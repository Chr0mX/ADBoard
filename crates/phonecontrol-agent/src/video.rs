//! H264 video pump for `/ws/devices/{serial}/video`.
//!
//! Framing: text JSON = [`VideoStatusFrame`]; binary = one Annex-B access unit
//! (start-code delimited NALs; keyframes typically carry SPS/PPS + IDR).

use phonecontrol_protocol::{StreamState, VideoStatusFrame};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};
use tokio::sync::{broadcast, RwLock};
use tokio::task::JoinHandle;
use tracing::{debug, info, warn};

/// Embedded 2s Constrained Baseline loop (360×640 @ ~10fps) for CI / no-ffmpeg.
const FIXTURE_H264: &[u8] = include_bytes!("../fixtures/testpattern.h264");

pub const TESTPATTERN_WIDTH: u32 = 360;
pub const TESTPATTERN_HEIGHT: u32 = 640;
pub const TESTPATTERN_CODEC_STRING: &str = "avc1.42E01E";
pub const TESTPATTERN_FPS: u32 = 10;

const VIDEO_CHANNEL_CAP: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VideoSourceKind {
    /// Prefer test pattern when scrcpy missing / mock; else scrcpy process (no frame pump yet).
    Auto,
    TestPattern,
    Scrcpy,
    Off,
}

impl VideoSourceKind {
    pub fn from_env() -> Self {
        match std::env::var("PHONECONTROL_VIDEO_SOURCE")
            .unwrap_or_else(|_| "auto".into())
            .to_ascii_lowercase()
            .as_str()
        {
            "testpattern" | "test" | "pattern" | "fixture" => Self::TestPattern,
            "scrcpy" => Self::Scrcpy,
            "off" | "none" | "disabled" => Self::Off,
            _ => Self::Auto,
        }
    }
}

#[derive(Debug, Clone)]
pub enum VideoPacket {
    Status(VideoStatusFrame),
    /// One Annex-B access unit.
    AnnexB(Vec<u8>),
}

struct SerialChannel {
    tx: broadcast::Sender<VideoPacket>,
}

/// Fan-out hub: one producer per serial, many WS subscribers.
pub struct VideoHub {
    channels: RwLock<HashMap<String, SerialChannel>>,
}

impl VideoHub {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            channels: RwLock::new(HashMap::new()),
        })
    }

    async fn ensure_channel(&self, serial: &str) -> broadcast::Sender<VideoPacket> {
        let mut guard = self.channels.write().await;
        if let Some(ch) = guard.get(serial) {
            return ch.tx.clone();
        }
        let (tx, _) = broadcast::channel(VIDEO_CHANNEL_CAP);
        guard.insert(
            serial.to_string(),
            SerialChannel { tx: tx.clone() },
        );
        tx
    }

    pub async fn subscribe(&self, serial: &str) -> broadcast::Receiver<VideoPacket> {
        self.ensure_channel(serial).await.subscribe()
    }

    pub async fn publish(&self, serial: &str, packet: VideoPacket) {
        let tx = self.ensure_channel(serial).await;
        let _ = tx.send(packet);
    }

    pub async fn publish_status(&self, serial: &str, frame: VideoStatusFrame) {
        self.publish(serial, VideoPacket::Status(frame)).await;
    }

    pub async fn publish_annexb(&self, serial: &str, au: Vec<u8>) {
        if au.is_empty() {
            return;
        }
        self.publish(serial, VideoPacket::AnnexB(au)).await;
    }
}

/// Running local video producer for one serial.
pub struct VideoPump {
    pub backend: String,
    pub width: u32,
    pub height: u32,
    pub codec_string: String,
    handle: JoinHandle<()>,
    /// Live ffmpeg child when using testsrc; None for fixture loop.
    live_ffmpeg: bool,
    child: Option<Child>,
}

impl VideoPump {
    pub fn is_finished(&self) -> bool {
        self.handle.is_finished()
    }

    pub fn is_live_ffmpeg(&self) -> bool {
        self.live_ffmpeg
    }

    pub async fn stop(mut self) {
        self.handle.abort();
        if let Some(mut child) = self.child.take() {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
    }
}

/// Decide whether session start should attach a test-pattern H264 pump.
pub fn should_use_testpattern(kind: VideoSourceKind, scrcpy_available: bool) -> bool {
    match kind {
        VideoSourceKind::TestPattern => true,
        VideoSourceKind::Auto => !scrcpy_available,
        VideoSourceKind::Scrcpy | VideoSourceKind::Off => false,
    }
}

pub fn ffmpeg_binary() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("FFMPEG_PATH") {
        let p = PathBuf::from(path);
        if p.is_file() {
            return Some(p);
        }
    }
    which("ffmpeg")
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

/// Start a synthetic H264 pump (live ffmpeg testsrc, or embedded fixture loop).
pub async fn start_testpattern_pump(
    hub: Arc<VideoHub>,
    serial: String,
) -> Result<VideoPump, String> {
    let status = VideoStatusFrame {
        serial: serial.clone(),
        stream: StreamState::Streaming,
        note: "synthetic H264 test pattern".into(),
        backend: "testpattern".into(),
        codec: Some("h264".into()),
        codec_string: Some(TESTPATTERN_CODEC_STRING.into()),
        width: Some(TESTPATTERN_WIDTH),
        height: Some(TESTPATTERN_HEIGHT),
        framing: Some("annexb".into()),
    };
    hub.publish_status(&serial, status).await;

    if let Some(ffmpeg) = ffmpeg_binary() {
        match spawn_ffmpeg_testsrc(hub.clone(), serial.clone(), ffmpeg).await {
            Ok(pump) => {
                info!(%serial, "testpattern pump via live ffmpeg");
                return Ok(pump);
            }
            Err(e) => {
                warn!(%serial, error = %e, "ffmpeg testsrc failed — falling back to fixture");
            }
        }
    }

    let handle = tokio::spawn(fixture_loop(hub, serial.clone()));
    info!(%serial, "testpattern pump via embedded fixture");
    Ok(VideoPump {
        backend: "testpattern".into(),
        width: TESTPATTERN_WIDTH,
        height: TESTPATTERN_HEIGHT,
        codec_string: TESTPATTERN_CODEC_STRING.into(),
        handle,
        live_ffmpeg: false,
        child: None,
    })
}

async fn spawn_ffmpeg_testsrc(
    hub: Arc<VideoHub>,
    serial: String,
    ffmpeg: PathBuf,
) -> Result<VideoPump, String> {
    let mut cmd = Command::new(&ffmpeg);
    cmd.args([
        "-hide_banner",
        "-loglevel",
        "error",
        "-re",
        "-f",
        "lavfi",
        "-i",
        &format!(
            "testsrc=size={TESTPATTERN_WIDTH}x{TESTPATTERN_HEIGHT}:rate={TESTPATTERN_FPS},format=yuv420p"
        ),
        "-c:v",
        "libx264",
        "-profile:v",
        "baseline",
        "-level",
        "3.0",
        "-tune",
        "zerolatency",
        "-g",
        &TESTPATTERN_FPS.to_string(),
        "-keyint_min",
        &TESTPATTERN_FPS.to_string(),
        "-bf",
        "0",
        "-pix_fmt",
        "yuv420p",
        "-an",
        "-f",
        "h264",
        "pipe:1",
    ]);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("spawn ffmpeg: {e}"))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "ffmpeg stdout missing".to_string())?;

    let serial_pump = serial.clone();
    let handle = tokio::spawn(async move {
        let mut buf = vec![0u8; 64 * 1024];
        let mut pending = Vec::with_capacity(128 * 1024);
        loop {
            match stdout.read(&mut buf).await {
                Ok(0) => {
                    debug!(serial = %serial_pump, "ffmpeg stdout EOF");
                    break;
                }
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let aus = drain_access_units(&mut pending);
                    for au in aus {
                        hub.publish_annexb(&serial_pump, au).await;
                    }
                }
                Err(e) => {
                    warn!(serial = %serial_pump, error = %e, "ffmpeg stdout read error");
                    break;
                }
            }
        }
    });

    // Brief settle — if ffmpeg dies immediately, surface the error.
    tokio::time::sleep(Duration::from_millis(150)).await;
    if let Ok(Some(status)) = child.try_wait() {
        handle.abort();
        return Err(format!("ffmpeg exited immediately ({status})"));
    }

    Ok(VideoPump {
        backend: "testpattern".into(),
        width: TESTPATTERN_WIDTH,
        height: TESTPATTERN_HEIGHT,
        codec_string: TESTPATTERN_CODEC_STRING.into(),
        handle,
        live_ffmpeg: true,
        child: Some(child),
    })
}

async fn fixture_loop(hub: Arc<VideoHub>, serial: String) {
    let aus = split_annexb_access_units(FIXTURE_H264);
    if aus.is_empty() {
        warn!(%serial, "fixture contained no access units");
        return;
    }
    let frame_delay = Duration::from_millis(1000 / TESTPATTERN_FPS as u64);
    let mut idx = 0usize;
    loop {
        let au = aus[idx].clone();
        hub.publish_annexb(&serial, au).await;
        idx = (idx + 1) % aus.len();
        tokio::time::sleep(frame_delay).await;
    }
}

/// Split Annex-B bytelength into access units (non-VCL NALs attach to the following VCL).
pub fn split_annexb_access_units(data: &[u8]) -> Vec<Vec<u8>> {
    let nals = split_annexb_nals(data);
    let mut aus = Vec::new();
    let mut pending: Vec<u8> = Vec::new();
    for nal in nals {
        let nal_type = nal_unit_type(&nal);
        append_annexb_nal(&mut pending, &nal);
        // VCL: slice / IDR → close AU
        if matches!(nal_type, 1 | 5) {
            if !pending.is_empty() {
                aus.push(std::mem::take(&mut pending));
            }
        }
    }
    if !pending.is_empty() {
        // Trailing SPS/PPS without VCL — keep as config AU.
        aus.push(pending);
    }
    aus
}

fn drain_access_units(pending: &mut Vec<u8>) -> Vec<Vec<u8>> {
    // Keep a trailing incomplete NAL in `pending`.
    let starts = find_start_codes(pending);
    if starts.len() < 2 {
        return Vec::new();
    }
    // Last start code may begin an incomplete NAL — only consume up to the last full NAL.
    let complete_end = *starts.last().unwrap();
    if complete_end == 0 {
        return Vec::new();
    }
    let chunk: Vec<u8> = pending[..complete_end].to_vec();
    let rest = pending[complete_end..].to_vec();
    pending.clear();
    pending.extend_from_slice(&rest);
    split_annexb_access_units(&chunk)
}

/// Returns NAL payloads **without** start codes.
pub fn split_annexb_nals(data: &[u8]) -> Vec<Vec<u8>> {
    let starts = find_start_codes(data);
    let mut out = Vec::new();
    for (i, &start) in starts.iter().enumerate() {
        let sc_len = if start + 3 < data.len() && data[start..start + 4] == [0, 0, 0, 1] {
            4
        } else {
            3
        };
        let payload_start = start + sc_len;
        let payload_end = if i + 1 < starts.len() {
            starts[i + 1]
        } else {
            data.len()
        };
        if payload_start < payload_end {
            out.push(data[payload_start..payload_end].to_vec());
        }
    }
    out
}

fn find_start_codes(data: &[u8]) -> Vec<usize> {
    let mut starts = Vec::new();
    let mut i = 0;
    while i + 3 < data.len() {
        if data[i] == 0 && data[i + 1] == 0 {
            if data[i + 2] == 1 {
                starts.push(i);
                i += 3;
                continue;
            }
            if i + 3 < data.len() && data[i + 2] == 0 && data[i + 3] == 1 {
                starts.push(i);
                i += 4;
                continue;
            }
        }
        i += 1;
    }
    starts
}

fn nal_unit_type(nal: &[u8]) -> u8 {
    if nal.is_empty() {
        return 0;
    }
    nal[0] & 0x1f
}

fn append_annexb_nal(buf: &mut Vec<u8>, nal: &[u8]) {
    buf.extend_from_slice(&[0, 0, 0, 1]);
    buf.extend_from_slice(nal);
}

/// True when an Annex-B AU contains an IDR (keyframe) or SPS (treat as key for WebCodecs).
pub fn annexb_is_keyframe(au: &[u8]) -> bool {
    for nal in split_annexb_nals(au) {
        match nal_unit_type(&nal) {
            5 | 7 => return true, // IDR or SPS
            _ => {}
        }
    }
    false
}

pub fn h264_status_for_session(
    serial: &str,
    stream: StreamState,
    note: impl Into<String>,
    backend: &str,
    width: Option<u32>,
    height: Option<u32>,
    codec_string: Option<&str>,
) -> VideoStatusFrame {
    let mut frame = VideoStatusFrame {
        serial: serial.into(),
        stream,
        note: note.into(),
        backend: backend.into(),
        codec: None,
        codec_string: None,
        width: None,
        height: None,
        framing: None,
    };
    if backend == "testpattern" || (stream == StreamState::Streaming && codec_string.is_some()) {
        if let (Some(w), Some(h), Some(cs)) = (width, height, codec_string) {
            frame = frame.with_h264(w, h, cs);
        }
    }
    frame
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixture_splits_into_access_units() {
        let aus = split_annexb_access_units(FIXTURE_H264);
        assert!(
            aus.len() >= 5,
            "expected several AUs from fixture, got {}",
            aus.len()
        );
        // First AU should include SPS (type 7) and typically PPS + IDR.
        let first_types: Vec<u8> = split_annexb_nals(&aus[0])
            .iter()
            .map(|n| nal_unit_type(n))
            .collect();
        assert!(
            first_types.contains(&7),
            "first AU should contain SPS, got {first_types:?}"
        );
        assert!(annexb_is_keyframe(&aus[0]));
    }

    #[test]
    fn video_source_env_parsing() {
        // Direct unit of the match logic via constructing from known strings is enough
        // through from_env only when env is set — test the helper mapping instead.
        assert_eq!(VideoSourceKind::Auto, VideoSourceKind::Auto);
        assert!(should_use_testpattern(VideoSourceKind::TestPattern, true));
        assert!(should_use_testpattern(VideoSourceKind::Auto, false));
        assert!(!should_use_testpattern(VideoSourceKind::Auto, true));
        assert!(!should_use_testpattern(VideoSourceKind::Scrcpy, false));
        assert!(!should_use_testpattern(VideoSourceKind::Off, false));
    }

    #[tokio::test]
    async fn hub_fans_out_annexb() {
        let hub = VideoHub::new();
        let mut rx = hub.subscribe("SER").await;
        hub.publish_annexb("SER", vec![0, 0, 0, 1, 0x65, 0x00])
            .await;
        match rx.recv().await.unwrap() {
            VideoPacket::AnnexB(b) => assert_eq!(b[4], 0x65),
            other => panic!("unexpected {other:?}"),
        }
    }
}
