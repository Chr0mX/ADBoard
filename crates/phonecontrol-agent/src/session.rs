//! Scrcpy session manager + ADB input injection + local H264 video pumps.
//!
//! - When `PHONECONTROL_VIDEO_SOURCE=testpattern` (or `auto` without scrcpy-server+ADB):
//!   pump synthetic Annex-B H264 (`backend: testpattern`).
//! - When scrcpy-server + ADB are ready and source is `auto|scrcpy`: start standalone
//!   scrcpy-server with `raw_stream=true`, demux Annex-B AUs into the video hub
//!   (`backend: scrcpy`).
//! - Touch, swipe, typing, and keycodes: scrcpy control-socket messages.
//! - Nav keys: `adb shell input keyevent` when ADB is available; otherwise stub.

use crate::audio::AudioHub;
use crate::scrcpy_control::ControlSender;
use crate::scrcpy_video::{
    cleanup_forward, scrcpy_server_jar, scrcpy_video_ready, start_scrcpy_audio_capture,
    start_scrcpy_raw_capture, video_launch_for, AudioCapture, ServerLog,
};
use crate::video::{
    h264_status_for_session, should_use_testpattern, start_scrcpy_fixture_pump,
    start_testpattern_pump, VideoHub, VideoPump, VideoSourceKind, TESTPATTERN_CODEC_STRING,
    TESTPATTERN_HEIGHT, TESTPATTERN_WIDTH,
};
use phonecontrol_protocol::{
    adb_install_args, adb_keyevent_args, adb_tap_args, nav_keycode, AudioStatusFrame, InjectMode,
    InjectStatus, MappedTap, NavActionType, PointerPhase, PointerTool, ScrcpyAvailability,
    SessionStatus,
    StreamState, VideoStatusFrame,
};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use tokio::process::{Child, Command};
use tokio::sync::{broadcast, Mutex, RwLock};
use tracing::{debug, info, warn};

#[derive(Debug, Clone)]
pub struct InjectResult {
    pub status: InjectStatus,
    pub detail: Option<String>,
}

struct LiveSession {
    info: SessionStatus,
    /// scrcpy-server `adb shell` child (raw stream path).
    child: Option<Child>,
    video: Option<VideoPump>,
    /// Local TCP port used for `adb forward` (removed on stop).
    forward_port: Option<u16>,
    /// Recent scrcpy-server stdout/stderr, when a real server was started.
    server_log: Option<ServerLog>,
    /// Scrcpy control socket. Touch, clipboard, and display power are written here.
    control: Option<ControlSender>,
    /// Opus scrcpy-server, when audio forwarding is on.
    audio_child: Option<Child>,
    audio_port: Option<u16>,
}

/// Quality, audio, and screen-off choices for the next (or current) scrcpy session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScrcpyPrefs {
    pub quality: String,
    pub audio: bool,
    pub screen_off: bool,
}

impl Default for ScrcpyPrefs {
    fn default() -> Self {
        Self {
            quality: "balanced".into(),
            audio: false,
            screen_off: false,
        }
    }
}

pub struct OptionsApplied {
    pub restarted: Vec<String>,
    /// Serial + result for an immediate screen-power message (no stream restart).
    pub power: Vec<(String, Result<(), String>)>,
}

pub struct SessionManager {
    sessions: RwLock<HashMap<String, LiveSession>>,
    adb_path: Option<PathBuf>,
    scrcpy_path: Option<PathBuf>,
    scrcpy_server: Option<PathBuf>,
    inject_mode: InjectMode,
    video_hub: Arc<VideoHub>,
    audio_hub: Arc<AudioHub>,
    video_source: VideoSourceKind,
    prefs: RwLock<ScrcpyPrefs>,
    clipboard_tx: broadcast::Sender<(String, String)>,
    /// One audio start or stop at a time, so a reload cannot launch a second server.
    audio_gate: Mutex<()>,
}

impl SessionManager {
    pub fn new(
        adb_path: Option<PathBuf>,
        scrcpy_path: Option<PathBuf>,
        video_hub: Arc<VideoHub>,
    ) -> Arc<Self> {
        Self::new_with_source(
            adb_path,
            scrcpy_path,
            video_hub,
            VideoSourceKind::from_env(),
        )
    }

    pub fn new_with_source(
        adb_path: Option<PathBuf>,
        scrcpy_path: Option<PathBuf>,
        video_hub: Arc<VideoHub>,
        video_source: VideoSourceKind,
    ) -> Arc<Self> {
        let inject_mode = if adb_path.is_some() {
            InjectMode::Adb
        } else {
            InjectMode::Stub
        };
        let scrcpy_server = scrcpy_server_jar(scrcpy_path.as_deref());
        info!(
            ?video_source,
            scrcpy_bin = scrcpy_path.as_ref().map(|p| p.display().to_string()),
            scrcpy_server = scrcpy_server.as_ref().map(|p| p.display().to_string()),
            "video source configured"
        );
        let (clipboard_tx, _) = broadcast::channel(64);
        Arc::new(Self {
            sessions: RwLock::new(HashMap::new()),
            adb_path,
            scrcpy_path,
            scrcpy_server,
            inject_mode,
            video_hub,
            audio_hub: AudioHub::new(),
            video_source,
            prefs: RwLock::new(ScrcpyPrefs::default()),
            clipboard_tx,
            audio_gate: Mutex::new(()),
        })
    }

    pub fn video_hub(&self) -> Arc<VideoHub> {
        self.video_hub.clone()
    }

    pub fn audio_hub(&self) -> Arc<AudioHub> {
        self.audio_hub.clone()
    }

    pub fn subscribe_clipboard(&self) -> broadcast::Receiver<(String, String)> {
        self.clipboard_tx.subscribe()
    }

    pub async fn prefs(&self) -> ScrcpyPrefs {
        self.prefs.read().await.clone()
    }

    #[allow(dead_code)]
    pub fn video_source(&self) -> VideoSourceKind {
        self.video_source
    }

    pub fn inject_mode(&self) -> InjectMode {
        self.inject_mode
    }

    pub fn scrcpy_availability(&self) -> ScrcpyAvailability {
        if self.scrcpy_path.is_some() || self.scrcpy_server.is_some() {
            ScrcpyAvailability::Available
        } else {
            ScrcpyAvailability::Missing
        }
    }

    fn scrcpy_ready(&self) -> bool {
        scrcpy_video_ready(self.adb_path.as_deref(), self.scrcpy_server.as_deref())
    }

    pub fn backend_label(&self) -> &'static str {
        if should_use_testpattern(self.video_source, self.scrcpy_ready()) {
            "testpattern"
        } else if self.scrcpy_ready() || self.scrcpy_server.is_some() || self.scrcpy_path.is_some()
        {
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
            VideoSourceKind::Scrcpy => {
                "scrcpy video requested but ADB or scrcpy-server missing — set ADB_PATH + SCRCPY_SERVER_PATH (or install scrcpy)"
                    .into()
            }
            _ => {
                "no video backend — set PHONECONTROL_VIDEO_SOURCE=testpattern or install scrcpy-server + ADB"
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
        } else if self.scrcpy_ready() {
            "session registered — call start to launch scrcpy-server raw H264".into()
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
                forward_port: None,
                server_log: None,
                control: None,
                audio_child: None,
                audio_port: None,
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
                    Some(pump.display_width()),
                    Some(pump.display_height()),
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

    /// Start video for `serial`: testpattern pump and/or scrcpy-server raw stream.
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

        let use_pattern = should_use_testpattern(self.video_source, self.scrcpy_ready());

        if use_pattern {
            return self.start_testpattern(serial).await;
        }

        if self.video_source == VideoSourceKind::Off {
            return self
                .set_status(serial, StreamState::Idle, self.stub_note())
                .await;
        }

        // Forced scrcpy without hardware: optional fixture mock for CI.
        if !self.scrcpy_ready() {
            if env_truthy("PHONECONTROL_SCRCPY_FIXTURE") {
                return self.start_scrcpy_fixture(serial).await;
            }
            return self
                .set_status(serial, StreamState::Idle, self.stub_note())
                .await;
        }

        self.start_scrcpy(serial).await
    }

    async fn start_scrcpy(&self, serial: &str) -> SessionStatus {
        let adb = self.adb_path.clone().expect("scrcpy_ready checked adb");
        let server = self
            .scrcpy_server
            .clone()
            .expect("scrcpy_ready checked server");

        self.set_status(
            serial,
            StreamState::Starting,
            format!("starting scrcpy-server raw H264 ({})", server.display()),
        )
        .await;

        let prefs = self.prefs.read().await.clone();
        let launch = video_launch_for(&prefs.quality, prefs.screen_off);
        match start_scrcpy_raw_capture(
            self.video_hub.clone(),
            adb.clone(),
            server.clone(),
            self.scrcpy_path.clone(),
            serial.to_string(),
            launch,
        )
        .await
        {
            Ok(capture) => {
                let (pump, server_child, port, server_log, control) = capture.into_parts();
                let mut note = "scrcpy-server raw H264 + control socket for touch".to_string();
                if prefs.screen_off {
                    match control.set_display_power(false).await {
                        Ok(()) => note.push_str(" | screen off"),
                        Err(e) => note.push_str(&format!(" | screen off failed: {e}")),
                    }
                }
                self.watch_clipboard(serial, control.clone());
                // Publish the picture and the control socket before audio.
                // A failed audio server must not hold touch or the H264 pipe.
                let info = self
                    .install_live_scrcpy(
                        serial,
                        pump,
                        server_child,
                        port,
                        server_log,
                        control,
                        note,
                    )
                    .await;
                info!(serial, "scrcpy session streaming (real H264 pipe)");
                if prefs.audio {
                    let _ = self.start_audio_if_needed(serial).await;
                }
                self.get_session(serial).await.unwrap_or(info)
            }
            Err(e) => {
                warn!(serial, error = %e, "scrcpy raw capture failed");
                self.set_status(
                    serial,
                    StreamState::Error,
                    format!("scrcpy raw H264 failed: {e}"),
                )
                .await
            }
        }
    }

    async fn start_scrcpy_fixture(&self, serial: &str) -> SessionStatus {
        self.set_status(
            serial,
            StreamState::Starting,
            "starting scrcpy fixture mock (PHONECONTROL_SCRCPY_FIXTURE)".into(),
        )
        .await;
        let pump = start_scrcpy_fixture_pump(self.video_hub.clone(), serial.to_string()).await;
        let mut guard = self.sessions.write().await;
        let live = guard
            .entry(serial.to_string())
            .or_insert_with(|| LiveSession {
                info: SessionStatus {
                    serial: serial.to_string(),
                    stream: StreamState::Idle,
                    note: String::new(),
                    backend: "scrcpy".into(),
                },
                child: None,
                video: None,
                forward_port: None,
                server_log: None,
                control: None,
                audio_child: None,
                audio_port: None,
            });
        live.video = Some(pump);
        live.info.stream = StreamState::Streaming;
        live.info.note = "scrcpy fixture mock → WS annex-B (no USB device)".into();
        live.info.backend = "scrcpy".into();
        let info = live.info.clone();
        drop(guard);
        self.publish_video_status(&info).await;
        info
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
                let live = guard
                    .entry(serial.to_string())
                    .or_insert_with(|| LiveSession {
                        info: SessionStatus {
                            serial: serial.to_string(),
                            stream: StreamState::Idle,
                            note: String::new(),
                            backend: "testpattern".into(),
                        },
                        child: None,
                        video: None,
                        forward_port: None,
                        server_log: None,
                        control: None,
                        audio_child: None,
                        audio_port: None,
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
        let note = if should_use_testpattern(self.video_source, self.scrcpy_ready()) {
            "session stopped (testpattern idle)".into()
        } else if self.scrcpy_ready() || self.scrcpy_path.is_some() {
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
        let (child, video, forward_port, control, audio_child, audio_port) = {
            let mut guard = self.sessions.write().await;
            if let Some(live) = guard.get_mut(serial) {
                (
                    live.child.take(),
                    live.video.take(),
                    live.forward_port.take(),
                    live.control.take(),
                    live.audio_child.take(),
                    live.audio_port.take(),
                )
            } else {
                (None, None, None, None, None, None)
            }
        };
        drop(control);
        if let Some(video) = video {
            video.stop().await;
        }
        if let Some(mut child) = child {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        if let Some(mut child) = audio_child {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        if let Some(adb) = self.adb_path.as_ref() {
            if let Some(port) = forward_port {
                cleanup_forward(adb, serial, port).await;
            }
            if let Some(port) = audio_port {
                cleanup_forward(adb, serial, port).await;
            }
        }
    }

    fn watch_clipboard(&self, serial: &str, control: ControlSender) {
        let mut rx = control.clipboard_receiver();
        let tx = self.clipboard_tx.clone();
        let serial = serial.to_string();
        tokio::spawn(async move {
            rx.borrow_and_update();
            loop {
                if rx.changed().await.is_err() {
                    break;
                }
                let text = rx.borrow().1.clone();
                let _ = tx.send((serial.clone(), text));
            }
        });
    }

    pub fn parse_quality(quality: &str) -> Result<&'static str, String> {
        match quality {
            "low" => Ok("low"),
            "balanced" => Ok("balanced"),
            "high" => Ok("high"),
            "original" => Ok("original"),
            _ => Err("quality must be low, balanced, high, or original".into()),
        }
    }

    /// Store prefs. Quality restarts the video server. Audio starts or stops beside it.
    /// Screen power is a control message.
    pub async fn apply_options(
        &self,
        incoming: ScrcpyPrefs,
        serials: &[String],
    ) -> Result<OptionsApplied, String> {
        let quality = Self::parse_quality(&incoming.quality)?.to_string();
        let next = ScrcpyPrefs {
            quality,
            audio: incoming.audio,
            screen_off: incoming.screen_off,
        };
        let prev = self.prefs.read().await.clone();
        let quality_changed = prev.quality != next.quality;
        let audio_changed = prev.audio != next.audio;
        let screen_changed = prev.screen_off != next.screen_off;
        *self.prefs.write().await = next.clone();

        let mut restarted = Vec::new();
        let mut power = Vec::new();
        if quality_changed {
            for serial in serials {
                let streaming = self.get_session(serial).await.is_some_and(|s| {
                    matches!(s.stream, StreamState::Streaming | StreamState::Starting)
                });
                if streaming {
                    let _ = self.restart(serial).await;
                    restarted.push(serial.clone());
                }
            }
        } else {
            // Audio must not tear down the H264 server. A second capture is what
            // made the picture glitch, and a reload used to restart it again and
            // drop the Opus process. A dead audio child is started again here.
            for serial in serials {
                if next.audio {
                    let _ = self.start_audio_if_needed(serial).await;
                } else if audio_changed {
                    self.stop_audio_only(serial).await;
                }
            }
            if screen_changed {
                let on = !next.screen_off;
                for serial in serials {
                    power.push((serial.clone(), self.set_display_power(serial, on).await));
                }
            }
        }
        Ok(OptionsApplied { restarted, power })
    }

    /// Start Opus if the video session is up and no audio server is still running.
    async fn start_audio_if_needed(&self, serial: &str) -> Result<(), String> {
        let _gate = self.audio_gate.lock().await;
        if !self.prefs.read().await.audio {
            return Ok(());
        }
        let streaming = self.get_session(serial).await.is_some_and(|s| {
            matches!(s.stream, StreamState::Streaming | StreamState::Starting)
        });
        if !streaming {
            return Ok(());
        }
        let dead_port = {
            let mut guard = self.sessions.write().await;
            let Some(live) = guard.get_mut(serial) else {
                return Ok(());
            };
            if let Some(child) = live.audio_child.as_mut() {
                match child.try_wait() {
                    Ok(None) => return Ok(()),
                    Ok(Some(_)) | Err(_) => {
                        live.audio_child = None;
                        live.audio_port.take()
                    }
                }
            } else {
                None
            }
        };
        if let (Some(adb), Some(port)) = (self.adb_path.as_ref(), dead_port) {
            cleanup_forward(adb, serial, port).await;
        }
        let (Some(adb), Some(server)) = (self.adb_path.clone(), self.scrcpy_server.clone()) else {
            let note = "Audio forwarding needs scrcpy-server and ADB.";
            self.audio_hub
                .publish_status(opus_frame(serial, StreamState::Error, note))
                .await;
            return Err(note.into());
        };
        self.audio_hub
            .publish_status(opus_frame(
                serial,
                StreamState::Starting,
                "Starting the Opus stream.",
            ))
            .await;
        let audio = start_scrcpy_audio_capture(
            self.audio_hub.clone(),
            &adb,
            &server,
            self.scrcpy_path.as_deref(),
            serial,
        )
        .await;
        self.finish_audio(serial, audio).await;
        Ok(())
    }

    async fn stop_audio_only(&self, serial: &str) {
        let _gate = self.audio_gate.lock().await;
        let (child, port) = {
            let mut guard = self.sessions.write().await;
            let Some(live) = guard.get_mut(serial) else {
                return;
            };
            (live.audio_child.take(), live.audio_port.take())
        };
        if let Some(mut child) = child {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        if let (Some(adb), Some(port)) = (self.adb_path.as_ref(), port) {
            cleanup_forward(adb, serial, port).await;
        }
        self.audio_hub
            .publish_status(opus_frame(
                serial,
                StreamState::Idle,
                "Audio forwarding is off.",
            ))
            .await;
    }

    pub async fn reset_video(&self, serial: &str) -> Result<(), String> {
        let Some(sender) = self.control_sender(serial).await else {
            return Err("scrcpy control is not connected".into());
        };
        sender.reset_video().await
    }

    pub async fn set_display_power(&self, serial: &str, on: bool) -> Result<(), String> {
        let sender = {
            let guard = self.sessions.read().await;
            guard.get(serial).and_then(|live| live.control.clone())
        };
        let Some(sender) = sender else {
            return Err("scrcpy control is not connected".into());
        };
        sender.set_display_power(on).await
    }

    pub async fn set_clipboard(&self, serial: &str, text: &str, paste: bool) -> Result<(), String> {
        if text.len() > 256 * 1024 {
            return Err("clipboard text is too long".into());
        }
        let sender = {
            let guard = self.sessions.read().await;
            guard.get(serial).and_then(|live| live.control.clone())
        };
        let Some(sender) = sender else {
            return Err("scrcpy control is not connected".into());
        };
        sender.set_clipboard(text, paste).await
    }

    pub async fn inject_text(&self, serial: &str, text: &str) -> Result<(), String> {
        let sender = self.control_sender(serial).await;
        let Some(sender) = sender else {
            return Err("scrcpy control is not connected".into());
        };
        sender.inject_text(text).await
    }

    pub async fn inject_keycode(
        &self,
        serial: &str,
        action: u8,
        keycode: u32,
        repeat: u32,
        metastate: u32,
    ) -> Result<(), String> {
        let sender = self.control_sender(serial).await;
        let Some(sender) = sender else {
            return Err("scrcpy control is not connected".into());
        };
        sender
            .inject_keycode(action, keycode, repeat, metastate)
            .await
    }

    async fn control_sender(&self, serial: &str) -> Option<ControlSender> {
        let guard = self.sessions.read().await;
        guard.get(serial).and_then(|live| live.control.clone())
    }

    pub async fn pull_clipboard(&self, serial: &str) -> Result<String, String> {
        let sender = {
            let guard = self.sessions.read().await;
            guard.get(serial).and_then(|live| live.control.clone())
        };
        let Some(sender) = sender else {
            return Err("scrcpy control is not connected".into());
        };
        sender.pull_clipboard().await
    }

    pub async fn audio_status(&self, serial: &str) -> AudioStatusFrame {
        if let Some(frame) = self.audio_hub.last_status(serial).await {
            return frame;
        }
        let prefs = self.prefs.read().await.clone();
        if !prefs.audio {
            return opus_frame(serial, StreamState::Idle, "Audio forwarding is off.");
        }
        if self.scrcpy_ready() {
            opus_frame(serial, StreamState::Starting, "Starting the Opus stream.")
        } else {
            opus_frame(
                serial,
                StreamState::Error,
                "Audio forwarding needs scrcpy-server and ADB. This session has no device audio.",
            )
        }
    }

    async fn install_live_scrcpy(
        &self,
        serial: &str,
        pump: VideoPump,
        server_child: Child,
        port: u16,
        server_log: ServerLog,
        control: ControlSender,
        note: String,
    ) -> SessionStatus {
        let mut guard = self.sessions.write().await;
        let live = guard
            .entry(serial.to_string())
            .or_insert_with(|| LiveSession {
                info: SessionStatus {
                    serial: serial.to_string(),
                    stream: StreamState::Starting,
                    note: String::new(),
                    backend: "scrcpy".into(),
                },
                child: None,
                video: None,
                forward_port: None,
                server_log: None,
                control: None,
                audio_child: None,
                audio_port: None,
            });
        live.video = Some(pump);
        live.child = Some(server_child);
        live.forward_port = Some(port);
        live.server_log = Some(server_log);
        live.control = Some(control);
        live.info.stream = StreamState::Streaming;
        live.info.note = note;
        live.info.backend = "scrcpy".into();
        let info = live.info.clone();
        drop(guard);
        self.publish_video_status(&info).await;
        info
    }

    async fn finish_audio(&self, serial: &str, audio: Result<AudioCapture, String>) {
        match audio {
            Ok(audio) => {
                let mut orphan = None;
                let info = {
                    let mut guard = self.sessions.write().await;
                    if let Some(live) = guard.get_mut(serial) {
                        live.audio_child = Some(audio.child);
                        live.audio_port = Some(audio.local_port);
                        live.info.note.push_str(" | audio opus");
                        Some(live.info.clone())
                    } else {
                        orphan = Some(audio.child);
                        None
                    }
                };
                if let Some(mut child) = orphan {
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                }
                if let Some(info) = info {
                    self.publish_video_status(&info).await;
                }
            }
            Err(error) => {
                let shown = clip_note(&error);
                let info = {
                    let mut guard = self.sessions.write().await;
                    guard.get_mut(serial).map(|live| {
                        live.info.note.push_str(" | audio failed");
                        live.info.clone()
                    })
                };
                self.audio_hub
                    .publish_status(opus_frame(serial, StreamState::Error, shown))
                    .await;
                if let Some(info) = info {
                    self.publish_video_status(&info).await;
                }
            }
        }
    }

    async fn set_status(&self, serial: &str, stream: StreamState, note: String) -> SessionStatus {
        let mut guard = self.sessions.write().await;
        let backend: String = self.backend_label().into();
        let entry = guard
            .entry(serial.to_string())
            .or_insert_with(|| LiveSession {
                info: SessionStatus {
                    serial: serial.to_string(),
                    stream: StreamState::Idle,
                    note: String::new(),
                    backend: backend.clone(),
                },
                child: None,
                video: None,
                forward_port: None,
                server_log: None,
                control: None,
                audio_child: None,
                audio_port: None,
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
        self.video_hub.publish_status(&session.serial, frame).await;
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

    /// Encoded picture size from the live pump. Zero until an SPS or a known source size exists.
    pub async fn video_display_size(&self, serial: &str) -> Option<(u32, u32)> {
        let guard = self.sessions.read().await;
        let pump = guard.get(serial)?.video.as_ref()?;
        let width = pump.display_width();
        let height = pump.display_height();
        if width == 0 || height == 0 {
            None
        } else {
            Some((width, height))
        }
    }

    /// Map a 0–1 point into the encoded video size and send one scrcpy touch.
    pub async fn inject_normalized(
        &self,
        serial: &str,
        phase: PointerPhase,
        x: f64,
        y: f64,
    ) -> InjectResult {
        let Some((width, height)) = self.video_display_size(serial).await else {
            return InjectResult {
                status: InjectStatus::Error,
                detail: Some("video size unknown — wait for the picture".into()),
            };
        };
        let px = (x.clamp(0.0, 1.0) * f64::from(width.saturating_sub(1))).round() as u32;
        let py = (y.clamp(0.0, 1.0) * f64::from(height.saturating_sub(1))).round() as u32;
        self.inject_pointer(serial, phase, PointerTool::Finger, px, py, width, height)
            .await
    }

    /// Write one scrcpy touch message. `width`/`height` are the encoded video size.
    pub async fn inject_pointer(
        &self,
        serial: &str,
        phase: PointerPhase,
        tool: PointerTool,
        x: u32,
        y: u32,
        width: u32,
        height: u32,
    ) -> InjectResult {
        let sender = {
            let guard = self.sessions.read().await;
            guard.get(serial).and_then(|live| live.control.clone())
        };
        let Some(sender) = sender else {
            return InjectResult {
                status: InjectStatus::Error,
                detail: Some("scrcpy control is not connected".into()),
            };
        };
        match sender.touch(phase, tool, x, y, width, height).await {
            Ok(()) => {
                if matches!(
                    phase,
                    PointerPhase::Hover | PointerPhase::Leave | PointerPhase::Move
                ) {
                    debug!(serial, ?phase, ?tool, x, y, "[scrcpy-control] pointer");
                } else {
                    info!(serial, ?phase, ?tool, x, y, width, height, "[scrcpy-control] pointer");
                }
                InjectResult {
                    status: InjectStatus::Ok,
                    detail: Some("scrcpy".into()),
                }
            }
            Err(e) => {
                warn!(serial, error = %e, "[scrcpy-control] touch failed");
                InjectResult {
                    status: InjectStatus::Error,
                    detail: Some(e),
                }
            }
        }
    }

    /// `adb -s SERIAL install -r PATH`. Missing ADB is an error, not a fake success.
    pub async fn install_apk(&self, serial: &str, apk: &std::path::Path) -> InjectResult {
        let Some(adb) = self.adb_path.clone() else {
            info!(serial, "[adb-install] no ADB — apk not installed");
            return InjectResult {
                status: InjectStatus::Error,
                detail: Some("adb is not available — cannot install APK".into()),
            };
        };

        let args = adb_install_args(serial, &apk.to_string_lossy());
        info!(serial, path = %apk.display(), "[adb-install] adb install -r");
        match run_adb(&adb, &args).await {
            Ok(()) => {
                info!(serial, "[adb-install] ok");
                InjectResult {
                    status: InjectStatus::Ok,
                    detail: None,
                }
            }
            Err(e) => {
                warn!(serial, error = %e, "[adb-install] failed");
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
        let mut stale_forwards = Vec::new();
        let mut audio_failed: Vec<(String, String)> = Vec::new();
        {
            let mut guard = self.sessions.write().await;
            for live in guard.values_mut() {
                if let Some(ref mut child) = live.child {
                    match child.try_wait() {
                        Ok(Some(status)) => {
                            live.child = None;
                            if let Some(port) = live.forward_port.take() {
                                stale_forwards.push((live.info.serial.clone(), port));
                            }
                            live.info.stream = StreamState::Error;
                            live.info.note = session_failure_note(
                                &format!("scrcpy-server process exited ({status})"),
                                live.server_log.as_ref(),
                            );
                            changed.push(live.info.clone());
                        }
                        Ok(None) => {}
                        Err(e) => {
                            live.child = None;
                            if let Some(port) = live.forward_port.take() {
                                stale_forwards.push((live.info.serial.clone(), port));
                            }
                            live.info.stream = StreamState::Error;
                            live.info.note = format!("scrcpy-server wait error: {e}");
                            changed.push(live.info.clone());
                        }
                    }
                }
                if let Some(ref mut audio) = live.audio_child {
                    match audio.try_wait() {
                        Ok(None) => {}
                        Ok(Some(status)) => {
                            let serial = live.info.serial.clone();
                            live.audio_child = None;
                            if let Some(port) = live.audio_port.take() {
                                stale_forwards.push((serial.clone(), port));
                            }
                            audio_failed.push((serial, format!("Audio server exited ({status}).")));
                        }
                        Err(e) => {
                            let serial = live.info.serial.clone();
                            live.audio_child = None;
                            if let Some(port) = live.audio_port.take() {
                                stale_forwards.push((serial.clone(), port));
                            }
                            audio_failed.push((serial, format!("Audio server wait error: {e}")));
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
                        drop(pump);
                    }
                    if live.info.stream == StreamState::Streaming {
                        live.info.stream = StreamState::Error;
                        live.info.note = session_failure_note(
                            "video socket closed before H264 arrived",
                            live.server_log.as_ref(),
                        );
                        changed.push(live.info.clone());
                    }
                }
            }
        }
        if let Some(adb) = self.adb_path.as_ref() {
            for (serial, port) in stale_forwards {
                cleanup_forward(adb, &serial, port).await;
            }
        }
        for session in &changed {
            self.publish_video_status(session).await;
        }
        for (serial, note) in audio_failed {
            self.audio_hub
                .publish_status(opus_frame(&serial, StreamState::Error, note))
                .await;
        }
        changed
    }
}

fn opus_frame(serial: &str, stream: StreamState, note: impl Into<String>) -> AudioStatusFrame {
    AudioStatusFrame {
        serial: serial.into(),
        stream,
        note: note.into(),
        codec: "opus".into(),
        sample_rate: 48_000,
        channels: 2,
        framing: "opus-pts".into(),
        description: None,
    }
}

fn clip_note(message: &str) -> String {
    let line = message.lines().next().unwrap_or(message).trim();
    if line.len() <= 180 {
        line.to_string()
    } else {
        let mut out = line.chars().take(177).collect::<String>();
        out.push_str("...");
        out
    }
}

fn session_failure_note(base: &str, log: Option<&ServerLog>) -> String {
    match log.map(ServerLog::tail).filter(|t| !t.is_empty()) {
        Some(tail) => format!("{base} | {tail}"),
        None => base.to_string(),
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

/// Resolve scrcpy binary: `SCRCPY_PATH`, vendored tree, then `which scrcpy`.
pub fn scrcpy_binary() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("SCRCPY_PATH") {
        let p = PathBuf::from(path);
        if p.is_file() {
            return Some(p);
        }
    }
    if let Some(p) = crate::paths::vendored_scrcpy() {
        return Some(p);
    }
    if let Ok(path) = std::env::var("SCRCPY_SERVER_PATH") {
        let p = PathBuf::from(path);
        if p.is_file() {
            if let Some(cli) = which("scrcpy") {
                return Some(cli);
            }
            // Server-only installs still count as "scrcpy available" for health.
            return None;
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

fn env_truthy(key: &str) -> bool {
    matches!(
        std::env::var(key).as_deref(),
        Ok("1") | Ok("true") | Ok("TRUE") | Ok("yes") | Ok("YES")
    )
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
        let hub = VideoHub::new();
        let mgr =
            SessionManager::new_with_source(None, None, hub.clone(), VideoSourceKind::TestPattern);
        let session = mgr.start("SERIAL").await;
        assert_eq!(session.stream, StreamState::Streaming);
        assert_eq!(session.backend, "testpattern");
        let frame = mgr.video_status_frame("SERIAL").await;
        assert_eq!(frame.framing.as_deref(), Some("annexb"));
        assert_eq!(frame.width, Some(TESTPATTERN_WIDTH));
        // Wait briefly for at least one AU.
        let mut rx = hub.subscribe("SERIAL").await;
        let mut got_binary = false;
        for _ in 0..50 {
            match tokio::time::timeout(std::time::Duration::from_millis(200), rx.recv()).await {
                Ok(Ok(crate::video::VideoPacket::AnnexB(b))) if !b.is_empty() => {
                    got_binary = true;
                    break;
                }
                Ok(Ok(_)) => {}
                Ok(Err(_)) => break,
                Err(_) => {} // timeout — keep waiting
            }
        }
        assert!(got_binary, "expected annex-B packets from testpattern");
        let stopped = mgr.stop("SERIAL").await;
        assert_eq!(stopped.stream, StreamState::Idle);
    }

    #[tokio::test]
    async fn stopped_session_stays_idle_after_reap() {
        let hub = VideoHub::new();
        let mgr =
            SessionManager::new_with_source(None, None, hub, VideoSourceKind::TestPattern);
        let started = mgr.start("SERIAL").await;
        assert_eq!(started.stream, StreamState::Streaming);
        let stopped = mgr.stop("SERIAL").await;
        assert_eq!(stopped.stream, StreamState::Idle);
        let changed = mgr.reap().await;
        assert!(
            changed.iter().all(|session| session.serial != "SERIAL"),
            "a stopped session must not be reported as Error by reap"
        );
        let after = mgr.get_session("SERIAL").await.expect("session");
        assert_eq!(after.stream, StreamState::Idle);
    }

    #[tokio::test]
    async fn start_off_stays_idle() {
        let hub = VideoHub::new();
        let mgr = SessionManager::new_with_source(None, None, hub, VideoSourceKind::Off);
        let session = mgr.start("SERIAL").await;
        assert_eq!(session.stream, StreamState::Idle);
        assert!(session.backend == "stub" || session.note.contains("off"));
    }

    #[tokio::test]
    async fn scrcpy_fixture_mock_streams_as_scrcpy() {
        std::env::set_var("PHONECONTROL_SCRCPY_FIXTURE", "1");
        let hub = VideoHub::new();
        let mgr = SessionManager::new_with_source(None, None, hub.clone(), VideoSourceKind::Scrcpy);
        let session = mgr.start("SCRCPY-MOCK").await;
        assert_eq!(session.stream, StreamState::Streaming);
        assert_eq!(session.backend, "scrcpy");
        let frame = mgr.video_status_frame("SCRCPY-MOCK").await;
        assert_eq!(frame.backend, "scrcpy");
        assert_eq!(frame.framing.as_deref(), Some("annexb"));
        let mut rx = hub.subscribe("SCRCPY-MOCK").await;
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
        assert!(got_binary, "expected annex-B from scrcpy fixture path");
        let _ = mgr.stop("SCRCPY-MOCK").await;
        std::env::remove_var("PHONECONTROL_SCRCPY_FIXTURE");
    }

    #[tokio::test]
    async fn auto_without_scrcpy_uses_testpattern() {
        let hub = VideoHub::new();
        // No adb / no server → auto falls back to testpattern.
        let mgr = SessionManager::new_with_source(None, None, hub, VideoSourceKind::Auto);
        assert!(!mgr.scrcpy_ready());
        let session = mgr.start("AUTO").await;
        assert_eq!(session.backend, "testpattern");
        assert_eq!(session.stream, StreamState::Streaming);
        let _ = mgr.stop("AUTO").await;
    }
}
