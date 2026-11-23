//! Input and device routes: video refresh, scrcpy options, clipboard, text and key input, APK install, and the device command, push and pull endpoints.
use super::*;

pub(super) async fn input_refresh(
    State(state): State<AppState>,
    Json(body): Json<VideoRefreshRequest>,
) -> Result<Json<ClipboardResponse>, (StatusCode, String)> {
    state
        .handle_video_refresh(body)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))
}

pub(super) async fn input_nav(
    State(state): State<AppState>,
    Json(body): Json<NavRequest>,
) -> Result<Json<adboard_protocol::NavBroadcast>, (StatusCode, String)> {
    state
        .handle_nav(body.mode, &body.target_ids, body.action.action_type)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))
}

pub(super) async fn scrcpy_options_get(
    State(state): State<AppState>,
) -> Json<ScrcpyOptionsResponse> {
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

pub(super) async fn scrcpy_options_set(
    State(state): State<AppState>,
    Json(body): Json<ScrcpyOptionsRequest>,
) -> Result<Json<ScrcpyOptionsResponse>, (StatusCode, String)> {
    state
        .handle_scrcpy_options(body)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))
}

pub(super) async fn clipboard_set(
    State(state): State<AppState>,
    Json(body): Json<ClipboardSetRequest>,
) -> Result<Json<ClipboardResponse>, (StatusCode, String)> {
    state
        .handle_clipboard_set(body)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))
}

pub(super) async fn input_text(
    State(state): State<AppState>,
    Json(body): Json<TextInjectRequest>,
) -> Result<Json<ClipboardResponse>, (StatusCode, String)> {
    state
        .handle_text(body)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))
}

pub(super) async fn input_key(
    State(state): State<AppState>,
    Json(body): Json<KeyInjectRequest>,
) -> Result<Json<ClipboardResponse>, (StatusCode, String)> {
    state
        .handle_key(body)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))
}

pub(super) async fn clipboard_pull(
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
pub(super) async fn input_install(
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
    let result = state
        .handle_install(mode, &target_ids, filename.trim(), &body)
        .await;
    if let Ok(broadcast) = &result {
        crate::events::record_install(filename.trim(), &broadcast.targets);
    }
    result.map(Json).map_err(|e| (StatusCode::BAD_REQUEST, e))
}

pub(super) fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

pub(super) fn parse_control_mode(value: &str) -> Result<ControlMode, String> {
    match value.trim() {
        "selected" => Ok(ControlMode::Selected),
        "multi" => Ok(ControlMode::Multi),
        "all" => Ok(ControlMode::All),
        other => Err(format!("unknown control mode: {other}")),
    }
}

pub(super) fn validate_apk_upload(filename: &str, bytes: &[u8]) -> Result<(), String> {
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

pub(super) async fn device_command(
    State(state): State<AppState>,
    Json(body): Json<DeviceCommandRequest>,
) -> Result<Json<adboard_protocol::DeviceCommandResponse>, (StatusCode, String)> {
    let (op, arg) = (body.op.clone(), body.arg.clone());
    // Status reads of Shizuku and the phone tweaks change nothing.
    let read_only = match op.as_str() {
        "shizuku" => !matches!(body.arg.as_deref(), Some("start")),
        "tweak" => matches!(body.arg2.as_deref(), None | Some("status")),
        _ => false,
    };
    let result = state.handle_command(body).await;
    if let (Ok(response), false) = (&result, read_only) {
        crate::events::record_command(&op, arg.as_deref(), &response.results);
    }
    result.map(Json).map_err(|e| (StatusCode::BAD_REQUEST, e))
}

pub(super) async fn device_push(
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

pub(super) async fn device_pull(
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
pub(super) struct PullQuery {
    #[serde(rename = "deviceId")]
    device_id: String,
    path: String,
}
