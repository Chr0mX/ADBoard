//! Scrcpy session manager + ADB input injection + local H264 video pumps.
//!
//! - When `PHONECONTROL_VIDEO_SOURCE=testpattern` (or `auto` without scrcpy): pump
//!   synthetic Annex-B H264 on the video hub (`streaming` / backend `testpattern`).
//! - When `scrcpy` exists and source allows it: start/stop headless scrcpy process.
//!   Real scrcpy→WS frame forwarder is still TBD; stream state reflects the process.
//! - Inject v1: `adb shell input tap` / `keyevent` when ADB is available; otherwise stub.

use crate::video::{
    h264_status_for_session, should_use_testpattern, start_testpattern_pump, VideoHub,
    VideoPump, VideoSourceKind, TESTPATTERN_CODEC_STRING, TESTPATTERN_HEIGHT, TESTPATTERN_WIDTH,
};
use phonecontrol_protocol::{
    adb_keyevent_args, adb_tap_args, nav_keycode, InjectMode, InjectStatus, MappedTap,
    NavActionType, ScrcpyAvailability, SessionStatus, StreamState, VideoStatusFrame,
};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use tokio::process::{Child, Command};
use tokio::sync::RwLock;
use tracing::{info, warn};

#[derive(Debug, Clone)]
pub struct InjectResult {
    pub status: InjectStatus,
    pub detail: Option<String>,
}

struct LiveSession {
    info: SessionStatus,
    child: Option<Child>,
    video: Option<VideoPump>,
}

pub struct SessionManager {
    sessions: RwLock<HashMap<String, LiveSession>>,
    adb_path: Option<PathBuf>,
    scrcpy_path: Option<PathBuf>,
    inject_mode: InjectMode,
    video_hub: Arc<VideoHub>,
    video_source: VideoSourceKind,
}

impl SessionManager {
    pub fn new(
        adb_path: Option<PathBuf>,
        scrcpy_path: Option<PathBuf>,
        video_hub: Arc<VideoHub>,
    ) -> Arc<Self> {
        let inject_mode = if adb_path.is_some() {
            InjectMode::Adb
        } else {
            InjectMode::Stub
        };
        let video_source = VideoSourceKind::from_env();
        info!(?video_source, "video source configured");
        Arc::new(Self {
            sessions: RwLock::new(HashMap::new()),
            adb_path,
            scrcpy_path,
            inject_mode,
            video_hub,
            video_source,
        })
    }

    pub fn video_hub(&self) -> Arc<VideoHub> {
        self.video_hub.clone()
    }

    pub fn video_source(&self) -> VideoSourceKind {
        self.video_source
    }

    pub fn inject_mode(&self) -> InjectMode {
        self.inject_mode
    }

    pub fn scrcpy_availability(&self) -> ScrcpyAvailability {
        if self.scrcpy_path.is_some() {
            ScrcpyAvailability::Available
        } else {
            ScrcpyAvailability::Missing
        }
    }

    pub fn backend_label(&self) -> &'static str {
        if should_use_testpattern(self.video_source, self.scrcpy_path.is_some()) {
            "testpattern"
        } else if self.scrcpy_path.is_some() {
            "scrcpy"
        } else {
            "stub"
        }
    }

    fn stub_note(&self) -> String {
        match self.video_source {
            VideoSourceKind::Off => {
                "video source off — set PHONECONTROL_VIDEO_SOURCE=testpattern to enable synthetic H264"
                    .into()
            }
            _ => {
                "no video backend — set PHONECONTROL_VIDEO_SOURCE=testpattern or install scrcpy"
                    .into()
            }
        }
    }

    pub async fn ensure_session(&self, serial: &str) -> SessionStatus {
        let mut guard = self.sessions.write().await;
        if let Some(live) = guard.get(serial) {
            return live.info.clone();
        }
        let backend = self.backend_label();
        let note = if backend == "testpattern" {
            "session registered — call start (or open video WS) for synthetic H264".into()
        } else if self.scrcpy_path.is_some() {
            "session registered — call start to launch headless scrcpy".into()
        } else {
            self.stub_note()
        };
        let info = SessionStatus {
            serial: serial.to_string(),
            stream: StreamState::Idle,
            note,
            backend: backend.into(),
        };
        guard.insert(
            serial.to_string(),
            LiveSession {
                info: info.clone(),
                child: None,
                video: None,
            },
        );
        info
    }

    pub async fn get_session(&self, serial: &str) -> Option<SessionStatus> {
        self.sessions
            .read()
            .await
            .get(serial)
            .map(|s| s.info.clone())
    }

    pub async fn list_sessions(&self) -> Vec<SessionStatus> {
        self.sessions
            .read()
            .await
            .values()
            .map(|s| s.info.clone())
            .collect()
    }

    /// Ensure a local H264 pump is running for `serial` (used by video WS subscribe).
    /// Does not tear down an already-streaming session.
    pub async fn ensure_streaming(&self, serial: &str) -> SessionStatus {
        let _ = self.ensure_session(serial).await;
        if let Some(s) = self.get_session(serial).await {
            if s.stream == StreamState::Streaming || s.stream == StreamState::Starting {
                return s;
            }
        }
        self.start(serial).await
    }

    pub async fn video_status_frame(&self, serial: &str) -> VideoStatusFrame {
        let session = self
            .get_session(serial)
            .await
            .unwrap_or_else(|| SessionStatus {
                serial: serial.into(),
                stream: StreamState::Idle,
                note: self.stub_note(),
                backend: self.backend_label().into(),
            });
        self.enrich_video_status(&session).await
    }

    async fn enrich_video_status(&self, session: &SessionStatus) -> VideoStatusFrame {
        let guard = self.sessions.read().await;
        if let Some(live) = guard.get(&session.serial) {
            if let Some(ref pump) = live.video {
                return h264_status_for_session(
                    &session.serial,
                    session.stream,
                    session.note.clone(),
                    &pump.backend,
                    Some(pump.width),
                    Some(pump.height),
                    Some(&pump.codec_string),
                );
            }
        }
        if session.backend == "testpattern" && session.stream == StreamState::Streaming {
            return VideoStatusFrame::from_session(session).with_h264(
                TESTPATTERN_WIDTH,
                TESTPATTERN_HEIGHT,
                TESTPATTERN_CODEC_STRING,
            );
        }
        VideoStatusFrame::from_session(session)
    }

    /// Start video for `serial`: testpattern pump and/or headless scrcpy.
    pub async fn start(&self, serial: &str) -> SessionStatus {
        let _ = self.ensure_session(serial).await;

        // Already streaming with a pump / child — idempotent.
        {
            let guard = self.sessions.read().await;
            if let Some(live) = guard.get(serial) {
                if live.info.stream == StreamState::Streaming
                    && (live.video.is_some() || live.child.is_some())
                {
                    return live.info.clone();
                }
            }
        }

        self.stop_producers(serial).await;

        let use_pattern =
            should_use_testpattern(self.video_source, self.scrcpy_path.is_some());

        if use_pattern {
            return self.start_testpattern(serial).await;
        }

        if self.video_source == VideoSourceKind::Off {
            return self
                .set_status(serial, StreamState::Idle, self.stub_note())
                .await;
        }

        let Some(scrcpy) = self.scrcpy_path.clone() else {
            // auto/scrcpy requested but binary missing — honest idle, unless caller
            // forced testpattern (handled above).
            return self
                .set_status(serial, StreamState::Idle, self.stub_note())
                .await;
        };

        self.set_status(
            serial,
            StreamState::Starting,
            format!("starting headless scrcpy ({})", scrcpy.display()),
        )
        .await;

        let mut cmd = Command::new(&scrcpy);
        cmd.args([
            "-s",
            serial,
            "--no-playback",
            "--no-window",
            "--no-audio",
            "--no-clipboard-autosync",
        ]);
        if let Ok(extra) = std::env::var("SCRCPY_EXTRA_ARGS") {
            for arg in extra.split_whitespace() {
                cmd.arg(arg);
            }
        }
        cmd.stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        match cmd.spawn() {
            Ok(child) => {
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                let mut guard = self.sessions.write().await;
                let live = guard.entry(serial.to_string()).or_insert_with(|| LiveSession {
                    info: SessionStatus {
                        serial: serial.to_string(),
                        stream: StreamState::Starting,
                        note: String::new(),
                        backend: "scrcpy".into(),
                    },
                    child: None,
                    video: None,
                });
                live.child = Some(child);
                let exited = if let Some(ref mut c) = live.child {
                    match c.try_wait() {
                        Ok(Some(status)) => Some(status),
                        _ => None,
                    }
                } else {
                    None
                };
                if let Some(status) = exited {
                    live.child = None;
                    live.info.stream = StreamState::Error;
                    live.info.note = format!(
                        "scrcpy exited immediately ({status}) — check device auth / scrcpy version"
                    );
                    live.info.backend = "scrcpy".into();
                    warn!(serial, %status, "scrcpy exited on start");
                    let info = live.info.clone();
                    drop(guard);
                    self.publish_video_status(&info).await;
                    return info;
                }
                live.info.stream = StreamState::Streaming;
                live.info.note =
                    "scrcpy process running (headless); raw H264 socket→WS pump not wired — use PHONECONTROL_VIDEO_SOURCE=testpattern for synthetic frames"
                        .into();
                live.info.backend = "scrcpy".into();
                info!(serial, "scrcpy session streaming (process up, frames not forwarded)");
                let info = live.info.clone();
                drop(guard);
                self.publish_video_status(&info).await;
                info
            }
            Err(e) => {
                warn!(serial, error = %e, "failed to spawn scrcpy");
                self.set_status(
                    serial,
                    StreamState::Error,
                    format!("failed to spawn scrcpy: {e}"),
                )
                .await
            }
        }
    }

    async fn start_testpattern(&self, serial: &str) -> SessionStatus {
        self.set_status(
            serial,
            StreamState::Starting,
            "starting synthetic H264 test pattern".into(),
        )
        .await;

        match start_testpattern_pump(self.video_hub.clone(), serial.to_string()).await {
            Ok(pump) => {
                let note = if pump.is_live_ffmpeg() {
                    "synthetic H264 via live ffmpeg testsrc → WS annex-B"
                } else {
                    "synthetic H264 via embedded fixture loop → WS annex-B"
                };
                let mut guard = self.sessions.write().await;
                let live = guard.entry(serial.to_string()).or_insert_with(|| LiveSession {
                    info: SessionStatus {
                        serial: serial.to_string(),
                        stream: StreamState::Idle,
                        note: String::new(),
                        backend: "testpattern".into(),
                    },
                    child: None,
                    video: None,
                });
                live.video = Some(pump);
                live.info.stream = StreamState::Streaming;
                live.info.note = note.into();
                live.info.backend = "testpattern".into();
                info!(serial, "testpattern session streaming");
                let info = live.info.clone();
                drop(guard);
                self.publish_video_status(&info).await;
                info
            }
            Err(e) => {
                warn!(serial, error = %e, "testpattern start failed");
                self.set_status(
                    serial,
                    StreamState::Error,
                    format!("testpattern failed: {e}"),
                )
                .await
            }
        }
    }

    pub async fn stop(&self, serial: &str) -> SessionStatus {
        self.stop_producers(serial).await;
        let note = if should_use_testpattern(self.video_source, self.scrcpy_path.is_some()) {
            "session stopped (testpattern idle)".into()
        } else if self.scrcpy_path.is_some() {
            "session stopped".into()
        } else {
            self.stub_note()
        };
        self.set_status(serial, StreamState::Idle, note).await
    }

    pub async fn restart(&self, serial: &str) -> SessionStatus {
        let _ = self.stop(serial).await;
        self.start(serial).await
    }

    async fn stop_producers(&self, serial: &str) {
        let (child, video) = {
            let mut guard = self.sessions.write().await;
            if let Some(live) = guard.get_mut(serial) {
                (live.child.take(), live.video.take())
            } else {
                (None, None)
            }
        };
        if let Some(mut child) = child {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        if let Some(video) = video {
            video.stop().await;
        }
    }

    async fn set_status(&self, serial: &str, stream: StreamState, note: String) -> SessionStatus {
        let mut guard = self.sessions.write().await;
        let backend: String = self.backend_label().into();
        let entry = guard.entry(serial.to_string()).or_insert_with(|| LiveSession {
            info: SessionStatus {
                serial: serial.to_string(),
                stream: StreamState::Idle,
                note: String::new(),
                backend: backend.clone(),
            },
            child: None,
            video: None,
        });
        entry.info.stream = stream;
        entry.info.note = note;
        // Keep backend truthful for an active pump.
        if entry.video.is_none() {
            entry.info.backend = backend;
        }
        let info = entry.info.clone();
        drop(guard);
        self.publish_video_status(&info).await;
        info
    }

    async fn publish_video_status(&self, session: &SessionStatus) {
        let frame = self.enrich_video_status(session).await;
        self.video_hub
            .publish_status(&session.serial, frame)
            .await;
    }

    /// Inject a mapped tap. Real path: `adb -s SERIAL shell input tap X Y`.
    pub async fn inject_tap(&self, serial: &str, tap: &MappedTap) -> InjectResult {
        let _ = self.ensure_session(serial).await;

        let Some(adb) = self.adb_path.clone() else {
            info!(
                serial,
                device_id = %tap.device_id,
                x = tap.x,
                y = tap.y,
                "[stub-inject] tap (no ADB — not sent to device)"
            );
            return InjectResult {
                status: InjectStatus::Stub,
                detail: Some("no ADB — mock fleet stub inject".into()),
            };
        };

        let args = adb_tap_args(serial, tap.x, tap.y);
        match run_adb(&adb, &args).await {
            Ok(()) => {
                info!(serial, x = tap.x, y = tap.y, "[adb-inject] tap ok");
                InjectResult {
                    status: InjectStatus::Ok,
                    detail: None,
                }
            }
            Err(e) => {
                warn!(serial, error = %e, "[adb-inject] tap failed");
                InjectResult {
                    status: InjectStatus::Error,
                    detail: Some(e),
                }
            }
        }
    }

    /// Inject nav via `adb shell input keyevent`.
    pub async fn inject_nav(&self, serial: &str, action: NavActionType) -> InjectResult {
        let _ = self.ensure_session(serial).await;
        let keycode = nav_keycode(action);

        let Some(adb) = self.adb_path.clone() else {
            info!(
                serial,
                ?action,
                keycode,
                "[stub-inject] nav (no ADB — not sent to device)"
            );
            return InjectResult {
                status: InjectStatus::Stub,
                detail: Some("no ADB — mock fleet stub inject".into()),
            };
        };

        let args = adb_keyevent_args(serial, keycode);
        match run_adb(&adb, &args).await {
            Ok(()) => {
                info!(serial, ?action, keycode, "[adb-inject] nav ok");
                InjectResult {
                    status: InjectStatus::Ok,
                    detail: None,
                }
            }
            Err(e) => {
                warn!(serial, error = %e, "[adb-inject] nav failed");
                InjectResult {
                    status: InjectStatus::Error,
                    detail: Some(e),
                }
            }
        }
    }

    /// Reap exited scrcpy children and flip stream state to error/idle.
    pub async fn reap(&self) -> Vec<SessionStatus> {
        let mut changed = Vec::new();
        let mut finished_video = Vec::new();
        {
            let mut guard = self.sessions.write().await;
            for live in guard.values_mut() {
                if let Some(ref mut child) = live.child {
                    match child.try_wait() {
                        Ok(Some(status)) => {
                            live.child = None;
                            live.info.stream = StreamState::Error;
                            live.info.note = format!("scrcpy process exited ({status})");
                            changed.push(live.info.clone());
                        }
                        Ok(None) => {}
                        Err(e) => {
                            live.child = None;
                            live.info.stream = StreamState::Error;
                            live.info.note = format!("scrcpy wait error: {e}");
                            changed.push(live.info.clone());
                        }
                    }
                }
                if let Some(ref pump) = live.video {
                    if pump.is_finished() {
                        finished_video.push(live.info.serial.clone());
                    }
                }
            }
            for serial in &finished_video {
                if let Some(live) = guard.get_mut(serial) {
                    if let Some(pump) = live.video.take() {
                        // Task already finished; drop without abort wait.
                        drop(pump);
                    }
                    if live.info.stream == StreamState::Streaming {
                        live.info.stream = StreamState::Error;
                        live.info.note = "video pump exited unexpectedly".into();
                        changed.push(live.info.clone());
                    }
                }
            }
        }
        for session in &changed {
            self.publish_video_status(session).await;
        }
        changed
    }
}

async fn run_adb(adb: &PathBuf, args: &[String]) -> Result<(), String> {
    let output = Command::new(adb)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("failed to spawn adb: {e}"))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        Err(format!(
            "adb {} failed ({}): {}{}",
            args.join(" "),
            output.status,
            stderr.trim(),
            if stdout.trim().is_empty() {
                String::new()
            } else {
                format!(" | {}", stdout.trim())
            }
        ))
    }
}

/// Resolve scrcpy binary: `SCRCPY_PATH`, then `which scrcpy`.
pub fn scrcpy_binary() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("SCRCPY_PATH") {
        let p = PathBuf::from(path);
        if p.is_file() {
            return Some(p);
        }
    }
    if let Ok(path) = std::env::var("SCRCPY_SERVER_PATH") {
        let p = PathBuf::from(path);
        if p.is_file() {
            if let Some(cli) = which("scrcpy") {
                return Some(cli);
            }
            return Some(p);
        }
    }
    which("scrcpy")
}

fn which(bin: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        for dir in std::env::split_paths(&paths) {
            let candidate = dir.join(bin);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        None
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use phonecontrol_protocol::InjectStatus;

    #[tokio::test]
    async fn stub_inject_without_adb() {
        let hub = VideoHub::new();
        let mgr = SessionManager::new(None, None, hub);
        let tap = MappedTap {
            device_id: "s24".into(),
            device_name: "S24".into(),
            x: 10,
            y: 20,
            width: 100,
            height: 200,
            inject: InjectStatus::Stub,
            inject_detail: None,
        };
        let r = mgr.inject_tap("R5CW90ABC1", &tap).await;
        assert_eq!(r.status, InjectStatus::Stub);
        let session = mgr.ensure_session("R5CW90ABC1").await;
        assert_eq!(session.stream, StreamState::Idle);
    }

    #[tokio::test]
    async fn start_testpattern_streams() {
        std::env::set_var("PHONECONTROL_VIDEO_SOURCE", "testpattern");
        let hub = VideoHub::new();
        let mgr = SessionManager::new(None, None, hub.clone());
        let session = mgr.start("SERIAL").await;
        assert_eq!(session.stream, StreamState::Streaming);
        assert_eq!(session.backend, "testpattern");
        let frame = mgr.video_status_frame("SERIAL").await;
        assert_eq!(frame.framing.as_deref(), Some("annexb"));
        assert_eq!(frame.width, Some(TESTPATTERN_WIDTH));
        // Wait briefly for at least one AU.
        let mut rx = hub.subscribe("SERIAL").await;
        let mut got_binary = false;
        for _ in 0..30 {
            match tokio::time::timeout(std::time::Duration::from_millis(200), rx.recv()).await {
                Ok(Ok(crate::video::VideoPacket::AnnexB(b))) if !b.is_empty() => {
                    got_binary = true;
                    break;
                }
                Ok(Ok(_)) => {}
                _ => break,
            }
        }
        assert!(got_binary, "expected annex-B packets from testpattern");
        let stopped = mgr.stop("SERIAL").await;
        assert_eq!(stopped.stream, StreamState::Idle);
        std::env::remove_var("PHONECONTROL_VIDEO_SOURCE");
    }

    #[tokio::test]
    async fn start_off_stays_idle() {
        std::env::set_var("PHONECONTROL_VIDEO_SOURCE", "off");
        let hub = VideoHub::new();
        let mgr = SessionManager::new(None, None, hub);
        let session = mgr.start("SERIAL").await;
        assert_eq!(session.stream, StreamState::Idle);
        assert!(session.backend == "stub" || session.note.contains("off"));
        std::env::remove_var("PHONECONTROL_VIDEO_SOURCE");
    }
}
