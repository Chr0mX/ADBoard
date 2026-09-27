//! HTTP + WebSocket API for the Phone Control UI.

use crate::device_manager::AppState;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use phonecontrol_protocol::{
    ClientCommand, HealthResponse, NavRequest, ServerEvent, SessionStatus, TapRequest,
    VideoStatusFrame,
};
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing::{debug, info, warn};

pub fn router(state: AppState) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    Router::new()
        .route("/health", get(health))
        .route("/api/health", get(health))
        .route("/api/devices", get(list_devices))
        .route("/api/sessions", get(list_sessions))
        .route("/api/sessions/{serial}", get(get_session))
        .route("/api/sessions/{serial}/start", post(start_session))
        .route("/api/sessions/{serial}/stop", post(stop_session))
        .route("/api/sessions/{serial}/restart", post(restart_session))
        .route("/api/input/tap", post(input_tap))
        .route("/api/input/nav", post(input_nav))
        .route("/ws", get(ws_upgrade))
        .route("/ws/events", get(ws_upgrade))
        .route("/ws/devices/{serial}/video", get(ws_video_upgrade))
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn health(State(state): State<AppState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok".into(),
        agent: "phonecontrol-agent".into(),
        adb: state.adb_availability(),
        scrcpy: state.scrcpy_availability(),
        inject: state.inject_mode(),
        port: state.inner.port,
    })
}

async fn list_devices(State(state): State<AppState>) -> Json<Vec<phonecontrol_protocol::Device>> {
    Json(state.list_devices().await)
}

async fn list_sessions(State(state): State<AppState>) -> Json<Vec<SessionStatus>> {
    Json(state.list_sessions().await)
}

async fn get_session(
    State(state): State<AppState>,
    Path(serial): Path<String>,
) -> Result<Json<SessionStatus>, (StatusCode, String)> {
    let serial = state.resolve_serial(&serial).await.map_err(|e| {
        (StatusCode::NOT_FOUND, e)
    })?;
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

async fn ws_upgrade(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn ws_video_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Path(serial): Path<String>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_video_socket(socket, state, serial))
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

    // Push current session snapshot so the UI can show stream state immediately.
    for session in state.list_sessions().await {
        if send_event(
            &mut sender,
            &ServerEvent::SessionUpdated { session },
        )
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
                                let devices = state_in.list_devices().await;
                                state_in.publish(ServerEvent::Devices { devices });
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
                                    .handle_nav(
                                        req.mode,
                                        &req.target_ids,
                                        req.action.action_type,
                                    )
                                    .await
                                {
                                    warn!(error = %e, "ws nav failed");
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

/// Video WS: status JSON today; binary H264 frames can be appended later on the same socket.
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
            };
            let _ = send_json(&mut sender, &frame).await;
            return;
        }
    };

    let mut events = state.subscribe();
    let session = state.session_status(&serial).await;
    let frame = VideoStatusFrame {
        serial: session.serial.clone(),
        stream: session.stream,
        note: session.note.clone(),
        backend: session.backend.clone(),
    };
    if send_json(&mut sender, &frame).await.is_err() {
        return;
    }

    let serial_filter = serial.clone();
    let mut send_task = tokio::spawn(async move {
        loop {
            match events.recv().await {
                Ok(ServerEvent::SessionUpdated { session }) if session.serial == serial_filter => {
                    let frame = VideoStatusFrame {
                        serial: session.serial.clone(),
                        stream: session.stream,
                        note: session.note.clone(),
                        backend: session.backend.clone(),
                    };
                    if send_json(&mut sender, &frame).await.is_err() {
                        break;
                    }
                }
                Ok(_) => {}
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = receiver.next().await {
            match msg {
                Message::Close(_) => break,
                Message::Ping(_) | Message::Pong(_) | Message::Text(_) | Message::Binary(_) => {
                    // Future: client→server control for the video socket.
                }
            }
        }
    });

    tokio::select! {
        _ = &mut send_task => recv_task.abort(),
        _ = &mut recv_task => send_task.abort(),
    }
    info!(%serial, "video websocket disconnected");
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
