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
use serde::Serialize;
use tracing::{info, warn};

use crate::device_manager::AppState;

mod ops;
mod timing;
mod tracking;
pub use ops::reconcile;
use ops::run_group;
pub use timing::*;
pub use tracking::*;

const FILE_NAME: &str = "quiet-cycle.json";
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
mod tests;
