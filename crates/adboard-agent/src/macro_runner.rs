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
    pub control: Arc<RunControl>,
    pub snapshot: Arc<Mutex<RunSnapshot>>,
}

fn update(snapshot: &Arc<Mutex<RunSnapshot>>, change: impl FnOnce(&mut RunSnapshot)) {
    let mut guard = snapshot.lock().unwrap_or_else(|e| e.into_inner());
    change(&mut guard);
}

/// Play a tab on its phones until its stop condition (port of `runMacroTab`).
pub async fn run_tab(options: RunOptions) -> RunSnapshot {
    let RunOptions { tab, devices, busy, only_step_id, send, is_online, read, control, snapshot } = options;
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
            if step.kind == "text" {
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

pub fn runs() -> &'static MacroRuns {
    static RUNS: OnceLock<MacroRuns> = OnceLock::new();
    RUNS.get_or_init(MacroRuns::default)
}

fn new_snapshot(tab: &MacroTab, device: &RunDevice) -> RunSnapshot {
    RunSnapshot {
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
        send: Sender,
        is_online: Option<OnlineCheck>,
        read: Option<ScreenReader>,
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
        tokio::spawn(async move {
            // Clean up even if the run panics, so the phone is never left locked.
            struct Release(&'static MacroRuns, String, Arc<Mutex<RunSnapshot>>);
            impl Drop for Release {
                fn drop(&mut self) {
                    let mut last = self.2.lock().unwrap_or_else(|e| e.into_inner()).clone();
                    if last.finished_at.is_none() {
                        last.status = "failed".into();
                        last.finished_at = Some(now_ms());
                        last.message = Some("The run ended unexpectedly".into());
                    }
                    self.0.finished.lock().unwrap_or_else(|e| e.into_inner()).insert(self.1.clone(), last);
                    self.0.live().remove(&self.1);
                    self.0.bump();
                    self.0.ended.notify_waiters();
                }
            }
            let _release = Release(self, device_id, snapshot.clone());
            run_tab(RunOptions {
                tab,
                devices: vec![device],
                busy: HashMap::new(),
                only_step_id,
                send,
                is_online,
                read,
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
        send: Sender,
        is_online: Option<OnlineCheck>,
        read: Option<ScreenReader>,
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
            match self.start_device(tab.clone(), device, only_step_id.clone(), send.clone(), is_online.clone(), read.clone()) {
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
                    kind: String::new(),
                    text: None,
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
        let first = devices.first().cloned().unwrap_or_else(|| phone("none"));
        let snapshot = Arc::new(Mutex::new(new_snapshot(&tab, &first)));
        RunOptions { tab, devices, busy: HashMap::new(), only_step_id: None, send, is_online: None, read: None, control, snapshot }
    }

    fn named(mut tab: MacroTab, name: &str) -> MacroTab {
        tab.name = name.into();
        tab
    }

    /// Records which tab each gesture came from, per phone.
    fn recording_sender(log: Arc<Mutex<Vec<String>>>, fail: Option<&'static str>) -> Sender {
        Arc::new(move |devices: Vec<RunDevice>, _strokes| {
            let log = log.clone();
            Box::pin(async move {
                devices
                    .iter()
                    .map(|d| {
                        log.lock().unwrap().push(d.id.clone());
                        SendResult {
                            device_id: d.id.clone(),
                            inject: if Some(d.id.as_str()) == fail { "error".into() } else { "ok".into() },
                            detail: None,
                        }
                    })
                    .collect()
            })
        })
    }

    fn touches(log: &Arc<Mutex<Vec<String>>>, id: &str) -> usize {
        log.lock().unwrap().iter().filter(|d| d.as_str() == id).count()
    }

    fn leak() -> &'static MacroRuns {
        Box::leak(Box::new(MacroRuns::default()))
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
    async fn two_phones_run_different_macros_at_once() {
        let reg = leak();
        let log = Arc::new(Mutex::new(Vec::new()));
        let a = named(tab_with(("infinite", 0.0, 1.0), 1, 15.0), "Farm");
        let b = named(tab_with(("infinite", 0.0, 1.0), 2, 15.0), "Collect");
        reg.start_device(a.clone(), phone("s24"), None, recording_sender(log.clone(), None), None, None).unwrap();
        reg.start_device(b.clone(), phone("s23"), None, recording_sender(log.clone(), None), None, None).unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        let view = reg.view();
        let by = |id: &str| view.runs.iter().find(|r| r.device_id == id).cloned().unwrap();
        assert_eq!((by("s24").tab_name.as_str(), by("s23").tab_name.as_str()), ("Farm", "Collect"));
        assert!(touches(&log, "s24") >= 3 && touches(&log, "s23") >= 3);
        assert!(reg.is_running(&a.id) && reg.is_running(&b.id));

        // A second start on a busy phone is refused; the first run is untouched.
        let dup = reg.start_device(b.clone(), phone("s24"), None, recording_sender(log.clone(), None), None, None);
        assert!(dup.unwrap_err().contains("already running \"Farm\""));

        // Stopping one phone leaves the other running.
        assert!(reg.stop_device("s24"));
        let s24 = reg.wait_devices(&["s24".to_string()]).await;
        assert_eq!(s24[0].status, "stopped");
        let before = touches(&log, "s23");
        tokio::time::sleep(std::time::Duration::from_millis(120)).await;
        assert!(touches(&log, "s23") > before, "s23 keeps playing");
        assert!(!reg.device_busy("s24") && reg.device_busy("s23"));

        // Pause is per phone too.
        assert!(reg.pause_device("s23"));
        assert_eq!(reg.view().paused, vec!["s23".to_string()]);
        assert!(reg.resume_device("s23"));
        reg.stop_all();
        reg.wait_devices(&["s23".to_string()]).await;
        assert!(!reg.device_busy("s23") && !reg.device_busy("s24"), "every lock is released");
    }

    #[tokio::test]
    async fn one_phone_failing_does_not_stop_the_other() {
        let reg = leak();
        let log = Arc::new(Mutex::new(Vec::new()));
        let tab = tab_with(("infinite", 0.0, 1.0), 1, 15.0);
        // Same macro on both phones = two runs; s23's gestures fail.
        let started = reg.start(tab.clone(), vec![phone("s24"), phone("s23")], None, recording_sender(log.clone(), Some("s23")), None, None).unwrap().started;
        assert_eq!(started.len(), 2);
        let failed = reg.wait_devices(&["s23".to_string()]).await;
        assert_eq!(failed[0].status, "failed");
        let before = touches(&log, "s24");
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert!(touches(&log, "s24") > before);
        // A tab-level start skips the busy phone and reports when none is free.
        assert!(reg.start(tab.clone(), vec![phone("s24")], None, recording_sender(log.clone(), None), None, None).is_err());
        let other = tab_with(("cycles", 0.0, 1.0), 1, 0.0);
        let report = reg.start(other, vec![phone("s24"), phone("p3")], None, recording_sender(log.clone(), None), None, None).unwrap();
        assert_eq!(report.started, vec!["p3".to_string()]);
        assert_eq!(report.skipped["s24"].state, "busy");
        assert_eq!(report.skipped["s24"].detail.as_deref(), Some("running \"Tab\""));
        reg.wait_devices(&report.started).await;
        assert!(reg.stop(&tab.id));
        let done = reg.wait_devices(&started).await;
        assert_eq!(done.iter().find(|r| r.device_id == "s24").unwrap().status, "stopped");
        reg.forget(&tab.id);
        assert!(reg.view().runs.iter().all(|r| r.tab_id != tab.id), "forgotten tab leaves no results");
    }

    #[tokio::test]
    async fn a_disconnected_phone_ends_only_its_run() {
        let reg = leak();
        let log = Arc::new(Mutex::new(Vec::new()));
        let unplugged = Arc::new(AtomicBool::new(false));
        let flag = unplugged.clone();
        let online: OnlineCheck = Arc::new(move |id: String| {
            let gone = flag.load(Ordering::SeqCst) && id == "s24";
            Box::pin(async move { !gone })
        });
        let tab = tab_with(("infinite", 0.0, 1.0), 1, 15.0);
        reg.start(tab.clone(), vec![phone("s24"), phone("s23")], None, recording_sender(log.clone(), None), Some(online), None).unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(60)).await;
        unplugged.store(true, Ordering::SeqCst);
        let ended = reg.wait_devices(&["s24".to_string()]).await;
        assert_eq!((ended[0].status.as_str(), ended[0].message.as_deref()), ("failed", Some(DISCONNECTED)));
        assert!(!reg.device_busy("s24"), "lock released");
        let before = touches(&log, "s23");
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert!(touches(&log, "s23") > before, "s23 keeps playing");
        reg.stop_all();
        reg.wait_devices(&["s23".to_string()]).await;
    }

    #[tokio::test]
    async fn offline_phones_are_skipped_at_start() {
        let reg = leak();
        let mut off = phone("a52");
        off.online = false;
        let err = reg.start(tab_with(("cycles", 0.0, 1.0), 1, 0.0), vec![off], None, counting_sender(Arc::default(), None), None, None).unwrap_err();
        assert!(err.contains("offline"));
        assert!(reg.view().runs.is_empty());
    }

    /* --------------------------- text steps --------------------------- */

    use crate::ocr::{ReadErrorKind, TextLine};

    /// A screen with these lines (0.2 × 0.02 of the screen each, at x, y).
    fn screen_of(lines: &[(&str, f64, f64)]) -> ScreenText {
        ScreenText {
            width: 1080,
            height: 2400,
            lines: lines
                .iter()
                .map(|&(text, x, y)| TextLine { text: text.into(), area: Area { x, y, width: 0.2, height: 0.02 }, confidence: None, chars: vec![] })
                .collect(),
            engine: "test".into(),
            ms: 1,
            cached: false,
        }
    }

    type Script = dyn Fn(&str, usize) -> Result<ScreenText, ReadError> + Send + Sync;

    /// Answers each read from `script(device, nth read of that device)`; counts reads.
    fn scripted(script: Arc<Script>) -> (ScreenReader, Arc<Mutex<HashMap<String, usize>>>) {
        let reads = Arc::new(Mutex::new(HashMap::<String, usize>::new()));
        let counter = reads.clone();
        let reader: ScreenReader = Arc::new(move |device: RunDevice, _area| {
            let n = {
                let mut map = counter.lock().unwrap();
                let entry = map.entry(device.id.clone()).or_default();
                *entry += 1;
                *entry
            };
            let answer = script(&device.id, n);
            Box::pin(async move { answer })
        });
        (reader, reads)
    }

    fn text_step(id: &str, action: &str, texts: &[&str], timeout_ms: f64) -> MacroStep {
        MacroStep {
            id: id.into(),
            enabled: true,
            fingers: vec![],
            delay_ms: 0.0,
            kind: "text".into(),
            text: Some(TextStep {
                action: action.into(),
                query: TextQuery { texts: texts.iter().map(|t| t.to_string()).collect(), mode: "contains".into(), case_sensitive: false },
                area: None,
                timeout_ms,
                interval_ms: MIN_TEXT_INTERVAL_MS,
                offset_x: 0.0,
                offset_y: 0.0,
                variable: String::new(),
                on_success: Outcome::next(),
                on_failure: Outcome::fail(),
            }),
        }
    }

    fn touch_step(id: &str, x: f64) -> MacroStep {
        MacroStep {
            id: id.into(),
            enabled: true,
            fingers: vec![MacroFinger { x, y: 1200.0, to_x: None, to_y: None, start_ms: 0.0, duration_ms: 20.0 }],
            delay_ms: 0.0,
            kind: String::new(),
            text: None,
        }
    }

    fn tab_of(steps: Vec<MacroStep>) -> MacroTab {
        let mut tab = tab_with(("cycles", 0.0, 1.0), 0, 0.0);
        tab.steps = steps;
        tab
    }

    fn edit(step: &mut MacroStep, change: impl FnOnce(&mut TextStep)) {
        change(step.text.as_mut().unwrap());
    }

    /// Records each gesture's first point (x as 0–1) per phone.
    fn point_sender(log: Arc<Mutex<Vec<(String, f64, f64)>>>) -> Sender {
        Arc::new(move |devices: Vec<RunDevice>, strokes: Vec<GestureStroke>| {
            let log = log.clone();
            Box::pin(async move {
                devices
                    .iter()
                    .map(|d| {
                        let p = &strokes[0].points[0];
                        log.lock().unwrap().push((d.id.clone(), p.x, p.y));
                        SendResult { device_id: d.id.clone(), inject: "ok".into(), detail: None }
                    })
                    .collect()
            })
        })
    }

    fn text_opts(tab: MacroTab, devices: Vec<RunDevice>, send: Sender, read: ScreenReader, control: Arc<RunControl>) -> RunOptions {
        let mut options = opts(tab, devices, send, control);
        options.read = Some(read);
        options
    }

    #[tokio::test]
    async fn tap_text_touches_the_center_of_the_match() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let (reader, _) = scripted(Arc::new(|_, _| Ok(screen_of(&[("Welcome", 0.1, 0.1), ("Sign in", 0.4, 0.5)]))));
        let mut step = text_step("t", "tap", &["SIGN IN"], 1000.0);
        edit(&mut step, |t| t.offset_x = 108.0); // 10% of the 1080 reference width
        let result = run_tab(text_opts(tab_of(vec![step]), vec![phone("a")], point_sender(log.clone()), reader, Arc::default())).await;
        assert_eq!(result.status, "done", "{:?}", result.message);
        let sent = log.lock().unwrap().clone();
        assert_eq!(sent.len(), 1);
        assert!((sent[0].1 - 0.6).abs() < 1e-9 && (sent[0].2 - 0.51).abs() < 1e-9, "{sent:?}");
        assert_eq!(result.touches, 1);
        let text = result.text.unwrap();
        assert_eq!((text.state.as_str(), text.matched.as_deref(), text.detail.as_deref()), ("met", Some("Sign in"), Some("Tapped “Sign in”")));
    }

    #[tokio::test]
    async fn wait_polls_until_the_text_appears_then_continues() {
        let log = Arc::new(Mutex::new(Vec::new()));
        // "Home" shows from the third read on.
        let (reader, reads) = scripted(Arc::new(|_, n| Ok(if n < 3 { screen_of(&[("Loading", 0.4, 0.5)]) } else { screen_of(&[("Home", 0.4, 0.1)]) })));
        let tab = tab_of(vec![text_step("w", "wait", &["home"], 5000.0), touch_step("after", 540.0)]);
        let result = run_tab(text_opts(tab, vec![phone("a")], point_sender(log.clone()), reader, Arc::default())).await;
        assert_eq!(result.status, "done");
        assert_eq!(reads.lock().unwrap()["a"], 3);
        assert_eq!(log.lock().unwrap().len(), 1, "the touch after the wait played");
        assert_eq!(result.text.unwrap().looks, 3);
    }

    #[tokio::test]
    async fn a_wait_that_times_out_fails_the_run_with_a_reason() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let (reader, reads) = scripted(Arc::new(|_, _| Ok(screen_of(&[("Loading", 0.4, 0.5)]))));
        let tab = tab_of(vec![text_step("w", "wait", &["Home", "Start"], 600.0), touch_step("after", 540.0)]);
        let started = std::time::Instant::now();
        let result = run_tab(text_opts(tab, vec![phone("a")], point_sender(log.clone()), reader, Arc::default())).await;
        assert_eq!(result.status, "failed");
        assert_eq!(result.message.as_deref(), Some("Step 1: “Home” or “Start” not found after 0.6 s"));
        assert!(started.elapsed().as_millis() >= 600);
        // Reads at 0, 250, 500 and the timeout itself.
        assert_eq!(reads.lock().unwrap()["a"], 4);
        assert!(log.lock().unwrap().is_empty(), "nothing after a failed wait");
        assert_eq!(result.devices["a"].state, "error");
    }

    #[tokio::test]
    async fn gone_waits_for_the_text_to_disappear() {
        let (reader, reads) = scripted(Arc::new(|_, n| Ok(if n < 2 { screen_of(&[("Please wait", 0.4, 0.5)]) } else { screen_of(&[]) })));
        let result = run_tab(text_opts(tab_of(vec![text_step("g", "gone", &["please wait"], 3000.0)]), vec![phone("a")], counting_sender(Arc::default(), None), reader, Arc::default())).await;
        assert_eq!(result.status, "done");
        assert_eq!(reads.lock().unwrap()["a"], 2);
        assert_eq!(result.text.unwrap().detail.as_deref(), Some("“please wait” is gone"));
    }

    /// Login flow: check for an error message and branch on it.
    #[tokio::test]
    async fn check_branches_to_another_step() {
        for (screen, expect) in [("Login failed", vec![0.9]), ("Welcome back", vec![0.1, 0.5])] {
            let log = Arc::new(Mutex::new(Vec::new()));
            let (reader, _) = scripted(Arc::new(move |_, _| Ok(screen_of(&[(screen, 0.3, 0.3)]))));
            let mut check = text_step("check", "check", &["failed", "wrong password"], 0.0);
            edit(&mut check, |t| {
                t.on_success = Outcome { go: "step".into(), step_id: Some("retry".into()) };
                t.on_failure = Outcome::next();
            });
            let mut ok = touch_step("ok-1", 108.0);
            ok.delay_ms = 0.0;
            let mut end = text_step("end", "check", &["anything"], 0.0);
            edit(&mut end, |t| {
                t.on_success = Outcome { go: "end".into(), step_id: None };
                t.on_failure = Outcome { go: "end".into(), step_id: None };
            });
            let tab = tab_of(vec![check, ok, touch_step("ok-2", 540.0), end, touch_step("retry", 972.0)]);
            let result = run_tab(text_opts(tab, vec![phone("a")], point_sender(log.clone()), reader, Arc::default())).await;
            assert_eq!(result.status, "done", "{:?}", result.message);
            let xs: Vec<f64> = log.lock().unwrap().iter().map(|(_, x, _)| (x * 10.0).round() / 10.0).collect();
            assert_eq!(xs, expect, "screen “{screen}”");
            if screen == "Welcome back" {
                assert_eq!(result.message.as_deref(), Some("Ended at step 4: “anything” is not on screen"));
            }
        }
    }

    #[tokio::test]
    async fn read_stores_a_variable_that_later_steps_use() {
        let (reader, _) = scripted(Arc::new(|_, _| Ok(screen_of(&[("Your code: 4821", 0.1, 0.2), ("Enter 4821 to continue", 0.1, 0.6)]))));
        let mut read = text_step("r", "read", &[r"code:\s*(\d+)"], 0.0);
        edit(&mut read, |t| {
            t.query.mode = "regex".into();
            t.variable = "code".into();
        });
        let log = Arc::new(Mutex::new(Vec::new()));
        let tab = tab_of(vec![read, text_step("t", "tap", &["enter {code}"], 0.0)]);
        let result = run_tab(text_opts(tab, vec![phone("a")], point_sender(log.clone()), reader, Arc::default())).await;
        assert_eq!(result.status, "done", "{:?}", result.message);
        assert_eq!(result.vars.get("code").map(String::as_str), Some("4821"));
        let sent = log.lock().unwrap().clone();
        assert!((sent[0].2 - 0.61).abs() < 1e-9, "tapped the line with the code: {sent:?}");
    }

    #[tokio::test]
    async fn stop_ends_a_long_wait_at_once() {
        let (reader, _) = scripted(Arc::new(|_, _| Ok(screen_of(&[]))));
        let control = Arc::new(RunControl::default());
        let c2 = control.clone();
        let handle = tokio::spawn(run_tab(text_opts(tab_of(vec![text_step("w", "wait", &["never"], 600_000.0)]), vec![phone("a")], counting_sender(Arc::default(), None), reader, control)));
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let asked = std::time::Instant::now();
        c2.stop();
        let result = handle.await.unwrap();
        assert_eq!(result.status, "stopped");
        assert!(asked.elapsed().as_millis() < 200, "stop is not held up by the wait");
    }

    #[tokio::test]
    async fn stop_does_not_wait_for_a_slow_read() {
        // A read that never answers (e.g. a hung capture).
        let reader: ScreenReader = Arc::new(|_, _| Box::pin(std::future::pending()));
        let control = Arc::new(RunControl::default());
        let c2 = control.clone();
        let handle = tokio::spawn(run_tab(text_opts(tab_of(vec![text_step("w", "wait", &["x"], 10_000.0)]), vec![phone("a")], counting_sender(Arc::default(), None), reader, control)));
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        c2.stop();
        let result = tokio::time::timeout(std::time::Duration::from_millis(500), handle).await.expect("stopped in time").unwrap();
        assert_eq!(result.status, "stopped");
    }

    #[tokio::test]
    async fn pause_holds_the_wait_and_its_timeout() {
        let (reader, reads) = scripted(Arc::new(|_, _| Ok(screen_of(&[]))));
        let control = Arc::new(RunControl::default());
        let c2 = control.clone();
        let started = std::time::Instant::now();
        let handle = tokio::spawn(run_tab(text_opts(tab_of(vec![text_step("w", "wait", &["x"], 500.0)]), vec![phone("a")], counting_sender(Arc::default(), None), reader, control)));
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        c2.pause();
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let frozen = reads.lock().unwrap()["a"];
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        assert_eq!(reads.lock().unwrap()["a"], frozen, "no reads while paused");
        c2.resume();
        let result = handle.await.unwrap();
        assert_eq!(result.status, "failed");
        // 0.5 s of looking plus ~0.6 s paused: the pause did not eat the timeout.
        assert!(started.elapsed().as_millis() >= 1000);
    }

    #[tokio::test]
    async fn read_errors_are_retried_and_missing_models_fail_at_once() {
        // Two failed captures, then the text.
        let (reader, reads) = scripted(Arc::new(|_, n| if n <= 2 { Err(ReadError::failed("adb: device busy")) } else { Ok(screen_of(&[("Ready", 0.1, 0.1)])) }));
        let result = run_tab(text_opts(tab_of(vec![text_step("w", "wait", &["ready"], 5000.0)]), vec![phone("a")], counting_sender(Arc::default(), None), reader, Arc::default())).await;
        assert_eq!((result.status.as_str(), reads.lock().unwrap()["a"]), ("done", 3));

        let (reader, _) = scripted(Arc::new(|_, _| Err(ReadError::failed("adb: device offline"))));
        let result = run_tab(text_opts(tab_of(vec![text_step("w", "wait", &["ready"], 60_000.0)]), vec![phone("a")], counting_sender(Arc::default(), None), reader, Arc::default())).await;
        assert_eq!(result.status, "failed");
        assert_eq!(result.message.as_deref(), Some("Step 1: cannot read the screen: adb: device offline"));

        let (reader, reads) = scripted(Arc::new(|_, _| Err(ReadError { kind: ReadErrorKind::Unavailable, message: "no models".into() })));
        let result = run_tab(text_opts(tab_of(vec![text_step("w", "wait", &["ready"], 60_000.0)]), vec![phone("a")], counting_sender(Arc::default(), None), reader, Arc::default())).await;
        assert_eq!((result.status.as_str(), result.message.as_deref(), reads.lock().unwrap()["a"]), ("failed", Some("Step 1: no models"), 1));
    }

    #[tokio::test]
    async fn a_phone_unplugged_during_a_wait_ends_its_run() {
        let unplugged = Arc::new(AtomicBool::new(false));
        let flag = unplugged.clone();
        let online: OnlineCheck = Arc::new(move |_| {
            let gone = flag.load(Ordering::SeqCst);
            Box::pin(async move { !gone })
        });
        let (reader, _) = scripted(Arc::new(|_, _| Ok(screen_of(&[]))));
        let mut options = text_opts(tab_of(vec![text_step("w", "wait", &["x"], 60_000.0)]), vec![phone("a")], counting_sender(Arc::default(), None), reader, Arc::default());
        options.is_online = Some(online);
        let handle = tokio::spawn(run_tab(options));
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        unplugged.store(true, Ordering::SeqCst);
        let result = tokio::time::timeout(std::time::Duration::from_secs(2), handle).await.unwrap().unwrap();
        assert_eq!((result.status.as_str(), result.message.as_deref()), ("failed", Some("Step 1: Phone disconnected")));
    }

    #[tokio::test]
    async fn bad_text_steps_fail_with_a_reason_before_reading() {
        let (reader, reads) = scripted(Arc::new(|_, _| Ok(screen_of(&[]))));
        let mut regex = text_step("r", "wait", &["(oops"], 0.0);
        edit(&mut regex, |t| t.query.mode = "regex".into());
        let mut jump = text_step("j", "check", &["x"], 0.0);
        edit(&mut jump, |t| t.on_failure = Outcome { go: "step".into(), step_id: Some("deleted".into()) });
        for (step, expect) in [
            (regex, "not a valid pattern"),
            (text_step("e", "tap", &["  "], 0.0), "enter the text to look for"),
            (jump, "turned off or was deleted"),
        ] {
            let result = run_tab(text_opts(tab_of(vec![step]), vec![phone("a")], counting_sender(Arc::default(), None), reader.clone(), Arc::default())).await;
            assert_eq!(result.status, "failed");
            assert!(result.message.as_deref().unwrap_or_default().contains(expect), "{:?}", result.message);
        }
        assert_eq!(reads.lock().unwrap().get("a").copied().unwrap_or(0), 1, "only the jump step read the screen");
        // No OCR on this path at all.
        let result = run_tab(opts(tab_of(vec![text_step("w", "wait", &["x"], 0.0)]), vec![phone("a")], counting_sender(Arc::default(), None), Arc::default())).await;
        assert_eq!(result.message.as_deref(), Some("Step 1: text steps need the ADBoard agent"));
    }

    #[tokio::test]
    async fn testing_one_text_step_reports_what_it_saw() {
        let (reader, _) = scripted(Arc::new(|_, _| Ok(screen_of(&[("Settings", 0.1, 0.1)]))));
        let mut step = text_step("c", "check", &["settings"], 0.0);
        edit(&mut step, |t| t.on_success = Outcome { go: "step".into(), step_id: Some("elsewhere".into()) });
        let mut options = text_opts(tab_of(vec![step]), vec![phone("a")], counting_sender(Arc::default(), None), reader, Arc::default());
        options.only_step_id = Some("c".into());
        let result = run_tab(options).await;
        assert_eq!((result.status.as_str(), result.message.as_deref()), ("done", Some("Found “Settings”")));
    }

    /// Two phones run the same macro: each reads its own screen and branches on it.
    #[tokio::test]
    async fn each_phone_branches_on_its_own_screen() {
        let reg = leak();
        let log = Arc::new(Mutex::new(Vec::new()));
        let (reader, _) = scripted(Arc::new(|device, _| Ok(screen_of(&[(if device == "s24" { "Error" } else { "Ready" }, 0.4, 0.4)]))));
        let mut check = text_step("check", "check", &["error"], 0.0);
        edit(&mut check, |t| {
            t.on_success = Outcome { go: "end".into(), step_id: None };
            t.on_failure = Outcome::next();
        });
        let tab = tab_of(vec![check, touch_step("go", 540.0)]);
        let report = reg.start(tab, vec![phone("s24"), phone("s23")], None, point_sender(log.clone()), None, Some(reader)).unwrap();
        let done = reg.wait_devices(&report.started).await;
        let by = |id: &str| done.iter().find(|r| r.device_id == id).unwrap().clone();
        assert_eq!(by("s24").message.as_deref(), Some("Ended at step 1: Found “Error”"));
        assert_eq!(by("s23").message.as_deref(), Some("Finished 1 cycle"));
        let touched: Vec<String> = log.lock().unwrap().iter().map(|(d, _, _)| d.clone()).collect();
        assert_eq!(touched, vec!["s23".to_string()]);
    }

    /// Tabs saved before text steps existed still load and play the same.
    #[tokio::test]
    async fn older_macros_still_load_and_play() {
        let old = serde_json::json!({
            "id": "tab-old", "name": "Farm", "reference": {"width": 1080, "height": 2400},
            "scale": "stretch", "orientation": "any", "stop": {"mode": "cycles", "seconds": 300, "cycles": 2},
            "jitterPx": 0, "targetIds": ["a"], "notes": "", "createdAt": 1, "updatedAt": 2,
            "steps": [{"id": "s1", "label": "", "enabled": true, "delayMs": 0,
                       "fingers": [{"id": "f1", "x": 540, "y": 1200, "startMs": 0, "durationMs": 50}]}]
        });
        let tab: MacroTab = serde_json::from_value(old).unwrap();
        assert!(tab.steps[0].text_step().is_none());
        let count = Arc::new(AtomicUsize::new(0));
        let result = run_tab(opts(tab, vec![phone("a")], counting_sender(count.clone(), None), Arc::default())).await;
        assert_eq!((result.status.as_str(), count.load(Ordering::SeqCst)), ("done", 2));
        assert!(result.text.is_none() && result.vars.is_empty());
    }

    #[test]
    fn text_step_json_from_the_browser() {
        let step: MacroStep = serde_json::from_value(serde_json::json!({
            "id": "s", "label": "", "enabled": true, "fingers": [], "delayMs": 300, "kind": "text",
            "text": {"action": "tap", "texts": ["OK"], "match": "exact", "caseSensitive": true,
                     "area": {"x": 0, "y": 1200, "width": 1080, "height": 1200},
                     "timeoutMs": 10000, "intervalMs": 1000, "offsetX": 0, "offsetY": -40, "variable": "",
                     "onSuccess": {"go": "next"}, "onFailure": {"go": "step", "stepId": "s9"}}
        }))
        .unwrap();
        let text = step.text_step().unwrap();
        assert_eq!((text.query.mode.as_str(), text.query.case_sensitive, text.offset_y), ("exact", true, -40.0));
        assert_eq!(text.on_failure, Outcome { go: "step".into(), step_id: Some("s9".into()) });
        // The bottom half of the reference maps to the bottom half of any screen (stretch).
        let tab = tab_of(vec![]);
        let area = screen_area(text.area.unwrap(), &tab, &phone("a"));
        assert_eq!(area, Area { x: 0.0, y: 0.5, width: 1.0, height: 0.5 });
    }
}
