//! Virtual display endpoints: create, list, close, launch an app, and the per-phone limit.

use super::*;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct VirtualDisplayBody {
    #[serde(default)]
    width: Option<u32>,
    #[serde(default)]
    height: Option<u32>,
    #[serde(default)]
    dpi: Option<u32>,
    #[serde(default)]
    start_app: Option<String>,
    #[serde(default)]
    keep_content: bool,
}

#[derive(serde::Deserialize)]
pub(super) struct LaunchBody {
    component: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct VirtualDisplayLimitBody {
    /// `null` goes back to ADBOARD_MAX_VIRTUAL_DISPLAYS (default 1).
    #[serde(default)]
    max_per_phone: Option<u32>,
}

async fn virtual_display_overview_json(state: &AppState) -> serde_json::Value {
    let displays: Vec<serde_json::Value> = state
        .all_virtual_displays()
        .await
        .into_iter()
        .map(|(phone, index, spec, display_id)| {
            serde_json::json!({
                "key": crate::virtual_display::display_key(&phone.serial, index),
                "phoneId": phone.id,
                "phoneName": phone.name,
                "index": index,
                "width": spec.width,
                "height": spec.height,
                "dpi": spec.dpi,
                "startApp": spec.start_app,
                "displayId": display_id,
            })
        })
        .collect();
    serde_json::json!({
        "limit": crate::virtual_display::max_per_phone(),
        "saved": crate::virtual_display::limit_override(),
        "envLimit": crate::virtual_display::env_limit(),
        "ceiling": crate::virtual_display::CEILING_PER_PHONE,
        "displays": displays,
    })
}

/// GET /api/virtual-display — the limit and every virtual display on this computer.
pub(super) async fn virtual_display_overview(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(virtual_display_overview_json(&state).await)
}

/// PUT /api/virtual-display — set the per-phone limit (`null` = the default).
pub(super) async fn set_virtual_display_limit(
    State(state): State<AppState>,
    Json(body): Json<VirtualDisplayLimitBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    if let Some(n) = body.max_per_phone {
        if n == 0 || n > crate::virtual_display::CEILING_PER_PHONE {
            return Err((
                StatusCode::BAD_REQUEST,
                format!(
                    "the limit must be from 1 to {}",
                    crate::virtual_display::CEILING_PER_PHONE
                ),
            ));
        }
    }
    crate::virtual_display_store::save_limit(body.max_per_phone)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(virtual_display_overview_json(&state).await))
}

/// GET /api/devices/{serial}/virtual-display — the phone's virtual displays.
pub(super) async fn list_virtual_displays(
    State(state): State<AppState>,
    Path(serial): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let displays = state
        .virtual_displays(&serial)
        .await
        .map_err(|e| (StatusCode::NOT_FOUND, e))?;
    let phone = state
        .resolve_serial(&serial)
        .await
        .map_err(|e| (StatusCode::NOT_FOUND, e))?;
    let items: Vec<serde_json::Value> = displays
        .into_iter()
        .map(|(index, spec, display_id)| {
            serde_json::json!({
                "index": index,
                "key": crate::virtual_display::display_key(&phone, index),
                "width": spec.width,
                "height": spec.height,
                "dpi": spec.dpi,
                "startApp": spec.start_app,
                "displayId": display_id,
            })
        })
        .collect();
    Ok(Json(serde_json::json!({
        "limit": crate::virtual_display::max_per_phone(),
        "displays": items,
    })))
}

/// POST /api/devices/{serial}/virtual-display — create one and start streaming it.
pub(super) async fn create_virtual_display(
    State(state): State<AppState>,
    Path(serial): Path<String>,
    Json(body): Json<VirtualDisplayBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let defaults = crate::virtual_display::VirtualDisplaySpec::default();
    let spec = crate::virtual_display::VirtualDisplaySpec {
        width: body.width.unwrap_or(defaults.width),
        height: body.height.unwrap_or(defaults.height),
        dpi: body.dpi.unwrap_or(defaults.dpi),
        start_app: body
            .start_app
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        keep_content: body.keep_content,
    };
    state
        .create_virtual_display(&serial, spec)
        .await
        .map(|(device, session)| Json(serde_json::json!({ "device": device, "session": session })))
        .map_err(|e| (StatusCode::BAD_REQUEST, e))
}

/// DELETE /api/virtual-display/{key} — stop a virtual display; its apps close with it.
pub(super) async fn close_virtual_display(
    State(state): State<AppState>,
    Path(key): Path<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .close_virtual_display(&key)
        .await
        .map(|()| StatusCode::NO_CONTENT)
        .map_err(|e| (StatusCode::NOT_FOUND, e))
}

/// POST /api/virtual-display/{key}/launch — start `pkg/.Activity` on that display.
pub(super) async fn launch_on_virtual_display(
    State(state): State<AppState>,
    Path(key): Path<String>,
    Json(body): Json<LaunchBody>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .launch_on_virtual_display(&key, body.component.trim())
        .await
        .map(|()| StatusCode::NO_CONTENT)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))
}
