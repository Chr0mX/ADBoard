//! "Quiet Mode Loop": every `interval` the agent puts every online phone into Quiet mode
//! (screen off, sound muted) for a short pulse, then back to normal, with or without a
//! browser open. A phone that connects while the loop runs goes quiet at once. It only repeats the two operations Quiet mode already uses (`mute` and the
//! scrcpy screen-off option).
//!
//! The cycle is saved in the config folder (`quiet-cycle.json`), so after an agent
//! restart it resumes in the phase the clock says it should be in. A task checks
//! every few seconds and applies the current phase to each online phone that has not
//! had it yet, which also covers phones that connect or reconnect later.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use adboard_protocol::{
    ControlMode, Device, DeviceCommandRequest, DeviceStatus, ScrcpyOptionsRequest,
};
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::device_manager::AppState;

const FILE_NAME: &str = "quiet-cycle.json";
pub const DEFAULT_INTERVAL_SECS: u64 = 3600;
/// How long each Quiet pulse lasts (shorter when the interval is very short).
pub const PULSE_SECS: u64 = 60;
const MAX_SECS: u64 = 7 * 24 * 3600;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Quiet,
    Normal,
}

impl Phase {
    pub fn other(self) -> Phase {
        match self {
            Phase::Quiet => Phase::Normal,
            Phase::Normal => Phase::Quiet,
        }
    }
}

/// What is saved: the settings and where in the cycle we are (unix seconds).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cycle {
    pub enabled: bool,
    pub interval_secs: u64,
    pub phase: Phase,
    pub phase_started_at: u64,
    pub phase_ends_at: u64,
}

impl Default for Cycle {
    fn default() -> Self {
        Cycle {
            enabled: false,
            interval_secs: DEFAULT_INTERVAL_SECS,
            phase: Phase::Normal,
            phase_started_at: 0,
            phase_ends_at: 0,
        }
    }
}

/// The shortest allowed phase; `ADBOARD_QUIET_MIN_SECS` lowers it for testing.
fn min_secs() -> u64 {
    crate::env::var("QUIET_MIN_SECS")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|n| *n >= 1)
        .unwrap_or(60)
}

pub fn clamp_secs(secs: u64) -> u64 {
    secs.clamp(min_secs(), MAX_SECS)
}

impl Cycle {
    /// The Quiet pulse for an interval: a minute, or half the interval when that is shorter.
    pub fn pulse_secs(interval_secs: u64) -> u64 {
        PULSE_SECS.min(interval_secs / 2).max(1)
    }

    /// How long `phase` lasts: the pulse for Quiet, the rest of the interval for Normal.
    pub fn duration(&self, phase: Phase) -> u64 {
        let pulse = Self::pulse_secs(self.interval_secs);
        match phase {
            Phase::Quiet => pulse,
            Phase::Normal => self.interval_secs - pulse,
        }
    }

    /// Begin `phase` at `now`.
    pub fn started(interval_secs: u64, phase: Phase, now: u64) -> Cycle {
        let interval_secs = clamp_secs(interval_secs);
        let mut cycle = Cycle {
            enabled: true,
            interval_secs,
            phase,
            phase_started_at: now,
            phase_ends_at: 0,
        };
        cycle.phase_ends_at = now + cycle.duration(phase);
        cycle
    }

    /// Move to the phase the clock says it is `now`. Each phase starts where the last
    /// one ended (no drift), and a long gap (the agent was off) lands in the right
    /// phase instead of replaying each flip. Returns whether it changed.
    pub fn advance(&mut self, now: u64) -> bool {
        if !self.enabled || now < self.phase_ends_at {
            return false;
        }
        // Whole intervals that passed leave the phase unchanged.
        let skipped = (now - self.phase_ends_at) / self.interval_secs;
        let mut end = self.phase_ends_at + skipped * self.interval_secs;
        let mut phase = self.phase;
        while now >= end {
            phase = phase.other();
            end += self.duration(phase);
        }
        self.phase = phase;
        self.phase_ends_at = end;
        self.phase_started_at = end - self.duration(phase);
        true
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    #[serde(flatten)]
    pub cycle: Cycle,
    pub now: u64,
    /// Seconds until the phase changes (0 when the cycle is off).
    pub seconds_left: u64,
}

struct Runtime {
    cycle: Mutex<Cycle>,
    path: OnceLock<PathBuf>,
    /// serial → which of the phone's two operations are done for which phase.
    applied: Mutex<HashMap<String, Done>>,
    /// Phones the loop has already looked at; `None` until the first look after the loop starts
    /// (or the agent restarts), so phones that were already connected are not "new".
    seen: Mutex<Option<std::collections::HashSet<String>>>,
}

fn runtime() -> &'static Runtime {
    static R: OnceLock<Runtime> = OnceLock::new();
    R.get_or_init(|| Runtime {
        cycle: Mutex::new(Cycle::default()),
        path: OnceLock::new(),
        applied: Mutex::new(HashMap::new()),
        seen: Mutex::new(None),
    })
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn load_from(path: &std::path::Path) -> Cycle {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Cycle>(&bytes).ok())
        .map(|mut cycle| {
            cycle.interval_secs = clamp_secs(cycle.interval_secs);
            cycle
        })
        .unwrap_or_default()
}

pub fn save_to(path: &std::path::Path, cycle: &Cycle) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_vec_pretty(cycle).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn persist(cycle: &Cycle) {
    if let Some(path) = runtime().path.get() {
        if let Err(error) = save_to(path, cycle) {
            warn!(%error, "cannot save the Quiet cycle");
        }
    }
}

/// Load the saved cycle (and the saved phone volumes) from the config folder.
pub fn init() {
    let dir = crate::data_dir::config_dir();
    crate::device_ops::init_saved_volumes(dir.join("quiet-volumes.json"));
    let path = dir.join(FILE_NAME);
    let mut cycle = load_from(&path);
    if cycle.enabled {
        info!(phase = ?cycle.phase, "Quiet cycle resumes");
        cycle.advance(now_secs());
    }
    if runtime().path.set(path).is_ok() {
        *lock(&runtime().cycle) = cycle.clone();
        persist(&cycle);
    }
}

pub fn status() -> Status {
    let now = now_secs();
    let mut cycle = lock(&runtime().cycle);
    if cycle.advance(now) {
        persist(&cycle);
    }
    let seconds_left = if cycle.enabled {
        cycle.phase_ends_at.saturating_sub(now)
    } else {
        0
    };
    Status {
        cycle: cycle.clone(),
        now,
        seconds_left,
    }
}

/// The loop is running. A phone that connects meanwhile is put into Quiet mode by it.
pub fn loop_running() -> bool {
    status().cycle.enabled
}

/// Start (or restart) the cycle in `phase`.
pub fn start(interval_secs: u64, phase: Phase) -> Status {
    let cycle = Cycle::started(interval_secs, phase, now_secs());
    {
        lock(&runtime().applied).clear();
        *lock(&runtime().seen) = None;
    }
    persist(&cycle);
    *lock(&runtime().cycle) = cycle;
    status()
}

/// Stop repeating; the phones stay as they are.
pub fn stop() -> Status {
    let mut cycle = lock(&runtime().cycle);
    cycle.enabled = false;
    persist(&cycle);
    drop(cycle);
    {
        lock(&runtime().applied).clear();
        *lock(&runtime().seen) = None;
    }
    status()
}

/// A person changed Quiet mode (sound or screen) outside the cycle: stop repeating.
pub fn manual_change() {
    let running = lock(&runtime().cycle).enabled;
    if running {
        info!("Quiet mode changed by hand; the repeating cycle stops");
        stop();
    }
}

/// What has been done for one phone, as the `phase_started_at` of the phase each of its
/// two operations last succeeded for. A phone is finished only when both match.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Done {
    audio: Option<u64>,
    screen: Option<u64>,
    /// Set (to the phase's start) for a phone that connected during a Normal phase: it goes
    /// quiet now and joins the loop from the next phase on.
    quiet_override: Option<u64>,
}

impl Done {
    /// Should this phone be quiet during the phase that began at `started_at`?
    fn wants_quiet(&self, phase: Phase, started_at: u64) -> bool {
        phase == Phase::Quiet || self.quiet_override == Some(started_at)
    }

    fn complete(&self, started_at: u64) -> bool {
        self.audio == Some(started_at) && self.screen == Some(started_at)
    }
}

/// Phones that are online and have not had both operations done for the current phase.
pub fn pending(online: &[String], done: &HashMap<String, Done>, started_at: u64) -> Vec<String> {
    online
        .iter()
        .filter(|serial| {
            !done
                .get(*serial)
                .copied()
                .unwrap_or_default()
                .complete(started_at)
        })
        .cloned()
        .collect()
}

/// For the pending phones: who still needs the sound change, and who still needs the screen
/// change. An operation that already succeeded is not sent again.
pub fn plan(
    pending: &[String],
    done: &HashMap<String, Done>,
    started_at: u64,
) -> (Vec<String>, Vec<String>) {
    let get = |serial: &String| done.get(serial).copied().unwrap_or_default();
    let audio = pending
        .iter()
        .filter(|s| get(s).audio != Some(started_at))
        .cloned()
        .collect();
    let screen = pending
        .iter()
        .filter(|s| get(s).screen != Some(started_at))
        .cloned()
        .collect();
    (audio, screen)
}

/// Remember what succeeded for `serial`. `None` means the operation was not tried this time;
/// `Some(false)` is a failure and leaves it pending (an older success is kept).
pub fn record(
    done: &mut HashMap<String, Done>,
    serial: &str,
    started_at: u64,
    audio: Option<bool>,
    screen: Option<bool>,
) {
    let entry = done.entry(serial.to_string()).or_default();
    if audio == Some(true) {
        entry.audio = Some(started_at);
    }
    if screen == Some(true) {
        entry.screen = Some(started_at);
    }
}

#[cfg(test)]
pub fn done_for(serial: &str) -> Option<(bool, bool)> {
    let started = lock(&runtime().cycle).phase_started_at;
    lock(&runtime().applied)
        .get(serial)
        .map(|d| (d.audio == Some(started), d.screen == Some(started)))
}

/// Send the sound and screen changes for one group of phones that all want the same state.
/// Returns, per phone, whether each operation succeeded (only for the ones asked for).
async fn run_group(
    state: &AppState,
    online: &[&Device],
    audio_todo: &[String],
    screen_todo: &[String],
    quiet: bool,
) -> (HashMap<String, bool>, HashMap<String, bool>) {
    let ids_of = |serials: &[String]| -> Vec<String> {
        online
            .iter()
            .filter(|d| serials.contains(&d.serial))
            .map(|d| d.id.clone())
            .collect()
    };

    // Sound: only the phones that still need it.
    let mut audio_out: HashMap<String, bool> = HashMap::new();
    if !audio_todo.is_empty() {
        let mute = state
            .run_command(DeviceCommandRequest {
                target_ids: ids_of(audio_todo),
                op: "mute".into(),
                arg: Some(if quiet { "on" } else { "off" }.into()),
                arg2: None,
            })
            .await;
        for device in online.iter().filter(|d| audio_todo.contains(&d.serial)) {
            let ok = match &mute {
                Ok(response) => match response.results.iter().find(|r| r.device_id == device.id) {
                    Some(result) if result.ok => true,
                    Some(result) => {
                        warn!(phone = %device.name, error = ?result.error, "Quiet cycle: mute failed");
                        false
                    }
                    None => {
                        warn!(phone = %device.name, "Quiet cycle: mute gave no answer");
                        false
                    }
                },
                Err(error) => {
                    warn!(phone = %device.name, %error, "Quiet cycle: mute failed");
                    false
                }
            };
            audio_out.insert(device.serial.clone(), ok);
        }
    }

    // Screen: only the phones that still need it. The options call also records the wanted
    // state for streams that start later; it reports a result only for phones whose screen
    // state changed, so a retry for a local phone sends the power message itself.
    let mut screen_out: HashMap<String, bool> = HashMap::new();
    if !screen_todo.is_empty() {
        let prefs = state.inner.sessions.prefs().await;
        let options = state
            .run_scrcpy_options(ScrcpyOptionsRequest {
                mode: ControlMode::Selected,
                target_ids: ids_of(screen_todo),
                quality: prefs.quality.clone(),
                audio: prefs.audio,
                screen_off: quiet,
                max_size: prefs.max_size,
                video_bit_rate: prefs.video_bit_rate,
                max_fps: prefs.max_fps,
            })
            .await;
        let locals: Vec<String> = state
            .list_local_devices()
            .await
            .into_iter()
            .map(|d| d.serial)
            .collect();
        for device in online.iter().filter(|d| screen_todo.contains(&d.serial)) {
            let ok = match &options {
                Err(error) => {
                    warn!(phone = %device.name, %error, "Quiet cycle: screen power failed");
                    false
                }
                Ok(response) => match response.results.iter().find(|r| r.device_id == device.id) {
                    Some(result) if result.ok => true,
                    Some(result) => {
                        warn!(phone = %device.name, error = ?result.error, "Quiet cycle: screen power failed");
                        false
                    }
                    None if locals.contains(&device.serial) => {
                        match state
                            .inner
                            .sessions
                            .set_display_power(&device.serial, !quiet)
                            .await
                        {
                            Ok(()) => true,
                            Err(error) => {
                                warn!(phone = %device.name, %error, "Quiet cycle: screen power failed");
                                false
                            }
                        }
                    }
                    // A phone on another host reports for itself; no report means nothing changed there.
                    None => true,
                },
            };
            screen_out.insert(device.serial.clone(), ok);
        }
    }
    (audio_out, screen_out)
}

/// Apply the current phase to every online phone that does not have it yet. Each phone
/// has its own record: only the operation that failed is retried, and one phone's failure
/// never holds back another. A phone that connects while the loop runs goes quiet at once,
/// even in a Normal phase, and follows the loop from the next phase.
pub async fn reconcile(state: &AppState) {
    let status = status();
    if !status.cycle.enabled {
        return;
    }
    let started_at = status.cycle.phase_started_at;
    let phase = status.cycle.phase;
    let devices = state.list_devices().await;
    let online: Vec<&Device> = devices
        .iter()
        .filter(|d| d.status == DeviceStatus::Online)
        .collect();
    let serials: Vec<String> = online.iter().map(|d| d.serial.clone()).collect();
    // A phone that went away is looked at again when it returns, as a new phone.
    let newcomers: Vec<String> = {
        let mut seen = lock(&runtime().seen);
        let newcomers = match seen.as_ref() {
            // First look since the loop started: the phones already here are not new.
            None => Vec::new(),
            Some(known) => serials
                .iter()
                .filter(|s| !known.contains(*s))
                .cloned()
                .collect(),
        };
        *seen = Some(serials.iter().cloned().collect());
        newcomers
    };
    {
        let mut applied = lock(&runtime().applied);
        applied.retain(|serial, _| serials.contains(serial));
        if phase == Phase::Normal {
            for serial in &newcomers {
                applied.entry(serial.clone()).or_default().quiet_override = Some(started_at);
            }
        }
    }
    let (audio_todo, screen_todo, wants) = {
        let applied = lock(&runtime().applied);
        let todo = pending(&serials, &applied, started_at);
        let (audio, screen) = plan(&todo, &applied, started_at);
        let wants: HashMap<String, bool> = serials
            .iter()
            .map(|s| {
                let quiet = applied
                    .get(s)
                    .copied()
                    .unwrap_or_default()
                    .wants_quiet(phase, started_at);
                (s.clone(), quiet)
            })
            .collect();
        (audio, screen, wants)
    };
    if audio_todo.is_empty() && screen_todo.is_empty() {
        return;
    }

    // Phones that want quiet and phones that want normal are sent their own changes. In a
    // Normal phase the quiet group goes first, so the saved screen setting ends as normal.
    let mut audio_out: HashMap<String, bool> = HashMap::new();
    let mut screen_out: HashMap<String, bool> = HashMap::new();
    let groups: [bool; 2] = if phase == Phase::Normal {
        [true, false]
    } else {
        [false, true]
    };
    for quiet in groups {
        let pick = |list: &[String]| -> Vec<String> {
            list.iter()
                .filter(|s| wants.get(*s).copied().unwrap_or(false) == quiet)
                .cloned()
                .collect()
        };
        let (audio_group, screen_group) = (pick(&audio_todo), pick(&screen_todo));
        if audio_group.is_empty() && screen_group.is_empty() {
            continue;
        }
        let (a, c) = run_group(state, &online, &audio_group, &screen_group, quiet).await;
        audio_out.extend(a);
        screen_out.extend(c);
    }

    let mut applied = lock(&runtime().applied);
    // The cycle may have been stopped or restarted while the calls ran.
    {
        let now = lock(&runtime().cycle);
        if !now.enabled || now.phase_started_at != started_at {
            return;
        }
    }
    for device in &online {
        let (audio, screen) = (
            audio_out.get(&device.serial).copied(),
            screen_out.get(&device.serial).copied(),
        );
        if audio.is_some() || screen.is_some() {
            record(&mut applied, &device.serial, started_at, audio, screen);
        }
    }
}

/// The background task: every few seconds, follow the clock and the phones.
pub fn spawn(state: AppState) {
    static STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if STARTED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let tick = crate::env::var("QUIET_TICK_MS")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|n| *n >= 100)
        .unwrap_or(5_000);
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(tick));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            reconcile(&state).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cycle(phase: Phase, now: u64) -> Cycle {
        Cycle::started(600, phase, now)
    }

    #[test]
    fn interval_is_clamped() {
        assert_eq!(clamp_secs(1), 60);
        assert_eq!(clamp_secs(u64::MAX), MAX_SECS);
        assert_eq!(clamp_secs(300), 300);
    }

    #[test]
    fn the_pulse_is_a_minute_or_half_a_short_interval() {
        assert_eq!(Cycle::pulse_secs(3600), 60);
        assert_eq!(Cycle::pulse_secs(600), 60);
        assert_eq!(Cycle::pulse_secs(100), 50);
        assert_eq!(Cycle::pulse_secs(4), 2);
    }

    #[test]
    fn quiet_is_a_brief_pulse_once_per_interval_without_drift() {
        // Interval 600: quiet for 60 s, then normal for 540 s, and again.
        let mut c = cycle(Phase::Quiet, 1_000);
        assert_eq!((c.phase_started_at, c.phase_ends_at), (1_000, 1_060));
        assert!(!c.advance(1_059));
        // Checked late: the next phase still starts where the last one ended.
        assert!(c.advance(1_100));
        assert_eq!(c.phase, Phase::Normal);
        assert_eq!((c.phase_started_at, c.phase_ends_at), (1_060, 1_600));
        assert!(c.advance(1_600));
        assert_eq!(c.phase, Phase::Quiet);
        assert_eq!((c.phase_started_at, c.phase_ends_at), (1_600, 1_660));
    }

    #[test]
    fn starting_in_normal_waits_out_the_rest_of_the_interval() {
        let c = cycle(Phase::Normal, 5_000);
        assert_eq!(c.phase_ends_at, 5_540);
    }

    #[test]
    fn a_long_gap_lands_in_the_phase_the_clock_says() {
        // From 0: quiet [0,60), normal [60,600), quiet [600,660), ... every 600 s.
        for now in [
            0u64,
            59,
            60,
            599,
            600,
            659,
            660,
            6_000 + 10,
            6_000 + 70,
            600 * 1001 + 5,
            600 * 1001 + 100,
        ] {
            let mut c = cycle(Phase::Quiet, 0);
            c.advance(now);
            let want = if now % 600 < 60 {
                Phase::Quiet
            } else {
                Phase::Normal
            };
            assert_eq!(c.phase, want, "at {now}");
            assert!(
                c.phase_started_at <= now && now < c.phase_ends_at,
                "at {now}"
            );
        }
    }

    #[test]
    fn a_stopped_cycle_never_moves() {
        let mut c = cycle(Phase::Quiet, 0);
        c.enabled = false;
        assert!(!c.advance(1_000_000));
        assert_eq!(c.phase, Phase::Quiet);
    }

    #[test]
    fn the_saved_cycle_resumes_after_a_restart() {
        let dir = std::env::temp_dir().join(format!("adboard-quiet-{}", uuid::Uuid::new_v4()));
        let path = dir.join(FILE_NAME);
        let c = cycle(Phase::Quiet, 100);
        save_to(&path, &c).unwrap();
        let mut loaded = load_from(&path);
        assert_eq!(loaded, c);
        // Restarted in the middle of the normal phase.
        // Quiet [100,160), normal [160,700), quiet [700,760): restarted 30 s into the second pulse.
        loaded.advance(100 + 600 + 30);
        assert_eq!(loaded.phase, Phase::Quiet);
        assert_eq!(loaded.phase_ends_at, 760);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_missing_or_broken_file_means_no_cycle() {
        let dir = std::env::temp_dir().join(format!("adboard-quiet-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!load_from(&dir.join("none.json")).enabled);
        std::fs::write(dir.join("bad.json"), b"{nope").unwrap();
        assert!(!load_from(&dir.join("bad.json")).enabled);
        let _ = std::fs::remove_dir_all(dir);
    }

    fn done(audio: bool, screen: bool, started: u64) -> Done {
        Done {
            audio: audio.then_some(started),
            screen: screen.then_some(started),
            quiet_override: None,
        }
    }

    #[test]
    fn a_phone_wants_quiet_in_a_quiet_phase_or_when_it_connected_during_normal() {
        let plain = Done::default();
        assert!(plain.wants_quiet(Phase::Quiet, 100));
        assert!(!plain.wants_quiet(Phase::Normal, 100));
        let newcomer = Done {
            quiet_override: Some(100),
            ..Done::default()
        };
        assert!(newcomer.wants_quiet(Phase::Normal, 100));
        // The override belongs to that phase only: the next normal phase is normal again.
        assert!(!newcomer.wants_quiet(Phase::Normal, 700));
    }

    fn s(name: &str) -> String {
        name.to_string()
    }

    #[test]
    fn only_phones_without_both_operations_done_are_pending() {
        let mut applied = HashMap::new();
        applied.insert(s("A"), done(true, true, 100));
        applied.insert(s("B"), done(true, true, 50)); // an older phase
        applied.insert(s("D"), done(true, false, 100)); // sound done, screen not
        let online = vec![s("A"), s("B"), s("C"), s("D")];
        assert_eq!(
            pending(&online, &applied, 100),
            vec![s("B"), s("C"), s("D")]
        );
    }

    #[test]
    fn audio_ok_screen_failed_stays_pending_and_only_the_screen_is_retried() {
        let mut applied = HashMap::new();
        record(&mut applied, "A", 100, Some(true), Some(false));
        assert_eq!(
            pending(&[s("A")], &applied, 100),
            vec![s("A")],
            "still pending"
        );
        let (audio, screen) = plan(&[s("A")], &applied, 100);
        assert!(audio.is_empty(), "the sound change is not sent again");
        assert_eq!(screen, vec![s("A")], "the screen change is retried");
        // The retry works: now it is complete and nothing more is planned.
        record(&mut applied, "A", 100, None, Some(true));
        assert!(pending(&[s("A")], &applied, 100).is_empty());
        assert_eq!(plan(&[], &applied, 100), (vec![], vec![]));
    }

    #[test]
    fn audio_failed_screen_ok_stays_pending_and_only_the_sound_is_retried() {
        let mut applied = HashMap::new();
        record(&mut applied, "A", 100, Some(false), Some(true));
        assert_eq!(pending(&[s("A")], &applied, 100), vec![s("A")]);
        let (audio, screen) = plan(&[s("A")], &applied, 100);
        assert_eq!(audio, vec![s("A")]);
        assert!(screen.is_empty());
        record(&mut applied, "A", 100, Some(true), None);
        assert!(pending(&[s("A")], &applied, 100).is_empty());
    }

    #[test]
    fn both_ok_is_applied_and_not_retried() {
        let mut applied = HashMap::new();
        record(&mut applied, "A", 100, Some(true), Some(true));
        assert!(pending(&[s("A")], &applied, 100).is_empty());
        assert_eq!(
            plan(&pending(&[s("A")], &applied, 100), &applied, 100),
            (vec![], vec![])
        );
        // A new phase starts from scratch.
        assert_eq!(pending(&[s("A")], &applied, 200), vec![s("A")]);
        assert_eq!(plan(&[s("A")], &applied, 200), (vec![s("A")], vec![s("A")]));
    }

    #[test]
    fn a_failure_is_per_phone_and_a_later_failure_keeps_an_earlier_success() {
        let mut applied = HashMap::new();
        record(&mut applied, "A", 100, Some(true), Some(true));
        record(&mut applied, "B", 100, Some(true), Some(false));
        record(&mut applied, "C", 100, Some(false), Some(false));
        assert_eq!(
            pending(&[s("A"), s("B"), s("C")], &applied, 100),
            vec![s("B"), s("C")]
        );
        let (audio, screen) = plan(&[s("B"), s("C")], &applied, 100);
        assert_eq!(audio, vec![s("C")]);
        assert_eq!(screen, vec![s("B"), s("C")]);
        // B's screen fails again: its sound success stays recorded.
        record(&mut applied, "B", 100, None, Some(false));
        assert_eq!(applied["B"], done(true, false, 100));
        assert_eq!(applied["A"], done(true, true, 100), "A is untouched");
    }

    #[test]
    fn saved_volumes_survive_a_restart() {
        let dir = std::env::temp_dir().join(format!("adboard-quiet-{}", uuid::Uuid::new_v4()));
        let path = dir.join("quiet-volumes.json");
        let mut map = HashMap::new();
        map.insert("SERIAL1".to_string(), 9u32);
        crate::device_ops::store_volumes(&path, &map).unwrap();
        assert_eq!(
            crate::device_ops::load_volumes(&path).get("SERIAL1"),
            Some(&9)
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
