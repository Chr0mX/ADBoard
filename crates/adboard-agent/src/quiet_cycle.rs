//! "Quiet Mode Loop": phones are kept quiet (screen off, sound muted) for the whole quiet
//! duration, then the screen comes on for a few seconds (sound stays muted), then the screen
//! goes off again and a new quiet duration starts, until the loop is turned off:
//!
//! ```text
//! 00:00  Quiet  screen off, muted  ┐ quiet duration (the full time, never shortened)
//! 30:00  Peek   screen ON,  muted  ┘ screen-on duration (1 to 5 s, default 3 s)
//! 30:03  Quiet  screen off, muted  ... and so on
//! ```
//!
//! The agent keeps the time (with or without a browser), saves it in the config folder
//! (`quiet-cycle.json`) so a restart resumes in the right phase, and applies the current
//! phase to every online phone. Sound and screen are tracked separately per phone, so one
//! failing operation is retried without repeating the other. A phone that connects, or
//! reconnects even between two checks, gets the current phase at once: the device watcher and
//! the session restarts report such events (`note_connected` / `note_disconnected`), which
//! bump the phone's generation, forget what was done for it and wake the background task, so
//! the loop never relies only on its periodic check. Starting, stopping or changing the loop
//! wakes the task too.

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
pub const DEFAULT_QUIET_SECS: u64 = 3600;
pub const DEFAULT_PEEK_SECS: u64 = 3;
pub const MIN_PEEK_SECS: u64 = 1;
pub const MAX_PEEK_SECS: u64 = 5;
const MAX_SECS: u64 = 7 * 24 * 3600;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    /// Screen off, sound muted, for the quiet duration.
    Quiet,
    /// Screen on, sound still muted, for the screen-on duration.
    #[serde(alias = "normal")]
    Peek,
}

impl Phase {
    pub fn other(self) -> Phase {
        match self {
            Phase::Quiet => Phase::Peek,
            Phase::Peek => Phase::Quiet,
        }
    }
}

/// What is saved: the settings and where in the cycle we are (unix milliseconds).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cycle {
    pub enabled: bool,
    /// The quiet duration in seconds (the setting the loop always had).
    pub interval_secs: u64,
    /// The screen-on duration in seconds, 1 to 5.
    #[serde(default = "default_peek")]
    pub peek_secs: u64,
    pub phase: Phase,
    #[serde(default)]
    pub phase_started_ms: u64,
    #[serde(default)]
    pub phase_ends_ms: u64,
    /// When this run of the loop began; sound is muted once per run, not once per phase.
    #[serde(default)]
    pub run_id: u64,
}

fn default_peek() -> u64 {
    DEFAULT_PEEK_SECS
}

impl Default for Cycle {
    fn default() -> Self {
        Cycle {
            enabled: false,
            interval_secs: DEFAULT_QUIET_SECS,
            peek_secs: DEFAULT_PEEK_SECS,
            phase: Phase::Quiet,
            phase_started_ms: 0,
            phase_ends_ms: 0,
            run_id: 0,
        }
    }
}

/// The shortest quiet duration; `ADBOARD_QUIET_MIN_SECS` lowers it for testing.
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

/// A screen-on duration must be 1 to 5 seconds.
pub fn valid_peek(secs: u64) -> bool {
    (MIN_PEEK_SECS..=MAX_PEEK_SECS).contains(&secs)
}

impl Cycle {
    /// How long `phase` lasts, in milliseconds.
    pub fn duration_ms(&self, phase: Phase) -> u64 {
        1000 * match phase {
            Phase::Quiet => self.interval_secs,
            Phase::Peek => self.peek_secs,
        }
    }

    /// Begin the loop at `now_ms`: quiet immediately, for the full quiet duration.
    pub fn started(quiet_secs: u64, peek_secs: u64, now_ms: u64) -> Cycle {
        let mut cycle = Cycle {
            enabled: true,
            interval_secs: clamp_secs(quiet_secs),
            peek_secs: peek_secs.clamp(MIN_PEEK_SECS, MAX_PEEK_SECS),
            phase: Phase::Quiet,
            phase_started_ms: now_ms,
            phase_ends_ms: 0,
            run_id: now_ms,
        };
        cycle.phase_ends_ms = now_ms + cycle.duration_ms(Phase::Quiet);
        cycle
    }

    /// Move to the phase the clock says it is `now_ms`. Each phase starts where the last one
    /// ended (no drift, and the quiet time is never shortened by the screen-on time), and a
    /// long gap (the agent was off) lands in the right phase instead of replaying each flip.
    /// Returns whether it changed.
    pub fn advance(&mut self, now_ms: u64) -> bool {
        if !self.enabled || now_ms < self.phase_ends_ms {
            return false;
        }
        let period = self.duration_ms(Phase::Quiet) + self.duration_ms(Phase::Peek);
        // Whole periods (quiet + screen-on) that passed leave the phase unchanged.
        let skipped = (now_ms - self.phase_ends_ms) / period;
        let mut end = self.phase_ends_ms + skipped * period;
        let mut phase = self.phase;
        while now_ms >= end {
            phase = phase.other();
            end += self.duration_ms(phase);
        }
        self.phase = phase;
        self.phase_ends_ms = end;
        self.phase_started_ms = end - self.duration_ms(phase);
        true
    }
}

/// What the API returns (times in seconds, for the UI).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    #[serde(skip)]
    pub cycle: Cycle,
    pub enabled: bool,
    pub interval_secs: u64,
    pub peek_secs: u64,
    pub phase: Phase,
    pub phase_started_at: u64,
    pub phase_ends_at: u64,
    pub now: u64,
    /// Seconds until the phase changes (0 when the loop is off).
    pub seconds_left: u64,
}

struct Runtime {
    cycle: Mutex<Cycle>,
    path: OnceLock<PathBuf>,
    /// serial → which of the phone's two operations are done, and for what.
    applied: Mutex<HashMap<String, Done>>,
    /// serial → connection generation, bumped by every connect or disconnect event. A result
    /// that was started under an older generation is stale and never counts.
    gens: Mutex<HashMap<String, u64>>,
    /// Wakes the background task now (the loop started, stopped, changed, or a phone
    /// connected). A wake sent while the task is busy is kept, so it is never lost.
    wake: tokio::sync::Notify,
    /// Held while a round of changes (or the restore when turning off) is sent, so the two
    /// never interleave.
    ops: tokio::sync::Mutex<()>,
}

fn runtime() -> &'static Runtime {
    static R: OnceLock<Runtime> = OnceLock::new();
    R.get_or_init(|| Runtime {
        cycle: Mutex::new(Cycle::default()),
        path: OnceLock::new(),
        applied: Mutex::new(HashMap::new()),
        gens: Mutex::new(HashMap::new()),
        wake: tokio::sync::Notify::new(),
        ops: tokio::sync::Mutex::new(()),
    })
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn load_from(path: &std::path::Path) -> Cycle {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Cycle>(&bytes).ok())
        .map(|mut cycle| {
            cycle.interval_secs = clamp_secs(cycle.interval_secs);
            cycle.peek_secs = cycle.peek_secs.clamp(MIN_PEEK_SECS, MAX_PEEK_SECS);
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
        cycle.advance(now_ms());
    }
    if runtime().path.set(path).is_ok() {
        *lock(&runtime().cycle) = cycle.clone();
        persist(&cycle);
    }
}

fn status_at(cycle: &Cycle, now: u64) -> Status {
    let left_ms = if cycle.enabled {
        cycle.phase_ends_ms.saturating_sub(now)
    } else {
        0
    };
    Status {
        cycle: cycle.clone(),
        enabled: cycle.enabled,
        interval_secs: cycle.interval_secs,
        peek_secs: cycle.peek_secs,
        phase: cycle.phase,
        phase_started_at: cycle.phase_started_ms / 1000,
        phase_ends_at: cycle.phase_ends_ms.div_ceil(1000),
        now: now / 1000,
        seconds_left: left_ms.div_ceil(1000),
    }
}

pub fn status() -> Status {
    let now = now_ms();
    let mut cycle = lock(&runtime().cycle);
    if cycle.advance(now) {
        persist(&cycle);
    }
    status_at(&cycle, now)
}

/// Start (or restart) the loop: phones go quiet at the next check, which is immediate.
pub fn start(quiet_secs: u64, peek_secs: u64) -> Status {
    let cycle = Cycle::started(quiet_secs, peek_secs, now_ms());
    lock(&runtime().applied).clear();
    persist(&cycle);
    *lock(&runtime().cycle) = cycle;
    // The task may be sleeping until its next check: phones should go quiet now.
    runtime().wake.notify_one();
    status()
}

/// Stop repeating. The phones stay as they are (see `stop_and_restore` for putting them back).
pub fn stop() -> Status {
    let mut cycle = lock(&runtime().cycle);
    cycle.enabled = false;
    persist(&cycle);
    drop(cycle);
    lock(&runtime().applied).clear();
    runtime().wake.notify_one();
    status()
}

/// Turn the loop off and put every online phone back: sound restored (each phone's own
/// volume, through the existing restore logic) and the screen on.
pub async fn stop_and_restore(state: &AppState) -> Status {
    let was_running = lock(&runtime().cycle).enabled;
    let result = stop();
    if was_running {
        // Wait for a round that is already sending changes to finish (it sees the loop is off
        // and records nothing), so the restore is the last word.
        let _ops = runtime().ops.lock().await;
        let devices = state.list_devices().await;
        let online: Vec<&Device> = devices
            .iter()
            .filter(|d| d.status == DeviceStatus::Online)
            .collect();
        let serials: Vec<String> = online.iter().map(|d| d.serial.clone()).collect();
        if !serials.is_empty() {
            run_group(state, &online, &serials, &serials, false, false).await;
        }
    }
    result
}

/// A person changed Quiet mode (sound or screen) outside the loop: stop repeating.
pub fn manual_change() {
    let running = lock(&runtime().cycle).enabled;
    if running {
        info!("Quiet mode changed by hand; the repeating cycle stops");
        stop();
    }
}

/// A connect or disconnect event for `serial`: it starts a new connection generation, so what was
/// done for the phone (and any result still on its way) no longer counts, and the task is woken
/// to bring the phone into the current phase now. Duplicate events are harmless. Nothing here
/// touches the loop's timing.
fn new_generation(serial: &str) {
    *lock(&runtime().gens).entry(serial.to_string()).or_insert(0) += 1;
    lock(&runtime().applied).remove(serial);
    runtime().wake.notify_one();
}

/// A phone has just (re)connected, even if it was gone for less time than a check takes.
pub fn note_connected(serial: &str) {
    new_generation(serial);
}

/// A phone has dropped: whatever was done for it is forgotten.
pub fn note_disconnected(serial: &str) {
    new_generation(serial);
}

/// The loop is running (it puts any phone that connects into the current phase itself).
pub fn loop_running() -> bool {
    status().cycle.enabled
}

/// What has been done for one phone: the run the sound was muted for, and the phase the
/// screen was set for. A phone is finished only when both are current.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Done {
    audio: Option<u64>,
    screen: Option<u64>,
}

impl Done {
    fn complete(&self, run_id: u64, phase_started: u64) -> bool {
        self.audio == Some(run_id) && self.screen == Some(phase_started)
    }
}

/// Phones that are online and are missing a muted sound or the screen state of this phase.
pub fn pending(
    online: &[String],
    done: &HashMap<String, Done>,
    run_id: u64,
    phase_started: u64,
) -> Vec<String> {
    online
        .iter()
        .filter(|serial| {
            !done
                .get(*serial)
                .copied()
                .unwrap_or_default()
                .complete(run_id, phase_started)
        })
        .cloned()
        .collect()
}

/// For the pending phones: who still needs muting (once per run) and who still needs the
/// screen change for this phase. An operation that already succeeded is not sent again.
pub fn plan(
    pending: &[String],
    done: &HashMap<String, Done>,
    run_id: u64,
    phase_started: u64,
) -> (Vec<String>, Vec<String>) {
    let get = |serial: &String| done.get(serial).copied().unwrap_or_default();
    let audio = pending
        .iter()
        .filter(|s| get(s).audio != Some(run_id))
        .cloned()
        .collect();
    let screen = pending
        .iter()
        .filter(|s| get(s).screen != Some(phase_started))
        .cloned()
        .collect();
    (audio, screen)
}

/// Remember what succeeded for `serial`. `None` means the operation was not tried this time;
/// `Some(false)` is a failure and leaves it pending (an older success is kept).
pub fn record(
    done: &mut HashMap<String, Done>,
    serial: &str,
    run_id: u64,
    phase_started: u64,
    audio: Option<bool>,
    screen: Option<bool>,
) {
    let entry = done.entry(serial.to_string()).or_default();
    if audio == Some(true) {
        entry.audio = Some(run_id);
    }
    if screen == Some(true) {
        entry.screen = Some(phase_started);
    }
}

/// Record the outcome of one round, ignoring what is stale: a phone whose connection
/// generation changed while its operations were running (it reconnected) is skipped, and a
/// screen result only counts for the phase it was sent for. Sound is per run (the caller has
/// checked the run is the same).
#[allow(clippy::too_many_arguments)]
pub fn settle(
    done: &mut HashMap<String, Done>,
    gens_then: &HashMap<String, u64>,
    gens_now: &HashMap<String, u64>,
    run_id: u64,
    phase_started_then: u64,
    phase_started_now: u64,
    audio_out: &HashMap<String, bool>,
    screen_out: &HashMap<String, bool>,
) {
    let mut serials: Vec<&String> = audio_out.keys().chain(screen_out.keys()).collect();
    serials.sort();
    serials.dedup();
    for serial in serials {
        if gens_then.get(serial) != gens_now.get(serial) {
            continue;
        }
        let screen = if phase_started_then == phase_started_now {
            screen_out.get(serial).copied()
        } else {
            None
        };
        record(
            done,
            serial,
            run_id,
            phase_started_then,
            audio_out.get(serial).copied(),
            screen,
        );
    }
}

#[cfg(test)]
pub fn done_for(serial: &str) -> Option<(bool, bool)> {
    let cycle = lock(&runtime().cycle).clone();
    lock(&runtime().applied).get(serial).map(|d| {
        (
            d.audio == Some(cycle.run_id),
            d.screen == Some(cycle.phase_started_ms),
        )
    })
}

/// Test only: jump the running loop to `phase`, starting now.
#[cfg(test)]
pub fn force_phase(phase: Phase) {
    let mut cycle = lock(&runtime().cycle);
    let now = now_ms();
    cycle.phase = phase;
    cycle.phase_started_ms = now;
    cycle.phase_ends_ms = now + cycle.duration_ms(phase);
}

/// Send the sound and screen changes for one group of phones that all want the same state:
/// sound muted (`mute_on`) or restored, screen off (`screen_off`) or on. Returns, per phone,
/// whether each operation succeeded (only for the ones asked for).
async fn run_group(
    state: &AppState,
    online: &[&Device],
    audio_todo: &[String],
    screen_todo: &[String],
    mute_on: bool,
    screen_off: bool,
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
                arg: Some(if mute_on { "on" } else { "off" }.into()),
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
                screen_off,
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
                            .set_display_power(&device.serial, !screen_off)
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

/// Apply the current phase to every online phone that does not have it yet. Each phone has
/// its own record: only the operation that failed is retried, and one phone's failure never
/// holds back another. Sound is muted once per run and stays muted in both phases; only the
/// screen changes between them.
pub async fn reconcile(state: &AppState) {
    // One round at a time, and never while the restore for turning the loop off is running.
    let _ops = runtime().ops.lock().await;
    let status = status();
    if !status.cycle.enabled {
        return;
    }
    let (run_id, phase_started, phase) = (
        status.cycle.run_id,
        status.cycle.phase_started_ms,
        status.cycle.phase,
    );
    let devices = state.list_devices().await;
    let online: Vec<&Device> = devices
        .iter()
        .filter(|d| d.status == DeviceStatus::Online)
        .collect();
    let serials: Vec<String> = online.iter().map(|d| d.serial.clone()).collect();
    let (audio_todo, screen_todo) = {
        let mut applied = lock(&runtime().applied);
        // A phone that went away is looked at again when it returns, as a new phone.
        applied.retain(|serial, _| serials.contains(serial));
        let todo = pending(&serials, &applied, run_id, phase_started);
        plan(&todo, &applied, run_id, phase_started)
    };
    if audio_todo.is_empty() && screen_todo.is_empty() {
        return;
    }
    let gens_then = lock(&runtime().gens).clone();
    let (audio_out, screen_out) = run_group(
        state,
        &online,
        &audio_todo,
        &screen_todo,
        true,
        phase == Phase::Quiet,
    )
    .await;

    let mut applied = lock(&runtime().applied);
    // The loop may have been stopped or restarted while the calls ran.
    let phase_started_now = {
        let now = lock(&runtime().cycle);
        if !now.enabled || now.run_id != run_id {
            return;
        }
        now.phase_started_ms
    };
    let gens_now = lock(&runtime().gens).clone();
    settle(
        &mut applied,
        &gens_then,
        &gens_now,
        run_id,
        phase_started,
        phase_started_now,
        &audio_out,
        &screen_out,
    );
}

/// How long the background task sleeps: until the phase ends (so a 1 to 5 second screen-on
/// phase is not missed), but never longer than the normal check period, and never a busy loop.
pub fn next_wait(enabled: bool, now_ms: u64, phase_ends_ms: u64, tick: Duration) -> Duration {
    if !enabled {
        return tick;
    }
    let until = Duration::from_millis(phase_ends_ms.saturating_sub(now_ms));
    until.min(tick).max(Duration::from_millis(100))
}

/// The task's loop: a round, then sleep until the phase ends, the check period passes, or
/// something wakes it (the loop started, stopped or changed, or a phone connected).
async fn run_loop(state: AppState, tick: Duration) {
    loop {
        reconcile(&state).await;
        let (enabled, ends) = {
            let cycle = lock(&runtime().cycle);
            (cycle.enabled, cycle.phase_ends_ms)
        };
        tokio::select! {
            _ = tokio::time::sleep(next_wait(enabled, now_ms(), ends, tick)) => {}
            _ = runtime().wake.notified() => {}
        }
    }
}

/// The background task: one for the whole agent.
pub fn spawn(state: AppState) {
    static STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if STARTED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let tick = Duration::from_millis(
        crate::env::var("QUIET_TICK_MS")
            .ok()
            .and_then(|v| v.trim().parse::<u64>().ok())
            .filter(|n| *n >= 100)
            .unwrap_or(5_000),
    );
    tokio::spawn(run_loop(state, tick));
}

/// Test only: the task's loop with a chosen check period, so a test can prove a wake works
/// even when the normal check is far away.
#[cfg(test)]
pub fn spawn_for_test(state: AppState, tick: Duration) -> tokio::task::JoinHandle<()> {
    tokio::spawn(run_loop(state, tick))
}

#[cfg(test)]
mod tests {
    use super::*;

    const QUIET: u64 = 600; // seconds
    const T0: u64 = 1_000_000; // ms

    fn running(peek: u64) -> Cycle {
        Cycle::started(QUIET, peek, T0)
    }

    fn s(name: &str) -> String {
        name.to_string()
    }

    // ---- timing ----

    #[test]
    fn it_starts_quiet_immediately_for_the_full_quiet_duration() {
        let c = running(3);
        assert!(c.enabled);
        assert_eq!(c.phase, Phase::Quiet);
        assert_eq!(c.phase_started_ms, T0);
        assert_eq!(c.phase_ends_ms, T0 + 600_000);
        assert_eq!(c.run_id, T0);
    }

    #[test]
    fn the_screen_on_time_is_not_part_of_the_quiet_time() {
        // 600 s quiet, 3 s screen on, 600 s quiet, 3 s screen on ...
        let mut c = running(3);
        assert!(!c.advance(T0 + 599_999));
        assert!(c.advance(T0 + 600_000));
        assert_eq!(c.phase, Phase::Peek);
        assert_eq!(
            (c.phase_started_ms, c.phase_ends_ms),
            (T0 + 600_000, T0 + 603_000)
        );
        assert!(!c.advance(T0 + 602_999));
        assert!(c.advance(T0 + 603_000));
        assert_eq!(c.phase, Phase::Quiet);
        // The new quiet countdown starts after the screen-on phase: another full 600 s.
        assert_eq!(
            (c.phase_started_ms, c.phase_ends_ms),
            (T0 + 603_000, T0 + 1_203_000)
        );
        assert!(c.advance(T0 + 1_203_000));
        assert_eq!(c.phase, Phase::Peek);
        assert_eq!(c.phase_ends_ms, T0 + 1_206_000);
    }

    #[test]
    fn screen_on_durations_of_one_three_and_five_seconds() {
        for peek in [1u64, 3, 5] {
            let mut c = running(peek);
            c.advance(T0 + 600_000);
            assert_eq!(c.phase, Phase::Peek, "peek {peek}");
            assert_eq!(c.phase_ends_ms - c.phase_started_ms, peek * 1000);
            c.advance(c.phase_ends_ms);
            assert_eq!(c.phase, Phase::Quiet);
            assert_eq!(
                c.phase_ends_ms - c.phase_started_ms,
                600_000,
                "quiet is always the full time"
            );
        }
    }

    #[test]
    fn a_late_check_does_not_drift_the_schedule() {
        let mut c = running(3);
        assert!(c.advance(T0 + 601_700)); // checked 1.7 s late
        assert_eq!(c.phase, Phase::Peek);
        assert_eq!(
            c.phase_ends_ms,
            T0 + 603_000,
            "the next change is still on schedule"
        );
    }

    #[test]
    fn it_repeats_indefinitely_and_lands_on_the_right_phase_after_a_long_gap() {
        // The period is 603 s: quiet [0,600), screen on [600,603), repeating.
        for peek_us in [
            0u64,
            599_999,
            600_000,
            602_999,
            603_000,
            1_202_999,
            1_203_000,
            603_000 * 1_000 + 1,
            603_000 * 1_000 + 600_500,
        ] {
            let mut c = running(3);
            c.advance(T0 + peek_us);
            let in_period = peek_us % 603_000;
            let want = if in_period < 600_000 {
                Phase::Quiet
            } else {
                Phase::Peek
            };
            assert_eq!(c.phase, want, "at +{peek_us} ms");
            assert!(c.phase_started_ms <= T0 + peek_us && T0 + peek_us < c.phase_ends_ms);
        }
    }

    #[test]
    fn a_stopped_loop_never_moves() {
        let mut c = running(3);
        c.enabled = false;
        assert!(!c.advance(T0 + 99_999_999));
        assert_eq!(c.phase, Phase::Quiet);
    }

    #[test]
    fn settings_are_limited() {
        assert_eq!(clamp_secs(1), 60);
        assert_eq!(clamp_secs(u64::MAX), MAX_SECS);
        assert!(valid_peek(1) && valid_peek(3) && valid_peek(5));
        assert!(!valid_peek(0) && !valid_peek(6));
        assert_eq!(Cycle::started(600, 99, T0).peek_secs, 5);
        assert_eq!(Cycle::started(600, 0, T0).peek_secs, 1);
    }

    // ---- saving and restarts ----

    #[test]
    fn a_saved_loop_resumes_after_a_restart_in_the_right_phase() {
        let dir = std::env::temp_dir().join(format!("adboard-quiet-{}", uuid::Uuid::new_v4()));
        let path = dir.join(FILE_NAME);
        let c = running(5);
        save_to(&path, &c).unwrap();
        let mut loaded = load_from(&path);
        assert_eq!(
            loaded, c,
            "the quiet duration and the screen-on duration are both saved"
        );
        // Restarted in the middle of the screen-on phase, then in the next quiet phase.
        loaded.advance(T0 + 600_000 + 2_000);
        assert_eq!(loaded.phase, Phase::Peek);
        loaded.advance(T0 + 605_000 + 10_000);
        assert_eq!(loaded.phase, Phase::Quiet);
        assert_eq!(loaded.phase_started_ms, T0 + 605_000);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn an_older_saved_file_still_loads() {
        let dir = std::env::temp_dir().join(format!("adboard-quiet-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("old.json");
        std::fs::write(
            &path,
            br#"{"enabled":true,"intervalSecs":1800,"phase":"normal","phaseStartedAt":1,"phaseEndsAt":2}"#,
        )
        .unwrap();
        let loaded = load_from(&path);
        assert!(loaded.enabled);
        assert_eq!(loaded.interval_secs, 1800);
        assert_eq!(
            loaded.peek_secs, DEFAULT_PEEK_SECS,
            "the screen-on time defaults to 3 s"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_missing_or_broken_file_means_no_loop() {
        let dir = std::env::temp_dir().join(format!("adboard-quiet-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!load_from(&dir.join("none.json")).enabled);
        std::fs::write(dir.join("bad.json"), b"{nope").unwrap();
        assert!(!load_from(&dir.join("bad.json")).enabled);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_status_reports_seconds_for_the_screen() {
        let c = running(3);
        let status = status_at(&c, T0 + 1_500);
        assert_eq!(status.seconds_left, 599);
        assert_eq!(status.peek_secs, 3);
        assert_eq!(status.interval_secs, 600);
        assert_eq!(status_at(&Cycle::default(), T0).seconds_left, 0);
    }

    #[test]
    fn the_task_wakes_for_the_end_of_a_short_screen_on_phase() {
        let tick = Duration::from_secs(5);
        assert_eq!(
            next_wait(true, 1_000, 1_800, tick),
            Duration::from_millis(800)
        );
        assert_eq!(
            next_wait(true, 1_000, 99_000, tick),
            tick,
            "never longer than a normal check"
        );
        assert_eq!(
            next_wait(true, 1_000, 900, tick),
            Duration::from_millis(100),
            "never a busy loop"
        );
        assert_eq!(next_wait(false, 1_000, 1_100, tick), tick);
    }

    // ---- per-phone tracking ----

    #[test]
    fn a_phone_is_finished_only_with_the_run_muted_and_this_phase_screen_set() {
        let mut done = HashMap::new();
        record(&mut done, "A", 7, 100, Some(true), Some(true));
        record(&mut done, "B", 7, 100, Some(true), Some(false));
        let online = vec![s("A"), s("B"), s("C")];
        assert_eq!(pending(&online, &done, 7, 100), vec![s("B"), s("C")]);
        // A new phase: only the screen is needed again; the sound stays muted for the run.
        let next = pending(&online, &done, 7, 200);
        assert_eq!(next, online);
        let (audio, screen) = plan(&next, &done, 7, 200);
        assert_eq!(
            audio,
            vec![s("C")],
            "A and B are already muted for this run"
        );
        assert_eq!(screen, online);
    }

    #[test]
    fn audio_ok_screen_failed_stays_pending_and_only_the_screen_is_retried() {
        let mut done = HashMap::new();
        record(&mut done, "A", 7, 100, Some(true), Some(false));
        assert_eq!(pending(&[s("A")], &done, 7, 100), vec![s("A")]);
        let (audio, screen) = plan(&[s("A")], &done, 7, 100);
        assert!(audio.is_empty(), "the mute is not sent again");
        assert_eq!(screen, vec![s("A")]);
        record(&mut done, "A", 7, 100, None, Some(true));
        assert!(pending(&[s("A")], &done, 7, 100).is_empty());
    }

    #[test]
    fn audio_failed_screen_ok_stays_pending_and_only_the_sound_is_retried() {
        let mut done = HashMap::new();
        record(&mut done, "A", 7, 100, Some(false), Some(true));
        assert_eq!(pending(&[s("A")], &done, 7, 100), vec![s("A")]);
        let (audio, screen) = plan(&[s("A")], &done, 7, 100);
        assert_eq!(audio, vec![s("A")]);
        assert!(screen.is_empty());
        record(&mut done, "A", 7, 100, Some(true), None);
        assert!(pending(&[s("A")], &done, 7, 100).is_empty());
    }

    #[test]
    fn phones_keep_their_own_state() {
        let mut done = HashMap::new();
        record(&mut done, "A", 7, 100, Some(true), Some(true));
        record(&mut done, "B", 7, 100, Some(true), Some(false));
        record(&mut done, "C", 7, 100, Some(false), Some(false));
        let (audio, screen) = plan(
            &pending(&[s("A"), s("B"), s("C")], &done, 7, 100),
            &done,
            7,
            100,
        );
        assert_eq!(audio, vec![s("C")]);
        assert_eq!(screen, vec![s("B"), s("C")]);
        record(&mut done, "B", 7, 100, None, Some(false)); // B fails again: its mute stays recorded
        assert_eq!(
            done["B"],
            Done {
                audio: Some(7),
                screen: None
            }
        );
        assert_eq!(
            done["A"],
            Done {
                audio: Some(7),
                screen: Some(100)
            }
        );
    }

    fn gens(pairs: &[(&str, u64)]) -> HashMap<String, u64> {
        pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()
    }

    fn outcomes(pairs: &[(&str, bool)]) -> HashMap<String, bool> {
        pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()
    }

    #[test]
    fn a_result_for_a_phone_that_reconnected_meanwhile_is_stale_and_ignored() {
        let mut done = HashMap::new();
        // A reconnected while its operations ran (generation 1 -> 2); B did not.
        settle(
            &mut done,
            &gens(&[("A", 1), ("B", 1)]),
            &gens(&[("A", 2), ("B", 1)]),
            7,
            100,
            100,
            &outcomes(&[("A", true), ("B", true)]),
            &outcomes(&[("A", true), ("B", true)]),
        );
        assert!(!done.contains_key("A"), "A stays pending and is redone");
        assert_eq!(
            done["B"],
            Done {
                audio: Some(7),
                screen: Some(100)
            },
            "B is unaffected"
        );
    }

    #[test]
    fn a_screen_result_never_marks_a_newer_phase_done() {
        let mut done = HashMap::new();
        // The phase changed (100 -> 200) while the screen change for phase 100 was in flight.
        settle(
            &mut done,
            &gens(&[("A", 1)]),
            &gens(&[("A", 1)]),
            7,
            100,
            200,
            &outcomes(&[("A", true)]),
            &outcomes(&[("A", true)]),
        );
        assert_eq!(
            done["A"],
            Done {
                audio: Some(7),
                screen: None
            },
            "the mute still counts, the screen does not"
        );
        assert_eq!(pending(&[s("A")], &done, 7, 200), vec![s("A")]);
    }

    #[test]
    fn a_failure_for_one_phone_leaves_the_others_recorded() {
        let mut done = HashMap::new();
        settle(
            &mut done,
            &gens(&[]),
            &gens(&[]),
            7,
            100,
            100,
            &outcomes(&[("A", true), ("B", false), ("C", true)]),
            &outcomes(&[("A", true), ("B", true), ("C", false)]),
        );
        assert_eq!(
            done["A"],
            Done {
                audio: Some(7),
                screen: Some(100)
            }
        );
        assert_eq!(
            done["B"],
            Done {
                audio: None,
                screen: Some(100)
            }
        );
        assert_eq!(
            done["C"],
            Done {
                audio: Some(7),
                screen: None
            }
        );
    }

    #[test]
    fn a_new_run_mutes_again() {
        let mut done = HashMap::new();
        record(&mut done, "A", 7, 100, Some(true), Some(true));
        assert_eq!(
            plan(&[s("A")], &done, 8, 100).0,
            vec![s("A")],
            "a restarted loop mutes again"
        );
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
