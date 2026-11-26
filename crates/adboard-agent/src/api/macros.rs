//! Macro runs, schedules (cron preview), the offline OCR used by text steps, and the named JSON store.
use super::*;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StorePutBody {
    value: serde_json::Value,
    #[serde(default)]
    base_rev: u64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MacroRunBody {
    tab: serde_json::Value,
    #[serde(default)]
    device_ids: Vec<String>,
    #[serde(default)]
    only_step_id: Option<String>,
}

/// GET /api/macro/runs — live runs, last results and the queue, for every browser.
pub(super) async fn macro_runs_list() -> Response {
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
pub(super) async fn macro_run_start(
    State(state): State<AppState>,
    Json(body): Json<MacroRunBody>,
) -> Response {
    let tab: crate::macro_runner::MacroTab = match serde_json::from_value(body.tab) {
        Ok(tab) => tab,
        Err(error) => {
            return auth_error(
                StatusCode::BAD_REQUEST,
                &format!("macro tab is not valid: {error}"),
            )
        }
    };
    match crate::macro_automation::start_tab(&state, tab, body.device_ids, body.only_step_id).await
    {
        Ok(report) => Json(
            serde_json::json!({ "ok": true, "started": report.started, "skipped": report.skipped }),
        )
        .into_response(),
        Err(error) => auth_error(StatusCode::CONFLICT, &error),
    }
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MacroDeviceBody {
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
pub(super) async fn macro_device_action(
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
                    Err(error) => {
                        return auth_error(
                            StatusCode::BAD_REQUEST,
                            &format!("body is not valid: {error}"),
                        )
                    }
                }
            };
            let tab = match (body.tab, body.tab_id) {
                (Some(value), _) => {
                    match serde_json::from_value::<crate::macro_runner::MacroTab>(value) {
                        Ok(tab) => Some(tab),
                        Err(error) => {
                            return auth_error(
                                StatusCode::BAD_REQUEST,
                                &format!("macro tab is not valid: {error}"),
                            )
                        }
                    }
                }
                (None, Some(id)) => match crate::macro_automation::shared_tab(&id) {
                    Some(tab) => Some(tab),
                    None => {
                        return auth_error(
                            StatusCode::NOT_FOUND,
                            "That macro is not in the shared macros",
                        )
                    }
                },
                (None, None) => None,
            };
            return match crate::macro_automation::start_device(
                &state,
                &device_id,
                tab,
                body.only_step_id,
            )
            .await
            {
                Ok(run) => Json(serde_json::json!({ "ok": true, "run": run })).into_response(),
                Err(DeviceStartError::UnknownDevice) => {
                    auth_error(StatusCode::NOT_FOUND, "unknown phone")
                }
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

#[derive(Debug, serde::Deserialize)]
pub(super) struct CronQuery {
    expr: String,
    #[serde(default)]
    count: Option<usize>,
}

/// GET /api/macro/cron?expr=…&count=3 — check a cron expression and list its
/// next runs on this computer's clock (the clock schedules run on).
pub(super) async fn macro_cron_preview(Query(query): Query<CronQuery>) -> Response {
    match crate::cron::parse(&query.expr) {
        Ok(cron) => {
            let mut next = Vec::new();
            let mut after = crate::macro_runner::now_ms();
            for _ in 0..query.count.unwrap_or(3).clamp(1, 10) {
                match crate::cron::next_local(&cron, after) {
                    Some(t) => {
                        next.push(t);
                        after = t;
                    }
                    None => break,
                }
            }
            Json(serde_json::json!({ "next": next, "utcOffsetMinutes": crate::cron::local_offset_minutes() })).into_response()
        }
        Err(error) => auth_error(StatusCode::BAD_REQUEST, &error),
    }
}

/// GET /api/ocr/status — can this ADBoard read text (models installed)?
pub(super) async fn ocr_status(State(state): State<AppState>) -> Response {
    Json(crate::ocr::status(&state).await).into_response()
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct OcrReadBody {
    device_id: String,
    /// 0–1 of the screen; whole screen when missing.
    #[serde(default)]
    area: Option<crate::ocr::Area>,
    /// Also report where these texts are (the step editor's highlight).
    #[serde(default)]
    query: Option<crate::ocr::TextQuery>,
    /// Keep per-character boxes (a controller reading a phone on this host).
    #[serde(default)]
    with_chars: bool,
}

/// POST /api/ocr/read — the text on a phone's screen now, with boxes as 0–1
/// of the screen (and the query's matches when one is given).
pub(super) async fn ocr_read(
    State(state): State<AppState>,
    Json(body): Json<OcrReadBody>,
) -> Response {
    use crate::ocr::ReadErrorKind;
    let mut screen = match crate::ocr::read_screen(&state, &body.device_id, body.area).await {
        Ok(screen) => screen,
        Err(error) => {
            let status = match error.kind {
                ReadErrorKind::Unavailable => StatusCode::SERVICE_UNAVAILABLE,
                ReadErrorKind::UnknownDevice => StatusCode::NOT_FOUND,
                ReadErrorKind::Failed => StatusCode::BAD_GATEWAY,
            };
            return auth_error(status, &error.message);
        }
    };
    let matches = match &body.query {
        Some(query) => match crate::ocr::find_matches(&screen.lines, query) {
            Ok(found) => found,
            Err(error) => return auth_error(StatusCode::BAD_REQUEST, &error),
        },
        None => Vec::new(),
    };
    if !body.with_chars {
        screen.lines.iter_mut().for_each(|line| line.chars.clear());
    }
    let mut value = serde_json::to_value(&screen).unwrap_or_default();
    if body.query.is_some() {
        value["matches"] = serde_json::to_value(matches).unwrap_or_default();
    }
    Json(value).into_response()
}

/// POST /api/macro/runs/{tabId}/stop|pause|resume|forget
pub(super) async fn macro_run_action(Path((tab_id, action)): Path<(String, String)>) -> Response {
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
pub(super) async fn macro_queue_action(
    State(state): State<AppState>,
    Path(action): Path<String>,
) -> Response {
    match action.as_str() {
        "run" => match crate::macro_automation::run_queue(state) {
            Ok(()) => Json(serde_json::json!({ "ok": true })).into_response(),
            Err(error) => auth_error(StatusCode::CONFLICT, &error),
        },
        "stop" => {
            Json(serde_json::json!({ "ok": crate::macro_automation::stop_queue() })).into_response()
        }
        _ => auth_error(StatusCode::NOT_FOUND, "unknown action"),
    }
}

/// GET /api/store/{name}/history — earlier revisions, newest first.
pub(super) async fn store_history(Path(name): Path<String>) -> Response {
    match crate::shared_store::store().history(&name) {
        Some(list) => Json(list).into_response(),
        None => auth_error(StatusCode::NOT_FOUND, "unknown store"),
    }
}

#[derive(serde::Deserialize)]
pub(super) struct StoreRestoreBody {
    rev: u64,
}

/// POST /api/store/{name}/restore — put an earlier revision back (as a new revision).
pub(super) async fn store_restore(
    Path(name): Path<String>,
    Json(body): Json<StoreRestoreBody>,
) -> Response {
    use crate::shared_store::PutError;
    match crate::shared_store::store().restore(&name, body.rev) {
        Ok(rev) => Json(serde_json::json!({ "rev": rev })).into_response(),
        Err(PutError::UnknownName) => auth_error(StatusCode::NOT_FOUND, "unknown store"),
        Err(PutError::Io(error)) => auth_error(StatusCode::NOT_FOUND, &error),
        Err(_) => auth_error(StatusCode::CONFLICT, "could not restore"),
    }
}

/// GET /api/store/{name} — the shared copy every browser reads.
pub(super) async fn store_get(Path(name): Path<String>) -> Response {
    match crate::shared_store::store().get(&name) {
        Some(stored) => Json(stored).into_response(),
        None => auth_error(StatusCode::NOT_FOUND, "unknown store"),
    }
}

/// PUT /api/store/{name} — save if `baseRev` is current, else 409 with the current copy.
pub(super) async fn store_put(
    Path(name): Path<String>,
    Json(body): Json<StorePutBody>,
) -> Response {
    use crate::shared_store::PutError;
    match crate::shared_store::store().put(&name, body.value, body.base_rev) {
        Ok(rev) => Json(serde_json::json!({ "rev": rev })).into_response(),
        Err(PutError::UnknownName) => auth_error(StatusCode::NOT_FOUND, "unknown store"),
        Err(PutError::TooLarge) => auth_error(StatusCode::PAYLOAD_TOO_LARGE, "too large"),
        Err(PutError::Conflict(current)) => (StatusCode::CONFLICT, Json(current)).into_response(),
        Err(PutError::Io(error)) => auth_error(StatusCode::INTERNAL_SERVER_ERROR, &error),
    }
}
