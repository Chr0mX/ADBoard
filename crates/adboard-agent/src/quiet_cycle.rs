//! "Repeat" for Quiet mode: the agent flips every online phone between Quiet
//! (screen off, sound muted) and normal every `interval`, with or without a browser
//! open. It only repeats the two operations Quiet mode already uses (`mute` and the
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

use adboard_protocol::{ControlMode, DeviceCommandRequest, DeviceStatus, ScrcpyOptionsRequest};
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::device_manager::AppState;

const FILE_NAME: &str = "quiet-cycle.json";
pub const DEFAULT_INTERVAL_SECS: u64 = 3600;
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
    /// Begin `phase` at `now`.
    pub fn started(interval_secs: u64, phase: Phase, now: u64) -> Cycle {
        let interval_secs = clamp_secs(interval_secs);
        Cycle { enabled: true, interval_secs, phase, phase_started_at: now, phase_ends_at: now + interval_secs }
    }

    /// Move to the phase the clock says it is `now`. Each phase starts where the last
    /// one ended (no drift), and a long gap (the agent was off) lands in the right
    /// phase instead of replaying each flip. Returns whether it changed.
    pub fn advance(&mut self, now: u64) -> bool {
        if !self.enabled || now < self.phase_ends_at {
            return false;
        }
        let steps = (now - self.phase_ends_at) / self.interval_secs + 1;
        if steps % 2 == 1 {
            self.phase = self.phase.other();
        }
        self.phase_ends_at += steps * self.interval_secs;
        self.phase_started_at = self.phase_ends_at - self.interval_secs;
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
    /// serial → `phase_started_at` of the phase last applied to that phone.
    applied: Mutex<HashMap<String, u64>>,
}

fn runtime() -> &'static Runtime {
    static R: OnceLock<Runtime> = OnceLock::new();
    R.get_or_init(|| Runtime {
        cycle: Mutex::new(Cycle::default()),
        path: OnceLock::new(),
        applied: Mutex::new(HashMap::new()),
    })
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
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
    let seconds_left = if cycle.enabled { cycle.phase_ends_at.saturating_sub(now) } else { 0 };
    Status { cycle: cycle.clone(), now, seconds_left }
}

/// Start (or restart) the cycle in `phase`.
pub fn start(interval_secs: u64, phase: Phase) -> Status {
    let cycle = Cycle::started(interval_secs, phase, now_secs());
    lock(&runtime().applied).clear();
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
    lock(&runtime().applied).clear();
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

/// Phones that are online and have not had the current phase applied yet.
pub fn pending(online: &[String], applied: &HashMap<String, u64>, started_at: u64) -> Vec<String> {
    online.iter().filter(|serial| applied.get(*serial) != Some(&started_at)).cloned().collect()
}

/// Apply the current phase to every online phone that does not have it yet.
pub async fn reconcile(state: &AppState) {
    let status = status();
    if !status.cycle.enabled {
        return;
    }
    let started_at = status.cycle.phase_started_at;
    let phase = status.cycle.phase;
    let devices = state.list_devices().await;
    let online: Vec<_> = devices.iter().filter(|d| d.status == DeviceStatus::Online).collect();
    // A phone that went away is looked at again when it returns.
    {
        let mut applied = lock(&runtime().applied);
        applied.retain(|serial, _| online.iter().any(|d| &d.serial == serial));
    }
    let todo: Vec<String> = {
        let applied = lock(&runtime().applied);
        let serials: Vec<String> = online.iter().map(|d| d.serial.clone()).collect();
        pending(&serials, &applied, started_at)
    };
    if todo.is_empty() {
        return;
    }
    let targets: Vec<_> = online.iter().filter(|d| todo.contains(&d.serial)).collect();
    let ids: Vec<String> = targets.iter().map(|d| d.id.clone()).collect();
    let quiet = phase == Phase::Quiet;
    let mute = state
        .run_command(DeviceCommandRequest {
            target_ids: ids.clone(),
            op: "mute".into(),
            arg: Some(if quiet { "on" } else { "off" }.into()),
            arg2: None,
        })
        .await;
    let prefs = state.inner.sessions.prefs().await;
    let screen = state
        .run_scrcpy_options(ScrcpyOptionsRequest {
            mode: ControlMode::Selected,
            target_ids: ids,
            quality: prefs.quality.clone(),
            audio: prefs.audio,
            screen_off: quiet,
            max_size: prefs.max_size,
            video_bit_rate: prefs.video_bit_rate,
            max_fps: prefs.max_fps,
        })
        .await;
    // A phone counts as done when its mute answered; a failed one is tried again next time.
    let mut applied = lock(&runtime().applied);
    // The cycle may have been stopped or restarted while the calls ran.
    {
        let now = lock(&runtime().cycle);
        if !now.enabled || now.phase_started_at != started_at {
            return;
        }
    }
    match &mute {
        Ok(response) => {
            for result in &response.results {
                if let Some(device) = targets.iter().find(|d| d.id == result.device_id) {
                    if result.ok {
                        applied.insert(device.serial.clone(), started_at);
                    } else {
                        warn!(phone = %device.name, error = ?result.error, "Quiet cycle: mute failed");
                    }
                }
            }
        }
        Err(error) => warn!(%error, "Quiet cycle: mute failed"),
    }
    if let Err(error) = screen {
        warn!(%error, "Quiet cycle: screen power failed");
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
    fn it_alternates_each_interval_without_drift() {
        let mut c = cycle(Phase::Quiet, 1_000);
        assert_eq!((c.phase_started_at, c.phase_ends_at), (1_000, 1_600));
        assert!(!c.advance(1_599));
        // Checked late: the next phase still starts where the last one ended.
        assert!(c.advance(1_650));
        assert_eq!(c.phase, Phase::Normal);
        assert_eq!((c.phase_started_at, c.phase_ends_at), (1_600, 2_200));
        assert!(c.advance(2_200));
        assert_eq!(c.phase, Phase::Quiet);
        assert_eq!((c.phase_started_at, c.phase_ends_at), (2_200, 2_800));
    }

    #[test]
    fn a_long_gap_lands_in_the_phase_the_clock_says() {
        // Quiet from 0, 600 s each: quiet [0,600), normal [600,1200), quiet [1200,1800)...
        for now in [0u64, 599, 600, 1199, 1200, 6_000 + 10, 6_000 + 650, 600 * 1001 + 5] {
            let mut c = cycle(Phase::Quiet, 0);
            c.advance(now);
            let want = if (now / 600) % 2 == 0 { Phase::Quiet } else { Phase::Normal };
            assert_eq!(c.phase, want, "at {now}");
            assert!(c.phase_started_at <= now && now < c.phase_ends_at, "at {now}");
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
        loaded.advance(100 + 600 + 30);
        assert_eq!(loaded.phase, Phase::Normal);
        assert_eq!(loaded.phase_ends_at, 100 + 1_200);
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

    #[test]
    fn only_phones_without_the_current_phase_are_pending() {
        let mut applied = HashMap::new();
        applied.insert("A".to_string(), 100u64);
        applied.insert("B".to_string(), 50u64);
        let online = vec!["A".to_string(), "B".to_string(), "C".to_string()];
        // A has this phase; B has an older one; C just connected.
        assert_eq!(pending(&online, &applied, 100), vec!["B".to_string(), "C".to_string()]);
    }

    #[test]
    fn saved_volumes_survive_a_restart() {
        let dir = std::env::temp_dir().join(format!("adboard-quiet-{}", uuid::Uuid::new_v4()));
        let path = dir.join("quiet-volumes.json");
        let mut map = HashMap::new();
        map.insert("SERIAL1".to_string(), 9u32);
        crate::device_ops::store_volumes(&path, &map).unwrap();
        assert_eq!(crate::device_ops::load_volumes(&path).get("SERIAL1"), Some(&9));
        let _ = std::fs::remove_dir_all(dir);
    }
}
