//! Live logcat for the Logcat tab, and the crash watcher that turns app
//! crashes into events (and Discord messages).
//!
//! The browser sends `{"package": "…", "level": "W"}` as its first message on
//! `/ws/devices/{serial}/logcat`; the agent answers with
//! `{"lines": [...]}` batches, `{"note": "…"}` and `{"skipped": n}`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;

use crate::device_manager::AppState;
use crate::device_ops::{adb_text, valid_package};
use crate::events::{record, Event, Severity};

/// Lines sent per second at most; the rest are counted as skipped.
const MAX_LINES_PER_SEC: usize = 2000;
/// Lines of history sent when the stream starts.
const BACKFILL: &str = "300";

#[derive(Debug, Default, Clone, Deserialize)]
pub struct Filter {
    #[serde(default)]
    pub package: String,
    #[serde(default)]
    pub level: String,
}

/// `V D I W E F`; anything else shows everything.
pub fn level_spec(level: &str) -> &'static str {
    match level.trim().to_ascii_uppercase().as_str() {
        "D" => "*:D",
        "I" => "*:I",
        "W" => "*:W",
        "E" => "*:E",
        "F" => "*:F",
        _ => "*:V",
    }
}

/// `cmd package list packages -U <pkg>` prints `package:com.app uid:10234`.
pub fn parse_uid(text: &str, package: &str) -> Option<u32> {
    text.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        (parts.next()?.strip_prefix("package:")? == package).then_some(())?;
        parts.find_map(|p| p.strip_prefix("uid:"))?.split(',').next()?.parse().ok()
    })
}

/// How to narrow logcat to one app.
#[derive(Debug, Clone, PartialEq)]
pub enum Scope {
    All,
    Uid(u32),
    Pid(String),
}

pub fn logcat_args(serial: &str, scope: &Scope, level: &str) -> Vec<String> {
    let mut args: Vec<String> = ["-s", serial, "logcat", "-v", "threadtime", "-T", BACKFILL].iter().map(|s| s.to_string()).collect();
    match scope {
        Scope::All => {}
        // By uid, not pid: an app can run several processes, and a restart changes the pid.
        Scope::Uid(uid) => args.push(format!("--uid={uid}")),
        Scope::Pid(pid) => args.push(format!("--pid={pid}")),
    }
    args.push(level_spec(level).to_string());
    args
}

fn frame(value: serde_json::Value) -> String {
    value.to_string()
}

/// Run logcat for `serial` until the receiver goes away. Frames are JSON text.
pub async fn stream(adb: Option<PathBuf>, serial: String, filter: Filter, tx: mpsc::Sender<String>) {
    let Some(adb) = adb else {
        mock_stream(filter, tx).await;
        return;
    };
    let package = filter.package.trim().to_string();
    let mut scopes = vec![Scope::All];
    if !package.is_empty() {
        if !valid_package(&package) {
            let _ = tx.send(frame(serde_json::json!({ "note": "package name is not valid" }))).await;
            return;
        }
        let listed = adb_text(&adb, &["-s".into(), serial.clone(), "shell".into(), format!("cmd package list packages -U {package}")]).await.unwrap_or_default();
        let pid = adb_text(&adb, &["-s".into(), serial.clone(), "shell".into(), format!("pidof {package}; true")]).await.unwrap_or_default();
        scopes = Vec::new();
        if let Some(uid) = parse_uid(&listed, &package) {
            scopes.push(Scope::Uid(uid));
        }
        if let Some(pid) = pid.split_whitespace().next().filter(|p| p.chars().all(|c| c.is_ascii_digit())) {
            scopes.push(Scope::Pid(pid.to_string()));
        }
        if scopes.is_empty() {
            let _ = tx.send(frame(serde_json::json!({ "note": format!("{package} is not installed or not running on this phone") }))).await;
            return;
        }
    }
    for (i, scope) in scopes.iter().enumerate() {
        let last = i + 1 == scopes.len();
        match run_logcat(&adb, &serial, scope, &filter.level, &tx).await {
            // Older logcat has no --uid: it stops at once; try the pid instead.
            Err(error) if !last => tracing::info!(%serial, %error, "logcat {scope:?} refused; trying the next scope"),
            Err(error) => {
                let _ = tx.send(frame(serde_json::json!({ "note": format!("logcat stopped: {error}") }))).await;
                return;
            }
            Ok(()) => return,
        }
    }
}

/// Stream one logcat process. `Err` when it exits before printing anything.
async fn run_logcat(adb: &Path, serial: &str, scope: &Scope, level: &str, tx: &mpsc::Sender<String>) -> Result<(), String> {
    let mut child = Command::new(adb)
        .args(logcat_args(serial, scope, level))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("failed to start adb logcat: {e}"))?;
    let stdout = child.stdout.take().ok_or("no logcat output")?;
    let stderr = child.stderr.take();
    let mut lines = BufReader::new(stdout).lines();
    let mut batch: Vec<String> = Vec::new();
    let mut printed = false;
    let mut second = Instant::now();
    let mut sent_this_second = 0usize;
    let mut skipped = 0usize;
    let mut flush = tokio::time::interval(Duration::from_millis(150));
    loop {
        tokio::select! {
            line = lines.next_line() => match line {
                Ok(Some(line)) => {
                    printed = true;
                    if second.elapsed() >= Duration::from_secs(1) {
                        second = Instant::now();
                        sent_this_second = 0;
                    }
                    if sent_this_second >= MAX_LINES_PER_SEC {
                        skipped += 1;
                    } else {
                        sent_this_second += 1;
                        batch.push(line);
                    }
                }
                _ => break,
            },
            _ = flush.tick() => {
                if skipped > 0 && tx.send(frame(serde_json::json!({ "skipped": skipped }))).await.is_err() {
                    return Ok(());
                }
                skipped = 0;
                if !batch.is_empty() && tx.send(frame(serde_json::json!({ "lines": std::mem::take(&mut batch) }))).await.is_err() {
                    return Ok(());
                }
            }
            _ = tx.closed() => return Ok(()),
        }
    }
    if !batch.is_empty() {
        let _ = tx.send(frame(serde_json::json!({ "lines": batch }))).await;
    }
    if printed {
        let _ = tx.send(frame(serde_json::json!({ "note": "logcat ended (phone disconnected?)" }))).await;
        return Ok(());
    }
    let mut error = String::new();
    if let Some(stderr) = stderr {
        let mut err_lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = err_lines.next_line().await {
            error.push_str(line.trim());
            error.push(' ');
        }
    }
    Err(if error.trim().is_empty() { "logcat printed nothing".into() } else { error.trim().to_string() })
}

/// The mock fleet's logcat: made-up lines at every level, so the tab can be tried.
async fn mock_stream(filter: Filter, tx: mpsc::Sender<String>) {
    let package = if filter.package.trim().is_empty() { "com.example.app" } else { filter.package.trim() };
    let wanted = level_rank(level_spec(&filter.level).trim_start_matches("*:"));
    let samples = [
        ("D", "ActivityThread", format!("Binding application {package}")),
        ("I", "ActivityManager", format!("Start proc 4242:{package}/u0a234 for activity")),
        ("V", "Choreographer", "Frame time 16.6 ms".to_string()),
        ("W", "System", "A resource failed to call close.".to_string()),
        ("E", "AndroidRuntime", format!("Process: {package}, PID: 4242 (mock error line)")),
    ];
    let _ = tx.send(frame(serde_json::json!({ "note": "mock phone: sample lines" }))).await;
    let mut n = 0u64;
    loop {
        let mut lines = Vec::new();
        for (level, tag, message) in &samples {
            if level_rank(level) >= wanted {
                n += 1;
                lines.push(format!("10-30 12:00:{:02}.{:03}  4242  4242 {level} {tag}: {message} #{n}", (n / 10) % 60, (n * 37) % 1000));
            }
        }
        if !lines.is_empty() && tx.send(frame(serde_json::json!({ "lines": lines }))).await.is_err() {
            return;
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(500)) => {}
            _ = tx.closed() => return,
        }
    }
}

fn level_rank(level: &str) -> u8 {
    match level {
        "D" => 1,
        "I" => 2,
        "W" => 3,
        "E" => 4,
        "F" => 5,
        _ => 0,
    }
}

/* ------------------------------ crash watch ------------------------------ */

/// One crash read from the crash buffer.
#[derive(Debug, Clone, PartialEq)]
pub struct Crash {
    pub package: String,
    pub native: bool,
    /// The first lines of the report (exception and top of the stack).
    pub lines: Vec<String>,
}

/// The message part of a `threadtime` line (after `TAG: `).
fn message(line: &str) -> &str {
    // "10-30 12:00:00.123  1234  1234 E AndroidRuntime: FATAL EXCEPTION: main"
    line.split_once(": ").map(|(_, m)| m).unwrap_or(line).trim()
}

/// Groups crash-buffer lines into crash reports.
#[derive(Default)]
pub struct CrashParser {
    current: Option<Crash>,
}

impl CrashParser {
    /// Feed one line; returns the previous crash when this line starts a new one.
    pub fn feed(&mut self, line: &str) -> Option<Crash> {
        let text = message(line);
        if text.starts_with("FATAL EXCEPTION") {
            let done = self.finish();
            self.current = Some(Crash { package: String::new(), native: false, lines: Vec::new() });
            return done;
        }
        if let Some(name) = text.split_once(">>> ").and_then(|(_, r)| r.split_once(" <<<")).map(|(n, _)| n.trim()) {
            // Native crash header: "pid: 1, tid: 1, name: x  >>> com.game <<<"
            let done = self.finish();
            let package = name.split(':').next().unwrap_or(name).to_string();
            self.current = Some(Crash { package, native: true, lines: Vec::new() });
            return done;
        }
        let crash = self.current.as_mut()?;
        if let Some(rest) = text.strip_prefix("Process: ") {
            crash.package = rest.split(',').next().unwrap_or("").trim().to_string();
        } else if crash.lines.len() < 8 && !text.is_empty() {
            crash.lines.push(text.to_string());
        }
        None
    }

    /// The crash being read, if it names an app.
    pub fn finish(&mut self) -> Option<Crash> {
        self.current.take().filter(|c| !c.package.is_empty())
    }
}

fn record_crash(crash: &Crash, device_id: &str, device_name: &str) {
    let what = if crash.native { "crashed (native)" } else { "crashed" };
    record(
        Event::new("app", "app.crashed", Severity::Error, format!("{} {what} on {device_name}", crash.package))
            .detail(crash.lines.join("\n"))
            .device(device_id, device_name)
            .source("crash-watch")
            .meta("package", crash.package.as_str()),
    );
}

/// Follow one phone's crash buffer until logcat ends.
async fn watch_phone(adb: PathBuf, serial: String, device_id: String, device_name: String) {
    let child = Command::new(&adb)
        .args(["-s", &serial, "logcat", "-b", "crash", "-v", "threadtime", "-T", "1"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn();
    let Ok(mut child) = child else { return };
    let Some(stdout) = child.stdout.take() else { return };
    let mut lines = BufReader::new(stdout).lines();
    let started = Instant::now();
    let mut parser = CrashParser::default();
    loop {
        // A report is complete when the buffer goes quiet for a moment.
        match tokio::time::timeout(Duration::from_millis(1500), lines.next_line()).await {
            Ok(Ok(Some(line))) => {
                // `-T 1` repeats the last old line; skip what arrives at once.
                if started.elapsed() < Duration::from_millis(1500) {
                    continue;
                }
                if let Some(crash) = parser.feed(&line) {
                    record_crash(&crash, &device_id, &device_name);
                }
            }
            Ok(_) => break,
            Err(_) => {
                if let Some(crash) = parser.finish() {
                    record_crash(&crash, &device_id, &device_name);
                }
            }
        }
    }
    if let Some(crash) = parser.finish() {
        record_crash(&crash, &device_id, &device_name);
    }
}

/// One crash-buffer reader per online phone on this computer.
pub fn spawn_crash_watch(state: AppState) {
    let Some(adb) = state.inner.adb_path.clone() else { return };
    tokio::spawn(async move {
        let mut watching: HashMap<String, tokio::task::JoinHandle<()>> = HashMap::new();
        let mut tick = tokio::time::interval(Duration::from_secs(15));
        loop {
            tick.tick().await;
            let online: HashMap<String, (String, String)> = state
                .list_local_devices()
                .await
                .into_iter()
                .filter(|d| d.status == adboard_protocol::DeviceStatus::Online)
                .map(|d| (d.serial.clone(), (d.id.clone(), d.name.clone())))
                .collect();
            watching.retain(|serial, task| {
                let keep = online.contains_key(serial) && !task.is_finished();
                if !keep {
                    task.abort();
                }
                keep
            });
            for (serial, (id, name)) in online {
                watching
                    .entry(serial.clone())
                    .or_insert_with(|| tokio::spawn(watch_phone(adb.clone(), serial, id, name)));
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn levels_and_args() {
        assert_eq!(level_spec("w"), "*:W");
        assert_eq!(level_spec(""), "*:V");
        assert_eq!(level_spec("; rm"), "*:V");
        assert_eq!(
            logcat_args("R5", &Scope::Uid(10234), "E"),
            ["-s", "R5", "logcat", "-v", "threadtime", "-T", "300", "--uid=10234", "*:E"]
        );
        assert_eq!(logcat_args("R5", &Scope::Pid("77".into()), "").last().map(String::as_str), Some("*:V"));
    }

    #[test]
    fn uid_from_the_package_list() {
        let text = "package:com.game uid:10234\npackage:com.game.helper uid:10300\n";
        assert_eq!(parse_uid(text, "com.game"), Some(10234));
        assert_eq!(parse_uid(text, "com.game.helper"), Some(10300));
        assert_eq!(parse_uid("package:com.x uid:1000,10234", "com.x"), Some(1000));
        assert_eq!(parse_uid(text, "com.none"), None);
    }

    #[test]
    fn groups_java_and_native_crashes() {
        let lines = [
            "--------- beginning of crash",
            "10-30 12:00:00.100  4242  4242 E AndroidRuntime: FATAL EXCEPTION: main",
            "10-30 12:00:00.100  4242  4242 E AndroidRuntime: Process: com.game, PID: 4242",
            "10-30 12:00:00.100  4242  4242 E AndroidRuntime: java.lang.NullPointerException: boom",
            "10-30 12:00:00.100  4242  4242 E AndroidRuntime: \tat com.game.Main.onCreate(Main.java:10)",
            "10-30 12:00:05.000  5000  5000 F DEBUG   : pid: 5000, tid: 5000, name: RenderThread  >>> com.other:remote <<<",
            "10-30 12:00:05.000  5000  5000 F DEBUG   : signal 11 (SIGSEGV), code 1",
        ];
        let mut parser = CrashParser::default();
        let mut crashes: Vec<Crash> = lines.iter().filter_map(|l| parser.feed(l)).collect();
        crashes.extend(parser.finish());
        assert_eq!(crashes.len(), 2);
        assert_eq!(crashes[0].package, "com.game");
        assert!(!crashes[0].native);
        assert_eq!(crashes[0].lines[0], "java.lang.NullPointerException: boom");
        assert_eq!(crashes[1].package, "com.other");
        assert!(crashes[1].native);
        assert_eq!(crashes[1].lines, vec!["signal 11 (SIGSEGV), code 1"]);
    }

    #[test]
    fn a_crash_without_a_process_line_is_dropped() {
        let mut parser = CrashParser::default();
        assert!(parser.feed("x E AndroidRuntime: FATAL EXCEPTION: main").is_none());
        assert!(parser.finish().is_none());
    }
}
