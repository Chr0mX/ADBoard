//! Video diagnostics snapshots: what every stage looked like when a page's video froze.
//!
//! The page keeps about 15 s of per-phone samples and events (see the page's `diagnostics-core`). When every
//! tile it shows stops painting at once (or someone asks with `__adboardVideoDiagnostics()`), it posts them to
//! `POST /api/diagnostics/video-snapshot`. The agent adds its own side, recorded the same way:
//!
//! - every open video socket (local, or a controller relay to a remote agent): frames sent or forwarded, when
//!   the last one went, whether it is holding frames back for a keyframe, how many it lost to a lag;
//! - per watched phone, a sample a second for the last 15 s: frames and keyframes the phone produced, how long
//!   since the last one, viewers, the session's state and its keyframe resets;
//!
//! and writes the whole thing as one JSON file, `video-diagnostics-<UTC>-<trigger>.json`, in the data folder's
//! `logs/`, next to `adboard.log` (the newest `KEEP` are kept; no other file there is touched). Nothing here
//! changes how video is handled: it only reads counters.
use super::ws_close::LinkStats;
use crate::device_manager::AppState;
use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};
use tracing::{info, warn};

/// Every snapshot file name starts with this, so pruning never touches the other logs beside them.
pub(super) const FILE_PREFIX: &str = "video-diagnostics-";
/// Snapshot files kept; older ones are removed when a new one is written.
pub(super) const KEEP: usize = 50;
/// Agent samples kept per phone (one a second).
const HISTORY_LEN: usize = 15;

struct SocketEntry {
    serial: String,
    kind: &'static str,
    remote: Option<String>,
    link: Arc<LinkStats>,
    opened: Instant,
}

static SOCKETS: LazyLock<Mutex<HashMap<u64, SocketEntry>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static NEXT_SOCKET: AtomicU64 = AtomicU64::new(1);

/// A video socket listed for snapshots; dropping it removes the entry.
pub(super) struct Registered(u64);

impl Drop for Registered {
    fn drop(&mut self) {
        if let Ok(mut sockets) = SOCKETS.lock() {
            sockets.remove(&self.0);
        }
    }
}

/// List an open video socket (`kind`: "local" for a phone on this agent, "proxy" for a controller relay).
pub(super) fn register(serial: &str, kind: &'static str, remote: Option<String>, link: Arc<LinkStats>, opened: Instant) -> Registered {
    let id = NEXT_SOCKET.fetch_add(1, Ordering::Relaxed);
    if let Ok(mut sockets) = SOCKETS.lock() {
        sockets.insert(id, SocketEntry { serial: serial.to_string(), kind, remote, link, opened });
    }
    Registered(id)
}

fn sockets_json() -> serde_json::Value {
    let Ok(sockets) = SOCKETS.lock() else {
        return serde_json::json!([]);
    };
    let mut out: Vec<serde_json::Value> = sockets
        .iter()
        .map(|(id, entry)| {
            let link = &entry.link;
            serde_json::json!({
                "id": id,
                "serial": entry.serial,
                "kind": entry.kind,
                "remote": entry.remote,
                "openForMs": entry.opened.elapsed().as_millis() as u64,
                "framesSent": link.frames.load(Ordering::Relaxed),
                "lastFrameAgoMs": link.ago_ms(&link.last_frame_ms, entry.opened),
                "lastHeartbeatAgoMs": link.ago_ms(&link.last_heartbeat_ms, entry.opened),
                "waitingForKeyframe": link.waiting.load(Ordering::Relaxed),
                "heldBack": link.held_back.load(Ordering::Relaxed),
                "lagged": link.lagged.load(Ordering::Relaxed),
                "viewerIdle": link.idle.load(Ordering::Relaxed),
            })
        })
        .collect();
    out.sort_by_key(|v| v["id"].as_u64().unwrap_or(0));
    serde_json::Value::Array(out)
}

static HISTORY: LazyLock<Mutex<HashMap<String, VecDeque<serde_json::Value>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// One sample of a phone's producer and session, as JSON.
async fn sample(state: &AppState, serial: &str) -> serde_json::Value {
    let stats = state.video_hub().source_stats(serial).await;
    let session = state.inner.sessions.get_session(serial).await;
    let resets = state.inner.sessions.reset_stats(serial);
    serde_json::json!({
        "at": unix_ms(),
        "frames": stats.frames,
        "keyframes": stats.keyframes,
        "lastFrameAgoMs": stats.idle.map(|d| d.as_millis() as u64),
        "inputAgoMs": stats.input_ago.map(|d| d.as_millis() as u64),
        "subscribers": stats.subscribers,
        "stream": session.as_ref().map(|s| format!("{:?}", s.stream)),
        "backend": session.as_ref().map(|s| s.backend.clone()),
        "resetsSent": resets.sent,
        "resetsMerged": resets.merged,
        "resetsExpired": resets.expired,
        "resetsEscalated": resets.escalated,
        "resetOutstandingAttempt": resets.outstanding_attempt,
        "lastResetLatencyMs": resets.last_latency_ms,
    })
}

/// Keep a second-by-second history of every watched phone (about 15 s), for snapshots.
pub(super) fn spawn_history(state: AppState) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            let watched = state.video_hub().watched_serials().await;
            let mut samples = Vec::with_capacity(watched.len());
            for serial in &watched {
                samples.push((serial.clone(), sample(&state, serial).await));
            }
            if let Ok(mut history) = HISTORY.lock() {
                history.retain(|serial, _| watched.contains(serial));
                for (serial, value) in samples {
                    let ring = history.entry(serial).or_default();
                    ring.push_back(value);
                    while ring.len() > HISTORY_LEN {
                        ring.pop_front();
                    }
                }
            }
        }
    });
}

/// The agent's side of a snapshot.
async fn agent_side(state: &AppState, serials: &[String]) -> serde_json::Value {
    let history = HISTORY.lock().map(|h| h.clone()).unwrap_or_default();
    let mut phones = serde_json::Map::new();
    let mut all: Vec<String> = serials.to_vec();
    for serial in history.keys() {
        if !all.contains(serial) {
            all.push(serial.clone());
        }
    }
    for serial in all {
        let now = sample(state, &serial).await;
        let remote = state.remote_owner(&serial).await;
        phones.insert(
            serial.clone(),
            serde_json::json!({
                "remoteOwner": remote,
                "now": now,
                "history": history.get(&serial).map(|h| h.iter().cloned().collect::<Vec<_>>()).unwrap_or_default(),
            }),
        );
    }
    serde_json::json!({
        "instance": super::PROCESS.0,
        "uptimeSecs": super::PROCESS.1.elapsed().as_secs(),
        "role": state.role().as_str(),
        "hostId": state.host_id(),
        "sockets": sockets_json(),
        "phones": phones,
    })
}

/// A file-name-safe version of the page's trigger name.
pub(super) fn safe_trigger(raw: &str) -> String {
    let cleaned: String = raw.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(32).collect();
    if cleaned.is_empty() { "snapshot".into() } else { cleaned }
}

/// Write one snapshot into `dir` and remove all but the newest `keep`.
pub(super) fn write_snapshot(dir: &Path, trigger: &str, value: &serde_json::Value, keep: usize) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%S%.3fZ");
    let path = dir.join(format!("{FILE_PREFIX}{stamp}-{}.json", safe_trigger(trigger)));
    std::fs::write(&path, serde_json::to_vec_pretty(value).unwrap_or_default())?;
    prune(dir, keep);
    Ok(path)
}

fn prune(dir: &Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<PathBuf> = entries
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.extension().is_some_and(|x| x == "json")
                && p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with(FILE_PREFIX))
        })
        .collect();
    // Names start with a UTC time stamp, so the name order is the age order.
    files.sort();
    let extra = files.len().saturating_sub(keep);
    for path in files.into_iter().take(extra) {
        let _ = std::fs::remove_file(path);
    }
}

/// POST /api/diagnostics/video-snapshot — the page's rolling history at a freeze; saved with the agent's side.
pub(super) async fn video_snapshot(
    State(state): State<AppState>,
    Json(page): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let trigger = page.get("trigger").and_then(|v| v.as_str()).unwrap_or("snapshot").to_string();
    let serials: Vec<String> = page
        .get("streams")
        .and_then(|v| v.as_object())
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default();
    let snapshot = serde_json::json!({
        "savedAt": chrono::Utc::now().to_rfc3339(),
        "trigger": trigger,
        "agent": agent_side(&state, &serials).await,
        "page": page,
    });
    let dir = crate::data_dir::logs_dir();
    let written = tokio::task::spawn_blocking(move || write_snapshot(&dir, &trigger, &snapshot, KEEP))
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    match written {
        Ok(path) => {
            info!(path = %path.display(), streams = serials.len(), "video diagnostics snapshot saved");
            Ok(Json(serde_json::json!({ "path": path.display().to_string() })))
        }
        Err(error) => {
            warn!(%error, "could not save a video diagnostics snapshot");
            Err((StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_snapshot_is_written_and_only_the_newest_are_kept() {
        let dir = std::env::temp_dir().join(format!("adboard-video-diag-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // The other logs in the same folder are never touched.
        std::fs::write(dir.join("adboard.log"), "log").unwrap();
        std::fs::write(dir.join("shell_run_history.json"), "[]").unwrap();
        let mut paths = Vec::new();
        for i in 0..5 {
            let value = serde_json::json!({ "n": i });
            paths.push(write_snapshot(&dir, "all-stalled", &value, 3).unwrap());
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let mut left: Vec<PathBuf> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.file_name().unwrap().to_string_lossy().starts_with(FILE_PREFIX))
            .collect();
        left.sort();
        assert_eq!(left, paths[2..].to_vec(), "the three newest stay");
        assert!(dir.join("adboard.log").exists() && dir.join("shell_run_history.json").exists(), "other logs untouched");
        let body: serde_json::Value = serde_json::from_slice(&std::fs::read(&left[2]).unwrap()).unwrap();
        assert_eq!(body["n"], 4);
        let name = left[0].file_name().unwrap().to_string_lossy().to_string();
        assert!(name.starts_with("video-diagnostics-") && name.ends_with("-all-stalled.json"), "{name}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_trigger_name_is_safe_in_a_file_name() {
        assert_eq!(safe_trigger("all-stalled"), "all-stalled");
        assert_eq!(safe_trigger("../../evil\\name"), "evilname");
        assert_eq!(safe_trigger(""), "snapshot");
        assert_eq!(safe_trigger(&"x".repeat(100)).len(), 32);
    }

    #[test]
    fn an_open_socket_is_listed_until_it_closes() {
        let link = Arc::new(LinkStats::default());
        let opened = Instant::now();
        link.note_frame(opened);
        link.held_back.store(7, Ordering::Relaxed);
        let guard = register("DIAG-SER", "local", None, link, opened);
        let listed = sockets_json();
        let mine = listed.as_array().unwrap().iter().find(|s| s["serial"] == "DIAG-SER").cloned().expect("listed");
        assert_eq!(mine["framesSent"], 1);
        assert_eq!(mine["heldBack"], 7);
        drop(guard);
        assert!(!sockets_json().as_array().unwrap().iter().any(|s| s["serial"] == "DIAG-SER"));
    }
}
