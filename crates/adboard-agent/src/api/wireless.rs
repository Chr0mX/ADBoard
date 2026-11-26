//! Wi-Fi ADB: list, add and remove wireless phones, and pair a new one by QR code.
use super::*;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WirelessConnectBody {
    address: String,
    #[serde(default)]
    port: Option<u16>,
    #[serde(default)]
    pairing_port: Option<u16>,
    #[serde(default)]
    pairing_code: Option<String>,
}

#[derive(serde::Serialize)]
pub(super) struct WirelessResult {
    endpoint: String,
    message: String,
}

#[derive(serde::Serialize)]
pub(super) struct WirelessList {
    endpoints: Vec<String>,
}

#[derive(serde::Deserialize)]
pub(super) struct WirelessRemoveBody {
    address: String,
}

pub(super) async fn list_wireless(State(state): State<AppState>) -> Json<WirelessList> {
    Json(WirelessList {
        endpoints: state.list_wireless(),
    })
}

pub(super) async fn add_wireless(
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
pub(super) struct QrPairBody {
    id: String,
    payload: String,
    svg: String,
}

#[derive(serde::Serialize)]
pub(super) struct QrPairStatusBody {
    id: String,
    state: String,
    message: String,
    endpoint: Option<String>,
}

pub(super) async fn start_qr_pair(
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

pub(super) async fn qr_pair_status(
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
        .ok_or((
            StatusCode::NOT_FOUND,
            "QR pairing session was not found".into(),
        ))
}

pub(super) async fn cancel_qr_pair(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    if state.cancel_qr_pair(&id) {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err((
            StatusCode::NOT_FOUND,
            "QR pairing session was not found".into(),
        ))
    }
}

pub(super) async fn remove_wireless(
    State(state): State<AppState>,
    Json(body): Json<WirelessRemoveBody>,
) -> Result<Json<WirelessResult>, (StatusCode, String)> {
    state
        .remove_wireless(&body.address)
        .await
        .map(|(endpoint, message)| Json(WirelessResult { endpoint, message }))
        .map_err(|error| (StatusCode::BAD_REQUEST, error))
}
