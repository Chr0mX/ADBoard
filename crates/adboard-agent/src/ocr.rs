//! Text on a phone's screen (OCR), for macro text steps and the editor's
//! "Read screen".
//!
//! A read is one screenshot over ADB (`exec-out screencap -p`, the capture the
//! Screenshot tool uses), cropped to the step's area and passed to the text
//! engine. Positions come back as 0–1 of the screen in its current rotation,
//! the same space gestures use, so a tap on found text lands on it whatever
//! the phone's resolution, density or orientation.
//!
//! The engine is ocrs (<https://github.com/robertknight/ocrs>): pure Rust, CPU
//! only and offline, so it builds unchanged for Linux and the MinGW Windows
//! pack. Its two models (about 12 MB) are not compiled in: `make fetch-deps`
//! puts them in `tools/ocr/` and `dist/windows/vendor/ocr/`, or
//! `ADBOARD_OCR_MODELS` names a folder holding them. Another engine only has
//! to implement [`TextEngine`]; macro runs never see which one is used.
//!
//! Reads are cheap to repeat: one recognition runs at a time (the engine
//! already uses every core), and a picture that has not changed since the
//! phone's last read reuses that read's text instead of running the engine.

use crate::device_manager::AppState;
use adboard_protocol::{Device, DeviceStatus};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

pub const DETECTION_MODEL: &str = "text-detection.rten";
pub const RECOGNITION_MODEL: &str = "text-recognition.rten";
/// Smallest area worth reading, in screen pixels.
const MIN_AREA_PX: u32 = 8;
/// Screens larger than this are refused rather than decoded.
const MAX_PIXELS: u64 = 40_000_000;
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(15);

/* ------------------------------ model ------------------------------ */

/// A rectangle as 0–1 of the screen.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct Area {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Area {
    pub const FULL: Area = Area { x: 0.0, y: 0.0, width: 1.0, height: 1.0 };

    pub fn center(&self) -> (f64, f64) {
        (self.x + self.width / 2.0, self.y + self.height / 2.0)
    }

    fn union(&self, other: &Area) -> Area {
        let x = self.x.min(other.x);
        let y = self.y.min(other.y);
        let right = (self.x + self.width).max(other.x + other.width);
        let bottom = (self.y + self.height).max(other.y + other.height);
        Area { x, y, width: right - x, height: bottom - y }
    }

    /// Clamped onto the screen; None when nothing (or NaN) is left.
    pub fn clamped(&self) -> Option<Area> {
        let x = self.x.clamp(0.0, 1.0);
        let y = self.y.clamp(0.0, 1.0);
        let right = (self.x + self.width).clamp(0.0, 1.0);
        let bottom = (self.y + self.height).clamp(0.0, 1.0);
        (right > x && bottom > y).then_some(Area { x, y, width: right - x, height: bottom - y })
    }

    fn contains(&self, (px, py): (f64, f64)) -> bool {
        px >= self.x && px <= self.x + self.width && py >= self.y && py <= self.y + self.height
    }
}

/// One line of text found on the screen.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TextLine {
    /// Whitespace collapsed to single spaces.
    pub text: String,
    #[serde(rename = "box")]
    pub area: Area,
    /// 0–1 when the engine reports it (ocrs does not).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f32>,
    /// One box per character of `text` when the engine gives them; lets a
    /// match inside a long line tap the matched words, not the line's center.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub chars: Vec<Area>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenText {
    /// Screenshot size in pixels (the current rotation).
    pub width: u32,
    pub height: u32,
    /// Lines in reading order.
    pub lines: Vec<TextLine>,
    pub engine: String,
    /// Capture plus recognition time.
    pub ms: u64,
    /// The picture had not changed since this phone's last read, so its text was reused.
    #[serde(default)]
    pub cached: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ReadErrorKind {
    /// No engine (models not installed). Retrying cannot help.
    Unavailable,
    /// The phone is not in the device list.
    UnknownDevice,
    /// This read failed (capture, decode, offline…); the next one may work.
    Failed,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ReadError {
    pub kind: ReadErrorKind,
    pub message: String,
}

impl ReadError {
    pub fn failed(message: impl Into<String>) -> Self {
        Self { kind: ReadErrorKind::Failed, message: message.into() }
    }
    pub fn fatal(&self) -> bool {
        self.kind != ReadErrorKind::Failed
    }
}

/* ------------------------------ engines ------------------------------ */

pub struct RgbImage {
    pub width: u32,
    pub height: u32,
    /// Row-major RGB, 3 bytes per pixel.
    pub pixels: Vec<u8>,
}

/// A box in image pixels; `right` and `bottom` are exclusive.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PixelRect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

/// A line as an engine reports it, in pixels of the image it was given.
pub struct EngineLine {
    pub text: String,
    pub rect: PixelRect,
    /// One rect per char of `text`, or empty.
    pub chars: Vec<PixelRect>,
    pub confidence: Option<f32>,
}

/// A text recognizer. ocrs is the built-in one; another engine, or other
/// models and settings, plug in here without touching macro runs.
pub trait TextEngine: Send + Sync {
    fn name(&self) -> &str;
    fn recognize(&self, image: &RgbImage) -> Result<Vec<EngineLine>, String>;
}

struct Ocrs(ocrs::OcrEngine);

impl TextEngine for Ocrs {
    fn name(&self) -> &str {
        "ocrs"
    }

    fn recognize(&self, image: &RgbImage) -> Result<Vec<EngineLine>, String> {
        use ocrs::TextItem;
        let source = ocrs::ImageSource::from_bytes(&image.pixels, (image.width, image.height)).map_err(|e| e.to_string())?;
        let input = self.0.prepare_input(source).map_err(|e| e.to_string())?;
        let words = self.0.detect_words(&input).map_err(|e| e.to_string())?;
        let lines = self.0.find_text_lines(&input, &words);
        let found = self.0.recognize_text(&input, &lines).map_err(|e| e.to_string())?;
        let rect = |r: rten_imageproc::Rect| PixelRect { left: r.left(), top: r.top(), right: r.right(), bottom: r.bottom() };
        Ok(found
            .into_iter()
            .flatten()
            .map(|line| EngineLine {
                text: line.to_string(),
                rect: rect(line.bounding_rect()),
                chars: line.chars().iter().map(|c| rect(c.rect)).collect(),
                confidence: None,
            })
            .collect())
    }
}

/// `ADBOARD_OCR_MODELS`, else the vendored folder from fetch-deps.
pub fn models_dir() -> Option<PathBuf> {
    match crate::env::var("OCR_MODELS") {
        Ok(dir) if !dir.trim().is_empty() => Some(PathBuf::from(dir.trim())),
        _ => crate::paths::vendored_ocr_models(),
    }
}

pub const NOT_INSTALLED: &str = "Text reading needs the OCR models: run `make fetch-deps` (Windows: scripts\\fetch-deps.ps1), \
or put text-detection.rten and text-recognition.rten in a folder and set ADBOARD_OCR_MODELS to it";

fn load_ocrs(dir: &Path) -> Result<Ocrs, String> {
    let load = |name: &str| {
        let path = dir.join(name);
        if !path.is_file() {
            return Err(format!("{NOT_INSTALLED} (missing {})", path.display()));
        }
        rten::Model::load_file(&path).map_err(|e| format!("cannot load {}: {e}", path.display()))
    };
    let params = ocrs::OcrEngineParams {
        detection_model: Some(load(DETECTION_MODEL)?),
        recognition_model: Some(load(RECOGNITION_MODEL)?),
        ..Default::default()
    };
    ocrs::OcrEngine::new(params).map(Ocrs).map_err(|e| e.to_string())
}

fn engine_slot() -> &'static Mutex<Option<Arc<dyn TextEngine>>> {
    static SLOT: OnceLock<Mutex<Option<Arc<dyn TextEngine>>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

/// The engine, loaded on first use. A failed load is retried on the next
/// read, so models added while ADBoard runs are picked up. Blocking.
pub fn engine() -> Result<Arc<dyn TextEngine>, ReadError> {
    let mut slot = engine_slot().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(engine) = slot.as_ref() {
        return Ok(engine.clone());
    }
    let unavailable = |message: String| ReadError { kind: ReadErrorKind::Unavailable, message };
    let dir = models_dir().ok_or_else(|| unavailable(NOT_INSTALLED.into()))?;
    let started = Instant::now();
    let engine: Arc<dyn TextEngine> = Arc::new(load_ocrs(&dir).map_err(unavailable)?);
    tracing::info!(dir = %dir.display(), ms = started.elapsed().as_millis() as u64, "[ocr] models loaded");
    *slot = Some(engine.clone());
    Ok(engine)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrStatus {
    pub available: bool,
    pub engine: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub models: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// Whether text steps can run on this agent (loads the models to find out).
pub async fn status(state: &AppState) -> OcrStatus {
    if state.inner.adb_path.is_none() {
        return OcrStatus { available: true, engine: "mock".into(), models: None, detail: Some("mock fleet: every phone shows the same sample text".into()) };
    }
    let models = models_dir().map(|d| d.display().to_string());
    match tokio::task::spawn_blocking(engine).await {
        Ok(Ok(engine)) => OcrStatus { available: true, engine: engine.name().into(), models, detail: None },
        Ok(Err(error)) => OcrStatus { available: false, engine: "ocrs".into(), models, detail: Some(error.message) },
        Err(error) => OcrStatus { available: false, engine: "ocrs".into(), models, detail: Some(error.to_string()) },
    }
}

/* --------------------------- image → text --------------------------- */

/// A PNG screenshot as RGB.
pub fn decode_png(bytes: &[u8]) -> Result<RgbImage, String> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = decoder.read_info().map_err(|e| format!("screenshot is not a PNG: {e}"))?;
    let (width, height) = reader.info().size();
    if u64::from(width) * u64::from(height) > MAX_PIXELS || width == 0 || height == 0 {
        return Err(format!("screenshot is {width}×{height}, too large to read"));
    }
    let mut buffer = vec![0; reader.output_buffer_size().ok_or("screenshot is too large to read")?];
    let info = reader.next_frame(&mut buffer).map_err(|e| format!("screenshot is damaged: {e}"))?;
    let data = &buffer[..info.buffer_size()];
    let pixels = match info.color_type {
        png::ColorType::Rgb => data.to_vec(),
        png::ColorType::Rgba => data.chunks_exact(4).flat_map(|p| [p[0], p[1], p[2]]).collect(),
        png::ColorType::Grayscale => data.iter().flat_map(|&g| [g, g, g]).collect(),
        png::ColorType::GrayscaleAlpha => data.chunks_exact(2).flat_map(|p| [p[0], p[0], p[0]]).collect(),
        png::ColorType::Indexed => return Err("screenshot uses an unsupported PNG palette".into()),
    };
    Ok(RgbImage { width: info.width, height: info.height, pixels })
}

/// The part of `image` under `area`, and its offset in pixels.
pub fn crop(image: &RgbImage, area: Area) -> Result<(RgbImage, (u32, u32)), String> {
    let area = area.clamped().ok_or("the area to read is empty")?;
    let (w, h) = (f64::from(image.width), f64::from(image.height));
    let x0 = (area.x * w).floor() as u32;
    let y0 = (area.y * h).floor() as u32;
    let x1 = ((area.x + area.width) * w).ceil().min(w) as u32;
    let y1 = ((area.y + area.height) * h).ceil().min(h) as u32;
    if x1.saturating_sub(x0) < MIN_AREA_PX || y1.saturating_sub(y0) < MIN_AREA_PX {
        return Err(format!("the area to read is under {MIN_AREA_PX} pixels"));
    }
    if (x0, y0, x1, y1) == (0, 0, image.width, image.height) {
        return Ok((RgbImage { width: image.width, height: image.height, pixels: image.pixels.clone() }, (0, 0)));
    }
    let stride = image.width as usize * 3;
    let mut pixels = Vec::with_capacity((x1 - x0) as usize * (y1 - y0) as usize * 3);
    for row in y0..y1 {
        let start = row as usize * stride + x0 as usize * 3;
        pixels.extend_from_slice(&image.pixels[start..start + (x1 - x0) as usize * 3]);
    }
    Ok((RgbImage { width: x1 - x0, height: y1 - y0, pixels }, (x0, y0)))
}

/// Engine lines (pixels of a crop at `offset`) → lines as 0–1 of the whole
/// `screen`, with whitespace collapsed and char boxes kept aligned.
pub fn to_lines(found: Vec<EngineLine>, offset: (u32, u32), screen: (u32, u32)) -> Vec<TextLine> {
    let (sw, sh) = (f64::from(screen.0.max(1)), f64::from(screen.1.max(1)));
    let norm = |r: &PixelRect| Area {
        x: (f64::from(r.left) + f64::from(offset.0)) / sw,
        y: (f64::from(r.top) + f64::from(offset.1)) / sh,
        width: f64::from((r.right - r.left).max(1)) / sw,
        height: f64::from((r.bottom - r.top).max(1)) / sh,
    };
    found
        .into_iter()
        .filter_map(|line| {
            let area = norm(&line.rect);
            let boxes: Vec<Area> = if line.chars.len() == line.text.chars().count() { line.chars.iter().map(norm).collect() } else { Vec::new() };
            let mut text = String::new();
            let mut chars = Vec::new();
            for (i, c) in line.text.chars().enumerate() {
                let c = if c.is_whitespace() { ' ' } else { c };
                if c == ' ' && (text.is_empty() || text.ends_with(' ')) {
                    continue;
                }
                text.push(c);
                if let Some(b) = boxes.get(i) {
                    chars.push(*b);
                }
            }
            if text.ends_with(' ') {
                text.pop();
                chars.truncate(text.chars().count());
            }
            if chars.len() != text.chars().count() {
                chars.clear();
            }
            (!text.is_empty()).then_some(TextLine { text, area, confidence: line.confidence, chars })
        })
        .collect()
}

fn picture_key(image: &RgbImage, offset: (u32, u32), engine: &str) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    (image.width, image.height, offset, engine).hash(&mut hasher);
    image.pixels.hash(&mut hasher);
    hasher.finish()
}

/// Each phone's last read: picture key → lines.
type LastReads = Mutex<HashMap<String, (u64, Vec<TextLine>)>>;

fn last_reads() -> &'static LastReads {
    static SEEN: OnceLock<LastReads> = OnceLock::new();
    SEEN.get_or_init(|| Mutex::new(HashMap::new()))
}

/// One recognition at a time: the engine already spreads one over every core,
/// so parallel reads from several phones would only add memory and latency.
fn recognize_gate() -> &'static tokio::sync::Semaphore {
    static GATE: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
    GATE.get_or_init(|| tokio::sync::Semaphore::new(1))
}

/// Text in `area` of a PNG screenshot of the phone `cache_key`.
pub async fn read_png(engine: Arc<dyn TextEngine>, png: Vec<u8>, area: Area, cache_key: &str) -> Result<(u32, u32, Vec<TextLine>, bool), ReadError> {
    let name = engine.name().to_string();
    let prepared = tokio::task::spawn_blocking(move || -> Result<_, String> {
        let image = decode_png(&png)?;
        let (part, offset) = crop(&image, area)?;
        let key = picture_key(&part, offset, &name);
        Ok((image.width, image.height, part, offset, key))
    })
    .await
    .map_err(|e| ReadError::failed(e.to_string()))?
    .map_err(ReadError::failed)?;
    let (width, height, part, offset, key) = prepared;
    if let Some((seen, lines)) = last_reads().lock().unwrap_or_else(|e| e.into_inner()).get(cache_key) {
        if *seen == key {
            return Ok((width, height, lines.clone(), true));
        }
    }
    let _permit = recognize_gate().acquire().await.map_err(|e| ReadError::failed(e.to_string()))?;
    let lines = tokio::task::spawn_blocking(move || engine.recognize(&part).map(|found| to_lines(found, offset, (width, height))))
        .await
        .map_err(|e| ReadError::failed(e.to_string()))?
        .map_err(|e| ReadError::failed(format!("text engine: {e}")))?;
    last_reads().lock().unwrap_or_else(|e| e.into_inner()).insert(cache_key.to_string(), (key, lines.clone()));
    Ok((width, height, lines, false))
}

/* ------------------------------ phones ------------------------------ */

async fn capture(adb: &Path, serial: &str) -> Result<Vec<u8>, String> {
    let child = tokio::process::Command::new(adb)
        .args(["-s", serial, "exec-out", "screencap", "-p"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        // A stopped run drops the read; don't leave adb running.
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("failed to spawn adb: {e}"))?;
    let output = tokio::time::timeout(CAPTURE_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| format!("screenshot took over {} s", CAPTURE_TIMEOUT.as_secs()))?
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if error.is_empty() { "screenshot failed".into() } else { error });
    }
    if output.stdout.len() < 8 || &output.stdout[..4] != b"\x89PNG" {
        return Err("screencap did not return a PNG".into());
    }
    Ok(output.stdout)
}

/// The mock fleet's screen: the same sample text on every phone.
pub const MOCK_LINES: &[(&str, f64, f64, f64, f64)] = &[
    ("ADBoard mock phone", 0.06, 0.04, 0.55, 0.025),
    ("Settings", 0.06, 0.12, 0.3, 0.03),
    ("Wi-Fi Connected", 0.06, 0.2, 0.45, 0.025),
    ("Bluetooth Off", 0.06, 0.26, 0.38, 0.025),
    ("Battery 100%", 0.06, 0.32, 0.36, 0.025),
    ("Sign in", 0.38, 0.6, 0.24, 0.03),
    ("Continue", 0.36, 0.7, 0.28, 0.03),
    ("Cancel OK", 0.3, 0.88, 0.4, 0.025),
];

pub fn mock_lines(area: Area) -> Vec<TextLine> {
    MOCK_LINES
        .iter()
        .map(|&(text, x, y, width, height)| {
            let n = text.chars().count() as f64;
            let chars = (0..text.chars().count()).map(|i| Area { x: x + width * i as f64 / n, y, width: width / n, height }).collect();
            TextLine { text: text.into(), area: Area { x, y, width, height }, confidence: None, chars }
        })
        .filter(|line| area.contains(line.area.center()))
        .collect()
}

fn device_of(devices: Vec<Device>, device_id: &str) -> Result<Device, ReadError> {
    devices
        .into_iter()
        .find(|d| d.id == device_id)
        .ok_or_else(|| ReadError { kind: ReadErrorKind::UnknownDevice, message: "That phone is not connected to ADBoard".into() })
}

/// The text in `area` (0–1, None = whole screen) of a phone's screen right now.
pub async fn read_screen(state: &AppState, device_id: &str, area: Option<Area>) -> Result<ScreenText, ReadError> {
    let started = Instant::now();
    let device = device_of(state.list_devices().await, device_id)?;
    if device.status != DeviceStatus::Online {
        return Err(ReadError::failed(format!("{} is offline", device.name)));
    }
    let area = match area {
        Some(a) => a.clamped().ok_or_else(|| ReadError::failed("the area to read is empty"))?,
        None => Area::FULL,
    };
    if !state.local_serial_set().await.contains(&device.serial) {
        return read_remote(state, &device, area).await;
    }
    let Some(adb) = state.inner.adb_path.clone() else {
        return Ok(ScreenText {
            width: device.resolution.width,
            height: device.resolution.height,
            lines: mock_lines(area),
            engine: "mock".into(),
            ms: started.elapsed().as_millis() as u64,
            cached: false,
        });
    };
    let engine = tokio::task::spawn_blocking(engine).await.map_err(|e| ReadError::failed(e.to_string()))??;
    let png = capture(&adb, &device.serial).await.map_err(ReadError::failed)?;
    let name = engine.name().to_string();
    let (width, height, lines, cached) = read_png(engine, png, area, &device.serial).await?;
    Ok(ScreenText { width, height, lines, engine: name, ms: started.elapsed().as_millis() as u64, cached })
}

/// A phone on another host: that host reads it (its own ADB and engine).
async fn read_remote(state: &AppState, device: &Device, area: Area) -> Result<ScreenText, ReadError> {
    let host = device.effective_host_id().to_string();
    let base = state.inner.mesh.http_base(&host).await.ok_or_else(|| ReadError::failed(format!("host {host} cannot be reached")))?;
    let url = format!("{}/api/ocr/read", base.trim_end_matches('/'));
    let body = serde_json::json!({ "deviceId": device.id, "area": area, "withChars": true });
    let body = serde_json::to_vec(&body).map_err(|e| ReadError::failed(e.to_string()))?;
    let (status, text) = crate::device_manager::http_post_bytes(&url, &[("Content-Type", "application/json")], &body)
        .await
        .map_err(ReadError::failed)?;
    if !(200..300).contains(&status) {
        let message = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string))
            .unwrap_or_else(|| format!("{host} said HTTP {status}"));
        let kind = if status == 503 { ReadErrorKind::Unavailable } else { ReadErrorKind::Failed };
        return Err(ReadError { kind, message: format!("{host}: {message}") });
    }
    serde_json::from_str(&text).map_err(|e| ReadError::failed(format!("{host}: {e}")))
}

/* ------------------------------ matching ------------------------------ */

/// What to look for. Several texts match when any of them is on screen.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TextQuery {
    #[serde(default)]
    pub texts: Vec<String>,
    /// contains | exact (whole words) | regex
    #[serde(default = "contains", rename = "match")]
    pub mode: String,
    #[serde(default)]
    pub case_sensitive: bool,
}

fn contains() -> String {
    "contains".into()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TextMatch {
    /// The matched text as read.
    pub text: String,
    /// What a Read step stores: a regex's first group, else the whole line.
    pub value: String,
    #[serde(rename = "box")]
    pub area: Area,
    /// Index into the screen's lines.
    pub line: usize,
}

fn collapse(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn fold(c: char, case_sensitive: bool) -> char {
    if case_sensitive {
        c
    } else {
        c.to_lowercase().next().unwrap_or(c)
    }
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric()
}

/// Char index of `needle` in `hay`; `whole_words` needs word edges on both sides.
fn find_chars(hay: &[char], needle: &[char], whole_words: bool) -> Option<usize> {
    if needle.is_empty() || needle.len() > hay.len() {
        return None;
    }
    (0..=hay.len() - needle.len()).find(|&i| {
        let j = i + needle.len();
        hay[i..j] == *needle
            && (!whole_words
                || ((i == 0 || !is_word(hay[i - 1]) || !is_word(hay[i])) && (j == hay.len() || !is_word(hay[j]) || !is_word(hay[j - 1]))))
    })
}

/// A box for chars `start..end` of `line`: their char boxes, else that share of the line's box.
fn span_area(line: &TextLine, start: usize, end: usize) -> Area {
    if line.chars.len() == line.text.chars().count() && end <= line.chars.len() && start < end {
        return line.chars[start + 1..end].iter().fold(line.chars[start], |acc, b| acc.union(b));
    }
    let n = line.text.chars().count().max(1) as f64;
    Area {
        x: line.area.x + line.area.width * start as f64 / n,
        y: line.area.y,
        width: line.area.width * (end.saturating_sub(start)).max(1) as f64 / n,
        height: line.area.height,
    }
}

pub fn compile(query: &TextQuery) -> Result<Vec<regex::Regex>, String> {
    if query.mode != "regex" {
        return Ok(Vec::new());
    }
    query
        .texts
        .iter()
        .map(|t| t.trim())
        .filter(|t| !t.is_empty())
        .map(|t| {
            regex::RegexBuilder::new(t)
                .case_insensitive(!query.case_sensitive)
                .size_limit(1 << 20)
                .build()
                .map_err(|e| format!("“{t}” is not a valid pattern: {}", e.to_string().lines().last().unwrap_or("error")))
        })
        .collect()
}

/// Every place any of the query's texts appears, in reading order (at most
/// one per text and line).
pub fn find_matches(lines: &[TextLine], query: &TextQuery) -> Result<Vec<TextMatch>, String> {
    let mut out: Vec<(usize, usize, TextMatch)> = Vec::new();
    if query.mode == "regex" {
        let patterns = compile(query)?;
        for (index, line) in lines.iter().enumerate() {
            for pattern in &patterns {
                let Some(caps) = pattern.captures(&line.text) else { continue };
                let whole = caps.get(0).expect("group 0");
                if whole.as_str().is_empty() {
                    continue;
                }
                let start = line.text[..whole.start()].chars().count();
                let end = start + whole.as_str().chars().count();
                let value = caps.get(1).map(|g| g.as_str()).unwrap_or(whole.as_str()).to_string();
                out.push((index, start, TextMatch { text: whole.as_str().into(), value, area: span_area(line, start, end), line: index }));
            }
        }
    } else {
        let whole_words = query.mode == "exact";
        let needles: Vec<Vec<char>> = query
            .texts
            .iter()
            .map(|t| collapse(t).chars().map(|c| fold(c, query.case_sensitive)).collect::<Vec<char>>())
            .filter(|n| !n.is_empty())
            .collect();
        for (index, line) in lines.iter().enumerate() {
            let chars: Vec<char> = line.text.chars().collect();
            let hay: Vec<char> = chars.iter().map(|&c| fold(c, query.case_sensitive)).collect();
            for needle in &needles {
                let Some(start) = find_chars(&hay, needle, whole_words) else { continue };
                let end = start + needle.len();
                let text: String = chars[start..end].iter().collect();
                out.push((index, start, TextMatch { text, value: line.text.clone(), area: span_area(line, start, end), line: index }));
            }
        }
    }
    out.sort_by_key(|(line, start, _)| (*line, *start));
    out.dedup_by(|a, b| a.0 == b.0 && a.1 == b.1 && a.2.text == b.2.text);
    Ok(out.into_iter().map(|(_, _, m)| m).collect())
}

/// `{name}` → the value a Read step stored in `name`. Unknown names are left
/// as written; in regex mode the value is escaped so it matches literally.
pub fn substitute(pattern: &str, vars: &BTreeMap<String, String>, regex: bool) -> String {
    let mut out = String::with_capacity(pattern.len());
    let mut rest = pattern;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let name_len = after.find('}').filter(|&n| n > 0 && valid_variable(&after[..n]));
        match name_len.and_then(|n| vars.get(&after[..n]).map(|v| (n, v))) {
            Some((n, value)) => {
                out.push_str(&if regex { regex::escape(value) } else { value.clone() });
                rest = &after[n + 1..];
            }
            None => {
                out.push('{');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Letters, digits and `_`, not starting with a digit, up to 32 long.
pub fn valid_variable(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && name.len() <= 32
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(text: &str, x: f64, y: f64) -> TextLine {
        // 0.01 wide per char, like a monospace line.
        let chars = (0..text.chars().count()).map(|i| Area { x: x + 0.01 * i as f64, y, width: 0.01, height: 0.02 }).collect();
        TextLine { text: text.into(), area: Area { x, y, width: 0.01 * text.chars().count() as f64, height: 0.02 }, confidence: None, chars }
    }

    fn query(texts: &[&str], mode: &str, case_sensitive: bool) -> TextQuery {
        TextQuery { texts: texts.iter().map(|t| t.to_string()).collect(), mode: mode.into(), case_sensitive }
    }

    fn screen() -> Vec<TextLine> {
        vec![line("Sign in", 0.1, 0.1), line("Username", 0.1, 0.3), line("Forgot password?", 0.2, 0.6), line("Cancel OK", 0.3, 0.9), line("Coins: 1,250", 0.5, 0.05)]
    }

    #[test]
    fn contains_is_case_insensitive_by_default_and_boxes_the_matched_chars() {
        let found = find_matches(&screen(), &query(&["PASSWORD"], "contains", false)).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!((found[0].text.as_str(), found[0].line), ("password", 2));
        // "password" is chars 7..15 of "Forgot password?".
        assert!((found[0].area.x - 0.27).abs() < 1e-9 && (found[0].area.width - 0.08).abs() < 1e-9);
        assert!(find_matches(&screen(), &query(&["PASSWORD"], "contains", true)).unwrap().is_empty());
    }

    #[test]
    fn exact_needs_whole_words() {
        let ok = find_matches(&screen(), &query(&["ok"], "exact", false)).unwrap();
        assert_eq!((ok.len(), ok[0].text.as_str()), (1, "OK"));
        assert!(find_matches(&screen(), &query(&["Sign"], "exact", false)).unwrap().len() == 1);
        assert!(find_matches(&screen(), &query(&["Sig"], "exact", false)).unwrap().is_empty());
        assert!(find_matches(&screen(), &query(&["user"], "exact", false)).unwrap().is_empty());
        // Punctuation is an edge: "password" in "password?".
        assert_eq!(find_matches(&screen(), &query(&["password"], "exact", false)).unwrap().len(), 1);
        // Extra spaces in what was typed don't matter.
        assert_eq!(find_matches(&screen(), &query(&["  Cancel   OK "], "exact", true)).unwrap().len(), 1);
    }

    #[test]
    fn any_of_several_texts_in_reading_order() {
        let found = find_matches(&screen(), &query(&["ok", "sign in", "nothing here"], "contains", false)).unwrap();
        assert_eq!(found.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(), vec!["Sign in", "OK"]);
        assert!(find_matches(&screen(), &query(&["", "   "], "contains", false)).unwrap().is_empty());
    }

    #[test]
    fn regex_reads_the_first_group() {
        let found = find_matches(&screen(), &query(&[r"coins:\s*([\d,]+)"], "regex", false)).unwrap();
        assert_eq!((found[0].value.as_str(), found[0].text.as_str()), ("1,250", "Coins: 1,250"));
        let plain = find_matches(&screen(), &query(&["user"], "contains", false)).unwrap();
        assert_eq!(plain[0].value, "Username", "contains stores the whole line");
        let bad = find_matches(&screen(), &query(&["(unclosed"], "regex", false)).unwrap_err();
        assert!(bad.contains("not a valid pattern"), "{bad}");
    }

    #[test]
    fn lines_without_char_boxes_share_the_line_box() {
        let mut lines = screen();
        lines[1].chars.clear();
        let found = find_matches(&lines, &query(&["name"], "contains", false)).unwrap();
        // "name" is the last 4 of 8 chars.
        assert!((found[0].area.x - 0.14).abs() < 1e-9 && (found[0].area.width - 0.04).abs() < 1e-9);
    }

    #[test]
    fn variables_substitute_and_escape_for_regex() {
        let vars = BTreeMap::from([("code".to_string(), "4.2+".to_string())]);
        assert_eq!(substitute("Code {code} ok", &vars, false), "Code 4.2+ ok");
        assert_eq!(substitute("v{code}", &vars, true), r"v4\.2\+");
        assert_eq!(substitute(r"\d{2,3} {missing} {", &vars, true), r"\d{2,3} {missing} {");
        assert!(valid_variable("coins_1") && !valid_variable("1coins") && !valid_variable("a-b") && !valid_variable(""));
    }

    #[test]
    fn crop_and_map_back_to_the_whole_screen() {
        let image = RgbImage { width: 100, height: 200, pixels: (0..100 * 200 * 3).map(|i| (i % 251) as u8).collect() };
        let (part, offset) = crop(&image, Area { x: 0.5, y: 0.25, width: 0.5, height: 0.5 }).unwrap();
        assert_eq!((part.width, part.height, offset), (50, 100, (50, 50)));
        assert_eq!(&part.pixels[..3], &image.pixels[(50 * 100 + 50) * 3..(50 * 100 + 50) * 3 + 3]);
        let lines = to_lines(
            vec![EngineLine {
                text: "  Hi   there ".into(),
                rect: PixelRect { left: 10, top: 20, right: 30, bottom: 30 },
                chars: (0..13).map(|i| PixelRect { left: 10 + i, top: 20, right: 11 + i, bottom: 30 }).collect(),
                confidence: Some(0.9),
            }],
            offset,
            (image.width, image.height),
        );
        assert_eq!(lines[0].text, "Hi there");
        assert_eq!(lines[0].chars.len(), 8);
        assert_eq!(lines[0].area, Area { x: 0.6, y: 0.35, width: 0.2, height: 0.05 });
        assert!(crop(&image, Area { x: 0.99, y: 0.0, width: 0.5, height: 1.0 }).is_err(), "under 8 px");
        assert!(crop(&image, Area { x: 2.0, y: 0.0, width: 0.5, height: 1.0 }).is_err(), "off the screen");
    }

    struct Fake(std::sync::atomic::AtomicUsize);
    impl TextEngine for Fake {
        fn name(&self) -> &str {
            "fake"
        }
        fn recognize(&self, image: &RgbImage) -> Result<Vec<EngineLine>, String> {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(vec![EngineLine { text: format!("{}x{}", image.width, image.height), rect: PixelRect { left: 0, top: 0, right: 4, bottom: 4 }, chars: vec![], confidence: None }])
        }
    }

    fn png_of(width: u32, height: u32, shade: u8) -> Vec<u8> {
        let mut out = Vec::new();
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        writer.write_image_data(&vec![shade; (width * height * 4) as usize]).unwrap();
        drop(writer);
        out
    }

    #[tokio::test]
    async fn an_unchanged_picture_is_not_read_twice() {
        let fake = Arc::new(Fake(Default::default()));
        let key = format!("serial-{}", uuid::Uuid::new_v4());
        let first = read_png(fake.clone(), png_of(40, 80, 10), Area::FULL, &key).await.unwrap();
        assert_eq!((first.0, first.1, first.2[0].text.as_str(), first.3), (40, 80, "40x80", false));
        let again = read_png(fake.clone(), png_of(40, 80, 10), Area::FULL, &key).await.unwrap();
        assert!(again.3, "same picture reuses the text");
        let changed = read_png(fake.clone(), png_of(40, 80, 99), Area::FULL, &key).await.unwrap();
        assert!(!changed.3);
        // Another area of the same picture is a new read.
        let half = read_png(fake.clone(), png_of(40, 80, 99), Area { x: 0.0, y: 0.0, width: 1.0, height: 0.5 }, &key).await.unwrap();
        assert_eq!((half.2[0].text.as_str(), half.3), ("40x40", false));
        assert_eq!(fake.0.load(std::sync::atomic::Ordering::SeqCst), 3);
        let broken = read_png(fake, b"not a png".to_vec(), Area::FULL, &key).await.unwrap_err();
        assert!(!broken.fatal() && broken.message.contains("not a PNG"));
    }

    #[test]
    fn mock_screen_honours_the_area() {
        assert_eq!(mock_lines(Area::FULL).len(), MOCK_LINES.len());
        let bottom = mock_lines(Area { x: 0.0, y: 0.8, width: 1.0, height: 0.2 });
        assert_eq!(bottom.iter().map(|l| l.text.as_str()).collect::<Vec<_>>(), vec!["Cancel OK"]);
    }

    /// Real models on a rendered login screen (`fixtures/ocr-login.png`).
    /// Runs when the models are installed (`make fetch-deps`, or CI's step).
    #[tokio::test]
    async fn ocrs_reads_a_rendered_screen_when_models_are_installed() {
        let Some(dir) = models_dir().filter(|d| d.join(DETECTION_MODEL).is_file()) else {
            eprintln!("skipped: OCR models not installed");
            return;
        };
        let engine: Arc<dyn TextEngine> = Arc::new(load_ocrs(&dir).unwrap());
        let png = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/ocr-login.png")).unwrap();
        let (width, height, lines, _) = read_png(engine.clone(), png.clone(), Area::FULL, "fixture").await.unwrap();
        assert_eq!((width, height), (1080, 2400));
        let found = find_matches(&lines, &query(&["log in"], "exact", false)).unwrap();
        assert_eq!(found.len(), 1, "{lines:?}");
        // The button label was drawn at x 460–620, y 1195–1240 of 1080×2400.
        let (cx, cy) = found[0].area.center();
        assert!((cx * 1080.0 - 540.0).abs() < 40.0 && (cy * 2400.0 - 1215.0).abs() < 30.0, "{:?}", found[0].area);
        assert_eq!(find_matches(&lines, &query(&["Forgot password"], "contains", false)).unwrap().len(), 1);
        let version = find_matches(&lines, &query(&[r"version (\d+\.\d+\.\d+)"], "regex", false)).unwrap();
        assert_eq!(version[0].value, "2.4.1");
        // Only the bottom half: the title is not in it.
        let (_, _, bottom, _) = read_png(engine, png, Area { x: 0.0, y: 0.5, width: 1.0, height: 0.5 }, "fixture").await.unwrap();
        assert!(find_matches(&bottom, &query(&["sign in"], "contains", false)).unwrap().is_empty());
        assert!(find_matches(&bottom, &query(&["wi-fi"], "contains", false)).unwrap().len() == 1);
    }
}
