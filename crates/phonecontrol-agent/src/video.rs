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
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{Child, Command};
use tokio::sync::{broadcast, RwLock};
use tokio::task::JoinHandle;
use tracing::{debug, info, warn};

/// Embedded 2s Constrained Baseline loop (360×640 @ ~10fps) for CI / no-ffmpeg.
pub const FIXTURE_H264: &[u8] = include_bytes!("../fixtures/testpattern.h264");

pub const TESTPATTERN_WIDTH: u32 = 360;
pub const TESTPATTERN_HEIGHT: u32 = 640;
pub const TESTPATTERN_CODEC_STRING: &str = "avc1.42E01E";
pub const TESTPATTERN_FPS: u32 = 10;
/// Placeholder until SPS / stream meta is known (WebCodecs sizes from decoded frames).
pub const SCRCPY_DEFAULT_CODEC_STRING: &str = "avc1.42E01E";

const VIDEO_CHANNEL_CAP: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VideoSourceKind {
    /// Prefer scrcpy raw H264 when ADB + scrcpy-server are ready; else testpattern.
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
    /// Live ffmpeg child when using testsrc; None for fixture / socket pumps.
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

    pub fn attach_child(&mut self, child: Child, live_ffmpeg: bool) {
        self.child = Some(child);
        self.live_ffmpeg = live_ffmpeg;
    }

    pub fn try_wait_child(&mut self) -> std::io::Result<Option<std::process::ExitStatus>> {
        if let Some(ref mut c) = self.child {
            c.try_wait()
        } else {
            Ok(None)
        }
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
///
/// `scrcpy_ready` means ADB + scrcpy-server jar are available for the raw-stream path.
pub fn should_use_testpattern(kind: VideoSourceKind, scrcpy_ready: bool) -> bool {
    match kind {
        VideoSourceKind::TestPattern => true,
        VideoSourceKind::Auto => !scrcpy_ready,
        VideoSourceKind::Scrcpy | VideoSourceKind::Off => false,
    }
}

/// Metadata published with an Annex-B reader pump.
#[derive(Debug, Clone)]
pub struct AnnexBPumpMeta {
    pub backend: String,
    pub note: String,
    pub width: u32,
    pub height: u32,
    pub codec_string: String,
}

impl AnnexBPumpMeta {
    pub fn scrcpy(width: u32, height: u32, codec_string: impl Into<String>) -> Self {
        Self {
            backend: "scrcpy".into(),
            note: "scrcpy-server raw H264 → WS annex-B".into(),
            width,
            height,
            codec_string: codec_string.into(),
        }
    }

    pub fn testpattern() -> Self {
        Self {
            backend: "testpattern".into(),
            note: "synthetic H264 test pattern".into(),
            width: TESTPATTERN_WIDTH,
            height: TESTPATTERN_HEIGHT,
            codec_string: TESTPATTERN_CODEC_STRING.into(),
        }
    }
}

/// Read a continuous Annex-B byte stream, split into access units, publish to the hub.
///
/// Used by ffmpeg testsrc, scrcpy-server TCP, and unit tests (Cursor / fixture readers).
pub async fn start_annexb_reader_pump<R>(
    hub: Arc<VideoHub>,
    serial: String,
    mut reader: R,
    meta: AnnexBPumpMeta,
) -> VideoPump
where
    R: AsyncRead + Unpin + Send + 'static,
{
    let status = VideoStatusFrame {
        serial: serial.clone(),
        stream: StreamState::Streaming,
        note: meta.note.clone(),
        backend: meta.backend.clone(),
        codec: Some("h264".into()),
        codec_string: Some(meta.codec_string.clone()),
        width: if meta.width > 0 {
            Some(meta.width)
        } else {
            None
        },
        height: if meta.height > 0 {
            Some(meta.height)
        } else {
            None
        },
        framing: Some("annexb".into()),
    };
    hub.publish_status(&serial, status).await;

    let backend = meta.backend.clone();
    let width = meta.width;
    let height = meta.height;
    let codec_string = meta.codec_string.clone();
    let serial_pump = serial.clone();
    let handle = tokio::spawn(async move {
        let mut buf = vec![0u8; 64 * 1024];
        let mut pending = Vec::with_capacity(128 * 1024);
        loop {
            match reader.read(&mut buf).await {
                Ok(0) => {
                    debug!(serial = %serial_pump, backend = %backend, "annex-B reader EOF");
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
                    warn!(serial = %serial_pump, error = %e, "annex-B reader error");
                    break;
                }
            }
        }
    });

    VideoPump {
        backend: meta.backend,
        width,
        height,
        codec_string,
        handle,
        live_ffmpeg: false,
        child: None,
    }
}

/// Pump the embedded fixture through the AU→hub path, labeled `backend: scrcpy`.
/// Used by integration tests when no USB device / scrcpy-server is present.
pub async fn start_scrcpy_fixture_pump(hub: Arc<VideoHub>, serial: String) -> VideoPump {
    let aus = split_annexb_access_units_complete(FIXTURE_H264);
    let codec = codec_string_from_sps_au(aus.first().map(|a| a.as_slice()).unwrap_or(&[]))
        .unwrap_or_else(|| SCRCPY_DEFAULT_CODEC_STRING.to_string());
    let meta = AnnexBPumpMeta {
        backend: "scrcpy".into(),
        note: "scrcpy fixture mock (no device) → WS annex-B".into(),
        width: TESTPATTERN_WIDTH,
        height: TESTPATTERN_HEIGHT,
        codec_string: codec.clone(),
    };
    let status = VideoStatusFrame {
        serial: serial.clone(),
        stream: StreamState::Streaming,
        note: meta.note.clone(),
        backend: meta.backend.clone(),
        codec: Some("h264".into()),
        codec_string: Some(meta.codec_string.clone()),
        width: Some(meta.width),
        height: Some(meta.height),
        framing: Some("annexb".into()),
    };
    hub.publish_status(&serial, status).await;

    let serial_pump = serial.clone();
    let handle = tokio::spawn(async move {
        if aus.is_empty() {
            return;
        }
        let frame_delay = Duration::from_millis(1000 / TESTPATTERN_FPS as u64);
        let mut idx = 0usize;
        loop {
            hub.publish_annexb(&serial_pump, aus[idx].clone()).await;
            idx = (idx + 1) % aus.len();
            tokio::time::sleep(frame_delay).await;
        }
    });

    VideoPump {
        backend: meta.backend,
        width: meta.width,
        height: meta.height,
        codec_string: codec,
        handle,
        live_ffmpeg: false,
        child: None,
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
        "-g",
        &TESTPATTERN_FPS.to_string(),
        "-keyint_min",
        &TESTPATTERN_FPS.to_string(),
        "-sc_threshold",
        "0",
        "-bf",
        "0",
        "-pix_fmt",
        "yuv420p",
        // Single-slice IDRs + repeated SPS/PPS — required for clean WebCodecs AUs.
        "-x264-params",
        "repeat-headers=1:intra-refresh=0:slices=1",
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
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "ffmpeg stdout missing".to_string())?;

    let meta = AnnexBPumpMeta::testpattern();
    let mut pump = start_annexb_reader_pump(hub, serial.clone(), stdout, meta).await;
    pump.attach_child(child, true);

    // Brief settle — if ffmpeg dies immediately, surface the error.
    tokio::time::sleep(Duration::from_millis(150)).await;
    if let Ok(Some(status)) = pump.try_wait_child() {
        pump.stop().await;
        return Err(format!("ffmpeg exited immediately ({status})"));
    }

    Ok(pump)
}

async fn fixture_loop(hub: Arc<VideoHub>, serial: String) {
    let aus = split_annexb_access_units_complete(FIXTURE_H264);
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

/// Derive `avc1.PPCCLL` from the first SPS NAL in an Annex-B AU.
pub fn codec_string_from_sps_au(au: &[u8]) -> Option<String> {
    for nal in split_annexb_nals(au) {
        if nal_unit_type(&nal) == 7 && nal.len() >= 4 {
            return Some(format!(
                "avc1.{:02X}{:02X}{:02X}",
                nal[1], nal[2], nal[3]
            ));
        }
    }
    None
}

/// Split Annex-B into access units (one primary coded picture each).
/// Non-VCL NALs attach to the following VCL. Multi-slice pictures stay together
/// (new picture starts when `first_mb_in_slice == 0`).
/// Trailing non-VCL without a VCL is returned as `leftover` (not emitted).
pub fn split_annexb_access_units(data: &[u8]) -> (Vec<Vec<u8>>, Vec<u8>) {
    let nals = split_annexb_nals(data);
    let mut aus = Vec::new();
    let mut pending: Vec<u8> = Vec::new();
    let mut pending_has_vcl = false;

    for nal in nals {
        let nal_type = nal_unit_type(&nal);
        let is_vcl = matches!(nal_type, 1 | 5);

        if is_vcl {
            let first_mb = slice_first_mb_in_slice(&nal).unwrap_or(0);
            // Start of a new primary picture → close previous AU.
            if first_mb == 0 && pending_has_vcl {
                aus.push(std::mem::take(&mut pending));
            }
            append_annexb_nal(&mut pending, &nal);
            pending_has_vcl = true;
        } else if pending_has_vcl && matches!(nal_type, 7 | 8 | 9) {
            // AUD / SPS / PPS ahead of the next picture → close current AU first.
            aus.push(std::mem::take(&mut pending));
            pending_has_vcl = false;
            append_annexb_nal(&mut pending, &nal);
        } else {
            append_annexb_nal(&mut pending, &nal);
        }
    }

    if pending_has_vcl {
        aus.push(std::mem::take(&mut pending));
        (aus, Vec::new())
    } else {
        (aus, pending)
    }
}

/// Like [`split_annexb_access_units`] but drops trailing non-VCL (for complete buffers / fixtures).
pub fn split_annexb_access_units_complete(data: &[u8]) -> Vec<Vec<u8>> {
    let (aus, _leftover) = split_annexb_access_units(data);
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
    let (aus, leftover) = split_annexb_access_units(&chunk);
    // Hold SPS/PPS until a VCL arrives in a later read.
    if !leftover.is_empty() {
        let mut merged = leftover;
        merged.extend_from_slice(pending);
        pending.clear();
        pending.extend_from_slice(&merged);
    }
    aus
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

/// Parse `first_mb_in_slice` (ue(v)) from a VCL NAL payload (including header byte).
fn slice_first_mb_in_slice(nal: &[u8]) -> Option<u32> {
    if nal.len() < 2 {
        return None;
    }
    // Skip NAL header; slice_header begins immediately for non-SVC/MVC.
    exp_golomb_ue(&nal[1..])
}

fn exp_golomb_ue(bytes: &[u8]) -> Option<u32> {
    let mut bit_pos = 0usize;
    let total_bits = bytes.len() * 8;
    // leading zeros
    let mut zeros = 0usize;
    while bit_pos < total_bits {
        let byte = bytes[bit_pos / 8];
        let bit = (byte >> (7 - (bit_pos % 8))) & 1;
        bit_pos += 1;
        if bit == 0 {
            zeros += 1;
            if zeros > 31 {
                return None;
            }
        } else {
            break;
        }
    }
    let mut value = 1u32;
    for _ in 0..zeros {
        if bit_pos >= total_bits {
            return None;
        }
        let byte = bytes[bit_pos / 8];
        let bit = u32::from((byte >> (7 - (bit_pos % 8))) & 1);
        bit_pos += 1;
        value = (value << 1) | bit;
    }
    Some(value.saturating_sub(1))
}

fn append_annexb_nal(buf: &mut Vec<u8>, nal: &[u8]) {
    buf.extend_from_slice(&[0, 0, 0, 1]);
    buf.extend_from_slice(nal);
}

/// True when an Annex-B AU contains an IDR (keyframe).
pub fn annexb_is_keyframe(au: &[u8]) -> bool {
    for nal in split_annexb_nals(au) {
        if nal_unit_type(&nal) == 5 {
            return true;
        }
    }
    false
}

/// True when AU contains at least one VCL NAL (slice / IDR).
pub fn annexb_has_vcl(au: &[u8]) -> bool {
    for nal in split_annexb_nals(au) {
        if matches!(nal_unit_type(&nal), 1 | 5) {
            return true;
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
    let pumping = backend == "testpattern"
        || backend == "scrcpy"
        || (stream == StreamState::Streaming && codec_string.is_some());
    if pumping {
        frame.codec = Some("h264".into());
        frame.framing = Some("annexb".into());
        if let Some(cs) = codec_string {
            frame.codec_string = Some(cs.into());
        }
        frame.width = width.filter(|w| *w > 0);
        frame.height = height.filter(|h| *h > 0);
    }
    frame
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixture_splits_into_access_units() {
        let aus = split_annexb_access_units_complete(FIXTURE_H264);
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
        assert!(annexb_has_vcl(&aus[0]));
        assert!(annexb_is_keyframe(&aus[0]));
        // No config-only AUs.
        for (i, au) in aus.iter().enumerate() {
            assert!(
                annexb_has_vcl(au),
                "AU {i} missing VCL NAL"
            );
        }
    }

    #[test]
    fn drain_emits_idrs_from_chunked_reads() {
        // Simulate ffmpeg pipe reads of a real annex-B stream (fixture has IDRs).
        let data = FIXTURE_H264;
        let mut pending = Vec::new();
        let mut all_aus = Vec::new();
        // Chunk in irregular sizes like a pipe.
        let mut off = 0;
        let mut chunk_sz = 137usize;
        while off < data.len() {
            let end = (off + chunk_sz).min(data.len());
            pending.extend_from_slice(&data[off..end]);
            all_aus.extend(drain_access_units(&mut pending));
            off = end;
            chunk_sz = 64 + (chunk_sz * 3) % 900;
        }
        // Flush: append a dummy start code so the final NAL can close.
        pending.extend_from_slice(&[0, 0, 0, 1, 0x01, 0x00]);
        all_aus.extend(drain_access_units(&mut pending));

        let idr_count = all_aus.iter().filter(|au| annexb_is_keyframe(au)).count();
        let sps_count = all_aus
            .iter()
            .filter(|au| split_annexb_nals(au).iter().any(|n| nal_unit_type(n) == 7))
            .count();
        assert!(
            idr_count >= 2,
            "expected IDR AUs from chunked drain, got {idr_count} (total AUs {})",
            all_aus.len()
        );
        assert!(
            sps_count >= 1,
            "expected SPS on some AUs, got {sps_count}"
        );
    }

    #[test]
    fn holds_trailing_sps_without_emitting() {
        let sps = [0u8, 0, 0, 1, 0x67, 0x42, 0x00, 0x1e, 0xff];
        let (aus, leftover) = split_annexb_access_units(&sps);
        assert!(aus.is_empty());
        assert!(!leftover.is_empty());
    }

    #[test]
    fn groups_multislice_picture_into_one_au() {
        // first_mb=0 → ue "1" → byte 0x80
        let slice0 = vec![0x65, 0x80];
        // first_mb=10 → ue encoding 0001011 → 0x16
        let slice1 = vec![0x65, 0x16];
        let mut buf = Vec::new();
        append_annexb_nal(&mut buf, &slice0);
        append_annexb_nal(&mut buf, &slice1);
        let (aus, leftover) = split_annexb_access_units(&buf);
        assert!(leftover.is_empty());
        assert_eq!(aus.len(), 1, "multi-slice picture should be one AU");
        let types: Vec<_> = split_annexb_nals(&aus[0])
            .iter()
            .map(|n| nal_unit_type(n))
            .collect();
        assert_eq!(types, vec![5, 5]);
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

    #[tokio::test]
    async fn annexb_reader_pump_feeds_hub() {
        let hub = VideoHub::new();
        let aus = split_annexb_access_units_complete(FIXTURE_H264);
        let mut bytes = Vec::new();
        for au in aus.iter().take(3) {
            bytes.extend_from_slice(au);
        }
        let mut rx = hub.subscribe("PIPE").await;
        let pump = start_annexb_reader_pump(
            hub,
            "PIPE".into(),
            std::io::Cursor::new(bytes),
            AnnexBPumpMeta::scrcpy(360, 640, "avc1.42E01E"),
        )
        .await;
        let mut got = 0usize;
        for _ in 0..20 {
            match tokio::time::timeout(Duration::from_millis(100), rx.recv()).await {
                Ok(Ok(VideoPacket::AnnexB(b))) if !b.is_empty() => got += 1,
                Ok(Ok(VideoPacket::Status(s))) => {
                    assert_eq!(s.backend, "scrcpy");
                    assert_eq!(s.framing.as_deref(), Some("annexb"));
                }
                _ => break,
            }
        }
        assert!(got >= 1, "expected annex-B AUs from mocked reader");
        pump.stop().await;
    }

    #[tokio::test]
    async fn scrcpy_fixture_pump_backend() {
        let hub = VideoHub::new();
        let mut rx = hub.subscribe("MOCK-SCRCPY").await;
        let pump = start_scrcpy_fixture_pump(hub, "MOCK-SCRCPY".into()).await;
        assert_eq!(pump.backend, "scrcpy");
        let mut got_binary = false;
        for _ in 0..20 {
            match tokio::time::timeout(Duration::from_millis(200), rx.recv()).await {
                Ok(Ok(VideoPacket::AnnexB(b))) if annexb_has_vcl(&b) => {
                    got_binary = true;
                    break;
                }
                Ok(Ok(_)) => {}
                _ => break,
            }
        }
        assert!(got_binary);
        pump.stop().await;
    }

    #[test]
    fn codec_string_from_fixture_sps() {
        let aus = split_annexb_access_units_complete(FIXTURE_H264);
        let cs = codec_string_from_sps_au(&aus[0]).expect("SPS in first AU");
        assert!(cs.starts_with("avc1."), "{cs}");
    }
}
