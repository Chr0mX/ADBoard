//! Events, the Discord notification settings and the Quiet Mode Loop routes.
use super::*;

/// GET /api/events — the event history, newest first (filters: q, severity,
/// category, device, run, since, until; paging: before, limit).
pub(super) async fn events_list(Query(query): Query<crate::events::Query>) -> Response {
    Json(crate::events::log().query(&query)).into_response()
}

#[derive(Debug, serde::Deserialize)]
pub(super) struct SummaryQuery {
    since: Option<u64>,
}

/// GET /api/events/summary — counts since `since` (default: the last 24 h).
pub(super) async fn events_summary(Query(query): Query<SummaryQuery>) -> Response {
    let since = query
        .since
        .unwrap_or_else(|| crate::events::now_ms().saturating_sub(86_400_000));
    Json(crate::events::log().summary(since)).into_response()
}

/// GET /api/events/macros — per-macro run results since `since` (default 7 days).
pub(super) async fn events_macros(Query(query): Query<SummaryQuery>) -> Response {
    let since = query
        .since
        .unwrap_or_else(|| crate::events::now_ms().saturating_sub(7 * 86_400_000));
    Json(crate::events::log().macro_stats(since)).into_response()
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ClearBody {
    /// Only events older than this (ms); everything when missing.
    #[serde(default)]
    before: Option<u64>,
}

/// POST /api/events/clear — delete history (all, or older than `before`).
pub(super) async fn events_clear(body: Option<Json<ClearBody>>) -> Response {
    let before = body.and_then(|Json(b)| b.before);
    let removed = crate::events::log().clear(before);
    crate::events::record(
        crate::events::Event::new(
            "system",
            "system.history_cleared",
            crate::events::Severity::Info,
            format!("Event history cleared ({removed} removed)"),
        )
        .source("settings"),
    );
    Json(serde_json::json!({ "removed": removed })).into_response()
}

/// GET /api/quiet-cycle — the repeating Quiet / normal cycle and the time left in this phase.
pub(super) async fn quiet_cycle_get() -> Response {
    Json(crate::quiet_cycle::status()).into_response()
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct QuietCycleBody {
    /// The quiet duration, in seconds.
    interval_secs: u64,
    /// The screen-on duration between quiet periods, 1 to 5 seconds (3 when missing).
    #[serde(default)]
    peek_secs: Option<u64>,
}

/// PUT /api/quiet-cycle — start (or restart) the Quiet Mode Loop: phones go quiet at once,
/// stay quiet for `intervalSecs`, then the screen comes on for `peekSecs` (sound stays muted),
/// and so on until stopped.
pub(super) async fn quiet_cycle_put(Json(body): Json<QuietCycleBody>) -> Response {
    if body.interval_secs == 0 {
        return auth_error(
            StatusCode::BAD_REQUEST,
            "the quiet duration must be above zero",
        );
    }
    let peek = body
        .peek_secs
        .unwrap_or(crate::quiet_cycle::DEFAULT_PEEK_SECS);
    if !crate::quiet_cycle::valid_peek(peek) {
        return auth_error(
            StatusCode::BAD_REQUEST,
            "the screen-on duration must be 1 to 5 seconds",
        );
    }
    Json(crate::quiet_cycle::start(body.interval_secs, peek)).into_response()
}

/// POST /api/quiet-cycle/stop — stop the loop and put the phones back (sound restored, screens on).
pub(super) async fn quiet_cycle_stop(State(state): State<AppState>) -> Response {
    Json(crate::quiet_cycle::stop_and_restore(&state).await).into_response()
}

/// GET /api/notifications — Discord settings and delivery status (never the URL).
pub(super) async fn notifications_get() -> Response {
    Json(crate::notify::public_settings()).into_response()
}

/// PUT /api/notifications — change some settings (missing fields stay).
pub(super) async fn notifications_put(Json(update): Json<crate::notify::Update>) -> Response {
    match crate::notify::update(update) {
        Ok(settings) => Json(settings).into_response(),
        Err(error) => auth_error(StatusCode::BAD_REQUEST, &error),
    }
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TestBody {
    /// Try this URL before saving it; the saved one when missing.
    #[serde(default)]
    webhook_url: Option<String>,
}

/// POST /api/notifications/test — send a test message to Discord now.
pub(super) async fn notifications_test(
    State(state): State<AppState>,
    body: Option<Json<TestBody>>,
) -> Response {
    let url = body.and_then(|Json(b)| b.webhook_url);
    match crate::notify::send_test(url, &state.inner.host_name).await {
        Ok(message) => Json(serde_json::json!({ "ok": true, "message": message })).into_response(),
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({ "ok": false, "error": error })),
        )
            .into_response(),
    }
}

/// Longest page report kept in one log line.
const VIDEO_REPORT_MAX: usize = 4000;

/// The part of a page report that goes in the log: one line, at most `VIDEO_REPORT_MAX` bytes, with the fields
/// that say where a picture is held first (JSON objects come out in alphabetical order, which put the pipeline
/// after the browser name and cut it off).
pub(super) fn video_report_line(body: &serde_json::Value) -> (String, String, String) {
    let field = |name: &str| -> String {
        body.get(name)
            .and_then(|v| v.as_str())
            .unwrap_or("?")
            .chars()
            .filter(|c| !c.is_control())
            .take(64)
            .collect()
    };
    let part = |name: &str| body.get(name).map(|v| v.to_string()).unwrap_or_else(|| "null".into());
    let mut detail = format!(
        "pipeline={} counters={} decodeState={} lastClose={} views={} page={} secureContext={} extra={} browser={}",
        part("pipeline"),
        part("counters"),
        part("decodeState"),
        part("lastClose"),
        part("views"),
        part("page"),
        part("secureContext"),
        serde_json::Value::Object(
            body.as_object()
                .map(|o| {
                    o.iter()
                        .filter(|(k, _)| {
                            !matches!(
                                k.as_str(),
                                "serial" | "event" | "pipeline" | "counters" | "decodeState" | "lastClose" | "views" | "page" | "secureContext" | "browser"
                            )
                        })
                        .map(|(k, v)| (k.clone(), v.clone()))
                        .collect()
                })
                .unwrap_or_default()
        ),
        part("browser"),
    );
    if detail.len() > VIDEO_REPORT_MAX {
        let mut cut = VIDEO_REPORT_MAX;
        while !detail.is_char_boundary(cut) {
            cut -= 1;
        }
        detail.truncate(cut);
        detail.push('…');
    }
    (field("serial"), field("event"), detail)
}

/// POST /api/diagnostics/video — the page saw a video problem (pictures arriving but none shown, a request that
/// did not answer, a stalled player) and says what each stage looked like. Logged, so the agent log alone shows
/// what the browser saw; nothing else is done with it.
pub(super) async fn video_problem_report(Json(body): Json<serde_json::Value>) -> StatusCode {
    let (serial, event, detail) = video_report_line(&body);
    warn!(%serial, %event, "page reports a video problem: {detail}");
    StatusCode::NO_CONTENT
}
