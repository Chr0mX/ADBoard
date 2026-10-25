//! Event history: what happened to phones, macro runs and ADBoard itself.
//!
//! Events are kept in memory (newest last) and appended to
//! `logs/events.jsonl` in the data folder, one JSON object per line, so the
//! history survives restarts without a database. The file is rewritten
//! (compacted) when it holds more than the retention allows, so it never
//! grows without bound. Damaged lines are skipped on load and the original
//! file is copied to `backups/corrupt/` first.
//!
//! Recording never depends on notifications: an event is stored first and
//! only then offered to `notify` (Discord), which may drop or fail it on its
//! own. Identical events in a burst (same kind, phone and summary within
//! five minutes) are folded into the first one as `repeats`, so a phone that
//! flaps or a poll that fails every two seconds cannot flood the history or
//! Discord.

use crate::device_manager::AppState;
use adboard_protocol::{Device, DeviceStatus, ServerEvent, StreamState};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

pub const FILE_NAME: &str = "events.jsonl";
/// Present while ADBoard runs; left behind when it did not stop cleanly.
const RUNNING_MARKER: &str = ".adboard-running";
pub const DEFAULT_MAX_EVENTS: usize = 10_000;
pub const MIN_MAX_EVENTS: usize = 100;
pub const MAX_MAX_EVENTS: usize = 200_000;
pub const DEFAULT_MAX_DAYS: u32 = 30;
pub const MAX_MAX_DAYS: u32 = 3650;
const FOLD_WINDOW_MS: u64 = 5 * 60_000;
/// How far back to look for an event to fold into.
const FOLD_LOOKBACK: usize = 64;
const MAX_TEXT: usize = 2000;
const NEVER_FOLD: &[&str] = &["system.started", "system.stopped", "system.unclean_shutdown", "system.panic"];
pub const MAX_PAGE: usize = 200;

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Debug,
    #[default]
    Info,
    Warning,
    Error,
    Critical,
}

impl Severity {
    pub fn as_str(self) -> &'static str {
        match self {
            Severity::Debug => "debug",
            Severity::Info => "info",
            Severity::Warning => "warning",
            Severity::Error => "error",
            Severity::Critical => "critical",
        }
    }
}

/// Event categories. Each can be turned on or off for notifications.
pub const CATEGORIES: &[&str] = &["device", "macro", "app", "scrcpy", "adb", "system", "notification"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    /// Increasing across restarts; also the paging cursor.
    pub id: u64,
    pub at: u64,
    /// One of [`CATEGORIES`].
    pub category: String,
    /// What happened, e.g. `device.disconnected`, `macro.failed`.
    pub kind: String,
    pub severity: Severity,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
    /// The part of ADBoard that saw it (`devices`, `macros`, `commands`…).
    pub source: String,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// The macro run this belongs to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub meta: Map<String, Value>,
    /// Identical events folded into this one.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub repeats: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_at: Option<u64>,
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}

impl Event {
    pub fn new(category: &str, kind: &str, severity: Severity, summary: impl Into<String>) -> Self {
        Self {
            id: 0,
            at: now_ms(),
            category: category.into(),
            kind: kind.into(),
            severity,
            device_id: None,
            device_name: None,
            source: category.into(),
            summary: summary.into(),
            detail: None,
            run_id: None,
            meta: Map::new(),
            repeats: 0,
            last_at: None,
        }
    }
    pub fn source(mut self, source: &str) -> Self {
        self.source = source.into();
        self
    }
    pub fn device(mut self, id: &str, name: &str) -> Self {
        self.device_id = Some(id.into());
        self.device_name = Some(name.into());
        self
    }
    pub fn detail(mut self, detail: impl Into<String>) -> Self {
        let detail = detail.into();
        if !detail.trim().is_empty() {
            self.detail = Some(detail);
        }
        self
    }
    pub fn run(mut self, run_id: &str) -> Self {
        self.run_id = Some(run_id.into());
        self
    }
    pub fn meta(mut self, key: &str, value: impl Into<Value>) -> Self {
        self.meta.insert(key.into(), value.into());
        self
    }
    /// Model and host of `device`, for notifications.
    pub fn about(self, device: &Device) -> Self {
        let model = device.model_name.clone().unwrap_or_else(|| device.model.clone());
        self.device(&device.id, &device.name).meta("model", model).meta("host", device.host.clone())
    }

    fn fold_key_matches(&self, other: &Event) -> bool {
        // Starts and stops are each worth a line, however close together.
        !NEVER_FOLD.contains(&other.kind.as_str())
            && self.kind == other.kind && self.device_id == other.device_id && self.summary == other.summary && self.run_id == other.run_id
    }
}

/* ------------------------------ secrets ------------------------------ */

/// Strip things that must never be stored or sent: webhook URLs (with their
/// token), and `token=` / `password=` style values. Applied to every event.
pub fn redact(text: &str) -> String {
    static PATTERNS: OnceLock<Vec<(regex::Regex, &'static str)>> = OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        vec![
            (regex::Regex::new(r"(?i)https?://[^\s/]*discord(?:app)?\.com/api/webhooks/[^\s\x22']*").expect("regex"), "[webhook]"),
            (regex::Regex::new(r"(?i)/api/webhooks/\d+/[A-Za-z0-9_\-]+").expect("regex"), "/api/webhooks/[hidden]"),
            (
                regex::Regex::new(r"(?i)\b(password|passwd|token|secret|authorization|api[_-]?key)(\s*[=:]\s*)[^\s,;&\x22']+").expect("regex"),
                "$1$2[hidden]",
            ),
        ]
    });
    let mut out = text.to_string();
    for (pattern, with) in patterns {
        if pattern.is_match(&out) {
            out = pattern.replace_all(&out, *with).into_owned();
        }
    }
    out
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

fn clean(mut event: Event) -> Event {
    event.summary = clip(&redact(event.summary.trim()), 300);
    event.detail = event.detail.map(|d| clip(&redact(d.trim()), MAX_TEXT));
    for value in event.meta.values_mut() {
        if let Value::String(s) = value {
            *s = clip(&redact(s), 500);
        }
    }
    event
}

/* ------------------------------ the log ------------------------------ */

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Retention {
    pub max_events: usize,
    /// 0 keeps events until `max_events` pushes them out.
    pub max_days: u32,
}

impl Default for Retention {
    fn default() -> Self {
        Self { max_events: DEFAULT_MAX_EVENTS, max_days: DEFAULT_MAX_DAYS }
    }
}

impl Retention {
    pub fn clamped(self) -> Self {
        Self { max_events: self.max_events.clamp(MIN_MAX_EVENTS, MAX_MAX_EVENTS), max_days: self.max_days.min(MAX_MAX_DAYS) }
    }
}

struct Inner {
    events: VecDeque<Event>,
    next_id: u64,
    retention: Retention,
    /// Lines in the file; compaction rewrites it when this outgrows the retention.
    file_lines: usize,
    /// A fold changed an event already written; the next compaction saves it.
    dirty: bool,
}

pub struct EventLog {
    inner: Mutex<Inner>,
    /// None keeps events in memory only (tests).
    path: Option<PathBuf>,
}

/// What loading the file found.
#[derive(Debug, Default, PartialEq)]
pub struct LoadReport {
    pub loaded: usize,
    pub damaged: usize,
    pub error: Option<String>,
}

impl EventLog {
    pub fn in_memory(retention: Retention) -> Self {
        Self {
            inner: Mutex::new(Inner { events: VecDeque::new(), next_id: 1, retention: retention.clamped(), file_lines: 0, dirty: false }),
            path: None,
        }
    }

    /// The log kept in `dir/events.jsonl`, with what was there loaded.
    pub fn open(dir: &Path, retention: Retention) -> (Self, LoadReport) {
        let path = dir.join(FILE_NAME);
        let mut report = LoadReport::default();
        let mut events = VecDeque::new();
        match std::fs::File::open(&path) {
            Ok(file) => {
                for line in std::io::BufReader::new(file).lines() {
                    match line {
                        Ok(line) if line.trim().is_empty() => {}
                        Ok(line) => match serde_json::from_str::<Event>(&line) {
                            Ok(event) => events.push_back(event),
                            Err(_) => report.damaged += 1,
                        },
                        Err(error) => {
                            report.error = Some(error.to_string());
                            break;
                        }
                    }
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => report.error = Some(error.to_string()),
        }
        report.loaded = events.len();
        let mut sorted: Vec<Event> = events.into_iter().collect();
        sorted.sort_by_key(|e| e.id);
        let next_id = sorted.last().map(|e| e.id + 1).unwrap_or(1);
        let file_lines = sorted.len() + report.damaged;
        let log = Self {
            inner: Mutex::new(Inner { events: sorted.into(), next_id, retention: retention.clamped(), file_lines, dirty: false }),
            path: Some(path.clone()),
        };
        if report.damaged > 0 {
            // Keep the original before the rewrite drops the damaged lines.
            let backup = crate::data_dir::backups_dir().join("corrupt");
            let _ = std::fs::create_dir_all(&backup);
            let _ = std::fs::copy(&path, backup.join(format!("events-{}.jsonl", crate::data_dir::stamp())));
        }
        {
            let mut inner = log.lock();
            log.trim(&mut inner, now_ms());
            if report.damaged > 0 {
                inner.dirty = true;
            }
            if inner.dirty || inner.file_lines > inner.events.len() {
                log.compact(&mut inner);
            }
        }
        (log, report)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Store an event. Returns it with its id, or None when it was folded
    /// into an identical recent one (which is then not notified again).
    pub fn record(&self, event: Event) -> Option<Event> {
        let mut event = clean(event);
        let mut inner = self.lock();
        let now = event.at;
        if let Some(previous) = inner
            .events
            .iter_mut()
            .rev()
            .take(FOLD_LOOKBACK)
            .take_while(|e| now.saturating_sub(e.last_at.unwrap_or(e.at)) < FOLD_WINDOW_MS)
            .find(|e| e.fold_key_matches(&event))
        {
            previous.repeats += 1;
            previous.last_at = Some(now);
            inner.dirty = true;
            return None;
        }
        event.id = inner.next_id;
        inner.next_id += 1;
        if let Some(path) = &self.path {
            if let Err(error) = append_line(path, &event) {
                tracing::warn!(%error, "cannot write the event history");
            } else {
                inner.file_lines += 1;
            }
        }
        inner.events.push_back(event.clone());
        self.trim(&mut inner, now);
        let limit = inner.retention.max_events;
        if inner.file_lines > limit + limit / 10 + 50 {
            self.compact(&mut inner);
        }
        Some(event)
    }

    fn trim(&self, inner: &mut Inner, now: u64) {
        let Retention { max_events, max_days } = inner.retention;
        while inner.events.len() > max_events {
            inner.events.pop_front();
        }
        if max_days > 0 {
            let cutoff = now.saturating_sub(u64::from(max_days) * 86_400_000);
            while inner.events.front().is_some_and(|e| e.last_at.unwrap_or(e.at) < cutoff) {
                inner.events.pop_front();
            }
        }
    }

    /// Rewrite the file with exactly the events kept (atomic replace).
    fn compact(&self, inner: &mut Inner) {
        let Some(path) = &self.path else { return };
        let tmp = path.with_extension("jsonl.tmp");
        let result = (|| -> std::io::Result<()> {
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            let mut out = std::io::BufWriter::new(std::fs::File::create(&tmp)?);
            for event in &inner.events {
                serde_json::to_writer(&mut out, event)?;
                out.write_all(b"\n")?;
            }
            out.flush()?;
            drop(out);
            std::fs::rename(&tmp, path)
        })();
        match result {
            Ok(()) => {
                inner.file_lines = inner.events.len();
                inner.dirty = false;
            }
            Err(error) => {
                let _ = std::fs::remove_file(&tmp);
                tracing::warn!(%error, "cannot compact the event history");
            }
        }
    }

    /// Save folded repeat counts (called on a clean stop).
    pub fn flush(&self) {
        let mut inner = self.lock();
        if inner.dirty {
            self.compact(&mut inner);
        }
    }

    pub fn set_retention(&self, retention: Retention) {
        let mut inner = self.lock();
        inner.retention = retention.clamped();
        // Whole pass (not just the oldest end): clocks can step backwards.
        if inner.retention.max_days > 0 {
            let cutoff = now_ms().saturating_sub(u64::from(inner.retention.max_days) * 86_400_000);
            inner.events.retain(|e| e.last_at.unwrap_or(e.at) >= cutoff);
        }
        self.trim(&mut inner, now_ms());
        self.compact(&mut inner);
    }

    /// Remove events (all, or those older than `before_ms`). Returns how many.
    pub fn clear(&self, before_ms: Option<u64>) -> usize {
        let mut inner = self.lock();
        let before = inner.events.len();
        match before_ms {
            Some(cutoff) => inner.events.retain(|e| e.last_at.unwrap_or(e.at) >= cutoff),
            None => inner.events.clear(),
        }
        let removed = before - inner.events.len();
        self.compact(&mut inner);
        removed
    }

    pub fn query(&self, query: &Query) -> Page {
        let inner = self.lock();
        let limit = query.limit.unwrap_or(50).clamp(1, MAX_PAGE);
        let mut total = 0;
        let mut events = Vec::with_capacity(limit);
        let mut has_more = false;
        // Newest first; one pass counts every match and collects the page.
        for event in inner.events.iter().rev().filter(|e| query.matches(e)) {
            total += 1;
            if query.before.is_some_and(|cursor| event.id >= cursor) {
                continue;
            }
            if events.len() < limit {
                events.push(event.clone());
            } else {
                has_more = true;
            }
        }
        let next_before = if has_more { events.last().map(|e| e.id) } else { None };
        Page { events, total, has_more, next_before }
    }

    /// Counts for the dashboard since `since` (ms).
    pub fn summary(&self, since: u64) -> Summary {
        let inner = self.lock();
        let mut summary = Summary { since, total: inner.events.len(), ..Default::default() };
        for event in inner.events.iter().filter(|e| e.last_at.unwrap_or(e.at) >= since) {
            let n = 1 + event.repeats as usize;
            *summary.by_severity.entry(event.severity.as_str().into()).or_default() += n;
            *summary.by_category.entry(event.category.clone()).or_default() += n;
            match event.kind.as_str() {
                "macro.completed" => summary.macro_runs.done += 1,
                "macro.failed" => summary.macro_runs.failed += 1,
                "macro.stopped" => summary.macro_runs.stopped += 1,
                _ => {}
            }
            if event.severity >= Severity::Warning {
                if let Some(name) = &event.device_name {
                    *summary.problem_devices.entry(name.clone()).or_default() += n;
                }
            }
        }
        summary.recent_problems = inner.events.iter().rev().filter(|e| e.severity >= Severity::Warning && e.category != "notification").take(5).cloned().collect();
        summary.latest_id = inner.events.back().map(|e| e.id).unwrap_or(0);
        summary
    }
}

impl EventLog {
    /// Per-macro results since `since`, from the run events in the history:
    /// runs, outcomes, average duration and the steps that fail most.
    pub fn macro_stats(&self, since: u64) -> Vec<MacroStats> {
        let inner = self.lock();
        let mut by: Vec<MacroStats> = Vec::new();
        let mut durations: HashMap<String, (u64, u64)> = HashMap::new();
        for event in inner.events.iter().filter(|e| e.at >= since && e.category == "macro") {
            let status = match event.kind.as_str() {
                "macro.completed" => "done",
                "macro.failed" => "failed",
                "macro.stopped" => "stopped",
                _ => continue,
            };
            let name = event.meta.get("macro").and_then(Value::as_str).unwrap_or("?").to_string();
            let tab_id = event.meta.get("tabId").and_then(Value::as_str).map(str::to_string);
            let key = tab_id.clone().unwrap_or_else(|| name.clone());
            let at = match by.iter().position(|m| m.key == key) {
                Some(at) => at,
                None => {
                    by.push(MacroStats { key: key.clone(), name: name.clone(), tab_id, ..Default::default() });
                    by.len() - 1
                }
            };
            let stats = &mut by[at];
            // Events are oldest first: the last one seen is the latest run.
            stats.name = name;
            stats.runs += 1;
            stats.last_at = event.at;
            stats.last_status = status.into();
            match status {
                "done" => {
                    stats.done += 1;
                    // Milliseconds when recorded (newer runs), else whole seconds.
                    let ms = event
                        .meta
                        .get("durationMs")
                        .and_then(Value::as_u64)
                        .or_else(|| event.meta.get("durationSeconds").and_then(Value::as_u64).map(|s| s * 1000));
                    if let Some(ms) = ms {
                        let d = durations.entry(key).or_default();
                        d.0 += ms;
                        d.1 += 1;
                    }
                }
                "stopped" => stats.stopped += 1,
                _ => {
                    stats.failed += 1;
                    if let Some(phone) = &event.device_name {
                        *stats.failed_phones.entry(phone.clone()).or_default() += 1;
                    }
                    let step = event.meta.get("step").and_then(Value::as_u64);
                    let reason = event.detail.clone().unwrap_or_default();
                    match stats.failing_steps.iter_mut().find(|f| f.step == step) {
                        Some(f) => {
                            f.count += 1;
                            f.last_reason = reason;
                        }
                        None => stats.failing_steps.push(StepFailures { step, count: 1, last_reason: reason }),
                    }
                }
            }
        }
        for stats in &mut by {
            stats.success_rate = if stats.runs > 0 { stats.done as f64 / stats.runs as f64 } else { 0.0 };
            stats.avg_seconds = durations.get(&stats.key).filter(|d| d.1 > 0).map(|d| d.0 as f64 / d.1 as f64 / 1000.0);
            stats.failing_steps.sort_by_key(|f| std::cmp::Reverse(f.count));
            stats.failing_steps.truncate(3);
        }
        // Most failures first, then busiest.
        by.sort_by(|a, b| b.failed.cmp(&a.failed).then(b.runs.cmp(&a.runs)));
        by
    }
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StepFailures {
    /// 1-based step that failed (None when the run failed before a step).
    pub step: Option<u64>,
    pub count: usize,
    pub last_reason: String,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MacroStats {
    #[serde(skip)]
    key: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    pub runs: usize,
    pub done: usize,
    pub failed: usize,
    pub stopped: usize,
    /// done / runs.
    pub success_rate: f64,
    /// Average length of finished runs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avg_seconds: Option<f64>,
    pub last_at: u64,
    pub last_status: String,
    /// The steps that fail most (up to 3).
    pub failing_steps: Vec<StepFailures>,
    pub failed_phones: std::collections::BTreeMap<String, usize>,
}

fn append_line(path: &Path, event: &Event) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut line = serde_json::to_vec(event)?;
    line.push(b'\n');
    let mut file = std::fs::OpenOptions::new().create(true).append(true).open(path)?;
    file.write_all(&line)
}

/// Filters for the history list. Every field is optional.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Query {
    /// Words to find in the summary, detail, kind, phone, macro or run id.
    pub q: Option<String>,
    /// Lowest severity shown.
    pub severity: Option<Severity>,
    /// Comma-separated categories.
    pub category: Option<String>,
    /// Device id.
    pub device: Option<String>,
    pub run: Option<String>,
    pub since: Option<u64>,
    pub until: Option<u64>,
    /// Paging cursor: events with a smaller id than this.
    pub before: Option<u64>,
    pub limit: Option<usize>,
}

impl Query {
    pub fn matches(&self, event: &Event) -> bool {
        if self.severity.is_some_and(|min| event.severity < min) {
            return false;
        }
        if let Some(categories) = self.category.as_deref().filter(|c| !c.trim().is_empty()) {
            if !categories.split(',').any(|c| c.trim() == event.category) {
                return false;
            }
        }
        if let Some(device) = self.device.as_deref().filter(|d| !d.is_empty()) {
            if event.device_id.as_deref() != Some(device) {
                return false;
            }
        }
        if let Some(run) = self.run.as_deref().filter(|r| !r.is_empty()) {
            if event.run_id.as_deref() != Some(run) {
                return false;
            }
        }
        let last = event.last_at.unwrap_or(event.at);
        if self.since.is_some_and(|s| last < s) || self.until.is_some_and(|u| event.at > u) {
            return false;
        }
        if let Some(q) = self.q.as_deref().map(str::trim).filter(|q| !q.is_empty()) {
            let hay = format!(
                "{} {} {} {} {} {} {} {}",
                event.summary,
                event.detail.as_deref().unwrap_or(""),
                event.kind,
                event.device_name.as_deref().unwrap_or(""),
                event.device_id.as_deref().unwrap_or(""),
                event.run_id.as_deref().unwrap_or(""),
                event.source,
                event.meta.values().filter_map(Value::as_str).collect::<Vec<_>>().join(" ")
            )
            .to_lowercase();
            if !q.to_lowercase().split_whitespace().all(|word| hay.contains(word)) {
                return false;
            }
        }
        true
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    /// Newest first.
    pub events: Vec<Event>,
    /// Events matching the filters (on every page).
    pub total: usize,
    pub has_more: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_before: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MacroCounts {
    pub done: usize,
    pub failed: usize,
    pub stopped: usize,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub since: u64,
    /// Events kept in all.
    pub total: usize,
    pub latest_id: u64,
    pub by_severity: std::collections::BTreeMap<String, usize>,
    pub by_category: std::collections::BTreeMap<String, usize>,
    pub macro_runs: MacroCounts,
    /// Phones with warnings or errors, and how many.
    pub problem_devices: std::collections::BTreeMap<String, usize>,
    pub recent_problems: Vec<Event>,
}

/* ------------------------------ global ------------------------------ */

fn slot() -> &'static OnceLock<EventLog> {
    static LOG: OnceLock<EventLog> = OnceLock::new();
    &LOG
}

/// The history. Before `init` (and in tests) it lives in memory only.
pub fn log() -> &'static EventLog {
    slot().get_or_init(|| EventLog::in_memory(Retention::default()))
}

/// Open the history in the data folder and note how the last run ended.
pub fn init(retention: Retention) {
    let dir = crate::data_dir::logs_dir();
    let (opened, report) = EventLog::open(&dir, retention);
    if slot().set(opened).is_err() {
        return;
    }
    if let Some(error) = report.error {
        record(Event::new("system", "system.history_unreadable", Severity::Warning, "The event history could not be read").detail(error));
    }
    if report.damaged > 0 {
        record(
            Event::new("system", "system.history_repaired", Severity::Warning, format!("{} damaged event line(s) were skipped", report.damaged))
                .detail("The original file was copied to backups/corrupt."),
        );
    }
    let marker = dir.join(RUNNING_MARKER);
    if marker.exists() {
        let started = std::fs::read_to_string(&marker).ok().and_then(|s| s.trim().parse::<u64>().ok());
        let mut event = Event::new("system", "system.unclean_shutdown", Severity::Error, "ADBoard did not shut down cleanly last time")
            .detail("It was closed, crashed or the computer lost power while it ran. Macro runs that were playing did not finish.");
        if let Some(at) = started {
            event = event.meta("previousStart", at);
        }
        record(event);
    }
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(&marker, now_ms().to_string());
    install_panic_hook();
}

/// A clean stop: saves folded counts and removes the running marker.
pub fn shutdown() {
    record(Event::new("system", "system.stopped", Severity::Info, "ADBoard stopped"));
    log().flush();
    let _ = std::fs::remove_file(crate::data_dir::logs_dir().join(RUNNING_MARKER));
}

/// Store an event and offer it to notifications.
pub fn record(event: Event) -> Option<Event> {
    let stored = log().record(event)?;
    crate::notify::offer(&stored);
    Some(stored)
}

fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let place = info.location().map(|l| format!(" at {}:{}", l.file(), l.line())).unwrap_or_default();
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "panic".into());
        // Memory and file only: the notifier may be the thing that panicked.
        let _ = log().record(Event::new("system", "system.panic", Severity::Critical, "Internal error in ADBoard").detail(format!("{message}{place}")));
        previous(info);
    }));
}

/* --------------------------- phones & streams --------------------------- */

#[derive(Debug, Clone, PartialEq)]
struct Seen {
    status: DeviceStatus,
    since: u64,
    name: String,
}

/// What changed between two fleet snapshots, as events.
fn fleet_changes(previous: &HashMap<String, Seen>, devices: &[Device], now: u64) -> Vec<Event> {
    let mut out = Vec::new();
    for device in devices {
        let name = &device.name;
        match (previous.get(&device.id).map(|s| (s.status, s.since)), device.status) {
            (None, DeviceStatus::Online) => out.push(Event::new("device", "device.connected", Severity::Info, format!("{name} connected")).about(device)),
            (None, DeviceStatus::Unauthorized) | (Some((DeviceStatus::Online | DeviceStatus::Offline, _)), DeviceStatus::Unauthorized) => out.push(
                Event::new("device", "device.unauthorized", Severity::Warning, format!("{name} is waiting for USB debugging approval"))
                    .detail("Accept the RSA prompt on the phone.")
                    .about(device),
            ),
            (Some((DeviceStatus::Online, _)), DeviceStatus::Offline) => {
                out.push(Event::new("device", "device.disconnected", Severity::Warning, format!("{name} went offline")).about(device))
            }
            (Some((DeviceStatus::Offline | DeviceStatus::Unauthorized, since)), DeviceStatus::Online) => {
                let away = now.saturating_sub(since) / 1000;
                out.push(
                    Event::new("device", "device.reconnected", Severity::Info, format!("{name} is back online"))
                        .detail(format!("Away for {}", duration_label(away)))
                        .meta("offlineSeconds", away)
                        .about(device),
                )
            }
            _ => {}
        }
    }
    for (id, seen) in previous {
        if seen.status == DeviceStatus::Online && !devices.iter().any(|d| &d.id == id) {
            out.push(
                Event::new("device", "device.disconnected", Severity::Warning, format!("{} was disconnected", seen.name))
                    .device(id, &seen.name)
                    .detail("It is no longer listed by ADB."),
            );
        }
    }
    out
}

pub fn duration_label(seconds: u64) -> String {
    match seconds {
        0..=59 => format!("{seconds} s"),
        60..=3599 => format!("{} min", seconds / 60),
        _ => format!("{} h {} min", seconds / 3600, (seconds % 3600) / 60),
    }
}

fn snapshot(devices: &[Device], previous: &HashMap<String, Seen>, now: u64) -> HashMap<String, Seen> {
    let mut next: HashMap<String, Seen> = devices
        .iter()
        .map(|d| {
            let since = match previous.get(&d.id) {
                Some(seen) if seen.status == d.status => seen.since,
                _ => now,
            };
            (d.id.clone(), Seen { status: d.status, since, name: d.name.clone() })
        })
        .collect();
    // An unplugged phone leaves ADB's list; remember it as offline so the
    // outage keeps its start time and its return counts as "back online".
    for (id, seen) in previous {
        if !next.contains_key(id) {
            let since = if seen.status == DeviceStatus::Online { now } else { seen.since };
            next.insert(id.clone(), Seen { status: DeviceStatus::Offline, since, name: seen.name.clone() });
        }
    }
    next
}

/// Phones offline for at least `mins` minutes that were not alerted yet
/// (`alerted` remembers them until they come back).
fn long_outages(seen: &HashMap<String, Seen>, alerted: &mut std::collections::HashSet<String>, now: u64, mins: u64) -> Vec<Event> {
    alerted.retain(|id| seen.get(id).is_some_and(|s| s.status != DeviceStatus::Online));
    if mins == 0 {
        return Vec::new();
    }
    let mut out = Vec::new();
    for (id, s) in seen {
        let away = now.saturating_sub(s.since);
        if s.status != DeviceStatus::Online && away >= mins * 60_000 && alerted.insert(id.clone()) {
            let what = if s.status == DeviceStatus::Unauthorized { "has been waiting for USB approval" } else { "has been offline" };
            out.push(
                Event::new("device", "device.offline_long", Severity::Warning, format!("{} {what} for {}", s.name, duration_label(away / 1000)))
                    .device(id, &s.name)
                    .detail(format!("Offline since {}. You will get a message when it is back.", crate::notify::iso_time(s.since)))
                    .meta("offlineSeconds", away / 1000),
            );
        }
    }
    out.sort_by(|a, b| a.device_name.cmp(&b.device_name));
    out
}

/// Watch the fleet and the video sessions and record what changes. Reads the
/// same broadcasts the UI gets, so nothing in device management changes.
pub fn spawn_watch(state: AppState) {
    tokio::spawn(async move {
        let mut events = state.subscribe();
        let devices = state.list_devices().await;
        let online = devices.iter().filter(|d| d.status == DeviceStatus::Online).count();
        record(
            Event::new("system", "system.started", Severity::Info, format!("ADBoard started · {online}/{} phones online", devices.len()))
                .source("agent")
                .meta("version", env!("CARGO_PKG_VERSION")),
        );
        let mut seen = snapshot(&devices, &HashMap::new(), now_ms());
        let mut alerted = std::collections::HashSet::new();
        let mut streams: HashMap<String, StreamState> = HashMap::new();
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(10));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            let fleet_changed = tokio::select! {
                message = events.recv() => match message {
                    Ok(ServerEvent::Devices { .. } | ServerEvent::DeviceUpdated { .. }) => true,
                    Ok(ServerEvent::SessionUpdated { session }) => {
                        let before = streams.insert(session.serial.clone(), session.stream);
                        if let Some(event) = stream_change(before, &session, &state).await {
                            record(event);
                        }
                        false
                    }
                    Ok(ServerEvent::Notice { message }) => {
                        let category = if message.to_lowercase().contains("adb") { "adb" } else { "system" };
                        record(Event::new(category, &format!("{category}.notice"), Severity::Warning, message).source("agent"));
                        false
                    }
                    Ok(_) => false,
                    // Missed some broadcasts: compare against the current fleet.
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => true,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                },
                _ = tick.tick() => true,
            };
            if fleet_changed {
                let devices = state.list_devices().await;
                let now = now_ms();
                for mut event in fleet_changes(&seen, &devices, now) {
                    // The end of an outage that was alerted.
                    if event.kind == "device.reconnected" && event.device_id.as_ref().is_some_and(|id| alerted.contains(id)) {
                        event = event.meta("alerted", true);
                    }
                    record(event.source("devices"));
                }
                seen = snapshot(&devices, &seen, now);
                for event in long_outages(&seen, &mut alerted, now, crate::notify::settings().offline_alert_mins) {
                    record(event.source("devices"));
                }
            }
        }
    });
}

async fn stream_change(before: Option<StreamState>, session: &adboard_protocol::SessionStatus, state: &AppState) -> Option<Event> {
    let device = state.list_devices().await.into_iter().find(|d| d.serial == session.serial);
    let name = device.as_ref().map(|d| d.name.clone()).unwrap_or_else(|| session.serial.clone());
    let event = match (before, session.stream) {
        (b, StreamState::Error) if b != Some(StreamState::Error) => {
            Event::new("scrcpy", "scrcpy.failed", Severity::Error, format!("Live screen of {name} stopped")).detail(session.note.clone())
        }
        (Some(StreamState::Error), StreamState::Streaming) => Event::new("scrcpy", "scrcpy.recovered", Severity::Info, format!("Live screen of {name} is back")),
        _ => return None,
    };
    let event = event.source("sessions");
    Some(match device {
        Some(device) => event.about(&device),
        None => event.device(&session.serial, &name),
    })
}

/* ------------------------- commands & installs ------------------------- */

/// Device commands worth a history entry, with their category and label.
fn command_label(op: &str) -> Option<(&'static str, &'static str)> {
    Some(match op {
        "reboot" => ("device", "Restart"),
        "shutdown" => ("device", "Power off"),
        "restartAdb" => ("adb", "Restart ADB"),
        "uninstall" => ("app", "Uninstall"),
        "launch" => ("app", "Launch app"),
        "forceStop" => ("app", "Force stop"),
        "clearData" => ("app", "Clear app data"),
        "screenshot" => ("device", "Screenshot"),
        "recordStart" => ("device", "Start recording"),
        "recordStop" => ("device", "Stop recording"),
        "displaySize" => ("device", "Screen size"),
        _ => return None,
    })
}

/// One event per phone for commands that change something; routine
/// successes (a screenshot, an app launch) are only recorded when they fail.
pub fn record_command(op: &str, arg: Option<&str>, results: &[adboard_protocol::DeviceOpResult]) {
    let Some((category, label)) = command_label(op) else { return };
    let routine = matches!(op, "screenshot" | "launch" | "forceStop" | "recordStart" | "recordStop");
    for result in results {
        let what = match (op, arg) {
            ("uninstall" | "launch" | "forceStop" | "clearData", Some(package)) => format!("{label} {package}"),
            _ => label.to_string(),
        };
        let event = if result.ok {
            if routine {
                continue;
            }
            Event::new(category, &format!("{category}.{op}"), Severity::Info, format!("{what} on {}", result.device_name)).detail(result.output.clone().unwrap_or_default())
        } else {
            Event::new(category, &format!("{category}.{op}_failed"), Severity::Error, format!("{what} failed on {}", result.device_name))
                .detail(result.error.clone().unwrap_or_default())
        };
        record(event.device(&result.device_id, &result.device_name).source("commands").meta("op", op));
    }
}

/// One event per phone for an APK install.
pub fn record_install(filename: &str, targets: &[adboard_protocol::NavTargetResult]) {
    use adboard_protocol::InjectStatus;
    for target in targets {
        let event = match target.inject {
            InjectStatus::Error => Event::new("app", "app.install_failed", Severity::Error, format!("Installing {filename} failed on {}", target.device_name))
                .detail(target.detail.clone().unwrap_or_default()),
            _ => Event::new("app", "app.installed", Severity::Info, format!("Installed {filename} on {}", target.device_name)),
        };
        record(event.device(&target.device_id, &target.device_name).source("install").meta("apk", filename));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use adboard_protocol::{ConnectionType, DeviceResolution};

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("adboard-events-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn event(kind: &str, severity: Severity, device: Option<&str>, summary: &str) -> Event {
        let category = kind.split('.').next().unwrap();
        let e = Event::new(category, kind, severity, summary);
        match device {
            Some(d) => e.device(d, &d.to_uppercase()),
            None => e,
        }
    }

    #[test]
    fn events_survive_a_restart_and_ids_keep_increasing() {
        let dir = temp_dir();
        let (log, report) = EventLog::open(&dir, Retention::default());
        assert_eq!(report, LoadReport::default());
        let first = log.record(event("device.disconnected", Severity::Warning, Some("s24"), "S24 went offline")).unwrap();
        log.record(event("macro.failed", Severity::Error, Some("s23"), "Farm failed on S23")).unwrap();
        drop(log);
        let (again, report) = EventLog::open(&dir, Retention::default());
        assert_eq!(report.loaded, 2);
        let next = again.record(event("device.connected", Severity::Info, Some("s24"), "S24 connected")).unwrap();
        assert!(next.id > first.id + 1);
        let page = again.query(&Query::default());
        assert_eq!(page.events.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(), vec!["device.connected", "macro.failed", "device.disconnected"]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn damaged_lines_are_skipped_and_the_original_is_kept() {
        let dir = temp_dir();
        let good = serde_json::to_string(&Event { id: 7, ..event("system.started", Severity::Info, None, "ok") }).unwrap();
        std::fs::write(dir.join(FILE_NAME), format!("{good}\n{{not json\n\n{good}x\n")).unwrap();
        let (log, report) = EventLog::open(&dir, Retention::default());
        assert_eq!((report.loaded, report.damaged), (1, 2));
        // The rewritten file only has the good line.
        let text = std::fs::read_to_string(dir.join(FILE_NAME)).unwrap();
        assert_eq!(text.lines().count(), 1);
        assert_eq!(log.record(event("system.notice", Severity::Info, None, "next")).unwrap().id, 8);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn retention_bounds_memory_and_the_file() {
        let dir = temp_dir();
        let (log, _) = EventLog::open(&dir, Retention { max_events: 100, max_days: 0 });
        for i in 0..1000 {
            log.record(event("macro.completed", Severity::Info, Some("s24"), &format!("run {i}"))).unwrap();
        }
        assert_eq!(log.query(&Query { limit: Some(200), ..Default::default() }).total, 100);
        let lines = std::fs::read_to_string(dir.join(FILE_NAME)).unwrap().lines().count();
        assert!(lines <= 100 + 10 + 50, "file stays bounded: {lines} lines");
        // Old events go by age too.
        let old = Event { at: now_ms() - 3 * 86_400_000, ..event("device.connected", Severity::Info, None, "old") };
        log.record(old);
        log.set_retention(Retention { max_events: 100, max_days: 1 });
        assert!(log.query(&Query { q: Some("old".into()), ..Default::default() }).events.is_empty());
        // Recording it pushed the oldest run out; removing it leaves 99.
        assert_eq!(std::fs::read_to_string(dir.join(FILE_NAME)).unwrap().lines().count(), 99);
        assert_eq!(log.clear(None), 99);
        assert_eq!(std::fs::read_to_string(dir.join(FILE_NAME)).unwrap(), "");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn bursts_fold_into_one_event() {
        let log = EventLog::in_memory(Retention::default());
        assert!(log.record(event("adb.notice", Severity::Warning, None, "adb devices failed")).is_some());
        for _ in 0..30 {
            assert!(log.record(event("adb.notice", Severity::Warning, None, "adb devices failed")).is_none());
        }
        // Another phone or another text is a new event.
        assert!(log.record(event("device.disconnected", Severity::Warning, Some("a"), "A went offline")).is_some());
        assert!(log.record(event("device.disconnected", Severity::Warning, Some("b"), "B went offline")).is_some());
        let page = log.query(&Query::default());
        assert_eq!(page.events.len(), 3);
        assert_eq!(page.events[2].repeats, 30);
        assert_eq!(log.summary(0).by_severity["warning"], 33);
    }

    #[test]
    fn filters_search_and_paging() {
        let log = EventLog::in_memory(Retention::default());
        for i in 0..120 {
            let device = if i % 2 == 0 { "s24" } else { "s23" };
            let (kind, severity) = if i % 10 == 0 { ("macro.failed", Severity::Error) } else { ("macro.completed", Severity::Info) };
            log.record(event(kind, severity, Some(device), &format!("Run {i} of Farm")).run(&format!("run-{i}")));
        }
        log.record(event("device.disconnected", Severity::Warning, Some("s24"), "S24 went offline").meta("model", "Galaxy S24"));
        let errors = log.query(&Query { severity: Some(Severity::Error), ..Default::default() });
        assert_eq!(errors.total, 12);
        assert!(errors.events.iter().all(|e| e.kind == "macro.failed"));
        let warn_up = log.query(&Query { severity: Some(Severity::Warning), category: Some("device".into()), ..Default::default() });
        assert_eq!(warn_up.total, 1);
        assert_eq!(log.query(&Query { q: Some("galaxy s24".into()), ..Default::default() }).total, 1, "searches meta too");
        assert_eq!(log.query(&Query { q: Some("RUN 117 farm".into()), ..Default::default() }).total, 1, "every word must match");
        assert_eq!(log.query(&Query { run: Some("run-30".into()), ..Default::default() }).events[0].summary, "Run 30 of Farm");
        assert_eq!(log.query(&Query { device: Some("s23".into()), ..Default::default() }).total, 60);
        // Paging: newest first, no gaps or repeats.
        let mut seen = Vec::new();
        let mut before = None;
        loop {
            let page = log.query(&Query { device: Some("s24".into()), limit: Some(25), before, ..Default::default() });
            seen.extend(page.events.iter().map(|e| e.id));
            if !page.has_more {
                break;
            }
            before = page.next_before;
        }
        assert_eq!(seen.len(), 61);
        assert!(seen.windows(2).all(|w| w[0] > w[1]));
        let since = log.query(&Query { since: Some(now_ms() + 60_000), ..Default::default() });
        assert_eq!(since.total, 0);
    }

    #[test]
    fn secrets_never_reach_the_history() {
        let log = EventLog::in_memory(Retention::default());
        let url = "https://discord.com/api/webhooks/123456789012345678/abcDEF_ghi-JKL";
        let stored = log
            .record(
                event("notification.failed", Severity::Warning, None, &format!("POST {url} failed"))
                    .detail("token=hunter2 password: swordfish; see /api/webhooks/1/xyz")
                    .meta("url", url),
            )
            .unwrap();
        let text = serde_json::to_string(&stored).unwrap();
        for secret in ["abcDEF_ghi-JKL", "hunter2", "swordfish", "xyz"] {
            assert!(!text.contains(secret), "{secret} leaked: {text}");
        }
        assert!(stored.summary.contains("[webhook]"));
    }

    fn phone(id: &str, status: DeviceStatus) -> Device {
        Device {
            id: id.into(),
            name: id.to_uppercase(),
            model: "SM-S921B".into(),
            model_name: Some("Galaxy S24".into()),
            android_version: "14".into(),
            serial: id.into(),
            connection: ConnectionType::Usb,
            status,
            battery: None,
            temperature_c: None,
            cpu_percent: None,
            memory_percent: None,
            resolution: DeviceResolution { width: 1080, height: 2400 },
            fps: None,
            bitrate_mbps: None,
            latency_ms: None,
            host: "pc".into(),
            host_id: None,
            wallpaper_hue: 0,
        }
    }

    #[test]
    fn fleet_changes_become_device_events() {
        let start = vec![phone("s24", DeviceStatus::Online), phone("s23", DeviceStatus::Online), phone("a52", DeviceStatus::Offline)];
        let seen = snapshot(&start, &HashMap::new(), 1_000);
        assert!(fleet_changes(&seen, &start, 2_000).is_empty(), "nothing changed");
        let next = vec![phone("s24", DeviceStatus::Offline), phone("a52", DeviceStatus::Online), phone("p8", DeviceStatus::Unauthorized)];
        let kinds: Vec<(String, Option<String>)> = fleet_changes(&seen, &next, 121_000).into_iter().map(|e| (e.kind, e.device_id)).collect();
        assert!(kinds.contains(&("device.disconnected".into(), Some("s24".into()))));
        assert!(kinds.contains(&("device.reconnected".into(), Some("a52".into()))));
        assert!(kinds.contains(&("device.unauthorized".into(), Some("p8".into()))));
        assert!(kinds.contains(&("device.disconnected".into(), Some("s23".into()))), "unplugged phones vanish from the list");
        let back = fleet_changes(&seen, &next, 121_000).into_iter().find(|e| e.kind == "device.reconnected").unwrap();
        assert_eq!(back.detail.as_deref(), Some("Away for 2 min"));
        assert_eq!(back.meta["model"], "Galaxy S24");
    }

    #[test]
    fn long_outages_are_alerted_once_and_unplugged_phones_are_remembered() {
        let mut alerted = std::collections::HashSet::new();
        let start = vec![phone("s24", DeviceStatus::Online), phone("s23", DeviceStatus::Online)];
        let seen = snapshot(&start, &HashMap::new(), 0);
        // s24 drops, s23 is unplugged (leaves the list) at 60 s.
        let seen = snapshot(&[phone("s24", DeviceStatus::Offline)], &seen, 60_000);
        assert_eq!(seen["s23"].status, DeviceStatus::Offline, "kept after leaving the list");
        assert!(long_outages(&seen, &mut alerted, 60_000 + 4 * 60_000, 5).is_empty(), "4 min < 5 min");
        let alerts = long_outages(&seen, &mut alerted, 60_000 + 5 * 60_000, 5);
        assert_eq!(alerts.iter().map(|e| e.summary.as_str()).collect::<Vec<_>>(), vec!["S23 has been offline for 5 min", "S24 has been offline for 5 min"]);
        assert!(long_outages(&seen, &mut alerted, 60_000 + 50 * 60_000, 5).is_empty(), "once per outage");
        // s24 comes back: it is forgotten, so its next outage alerts again.
        let back = snapshot(&[phone("s24", DeviceStatus::Online)], &seen, 4_000_000);
        let changes = fleet_changes(&seen, &[phone("s24", DeviceStatus::Online)], 4_000_000);
        assert!(changes.iter().any(|e| e.kind == "device.reconnected" && e.device_id.as_deref() == Some("s24")));
        assert!(long_outages(&back, &mut alerted, 4_000_000, 5).is_empty());
        assert!(!alerted.contains("s24") && alerted.contains("s23"));
        assert!(long_outages(&seen, &mut std::collections::HashSet::new(), 10_000_000, 0).is_empty(), "0 turns it off");
    }

    #[test]
    fn macro_stats_from_run_events() {
        let log = EventLog::in_memory(Retention::default());
        let run = |kind: &str, tab: &str, device: &str, seconds: u64, step: Option<u64>, reason: &str| {
            let severity = if kind == "macro.failed" { Severity::Error } else { Severity::Info };
            let mut e = event(kind, severity, Some(device), &format!("{tab} {kind}")).meta("macro", tab).meta("tabId", format!("tab-{tab}")).meta("durationSeconds", seconds).detail(reason);
            if let Some(step) = step {
                e = e.meta("step", step);
            }
            e
        };
        for (i, seconds) in [60u64, 120, 90].into_iter().enumerate() {
            log.record(run("macro.completed", "Farm", "s24", seconds, None, &format!("Finished {i}")).run(&format!("r{i}")));
        }
        log.record(run("macro.failed", "Farm", "s23", 5, Some(3), "Step 3: “OK” not found").run("r3"));
        log.record(run("macro.failed", "Farm", "s23", 5, Some(3), "Step 3: “OK” not found after 10 s").run("r4"));
        log.record(run("macro.failed", "Farm", "s24", 5, Some(1), "Phone disconnected").run("r5"));
        log.record(run("macro.stopped", "Login", "s24", 5, None, "Stopped").run("r6"));
        log.record(event("macro.started", Severity::Info, Some("s24"), "Farm started").meta("macro", "Farm").meta("tabId", "tab-Farm").run("r7"));
        let stats = log.macro_stats(0);
        assert_eq!(stats.len(), 2);
        let farm = &stats[0];
        assert_eq!((farm.name.as_str(), farm.runs, farm.done, farm.failed, farm.stopped), ("Farm", 6, 3, 3, 0));
        assert!((farm.success_rate - 0.5).abs() < 1e-9);
        assert_eq!(farm.avg_seconds, Some(90.0), "only finished runs count");
        assert_eq!(farm.failing_steps[0], StepFailures { step: Some(3), count: 2, last_reason: "Step 3: “OK” not found after 10 s".into() });
        assert_eq!(farm.failed_phones["S23"], 2);
        assert_eq!(farm.last_status, "failed");
        assert_eq!((stats[1].name.as_str(), stats[1].stopped, stats[1].avg_seconds), ("Login", 1, None));
        assert!(log.macro_stats(now_ms() + 1000).is_empty());
    }

    #[test]
    fn commands_record_failures_and_changes_not_routine_successes() {
        let before = log().query(&Query { q: Some("cmdtest".into()), ..Default::default() }).total;
        let ok = |name: &str| adboard_protocol::DeviceOpResult { device_id: name.into(), device_name: format!("cmdtest {name}"), ok: true, output: None, error: None };
        let bad = adboard_protocol::DeviceOpResult { device_id: "b".into(), device_name: "cmdtest b".into(), ok: false, output: None, error: Some("no such package".into()) };
        record_command("screenshot", None, &[ok("a")]);
        record_command("files", None, &[ok("a")]);
        record_command("launch", Some("com.game"), &[ok("a"), bad.clone()]);
        record_command("reboot", None, &[ok("a")]);
        let page = log().query(&Query { q: Some("cmdtest".into()), ..Default::default() });
        assert_eq!(page.total - before, 2);
        assert!(page.events.iter().any(|e| e.kind == "app.launch_failed" && e.summary == "Launch app com.game failed on cmdtest b"));
        assert!(page.events.iter().any(|e| e.kind == "device.reboot"));
    }
}
