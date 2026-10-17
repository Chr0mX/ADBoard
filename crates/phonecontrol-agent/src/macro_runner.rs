//! Macro runs on the agent. A run belongs to its phones (the scrcpy
//! instances), not to the browser that pressed Run: every browser sees it,
//! can pause or stop it, and it keeps going when that browser closes.
//!
//! Port of the browser runner in `src/lib/macro/core.ts` (`placement`,
//! `toNormalized`, `buildStrokes`, `runMacroTab`) and the run registry in
//! `src/lib/macro/runs.ts` (one run per tab, one tab per phone). Each step is
//! played through the same `handle_gesture` path as `/api/input/gesture`.

use phonecontrol_protocol::{GestureStroke, NormalizedPoint};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::Notify;

pub const MAX_FINGERS: usize = 10;
pub const MIN_TOUCH_MS: f64 = 10.0;
pub const MAX_TOUCH_MS: f64 = 60_000.0;
pub const MAX_DELAY_MS: f64 = 3_600_000.0;

/* ----------------------------- model ----------------------------- */

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct Size {
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MacroFinger {
    pub x: f64,
    pub y: f64,
    #[serde(default)]
    pub to_x: Option<f64>,
    #[serde(default)]
    pub to_y: Option<f64>,
    #[serde(default)]
    pub start_ms: f64,
    #[serde(default = "default_duration")]
    pub duration_ms: f64,
}

fn default_duration() -> f64 {
    60.0
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MacroStep {
    pub id: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default)]
    pub fingers: Vec<MacroFinger>,
    #[serde(default)]
    pub delay_ms: f64,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MacroStop {
    #[serde(default = "default_stop_mode")]
    pub mode: String,
    #[serde(default)]
    pub seconds: f64,
    #[serde(default = "one")]
    pub cycles: f64,
}

fn default_stop_mode() -> String {
    "cycles".into()
}
fn one() -> f64 {
    1.0
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MacroTab {
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub reference: Size,
    #[serde(default = "default_scale")]
    pub scale: String,
    #[serde(default = "default_orientation")]
    pub orientation: String,
    pub stop: MacroStop,
    #[serde(default)]
    pub jitter_px: f64,
    #[serde(default)]
    pub steps: Vec<MacroStep>,
    #[serde(default)]
    pub target_ids: Vec<String>,
}

fn default_scale() -> String {
    "stretch".into()
}
fn default_orientation() -> String {
    "any".into()
}

/* ------------------------------ math ------------------------------ */

fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    v.max(lo).min(hi)
}

/// Where the reference screen lands on a device screen, as 0–1 of the device.
pub fn placement(reference: Size, device: Option<Size>, scale: &str) -> (f64, f64, f64, f64) {
    match device {
        Some(d) if scale == "fit" && d.width > 0.0 && d.height > 0.0 => {
            let s = (d.width / reference.width).min(d.height / reference.height);
            let w = reference.width * s / d.width;
            let h = reference.height * s / d.height;
            ((1.0 - w) / 2.0, (1.0 - h) / 2.0, w, h)
        }
        _ => (0.0, 0.0, 1.0, 1.0),
    }
}

/// Reference pixels → 0–1 of the device screen.
pub fn to_normalized(x: f64, y: f64, reference: Size, device: Option<Size>, scale: &str) -> NormalizedPoint {
    let (left, top, width, height) = placement(reference, device, scale);
    let rx = clamp(x / reference.width, 0.0, 1.0);
    let ry = clamp(y / reference.height, 0.0, 1.0);
    NormalizedPoint { x: left + rx * width, y: top + ry * height }
}

fn orientation_of(size: Size) -> i8 {
    if size.width == size.height {
        0
    } else if size.width > size.height {
        1
    } else {
        -1
    }
}

pub fn orientation_mismatch(reference: Size, device: Option<Size>) -> bool {
    match device {
        Some(d) if d.width > 0.0 && d.height > 0.0 => {
            let (a, b) = (orientation_of(reference), orientation_of(d));
            a != 0 && b != 0 && a != b
        }
        _ => false,
    }
}

/// Small deterministic-per-seed random source for jitter (no extra crate).
pub struct Rng(u64);
impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed | 1)
    }
    pub fn seeded() -> Self {
        let seed = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(7);
        Self::new(seed ^ 0x9E37_79B9_7F4A_7C15)
    }
    /// 0 ≤ n < 1
    pub fn next_f64(&mut self) -> f64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        (x >> 11) as f64 / (1u64 << 53) as f64
    }
}

/// One step → finger strokes for a device (`device` None = stretch over the screen).
pub fn build_strokes(step: &MacroStep, tab: &MacroTab, device: Option<Size>, rng: &mut Rng) -> Vec<GestureStroke> {
    let jitter = tab.jitter_px;
    let wobble = |rng: &mut Rng| if jitter > 0.0 { ((rng.next_f64() * 2.0 - 1.0) * jitter).round() } else { 0.0 };
    step.fingers
        .iter()
        .take(MAX_FINGERS)
        .enumerate()
        .map(|(index, finger)| {
            let dx = wobble(rng);
            let dy = wobble(rng);
            let mut points = vec![to_normalized(finger.x + dx, finger.y + dy, tab.reference, device, &tab.scale)];
            if let (Some(tx), Some(ty)) = (finger.to_x, finger.to_y) {
                let ex = tx + wobble(rng);
                let ey = ty + wobble(rng);
                points.push(to_normalized(ex, ey, tab.reference, device, &tab.scale));
            }
            GestureStroke {
                pointer: index as u8,
                start_ms: clamp(finger.start_ms.round(), 0.0, MAX_TOUCH_MS) as u32,
                duration_ms: clamp(finger.duration_ms.round(), MIN_TOUCH_MS, MAX_TOUCH_MS) as u32,
                points,
            }
        })
        .collect()
}

/* ------------------------------ runs ------------------------------ */

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRunStatus {
    pub name: String,
    /// waiting | ok | stub | error | skipped | busy
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSnapshot {
    pub tab_id: String,
    pub tab_name: String,
    /// running | paused | stopping | done | stopped | failed
    pub status: String,
    pub cycle: u64,
    pub step_index: usize,
    pub step_count: usize,
    pub touches: u64,
    pub started_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deadline: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub devices: BTreeMap<String, DeviceRunStatus>,
    /// Increments with every gesture sent (live ripples in browsers).
    pub touch_seq: u64,
    pub last_points: Vec<NormalizedPoint>,
    pub last_device_ids: Vec<String>,
    /// The last step as sent: one gesture per screen-size group.
    pub last_gestures: Vec<SentGesture>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SentGesture {
    pub device_ids: Vec<String>,
    pub strokes: Vec<GestureStroke>,
}

#[derive(Debug, Clone)]
pub struct RunDevice {
    pub id: String,
    pub name: String,
    pub online: bool,
    pub resolution: Size,
}

#[derive(Debug, Clone)]
pub struct SendResult {
    pub device_id: String,
    /// ok | stub | error
    pub inject: String,
    pub detail: Option<String>,
}

pub type SendFuture = Pin<Box<dyn Future<Output = Vec<SendResult>> + Send>>;
pub type Sender = Arc<dyn Fn(Vec<RunDevice>, Vec<GestureStroke>) -> SendFuture + Send + Sync>;

/// Stop and pause switches for one run.
#[derive(Default)]
pub struct RunControl {
    stop: AtomicBool,
    paused: AtomicBool,
    wake: Notify,
}

impl RunControl {
    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
        self.wake.notify_waiters();
    }
    pub fn pause(&self) {
        self.paused.store(true, Ordering::SeqCst);
    }
    pub fn resume(&self) {
        self.paused.store(false, Ordering::SeqCst);
        self.wake.notify_waiters();
    }
    pub fn stopped(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }
    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }
    /// Sleep `ms`, returning early on Stop.
    async fn sleep(&self, ms: u64) {
        if ms == 0 || self.stopped() {
            return;
        }
        let until = tokio::time::Instant::now() + std::time::Duration::from_millis(ms);
        while !self.stopped() {
            let notified = self.wake.notified();
            tokio::select! {
                _ = tokio::time::sleep_until(until) => return,
                _ = notified => {}
            }
        }
    }
    /// Wait while paused (returns on Resume or Stop).
    async fn wait_resume(&self) {
        while self.is_paused() && !self.stopped() {
            let notified = self.wake.notified();
            if !self.is_paused() || self.stopped() {
                break;
            }
            tokio::select! {
                _ = notified => {}
                _ = tokio::time::sleep(std::time::Duration::from_millis(250)) => {}
            }
        }
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub struct RunOptions {
    pub tab: MacroTab,
    pub devices: Vec<RunDevice>,
    /// Phones driven by another tab, with that tab's name.
    pub busy: HashMap<String, String>,
    pub only_step_id: Option<String>,
    pub send: Sender,
    pub control: Arc<RunControl>,
    pub snapshot: Arc<Mutex<RunSnapshot>>,
}

fn update(snapshot: &Arc<Mutex<RunSnapshot>>, change: impl FnOnce(&mut RunSnapshot)) {
    let mut guard = snapshot.lock().unwrap_or_else(|e| e.into_inner());
    change(&mut guard);
}

/// Play a tab on its phones until its stop condition (port of `runMacroTab`).
pub async fn run_tab(options: RunOptions) -> RunSnapshot {
    let RunOptions { tab, devices, busy, only_step_id, send, control, snapshot } = options;
    let steps: Vec<MacroStep> = match &only_step_id {
        Some(id) => tab.steps.iter().filter(|s| &s.id == id).cloned().collect(),
        None => tab.steps.iter().filter(|s| s.enabled).cloned().collect(),
    };
    let finish = |status: &str, message: &str| {
        update(&snapshot, |s| {
            s.status = status.into();
            s.finished_at = Some(now_ms());
            s.message = Some(message.into());
        });
        snapshot.lock().unwrap_or_else(|e| e.into_inner()).clone()
    };

    let mut active: Vec<RunDevice> = Vec::new();
    update(&snapshot, |s| {
        s.step_count = steps.len();
        for device in &devices {
            let row = if !device.online {
                DeviceRunStatus { name: device.name.clone(), state: "skipped".into(), detail: Some("offline".into()) }
            } else if let Some(other) = busy.get(&device.id) {
                DeviceRunStatus { name: device.name.clone(), state: "busy".into(), detail: Some(format!("running \"{other}\"")) }
            } else if tab.orientation == "match" && orientation_mismatch(tab.reference, Some(device.resolution)) {
                DeviceRunStatus { name: device.name.clone(), state: "skipped".into(), detail: Some("other orientation".into()) }
            } else {
                active.push(device.clone());
                DeviceRunStatus { name: device.name.clone(), state: "waiting".into(), detail: None }
            };
            s.devices.insert(device.id.clone(), row);
        }
    });
    if steps.is_empty() {
        return finish("failed", "No enabled steps to play");
    }
    if active.is_empty() {
        return finish("failed", "No phone to run on");
    }

    let max_cycles: u64 = if only_step_id.is_some() {
        1
    } else if tab.stop.mode == "cycles" {
        tab.stop.cycles.max(1.0).round() as u64
    } else {
        u64::MAX
    };
    let mut deadline: Option<u64> = if only_step_id.is_none() && tab.stop.mode == "time" {
        Some(now_ms() + (tab.stop.seconds.max(0.0) * 1000.0) as u64)
    } else {
        None
    };
    update(&snapshot, |s| s.deadline = deadline);
    let mut rng = Rng::seeded();

    let mut cycle: u64 = 1;
    while cycle <= max_cycles {
        update(&snapshot, |s| s.cycle = cycle);
        for (index, step) in steps.iter().enumerate() {
            if control.stopped() {
                return finish("stopped", "Stopped");
            }
            if control.is_paused() {
                let paused_at = now_ms();
                update(&snapshot, |s| s.status = "paused".into());
                control.wait_resume().await;
                if let Some(d) = deadline.as_mut() {
                    *d += now_ms() - paused_at;
                }
                update(&snapshot, |s| {
                    s.status = "running".into();
                    s.deadline = deadline;
                });
                if control.stopped() {
                    return finish("stopped", "Stopped");
                }
            }
            if deadline.is_some_and(|d| now_ms() >= d) {
                return finish("done", "Time is up");
            }
            update(&snapshot, |s| s.step_index = index);

            // Fit mode scales per screen size; stretch sends one gesture to all.
            let mut groups: Vec<(Option<Size>, Vec<RunDevice>)> = Vec::new();
            for device in &active {
                let key = if tab.scale == "fit" { Some(device.resolution) } else { None };
                match groups.iter_mut().find(|(k, _)| *k == key) {
                    Some((_, list)) => list.push(device.clone()),
                    None => groups.push((key, vec![device.clone()])),
                }
            }
            let mut results = Vec::new();
            let mut points = Vec::new();
            let mut ids = Vec::new();
            let mut sent = Vec::new();
            for (size, group) in groups {
                let strokes = build_strokes(step, &tab, size, &mut rng);
                for stroke in &strokes {
                    if let Some(p) = stroke.points.last() {
                        points.push(p.clone());
                    }
                }
                ids.extend(group.iter().map(|d| d.id.clone()));
                sent.push(SentGesture { device_ids: group.iter().map(|d| d.id.clone()).collect(), strokes: strokes.clone() });
                results.extend(send(group, strokes).await);
            }
            let mut failed_detail = None;
            update(&snapshot, |s| {
                s.touches += 1;
                s.touch_seq += 1;
                s.last_points = points;
                s.last_device_ids = ids;
                s.last_gestures = sent;
                for result in &results {
                    if let Some(row) = s.devices.get_mut(&result.device_id) {
                        row.state = result.inject.clone();
                        row.detail = result.detail.clone();
                    }
                    if result.inject == "error" {
                        failed_detail = result.detail.clone().or(failed_detail.take());
                        active.retain(|d| d.id != result.device_id);
                    }
                }
            });
            if active.is_empty() {
                let message = match failed_detail {
                    Some(detail) => format!("Every phone failed: {detail}"),
                    None => "Every phone failed".into(),
                };
                return finish("failed", &message);
            }
            let mut wait = clamp(step.delay_ms, 0.0, MAX_DELAY_MS) as u64;
            if let Some(d) = deadline {
                wait = wait.min(d.saturating_sub(now_ms()));
            }
            control.sleep(wait).await;
        }
        cycle += 1;
    }
    if only_step_id.is_some() {
        finish("done", "Step played")
    } else {
        finish("done", &format!("Finished {max_cycles} cycle{}", if max_cycles == 1 { "" } else { "s" }))
    }
}

/* ---------------------------- registry ---------------------------- */

struct LiveRun {
    tab_name: String,
    control: Arc<RunControl>,
    snapshot: Arc<Mutex<RunSnapshot>>,
}

#[derive(Default)]
pub struct MacroRuns {
    runs: Mutex<HashMap<String, LiveRun>>,
    finished: Mutex<HashMap<String, RunSnapshot>>,
    /// device id → tab id
    owners: Mutex<HashMap<String, String>>,
    version: AtomicU64,
    /// Woken when a run ends (queue waits on it).
    ended: Notify,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunsView {
    pub version: u64,
    pub runs: Vec<RunSnapshot>,
    /// Paused tabs (pause takes effect before the next step).
    pub paused: Vec<String>,
}

pub fn runs() -> &'static MacroRuns {
    static RUNS: OnceLock<MacroRuns> = OnceLock::new();
    RUNS.get_or_init(MacroRuns::default)
}

impl MacroRuns {
    fn bump(&self) {
        self.version.fetch_add(1, Ordering::SeqCst);
    }

    pub fn is_running(&self, tab_id: &str) -> bool {
        self.runs.lock().unwrap_or_else(|e| e.into_inner()).contains_key(tab_id)
    }

    /// Phones driven by another tab, with that tab's name.
    pub fn busy_phones(&self, tab_id: &str) -> HashMap<String, String> {
        let owners = self.owners.lock().unwrap_or_else(|e| e.into_inner());
        let runs = self.runs.lock().unwrap_or_else(|e| e.into_inner());
        owners
            .iter()
            .filter(|(_, owner)| owner.as_str() != tab_id)
            .filter_map(|(device, owner)| runs.get(owner).map(|r| (device.clone(), r.tab_name.clone())))
            .collect()
    }

    /// Start a tab. Err when it is already running.
    pub fn start(
        &'static self,
        tab: MacroTab,
        devices: Vec<RunDevice>,
        only_step_id: Option<String>,
        send: Sender,
    ) -> Result<(), String> {
        let tab_id = tab.id.clone();
        let busy = self.busy_phones(&tab_id);
        let control = Arc::new(RunControl::default());
        let claimed: Vec<String> = devices.iter().filter(|d| d.online && !busy.contains_key(&d.id)).map(|d| d.id.clone()).collect();
        let snapshot = Arc::new(Mutex::new(RunSnapshot {
            tab_id: tab_id.clone(),
            tab_name: tab.name.clone(),
            status: "running".into(),
            cycle: 1,
            step_index: 0,
            step_count: 0,
            touches: 0,
            started_at: now_ms(),
            finished_at: None,
            deadline: None,
            message: None,
            devices: BTreeMap::new(),
            touch_seq: 0,
            last_points: Vec::new(),
            last_device_ids: Vec::new(),
            last_gestures: Vec::new(),
        }));
        {
            let mut runs = self.runs.lock().unwrap_or_else(|e| e.into_inner());
            if runs.contains_key(&tab_id) {
                return Err(format!("\"{}\" is already running", tab.name));
            }
            let mut owners = self.owners.lock().unwrap_or_else(|e| e.into_inner());
            for id in &claimed {
                owners.insert(id.clone(), tab_id.clone());
            }
            runs.insert(
                tab_id.clone(),
                LiveRun { tab_name: tab.name.clone(), control: control.clone(), snapshot: snapshot.clone() },
            );
        }
        self.finished.lock().unwrap_or_else(|e| e.into_inner()).remove(&tab_id);
        self.bump();
        tokio::spawn(async move {
            let result = run_tab(RunOptions {
                tab,
                devices,
                busy,
                only_step_id,
                send,
                control,
                snapshot,
            })
            .await;
            self.finished.lock().unwrap_or_else(|e| e.into_inner()).insert(tab_id.clone(), result);
            self.runs.lock().unwrap_or_else(|e| e.into_inner()).remove(&tab_id);
            let mut owners = self.owners.lock().unwrap_or_else(|e| e.into_inner());
            for id in claimed {
                if owners.get(&id) == Some(&tab_id) {
                    owners.remove(&id);
                }
            }
            drop(owners);
            self.bump();
            self.ended.notify_waiters();
        });
        Ok(())
    }

    fn with_run(&self, tab_id: &str, act: impl FnOnce(&LiveRun)) -> bool {
        let runs = self.runs.lock().unwrap_or_else(|e| e.into_inner());
        match runs.get(tab_id) {
            Some(run) => {
                act(run);
                drop(runs);
                self.bump();
                true
            }
            None => false,
        }
    }

    pub fn stop(&self, tab_id: &str) -> bool {
        self.with_run(tab_id, |run| {
            run.control.stop();
            update(&run.snapshot, |s| s.status = "stopping".into());
        })
    }

    pub fn stop_all(&self) {
        let ids: Vec<String> = self.runs.lock().unwrap_or_else(|e| e.into_inner()).keys().cloned().collect();
        for id in ids {
            self.stop(&id);
        }
    }

    pub fn pause(&self, tab_id: &str) -> bool {
        self.with_run(tab_id, |run| run.control.pause())
    }

    pub fn resume(&self, tab_id: &str) -> bool {
        self.with_run(tab_id, |run| run.control.resume())
    }

    /// Every live run plus the last result of finished tabs.
    pub fn view(&self) -> RunsView {
        let runs = self.runs.lock().unwrap_or_else(|e| e.into_inner());
        let mut out: Vec<RunSnapshot> = runs.values().map(|r| r.snapshot.lock().unwrap_or_else(|e| e.into_inner()).clone()).collect();
        let paused = runs.iter().filter(|(_, r)| r.control.is_paused()).map(|(id, _)| id.clone()).collect();
        let finished = self.finished.lock().unwrap_or_else(|e| e.into_inner());
        out.extend(finished.iter().filter(|(id, _)| !runs.contains_key(*id)).map(|(_, s)| s.clone()));
        RunsView { version: self.version.load(Ordering::SeqCst), runs: out, paused }
    }

    /// Wait until `tab_id` is no longer running; returns its final snapshot.
    pub async fn wait_finished(&self, tab_id: &str) -> Option<RunSnapshot> {
        loop {
            let notified = self.ended.notified();
            if !self.is_running(tab_id) {
                return self.finished.lock().unwrap_or_else(|e| e.into_inner()).get(tab_id).cloned();
            }
            tokio::select! {
                _ = notified => {}
                _ = tokio::time::sleep(std::time::Duration::from_millis(500)) => {}
            }
        }
    }

    /// Forget a deleted tab's last result.
    pub fn forget(&self, tab_id: &str) {
        self.stop(tab_id);
        self.finished.lock().unwrap_or_else(|e| e.into_inner()).remove(tab_id);
        self.bump();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    fn tab_with(stop: (&str, f64, f64), steps: usize, delay: f64) -> MacroTab {
        MacroTab {
            id: format!("t-{}", uuid::Uuid::new_v4()),
            name: "Tab".into(),
            reference: Size { width: 1080.0, height: 2400.0 },
            scale: "stretch".into(),
            orientation: "any".into(),
            stop: MacroStop { mode: stop.0.into(), seconds: stop.1, cycles: stop.2 },
            jitter_px: 0.0,
            steps: (0..steps)
                .map(|i| MacroStep {
                    id: format!("s{i}"),
                    enabled: true,
                    fingers: vec![MacroFinger { x: 540.0, y: 1200.0, to_x: None, to_y: None, start_ms: 0.0, duration_ms: 50.0 }],
                    delay_ms: delay,
                })
                .collect(),
            target_ids: vec![],
        }
    }

    fn phone(id: &str) -> RunDevice {
        RunDevice { id: id.into(), name: id.to_uppercase(), online: true, resolution: Size { width: 1080.0, height: 2400.0 } }
    }

    fn counting_sender(count: Arc<AtomicUsize>, fail: Option<&'static str>) -> Sender {
        Arc::new(move |devices: Vec<RunDevice>, _strokes| {
            count.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                devices
                    .iter()
                    .map(|d| SendResult {
                        device_id: d.id.clone(),
                        inject: if Some(d.id.as_str()) == fail { "error".into() } else { "ok".into() },
                        detail: None,
                    })
                    .collect()
            })
        })
    }

    fn opts(tab: MacroTab, devices: Vec<RunDevice>, send: Sender, control: Arc<RunControl>) -> RunOptions {
        let snapshot = Arc::new(Mutex::new(RunSnapshot {
            tab_id: tab.id.clone(),
            tab_name: tab.name.clone(),
            status: "running".into(),
            cycle: 1,
            step_index: 0,
            step_count: 0,
            touches: 0,
            started_at: now_ms(),
            finished_at: None,
            deadline: None,
            message: None,
            devices: BTreeMap::new(),
            touch_seq: 0,
            last_points: vec![],
            last_device_ids: vec![],
            last_gestures: vec![],
        }));
        RunOptions { tab, devices, busy: HashMap::new(), only_step_id: None, send, control, snapshot }
    }

    #[test]
    fn placement_and_normalization_match_the_browser() {
        let reference = Size { width: 900.0, height: 1600.0 };
        // Stretch: straight fractions of the screen.
        let p = to_normalized(450.0, 400.0, reference, Some(Size { width: 1080.0, height: 2400.0 }), "stretch");
        assert!((p.x - 0.5).abs() < 1e-9 && (p.y - 0.25).abs() < 1e-9);
        // Fit on a taller screen: letterboxed top and bottom.
        let (left, top, w, h) = placement(reference, Some(Size { width: 1080.0, height: 2400.0 }), "fit");
        assert!((left - 0.0).abs() < 1e-9 && (w - 1.0).abs() < 1e-9);
        assert!((h - (1600.0 * 1.2 / 2400.0)).abs() < 1e-9);
        assert!((top - (1.0 - h) / 2.0).abs() < 1e-9);
        // Points outside the reference are clamped onto it.
        let q = to_normalized(-50.0, 99999.0, reference, None, "stretch");
        assert_eq!((q.x, q.y), (0.0, 1.0));
        assert!(orientation_mismatch(reference, Some(Size { width: 2400.0, height: 1080.0 })));
        assert!(!orientation_mismatch(reference, Some(Size { width: 1080.0, height: 2400.0 })));
    }

    #[test]
    fn strokes_keep_timing_limits_and_swipes() {
        let mut tab = tab_with(("cycles", 0.0, 1.0), 1, 0.0);
        tab.steps[0].fingers = vec![
            MacroFinger { x: 100.0, y: 100.0, to_x: Some(900.0), to_y: Some(100.0), start_ms: -5.0, duration_ms: 1.0 },
            MacroFinger { x: 200.0, y: 200.0, to_x: None, to_y: None, start_ms: 30.0, duration_ms: 999_999.0 },
        ];
        let strokes = build_strokes(&tab.steps[0], &tab, None, &mut Rng::new(1));
        assert_eq!(strokes.len(), 2);
        assert_eq!(strokes[0].points.len(), 2);
        assert_eq!((strokes[0].start_ms, strokes[0].duration_ms), (0, 10));
        assert_eq!((strokes[1].pointer, strokes[1].start_ms, strokes[1].duration_ms), (1, 30, 60_000));
        // Jitter stays within ±jitter px of the reference point.
        tab.jitter_px = 5.0;
        for seed in 1..50 {
            let s = build_strokes(&tab.steps[0], &tab, None, &mut Rng::new(seed));
            let x = s[1].points[0].x * 1080.0;
            assert!((x - 200.0).abs() <= 5.0 + 1e-6);
        }
    }

    #[tokio::test]
    async fn plays_cycles_then_finishes() {
        let count = Arc::new(AtomicUsize::new(0));
        let result = run_tab(opts(tab_with(("cycles", 0.0, 3.0), 2, 0.0), vec![phone("a")], counting_sender(count.clone(), None), Arc::default())).await;
        assert_eq!(result.status, "done");
        assert_eq!(count.load(Ordering::SeqCst), 6);
        assert_eq!(result.touches, 6);
    }

    #[tokio::test]
    async fn failed_phone_drops_out_and_all_failing_fails() {
        let count = Arc::new(AtomicUsize::new(0));
        let result = run_tab(opts(tab_with(("cycles", 0.0, 2.0), 1, 0.0), vec![phone("a"), phone("b")], counting_sender(count.clone(), Some("b")), Arc::default())).await;
        assert_eq!(result.status, "done");
        assert_eq!(result.devices["b"].state, "error");
        let solo = run_tab(opts(tab_with(("cycles", 0.0, 2.0), 1, 0.0), vec![phone("b")], counting_sender(count, Some("b")), Arc::default())).await;
        assert_eq!(solo.status, "failed");
    }

    #[tokio::test]
    async fn stop_and_time_limit() {
        let count = Arc::new(AtomicUsize::new(0));
        let control = Arc::new(RunControl::default());
        let c2 = control.clone();
        let handle = tokio::spawn(run_tab(opts(tab_with(("infinite", 0.0, 1.0), 1, 20.0), vec![phone("a")], counting_sender(count.clone(), None), control)));
        tokio::time::sleep(std::time::Duration::from_millis(120)).await;
        c2.stop();
        let stopped = handle.await.unwrap();
        assert_eq!(stopped.status, "stopped");
        assert!(count.load(Ordering::SeqCst) >= 2);

        let timed = run_tab(opts(tab_with(("time", 0.2, 1.0), 1, 30.0), vec![phone("a")], counting_sender(Arc::new(AtomicUsize::new(0)), None), Arc::default())).await;
        assert_eq!(timed.status, "done");
        assert_eq!(timed.message.as_deref(), Some("Time is up"));
    }

    #[tokio::test]
    async fn pause_holds_steps_and_extends_the_time_limit() {
        let count = Arc::new(AtomicUsize::new(0));
        let control = Arc::new(RunControl::default());
        let c2 = control.clone();
        let started = std::time::Instant::now();
        let handle = tokio::spawn(run_tab(opts(tab_with(("time", 0.3, 1.0), 1, 20.0), vec![phone("a")], counting_sender(count.clone(), None), control)));
        tokio::time::sleep(std::time::Duration::from_millis(60)).await;
        c2.pause();
        tokio::time::sleep(std::time::Duration::from_millis(60)).await;
        let frozen = count.load(Ordering::SeqCst);
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert_eq!(count.load(Ordering::SeqCst), frozen, "no touches while paused");
        c2.resume();
        let result = handle.await.unwrap();
        assert_eq!(result.status, "done");
        assert!(count.load(Ordering::SeqCst) > frozen, "plays again after resume");
        // 0.3 s of play plus ~0.36 s paused: the pause did not eat the time limit.
        assert!(started.elapsed().as_millis() >= 600);
    }

    #[tokio::test]
    async fn registry_locks_phones_per_tab() {
        let reg: &'static MacroRuns = Box::leak(Box::new(MacroRuns::default()));
        let count = Arc::new(AtomicUsize::new(0));
        let a = tab_with(("infinite", 0.0, 1.0), 1, 20.0);
        let b = tab_with(("cycles", 0.0, 1.0), 1, 0.0);
        reg.start(a.clone(), vec![phone("p1")], None, counting_sender(count.clone(), None)).unwrap();
        assert!(reg.start(a.clone(), vec![phone("p1")], None, counting_sender(count.clone(), None)).is_err());
        assert_eq!(reg.busy_phones(&b.id).get("p1").map(String::as_str), Some("Tab"));
        reg.start(b.clone(), vec![phone("p1")], None, counting_sender(count.clone(), None)).unwrap();
        let b_result = reg.wait_finished(&b.id).await.unwrap();
        assert_eq!(b_result.status, "failed", "p1 belongs to the other tab");
        assert!(reg.pause(&a.id));
        assert!(reg.view().paused.contains(&a.id));
        assert!(reg.stop(&a.id));
        let a_result = reg.wait_finished(&a.id).await.unwrap();
        assert_eq!(a_result.status, "stopped");
        assert!(reg.busy_phones(&b.id).is_empty());
    }
}
