//! Outbound agent → controller WebSocket client.

use crate::device_manager::AppState;
use futures_util::{SinkExt, StreamExt};
use phonecontrol_protocol::{
    now_ms, AgentHello, AgentToController, ControllerToAgent, SessionAction,
};
use std::time::Duration;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{error, info, warn};

const HEARTBEAT_SECS: u64 = 5;
const RECONNECT_SECS: u64 = 3;

/// Run forever: connect to controller, register, forward devices, handle proxies.
pub async fn run_agent_client(state: AppState, url: String) {
    let url = append_token_query(&url, state.api_token());
    loop {
        info!(%url, "agent connecting to controller");
        match connect_async(&url).await {
            Ok((ws, _)) => {
                info!(%url, "agent connected to controller");
                if let Err(e) = session(state.clone(), ws).await {
                    warn!(error = %e, "agent mesh session ended");
                }
            }
            Err(e) => {
                error!(error = %e, %url, "agent connect failed — retrying");
            }
        }
        tokio::time::sleep(Duration::from_secs(RECONNECT_SECS)).await;
    }
}

async fn session(
    state: AppState,
    ws: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> Result<(), String> {
    let (mut sink, mut stream) = ws.split();

    let hello = AgentToController::Hello(AgentHello {
        host_id: state.host_id().into(),
        host_name: state.host_name().into(),
        os: crate::mesh::detect_os(),
        adb: state.adb_availability(),
        scrcpy: state.scrcpy_availability(),
        inject: state.inject_mode(),
        http_base: Some(
            std::env::var("PHONECONTROL_HTTP_BASE").unwrap_or_else(|_| {
                format!("http://127.0.0.1:{}", state.inner.port)
            }),
        ),
    });
    send(&mut sink, &hello).await?;

    // Initial device snapshot.
    let devices = state.list_local_devices().await;
    send(
        &mut sink,
        &AgentToController::Devices {
            host_id: state.host_id().into(),
            devices,
        },
    )
    .await?;

    for session in state.list_local_sessions().await {
        send(
            &mut sink,
            &AgentToController::SessionUpdated {
                host_id: state.host_id().into(),
                session,
            },
        )
        .await?;
    }

    let mut events = state.subscribe();
    let mut heartbeat = tokio::time::interval(Duration::from_secs(HEARTBEAT_SECS));

    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                send(
                    &mut sink,
                    &AgentToController::Heartbeat {
                        host_id: state.host_id().into(),
                        at: now_ms(),
                    },
                ).await?;
            }
            event = events.recv() => {
                match event {
                    Ok(phonecontrol_protocol::ServerEvent::Devices { devices }) => {
                        // Only forward local devices (agent has no remotes).
                        send(
                            &mut sink,
                            &AgentToController::Devices {
                                host_id: state.host_id().into(),
                                devices,
                            },
                        ).await?;
                    }
                    Ok(phonecontrol_protocol::ServerEvent::SessionUpdated { session }) => {
                        send(
                            &mut sink,
                            &AgentToController::SessionUpdated {
                                host_id: state.host_id().into(),
                                session,
                            },
                        ).await?;
                    }
                    Ok(_) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        let devices = state.list_local_devices().await;
                        send(
                            &mut sink,
                            &AgentToController::Devices {
                                host_id: state.host_id().into(),
                                devices,
                            },
                        ).await?;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        return Err("local event bus closed".into());
                    }
                }
            }
            msg = stream.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        match serde_json::from_str::<ControllerToAgent>(&text) {
                            Ok(cmd) => {
                                handle_controller_cmd(&state, &mut sink, cmd).await?;
                            }
                            Err(e) => {
                                warn!(error = %e, "ignored non-command controller frame");
                            }
                        }
                    }
                    Some(Ok(Message::Ping(p))) => {
                        sink.send(Message::Pong(p)).await.map_err(|e| e.to_string())?;
                    }
                    Some(Ok(Message::Close(_))) | None => {
                        return Err("controller closed websocket".into());
                    }
                    Some(Ok(_)) => {}
                    Some(Err(e)) => return Err(e.to_string()),
                }
            }
        }
    }
}

async fn handle_controller_cmd(
    state: &AppState,
    sink: &mut futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        Message,
    >,
    cmd: ControllerToAgent,
) -> Result<(), String> {
    match cmd {
        ControllerToAgent::Welcome { message, .. } => {
            info!(%message, "controller welcome");
        }
        ControllerToAgent::Ping { .. } => {
            send(
                sink,
                &AgentToController::Heartbeat {
                    host_id: state.host_id().into(),
                    at: now_ms(),
                },
            )
            .await?;
        }
        ControllerToAgent::Tap {
            request_id,
            mode,
            target_ids,
            normalized,
        } => {
            let reply = match state
                .handle_tap_local(mode, &target_ids, normalized)
                .await
            {
                Ok(broadcast) => AgentToController::TapResult {
                    request_id,
                    error: None,
                    targets: broadcast.targets,
                },
                Err(e) => AgentToController::TapResult {
                    request_id,
                    error: Some(e),
                    targets: vec![],
                },
            };
            send(sink, &reply).await?;
        }
        ControllerToAgent::Pointer {
            request_id,
            mode,
            target_ids,
            phase,
            tool,
            normalized,
            frame_width,
            frame_height,
        } => {
            let reply = match state
                .handle_pointer_local(
                    mode,
                    &target_ids,
                    phase,
                    tool,
                    normalized,
                    frame_width,
                    frame_height,
                )
                .await
            {
                Ok(broadcast) => AgentToController::TapResult {
                    request_id,
                    error: None,
                    targets: broadcast.targets,
                },
                Err(e) => AgentToController::TapResult {
                    request_id,
                    error: Some(e),
                    targets: vec![],
                },
            };
            send(sink, &reply).await?;
        }
        ControllerToAgent::Nav {
            request_id,
            mode,
            target_ids,
            action,
        } => {
            let reply = match state.handle_nav_local(mode, &target_ids, action).await {
                Ok(broadcast) => AgentToController::NavResult {
                    request_id,
                    error: None,
                    targets: broadcast.targets,
                },
                Err(e) => AgentToController::NavResult {
                    request_id,
                    error: Some(e),
                    targets: vec![],
                },
            };
            send(sink, &reply).await?;
        }
        ControllerToAgent::SessionStart { request_id, serial } => {
            reply_session(state, sink, request_id, &serial, SessionAction::Start).await?;
        }
        ControllerToAgent::SessionStop { request_id, serial } => {
            reply_session(state, sink, request_id, &serial, SessionAction::Stop).await?;
        }
        ControllerToAgent::SessionRestart { request_id, serial } => {
            reply_session(state, sink, request_id, &serial, SessionAction::Restart).await?;
        }
    }
    Ok(())
}

async fn reply_session(
    state: &AppState,
    sink: &mut futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        Message,
    >,
    request_id: String,
    serial: &str,
    action: SessionAction,
) -> Result<(), String> {
    let result = match action {
        SessionAction::Start => state.start_session_local(serial).await,
        SessionAction::Stop => state.stop_session_local(serial).await,
        SessionAction::Restart => state.restart_session_local(serial).await,
    };
    let reply = match result {
        Ok(session) => AgentToController::SessionResult {
            request_id,
            error: None,
            session: Some(session),
        },
        Err(e) => AgentToController::SessionResult {
            request_id,
            error: Some(e),
            session: None,
        },
    };
    send(sink, &reply).await
}

async fn send<S>(
    sink: &mut futures_util::stream::SplitSink<S, Message>,
    value: &impl serde::Serialize,
) -> Result<(), String>
where
    S: futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    let text = serde_json::to_string(value).map_err(|e| e.to_string())?;
    sink.send(Message::Text(text.into()))
        .await
        .map_err(|e| e.to_string())
}

fn append_token_query(url: &str, token: &str) -> String {
    if token.is_empty() {
        return url.to_string();
    }
    if url.contains("token=") {
        return url.to_string();
    }
    let encoded: String = token
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect();
    if url.contains('?') {
        format!("{url}&token={encoded}")
    } else {
        format!("{url}?token={encoded}")
    }
}

#[cfg(test)]
mod tls_tests {
    use tokio_tungstenite::tungstenite::error::{Error, UrlError};

    /// A wss:// controller must get as far as a TLS handshake, not fail with
    /// "TLS support not compiled in".
    #[tokio::test]
    async fn wss_urls_are_supported() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            // Accept and hang up: the client sees a TLS/IO error.
            let _ = listener.accept().await;
        });
        let result = tokio_tungstenite::connect_async(format!("wss://127.0.0.1:{port}/ws/agent")).await;
        match result {
            Err(Error::Url(UrlError::TlsFeatureNotEnabled)) => panic!("TLS is not compiled in"),
            Err(_) => {}
            Ok(_) => panic!("handshake cannot succeed against a closed socket"),
        }
    }
}

