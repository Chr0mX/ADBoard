//! Scrcpy-server raw H264 capture → Annex-B access units → [`VideoHub`].
//!
//! Current scrcpy **client** no longer records/pipes raw H264 (`--record-format=h264`
//! was removed). The supported headless path is the **standalone server** with
//! `raw_stream=true` (see Genymobile/scrcpy `doc/develop.md`):
//!
//! ```text
//! adb -s SERIAL push scrcpy-server /data/local/tmp/phonecontrol-scrcpy-server.jar
//! adb -s SERIAL forward tcp:PORT localabstract:NAME
//! adb -s SERIAL shell CLASSPATH=... app_process / com.genymobile.scrcpy.Server VER \
//!     tunnel_forward=true audio=false control=true cleanup=false \
//!     raw_stream=true video_codec=h264 max_size=1280
//! # TCP connect video, then control. Dummy byte is on the video socket.
//! # Bytes after that byte are Annex-B H264. The control socket takes
//! # scrcpy INJECT_TOUCH_EVENT messages.
//! ```
//!
//! `raw_stream=true` forces device/frame/stream metadata off. `send_dummy_byte`
//! is turned back on afterwards: `adb forward` accepts TCP before the device
//! socket is listening, so the first byte is the only way to know the server
//! is actually there. Everything after that byte is Annex-B H264.

use crate::audio::{spawn_opus_pump, AudioHub};
use crate::scrcpy_control::{open_video_and_control, ControlSender};
use crate::video::{
    start_annexb_reader_pump, AnnexBPumpMeta, VideoHub, VideoPump, SCRCPY_DEFAULT_CODEC_STRING,
};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, BufReader};
use tokio::net::TcpStream;
use tokio::process::{Child, Command};
use tracing::{info, warn};

const REMOTE_SERVER_PATH: &str = "/data/local/tmp/phonecontrol-scrcpy-server.jar";
const DEFAULT_MAX_SIZE: u32 = 1280;

/// Video-server launch. Audio stays off here so the Annex-B parser is unchanged.
/// Opus is a second server; see [`start_scrcpy_audio_capture`].
#[derive(Debug, Clone)]
pub struct VideoLaunch {
    pub max_size: u32,
    pub video_bit_rate: Option<u32>,
    pub max_fps: Option<u32>,
    pub stay_awake: bool,
}

impl Default for VideoLaunch {
    fn default() -> Self {
        Self {
            max_size: DEFAULT_MAX_SIZE,
            video_bit_rate: None,
            max_fps: None,
            stay_awake: false,
        }
    }
}

/// Preset → server args. `balanced` keeps the historical max_size default.
pub fn video_launch_for(quality: &str, screen_off: bool) -> VideoLaunch {
    let mut launch = match quality {
        "low" => VideoLaunch {
            max_size: 720,
            video_bit_rate: Some(1_000_000),
            max_fps: Some(15),
            stay_awake: false,
        },
        "high" => VideoLaunch {
            max_size: 1920,
            video_bit_rate: Some(8_000_000),
            max_fps: Some(60),
            stay_awake: false,
        },
        "original" => VideoLaunch {
            max_size: 0,
            video_bit_rate: Some(16_000_000),
            max_fps: Some(60),
            stay_awake: false,
        },
        _ => VideoLaunch {
            max_size: max_size_from_env(),
            video_bit_rate: None,
            max_fps: None,
            stay_awake: false,
        },
    };
    launch.stay_awake = screen_off;
    launch
}

/// Last lines printed by scrcpy-server (stdout and stderr).
#[derive(Clone, Default)]
pub struct ServerLog {
    lines: Arc<Mutex<String>>,
}

impl ServerLog {
    pub fn push_line(&self, line: &str) {
        let line = line.trim();
        if line.is_empty() {
            return;
        }
        let mut guard = self.lines.lock().unwrap_or_else(|e| e.into_inner());
        if !guard.is_empty() {
            guard.push_str(" | ");
        }
        guard.push_str(line);
        const MAX: usize = 400;
        if guard.len() > MAX {
            let mut cut = guard.len() - MAX;
            while cut < guard.len() && !guard.is_char_boundary(cut) {
                cut += 1;
            }
            *guard = guard[cut..].trim_start().to_string();
        }
    }

    pub fn tail(&self) -> String {
        self.lines.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

/// Owns the adb-forwarded TCP pump + server shell process for one serial.
pub struct ScrcpyRawCapture {
    pub pump: VideoPump,
    server: Child,
    local_port: u16,
    pub server_log: ServerLog,
    pub control: ControlSender,
}

impl ScrcpyRawCapture {
    pub fn into_parts(self) -> (VideoPump, Child, u16, ServerLog, ControlSender) {
        (
            self.pump,
            self.server,
            self.local_port,
            self.server_log,
            self.control,
        )
    }
}

/// Resolve scrcpy-server jar: `SCRCPY_SERVER_PATH`, next to binary, vendored, distro paths.
pub fn scrcpy_server_jar(scrcpy_bin: Option<&Path>) -> Option<PathBuf> {
    if let Ok(path) = std::env::var("SCRCPY_SERVER_PATH") {
        let p = PathBuf::from(path);
        if p.is_file() {
            return Some(p);
        }
    }
    if let Some(bin) = scrcpy_bin {
        if let Some(dir) = bin.parent() {
            for name in ["scrcpy-server", "scrcpy-server.jar"] {
                let candidate = dir.join(name);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
            // Release tarballs often ship `scrcpy-server-vX.Y.Z`
            if let Ok(entries) = std::fs::read_dir(dir) {
                for entry in entries.flatten() {
                    let name = entry.file_name();
                    let name = name.to_string_lossy();
                    if name.starts_with("scrcpy-server") && entry.path().is_file() {
                        return Some(entry.path());
                    }
                }
            }
        }
    }
    if let Some(p) = crate::paths::vendored_scrcpy_server() {
        return Some(p);
    }
    // Common distro paths
    for candidate in [
        "/usr/share/scrcpy/scrcpy-server",
        "/usr/local/share/scrcpy/scrcpy-server",
        "/usr/share/scrcpy/scrcpy-server.jar",
    ] {
        let p = PathBuf::from(candidate);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// True when we can attempt a real scrcpy raw-stream session.
pub fn scrcpy_video_ready(adb: Option<&Path>, server: Option<&Path>) -> bool {
    adb.is_some() && server.is_some()
}

/// Parse server version string required as the first `Server` argument.
pub fn scrcpy_server_version(server_jar: &Path, scrcpy_bin: Option<&Path>) -> String {
    if let Ok(v) = std::env::var("SCRCPY_SERVER_VERSION") {
        let v = v.trim().to_string();
        if !v.is_empty() {
            return v;
        }
    }
    if let Some(v) = version_from_filename(server_jar) {
        return v;
    }
    if let Some(bin) = scrcpy_bin {
        if let Some(v) = version_from_scrcpy_cli(bin) {
            return v;
        }
    }
    // Last resort — recent releases; override via SCRCPY_SERVER_VERSION if wrong.
    "3.3.1".into()
}

fn version_from_filename(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_string_lossy();
    // scrcpy-server-v3.3.1 / scrcpy-server-v4.1
    if let Some(rest) = name.strip_prefix("scrcpy-server-v") {
        let ver = rest.trim_end_matches(".jar");
        if !ver.is_empty() {
            return Some(ver.to_string());
        }
    }
    None
}

fn version_from_scrcpy_cli(bin: &Path) -> Option<String> {
    let output = std::process::Command::new(bin)
        .arg("--version")
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    // "scrcpy 3.3.1" / "scrcpy 2.7 <https://...>"
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("scrcpy ") {
            let ver = rest.split_whitespace().next()?;
            if ver.chars().next().is_some_and(|c| c.is_ascii_digit()) {
                return Some(ver.to_string());
            }
        }
    }
    None
}

pub fn max_size_from_env() -> u32 {
    std::env::var("SCRCPY_MAX_SIZE")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_MAX_SIZE)
}

/// Build the `app_process … Server` argument vector (after `adb shell`).
pub fn build_server_shell_command(
    remote_jar: &str,
    version: &str,
    launch: &VideoLaunch,
    extra_opts: &[String],
) -> String {
    // `raw_stream` clears send_dummy_byte. Put send_dummy_byte after it so
    // the handshake byte comes back. adb forward accepts TCP before the
    // device is listening; without that byte the reader sees EOF immediately.
    // Do not set send_frame_meta after raw_stream: that would prefix every
    // video packet and break the Annex-B reader.
    let mut opts = vec![
        "scid=-1".to_string(),
        "log_level=info".to_string(),
        "tunnel_forward=true".to_string(),
        "audio=false".to_string(),
        "control=true".to_string(),
        "cleanup=false".to_string(),
        "raw_stream=true".to_string(),
        "send_dummy_byte=true".to_string(),
        "video_codec=h264".to_string(),
        format!("max_size={}", launch.max_size),
    ];
    if let Some(rate) = launch.video_bit_rate {
        opts.push(format!("video_bit_rate={rate}"));
    }
    if let Some(fps) = launch.max_fps {
        opts.push(format!("max_fps={fps}"));
    }
    if launch.stay_awake {
        opts.push("stay_awake=true".to_string());
    }
    opts.extend(extra_opts.iter().cloned());
    format!(
        "CLASSPATH={remote_jar} app_process / com.genymobile.scrcpy.Server {version} {}",
        opts.join(" ")
    )
}

/// Audio-only server. No `raw_stream`, so codec id + packet headers stay on.
/// Socket name is `scrcpy_{scid:08x}` (scid=-1 would steal the video socket).
/// `scid` is hex: `Options.parse` uses `Integer.parseInt(value, 16)`.
/// This socket is the server's first socket, so scrcpy still writes the 64-byte
/// device name before the codec id (the same prefix `scrcpy.exe` reads). The
/// audio pump skips that name. Do not set `raw_stream` here: it also strips
/// the Opus headers.
pub fn build_audio_server_command(remote_jar: &str, version: &str, scid: u32) -> String {
    let opts = [
        format!("scid={scid:x}"),
        "log_level=info".to_string(),
        "tunnel_forward=true".to_string(),
        "video=false".to_string(),
        "audio=true".to_string(),
        "audio_codec=opus".to_string(),
        "control=false".to_string(),
        "cleanup=false".to_string(),
        "send_dummy_byte=true".to_string(),
    ];
    format!(
        "CLASSPATH={remote_jar} app_process / com.genymobile.scrcpy.Server {version} {}",
        opts.join(" ")
    )
}

pub fn audio_scid(serial: &str) -> u32 {
    let mut hash = 0u32;
    for b in serial.bytes() {
        hash = hash.wrapping_mul(31).wrapping_add(u32::from(b));
    }
    let id = hash & 0x7fff_fffe;
    if id == 0 {
        1
    } else {
        id
    }
}

pub fn audio_socket_name(scid: u32) -> String {
    format!("scrcpy_{scid:08x}")
}

fn audio_port_for_serial(serial: &str) -> u16 {
    31183 + (local_port_for_serial(serial) - 27183)
}

fn local_port_for_serial(serial: &str) -> u16 {
    let mut hash = 0u32;
    for b in serial.bytes() {
        hash = hash.wrapping_mul(31).wrapping_add(u32::from(b));
    }
    27183 + (hash % 2000) as u16
}

fn extra_server_opts() -> Vec<String> {
    let mut opts = Vec::new();
    if let Ok(extra) = std::env::var("SCRCPY_SERVER_OPTS") {
        for arg in extra.split_whitespace() {
            opts.push(arg.to_string());
        }
    }
    // Map a few SCRCPY_EXTRA_ARGS that apply to the server.
    if let Ok(extra) = std::env::var("SCRCPY_EXTRA_ARGS") {
        let parts: Vec<&str> = extra.split_whitespace().collect();
        let mut i = 0;
        while i < parts.len() {
            let p = parts[i];
            if let Some(v) = p.strip_prefix("--max-size=") {
                opts.push(format!("max_size={v}"));
            } else if p == "--max-size" || p == "-m" {
                if let Some(v) = parts.get(i + 1) {
                    opts.push(format!("max_size={v}"));
                    i += 1;
                }
            } else if let Some(v) = p.strip_prefix("--max-fps=") {
                opts.push(format!("max_fps={v}"));
            } else if let Some(v) = p.strip_prefix("--video-bit-rate=") {
                opts.push(format!("video_bit_rate={v}"));
            } else if p == "-b" {
                if let Some(v) = parts.get(i + 1) {
                    opts.push(format!("video_bit_rate={v}"));
                    i += 1;
                }
            }
            i += 1;
        }
    }
    opts
}

async fn run_adb(adb: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new(adb)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("spawn adb: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!(
            "adb {} failed ({}): {}",
            args.join(" "),
            output.status,
            stderr.trim()
        ))
    }
}

async fn adb_forward_remove(adb: &Path, serial: &str, port: u16) -> Result<(), String> {
    let _ = run_adb(
        adb,
        &["-s", serial, "forward", "--remove", &format!("tcp:{port}")],
    )
    .await;
    Ok(())
}

/// Push server, forward port, start raw_stream server, TCP-connect, pump AUs.
pub async fn start_scrcpy_raw_capture(
    hub: Arc<VideoHub>,
    adb: PathBuf,
    server_jar: PathBuf,
    scrcpy_bin: Option<PathBuf>,
    serial: String,
    launch: VideoLaunch,
) -> Result<ScrcpyRawCapture, String> {
    let version = scrcpy_server_version(&server_jar, scrcpy_bin.as_deref());
    let local_port = local_port_for_serial(&serial);
    let extra = extra_server_opts();

    info!(
        %serial,
        server = %server_jar.display(),
        %version,
        local_port,
        "starting scrcpy-server raw H264 stream"
    );

    run_adb(
        &adb,
        &[
            "-s",
            &serial,
            "push",
            server_jar.to_str().ok_or("server path not utf-8")?,
            REMOTE_SERVER_PATH,
        ],
    )
    .await?;

    // Per-device abstract socket (adb -s scopes the forward). Documented name: scrcpy.
    let _ = adb_forward_remove(&adb, &serial, local_port).await;
    run_adb(
        &adb,
        &[
            "-s",
            &serial,
            "forward",
            &format!("tcp:{local_port}"),
            "localabstract:scrcpy",
        ],
    )
    .await?;

    let shell_cmd = build_server_shell_command(REMOTE_SERVER_PATH, &version, &launch, &extra);
    let mut server = Command::new(&adb)
        .args(["-s", &serial, "shell", &shell_cmd])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("spawn scrcpy-server shell: {e}"))?;

    let server_log = ServerLog::default();
    if let Some(out) = server.stdout.take() {
        spawn_server_log(out, serial.clone(), server_log.clone());
    }
    if let Some(err) = server.stderr.take() {
        spawn_server_log(err, serial.clone(), server_log.clone());
    }

    // adb forward accepts localhost before scrcpy-server listens. The server
    // writes the dummy byte on the video socket only after the control socket
    // is accepted, so both connects happen before that read.
    let addr = SocketAddr::from(([127, 0, 0, 1], local_port));
    let (stream, control_stream) = match open_video_and_control(addr, Duration::from_secs(10)).await
    {
        Ok(pair) => pair,
        Err(e) => {
            let _ = server.kill().await;
            let _ = server.wait().await;
            let _ = adb_forward_remove(&adb, &serial, local_port).await;
            return Err(with_server_log(
                &format!("scrcpy-server handshake failed: {e}"),
                &server_log,
            ));
        }
    };
    let control = ControlSender::spawn(control_stream);

    tokio::time::sleep(Duration::from_millis(100)).await;
    if let Ok(Some(status)) = server.try_wait() {
        let _ = adb_forward_remove(&adb, &serial, local_port).await;
        return Err(with_server_log(
            &format!("scrcpy-server exited right after connect ({status})"),
            &server_log,
        ));
    }

    let meta = AnnexBPumpMeta::scrcpy(0, 0, SCRCPY_DEFAULT_CODEC_STRING);
    let pump = start_annexb_reader_pump(hub, serial.clone(), stream, meta).await;

    info!(%serial, local_port, "scrcpy raw H264 pump attached");
    Ok(ScrcpyRawCapture {
        pump,
        server,
        local_port,
        server_log,
        control,
    })
}

fn with_server_log(message: &str, log: &ServerLog) -> String {
    let tail = log.tail();
    if tail.is_empty() {
        message.to_string()
    } else {
        format!("{message} | {tail}")
    }
}

fn spawn_server_log<R>(reader: R, serial: String, log: ServerLog)
where
    R: AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    info!(%serial, "scrcpy-server: {line}");
                    log.push_line(&line);
                }
                Ok(None) => break,
                Err(e) => {
                    warn!(%serial, error = %e, "scrcpy-server log read failed");
                    break;
                }
            }
        }
    });
}

/// TCP-connect and read the one-byte scrcpy handshake.
///
/// A bare connect is not enough: `adb forward` accepts on 127.0.0.1 before
/// `localabstract:scrcpy` exists, and that socket then EOFs.
#[cfg_attr(not(test), allow(dead_code))]
async fn connect_until_handshake(addr: SocketAddr, budget: Duration) -> Result<TcpStream, String> {
    let start = std::time::Instant::now();
    let mut last = "scrcpy-server did not send the handshake byte".to_string();
    while start.elapsed() < budget {
        match TcpStream::connect(addr).await {
            Ok(mut stream) => {
                let mut byte = [0u8; 1];
                match tokio::time::timeout(Duration::from_millis(250), stream.read_exact(&mut byte))
                    .await
                {
                    Ok(Ok(_)) => return Ok(stream),
                    Ok(Err(e)) => {
                        last = format!("socket closed before handshake: {e}");
                    }
                    Err(_) => {
                        last = "adb accepted TCP but scrcpy-server was not listening".into();
                    }
                }
            }
            Err(e) => {
                last = format!("TCP connect failed: {e}");
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err(last)
}

/// Second scrcpy-server: Opus only. The video handshake is not involved.
pub struct AudioCapture {
    pub child: Child,
    pub local_port: u16,
}

pub async fn start_scrcpy_audio_capture(
    hub: Arc<AudioHub>,
    adb: &Path,
    server_jar: &Path,
    scrcpy_bin: Option<&Path>,
    serial: &str,
) -> Result<AudioCapture, String> {
    let version = scrcpy_server_version(server_jar, scrcpy_bin);
    let scid = audio_scid(serial);
    let socket = audio_socket_name(scid);
    let local_port = audio_port_for_serial(serial);

    // The video start already pushed the jar. A second push shares the adb
    // connection with the live forward and stalls the picture.
    let _ = adb_forward_remove(adb, serial, local_port).await;
    run_adb(
        adb,
        &[
            "-s",
            serial,
            "forward",
            &format!("tcp:{local_port}"),
            &format!("localabstract:{socket}"),
        ],
    )
    .await?;

    let shell_cmd = build_audio_server_command(REMOTE_SERVER_PATH, &version, scid);
    let mut server = Command::new(adb)
        .args(["-s", serial, "shell", &shell_cmd])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("spawn scrcpy audio server: {e}"))?;

    let server_log = ServerLog::default();
    if let Some(out) = server.stdout.take() {
        spawn_server_log(out, format!("{serial}-audio"), server_log.clone());
    }
    if let Some(err) = server.stderr.take() {
        spawn_server_log(err, format!("{serial}-audio"), server_log.clone());
    }

    // Audio-only server accepts one socket, then writes the dummy byte.
    // Stop as soon as the process exits. A bad scid used to burn the full
    // handshake budget while the picture and the control socket waited.
    let addr = SocketAddr::from(([127, 0, 0, 1], local_port));
    let stream = match open_audio_until_exit(&mut server, addr, Duration::from_secs(8)).await {
        Ok(stream) => stream,
        Err(e) => {
            tokio::time::sleep(Duration::from_millis(40)).await;
            let _ = server.kill().await;
            let _ = server.wait().await;
            let _ = adb_forward_remove(adb, serial, local_port).await;
            return Err(with_server_log(
                &format!("scrcpy audio handshake failed: {e}"),
                &server_log,
            ));
        }
    };
    spawn_opus_pump(hub, serial.to_string(), stream);
    info!(%serial, local_port, %socket, "scrcpy opus audio pump attached");
    Ok(AudioCapture {
        child: server,
        local_port,
    })
}

/// Audio handshake. A server that has already exited returns immediately.
async fn open_audio_until_exit(
    server: &mut Child,
    addr: SocketAddr,
    budget: Duration,
) -> Result<TcpStream, String> {
    let start = std::time::Instant::now();
    let mut last = "scrcpy audio server did not send the handshake byte".to_string();
    while start.elapsed() < budget {
        match server.try_wait() {
            Ok(Some(status)) => {
                return Err(format!("scrcpy audio server exited ({status})"));
            }
            Err(e) => return Err(format!("scrcpy audio server wait error: {e}")),
            Ok(None) => {}
        }
        match TcpStream::connect(addr).await {
            Ok(mut stream) => {
                let mut byte = [0u8; 1];
                match tokio::time::timeout(Duration::from_millis(250), stream.read_exact(&mut byte))
                    .await
                {
                    Ok(Ok(_)) => {
                        let _ = stream.set_nodelay(true);
                        return Ok(stream);
                    }
                    Ok(Err(e)) => {
                        last = format!("audio socket closed before handshake: {e}");
                    }
                    Err(_) => {
                        last =
                            "scrcpy audio server accepted TCP but did not send the handshake byte"
                                .into();
                    }
                }
            }
            Err(e) => {
                last = format!("audio TCP connect failed: {e}");
            }
        }
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
    Err(last)
}

/// Remove a previously installed adb forward (best-effort helper for session stop).
pub async fn cleanup_forward(adb: &Path, serial: &str, port: u16) {
    if let Err(e) = adb_forward_remove(adb, serial, port).await {
        warn!(%serial, port, error = %e, "adb forward remove failed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_argv_includes_raw_stream() {
        let cmd = build_server_shell_command(
            REMOTE_SERVER_PATH,
            "3.3.1",
            &VideoLaunch {
                max_size: 1280,
                ..VideoLaunch::default()
            },
            &["max_fps=15".into()],
        );
        assert!(cmd.contains("com.genymobile.scrcpy.Server 3.3.1"));
        assert!(cmd.contains("scid=-1"));
        assert!(cmd.contains("raw_stream=true"));
        assert!(cmd.contains("tunnel_forward=true"));
        assert!(cmd.contains("audio=false"));
        assert!(cmd.contains("control=true"));
        assert!(cmd.contains("video_codec=h264"));
        assert!(cmd.contains("max_size=1280"));
        assert!(cmd.contains("max_fps=15"));
        assert!(!cmd.contains("send_frame_meta"));
        let raw = cmd.find("raw_stream=true").unwrap();
        let dummy = cmd.find("send_dummy_byte=true").unwrap();
        assert!(dummy > raw, "dummy byte must override raw_stream");
        assert!(!cmd.contains("stay_awake"));
        assert!(!cmd.contains("video_bit_rate"));
    }

    #[test]
    fn quality_presets_change_size_bitrate_and_fps() {
        let low = video_launch_for("low", false);
        let cmd = build_server_shell_command(REMOTE_SERVER_PATH, "3.3.1", &low, &[]);
        assert!(cmd.contains("max_size=720"));
        assert!(cmd.contains("video_bit_rate=1000000"));
        assert!(cmd.contains("max_fps=15"));
        assert!(cmd.contains("audio=false"));
        assert!(!cmd.contains("send_frame_meta"));

        let off = video_launch_for("balanced", true);
        let cmd = build_server_shell_command(REMOTE_SERVER_PATH, "3.3.1", &off, &[]);
        assert!(cmd.contains("stay_awake=true"));
        assert!(cmd.contains("audio=false"));

        let original = video_launch_for("original", false);
        assert_eq!(original.max_size, 0);
        assert_eq!(original.video_bit_rate, Some(16_000_000));
    }

    #[test]
    fn audio_server_is_separate_and_keeps_packet_headers() {
        let scid = audio_scid("R5CR50AR96VZ");
        assert_ne!(scid, 0);
        let cmd = build_audio_server_command(REMOTE_SERVER_PATH, "3.3.1", scid);
        let hex = format!("{scid:x}");
        assert!(cmd.contains(&format!("scid={hex}")));
        assert_ne!(
            hex,
            scid.to_string(),
            "fixture scid must not look like decimal"
        );
        assert!(i32::from_str_radix(&hex, 16).is_ok());
        assert!(cmd.contains("video=false"));
        assert!(cmd.contains("audio=true"));
        assert!(cmd.contains("audio_codec=opus"));
        assert!(cmd.contains("control=false"));
        assert!(cmd.contains("send_dummy_byte=true"));
        assert!(!cmd.contains("raw_stream"));
        assert!(!cmd.contains("send_frame_meta"));
        assert!(!cmd.contains(&format!("scid={scid}")));
        assert_eq!(audio_socket_name(scid), format!("scrcpy_{scid:08x}"));
        let video_port = local_port_for_serial("R5CR50AR96VZ");
        let audio_port = audio_port_for_serial("R5CR50AR96VZ");
        assert_ne!(video_port, audio_port);
    }

    #[test]
    fn audio_scid_is_hex_so_integer_parse_accepts_it() {
        // Redmi 2312DRAABC: decimal scid "1297390910" crashed Options.parse
        // (`Integer.parseInt(value, 16)` — 10 hex digits overflow a signed int).
        let scid = 1_297_390_910u32;
        let cmd = build_audio_server_command(REMOTE_SERVER_PATH, "3.3.1", scid);
        let hex = format!("{scid:x}");
        assert!(cmd.contains(&format!("scid={hex} ")), "{cmd}");
        assert!(!cmd.contains("scid=1297390910"), "{cmd}");
        let parsed = i32::from_str_radix(&hex, 16).expect("scid fits a signed 32-bit hex int");
        assert_eq!(parsed as u32, scid);

        let live = audio_scid("s8mfpbxwf6pnpr8x");
        let live_hex = format!("{live:x}");
        assert!(live_hex.len() <= 8);
        assert!(i32::from_str_radix(&live_hex, 16).is_ok());
        let socket = audio_socket_name(live);
        assert_eq!(socket, format!("scrcpy_{live:08x}"));
    }

    #[test]
    fn version_parses_from_release_filename() {
        assert_eq!(
            version_from_filename(Path::new("/opt/scrcpy-server-v4.1")).as_deref(),
            Some("4.1")
        );
        assert_eq!(
            version_from_filename(Path::new("scrcpy-server-v3.3.1.jar")).as_deref(),
            Some("3.3.1")
        );
        assert_eq!(version_from_filename(Path::new("scrcpy-server")), None);
    }

    #[test]
    fn ready_requires_adb_and_server() {
        assert!(!scrcpy_video_ready(None, Some(Path::new("/x"))));
        assert!(!scrcpy_video_ready(Some(Path::new("/adb")), None));
        assert!(scrcpy_video_ready(
            Some(Path::new("/adb")),
            Some(Path::new("/server"))
        ));
    }

    #[tokio::test]
    async fn handshake_skips_accept_that_closes_immediately() {
        use tokio::io::AsyncWriteExt;
        use tokio::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let _ = sock.shutdown().await;
            let (mut sock, _) = listener.accept().await.unwrap();
            sock.write_all(&[0x00, 0x00, 0x00, 0x00, 0x01])
                .await
                .unwrap();
            tokio::time::sleep(Duration::from_secs(2)).await;
        });

        let mut stream = connect_until_handshake(addr, Duration::from_secs(3))
            .await
            .expect("handshake");
        let mut rest = [0u8; 4];
        stream.read_exact(&mut rest).await.unwrap();
        assert_eq!(rest, [0x00, 0x00, 0x00, 0x01]);
    }

    #[test]
    fn port_stable_per_serial() {
        let a = local_port_for_serial("R5CW90");
        let b = local_port_for_serial("R5CW90");
        let c = local_port_for_serial("OTHER");
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert!((27183..29183).contains(&a));
    }
}
