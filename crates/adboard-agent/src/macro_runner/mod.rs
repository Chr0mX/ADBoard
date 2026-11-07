//! Macro runs on the agent. A run belongs to its phones (the scrcpy
//! instances), not to the browser that pressed Run: every browser sees it,
//! can pause or stop it, and it keeps going when that browser closes.
//!
//! Port of the browser runner in `src/lib/macro/core.ts` (`placement`,
//! `toNormalized`, `buildStrokes`, `runMacroTab`) and the run registry in
//! `src/lib/macro/runs.ts`. Runs are kept per phone: each phone has at most one
//! run, and every phone's run has its own cycles, pause, stop and failure, so
//! stopping or unplugging one phone never touches the others. Each step is
//! played through the same `handle_gesture` path as `/api/input/gesture`.
//!
//! Text steps (`kind: "text"`) read the phone's screen through `ocr` instead
//! of touching a fixed point: tap a text, wait until one shows or goes away,
//! check for one, or read one into a variable. Each ends in an outcome (next
//! step, go to a step, end or fail the run), which is how a macro branches on
//! what the screen shows. Runs are per phone, so every phone branches on its
//! own screen.

use crate::events::{Event, Severity};
use crate::ocr::{self, Area, ReadError, ScreenText, TextMatch, TextQuery};
use adboard_protocol::{GestureStroke, NormalizedPoint};
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
/// Longest a text step keeps looking.
pub const MAX_TEXT_WAIT_MS: f64 = 600_000.0;
pub const MIN_TEXT_INTERVAL_MS: f64 = 250.0;
pub const MAX_TEXT_INTERVAL_MS: f64 = 60_000.0;
/// Reads in a row that may fail (capture hiccups) before the step fails.
const MAX_READ_ERRORS: u32 = 3;
const TEXT_TAP_MS: u32 = 50;

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
    /// `touch` (missing in older macros) or `text`.
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub text: Option<TextStep>,
    #[serde(default)]
    pub app: Option<AppStep>,
}

/// An app step: open an app (`kind: "app"`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStep {
    pub package_name: String,
    /// Optional activity (`.MainActivity` or `pkg/.Activity`), optionally
    /// followed by `am start` arguments, as saved apps keep it.
    #[serde(default)]
    pub activity: String,
    /// Force-stop first, so the app opens from its start screen.
    #[serde(default)]
    pub restart: bool,
}

impl MacroStep {
    fn text_step(&self) -> Option<&TextStep> {
        if self.kind == "text" {
            self.text.as_ref()
        } else {
            None
        }
    }
}

fn yes() -> bool {
    true
}

/// A rectangle in reference pixels.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
pub struct RefArea {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// What a text step does next: `next`, `step` (go to `step_id`), `end` (the
/// run is done) or `fail`.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    #[serde(default = "go_next")]
    pub go: String,
    #[serde(default)]
    pub step_id: Option<String>,
}

fn go_next() -> String {
    "next".into()
}

impl Outcome {
    fn next() -> Self {
        Self { go: go_next(), step_id: None }
    }
    fn fail() -> Self {
        Self { go: "fail".into(), step_id: None }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextStep {
    /// tap | wait | gone | check | read
    pub action: String,
    #[serde(flatten)]
    pub query: TextQuery,
    /// Where to look, in reference pixels; None is the whole screen.
    #[serde(default)]
    pub area: Option<RefArea>,
    /// How long to keep looking; 0 looks once.
    #[serde(default)]
    pub timeout_ms: f64,
    #[serde(default = "default_interval")]
    pub interval_ms: f64,
    /// Tap: from the text's center, in reference pixels.
    #[serde(default)]
    pub offset_x: f64,
    #[serde(default)]
    pub offset_y: f64,
    /// Read: the variable to store into.
    #[serde(default)]
    pub variable: String,
    /// When the step's condition is met (found, gone, read).
    #[serde(default = "Outcome::next")]
    pub on_success: Outcome,
    /// When it is not met in time.
    #[serde(default = "Outcome::fail")]
    pub on_failure: Outcome,
}

fn default_interval() -> f64 {
    1000.0
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
    /// This run, in the event history (`run-…`).
    pub run_id: String,
    /// The phone this run drives.
    pub device_id: String,
    pub device_name: String,
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
    /// The text step looking now, or the last one decided.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<TextStatus>,
    /// Values stored by Read text steps.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub vars: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TextStatus {
    pub step_id: String,
    pub device_id: String,
    pub action: String,
    /// looking | met | missed | failed
    pub state: String,
    /// Screen reads so far in this step.
    pub looks: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// The text found, and where (0–1 of that phone's screen).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matched: Option<String>,
    #[serde(rename = "box", skip_serializing_if = "Option::is_none")]
    pub area: Option<Area>,
    /// Time of the last read, and whether it reused an unchanged picture.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_ms: Option<u64>,
    pub cached: bool,
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
/// Is this phone still connected? Asked before every step.
pub type OnlineCheck = Arc<dyn Fn(String) -> Pin<Box<dyn Future<Output = bool> + Send>> + Send + Sync>;
pub type ReadFuture = Pin<Box<dyn Future<Output = Result<ScreenText, ReadError>> + Send>>;
pub type CommandFuture = Pin<Box<dyn Future<Output = Result<String, String>> + Send>>;
/// A device command (`launch`, `forceStop`…) on one phone, as POST
/// /api/device/command runs it: `(phone, op, arg, arg2)`.
pub type CommandRunner = Arc<dyn Fn(RunDevice, &'static str, Option<String>, Option<String>) -> CommandFuture + Send + Sync>;

/// What a run uses to reach its phones.
#[derive(Clone)]
pub struct RunTools {
    pub send: Sender,
    /// None skips the connection check (tests).
    pub is_online: Option<OnlineCheck>,
    /// None fails text steps (no OCR on this path).
    pub read: Option<ScreenReader>,
    /// None fails app steps.
    pub command: Option<CommandRunner>,
}
/// The text in an area (0–1) of a phone's screen, for text steps.
pub type ScreenReader = Arc<dyn Fn(RunDevice, Area) -> ReadFuture + Send + Sync>;

pub const DISCONNECTED: &str = "Phone disconnected";

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
    /// Returns once Stop is pressed.
    async fn until_stopped(&self) {
        while !self.stopped() {
            let notified = self.wake.notified();
            if self.stopped() {
                break;
            }
            notified.await;
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
    /// None skips the connection check (tests).
    pub is_online: Option<OnlineCheck>,
    /// None fails text steps (no OCR on this path).
    pub read: Option<ScreenReader>,
    /// None fails app steps.
    pub command: Option<CommandRunner>,
    pub control: Arc<RunControl>,
    pub snapshot: Arc<Mutex<RunSnapshot>>,
}

fn update(snapshot: &Arc<Mutex<RunSnapshot>>, change: impl FnOnce(&mut RunSnapshot)) {
    let mut guard = snapshot.lock().unwrap_or_else(|e| e.into_inner());
    change(&mut guard);
}

/// Play a tab on its phones until its stop condition (port of `runMacroTab`).
pub async fn run_tab(options: RunOptions) -> RunSnapshot {
    let RunOptions { tab, devices, busy, only_step_id, send, is_online, read, command, control, snapshot } = options;
    let solo = devices.len() == 1;
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
        let message = match (solo, snapshot.lock().unwrap_or_else(|e| e.into_inner()).devices.values().next().cloned()) {
            (true, Some(row)) => format!("{}: {}", row.name, row.detail.unwrap_or_else(|| row.state.clone())),
            _ => "No phone to run on".into(),
        };
        return finish("failed", &message);
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
    let mut vars: BTreeMap<String, String> = BTreeMap::new();

    let mut cycle: u64 = 1;
    while cycle <= max_cycles {
        update(&snapshot, |s| s.cycle = cycle);
        // Index loop: a text step can jump to another step.
        let mut index = 0;
        while index < steps.len() {
            let step = &steps[index];
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

            // A phone that went away ends its part of the run (and only that).
            if let Some(check) = &is_online {
                let mut gone = Vec::new();
                for device in &active {
                    if !check(device.id.clone()).await {
                        gone.push(device.id.clone());
                    }
                }
                if !gone.is_empty() {
                    active.retain(|d| !gone.contains(&d.id));
                    update(&snapshot, |s| {
                        for id in &gone {
                            if let Some(row) = s.devices.get_mut(id) {
                                row.state = "error".into();
                                row.detail = Some(DISCONNECTED.into());
                            }
                        }
                    });
                    if active.is_empty() {
                        return finish("failed", if solo { DISCONNECTED } else { "Every phone disconnected" });
                    }
                }
            }

            let mut next = index + 1;
            if step.kind == "app" {
                let Some(app) = step.app.as_ref() else {
                    return finish("failed", &format!("Step {}: the app step has no settings", index + 1));
                };
                if let Some(message) = play_app_step(app, index + 1, &mut active, solo, command.as_ref(), &snapshot).await {
                    return finish("failed", &message);
                }
            } else if step.kind == "text" {
                let Some(text) = step.text_step() else {
                    return finish("failed", &format!("Step {}: the text step has no settings", index + 1));
                };
                let context = TextContext {
                    tab: &tab,
                    steps: &steps,
                    index,
                    solo,
                    single: only_step_id.is_some(),
                    read: read.as_ref(),
                    send: &send,
                    is_online: is_online.as_ref(),
                    control: &control,
                    snapshot: &snapshot,
                };
                match play_text_step(&context, text, &mut active, &mut deadline, &mut rng, &mut vars).await {
                    Flow::Next => {}
                    Flow::Goto(target) => next = target,
                    Flow::Finish(status, message) => return finish(status, &message),
                }
            } else {
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
                    let message = match (solo, failed_detail) {
                        (true, Some(detail)) => format!("Phone failed: {detail}"),
                        (true, None) => "Phone failed".into(),
                        (false, Some(detail)) => format!("Every phone failed: {detail}"),
                        (false, None) => "Every phone failed".into(),
                    };
                    return finish("failed", &message);
                }
            }
            let mut wait = clamp(step.delay_ms, 0.0, MAX_DELAY_MS) as u64;
            if let Some(d) = deadline {
                wait = wait.min(d.saturating_sub(now_ms()));
            }
            control.sleep(wait).await;
            index = next;
        }
        cycle += 1;
    }
    if only_step_id.is_some() {
        // A tested text step reports what it saw.
        let seen = snapshot.lock().unwrap_or_else(|e| e.into_inner()).text.as_ref().and_then(|t| t.detail.clone());
        let message = if steps[0].kind == "text" { seen.unwrap_or_else(|| "Step played".into()) } else { "Step played".into() };
        finish("done", &message)
    } else {
        finish("done", &format!("Finished {max_cycles} cycle{}", if max_cycles == 1 { "" } else { "s" }))
    }
}

/* ----------------------------- app steps ----------------------------- */

/// Open an app on the run's phones. A phone where it fails drops out like a
/// failed gesture; returns the run's failure message when none is left.
async fn play_app_step(app: &AppStep, n: usize, active: &mut Vec<RunDevice>, solo: bool, command: Option<&CommandRunner>, snapshot: &Arc<Mutex<RunSnapshot>>) -> Option<String> {
    let Some(command) = command else { return Some(format!("Step {n}: app steps need the ADBoard agent")) };
    let package = app.package_name.trim().to_string();
    if package.is_empty() {
        return Some(format!("Step {n}: choose the app to open"));
    }
    let activity = Some(app.activity.trim().to_string()).filter(|a| !a.is_empty());
    let runs = active.iter().map(|device| {
        let (device, package, activity) = (device.clone(), package.clone(), activity.clone());
        async move {
            if app.restart {
                // Not running is fine: launching is what matters.
                let _ = command(device.clone(), "forceStop", Some(package.clone()), None).await;
            }
            let result = command(device.clone(), "launch", Some(package), activity).await;
            (device.id, result)
        }
    });
    let results = futures_util::future::join_all(runs).await;
    let mut failed: Vec<(String, String)> = Vec::new();
    update(snapshot, |s| {
        for (id, result) in &results {
            let Some(row) = s.devices.get_mut(id) else { continue };
            match result {
                Ok(output) => {
                    row.state = "ok".into();
                    row.detail = Some(if output.is_empty() { format!("opened {package}") } else { output.clone() });
                }
                Err(error) => {
                    row.state = "error".into();
                    row.detail = Some(format!("Opening {package} failed: {error}"));
                    failed.push((id.clone(), error.clone()));
                }
            }
        }
    });
    active.retain(|d| !failed.iter().any(|(id, _)| id == &d.id));
    if !active.is_empty() {
        return None;
    }
    let reason = failed.first().map(|(_, e)| e.clone()).unwrap_or_default();
    Some(if solo { format!("Step {n}: opening {package} failed: {reason}") } else { format!("Every phone failed: step {n}: opening {package} failed: {reason}") })
}

/* ---------------------------- text steps ---------------------------- */

struct TextContext<'a> {
    tab: &'a MacroTab,
    steps: &'a [MacroStep],
    index: usize,
    solo: bool,
    /// Testing one step: jumps have nowhere to go, so they continue.
    single: bool,
    read: Option<&'a ScreenReader>,
    send: &'a Sender,
    is_online: Option<&'a OnlineCheck>,
    control: &'a RunControl,
    snapshot: &'a Arc<Mutex<RunSnapshot>>,
}

enum Flow {
    Next,
    Goto(usize),
    Finish(&'static str, String),
}

enum Look {
    /// The condition held: the first match (for tap / read) and what was seen.
    Met(Option<TextMatch>, String),
    Missed(String),
    Stopped,
    TimeUp,
    Disconnected,
    Failed(String),
}

const TEXT_ACTIONS: &[&str] = &["tap", "wait", "gone", "check", "read"];

fn wait_label(ms: u64) -> String {
    if ms < 60_000 {
        let s = ms as f64 / 1000.0;
        if ms.is_multiple_of(1000) { format!("{s:.0} s") } else { format!("{s:.1} s") }
    } else {
        format!("{} min", (ms as f64 / 60_000.0 * 10.0).round() / 10.0)
    }
}

/// “Sign in”, or “Sign in” or “Log in”.
fn texts_label(query: &TextQuery) -> String {
    let texts: Vec<String> = query.texts.iter().map(|t| t.trim()).filter(|t| !t.is_empty()).map(|t| format!("“{t}”")).collect();
    if texts.is_empty() { "text".into() } else { texts.join(" or ") }
}

/// A reference-pixel area → 0–1 of a phone's screen, scaled like touches.
fn screen_area(area: RefArea, tab: &MacroTab, device: &RunDevice) -> Area {
    let a = to_normalized(area.x, area.y, tab.reference, Some(device.resolution), &tab.scale);
    let b = to_normalized(area.x + area.width, area.y + area.height, tab.reference, Some(device.resolution), &tab.scale);
    Area { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y }
}

/// Where a Tap text step touches: the match's center plus the step's offset
/// (reference pixels, scaled like touches) and the tab's random offset.
fn tap_point(found: &TextMatch, text: &TextStep, tab: &MacroTab, device: &RunDevice, rng: &mut Rng) -> NormalizedPoint {
    let (cx, cy) = found.area.center();
    let (_, _, w, h) = placement(tab.reference, Some(device.resolution), &tab.scale);
    let mut wobble = || if tab.jitter_px > 0.0 { ((rng.next_f64() * 2.0 - 1.0) * tab.jitter_px).round() } else { 0.0 };
    let dx = text.offset_x + wobble();
    let dy = text.offset_y + wobble();
    NormalizedPoint { x: clamp(cx + dx / tab.reference.width * w, 0.0, 1.0), y: clamp(cy + dy / tab.reference.height * h, 0.0, 1.0) }
}

/// Look at one phone's screen until the step's condition holds or time runs out.
async fn look(cx: &TextContext<'_>, text: &TextStep, query: &TextQuery, device: &RunDevice, read: &ScreenReader, mut deadline: Option<u64>) -> (Look, u64) {
    let step_id = cx.steps[cx.index].id.clone();
    let area = text.area.map(|a| screen_area(a, cx.tab, device)).unwrap_or(Area::FULL);
    let wait = clamp(text.timeout_ms, 0.0, MAX_TEXT_WAIT_MS) as u64;
    let interval = clamp(text.interval_ms, MIN_TEXT_INTERVAL_MS, MAX_TEXT_INTERVAL_MS) as u64;
    let has_texts = query.texts.iter().any(|t| !t.trim().is_empty());
    let label = texts_label(query);
    let mut until = now_ms() + wait;
    let mut paused = 0;
    let mut looks = 0u32;
    let mut errors = 0u32;
    let mut detail = String::new();
    let status = |state: &str, looks: u32, detail: &str, found: Option<&TextMatch>, screen: Option<&ScreenText>| {
        update(cx.snapshot, |s| {
            s.text = Some(TextStatus {
                step_id: step_id.clone(),
                device_id: device.id.clone(),
                action: text.action.clone(),
                state: state.into(),
                looks,
                detail: (!detail.is_empty()).then(|| detail.to_string()),
                matched: found.map(|m| m.text.clone()),
                area: found.map(|m| m.area),
                read_ms: screen.map(|s| s.ms),
                cached: screen.is_some_and(|s| s.cached),
            });
            if let Some(row) = s.devices.get_mut(&device.id) {
                row.state = match state {
                    "met" => "found",
                    "missed" => "missing",
                    "failed" => "error",
                    _ => "reading",
                }
                .into();
                row.detail = (!detail.is_empty()).then(|| detail.to_string());
            }
        })
    };
    loop {
        if cx.control.stopped() {
            return (Look::Stopped, paused);
        }
        if cx.control.is_paused() {
            let at = now_ms();
            update(cx.snapshot, |s| s.status = "paused".into());
            cx.control.wait_resume().await;
            let held = now_ms() - at;
            paused += held;
            until += held;
            if let Some(d) = deadline.as_mut() {
                *d += held;
            }
            update(cx.snapshot, |s| {
                s.status = "running".into();
                s.deadline = deadline;
            });
            if cx.control.stopped() {
                return (Look::Stopped, paused);
            }
        }
        if deadline.is_some_and(|d| now_ms() >= d) {
            return (Look::TimeUp, paused);
        }
        // The step already checked before the first look.
        if looks > 0 {
            if let Some(check) = cx.is_online {
                if !check(device.id.clone()).await {
                    return (Look::Disconnected, paused);
                }
            }
        }
        status("looking", looks, &detail, None, None);
        let result = tokio::select! {
            result = read(device.clone(), area) => result,
            _ = cx.control.until_stopped() => return (Look::Stopped, paused),
        };
        looks += 1;
        match result {
            Err(error) if error.fatal() => {
                status("failed", looks, &error.message, None, None);
                return (Look::Failed(error.message), paused);
            }
            Err(error) => {
                errors += 1;
                detail = format!("cannot read the screen: {}", error.message);
                if errors >= MAX_READ_ERRORS {
                    status("failed", looks, &detail, None, None);
                    return (Look::Failed(detail), paused);
                }
            }
            Ok(screen) => {
                errors = 0;
                // Patterns were checked before looking.
                let found = ocr::find_matches(&screen.lines, query).unwrap_or_default().into_iter().next();
                let outcome = match text.action.as_str() {
                    "gone" if found.is_none() => Some((None, format!("{label} is gone"))),
                    "gone" => None,
                    "read" if !has_texts && !screen.lines.is_empty() => {
                        let value = screen.lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>().join("\n");
                        let all = screen.lines[1..].iter().fold(screen.lines[0].area, |a, l| union(a, l.area));
                        let detail = format!("Read “{}”", value.replace('\n', " / "));
                        Some((Some(TextMatch { text: value.clone(), value, area: all, line: 0 }), detail))
                    }
                    "read" => found.map(|m| (Some(m.clone()), format!("Read “{}”", m.value))),
                    _ => found.map(|m| (Some(m.clone()), format!("Found “{}”", m.text))),
                };
                if let Some((found, detail)) = outcome {
                    status("met", looks, &detail, found.as_ref(), Some(&screen));
                    return (Look::Met(found, detail), paused);
                }
                detail = match screen.lines.len() {
                    0 => "no text on screen".into(),
                    n if text.action == "gone" => format!("{label} still shown · {n} line{}", if n == 1 { "" } else { "s" }),
                    n => format!("{n} line{} read, no {label}", if n == 1 { "" } else { "s" }),
                };
                status("looking", looks, &detail, None, Some(&screen));
            }
        }
        let left = until.saturating_sub(now_ms());
        if left == 0 {
            let after = if wait > 0 { format!(" after {}", wait_label(wait)) } else { String::new() };
            let missed = match text.action.as_str() {
                "gone" => format!("{label} still shown{after}"),
                "check" => format!("{label} is not on screen"),
                "read" if !has_texts => format!("nothing to read{after}"),
                _ => format!("{label} not found{after}"),
            };
            let missed = if errors > 0 { format!("{missed} ({detail})") } else { missed };
            status("missed", looks, &missed, None, None);
            return (Look::Missed(missed), paused);
        }
        let mut nap = interval.min(left);
        if let Some(d) = deadline {
            nap = nap.min(d.saturating_sub(now_ms()));
        }
        cx.control.sleep(nap).await;
    }
}

fn union(a: Area, b: Area) -> Area {
    let x = a.x.min(b.x);
    let y = a.y.min(b.y);
    Area { x, y, width: (a.x + a.width).max(b.x + b.width) - x, height: (a.y + a.height).max(b.y + b.height) - y }
}

enum Resolved {
    Next,
    Goto(usize),
    End,
    Fail,
}

fn resolve(outcome: &Outcome, cx: &TextContext<'_>) -> Result<Resolved, String> {
    match outcome.go.as_str() {
        "step" if cx.single => Ok(Resolved::Next),
        "step" => {
            let id = outcome.step_id.as_deref().unwrap_or_default();
            cx.steps.iter().position(|s| s.id == id).map(Resolved::Goto).ok_or_else(|| "the step to go to is turned off or was deleted".into())
        }
        "end" => Ok(Resolved::End),
        "fail" => Ok(Resolved::Fail),
        _ => Ok(Resolved::Next),
    }
}

/// Play one text step on the run's phones (normally one: runs are per phone).
/// Phones whose outcome is Fail drop out like a failed gesture; the first
/// remaining phone's outcome decides where the run goes.
async fn play_text_step(
    cx: &TextContext<'_>,
    text: &TextStep,
    active: &mut Vec<RunDevice>,
    deadline: &mut Option<u64>,
    rng: &mut Rng,
    vars: &mut BTreeMap<String, String>,
) -> Flow {
    let n = cx.index + 1;
    let fail = |message: String| Flow::Finish("failed", format!("Step {n}: {message}"));
    let Some(read) = cx.read else { return fail("text steps need the ADBoard agent".into()) };
    if !TEXT_ACTIONS.contains(&text.action.as_str()) {
        return fail(format!("unknown text action “{}”", text.action));
    }
    let query = TextQuery {
        texts: text.query.texts.iter().map(|t| ocr::substitute(t, vars, text.query.mode == "regex")).collect(),
        ..text.query.clone()
    };
    if let Err(error) = ocr::compile(&query) {
        return fail(error);
    }
    if text.action != "read" && !query.texts.iter().any(|t| !t.trim().is_empty()) {
        return fail("enter the text to look for".into());
    }
    if text.action == "read" && !text.variable.is_empty() && !ocr::valid_variable(&text.variable) {
        return fail(format!("“{}” is not a usable variable name", text.variable));
    }

    let start = *deadline;
    let looks = futures_util::future::join_all(active.iter().map(|device| look(cx, text, &query, device, read, start))).await;
    if let (Some(d), Some(held)) = (deadline.as_mut(), looks.iter().map(|(_, p)| *p).max()) {
        *d += held;
    }
    update(cx.snapshot, |s| s.deadline = *deadline);

    let mut flow: Option<Flow> = None;
    let mut failures: Vec<(String, String)> = Vec::new();
    for (device, (seen, _)) in active.iter().zip(looks) {
        let (outcome, detail) = match seen {
            Look::Stopped => return Flow::Finish("stopped", "Stopped".into()),
            Look::TimeUp => return Flow::Finish("done", "Time is up".into()),
            Look::Disconnected => {
                failures.push((device.id.clone(), DISCONNECTED.into()));
                continue;
            }
            Look::Failed(message) => {
                failures.push((device.id.clone(), message));
                continue;
            }
            Look::Missed(detail) => {
                if text.action == "read" && !text.variable.is_empty() {
                    vars.insert(text.variable.clone(), String::new());
                }
                (&text.on_failure, detail)
            }
            Look::Met(found, mut detail) => {
                if text.action == "tap" {
                    let Some(found) = found.as_ref() else { continue };
                    let point = tap_point(found, text, cx.tab, device, rng);
                    let strokes = vec![GestureStroke { pointer: 0, start_ms: 0, duration_ms: TEXT_TAP_MS, points: vec![point] }];
                    let results = (cx.send)(vec![device.clone()], strokes.clone()).await;
                    let result = results.into_iter().find(|r| r.device_id == device.id);
                    let tapped = format!("Tapped “{}”", found.text);
                    update(cx.snapshot, |s| {
                        s.touches += 1;
                        s.touch_seq += 1;
                        s.last_points = vec![point];
                        s.last_device_ids = vec![device.id.clone()];
                        s.last_gestures = vec![SentGesture { device_ids: vec![device.id.clone()], strokes }];
                        if let Some(row) = s.devices.get_mut(&device.id) {
                            row.state = result.as_ref().map(|r| r.inject.clone()).unwrap_or_else(|| "error".into());
                            row.detail = Some(tapped.clone());
                        }
                        if let Some(status) = s.text.as_mut() {
                            status.detail = Some(tapped.clone());
                        }
                    });
                    match result {
                        Some(r) if r.inject != "error" => detail = tapped,
                        other => {
                            failures.push((device.id.clone(), other.and_then(|r| r.detail).unwrap_or_else(|| "tap failed".into())));
                            continue;
                        }
                    }
                }
                if text.action == "read" && !text.variable.is_empty() {
                    if let Some(found) = &found {
                        vars.insert(text.variable.clone(), found.value.clone());
                        detail = format!("{detail} into {}", text.variable);
                    }
                }
                (&text.on_success, detail)
            }
        };
        match resolve(outcome, cx) {
            Err(message) => return fail(message),
            Ok(Resolved::Fail) => failures.push((device.id.clone(), detail)),
            Ok(Resolved::End) => {
                flow.get_or_insert(Flow::Finish("done", format!("Ended at step {n}: {detail}")));
            }
            Ok(Resolved::Goto(target)) => {
                flow.get_or_insert(Flow::Goto(target));
            }
            Ok(Resolved::Next) => {
                flow.get_or_insert(Flow::Next);
            }
        }
    }

    let vars_now = vars.clone();
    update(cx.snapshot, |s| {
        s.vars = vars_now;
        for (id, message) in &failures {
            if let Some(row) = s.devices.get_mut(id) {
                row.state = "error".into();
                row.detail = Some(message.clone());
            }
        }
    });
    active.retain(|d| !failures.iter().any(|(id, _)| id == &d.id));
    if active.is_empty() {
        let detail = failures.first().map(|(_, m)| m.clone()).unwrap_or_else(|| "failed".into());
        return if cx.solo { fail(detail) } else { Flow::Finish("failed", format!("Every phone failed: step {n}: {detail}")) };
    }
    flow.unwrap_or(Flow::Next)
}

/* ---------------------------- registry ---------------------------- */

struct LiveRun {
    tab_id: String,
    tab_name: String,
    control: Arc<RunControl>,
    snapshot: Arc<Mutex<RunSnapshot>>,
}

/// Live runs keyed by phone (device id): one run per phone at most.
#[derive(Default)]
pub struct MacroRuns {
    runs: Mutex<HashMap<String, LiveRun>>,
    /// Each phone's last finished run.
    finished: Mutex<HashMap<String, RunSnapshot>>,
    version: AtomicU64,
    /// Woken when a run ends (queue waits on it).
    ended: Notify,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunsView {
    pub version: u64,
    /// One entry per phone: its live run, else its last finished run.
    pub runs: Vec<RunSnapshot>,
    /// Phones whose run is paused (pause takes effect before the next step).
    pub paused: Vec<String>,
}

/// Which phones a tab-level start started, and why the others were skipped.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartReport {
    pub started: Vec<String>,
    pub skipped: BTreeMap<String, DeviceRunStatus>,
}

fn run_event(s: &RunSnapshot, kind: &str, severity: Severity, summary: String) -> Event {
    Event::new("macro", kind, severity, summary)
        .source("macros")
        .device(&s.device_id, &s.device_name)
        .run(&s.run_id)
        .meta("macro", s.tab_name.clone())
        .meta("tabId", s.tab_id.clone())
}

/// The end of a run in the event history: result, reason, failing step,
/// cycles, touches and duration.
fn record_run_end(s: &RunSnapshot) {
    let message = s.message.clone().unwrap_or_default();
    let (kind, severity, summary) = match s.status.as_str() {
        "done" => ("macro.completed", Severity::Info, format!("{} finished on {}", s.tab_name, s.device_name)),
        "stopped" => ("macro.stopped", Severity::Info, format!("{} was stopped on {}", s.tab_name, s.device_name)),
        _ => ("macro.failed", Severity::Error, format!("{} failed on {}", s.tab_name, s.device_name)),
    };
    let ms = s.finished_at.unwrap_or_else(now_ms).saturating_sub(s.started_at);
    let seconds = ms / 1000;
    let mut event = run_event(s, kind, severity, summary)
        .detail(message)
        .meta("status", s.status.clone())
        .meta("cycles", s.cycle)
        .meta("touches", s.touches)
        .meta("durationSeconds", seconds)
        .meta("durationMs", ms);
    if s.status == "failed" && s.step_count > 0 {
        event = event.meta("step", s.step_index + 1).meta("steps", s.step_count);
    }
    if let Some(text) = &s.text {
        if s.status == "failed" && text.state != "met" {
            event = event.meta("textStep", text.detail.clone().unwrap_or_default());
        }
    }
    crate::events::record(event);
}

pub fn runs() -> &'static MacroRuns {
    static RUNS: OnceLock<MacroRuns> = OnceLock::new();
    RUNS.get_or_init(MacroRuns::default)
}

fn new_snapshot(tab: &MacroTab, device: &RunDevice) -> RunSnapshot {
    RunSnapshot {
        run_id: format!("run-{}", &uuid::Uuid::new_v4().simple().to_string()[..12]),
        device_id: device.id.clone(),
        device_name: device.name.clone(),
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
        last_points: Vec::new(),
        last_device_ids: Vec::new(),
        last_gestures: Vec::new(),
        text: None,
        vars: BTreeMap::new(),
    }
}

impl MacroRuns {
    fn bump(&self) {
        self.version.fetch_add(1, Ordering::SeqCst);
    }

    fn live(&self) -> std::sync::MutexGuard<'_, HashMap<String, LiveRun>> {
        self.runs.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Is `tab_id` running on any phone?
    pub fn is_running(&self, tab_id: &str) -> bool {
        self.live().values().any(|r| r.tab_id == tab_id)
    }

    pub fn device_busy(&self, device_id: &str) -> bool {
        self.live().contains_key(device_id)
    }

    /// Start `tab` on one phone. Err when that phone already has a run.
    pub fn start_device(
        &'static self,
        tab: MacroTab,
        device: RunDevice,
        only_step_id: Option<String>,
        tools: RunTools,
    ) -> Result<(), String> {
        let device_id = device.id.clone();
        let control = Arc::new(RunControl::default());
        let snapshot = Arc::new(Mutex::new(new_snapshot(&tab, &device)));
        {
            let mut live = self.live();
            if let Some(other) = live.get(&device_id) {
                return Err(format!("{} is already running \"{}\"", device.name, other.tab_name));
            }
            live.insert(
                device_id.clone(),
                LiveRun { tab_id: tab.id.clone(), tab_name: tab.name.clone(), control: control.clone(), snapshot: snapshot.clone() },
            );
        }
        self.bump();
        // Testing one step is routine; whole runs go in the event history.
        let recorded = only_step_id.is_none();
        if recorded {
            let s = snapshot.lock().unwrap_or_else(|e| e.into_inner()).clone();
            crate::events::record(run_event(&s, "macro.started", Severity::Info, format!("{} started on {}", s.tab_name, s.device_name)));
        }
        tokio::spawn(async move {
            // Clean up even if the run panics, so the phone is never left locked.
            struct Release(&'static MacroRuns, String, Arc<Mutex<RunSnapshot>>, bool);
            impl Drop for Release {
                fn drop(&mut self) {
                    let mut last = self.2.lock().unwrap_or_else(|e| e.into_inner()).clone();
                    if last.finished_at.is_none() {
                        last.status = "failed".into();
                        last.finished_at = Some(now_ms());
                        last.message = Some("The run ended unexpectedly".into());
                    }
                    if self.3 {
                        record_run_end(&last);
                    }
                    self.0.finished.lock().unwrap_or_else(|e| e.into_inner()).insert(self.1.clone(), last);
                    self.0.live().remove(&self.1);
                    self.0.bump();
                    self.0.ended.notify_waiters();
                }
            }
            let _release = Release(self, device_id, snapshot.clone(), recorded);
            run_tab(RunOptions {
                tab,
                devices: vec![device],
                busy: HashMap::new(),
                only_step_id,
                send: tools.send,
                is_online: tools.is_online,
                read: tools.read,
                command: tools.command,
                control,
                snapshot,
            })
            .await;
        });
        Ok(())
    }

    /// Start `tab` on each of `devices`: one independent run per phone.
    /// Offline phones and phones that already have a run are skipped (and
    /// reported). Err when none could start.
    pub fn start(
        &'static self,
        tab: MacroTab,
        devices: Vec<RunDevice>,
        only_step_id: Option<String>,
        tools: RunTools,
    ) -> Result<StartReport, String> {
        let mut report = StartReport::default();
        for device in devices {
            let id = device.id.clone();
            let name = device.name.clone();
            if !device.online {
                report.skipped.insert(id, DeviceRunStatus { name, state: "skipped".into(), detail: Some("offline".into()) });
                continue;
            }
            let other = self.live().get(&id).map(|r| r.tab_name.clone());
            match self.start_device(tab.clone(), device, only_step_id.clone(), tools.clone()) {
                Ok(()) => report.started.push(id),
                Err(error) => {
                    let detail = other.map(|t| format!("running \"{t}\"")).unwrap_or(error);
                    report.skipped.insert(id, DeviceRunStatus { name, state: "busy".into(), detail: Some(detail) });
                }
            }
        }
        if report.started.is_empty() {
            return Err(if report.skipped.is_empty() {
                "No phone ticked".into()
            } else {
                report.skipped.values().map(|r| format!("{} is {}", r.name, r.detail.clone().unwrap_or_default())).collect::<Vec<_>>().join("; ")
            });
        }
        Ok(report)
    }

    fn act(&self, pick: impl Fn(&str, &LiveRun) -> bool, act: impl Fn(&LiveRun)) -> bool {
        let live = self.live();
        let mut hit = false;
        for (device, run) in live.iter() {
            if pick(device, run) {
                act(run);
                hit = true;
            }
        }
        drop(live);
        if hit {
            self.bump();
        }
        hit
    }

    fn stop_run(run: &LiveRun) {
        run.control.stop();
        update(&run.snapshot, |s| s.status = "stopping".into());
    }

    /// Stop every phone running `tab_id`.
    pub fn stop(&self, tab_id: &str) -> bool {
        self.act(|_, r| r.tab_id == tab_id, Self::stop_run)
    }

    pub fn stop_device(&self, device_id: &str) -> bool {
        self.act(|d, _| d == device_id, Self::stop_run)
    }

    pub fn stop_all(&self) {
        self.act(|_, _| true, Self::stop_run);
    }

    pub fn pause(&self, tab_id: &str) -> bool {
        self.act(|_, r| r.tab_id == tab_id, |r| r.control.pause())
    }

    pub fn resume(&self, tab_id: &str) -> bool {
        self.act(|_, r| r.tab_id == tab_id, |r| r.control.resume())
    }

    pub fn pause_device(&self, device_id: &str) -> bool {
        self.act(|d, _| d == device_id, |r| r.control.pause())
    }

    pub fn resume_device(&self, device_id: &str) -> bool {
        self.act(|d, _| d == device_id, |r| r.control.resume())
    }

    /// Every phone's live run, plus the last result of phones not running.
    pub fn view(&self) -> RunsView {
        let live = self.live();
        let mut out: Vec<RunSnapshot> = live.values().map(|r| r.snapshot.lock().unwrap_or_else(|e| e.into_inner()).clone()).collect();
        let paused = live.iter().filter(|(_, r)| r.control.is_paused()).map(|(id, _)| id.clone()).collect();
        let finished = self.finished.lock().unwrap_or_else(|e| e.into_inner());
        out.extend(finished.iter().filter(|(id, _)| !live.contains_key(*id)).map(|(_, s)| s.clone()));
        out.sort_by(|a, b| a.device_id.cmp(&b.device_id));
        RunsView { version: self.version.load(Ordering::SeqCst), runs: out, paused }
    }

    /// Wait until none of `device_ids` has a live run; returns their last results.
    pub async fn wait_devices(&self, device_ids: &[String]) -> Vec<RunSnapshot> {
        loop {
            let notified = self.ended.notified();
            if !device_ids.iter().any(|id| self.device_busy(id)) {
                let finished = self.finished.lock().unwrap_or_else(|e| e.into_inner());
                return device_ids.iter().filter_map(|id| finished.get(id).cloned()).collect();
            }
            tokio::select! {
                _ = notified => {}
                _ = tokio::time::sleep(std::time::Duration::from_millis(500)) => {}
            }
        }
    }

    /// Forget a deleted tab: stop it and drop its last results.
    pub fn forget(&self, tab_id: &str) {
        self.stop(tab_id);
        self.finished.lock().unwrap_or_else(|e| e.into_inner()).retain(|_, s| s.tab_id != tab_id);
        self.bump();
    }
}

#[cfg(test)]
mod tests;
