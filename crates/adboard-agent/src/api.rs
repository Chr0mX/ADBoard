//! HTTP + WebSocket API for the ADBoard UI + agent mesh.

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
    let period = std::time::Duration::from_secs(WS_KEEPALIVE_SECS);
    let mut interval = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    interval
}

fn ws_ping() -> Message {
    Message::Ping(Bytes::new())
}

pub fn router(state: AppState) -> Router {
    router_with_auth(state, WebAuth::from_env())
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
        .route("/api/system/storage", get(crate::system_api::storage))
        .route("/api/system/open-folder", post(crate::system_api::open_folder))
        .route("/api/system/backup", post(crate::system_api::backup))
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
        .route("/ws/devices/{serial}/audio", get(ws_audio_upgrade));

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

/// Browsers cannot set headers on a WebSocket, so the UI offers the token as a
/// subprotocol (`adboard-token.<hex>`) instead of `?token=`, which proxies and
/// Cloudflare would log. The server answers with the plain `adboard` protocol.
pub const WS_PROTOCOL: &str = "adboard";
/// Accepted from UIs built before the ADBoard rename (tabs left open).
const LEGACY_WS_PROTOCOL: &str = "rasiel";
const WS_TOKEN_PROTOCOL_PREFIXES: [&str; 2] = ["adboard-token.", "rasiel-token."];

fn token_from_ws_protocol(headers: &HeaderMap) -> Option<String> {
    headers
        .get_all(header::SEC_WEBSOCKET_PROTOCOL)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .find_map(|item| {
            let item = item.trim();
            let hex = WS_TOKEN_PROTOCOL_PREFIXES
                .iter()
                .find_map(|prefix| item.strip_prefix(prefix))?;
            if hex.len() % 2 != 0 {
                return None;
            }
            let bytes: Option<Vec<u8>> = (0..hex.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(hex.get(i..i + 2)?, 16).ok())
                .collect();
            String::from_utf8(bytes?).ok().filter(|t| !t.is_empty())
        })
}

fn token_from_request(headers: &HeaderMap, uri: &axum::http::Uri) -> Option<String> {
    if let Some(token) = token_from_ws_protocol(headers) {
        return Some(token);
    }
    if let Some(value) = headers
        .get(TOKEN_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return Some(value.to_string());
    }
    uri.query().and_then(|q| {
        q.split('&').find_map(|pair| {
            let (key, value) = pair.split_once('=')?;
            if key == "token" {
                let decoded = percent_decode(value);
                if decoded.is_empty() {
                    None
                } else {
                    Some(decoded)
                }
            } else {
                None
            }
        })
    })
}

fn origin_allowed_for_bootstrap(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) else {
        // Same-origin navigations and non-browser clients omit Origin.
        return true;
    };
    if origin_matches_host(origin, headers) {
        return true;
    }
    allowed_dev_origins()
        .iter()
        .any(|allowed| allowed.as_bytes() == origin.as_bytes())
}

fn origin_matches_host(origin: &str, headers: &HeaderMap) -> bool {
    let Some(host) = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return false;
    };
    let Ok(url) = origin.parse::<axum::http::Uri>() else {
        return false;
    };
    let Some(origin_host) = url.host() else {
        return false;
    };
    let origin_authority = match url.port_u16() {
        Some(port) => format!("{origin_host}:{port}"),
        None => origin_host.to_string(),
    };
    origin_authority.eq_ignore_ascii_case(host)
        || origin_host.eq_ignore_ascii_case(host)
}

async fn require_api_token(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let path = request.uri().path().to_string();
    if path_is_open(&path) || path_is_static_ui(&path) {
        return Ok(next.run(request).await);
    }
    let provided = token_from_request(request.headers(), request.uri());
    match provided {
        Some(token) if token == state.api_token() => Ok(next.run(request).await),
        _ => Err(StatusCode::UNAUTHORIZED),
    }
}

#[derive(serde::Serialize)]
struct BootstrapBody {
    token: String,
}

const PROXY_NEEDS_PASSWORD: &str = "ADBoard is being reached through a reverse proxy without a password. Set ADBOARD_PASSWORD on the ADBoard host (or ADBOARD_ALLOW_PROXY_WITHOUT_PASSWORD=1 if Cloudflare Access or similar already protects it).";

fn auth_error(status: StatusCode, message: &str) -> Response {
    (status, Json(serde_json::json!({ "error": message }))).into_response()
}

async fn bootstrap(
    State(state): State<AppState>,
    Extension(auth): Extension<Arc<WebAuth>>,
    headers: HeaderMap,
) -> Response {
    if !origin_allowed_for_bootstrap(&headers) {
        return auth_error(StatusCode::FORBIDDEN, "This page's origin may not use ADBoard.");
    }
    if auth.password_required() {
        if !auth.session_valid(&headers) {
            return auth_error(StatusCode::UNAUTHORIZED, "Sign in to ADBoard.");
        }
    } else if auth.proxy_blocked(&headers) {
        return auth_error(StatusCode::FORBIDDEN, PROXY_NEEDS_PASSWORD);
    }
    Json(BootstrapBody {
        token: state.api_token().to_string(),
    })
    .into_response()
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionBody {
    auth_required: bool,
    authenticated: bool,
    proxy_blocked: bool,
    /// Signed-in username (only when authenticated).
    username: Option<String>,
    /// No account yet and this is a direct LAN request: the UI may offer "Set password".
    can_set_password: bool,
}

async fn session_status(
    Extension(auth): Extension<Arc<WebAuth>>,
    headers: HeaderMap,
) -> Json<SessionBody> {
    let auth_required = auth.password_required();
    let authenticated = auth_required && auth.session_valid(&headers);
    Json(SessionBody {
        auth_required,
        authenticated,
        proxy_blocked: auth.proxy_blocked(&headers),
        username: if authenticated { auth.username() } else { None },
        can_set_password: !auth_required && !web_auth::is_proxied(&headers),
    })
}

#[derive(serde::Deserialize)]
struct LoginBody {
    #[serde(default)]
    username: Option<String>,
    password: String,
}

async fn login(
    Extension(auth): Extension<Arc<WebAuth>>,
    headers: HeaderMap,
    Json(body): Json<LoginBody>,
) -> Response {
    if !origin_allowed_for_bootstrap(&headers) {
        return auth_error(StatusCode::FORBIDDEN, "This page's origin may not use ADBoard.");
    }
    if !auth.password_required() {
        return auth_error(StatusCode::BAD_REQUEST, "No password is configured on this ADBoard host.");
    }
    let username = body
        .username
        .as_deref()
        .filter(|u| !u.trim().is_empty())
        .unwrap_or(web_auth::DEFAULT_USERNAME);
    if !auth.check_login(username, &body.password) {
        // Slow down guessing.
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        warn!(proxied = web_auth::is_proxied(&headers), "failed sign-in");
        return auth_error(StatusCode::UNAUTHORIZED, "Wrong username or password.");
    }
    let id = auth.create_session();
    let mut response = Json(serde_json::json!({ "ok": true })).into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        web_auth::session_set_cookie(&id, web_auth::is_https(&headers)),
    );
    response
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangePasswordBody {
    #[serde(default)]
    current_password: String,
    #[serde(default)]
    username: Option<String>,
    new_password: String,
}

/// Change the account password (signed in, with the current password), or set
/// the first one from a direct LAN request. Ends every other session.
async fn change_password(
    Extension(auth): Extension<Arc<WebAuth>>,
    headers: HeaderMap,
    Json(body): Json<ChangePasswordBody>,
) -> Response {
    if !origin_allowed_for_bootstrap(&headers) {
        return auth_error(StatusCode::FORBIDDEN, "This page's origin may not use ADBoard.");
    }
    let current_user = auth.username();
    match &current_user {
        Some(user) => {
            if !auth.session_valid(&headers) {
                return auth_error(StatusCode::UNAUTHORIZED, "Sign in to ADBoard.");
            }
            if !auth.check_login(user, &body.current_password) {
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                return auth_error(StatusCode::UNAUTHORIZED, "Current password is wrong.");
            }
        }
        None => {
            if web_auth::is_proxied(&headers) {
                return auth_error(
                    StatusCode::FORBIDDEN,
                    "Set the first password on the ADBoard host's network, or with ADBOARD_PASSWORD.",
                );
            }
        }
    }
    let username = body
        .username
        .as_deref()
        .filter(|u| !u.trim().is_empty())
        .map(str::to_string)
        .or(current_user)
        .unwrap_or_else(|| web_auth::DEFAULT_USERNAME.to_string());
    if let Err(message) = auth.set_credentials(&username, &body.new_password) {
        return auth_error(StatusCode::BAD_REQUEST, &message);
    }
    info!(%username, "ADBoard account password changed");
    let id = auth.create_session();
    let mut response = Json(serde_json::json!({ "ok": true, "username": username })).into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        web_auth::session_set_cookie(&id, web_auth::is_https(&headers)),
    );
    response
}

async fn logout(Extension(auth): Extension<Arc<WebAuth>>, headers: HeaderMap) -> Response {
    auth.end_session(&headers);
    let mut response = StatusCode::NO_CONTENT.into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        web_auth::session_clear_cookie(web_auth::is_https(&headers)),
    );
    response
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
    })
}

async fn list_devices(State(state): State<AppState>) -> Json<Vec<adboard_protocol::Device>> {
    Json(state.list_devices().await)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct WirelessConnectBody {
    address: String,
    #[serde(default)]
    port: Option<u16>,
    #[serde(default)]
    pairing_port: Option<u16>,
    #[serde(default)]
    pairing_code: Option<String>,
}

#[derive(serde::Serialize)]
struct WirelessResult {
    endpoint: String,
    message: String,
}

#[derive(serde::Serialize)]
struct WirelessList {
    endpoints: Vec<String>,
}

#[derive(serde::Deserialize)]
struct WirelessRemoveBody {
    address: String,
}

async fn list_wireless(State(state): State<AppState>) -> Json<WirelessList> {
    Json(WirelessList {
        endpoints: state.list_wireless(),
    })
}

async fn add_wireless(
    State(state): State<AppState>,
    Json(body): Json<WirelessConnectBody>,
) -> Result<Json<WirelessResult>, (StatusCode, String)> {
    state
        .add_wireless(
            &body.address,
            body.port,
            body.pairing_port,
            body.pairing_code.as_deref(),
        )
        .await
        .map(|(endpoint, message)| Json(WirelessResult { endpoint, message }))
        .map_err(|error| (StatusCode::BAD_REQUEST, error))
}

#[derive(serde::Serialize)]
struct QrPairBody {
    id: String,
    payload: String,
    svg: String,
}

#[derive(serde::Serialize)]
struct QrPairStatusBody {
    id: String,
    state: String,
    message: String,
    endpoint: Option<String>,
}

async fn start_qr_pair(
    State(state): State<AppState>,
) -> Result<Json<QrPairBody>, (StatusCode, String)> {
    state
        .start_qr_pair()
        .map(|info| {
            Json(QrPairBody {
                id: info.id,
                payload: info.payload,
                svg: info.svg,
            })
        })
        .map_err(|error| (StatusCode::BAD_REQUEST, error))
}

async fn qr_pair_status(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<QrPairStatusBody>, (StatusCode, String)> {
    state
        .qr_pair_status(&id)
        .map(|status| {
            Json(QrPairStatusBody {
                id: status.id,
                state: status.state,
                message: status.message,
                endpoint: status.endpoint,
            })
        })
        .ok_or((StatusCode::NOT_FOUND, "QR pairing session was not found".into()))
}

async fn cancel_qr_pair(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    if state.cancel_qr_pair(&id) {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err((StatusCode::NOT_FOUND, "QR pairing session was not found".into()))
    }
}

async fn remove_wireless(
    State(state): State<AppState>,
    Json(body): Json<WirelessRemoveBody>,
) -> Result<Json<WirelessResult>, (StatusCode, String)> {
    state
        .remove_wireless(&body.address)
        .await
        .map(|(endpoint, message)| Json(WirelessResult { endpoint, message }))
        .map_err(|error| (StatusCode::BAD_REQUEST, error))
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

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StorePutBody {
    value: serde_json::Value,
    #[serde(default)]
    base_rev: u64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct MacroRunBody {
    tab: serde_json::Value,
    #[serde(default)]
    device_ids: Vec<String>,
    #[serde(default)]
    only_step_id: Option<String>,
}

/// GET /api/macro/runs — live runs, last results and the queue, for every browser.
async fn macro_runs_list() -> Response {
    let view = crate::macro_runner::runs().view();
    Json(serde_json::json!({
        "version": view.version,
        "runs": view.runs,
        "paused": view.paused,
        "queue": crate::macro_automation::queue_progress(),
    }))
    .into_response()
}

/// POST /api/macro/runs — play a tab on the agent (it keeps going when the browser closes).
async fn macro_run_start(State(state): State<AppState>, Json(body): Json<MacroRunBody>) -> Response {
    let tab: crate::macro_runner::MacroTab = match serde_json::from_value(body.tab) {
        Ok(tab) => tab,
        Err(error) => return auth_error(StatusCode::BAD_REQUEST, &format!("macro tab is not valid: {error}")),
    };
    match crate::macro_automation::start_tab(&state, tab, body.device_ids, body.only_step_id).await {
        Ok(report) => Json(serde_json::json!({ "ok": true, "started": report.started, "skipped": report.skipped })).into_response(),
        Err(error) => auth_error(StatusCode::CONFLICT, &error),
    }
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct MacroDeviceBody {
    /// A full tab to play; else `tabId` from the shared macros; else the phone's assignment.
    #[serde(default)]
    tab: Option<serde_json::Value>,
    #[serde(default)]
    tab_id: Option<String>,
    #[serde(default)]
    only_step_id: Option<String>,
}

/// POST /api/macro/devices/{deviceId}/start|stop|pause|resume — one phone's run,
/// independent of every other phone.
async fn macro_device_action(
    State(state): State<AppState>,
    Path((device_id, action)): Path<(String, String)>,
    body: Bytes,
) -> Response {
    use crate::macro_automation::DeviceStartError;
    let runs = crate::macro_runner::runs();
    let ok = match action.as_str() {
        "start" => {
            // The body is optional: no body plays the phone's assigned macro.
            let body: MacroDeviceBody = if body.iter().all(u8::is_ascii_whitespace) {
                MacroDeviceBody::default()
            } else {
                match serde_json::from_slice(&body) {
                    Ok(b) => b,
                    Err(error) => return auth_error(StatusCode::BAD_REQUEST, &format!("body is not valid: {error}")),
                }
            };
            let tab = match (body.tab, body.tab_id) {
                (Some(value), _) => match serde_json::from_value::<crate::macro_runner::MacroTab>(value) {
                    Ok(tab) => Some(tab),
                    Err(error) => return auth_error(StatusCode::BAD_REQUEST, &format!("macro tab is not valid: {error}")),
                },
                (None, Some(id)) => match crate::macro_automation::shared_tab(&id) {
                    Some(tab) => Some(tab),
                    None => return auth_error(StatusCode::NOT_FOUND, "That macro is not in the shared macros"),
                },
                (None, None) => None,
            };
            return match crate::macro_automation::start_device(&state, &device_id, tab, body.only_step_id).await {
                Ok(run) => Json(serde_json::json!({ "ok": true, "run": run })).into_response(),
                Err(DeviceStartError::UnknownDevice) => auth_error(StatusCode::NOT_FOUND, "unknown phone"),
                Err(DeviceStartError::Offline(m)) => auth_error(StatusCode::BAD_REQUEST, &m),
                Err(DeviceStartError::NoMacro(m)) => auth_error(StatusCode::NOT_FOUND, &m),
                Err(DeviceStartError::Busy(m)) => auth_error(StatusCode::CONFLICT, &m),
            };
        }
        "stop" => runs.stop_device(&device_id),
        "pause" => runs.pause_device(&device_id),
        "resume" => runs.resume_device(&device_id),
        _ => return auth_error(StatusCode::NOT_FOUND, "unknown action"),
    };
    Json(serde_json::json!({ "ok": ok })).into_response()
}

/// POST /api/macro/runs/{tabId}/stop|pause|resume|forget
async fn macro_run_action(Path((tab_id, action)): Path<(String, String)>) -> Response {
    let runs = crate::macro_runner::runs();
    let ok = match action.as_str() {
        "stop" => runs.stop(&tab_id),
        "pause" => runs.pause(&tab_id),
        "resume" => runs.resume(&tab_id),
        "forget" => {
            runs.forget(&tab_id);
            true
        }
        "stop-all" => {
            runs.stop_all();
            true
        }
        _ => return auth_error(StatusCode::NOT_FOUND, "unknown action"),
    };
    Json(serde_json::json!({ "ok": ok })).into_response()
}

/// POST /api/macro/queue/run|stop
async fn macro_queue_action(State(state): State<AppState>, Path(action): Path<String>) -> Response {
    match action.as_str() {
        "run" => match crate::macro_automation::run_queue(state) {
            Ok(()) => Json(serde_json::json!({ "ok": true })).into_response(),
            Err(error) => auth_error(StatusCode::CONFLICT, &error),
        },
        "stop" => Json(serde_json::json!({ "ok": crate::macro_automation::stop_queue() })).into_response(),
        _ => auth_error(StatusCode::NOT_FOUND, "unknown action"),
    }
}

/// GET /api/store/{name}/history — earlier revisions, newest first.
async fn store_history(Path(name): Path<String>) -> Response {
    match crate::shared_store::store().history(&name) {
        Some(list) => Json(list).into_response(),
        None => auth_error(StatusCode::NOT_FOUND, "unknown store"),
    }
}

#[derive(serde::Deserialize)]
struct StoreRestoreBody {
    rev: u64,
}

/// POST /api/store/{name}/restore — put an earlier revision back (as a new revision).
async fn store_restore(Path(name): Path<String>, Json(body): Json<StoreRestoreBody>) -> Response {
    use crate::shared_store::PutError;
    match crate::shared_store::store().restore(&name, body.rev) {
        Ok(rev) => Json(serde_json::json!({ "rev": rev })).into_response(),
        Err(PutError::UnknownName) => auth_error(StatusCode::NOT_FOUND, "unknown store"),
        Err(PutError::Io(error)) => auth_error(StatusCode::NOT_FOUND, &error),
        Err(_) => auth_error(StatusCode::CONFLICT, "could not restore"),
    }
}

/// GET /api/store/{name} — the shared copy every browser reads.
async fn store_get(Path(name): Path<String>) -> Response {
    match crate::shared_store::store().get(&name) {
        Some(stored) => Json(stored).into_response(),
        None => auth_error(StatusCode::NOT_FOUND, "unknown store"),
    }
}

/// PUT /api/store/{name} — save if `baseRev` is current, else 409 with the current copy.
async fn store_put(Path(name): Path<String>, Json(body): Json<StorePutBody>) -> Response {
    use crate::shared_store::PutError;
    match crate::shared_store::store().put(&name, body.value, body.base_rev) {
        Ok(rev) => Json(serde_json::json!({ "rev": rev })).into_response(),
        Err(PutError::UnknownName) => auth_error(StatusCode::NOT_FOUND, "unknown store"),
        Err(PutError::TooLarge) => auth_error(StatusCode::PAYLOAD_TOO_LARGE, "too large"),
        Err(PutError::Conflict(current)) => (StatusCode::CONFLICT, Json(current)).into_response(),
        Err(PutError::Io(error)) => auth_error(StatusCode::INTERNAL_SERVER_ERROR, &error),
    }
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
) -> Result<Json<adboard_protocol::NavBroadcast>, (StatusCode, String)> {
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
        max_size: prefs.max_size,
        video_bit_rate: prefs.video_bit_rate,
        max_fps: prefs.max_fps,
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
    let body = crate::uploads::request_body(&headers, body).await?;
    let filename = header_str(&headers, "x-adboard-filename").unwrap_or("");
    let mode = header_str(&headers, "x-adboard-mode").unwrap_or("selected");
    let targets = header_str(&headers, "x-adboard-targets").unwrap_or("");
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
) -> Result<Json<adboard_protocol::DeviceCommandResponse>, (StatusCode, String)> {
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
) -> Result<Json<adboard_protocol::DeviceCommandResponse>, (StatusCode, String)> {
    let body = crate::uploads::request_body(&headers, body).await?;
    let targets = header_list(&headers, "x-adboard-targets")?;
    let filename =
        header_value(&headers, "x-adboard-filename").unwrap_or_else(|| "upload.bin".into());
    let dest =
        header_value(&headers, "x-adboard-dest").unwrap_or_else(|| "/sdcard/Download/".into());
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
    ws.protocols([WS_PROTOCOL, LEGACY_WS_PROTOCOL]).on_upgrade(move |socket| handle_socket(socket, state))
}

async fn ws_agent_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    if state.role() != Role::Controller {
        // Still upgrade so the peer gets a clean close rather than HTTP 404 mid-handshake.
        return ws.protocols([WS_PROTOCOL, LEGACY_WS_PROTOCOL]).on_upgrade(|mut socket| async move {
            let _ = socket
                .send(Message::Text(
                    r#"{"type":"notice","message":"not a controller"}"#.into(),
                ))
                .await;
            let _ = socket.close().await;
        });
    }
    ws.protocols([WS_PROTOCOL, LEGACY_WS_PROTOCOL]).on_upgrade(move |socket| handle_agent_socket(socket, state))
}

async fn ws_video_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Path(serial): Path<String>,
) -> impl IntoResponse {
    ws.protocols([WS_PROTOCOL, LEGACY_WS_PROTOCOL]).on_upgrade(move |socket| handle_video_socket(socket, state, serial))
}

async fn ws_audio_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Path(serial): Path<String>,
) -> impl IntoResponse {
    ws.protocols([WS_PROTOCOL, LEGACY_WS_PROTOCOL]).on_upgrade(move |socket| handle_audio_socket(socket, state, serial))
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
        let mut keepalive = ws_keepalive();
        loop {
            let received = tokio::select! {
                received = events.recv() => received,
                _ = keepalive.tick() => {
                    if sender.send(ws_ping()).await.is_err() {
                        break;
                    }
                    continue;
                }
            };
            match received {
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
        message: "adboard mesh v1".into(),
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
                stream: adboard_protocol::StreamState::Error,
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
                proxy_remote_stream(sender, receiver, &base, &serial, "video", state.api_token()).await;
            }
            None => {
                let frame = VideoStatusFrame {
                    serial: serial.clone(),
                    stream: adboard_protocol::StreamState::Error,
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
            stream: adboard_protocol::StreamState::Error,
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
    // A cached IDR is from earlier in the GOP. Predicted frames after it were
    // not encoded from that IDR, and the browser paints them solid green until
    // Refresh (`RESET_VIDEO`). Hold this socket on the next IDR and ask for one.
    let scrcpy_live = frame.backend == "scrcpy";
    if scrcpy_live {
        let sessions = state.inner.sessions.clone();
        let serial_reset = serial.clone();
        tokio::spawn(async move {
            for attempt in 0..8 {
                match sessions.reset_video(&serial_reset).await {
                    Ok(()) => {
                        debug!(%serial_reset, "requested a fresh video keyframe");
                        break;
                    }
                    Err(e) => {
                        if attempt == 7 {
                            debug!(%serial_reset, error = %e, "fresh keyframe request failed");
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                    }
                }
            }
        });
    }
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
        // Scrcpy sockets always wait: the replayed IDR must not be followed by
        // later P-frames. The keyframe requested above ends the wait.
        let mut wait_for_key = scrcpy_live;
        let mut keepalive = ws_keepalive();
        loop {
            tokio::select! {
                _ = keepalive.tick() => {
                    if sender.send(ws_ping()).await.is_err() {
                        break;
                    }
                }
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
            frame.stream = adboard_protocol::StreamState::Error;
            frame.note = e;
            let _ = send_json(&mut sender, &frame).await;
            return;
        }
    };

    if let Some(host_id) = state.remote_owner(&serial).await {
        match state.remote_http_base(&host_id).await {
            Some(base) => {
                info!(%serial, %host_id, "proxying audio WS to agent");
                proxy_remote_stream(sender, receiver, &base, &serial, "audio", state.api_token()).await;
            }
            None => {
                let mut frame = state.inner.sessions.audio_status(&serial).await;
                frame.stream = adboard_protocol::StreamState::Error;
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
        let mut keepalive = ws_keepalive();
        loop {
            let received = tokio::select! {
                received = audio_rx.recv() => received,
                _ = keepalive.tick() => {
                    if sender.send(ws_ping()).await.is_err() {
                        break;
                    }
                    continue;
                }
            };
            match received {
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
    token: &str,
) {
    let ws_url = http_to_ws_device_url(agent_http_base, serial, channel);
    // Agents share ADBOARD_TOKEN with the controller; send it as a header.
    let connected = match crate::mesh_client::ws_request_with_token(&ws_url, token) {
        Ok(request) => tokio_tungstenite::connect_async(request).await,
        Err(e) => Err(e),
    };
    let (agent_ws, _) = match connected {
        Ok(pair) => pair,
        Err(e) => {
            let frame = VideoStatusFrame {
                serial: serial.into(),
                stream: adboard_protocol::StreamState::Error,
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
    use adboard_protocol::Role;
    use tower::ServiceExt;

    fn apk_request(filename: &str, targets: &str, bytes: &'static [u8], token: &str) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri("/api/input/install")
            .header("x-adboard-mode", "selected")
            .header("x-adboard-targets", targets)
            .header("x-adboard-filename", filename)
            .header(TOKEN_HEADER, token)
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
        let token = state.api_token().to_string();
        let devices = state.list_devices().await;
        let id = devices
            .iter()
            .find(|d| d.status == adboard_protocol::DeviceStatus::Online)
            .expect("online device")
            .id
            .clone();
        let app = router_with_auth(state, WebAuth::new(None, false));

        let rejected = app
            .clone()
            .oneshot(apk_request("notes.txt", &id, b"PK\x03\x04nope", &token))
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
            .oneshot(apk_request("demo.apk", &id, b"PK\x03\x04fake-apk", &token))
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
        let token = state.api_token().to_string();
        let devices = state.list_devices().await;
        let id = devices
            .iter()
            .find(|d| d.status == adboard_protocol::DeviceStatus::Online)
            .expect("online device")
            .id
            .clone();
        let app = router_with_auth(state, WebAuth::new(None, false));
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/device/command")
                    .header("content-type", "application/json")
                    .header(TOKEN_HEADER, &token)
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
    async fn api_rejects_missing_token_and_serves_bootstrap() {
        let state = AppState::new(
            Role::Controller,
            "token-test".into(),
            "token-test".into(),
            0,
            None,
        );
        let token = state.api_token().to_string();
        let app = router_with_auth(state, WebAuth::new(None, false));

        let denied = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/device/command")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"targetIds":["s24"],"op":"shell","arg":"id"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);

        let boot = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/bootstrap")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(boot.status(), StatusCode::OK);
        let boot_text = body_text(boot).await;
        assert!(boot_text.contains(&token), "{boot_text}");

        let forbidden = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/bootstrap")
                    .header("origin", "https://evil.example")
                    .header("host", "127.0.0.1:3848")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);

        let health = app
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(health.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn api_accepts_new_and_legacy_token_headers() {
        let state = AppState::new(Role::Controller, "hdr-test".into(), "hdr-test".into(), 0, None);
        let token = state.api_token().to_string();
        let app = router_with_auth(state, WebAuth::new(None, false));
        for name in [TOKEN_HEADER, LEGACY_TOKEN_HEADER] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri("/api/devices")
                        .header(name, &token)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK, "{name}");
        }
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
        let token = state.api_token().to_string();
        let devices = state.list_devices().await;
        let id = devices
            .iter()
            .find(|d| d.status == adboard_protocol::DeviceStatus::Online)
            .expect("online device")
            .id
            .clone();
        let app = router_with_auth(state, WebAuth::new(None, false));

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/scrcpy/options")
                    .header("content-type", "application/json")
                    .header(TOKEN_HEADER, &token)
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
                    .header(TOKEN_HEADER, &token)
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
                    .header(TOKEN_HEADER, &token)
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
                    .header(TOKEN_HEADER, &token)
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
        let token = state.api_token().to_string();
        let devices = state.list_devices().await;
        let id = devices
            .iter()
            .find(|d| d.status == adboard_protocol::DeviceStatus::Online)
            .expect("online device")
            .id
            .clone();
        let app = router_with_auth(state, WebAuth::new(None, false));

        let text = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/input/text")
                    .header("content-type", "application/json")
                    .header(TOKEN_HEADER, &token)
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
                    .header(TOKEN_HEADER, &token)
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
        let token = state.api_token().to_string();
        let app = router_with_auth(state, WebAuth::new(None, false));
        let response = app
            .oneshot(apk_request("demo.apk", id, b"this is not a zip", &token))
            .await
            .unwrap();
        let status = response.status();
        let text = body_text(response).await;
        (status, text)
    }

    fn auth_state() -> AppState {
        AppState::new(Role::Controller, "auth-test".into(), "auth-test".into(), 0, None)
    }

    fn get(uri: &str, headers: &[(&str, &str)]) -> Request<Body> {
        let mut builder = Request::builder().uri(uri);
        for (name, value) in headers {
            builder = builder.header(*name, *value);
        }
        builder.body(Body::empty()).unwrap()
    }

    fn login_request(password: &str, headers: &[(&str, &str)]) -> Request<Body> {
        let mut builder = Request::builder()
            .method("POST")
            .uri("/api/login")
            .header("content-type", "application/json");
        for (name, value) in headers {
            builder = builder.header(*name, *value);
        }
        builder
            .body(Body::from(format!(r#"{{"password":"{password}"}}"#)))
            .unwrap()
    }

    #[tokio::test]
    async fn bootstrap_refuses_proxied_requests_without_password() {
        let app = router_with_auth(auth_state(), WebAuth::new(None, false));
        let lan = app.clone().oneshot(get("/api/bootstrap", &[])).await.unwrap();
        assert_eq!(lan.status(), StatusCode::OK);

        let proxied = app
            .clone()
            .oneshot(get(
                "/api/bootstrap",
                &[("x-forwarded-for", "203.0.113.9"), ("cf-ray", "abc")],
            ))
            .await
            .unwrap();
        assert_eq!(proxied.status(), StatusCode::FORBIDDEN);
        assert!(body_text(proxied).await.contains("ADBOARD_PASSWORD"));

        let session = app
            .oneshot(get("/api/session", &[("x-forwarded-for", "203.0.113.9")]))
            .await
            .unwrap();
        assert!(body_text(session).await.contains(r#""proxyBlocked":true"#));

        let allowed = router_with_auth(auth_state(), WebAuth::new(None, true))
            .oneshot(get("/api/bootstrap", &[("x-forwarded-for", "203.0.113.9")]))
            .await
            .unwrap();
        assert_eq!(allowed.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn password_sign_in_flow() {
        let state = auth_state();
        let token = state.api_token().to_string();
        let app = router_with_auth(state, WebAuth::new(Some("open sesame".into()), false));
        let proxy = [
            ("host", "adboard.example.com"),
            ("origin", "https://adboard.example.com"),
            ("x-forwarded-for", "203.0.113.9"),
            ("x-forwarded-proto", "https"),
        ];

        let anon = app.clone().oneshot(get("/api/bootstrap", &proxy)).await.unwrap();
        assert_eq!(anon.status(), StatusCode::UNAUTHORIZED);
        assert!(!body_text(anon).await.contains(&token));

        let wrong = app.clone().oneshot(login_request("nope", &proxy)).await.unwrap();
        assert_eq!(wrong.status(), StatusCode::UNAUTHORIZED);
        assert!(wrong.headers().get(header::SET_COOKIE).is_none());

        let evil = app
            .clone()
            .oneshot(login_request(
                "open sesame",
                &[("host", "adboard.example.com"), ("origin", "https://evil.example")],
            ))
            .await
            .unwrap();
        assert_eq!(evil.status(), StatusCode::FORBIDDEN);

        let ok = app.clone().oneshot(login_request("open sesame", &proxy)).await.unwrap();
        assert_eq!(ok.status(), StatusCode::OK);
        let set_cookie = ok.headers()[header::SET_COOKIE].to_str().unwrap().to_string();
        assert!(set_cookie.contains("HttpOnly") && set_cookie.contains("Secure"), "{set_cookie}");
        let cookie = set_cookie.split(';').next().unwrap().to_string();

        let mut with_cookie = proxy.to_vec();
        with_cookie.push(("cookie", cookie.as_str()));
        let boot = app.clone().oneshot(get("/api/bootstrap", &with_cookie)).await.unwrap();
        assert_eq!(boot.status(), StatusCode::OK);
        assert!(body_text(boot).await.contains(&token));

        let session = app.clone().oneshot(get("/api/session", &with_cookie)).await.unwrap();
        let text = body_text(session).await;
        assert!(text.contains(r#""authRequired":true"#) && text.contains(r#""authenticated":true"#), "{text}");

        let mut logout = Request::builder().method("POST").uri("/api/logout");
        for (name, value) in &with_cookie {
            logout = logout.header(*name, *value);
        }
        let out = app.clone().oneshot(logout.body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(out.status(), StatusCode::NO_CONTENT);
        assert!(out.headers()[header::SET_COOKIE].to_str().unwrap().contains("Max-Age=0"));

        let after = app.oneshot(get("/api/bootstrap", &with_cookie)).await.unwrap();
        assert_eq!(after.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn cache_headers_by_path() {
        let app: Router = Router::new()
            .route("/api/devices", axum::routing::get(|| async { "[]" }))
            .route("/_next/static/chunks/app.js", axum::routing::get(|| async { "js" }))
            .route("/sw.js", axum::routing::get(|| async { "sw" }))
            .route("/", axum::routing::get(|| async { "html" }))
            .layer(middleware::from_fn(cache_headers));
        for (path, expected) in [
            ("/api/devices", "no-store"),
            ("/_next/static/chunks/app.js", "public, max-age=31536000, immutable"),
            ("/sw.js", "no-cache"),
            ("/", "no-cache"),
        ] {
            let response = app.clone().oneshot(get(path, &[])).await.unwrap();
            assert_eq!(response.headers()[header::CACHE_CONTROL], expected, "{path}");
        }
    }

    fn hex(token: &str) -> String {
        token.bytes().map(|b| format!("{b:02x}")).collect()
    }

    #[tokio::test]
    async fn websocket_accepts_token_as_subprotocol() {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        let state = auth_state();
        let token = state.api_token().to_string();
        let app = router_with_auth(state, WebAuth::new(None, false));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        // No token anywhere: refused.
        assert!(tokio_tungstenite::connect_async(format!("ws://{addr}/ws")).await.is_err());

        // Token only in Sec-WebSocket-Protocol, nothing in the URL.
        let mut request = format!("ws://{addr}/ws").into_client_request().unwrap();
        request.headers_mut().insert(
            "sec-websocket-protocol",
            format!("adboard, adboard-token.{}", hex(&token)).parse().unwrap(),
        );
        let (_socket, response) = tokio_tungstenite::connect_async(request).await.unwrap();
        assert_eq!(response.headers()["sec-websocket-protocol"], "adboard");

        // A UI from before the rename (still open in a tab) keeps working.
        let mut legacy = format!("ws://{addr}/ws").into_client_request().unwrap();
        legacy.headers_mut().insert(
            "sec-websocket-protocol",
            format!("rasiel, rasiel-token.{}", hex(&token)).parse().unwrap(),
        );
        let (_legacy_socket, legacy_response) = tokio_tungstenite::connect_async(legacy).await.unwrap();
        assert_eq!(legacy_response.headers()["sec-websocket-protocol"], "rasiel");

        // Wrong token in the subprotocol: refused.
        let mut bad = format!("ws://{addr}/ws").into_client_request().unwrap();
        bad.headers_mut().insert(
            "sec-websocket-protocol",
            format!("adboard, adboard-token.{}", hex("nope")).parse().unwrap(),
        );
        assert!(tokio_tungstenite::connect_async(bad).await.is_err());

        // Server-to-server: the token header works too.
        let header = crate::mesh_client::ws_request_with_token(&format!("ws://{addr}/ws"), &token).unwrap();
        assert!(!header.uri().to_string().contains("token="));
        assert!(tokio_tungstenite::connect_async(header).await.is_ok());
    }

    #[tokio::test]
    async fn upload_chunks_go_through_the_router() {
        let state = auth_state();
        let token = state.api_token().to_string();
        let app = router_with_auth(state, WebAuth::new(None, false));
        let id = format!("router-{}", uuid::Uuid::new_v4().simple());
        let response = app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri(format!("/api/uploads/{id}"))
                    .header(TOKEN_HEADER, &token)
                    .header("x-adboard-offset", "0")
                    .body(Body::from(vec![7u8; 1024]))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(body_text(response).await.contains(r#""received":1024"#));
        let mut headers = HeaderMap::new();
        headers.insert(crate::uploads::UPLOAD_HEADER, id.parse().unwrap());
        let staged = crate::uploads::request_body(&headers, Bytes::new()).await.unwrap();
        assert_eq!(staged.len(), 1024);
    }

    fn change_request(body: &str, headers: &[(&str, &str)]) -> Request<Body> {
        let mut builder = Request::builder()
            .method("POST")
            .uri("/api/account/password")
            .header("content-type", "application/json");
        for (name, value) in headers {
            builder = builder.header(*name, *value);
        }
        builder.body(Body::from(body.to_string())).unwrap()
    }

    #[tokio::test]
    async fn password_can_be_set_and_changed() {
        // No account: refused through a proxy, allowed on the LAN.
        let app = router_with_auth(auth_state(), WebAuth::new(None, false));
        let proxied = app
            .clone()
            .oneshot(change_request(
                r#"{"newPassword":"lan-first-1"}"#,
                &[("x-forwarded-for", "203.0.113.9")],
            ))
            .await
            .unwrap();
        assert_eq!(proxied.status(), StatusCode::FORBIDDEN);
        let lan = app
            .clone()
            .oneshot(change_request(r#"{"username":"ops","newPassword":"lan-first-1"}"#, &[]))
            .await
            .unwrap();
        assert_eq!(lan.status(), StatusCode::OK);
        let cookie = lan.headers()[header::SET_COOKIE].to_str().unwrap().split(';').next().unwrap().to_string();

        // Now an account exists: changing needs a session and the current password.
        let anon = app
            .clone()
            .oneshot(change_request(r#"{"currentPassword":"lan-first-1","newPassword":"changed-22"}"#, &[]))
            .await
            .unwrap();
        assert_eq!(anon.status(), StatusCode::UNAUTHORIZED);
        let wrong = app
            .clone()
            .oneshot(change_request(
                r#"{"currentPassword":"nope","newPassword":"changed-22"}"#,
                &[("cookie", &cookie)],
            ))
            .await
            .unwrap();
        assert_eq!(wrong.status(), StatusCode::UNAUTHORIZED);
        let short = app
            .clone()
            .oneshot(change_request(
                r#"{"currentPassword":"lan-first-1","newPassword":"short"}"#,
                &[("cookie", &cookie)],
            ))
            .await
            .unwrap();
        assert_eq!(short.status(), StatusCode::BAD_REQUEST);
        let ok = app
            .clone()
            .oneshot(change_request(
                r#"{"currentPassword":"lan-first-1","newPassword":"changed-22"}"#,
                &[("cookie", &cookie)],
            ))
            .await
            .unwrap();
        assert_eq!(ok.status(), StatusCode::OK);

        // Old cookie is gone; new password signs in as the same user.
        let old = app.clone().oneshot(get("/api/bootstrap", &[("cookie", &cookie)])).await.unwrap();
        assert_eq!(old.status(), StatusCode::UNAUTHORIZED);
        let mut login = Request::builder()
            .method("POST")
            .uri("/api/login")
            .header("content-type", "application/json");
        login = login.header("x-test", "1");
        let signed = app
            .oneshot(login.body(Body::from(r#"{"username":"ops","password":"changed-22"}"#)).unwrap())
            .await
            .unwrap();
        assert_eq!(signed.status(), StatusCode::OK);
    }
}

