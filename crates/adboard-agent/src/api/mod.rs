//! HTTP + WebSocket API for the ADBoard UI + agent mesh.

mod virtual_display;
mod wireless;
mod macros;
mod auth;
mod input;
mod monitoring;
mod ws;
mod ws_close;
mod video_diag;
use auth::*;
use input::*;
use monitoring::*;
use ws::*;
use wireless::*;
use macros::*;
use ws_close::*;
use virtual_display::{
    close_virtual_display, create_virtual_display, launch_on_virtual_display, list_virtual_displays,
    set_virtual_display_limit, virtual_display_overview,
};
use crate::device_manager::AppState;
use crate::web_auth::{self, WebAuth};
use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use axum::extract::Request;
use futures_util::{SinkExt, StreamExt};
use adboard_protocol::{
    AgentToController, ClientCommand, ClipboardPullRequest, ClipboardResponse, ClipboardSetRequest,
    ControlMode, ControllerToAgent, DeviceCommandRequest, HealthResponse,
    InstallBroadcast, KeyInjectRequest, NavRequest, PointerRequest, Role, ScrcpyOptionsRequest,
    ScrcpyOptionsResponse, ServerEvent, SessionStatus, TapRequest, TextInjectRequest,
    VideoRefreshRequest, VideoStatusFrame,
};
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use tokio::sync::mpsc;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::services::ServeDir;
use tower_http::trace::TraceLayer;
use tracing::{debug, info, warn};

const TOKEN_HEADER: &str = "x-adboard-token";
/// Legacy compatibility: request headers from before the rename
/// (`x-phonecontrol-*`). Accepted by [`legacy_headers`] and allowed by CORS so
/// older UIs and agents keep working; never sent by this UI.
pub const LEGACY_HEADER_PREFIX: &str = "x-phonecontrol-";
pub const LEGACY_TOKEN_HEADER: &str = "x-phonecontrol-token";
const HEADER_SUFFIXES: [&str; 8] = ["token", "mode", "targets", "filename", "dest", "dir", "upload", "offset"];
/// Ping browser sockets this often. Cloudflare drops a WebSocket after 100 s
/// without traffic and nginx (Nginx Proxy Manager) after 60 s by default; a
/// still phone screen sends no video frames at all.
const WS_KEEPALIVE_SECS: u64 = 25;

fn ws_keepalive() -> tokio::time::Interval {
    // Tests shorten the silence limit (see ws_close), so a reading client must answer pings just as often.
    #[cfg(test)]
    let period = std::time::Duration::from_millis(500);
    #[cfg(not(test))]
    let period = std::time::Duration::from_secs(WS_KEEPALIVE_SECS);
    let mut interval = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    interval
}

/// Seconds between status frames repeated on a video socket as a heartbeat.
const VIDEO_HEARTBEAT_SECS: u64 = 5;
/// A lagging viewer triggers at most one keyframe request in this time.
const LAG_KEYFRAME_EVERY: std::time::Duration = std::time::Duration::from_secs(2);

fn video_heartbeat() -> tokio::time::Interval {
    let period = std::time::Duration::from_secs(VIDEO_HEARTBEAT_SECS);
    let mut interval = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    interval
}

/// The status frame plus `"heartbeat": <seconds>`. The extra field tells the
/// page this agent repeats the frame on that beat, so silence for a few beats
/// means a dead connection. Older pages ignore the field.
fn status_with_heartbeat(frame: &VideoStatusFrame) -> String {
    status_with_link(frame, None)
}

/// What one video socket has done, sent with its heartbeat so the page can tell where pictures stop: at the
/// phone (`sourceFrames` still), in the agent (`sourceFrames` moves, `sentFrames` does not), or in the page
/// (`sentFrames` moves, nothing arrives).
#[derive(Debug, Clone, Copy, Default)]
pub(super) struct LinkReport {
    pub source: crate::video::SourceStats,
    pub sent_frames: u64,
    pub held_back: u32,
    pub waiting_for_keyframe: bool,
    /// This phone's keyframe resets: sent, merged, deadlines missed, restarts, the one outstanding, the last latency.
    pub resets: crate::session::ResetStats,
}

fn status_with_link(frame: &VideoStatusFrame, link: Option<LinkReport>) -> String {
    let mut value = serde_json::to_value(frame).unwrap_or_else(|_| serde_json::json!({}));
    if let Some(map) = value.as_object_mut() {
        map.insert("heartbeat".into(), serde_json::json!(VIDEO_HEARTBEAT_SECS));
        map.insert("instance".into(), serde_json::json!(PROCESS.0));
        if let Some(link) = link {
            map.insert("sourceFrames".into(), serde_json::json!(link.source.frames));
            map.insert(
                "sourceIdleMs".into(),
                link.source.idle.map_or(serde_json::Value::Null, |d| serde_json::json!(d.as_millis() as u64)),
            );
            map.insert("sentFrames".into(), serde_json::json!(link.sent_frames));
            map.insert("heldBack".into(), serde_json::json!(link.held_back));
            map.insert("waitingForKeyframe".into(), serde_json::json!(link.waiting_for_keyframe));
            map.insert(
                "resets".into(),
                serde_json::json!({
                    "sent": link.resets.sent,
                    "merged": link.resets.merged,
                    "expired": link.resets.expired,
                    "escalated": link.resets.escalated,
                    "outstandingAttempt": link.resets.outstanding_attempt,
                    "lastLatencyMs": link.resets.last_latency_ms,
                }),
            );
        }
    }
    value.to_string()
}

fn ws_ping() -> Message {
    Message::Ping(Bytes::new())
}

pub fn router(state: AppState) -> Router {
    let auth = WebAuth::from_env();
    // Not a restriction, only a heads-up: with no password, anyone who can reach
    // the port can read the API token from /api/bootstrap and use every route.
    let loopback_only = matches!(
        crate::env::var("BIND").ok().as_deref().map(str::trim),
        Some("127.0.0.1" | "localhost")
    );
    if !loopback_only && !auth.password_required() {
        warn!(
            "ADBoard is listening on every network interface with no password set: anyone on this network can use it. Set a password (Settings, Account) or start with ADBOARD_BIND=127.0.0.1"
        );
    }
    router_with_auth(state, auth)
}

pub fn router_with_auth(state: AppState, auth: WebAuth) -> Router {
    let cors = build_cors_layer();

    let mut router = Router::new()
        .route("/health", get(health))
        .route("/api/health", get(health))
        .route("/api/bootstrap", get(bootstrap))
        .route("/api/session", get(session_status))
        .route("/api/login", post(login))
        .route("/api/logout", post(logout))
        .route("/api/account/password", post(change_password))
        .route("/api/devices", get(list_devices))
        .route(
            "/api/devices/wireless",
            get(list_wireless).post(add_wireless).delete(remove_wireless),
        )
        .route("/api/devices/wireless/qr", post(start_qr_pair))
        .route(
            "/api/devices/wireless/qr/{id}",
            get(qr_pair_status).delete(cancel_qr_pair),
        )
        .route("/api/hosts", get(list_hosts))
        .route(
            "/api/virtual-display",
            get(virtual_display_overview).put(set_virtual_display_limit),
        )
        .route(
            "/api/devices/{serial}/virtual-display",
            get(list_virtual_displays).post(create_virtual_display),
        )
        .route(
            "/api/virtual-display/{key}",
            axum::routing::delete(close_virtual_display),
        )
        .route(
            "/api/virtual-display/{key}/launch",
            post(launch_on_virtual_display),
        )
        .route("/api/sessions", get(list_sessions))
        .route("/api/sessions/{serial}", get(get_session))
        .route("/api/sessions/{serial}/start", post(start_session))
        .route("/api/sessions/{serial}/stop", post(stop_session))
        .route("/api/sessions/{serial}/restart", post(restart_session))
        .route("/api/input/tap", post(input_tap))
        .route("/api/input/pointer", post(input_pointer))
        .route("/api/input/gesture", post(input_gesture))
        .route("/api/input/refresh", post(input_refresh))
        .route("/api/input/nav", post(input_nav))
        .route(
            "/api/input/install",
            post(input_install).layer(DefaultBodyLimit::max(256 * 1024 * 1024)),
        )
        .route("/api/device/command", post(device_command))
        .route(
            "/api/uploads/{id}",
            axum::routing::put(crate::uploads::put_chunk)
                .layer(DefaultBodyLimit::max(crate::uploads::MAX_CHUNK_BYTES)),
        )
        .route(
            "/api/device/push",
            post(device_push).layer(DefaultBodyLimit::max(256 * 1024 * 1024)),
        )
        .route("/api/device/pull", get(device_pull))
        .route(
            "/api/host/files",
            get(crate::host_files::list_files)
                .delete(crate::host_files::delete_file)
                .post(crate::host_files::upload_file)
                .layer(DefaultBodyLimit::max(256 * 1024 * 1024)),
        )
        .route("/api/host/files/raw", get(crate::host_files::raw_file))
        .route("/api/host/files/op", post(crate::host_files::apply_op))
        .route(
            "/api/scrcpy/options",
            get(scrcpy_options_get).post(scrcpy_options_set),
        )
        .route("/api/input/clipboard", post(clipboard_set))
        .route("/api/input/clipboard/pull", post(clipboard_pull))
        .route("/api/input/text", post(input_text))
        .route("/api/input/key", post(input_key))
        .route("/api/macro/runs", get(macro_runs_list).post(macro_run_start))
        .route("/api/macro/runs/{tab_id}/{action}", post(macro_run_action))
        .route("/api/macro/devices/{device_id}/{action}", post(macro_device_action))
        .route("/api/macro/queue/{action}", post(macro_queue_action))
        .route("/api/macro/cron", get(macro_cron_preview))
        .route("/api/diagnostics/video", post(video_problem_report))
        .route(
            "/api/diagnostics/video-snapshot",
            post(video_diag::video_snapshot).layer(DefaultBodyLimit::max(512 * 1024)),
        )
        .route("/api/events", get(events_list))
        .route("/api/events/summary", get(events_summary))
        .route("/api/events/macros", get(events_macros))
        .route("/api/events/clear", post(events_clear))
        .route("/api/notifications", get(notifications_get).put(notifications_put))
        .route("/api/notifications/test", post(notifications_test))
        .route("/api/quiet-cycle", get(quiet_cycle_get).put(quiet_cycle_put))
        .route("/api/quiet-cycle/stop", post(quiet_cycle_stop))
        .route("/api/ocr/status", get(ocr_status))
        .route("/api/ocr/read", post(ocr_read))
        .route("/api/system/storage", get(crate::system_api::storage))
        .route("/api/system/open-folder", post(crate::system_api::open_folder))
        .route("/api/system/backup", post(crate::system_api::backup))
        .route("/api/system/location", post(crate::system_api::set_location))
        .route("/api/apps/icon", get(crate::app_icon::app_icon))
        .route("/api/apps/meta", get(crate::app_icon::app_meta))
        .route("/api/store/{name}/history", get(store_history))
        .route("/api/store/{name}/restore", post(store_restore))
        .route(
            "/api/store/{name}",
            get(store_get)
                .put(store_put)
                .layer(DefaultBodyLimit::max(crate::shared_store::MAX_STORE_BYTES + 64 * 1024)),
        )
        .route("/ws", get(ws_upgrade))
        .route("/ws/events", get(ws_upgrade))
        .route("/ws/agent", get(ws_agent_upgrade))
        .route("/ws/devices/{serial}/video", get(ws_video_upgrade))
        .route("/ws/devices/{serial}/audio", get(ws_audio_upgrade))
        .route("/ws/devices/{serial}/logcat", get(ws_logcat_upgrade));

    if let Some(dir) = ui_dir() {
        info!(path = %dir.display(), "serving control UI at /");
        router = router.fallback_service(ServeDir::new(dir).append_index_html_on_directories(true));
    } else {
        warn!("no ui/index.html next to the executable — GET / has no page");
        router = router.route("/", get(ui_not_bundled));
    }

    router
        .layer(middleware::from_fn_with_state(state.clone(), require_api_token))
        .layer(middleware::from_fn(legacy_headers))
        .layer(Extension(Arc::new(auth)))
        .layer(middleware::from_fn(cache_headers))
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

fn build_cors_layer() -> CorsLayer {
    let origins = allowed_dev_origins();
    CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        // The dev UI on :3847 signs in against the agent on :3848 with a cookie.
        .allow_credentials(true)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::DELETE,
            Method::OPTIONS,
            Method::PUT,
        ])
        .allow_headers(
            std::iter::once(header::CONTENT_TYPE)
                .chain(HEADER_SUFFIXES.iter().flat_map(|suffix| {
                    [format!("x-adboard-{suffix}"), format!("{LEGACY_HEADER_PREFIX}{suffix}")]
                }).filter_map(|name| HeaderName::from_bytes(name.as_bytes()).ok()))
                .collect::<Vec<_>>(),
        )
}

/// Legacy compatibility: copy `x-phonecontrol-<x>` request headers to
/// `x-adboard-<x>` (when the new one is absent), so handlers read one name.
async fn legacy_headers(mut request: Request, next: Next) -> Response {
    let headers = request.headers_mut();
    for suffix in HEADER_SUFFIXES {
        let new_name = format!("x-adboard-{suffix}");
        if headers.contains_key(new_name.as_str()) {
            continue;
        }
        let old = headers.get(format!("{LEGACY_HEADER_PREFIX}{suffix}").as_str()).cloned();
        if let (Some(value), Ok(name)) = (old, HeaderName::from_bytes(new_name.as_bytes())) {
            headers.insert(name, value);
        }
    }
    next.run(request).await
}

fn allowed_dev_origins() -> Vec<HeaderValue> {
    static ORIGINS: OnceLock<Vec<HeaderValue>> = OnceLock::new();
    ORIGINS
        .get_or_init(|| {
            let raw = crate::env::var("DEV_ORIGINS").unwrap_or_else(|_| {
                "http://127.0.0.1:3847,http://localhost:3847".into()
            });
            raw.split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .filter_map(|s| HeaderValue::from_str(s).ok())
                .collect()
        })
        .clone()
}

fn path_is_open(path: &str) -> bool {
    matches!(
        path,
        "/health"
            | "/api/health"
            | "/api/bootstrap"
            | "/api/session"
            | "/api/login"
            | "/api/logout"
            | "/api/account/password"
    )
}

fn path_is_static_ui(path: &str) -> bool {
    !path.starts_with("/api/") && !path.starts_with("/ws/") && path != "/ws"
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (from_hex(bytes[i + 1]), from_hex(bytes[i + 2])) {
                out.push((hi << 4) | lo);
                i += 3;
                continue;
            }
        }
        if bytes[i] == b'+' {
            out.push(b' ');
        } else {
            out.push(bytes[i]);
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn from_hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// How long a video socket on a stream it just started waits for the first
/// frame before asking scrcpy for a fresh keyframe. A reset sent before
/// scrcpy's capture runs crashes its control thread (NullPointerException in
/// CaptureControl.reset) and the stream has to restart.
const FIRST_FRAME_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

/// Wait until `rx` carries a video access unit, or `limit` passes.
async fn first_access_unit(rx: &mut tokio::sync::broadcast::Receiver<crate::video::VideoPacket>, limit: std::time::Duration) -> bool {
    let wait = async {
        loop {
            match rx.recv().await {
                Ok(crate::video::VideoPacket::AnnexB(_)) => return true,
                Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return false,
            }
        }
    };
    tokio::time::timeout(limit, wait).await.unwrap_or(false)
}

/// Cache rules for Cloudflare and browsers. Hashed Next assets never change;
/// everything else (HTML, sw.js, manifest, RSC .txt) must revalidate so an
/// update is not hidden behind an edge cache. API responses are never cached.
async fn cache_headers(request: Request, next: Next) -> Response {
    let path = request.uri().path().to_string();
    let mut response = next.run(request).await;
    if response.headers().contains_key(header::CACHE_CONTROL) {
        return response;
    }
    let value = if path.starts_with("/api/") || path == "/health" {
        "no-store"
    } else if path == "/ws" || path.starts_with("/ws/") {
        return response;
    } else if path.starts_with("/_next/static/") && response.status().is_success() {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static(value));
    response
}

fn ui_dir() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("ui"));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("ui"));
        candidates.push(cwd.join("dist/windows/ui"));
    }
    candidates
        .into_iter()
        .find(|dir| dir.join("index.html").is_file())
}

async fn ui_not_bundled() -> Html<&'static str> {
    Html(
        "<!doctype html><meta charset=\"utf-8\"><title>ADBoard</title>\
         <p>ADBoard is running, but the web UI was not found next to the executable.</p>\
         <p><a href=\"/health\">Health</a></p>",
    )
}

async fn health(State(state): State<AppState>) -> Json<HealthResponse> {
    let registered = if state.role() == Role::Controller {
        state.mesh().registered_count().await
    } else {
        0
    };
    Json(HealthResponse {
        status: "ok".into(),
        agent: "adboard-agent".into(),
        role: state.role(),
        host_id: state.host_id().into(),
        host_name: state.host_name().into(),
        adb: state.adb_availability(),
        scrcpy: state.scrcpy_availability(),
        inject: state.inject_mode(),
        port: state.inner.port,
        registered_hosts: registered,
        controller_link: (state.role() == Role::Agent).then(crate::mesh_client::link_status),
        instance: PROCESS.0.clone(),
        uptime_secs: PROCESS.1.elapsed().as_secs(),
        ready: crate::device_manager::fleet_ready(),
    })
}

/// This process's id (random, new at every start) and when it started.
static PROCESS: std::sync::LazyLock<(String, std::time::Instant)> =
    std::sync::LazyLock::new(|| (uuid::Uuid::new_v4().simple().to_string()[..12].to_string(), std::time::Instant::now()));

/// Keep the per-phone history that video diagnostics snapshots include (see `video_diag`).
pub fn spawn_video_history(state: AppState) {
    video_diag::spawn_history(state);
}

/// Touch the process id at start, so uptime counts from the start and not from the first `/health`.
pub fn note_process_start() {
    std::sync::LazyLock::force(&PROCESS);
}

async fn list_devices(State(state): State<AppState>) -> Json<Vec<adboard_protocol::Device>> {
    Json(state.list_devices().await)
}

async fn list_hosts(State(state): State<AppState>) -> Json<Vec<adboard_protocol::HostInfo>> {
    Json(state.list_hosts().await)
}

async fn list_sessions(State(state): State<AppState>) -> Json<Vec<SessionStatus>> {
    Json(state.list_sessions().await)
}

async fn get_session(
    State(state): State<AppState>,
    Path(serial): Path<String>,
) -> Result<Json<SessionStatus>, (StatusCode, String)> {
    let serial = state
        .resolve_serial(&serial)
        .await
        .map_err(|e| (StatusCode::NOT_FOUND, e))?;
    Ok(Json(state.session_status(&serial).await))
}

async fn start_session(
    State(state): State<AppState>,
    Path(serial): Path<String>,
) -> Result<Json<SessionStatus>, (StatusCode, String)> {
    let serial = state
        .resolve_serial(&serial)
        .await
        .map_err(|e| (StatusCode::NOT_FOUND, e))?;
    state
        .start_session(&serial)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))
}

async fn stop_session(
    State(state): State<AppState>,
    Path(serial): Path<String>,
) -> Result<Json<SessionStatus>, (StatusCode, String)> {
    let serial = state
        .resolve_serial(&serial)
        .await
        .map_err(|e| (StatusCode::NOT_FOUND, e))?;
    state
        .stop_session(&serial)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))
}

async fn restart_session(
    State(state): State<AppState>,
    Path(serial): Path<String>,
) -> Result<Json<SessionStatus>, (StatusCode, String)> {
    let serial = state
        .resolve_serial(&serial)
        .await
        .map_err(|e| (StatusCode::NOT_FOUND, e))?;
    state
        .restart_session(&serial)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))
}

async fn input_tap(
    State(state): State<AppState>,
    Json(body): Json<TapRequest>,
) -> Result<Json<adboard_protocol::TapBroadcast>, (StatusCode, String)> {
    state
        .handle_tap(body.mode, &body.target_ids, body.normalized)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))
}

async fn input_pointer(
    State(state): State<AppState>,
    Json(body): Json<PointerRequest>,
) -> Result<Json<adboard_protocol::TapBroadcast>, (StatusCode, String)> {
    state
        .handle_pointer(
            body.mode,
            &body.target_ids,
            body.phase,
            body.tool,
            body.normalized,
            body.frame_width,
            body.frame_height,
        )
        .await
        .map(Json)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))
}

async fn input_gesture(
    State(state): State<AppState>,
    Json(body): Json<adboard_protocol::GestureRequest>,
) -> Result<Json<adboard_protocol::GestureResult>, (StatusCode, String)> {
    state
        .handle_gesture(body)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))
}

fn header_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn header_list(headers: &HeaderMap, name: &str) -> Result<Vec<String>, (StatusCode, String)> {
    let raw = header_value(headers, name).unwrap_or_default();
    let ids: Vec<String> = raw
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if ids.is_empty() {
        Err((StatusCode::BAD_REQUEST, format!("missing {name}")))
    } else {
        Ok(ids)
    }
}

#[cfg(test)]
mod tests;


#[cfg(test)]
mod host_check_tests;
