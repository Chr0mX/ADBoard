//! HTTP + WebSocket API for the Phone Control UI + agent mesh.

use crate::device_manager::AppState;
use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use phonecontrol_protocol::{
    AgentToController, ClientCommand, ClipboardPullRequest, ClipboardResponse, ClipboardSetRequest,
    ControlMode, ControllerToAgent, DeviceCommandRequest, HealthResponse, HostFileEntry,
    InstallBroadcast, KeyInjectRequest, NavRequest, PointerRequest, Role, ScrcpyOptionsRequest,
    ScrcpyOptionsResponse, ServerEvent, SessionStatus, TapRequest,     TextInjectRequest, VideoRefreshRequest,
    VideoStatusFrame,
};
use std::path::PathBuf;
use tokio::sync::mpsc;
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::ServeDir;
use tower_http::trace::TraceLayer;
use tracing::{debug, info, warn};

pub fn router(state: AppState) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let mut router = Router::new()
        .route("/health", get(health))
        .route("/api/health", get(health))
        .route("/api/devices", get(list_devices))
        .route("/api/hosts", get(list_hosts))
        .route("/api/sessions", get(list_sessions))
        .route("/api/sessions/{serial}", get(get_session))
        .route("/api/sessions/{serial}/start", post(start_session))
        .route("/api/sessions/{serial}/stop", post(stop_session))
        .route("/api/sessions/{serial}/restart", post(restart_session))
        .route("/api/input/tap", post(input_tap))
        .route("/api/input/pointer", post(input_pointer))
        .route("/api/input/refresh", post(input_refresh))
        .route("/api/input/nav", post(input_nav))
        .route(
            "/api/input/install",
            post(input_install).layer(DefaultBodyLimit::max(256 * 1024 * 1024)),
        )
        .route("/api/device/command", post(device_command))
        .route(
            "/api/device/push",
            post(device_push).layer(DefaultBodyLimit::max(256 * 1024 * 1024)),
        )
        .route("/api/device/pull", get(device_pull))
        .route(
            "/api/host/files",
            get(host_files)
                .delete(host_file_delete)
                .post(host_file_upload)
                .layer(DefaultBodyLimit::max(256 * 1024 * 1024)),
        )
        .route("/api/host/files/raw", get(host_file_raw))
        .route("/api/host/files/op", post(host_file_op))
        .route(
            "/api/scrcpy/options",
            get(scrcpy_options_get).post(scrcpy_options_set),
        )
        .route("/api/input/clipboard", post(clipboard_set))
        .route("/api/input/clipboard/pull", post(clipboard_pull))
        .route("/api/input/text", post(input_text))
        .route("/api/input/key", post(input_key))
        .route("/ws", get(ws_upgrade))
        .route("/ws/events", get(ws_upgrade))
        .route("/ws/agent", get(ws_agent_upgrade))
        .route("/ws/devices/{serial}/video", get(ws_video_upgrade))
        .route("/ws/devices/{serial}/audio", get(ws_audio_upgrade));

    if let Some(dir) = ui_dir() {
        info!(path = %dir.display(), "serving control UI at /");
        router = router.fallback_service(ServeDir::new(dir).append_index_html_on_directories(true));
    } else {
        warn!("no ui/index.html next to the executable — GET / has no page");
        router = router.route("/", get(ui_not_bundled));
    }

    router
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state)
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
        "<!doctype html><meta charset=\"utf-8\"><title>Phone Control</title>\
         <p>Phone Control is running, but the web UI was not found next to the executable.</p>\
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
        agent: "phonecontrol-agent".into(),
        role: state.role(),
        host_id: state.host_id().into(),
        host_name: state.host_name().into(),
        adb: state.adb_availability(),
        scrcpy: state.scrcpy_availability(),
        inject: state.inject_mode(),
        port: state.inner.port,
        registered_hosts: registered,
    })
}

async fn list_devices(State(state): State<AppState>) -> Json<Vec<phonecontrol_protocol::Device>> {
    Json(state.list_devices().await)
}

async fn list_hosts(State(state): State<AppState>) -> Json<Vec<phonecontrol_protocol::HostInfo>> {
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
) -> Result<Json<phonecontrol_protocol::TapBroadcast>, (StatusCode, String)> {
    state
        .handle_tap(body.mode, &body.target_ids, body.normalized)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))
}

async fn input_pointer(
    State(state): State<AppState>,
    Json(body): Json<PointerRequest>,
) -> Result<Json<phonecontrol_protocol::TapBroadcast>, (StatusCode, String)> {
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

async fn input_refresh(
    State(state): State<AppState>,
    Json(body): Json<VideoRefreshRequest>,
) -> Result<Json<ClipboardResponse>, (StatusCode, String)> {
    state
        .handle_video_refresh(body)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))
}

async fn input_nav(
    State(state): State<AppState>,
    Json(body): Json<NavRequest>,
) -> Result<Json<phonecontrol_protocol::NavBroadcast>, (StatusCode, String)> {
    state
        .handle_nav(body.mode, &body.target_ids, body.action.action_type)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))
}

async fn scrcpy_options_get(State(state): State<AppState>) -> Json<ScrcpyOptionsResponse> {
    let prefs = state.inner.sessions.prefs().await;
    Json(ScrcpyOptionsResponse {
        quality: prefs.quality,
        audio: prefs.audio,
        screen_off: prefs.screen_off,
        restarted: Vec::new(),
        results: Vec::new(),
    })
}

async fn scrcpy_options_set(
    State(state): State<AppState>,
    Json(body): Json<ScrcpyOptionsRequest>,
) -> Result<Json<ScrcpyOptionsResponse>, (StatusCode, String)> {
    state
        .handle_scrcpy_options(body)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))
}

async fn clipboard_set(
    State(state): State<AppState>,
    Json(body): Json<ClipboardSetRequest>,
) -> Result<Json<ClipboardResponse>, (StatusCode, String)> {
    state
        .handle_clipboard_set(body)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))
}

async fn input_text(
    State(state): State<AppState>,
    Json(body): Json<TextInjectRequest>,
) -> Result<Json<ClipboardResponse>, (StatusCode, String)> {
    state
        .handle_text(body)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))
}

async fn input_key(
    State(state): State<AppState>,
    Json(body): Json<KeyInjectRequest>,
) -> Result<Json<ClipboardResponse>, (StatusCode, String)> {
    state
        .handle_key(body)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))
}

async fn clipboard_pull(
    State(state): State<AppState>,
    Json(body): Json<ClipboardPullRequest>,
) -> Result<Json<ClipboardResponse>, (StatusCode, String)> {
    state
        .handle_clipboard_pull(body)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))
}

/// Raw APK body. Headers name the file, the control mode, and the same target ids nav uses.
async fn input_install(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<InstallBroadcast>, (StatusCode, String)> {
    let filename = header_str(&headers, "x-phonecontrol-filename").unwrap_or("");
    let mode = header_str(&headers, "x-phonecontrol-mode").unwrap_or("selected");
    let targets = header_str(&headers, "x-phonecontrol-targets").unwrap_or("");
    validate_apk_upload(filename, &body).map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    let mode = parse_control_mode(mode).map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    let target_ids: Vec<String> = targets
        .split(',')
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .collect();
    if target_ids.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "no install targets".into()));
    }
    state
        .handle_install(mode, &target_ids, filename.trim(), &body)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))
}

fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

fn parse_control_mode(value: &str) -> Result<ControlMode, String> {
    match value.trim() {
        "selected" => Ok(ControlMode::Selected),
        "multi" => Ok(ControlMode::Multi),
        "all" => Ok(ControlMode::All),
        other => Err(format!("unknown control mode: {other}")),
    }
}

fn validate_apk_upload(filename: &str, bytes: &[u8]) -> Result<(), String> {
    let name = filename.trim();
    let bad_name = name.is_empty()
        || name.len() > 180
        || name.contains(['/', '\\', '\0', '\r', '\n', ':'])
        || !name.to_ascii_lowercase().ends_with(".apk");
    let bad_bytes =
        bytes.len() < 4 || bytes[0] != b'P' || bytes[1] != b'K' || bytes[2] != 3 || bytes[3] != 4;
    if bad_name || bad_bytes {
        return Err("only .apk files can be installed".into());
    }
    Ok(())
}

async fn device_command(
    State(state): State<AppState>,
    Json(body): Json<DeviceCommandRequest>,
) -> Result<Json<phonecontrol_protocol::DeviceCommandResponse>, (StatusCode, String)> {
    state
        .handle_command(body)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))
}

async fn device_push(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<phonecontrol_protocol::DeviceCommandResponse>, (StatusCode, String)> {
    let targets = header_list(&headers, "x-phonecontrol-targets")?;
    let filename =
        header_value(&headers, "x-phonecontrol-filename").unwrap_or_else(|| "upload.bin".into());
    let dest =
        header_value(&headers, "x-phonecontrol-dest").unwrap_or_else(|| "/sdcard/Download/".into());
    if filename.contains('/') || filename.contains('\\') {
        return Err((StatusCode::BAD_REQUEST, "invalid filename".into()));
    }
    state
        .push_file(&targets, &filename, &dest, &body)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))
}

async fn device_pull(
    State(state): State<AppState>,
    Query(query): Query<PullQuery>,
) -> Result<Response, (StatusCode, String)> {
    let (name, bytes) = state
        .pull_file(&query.device_id, &query.path)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    Response::builder()
        .header("content-type", "application/octet-stream")
        .header(
            "content-disposition",
            format!("attachment; filename=\"{name}\""),
        )
        .body(axum::body::Body::from(bytes))
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

#[derive(serde::Deserialize)]
struct PullQuery {
    #[serde(rename = "deviceId")]
    device_id: String,
    path: String,
}

#[derive(serde::Deserialize)]
struct HostPathQuery {
    #[serde(default)]
    path: String,
}

async fn host_files(
    Query(query): Query<HostPathQuery>,
) -> Result<Json<Vec<HostFileEntry>>, (StatusCode, String)> {
    let root = crate::device_ops::files_root();
    let dir = crate::device_ops::host_path(&root, &query.path)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    let mut entries = Vec::new();
    let read = std::fs::read_dir(&dir).map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    for item in read.flatten() {
        let name = item.file_name().to_string_lossy().to_string();
        let meta = item.metadata().ok();
        let rel = if query.path.is_empty() {
            name.clone()
        } else {
            format!("{}/{}", query.path.trim_matches('/'), name)
        };
        entries.push(HostFileEntry {
            name,
            path: rel,
            dir: meta.as_ref().map(|m| m.is_dir()).unwrap_or(false),
            size: meta.map(|m| m.len()).unwrap_or(0),
        });
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(Json(entries))
}

async fn host_file_delete(
    Query(query): Query<HostPathQuery>,
) -> Result<StatusCode, (StatusCode, String)> {
    if query.path.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "path is required".into()));
    }
    let root = crate::device_ops::files_root();
    let path = crate::device_ops::host_path(&root, &query.path)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    if path == root {
        return Err((
            StatusCode::BAD_REQUEST,
            "refusing to delete the file root".into(),
        ));
    }
    if path.is_dir() {
        std::fs::remove_dir_all(&path).map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    } else {
        std::fs::remove_file(&path).map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn host_file_upload(
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<HostFileEntry>, (StatusCode, String)> {
    let filename =
        header_value(&headers, "x-phonecontrol-filename").unwrap_or_else(|| "upload.bin".into());
    let dir = header_value(&headers, "x-phonecontrol-dir").unwrap_or_else(|| "Downloads".into());
    if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return Err((StatusCode::BAD_REQUEST, "invalid filename".into()));
    }
    let root = crate::device_ops::files_root();
    let rel = format!("{}/{}", dir.trim_matches('/'), filename);
    let path =
        crate::device_ops::host_path(&root, &rel).map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    }
    tokio::fs::write(&path, &body)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    Ok(Json(HostFileEntry {
        name: filename,
        path: rel,
        dir: false,
        size: body.len() as u64,
    }))
}

#[derive(serde::Deserialize)]
struct HostFileOpBody {
    op: String,
    path: String,
    #[serde(default)]
    dest: String,
}

async fn host_file_op(
    Json(body): Json<HostFileOpBody>,
) -> Result<Json<phonecontrol_protocol::HostFileEntry>, (StatusCode, String)> {
    let root = crate::device_ops::files_root();
    let rel = crate::device_ops::apply_host_op(&root, &body.op, &body.path, &body.dest)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    let full = crate::device_ops::host_path(&root, &rel).map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    let meta = std::fs::metadata(&full).ok();
    let name = full
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&rel)
        .to_string();
    Ok(Json(phonecontrol_protocol::HostFileEntry {
        name,
        path: rel,
        dir: meta.as_ref().map(|m| m.is_dir()).unwrap_or(false),
        size: meta.map(|m| m.len()).unwrap_or(0),
    }))
}

async fn host_file_raw(
    Query(query): Query<HostPathQuery>,
) -> Result<Response, (StatusCode, String)> {
    let root = crate::device_ops::files_root();
    let path = crate::device_ops::host_path(&root, &query.path)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| (StatusCode::NOT_FOUND, e.to_string()))?;
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    Response::builder()
        .header("content-type", "application/octet-stream")
        .header(
            "content-disposition",
            format!("attachment; filename=\"{name}\""),
        )
        .body(axum::body::Body::from(bytes))
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
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

async fn ws_upgrade(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn ws_agent_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    if state.role() != Role::Controller {
        // Still upgrade so the peer gets a clean close rather than HTTP 404 mid-handshake.
        return ws.on_upgrade(|mut socket| async move {
            let _ = socket
                .send(Message::Text(
                    r#"{"type":"notice","message":"not a controller"}"#.into(),
                ))
                .await;
            let _ = socket.close().await;
        });
    }
    ws.on_upgrade(move |socket| handle_agent_socket(socket, state))
}

async fn ws_video_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Path(serial): Path<String>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_video_socket(socket, state, serial))
}

async fn ws_audio_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Path(serial): Path<String>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_audio_socket(socket, state, serial))
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let (mut sender, mut receiver) = socket.split();
    let mut events = state.subscribe();

    let devices = state.list_devices().await;
    if send_event(&mut sender, &ServerEvent::Devices { devices })
        .await
        .is_err()
    {
        return;
    }

    let hosts = state.list_hosts().await;
    if send_event(&mut sender, &ServerEvent::Hosts { hosts })
        .await
        .is_err()
    {
        return;
    }

    for session in state.list_sessions().await {
        if send_event(&mut sender, &ServerEvent::SessionUpdated { session })
            .await
            .is_err()
        {
            return;
        }
    }

    let state_out = state.clone();
    let mut send_task = tokio::spawn(async move {
        loop {
            match events.recv().await {
                Ok(event) => {
                    if send_event(&mut sender, &event).await.is_err() {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    let devices = state_out.list_devices().await;
                    if send_event(&mut sender, &ServerEvent::Devices { devices })
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    let state_in = state.clone();
    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = receiver.next().await {
            match msg {
                Message::Text(text) => {
                    if let Ok(cmd) = serde_json::from_str::<ClientCommand>(&text) {
                        match cmd {
                            ClientCommand::Subscribe | ClientCommand::Ping => {
                                state_in.publish_fleet().await;
                            }
                            ClientCommand::Tap(req) => {
                                if let Err(e) = state_in
                                    .handle_tap(req.mode, &req.target_ids, req.normalized)
                                    .await
                                {
                                    warn!(error = %e, "ws tap failed");
                                }
                            }
                            ClientCommand::Nav(req) => {
                                if let Err(e) = state_in
                                    .handle_nav(req.mode, &req.target_ids, req.action.action_type)
                                    .await
                                {
                                    warn!(error = %e, "ws nav failed");
                                }
                            }
                            ClientCommand::Pointer(req) => {
                                if let Err(e) = state_in
                                    .handle_pointer(
                                        req.mode,
                                        &req.target_ids,
                                        req.phase,
                                        req.tool,
                                        req.normalized,
                                        req.frame_width,
                                        req.frame_height,
                                    )
                                    .await
                                {
                                    warn!(error = %e, "ws pointer failed");
                                }
                            }
                        }
                    } else {
                        debug!(%text, "ignored non-command ws text");
                    }
                }
                Message::Close(_) => break,
                Message::Ping(_) | Message::Pong(_) | Message::Binary(_) => {}
            }
        }
    });

    tokio::select! {
        _ = &mut send_task => recv_task.abort(),
        _ = &mut recv_task => send_task.abort(),
    }
    info!("websocket client disconnected");
}

/// Agent mesh socket on the controller.
async fn handle_agent_socket(socket: WebSocket, state: AppState) {
    let (mut sender, mut receiver) = socket.split();
    let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<ControllerToAgent>();
    let mesh = state.mesh();

    let welcome = ControllerToAgent::Welcome {
        controller_host_id: state.host_id().into(),
        message: "phonecontrol mesh v1".into(),
    };
    if send_json(&mut sender, &welcome).await.is_err() {
        return;
    }

    let registered_host = std::sync::Arc::new(tokio::sync::Mutex::new(None::<String>));

    // Forward controller→agent commands.
    let mut send_task = tokio::spawn(async move {
        while let Some(cmd) = cmd_rx.recv().await {
            if send_json(&mut sender, &cmd).await.is_err() {
                break;
            }
        }
    });

    let state_in = state.clone();
    let registered_in = registered_host.clone();
    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = receiver.next().await {
            match msg {
                Message::Text(text) => match serde_json::from_str::<AgentToController>(&text) {
                    Ok(frame) => {
                        if let Err(e) =
                            handle_agent_frame(&state_in, &mesh, &cmd_tx, &registered_in, frame)
                                .await
                        {
                            warn!(error = %e, "agent frame handling failed");
                        }
                    }
                    Err(e) => {
                        debug!(error = %e, %text, "ignored non-mesh agent text");
                    }
                },
                Message::Close(_) => break,
                Message::Ping(_) | Message::Pong(_) | Message::Binary(_) => {}
            }
        }
    });

    tokio::select! {
        _ = &mut send_task => recv_task.abort(),
        _ = &mut recv_task => send_task.abort(),
    }

    if let Some(id) = registered_host.lock().await.clone() {
        state.mesh().unregister(&id).await;
        state.publish_fleet().await;
        state.publish(ServerEvent::Notice {
            message: format!("agent {id} disconnected"),
        });
    }
    info!("agent websocket disconnected");
}

async fn handle_agent_frame(
    state: &AppState,
    mesh: &std::sync::Arc<crate::mesh::MeshRegistry>,
    cmd_tx: &mpsc::UnboundedSender<ControllerToAgent>,
    registered_host: &std::sync::Arc<tokio::sync::Mutex<Option<String>>>,
    frame: AgentToController,
) -> Result<(), String> {
    match frame {
        AgentToController::Hello(hello) => {
            mesh.register(
                hello.host_id.clone(),
                hello.host_name.clone(),
                hello.os.clone(),
                cmd_tx.clone(),
                hello.http_base.clone(),
            )
            .await?;
            *registered_host.lock().await = Some(hello.host_id.clone());
            state.publish(ServerEvent::Notice {
                message: format!(
                    "agent registered: {} ({}){}",
                    hello.host_name,
                    hello.host_id,
                    hello
                        .http_base
                        .as_ref()
                        .map(|u| format!(" video@{u}"))
                        .unwrap_or_default()
                ),
            });
            let hosts = state.list_hosts().await;
            state.publish(ServerEvent::Hosts { hosts });
        }
        AgentToController::Heartbeat { host_id: id, .. } => {
            mesh.touch(&id).await;
        }
        AgentToController::Devices {
            host_id: id,
            devices,
        } => {
            // Ensure host tags are consistent.
            let tagged: Vec<_> = devices
                .into_iter()
                .map(|mut d| {
                    if d.host_id.is_none() {
                        d.host_id = Some(id.clone());
                    }
                    d
                })
                .collect();
            let changed = mesh.set_devices(&id, tagged).await;
            if changed {
                state.publish_fleet().await;
            }
        }
        AgentToController::SessionUpdated {
            host_id: id,
            session,
        } => {
            mesh.set_session(&id, session.clone()).await;
            state.publish(ServerEvent::SessionUpdated { session });
        }
        AgentToController::TapResult {
            request_id,
            error,
            targets,
        } => {
            let result = match error {
                Some(e) => Err(e),
                None => Ok(targets),
            };
            mesh.complete_tap(&request_id, result).await;
        }
        AgentToController::NavResult {
            request_id,
            error,
            targets,
        } => {
            let result = match error {
                Some(e) => Err(e),
                None => Ok(targets),
            };
            mesh.complete_nav(&request_id, result).await;
        }
        AgentToController::SessionResult {
            request_id,
            error,
            session,
        } => {
            let result = match (error, session) {
                (Some(e), _) => Err(e),
                (None, Some(s)) => Ok(s),
                (None, None) => Err("agent returned empty session result".into()),
            };
            mesh.complete_session(&request_id, result).await;
        }
    }
    Ok(())
}

/// Video WS: text = VideoStatusFrame JSON; binary = Annex-B H264 access units.
/// Local serials pump from the video hub; remote serials are proxied via the agent's http_base.
async fn handle_video_socket(socket: WebSocket, state: AppState, id_or_serial: String) {
    let (mut sender, mut receiver) = socket.split();

    let serial = match state.resolve_serial(&id_or_serial).await {
        Ok(s) => s,
        Err(e) => {
            let frame = VideoStatusFrame {
                serial: id_or_serial,
                stream: phonecontrol_protocol::StreamState::Error,
                note: e,
                backend: "stub".into(),
                codec: None,
                codec_string: None,
                width: None,
                height: None,
                framing: None,
            };
            let _ = send_json(&mut sender, &frame).await;
            return;
        }
    };

    // Remote device → proxy agent video WS.
    if let Some(host_id) = state.remote_owner(&serial).await {
        match state.remote_http_base(&host_id).await {
            Some(base) => {
                info!(%serial, %host_id, %base, "proxying video WS to agent");
                proxy_remote_stream(sender, receiver, &base, &serial, "video").await;
            }
            None => {
                let frame = VideoStatusFrame {
                    serial: serial.clone(),
                    stream: phonecontrol_protocol::StreamState::Error,
                    note: format!(
                        "agent {host_id} did not advertise http_base — cannot proxy video"
                    ),
                    backend: "stub".into(),
                    codec: None,
                    codec_string: None,
                    width: None,
                    height: None,
                    framing: None,
                };
                let _ = send_json(&mut sender, &frame).await;
            }
        }
        return;
    }

    // Local: ensure pump is running (subscribe does not tear down on disconnect).
    if let Err(e) = state.ensure_local_streaming(&serial).await {
        let frame = VideoStatusFrame {
            serial: serial.clone(),
            stream: phonecontrol_protocol::StreamState::Error,
            note: e,
            backend: "stub".into(),
            codec: None,
            codec_string: None,
            width: None,
            height: None,
            framing: None,
        };
        let _ = send_json(&mut sender, &frame).await;
        return;
    }

    let frame = state.inner.sessions.video_status_frame(&serial).await;
    if send_json(&mut sender, &frame).await.is_err() {
        return;
    }

    let hub = state.video_hub();
    let mut video_rx = hub.subscribe(&serial).await;
    let replay = hub.replay_access_units(&serial).await;
    let hub_lag = hub.clone();
    let mut events = state.subscribe();
    let serial_filter = serial.clone();
    let serial_lag = serial.clone();

    let mut send_task = tokio::spawn(async move {
        for au in replay {
            if sender.send(Message::Binary(au.into())).await.is_err() {
                return;
            }
        }
        // Set after a gap. P-frames must not follow the replayed IDR.
        let mut wait_for_key = false;
        loop {
            tokio::select! {
                packet = video_rx.recv() => {
                    match packet {
                        Ok(crate::video::VideoPacket::Status(frame)) => {
                            if send_json(&mut sender, &frame).await.is_err() {
                                break;
                            }
                        }
                        Ok(crate::video::VideoPacket::AnnexB(bytes)) => {
                            if !crate::video::keep_after_gap(&mut wait_for_key, &bytes) {
                                continue;
                            }
                            if sender
                                .send(Message::Binary(bytes.into()))
                                .await
                                .is_err()
                            {
                                break;
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                            debug!(lagged = n, "video subscriber lagged");
                            let mut failed = false;
                            for au in hub_lag.replay_access_units(&serial_lag).await {
                                if sender
                                    .send(Message::Binary(au.into()))
                                    .await
                                    .is_err()
                                {
                                    failed = true;
                                    break;
                                }
                            }
                            if failed {
                                break;
                            }
                            wait_for_key = true;
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
                event = events.recv() => {
                    match event {
                        Ok(ServerEvent::SessionUpdated { session })
                            if session.serial == serial_filter =>
                        {
                            // Status also arrives via video hub; this covers peers that
                            // only publish ServerEvent.
                            let frame = VideoStatusFrame::from_session(&session);
                            if send_json(&mut sender, &frame).await.is_err() {
                                break;
                            }
                        }
                        Ok(_) => {}
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
            }
        }
    });

    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = receiver.next().await {
            match msg {
                Message::Close(_) => break,
                Message::Ping(_) | Message::Pong(_) | Message::Text(_) | Message::Binary(_) => {}
            }
        }
    });

    tokio::select! {
        _ = &mut send_task => recv_task.abort(),
        _ = &mut recv_task => send_task.abort(),
    }
    info!(%serial, "video websocket disconnected (session left running)");
}

async fn handle_audio_socket(socket: WebSocket, state: AppState, serial: String) {
    let (mut sender, receiver) = socket.split();
    let serial = match state.resolve_serial(&serial).await {
        Ok(serial) => serial,
        Err(e) => {
            let frame = state.inner.sessions.audio_status(&serial).await;
            let mut frame = frame;
            frame.stream = phonecontrol_protocol::StreamState::Error;
            frame.note = e;
            let _ = send_json(&mut sender, &frame).await;
            return;
        }
    };

    if let Some(host_id) = state.remote_owner(&serial).await {
        match state.remote_http_base(&host_id).await {
            Some(base) => {
                info!(%serial, %host_id, "proxying audio WS to agent");
                proxy_remote_stream(sender, receiver, &base, &serial, "audio").await;
            }
            None => {
                let mut frame = state.inner.sessions.audio_status(&serial).await;
                frame.stream = phonecontrol_protocol::StreamState::Error;
                frame.note =
                    format!("agent {host_id} did not advertise http_base — cannot proxy audio");
                let _ = send_json(&mut sender, &frame).await;
            }
        }
        return;
    }

    let frame = state.inner.sessions.audio_status(&serial).await;
    if send_json(&mut sender, &frame).await.is_err() {
        return;
    }
    let hub = state.inner.sessions.audio_hub();
    let (mut audio_rx, _) = hub.subscribe(&serial).await;
    let mut send_task = tokio::spawn(async move {
        loop {
            match audio_rx.recv().await {
                Ok(crate::audio::AudioFrame::Status(frame)) => {
                    if send_json(&mut sender, &frame).await.is_err() {
                        break;
                    }
                }
                Ok(crate::audio::AudioFrame::Packet(bytes)) => {
                    if sender.send(Message::Binary(bytes.into())).await.is_err() {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
    let mut recv_task = tokio::spawn(async move {
        let mut receiver = receiver;
        while let Some(Ok(msg)) = receiver.next().await {
            if matches!(msg, Message::Close(_)) {
                break;
            }
        }
    });
    tokio::select! {
        _ = &mut send_task => recv_task.abort(),
        _ = &mut recv_task => send_task.abort(),
    }
    info!(%serial, "audio websocket disconnected");
}

/// Relay an agent device websocket (video or audio) to the browser.
async fn proxy_remote_stream(
    mut client_out: futures_util::stream::SplitSink<WebSocket, Message>,
    mut client_in: futures_util::stream::SplitStream<WebSocket>,
    agent_http_base: &str,
    serial: &str,
    channel: &str,
) {
    let ws_url = http_to_ws_device_url(agent_http_base, serial, channel);
    let (agent_ws, _) = match tokio_tungstenite::connect_async(&ws_url).await {
        Ok(pair) => pair,
        Err(e) => {
            let frame = VideoStatusFrame {
                serial: serial.into(),
                stream: phonecontrol_protocol::StreamState::Error,
                note: format!("video proxy connect failed: {e}"),
                backend: "stub".into(),
                codec: None,
                codec_string: None,
                width: None,
                height: None,
                framing: None,
            };
            let _ = send_json(&mut client_out, &frame).await;
            return;
        }
    };

    let (mut agent_out, mut agent_in) = agent_ws.split();

    let mut to_client = tokio::spawn(async move {
        while let Some(Ok(msg)) = agent_in.next().await {
            let mapped = match msg {
                tokio_tungstenite::tungstenite::Message::Text(t) => {
                    Message::Text(t.as_str().to_string().into())
                }
                tokio_tungstenite::tungstenite::Message::Binary(b) => {
                    Message::Binary(b.to_vec().into())
                }
                tokio_tungstenite::tungstenite::Message::Ping(p) => {
                    Message::Ping(p.to_vec().into())
                }
                tokio_tungstenite::tungstenite::Message::Pong(p) => {
                    Message::Pong(p.to_vec().into())
                }
                tokio_tungstenite::tungstenite::Message::Close(_) => break,
                tokio_tungstenite::tungstenite::Message::Frame(_) => continue,
            };
            if client_out.send(mapped).await.is_err() {
                break;
            }
        }
    });

    let mut to_agent = tokio::spawn(async move {
        while let Some(Ok(msg)) = client_in.next().await {
            let mapped = match msg {
                Message::Text(t) => {
                    tokio_tungstenite::tungstenite::Message::Text(t.as_str().into())
                }
                Message::Binary(b) => {
                    tokio_tungstenite::tungstenite::Message::Binary(b.to_vec().into())
                }
                Message::Ping(p) => {
                    tokio_tungstenite::tungstenite::Message::Ping(p.to_vec().into())
                }
                Message::Pong(p) => {
                    tokio_tungstenite::tungstenite::Message::Pong(p.to_vec().into())
                }
                Message::Close(_) => break,
            };
            if agent_out.send(mapped).await.is_err() {
                break;
            }
        }
    });

    tokio::select! {
        _ = &mut to_client => to_agent.abort(),
        _ = &mut to_agent => to_client.abort(),
    }
}

fn http_to_ws_device_url(http_base: &str, serial: &str, channel: &str) -> String {
    let base = http_base.trim_end_matches('/');
    let ws = if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = base.strip_prefix("http://") {
        format!("ws://{rest}")
    } else if base.starts_with("ws://") || base.starts_with("wss://") {
        base.to_string()
    } else {
        format!("ws://{base}")
    };
    format!("{ws}/ws/devices/{serial}/{channel}")
}

async fn send_event(
    sender: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    event: &ServerEvent,
) -> Result<(), ()> {
    send_json(sender, event).await
}

async fn send_json<T: serde::Serialize>(
    sender: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    value: &T,
) -> Result<(), ()> {
    let text = serde_json::to_string(value).map_err(|_| ())?;
    sender
        .send(Message::Text(text.into()))
        .await
        .map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use phonecontrol_protocol::Role;
    use tower::ServiceExt;

    fn apk_request(filename: &str, targets: &str, bytes: &'static [u8]) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri("/api/input/install")
            .header("x-phonecontrol-mode", "selected")
            .header("x-phonecontrol-targets", targets)
            .header("x-phonecontrol-filename", filename)
            .body(Body::from(bytes))
            .unwrap()
    }

    async fn body_text(response: axum::response::Response) -> String {
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        String::from_utf8_lossy(&bytes).into_owned()
    }

    #[tokio::test]
    async fn install_rejects_non_apk_and_reports_missing_adb() {
        let state = AppState::new(
            Role::Controller,
            "install-test".into(),
            "install-test".into(),
            0,
            None,
        );
        let devices = state.list_devices().await;
        let id = devices
            .iter()
            .find(|d| d.status == phonecontrol_protocol::DeviceStatus::Online)
            .expect("online device")
            .id
            .clone();
        let app = router(state);

        let rejected = app
            .clone()
            .oneshot(apk_request("notes.txt", &id, b"PK\x03\x04nope"))
            .await
            .unwrap();
        assert_eq!(rejected.status(), StatusCode::BAD_REQUEST);
        let text = body_text(rejected).await;
        assert!(
            text.contains("apk"),
            "non-apk upload should be rejected, got {text}"
        );

        let not_zip = router_oneshot_note(&id).await;
        assert_eq!(not_zip.0, StatusCode::BAD_REQUEST);
        assert!(not_zip.1.contains("apk"), "got {}", not_zip.1);

        let response = app
            .oneshot(apk_request("demo.apk", &id, b"PK\x03\x04fake-apk"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let text = body_text(response).await;
        assert!(
            text.contains("adb is not available"),
            "missing adb should be a clear error, got {text}"
        );
        assert!(text.contains("\"inject\":\"error\""), "{text}");
    }

    #[tokio::test]
    async fn command_reports_missing_adb_and_rejects_a_bad_shell() {
        let state = AppState::new(
            Role::Controller,
            "command-test".into(),
            "command-test".into(),
            0,
            None,
        );
        let devices = state.list_devices().await;
        let id = devices
            .iter()
            .find(|d| d.status == phonecontrol_protocol::DeviceStatus::Online)
            .expect("online device")
            .id
            .clone();
        let app = router(state);
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/device/command")
                    .header("content-type", "application/json")
                    .body(Body::from(format!(
                        "{{\"targetIds\":[\"{id}\"],\"op\":\"shell\",\"arg\":\"pm list packages\"}}"
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let text = body_text(response).await;
        assert!(text.contains("adb is not available"), "{text}");
        assert!(text.contains("\"ok\":false"), "{text}");
    }

    #[tokio::test]
    async fn scrcpy_options_and_clipboard_on_a_mock_device() {
        let state = AppState::new(
            Role::Controller,
            "scrcpy-opt".into(),
            "scrcpy-opt".into(),
            0,
            None,
        );
        let devices = state.list_devices().await;
        let id = devices
            .iter()
            .find(|d| d.status == phonecontrol_protocol::DeviceStatus::Online)
            .expect("online device")
            .id
            .clone();
        let app = router(state);

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/scrcpy/options")
                    .header("content-type", "application/json")
                    .body(Body::from(format!(
                        r#"{{"mode":"selected","targetIds":["{id}"],"quality":"high","audio":true,"screenOff":false}}"#
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let text = body_text(response).await;
        assert!(text.contains("\"quality\":\"high\""), "{text}");
        assert!(text.contains("\"audio\":true"), "{text}");

        let screen = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/scrcpy/options")
                    .header("content-type", "application/json")
                    .body(Body::from(format!(
                        r#"{{"mode":"selected","targetIds":["{id}"],"quality":"high","audio":true,"screenOff":true}}"#
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(screen.status(), StatusCode::OK);
        let screen_text = body_text(screen).await;
        assert!(screen_text.contains("\"screenOff\":true"), "{screen_text}");
        assert!(
            screen_text.contains("scrcpy control is not connected"),
            "screen-off on a mock session should say the control socket is missing, got {screen_text}"
        );

        let saved = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/scrcpy/options")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(saved.status(), StatusCode::OK);
        let saved_text = body_text(saved).await;
        assert!(saved_text.contains("\"quality\":\"high\""), "{saved_text}");

        let clip = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/input/clipboard")
                    .header("content-type", "application/json")
                    .body(Body::from(format!(
                        r#"{{"mode":"selected","targetIds":["{id}"],"text":"hello","paste":true}}"#
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(clip.status(), StatusCode::OK);
        let clip_text = body_text(clip).await;
        assert!(
            clip_text.contains("scrcpy control is not connected"),
            "{clip_text}"
        );
        assert!(clip_text.contains("\"ok\":false"), "{clip_text}");
    }

    #[tokio::test]
    async fn keyboard_routes_use_the_control_socket() {
        let state = AppState::new(Role::Controller, "keys".into(), "keys".into(), 0, None);
        let devices = state.list_devices().await;
        let id = devices
            .iter()
            .find(|d| d.status == phonecontrol_protocol::DeviceStatus::Online)
            .expect("online device")
            .id
            .clone();
        let app = router(state);

        let text = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/input/text")
                    .header("content-type", "application/json")
                    .body(Body::from(format!(
                        r#"{{"mode":"selected","targetIds":["{id}"],"text":"a"}}"#
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(text.status(), StatusCode::OK);
        let text_body = body_text(text).await;
        assert!(
            text_body.contains("scrcpy control is not connected"),
            "{text_body}"
        );

        let key = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/input/key")
                    .header("content-type", "application/json")
                    .body(Body::from(format!(
                        r#"{{"mode":"selected","targetIds":["{id}"],"action":"down","keycode":66,"repeat":0,"metastate":0}}"#
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(key.status(), StatusCode::OK);
        let key_body = body_text(key).await;
        assert!(
            key_body.contains("scrcpy control is not connected"),
            "{key_body}"
        );
    }

    async fn router_oneshot_note(id: &str) -> (StatusCode, String) {
        let state = AppState::new(
            Role::Controller,
            "install-test-2".into(),
            "install-test-2".into(),
            0,
            None,
        );
        let app = router(state);
        let response = app
            .oneshot(apk_request("demo.apk", id, b"this is not a zip"))
            .await
            .unwrap();
        let status = response.status();
        let text = body_text(response).await;
        (status, text)
    }
}
