//! API token and password sign-in: token lookup from headers and the WebSocket subprotocol, the origin/host checks for bootstrap, and the login, logout, session and password routes.
use super::*;

/// Browsers cannot set headers on a WebSocket, so the UI offers the token as a
/// subprotocol (`adboard-token.<hex>`) instead of `?token=`, which proxies and
/// Cloudflare would log. The server answers with the plain `adboard` protocol.
pub const WS_PROTOCOL: &str = "adboard";
/// Accepted from UIs built before the ADBoard rename (tabs left open).
pub(super) const LEGACY_WS_PROTOCOL: &str = "rasiel";
pub(super) const WS_TOKEN_PROTOCOL_PREFIXES: [&str; 2] = ["adboard-token.", "rasiel-token."];

pub(super) fn token_from_ws_protocol(headers: &HeaderMap) -> Option<String> {
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

pub(super) fn token_from_request(headers: &HeaderMap, uri: &axum::http::Uri) -> Option<String> {
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

pub(super) fn origin_allowed_for_bootstrap(headers: &HeaderMap) -> bool {
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

/// The host name from a `Host` header value, without the port or brackets.
pub(super) fn host_name(host: &str) -> &str {
    if let Some(rest) = host.strip_prefix('[') {
        return rest.split(']').next().unwrap_or("");
    }
    match host.rsplit_once(':') {
        Some((name, port)) if !name.contains(':') && port.bytes().all(|b| b.is_ascii_digit()) => {
            name
        }
        _ => host,
    }
}

/// True when the `Host` header is `localhost`, an IP address, or listed in
/// `ADBOARD_ALLOWED_HOSTS`. Rebinding attacks send a domain name here. A
/// request with no `Host` at all names no domain, and browsers always send
/// one, so that is allowed; an unreadable `Host` is not.
pub(super) fn host_is_direct(headers: &HeaderMap) -> bool {
    let Some(value) = headers.get(header::HOST) else {
        return true;
    };
    let Ok(host) = value.to_str() else {
        return false;
    };
    let name = host_name(host.trim());
    if name.eq_ignore_ascii_case("localhost") || name.parse::<std::net::IpAddr>().is_ok() {
        return true;
    }
    crate::env::var("ALLOWED_HOSTS")
        .map(|list| {
            list.split(',')
                .any(|allowed| allowed.trim().eq_ignore_ascii_case(name))
        })
        .unwrap_or(false)
}

pub(super) fn origin_matches_host(origin: &str, headers: &HeaderMap) -> bool {
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
    origin_authority.eq_ignore_ascii_case(host) || origin_host.eq_ignore_ascii_case(host)
}

/// Compare the token a request carries with the real one without stopping at
/// the first difference, so the time taken does not hint at how much matched.
pub(super) fn tokens_match(provided: &str, expected: &str) -> bool {
    let (a, b) = (provided.as_bytes(), expected.as_bytes());
    let mut diff = (a.len() ^ b.len()) as u32;
    for i in 0..a.len().max(b.len()) {
        diff |= u32::from(a.get(i).copied().unwrap_or(0) ^ b.get(i).copied().unwrap_or(0));
    }
    diff == 0
}

pub(super) async fn require_api_token(
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
        Some(token) if tokens_match(&token, state.api_token()) => Ok(next.run(request).await),
        _ => Err(StatusCode::UNAUTHORIZED),
    }
}

#[derive(serde::Serialize)]
pub(super) struct BootstrapBody {
    token: String,
}

pub(super) const PROXY_NEEDS_PASSWORD: &str = "ADBoard is being reached through a reverse proxy without a password. Set ADBOARD_PASSWORD on the ADBoard host (or ADBOARD_ALLOW_PROXY_WITHOUT_PASSWORD=1 if Cloudflare Access or similar already protects it).";

pub(super) fn auth_error(status: StatusCode, message: &str) -> Response {
    (status, Json(serde_json::json!({ "error": message }))).into_response()
}

pub(super) async fn bootstrap(
    State(state): State<AppState>,
    Extension(auth): Extension<Arc<WebAuth>>,
    headers: HeaderMap,
) -> Response {
    if !origin_allowed_for_bootstrap(&headers) {
        return auth_error(
            StatusCode::FORBIDDEN,
            "This page's origin may not use ADBoard.",
        );
    }
    if auth.password_required() {
        if !auth.session_valid(&headers) {
            return auth_error(StatusCode::UNAUTHORIZED, "Sign in to ADBoard.");
        }
    } else if auth.proxy_blocked(&headers) {
        return auth_error(StatusCode::FORBIDDEN, PROXY_NEEDS_PASSWORD);
    } else if !host_is_direct(&headers) {
        // DNS rebinding: a page on another domain can point its name at this
        // agent and read the token here. Without a password, only addresses
        // and names listed in ADBOARD_ALLOWED_HOSTS may read it.
        return auth_error(
            StatusCode::FORBIDDEN,
            "Use this computer's IP address, or add the name to ADBOARD_ALLOWED_HOSTS.",
        );
    }
    Json(BootstrapBody {
        token: state.api_token().to_string(),
    })
    .into_response()
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SessionBody {
    auth_required: bool,
    authenticated: bool,
    proxy_blocked: bool,
    /// Signed-in username (only when authenticated).
    username: Option<String>,
    /// No account yet and this is a direct LAN request: the UI may offer "Set password".
    can_set_password: bool,
}

pub(super) async fn session_status(
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
pub(super) struct LoginBody {
    #[serde(default)]
    username: Option<String>,
    password: String,
}

pub(super) async fn login(
    Extension(auth): Extension<Arc<WebAuth>>,
    headers: HeaderMap,
    Json(body): Json<LoginBody>,
) -> Response {
    if !origin_allowed_for_bootstrap(&headers) {
        return auth_error(
            StatusCode::FORBIDDEN,
            "This page's origin may not use ADBoard.",
        );
    }
    if !auth.password_required() {
        return auth_error(
            StatusCode::BAD_REQUEST,
            "No password is configured on this ADBoard host.",
        );
    }
    let username = body
        .username
        .as_deref()
        .filter(|u| !u.trim().is_empty())
        .unwrap_or(web_auth::DEFAULT_USERNAME);
    if !auth.verify_login(username, &body.password).await {
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
pub(super) struct ChangePasswordBody {
    #[serde(default)]
    current_password: String,
    #[serde(default)]
    username: Option<String>,
    new_password: String,
}

/// Change the account password (signed in, with the current password), or set
/// the first one from a direct LAN request. Ends every other session.
pub(super) async fn change_password(
    Extension(auth): Extension<Arc<WebAuth>>,
    headers: HeaderMap,
    Json(body): Json<ChangePasswordBody>,
) -> Response {
    if !origin_allowed_for_bootstrap(&headers) {
        return auth_error(
            StatusCode::FORBIDDEN,
            "This page's origin may not use ADBoard.",
        );
    }
    let current_user = auth.username();
    match &current_user {
        Some(user) => {
            if !auth.session_valid(&headers) {
                return auth_error(StatusCode::UNAUTHORIZED, "Sign in to ADBoard.");
            }
            if !auth.verify_login(user, &body.current_password).await {
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
    let mut response =
        Json(serde_json::json!({ "ok": true, "username": username })).into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        web_auth::session_set_cookie(&id, web_auth::is_https(&headers)),
    );
    response
}

pub(super) async fn logout(
    Extension(auth): Extension<Arc<WebAuth>>,
    headers: HeaderMap,
) -> Response {
    auth.end_session(&headers);
    let mut response = StatusCode::NO_CONTENT.into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        web_auth::session_clear_cookie(web_auth::is_https(&headers)),
    );
    response
}
