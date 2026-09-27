//! Scrcpy session manager + ADB input injection.
//!
//! - When `scrcpy` (or `SCRCPY_PATH`) exists: start/stop/restart headless sessions
//!   (no stock GUI windows). H264→browser decode stays stubbed; stream state is real.
//! - When missing: honest `idle` stub with a clear note.
//! - Inject v1: `adb shell input tap` / `keyevent` when ADB is available; otherwise stub.

use phonecontrol_protocol::{
    adb_keyevent_args, adb_tap_args, nav_keycode, InjectMode, InjectStatus, MappedTap,
    NavActionType, ScrcpyAvailability, SessionStatus, StreamState,
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
}

pub struct SessionManager {
    sessions: RwLock<HashMap<String, LiveSession>>,
    adb_path: Option<PathBuf>,
    scrcpy_path: Option<PathBuf>,
    inject_mode: InjectMode,
}

impl SessionManager {
    pub fn new(adb_path: Option<PathBuf>, scrcpy_path: Option<PathBuf>) -> Arc<Self> {
        let inject_mode = if adb_path.is_some() {
            InjectMode::Adb
        } else {
            InjectMode::Stub
        };
        Arc::new(Self {
            sessions: RwLock::new(HashMap::new()),
            adb_path,
            scrcpy_path,
            inject_mode,
        })
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
        if self.scrcpy_path.is_some() {
            "scrcpy"
        } else {
            "stub"
        }
    }

    fn stub_note() -> String {
        "scrcpy binary missing — stream idle (set SCRCPY_PATH or install scrcpy; H264 frame pump still stubbed)".into()
    }

    pub async fn ensure_session(&self, serial: &str) -> SessionStatus {
        let mut guard = self.sessions.write().await;
        if let Some(live) = guard.get(serial) {
            return live.info.clone();
        }
        let info = SessionStatus {
            serial: serial.to_string(),
            stream: StreamState::Idle,
            note: if self.scrcpy_path.is_some() {
                "session registered — call start to launch headless scrcpy".into()
            } else {
                Self::stub_note()
            },
            backend: self.backend_label().into(),
        };
        guard.insert(
            serial.to_string(),
            LiveSession {
                info: info.clone(),
                child: None,
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

    /// Start a headless scrcpy session for `serial` when the binary exists.
    pub async fn start(&self, serial: &str) -> SessionStatus {
        let _ = self.ensure_session(serial).await;

        let Some(scrcpy) = self.scrcpy_path.clone() else {
            return self
                .set_status(
                    serial,
                    StreamState::Idle,
                    Self::stub_note(),
                )
                .await;
        };

        // Stop any prior child first.
        self.stop_child(serial).await;

        self.set_status(
            serial,
            StreamState::Starting,
            format!("starting headless scrcpy ({})", scrcpy.display()),
        )
        .await;

        // Headless: no window / no playback. Video bytes are not forwarded yet —
        // this keeps a real process lifecycle so a later WS/WebRTC pump can attach.
        let mut cmd = Command::new(&scrcpy);
        cmd.args([
            "-s",
            serial,
            "--no-playback",
            "--no-window",
            "--no-audio",
            "--no-clipboard-autosync",
        ]);
        // Optional extra args from env (space-separated).
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
                // Brief settle — if the process exits immediately, treat as error.
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                let mut guard = self.sessions.write().await;
                let live = guard.entry(serial.to_string()).or_insert_with(|| LiveSession {
                    info: SessionStatus {
                        serial: serial.to_string(),
                        stream: StreamState::Starting,
                        note: String::new(),
                        backend: self.backend_label().into(),
                    },
                    child: None,
                });
                // Check if still running without consuming the child permanently.
                // We store it; try_wait mutably.
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
                    live.info.backend = self.backend_label().into();
                    warn!(serial, %status, "scrcpy exited on start");
                    return live.info.clone();
                }
                live.info.stream = StreamState::Streaming;
                live.info.note =
                    "scrcpy process running (headless); H264→browser frame pump not wired yet"
                        .into();
                live.info.backend = self.backend_label().into();
                info!(serial, "scrcpy session streaming (process up, frames stubbed)");
                live.info.clone()
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

    pub async fn stop(&self, serial: &str) -> SessionStatus {
        self.stop_child(serial).await;
        let note = if self.scrcpy_path.is_some() {
            "session stopped".into()
        } else {
            Self::stub_note()
        };
        self.set_status(serial, StreamState::Idle, note).await
    }

    pub async fn restart(&self, serial: &str) -> SessionStatus {
        let _ = self.stop(serial).await;
        self.start(serial).await
    }

    async fn stop_child(&self, serial: &str) {
        let mut guard = self.sessions.write().await;
        if let Some(live) = guard.get_mut(serial) {
            if let Some(mut child) = live.child.take() {
                let _ = child.kill().await;
                let _ = child.wait().await;
            }
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
        });
        entry.info.stream = stream;
        entry.info.note = note;
        entry.info.backend = backend;
        entry.info.clone()
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
    // Optional dedicated server jar/path — used as a presence signal for "available"
    // even when the CLI wrapper name differs.
    if let Ok(path) = std::env::var("SCRCPY_SERVER_PATH") {
        let p = PathBuf::from(path);
        if p.is_file() {
            // Prefer CLI if present; otherwise treat server path as "available" marker only.
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
        let mgr = SessionManager::new(None, None);
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
        assert_eq!(session.backend, "stub");
    }

    #[tokio::test]
    async fn start_without_scrcpy_stays_idle() {
        let mgr = SessionManager::new(None, None);
        let session = mgr.start("SERIAL").await;
        assert_eq!(session.stream, StreamState::Idle);
        assert!(session.note.contains("scrcpy"));
    }
}
