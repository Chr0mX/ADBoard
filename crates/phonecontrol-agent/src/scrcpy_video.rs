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
//!     tunnel_forward=true audio=false control=false cleanup=false \
//!     raw_stream=true video_codec=h264 max_size=1280
//! # then TCP connect 127.0.0.1:PORT → raw Annex-B H264
//! ```
//!
//! `raw_stream=true` forces:
//! `send_device_meta=false`, `send_frame_meta=false`, `send_dummy_byte=false`,
//! `send_stream_meta=false` — so the socket is a pure H264 elementary stream.

use crate::video::{
    start_annexb_reader_pump, AnnexBPumpMeta, VideoHub, VideoPump, SCRCPY_DEFAULT_CODEC_STRING,
};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::process::{Child, Command};
use tracing::{info, warn};

const REMOTE_SERVER_PATH: &str = "/data/local/tmp/phonecontrol-scrcpy-server.jar";
const DEFAULT_MAX_SIZE: u32 = 1280;

/// Owns the adb-forwarded TCP pump + server shell process for one serial.
pub struct ScrcpyRawCapture {
    pub pump: VideoPump,
    server: Child,
    local_port: u16,
}

impl ScrcpyRawCapture {
    pub fn into_parts(self) -> (VideoPump, Child, u16) {
        (self.pump, self.server, self.local_port)
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
    max_size: u32,
    extra_opts: &[String],
) -> String {
    let mut opts = vec![
        format!("tunnel_forward=true"),
        format!("audio=false"),
        format!("control=false"),
        format!("cleanup=false"),
        format!("raw_stream=true"),
        format!("video_codec=h264"),
        format!("max_size={max_size}"),
    ];
    opts.extend(extra_opts.iter().cloned());
    format!(
        "CLASSPATH={remote_jar} app_process / com.genymobile.scrcpy.Server {version} {}",
        opts.join(" ")
    )
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
) -> Result<ScrcpyRawCapture, String> {
    let version = scrcpy_server_version(&server_jar, scrcpy_bin.as_deref());
    let max_size = max_size_from_env();
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

    let shell_cmd = build_server_shell_command(REMOTE_SERVER_PATH, &version, max_size, &extra);
    let mut server = Command::new(&adb)
        .args(["-s", &serial, "shell", &shell_cmd])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("spawn scrcpy-server shell: {e}"))?;

    // Give the server a moment to listen, then connect (connection starts the stream).
    let addr = SocketAddr::from(([127, 0, 0, 1], local_port));
    let stream = match connect_with_retry(addr, Duration::from_secs(5)).await {
        Ok(s) => s,
        Err(e) => {
            let _ = server.kill().await;
            let _ = adb_forward_remove(&adb, &serial, local_port).await;
            // Surface server stderr if it died immediately.
            if let Ok(Some(status)) = server.try_wait() {
                return Err(format!(
                    "scrcpy-server exited before TCP connect ({status}): {e}"
                ));
            }
            return Err(format!("TCP connect to scrcpy-server failed: {e}"));
        }
    };

    // Quick check — server still alive after accept.
    tokio::time::sleep(Duration::from_millis(100)).await;
    if let Ok(Some(status)) = server.try_wait() {
        let _ = adb_forward_remove(&adb, &serial, local_port).await;
        return Err(format!(
            "scrcpy-server exited right after connect ({status}) — check version match / device auth"
        ));
    }

    let meta = AnnexBPumpMeta::scrcpy(0, 0, SCRCPY_DEFAULT_CODEC_STRING);
    let pump = start_annexb_reader_pump(hub, serial.clone(), stream, meta).await;

    info!(%serial, local_port, "scrcpy raw H264 pump attached");
    Ok(ScrcpyRawCapture {
        pump,
        server,
        local_port,
    })
}

async fn connect_with_retry(
    addr: SocketAddr,
    budget: Duration,
) -> Result<TcpStream, std::io::Error> {
    let start = std::time::Instant::now();
    let mut last_err = None;
    while start.elapsed() < budget {
        match TcpStream::connect(addr).await {
            Ok(s) => return Ok(s),
            Err(e) => {
                last_err = Some(e);
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
    Err(last_err.unwrap_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::TimedOut, "connect budget exhausted")
    }))
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
            1280,
            &["max_fps=15".into()],
        );
        assert!(cmd.contains("com.genymobile.scrcpy.Server 3.3.1"));
        assert!(cmd.contains("raw_stream=true"));
        assert!(cmd.contains("tunnel_forward=true"));
        assert!(cmd.contains("audio=false"));
        assert!(cmd.contains("control=false"));
        assert!(cmd.contains("video_codec=h264"));
        assert!(cmd.contains("max_size=1280"));
        assert!(cmd.contains("max_fps=15"));
        assert!(!cmd.contains("send_frame_meta")); // folded into raw_stream
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
