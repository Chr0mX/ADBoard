//! Outbound agent → controller WebSocket client.

use crate::device_manager::AppState;
use futures_util::{SinkExt, StreamExt};
use adboard_protocol::{
    now_ms, AgentHello, AgentToController, ControllerToAgent, SessionAction,
};
use std::time::Duration;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{error, info, warn};

use adboard_protocol::ControllerLink;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

const HEARTBEAT_SECS: u64 = 5;
/// The controller answered nothing at all (no frame, no pong) for this long: the connection is dead.
const STALE_AFTER_SECS: u64 = 20;
const CONNECT_TIMEOUT_SECS: u64 = 10;
/// A connection that lasted this long counts as a success: the next failure starts from the short delay.
const HEALTHY_AFTER_SECS: u64 = 10;

/// How a connection behaves. The defaults are used in production; tests use short values.
#[derive(Debug, Clone)]
pub struct LinkTiming {
    pub heartbeat: Duration,
    pub stale_after: Duration,
    pub connect_timeout: Duration,
    pub backoff_base: Duration,
    pub backoff_max: Duration,
    pub healthy_after: Duration,
}

impl Default for LinkTiming {
    fn default() -> Self {
        LinkTiming {
            heartbeat: Duration::from_secs(HEARTBEAT_SECS),
            stale_after: Duration::from_secs(STALE_AFTER_SECS),
            connect_timeout: Duration::from_secs(CONNECT_TIMEOUT_SECS),
            backoff_base: Duration::from_secs(1),
            backoff_max: Duration::from_secs(30),
            healthy_after: Duration::from_secs(HEALTHY_AFTER_SECS),
        }
    }
}

fn link() -> &'static Mutex<ControllerLink> {
    static LINK: std::sync::OnceLock<Mutex<ControllerLink>> = std::sync::OnceLock::new();
    LINK.get_or_init(|| {
        Mutex::new(ControllerLink {
            state: "connecting".into(),
            failures: 0,
            connections: 0,
            last_error: None,
            last_connected_ms: None,
            next_attempt_ms: None,
        })
    })
}

fn update_link(change: impl FnOnce(&mut ControllerLink)) {
    change(&mut link().lock().unwrap_or_else(|e| e.into_inner()));
}

/// How the agent's connection to the controller is doing (for `GET /health`).
pub fn link_status() -> ControllerLink {
    link().lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// Only one connection worker may run: a second call finds the claim taken.
static WORKER: AtomicBool = AtomicBool::new(false);

pub struct WorkerClaim;

impl WorkerClaim {
    pub fn take() -> Option<WorkerClaim> {
        (!WORKER.swap(true, Ordering::SeqCst)).then_some(WorkerClaim)
    }
}

impl Drop for WorkerClaim {
    fn drop(&mut self) {
        WORKER.store(false, Ordering::SeqCst);
    }
}

/// Has the controller gone quiet for longer than `limit`?
pub fn is_silent(last_heard: std::time::Instant, now: std::time::Instant, limit: Duration) -> bool {
    now.saturating_duration_since(last_heard) > limit
}

/// Run forever: connect to controller, register, forward devices, handle proxies. When the
/// connection ends or cannot be made, try again after a growing, jittered delay (so many agents
/// that lost the controller together do not return in lockstep).
pub async fn run_agent_client(state: AppState, url: String) {
    run_agent_client_with(state, url, LinkTiming::default()).await
}

pub async fn run_agent_client_with(state: AppState, url: String, timing: LinkTiming) {
    let Some(_claim) = WorkerClaim::take() else {
        warn!(%url, "a controller connection worker is already running; not starting another");
        return;
    };
    let mut backoff = crate::backoff::Backoff::new(timing.backoff_base, timing.backoff_max);
    let mut failures: u32 = 0;
    loop {
        update_link(|l| {
            l.state = if failures == 0 && l.connections == 0 { "connecting" } else { "retrying" }.into();
            l.next_attempt_ms = None;
        });
        info!(%url, attempt = failures + 1, "agent connecting to controller");
        let request = match ws_request_with_token(&url, state.api_token()) {
            Ok(request) => request,
            Err(e) => {
                error!(error = %e, %url, "invalid controller URL");
                update_link(|l| l.last_error = Some(format!("invalid controller URL: {e}")));
                return;
            }
        };
        let started = std::time::Instant::now();
        let outcome = match tokio::time::timeout(timing.connect_timeout, connect_async(request)).await {
            Ok(Ok((ws, _))) => {
                info!(%url, recovered_after_failures = failures, "agent connected to controller");
                update_link(|l| {
                    l.state = "connected".into();
                    l.failures = 0;
                    l.connections += 1;
                    l.last_error = None;
                    l.last_connected_ms = Some(now_ms());
                });
                session(state.clone(), ws, &timing).await
            }
            Ok(Err(e)) => Err(format!("connect failed: {e}")),
            Err(_) => Err(format!("connect timed out after {}s", timing.connect_timeout.as_secs())),
        };
        let lasted = started.elapsed();
        match &outcome {
            Err(e) => warn!(error = %e, %url, lasted_secs = lasted.as_secs(), "controller connection ended"),
            Ok(()) => info!(%url, "controller connection closed"),
        }
        if lasted >= timing.healthy_after {
            // It worked for a while: whatever ended it, the next attempt starts from the short delay.
            backoff.reset();
            failures = 0;
        } else {
            failures += 1;
        }
        let delay = backoff.next_delay();
        update_link(|l| {
            l.state = "retrying".into();
            l.failures = failures;
            if let Err(e) = &outcome {
                l.last_error = Some(e.clone());
            }
            l.next_attempt_ms = Some(now_ms() + delay.as_millis() as u64);
        });
        info!(%url, retry_in_ms = delay.as_millis() as u64, failures, "retrying the controller connection");
        tokio::time::sleep(delay).await;
    }
}

async fn session(
    state: AppState,
    ws: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    timing: &LinkTiming,
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
            crate::env::var("HTTP_BASE").unwrap_or_else(|_| {
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
    let mut heartbeat = tokio::time::interval(timing.heartbeat);
    // Anything from the controller (a frame, or the answer to our ping) proves it is alive.
    let mut last_heard = std::time::Instant::now();

    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                if is_silent(last_heard, std::time::Instant::now(), timing.stale_after) {
                    return Err(format!("controller silent for {}s", last_heard.elapsed().as_secs()));
                }
                // A protocol ping: the controller (or a proxy in front of it) answers with a pong even
                // when it has nothing else to say, so silence really means a dead connection.
                sink.send(Message::Ping(Vec::new().into())).await.map_err(|e| e.to_string())?;
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
                    Ok(adboard_protocol::ServerEvent::Devices { devices }) => {
                        // Only forward local devices (agent has no remotes).
                        send(
                            &mut sink,
                            &AgentToController::Devices {
                                host_id: state.host_id().into(),
                                devices,
                            },
                        ).await?;
                    }
                    Ok(adboard_protocol::ServerEvent::SessionUpdated { session }) => {
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
                if msg.is_some() {
                    last_heard = std::time::Instant::now();
                }
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

/// Server-to-server WebSocket request carrying the token as a header rather
/// than `?token=` (query strings end up in proxy and Cloudflare logs).
pub fn ws_request_with_token(
    url: &str,
    token: &str,
) -> Result<
    tokio_tungstenite::tungstenite::handshake::client::Request,
    tokio_tungstenite::tungstenite::Error,
> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let mut request = url.into_client_request()?;
    if !token.is_empty() {
        if let Ok(value) = token.parse() {
            request.headers_mut().insert("x-adboard-token", value);
        }
        // Legacy compatibility: controllers from before the rename read this name.
        if let Ok(value) = token.parse() {
            request.headers_mut().insert(crate::api::LEGACY_TOKEN_HEADER, value);
        }
    }
    Ok(request)
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



#[cfg(test)]
mod tests {
    use super::*;
    use adboard_protocol::Role;
    use std::sync::atomic::AtomicUsize;
    use std::sync::Arc;

    /// The worker claim and the link status are process-wide, so these tests run one at a time.
    static ONE_AT_A_TIME: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    fn quick() -> LinkTiming {
        LinkTiming {
            heartbeat: Duration::from_millis(150),
            stale_after: Duration::from_millis(700),
            connect_timeout: Duration::from_secs(2),
            backoff_base: Duration::from_millis(100),
            backoff_max: Duration::from_millis(400),
            healthy_after: Duration::from_millis(500),
        }
    }

    fn agent_state() -> AppState {
        AppState::new(Role::Agent, "agent-1".into(), "agent-1".into(), 0, None)
    }

    async fn wait_for(mut check: impl FnMut() -> bool, secs: u64) -> bool {
        let start = std::time::Instant::now();
        while !check() && start.elapsed() < Duration::from_secs(secs) {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        check()
    }

    /// A fake controller. `behaviour(n, ws)` runs for the n-th connection (1-based).
    async fn fake_controller<F, Fut>(behaviour: F) -> (String, Arc<AtomicUsize>, tokio::task::JoinHandle<()>)
    where
        F: Fn(usize, tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>) -> Fut + Send + Sync + 'static,
        Fut: std::future::Future<Output = ()> + Send + 'static,
    {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/ws/agent", listener.local_addr().unwrap());
        let accepted = Arc::new(AtomicUsize::new(0));
        let counter = accepted.clone();
        let behaviour = Arc::new(behaviour);
        let handle = tokio::spawn(async move {
            loop {
                let Ok((tcp, _)) = listener.accept().await else { break };
                let Ok(ws) = tokio_tungstenite::accept_async(tcp).await else { continue };
                let n = counter.fetch_add(1, Ordering::SeqCst) + 1;
                let behaviour = behaviour.clone();
                tokio::spawn(async move { behaviour(n, ws).await });
            }
        });
        (url, accepted, handle)
    }

    #[test]
    fn silence_is_measured_from_the_last_thing_heard() {
        let now = std::time::Instant::now();
        assert!(!is_silent(now, now + Duration::from_secs(19), Duration::from_secs(20)));
        assert!(is_silent(now, now + Duration::from_secs(21), Duration::from_secs(20)));
        assert!(!is_silent(now + Duration::from_secs(5), now, Duration::from_secs(1)), "a clock that did not move is not silence");
    }

    #[tokio::test]
    async fn only_one_connection_worker_can_run() {
        let _guard = ONE_AT_A_TIME.lock().await;
        let first = WorkerClaim::take().expect("the first claim works");
        assert!(WorkerClaim::take().is_none(), "a second worker is refused");
        drop(first);
        assert!(WorkerClaim::take().is_some(), "and the claim is free again when the worker ends");
    }

    #[tokio::test]
    async fn after_the_controller_drops_the_agent_reconnects_and_registers_again() {
        let _guard = ONE_AT_A_TIME.lock().await;
        let hellos = Arc::new(AtomicUsize::new(0));
        let seen = hellos.clone();
        let (url, accepted, server) = fake_controller(move |n, mut ws| {
            let seen = seen.clone();
            async move {
                // Read until the agent has sent its device snapshot (hello, then devices).
                let mut got_hello = false;
                while let Some(Ok(Message::Text(text))) = ws.next().await {
                    if text.contains("\"hello\"") {
                        got_hello = true;
                        seen.fetch_add(1, Ordering::SeqCst);
                    }
                    if got_hello && text.contains("\"devices\"") {
                        break;
                    }
                }
                if n == 1 {
                    return; // the controller restarts: the connection just drops
                }
                // Stay up and answer pings by reading.
                while ws.next().await.is_some() {}
            }
        })
        .await;
        let worker = tokio::spawn(run_agent_client_with(agent_state(), url, quick()));
        assert!(wait_for(|| accepted.load(Ordering::SeqCst) >= 2, 8).await, "it came back after the drop");
        assert!(wait_for(|| hellos.load(Ordering::SeqCst) >= 2, 5).await, "and registered again, sending its devices again");
        assert!(wait_for(|| link_status().state == "connected", 3).await);
        assert_eq!(link_status().failures, 0);
        worker.abort();
        let _ = worker.await; // its claim is released once it is dropped
        server.abort();
    }

    #[tokio::test]
    async fn a_controller_that_goes_silent_is_given_up_on_and_retried() {
        let _guard = ONE_AT_A_TIME.lock().await;
        let (url, accepted, server) = fake_controller(|_, ws| async move {
            // Accepts the connection, then never reads or answers anything (a half-open connection).
            let _keep = ws;
            tokio::time::sleep(Duration::from_secs(30)).await;
        })
        .await;
        let worker = tokio::spawn(run_agent_client_with(agent_state(), url, quick()));
        assert!(wait_for(|| accepted.load(Ordering::SeqCst) >= 2, 10).await, "the silent connection was dropped and a new one made");
        assert!(link_status().last_error.unwrap_or_default().contains("silent") || link_status().connections >= 2);
        worker.abort();
        let _ = worker.await;
        server.abort();
    }

    #[tokio::test]
    async fn an_unreachable_controller_is_retried_with_growing_delays_and_recovery_resets_them() {
        let _guard = ONE_AT_A_TIME.lock().await;
        // Reserve a port, then free it: nothing listens there yet.
        let free = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = free.local_addr().unwrap();
        drop(free);
        let url = format!("ws://{addr}/ws/agent");
        let worker = tokio::spawn(run_agent_client_with(agent_state(), url, quick()));
        assert!(wait_for(|| link_status().failures >= 3, 8).await, "it keeps trying");
        let status = link_status();
        assert_eq!(status.state, "retrying");
        assert!(status.last_error.as_deref().unwrap_or("").contains("connect failed"), "{status:?}");
        assert!(status.next_attempt_ms.is_some(), "the next attempt is announced");
        // The controller appears.
        let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
        let server = tokio::spawn(async move {
            loop {
                let Ok((tcp, _)) = listener.accept().await else { break };
                if let Ok(mut ws) = tokio_tungstenite::accept_async(tcp).await {
                    tokio::spawn(async move { while ws.next().await.is_some() {} });
                }
            }
        });
        assert!(wait_for(|| link_status().state == "connected", 8).await, "it connects once the controller is back");
        assert_eq!(link_status().failures, 0, "the failure count starts over");
        assert!(link_status().last_connected_ms.is_some());
        worker.abort();
        let _ = worker.await;
        server.abort();
    }

    #[tokio::test]
    async fn the_agents_own_phones_are_not_touched_while_the_controller_is_away() {
        let _guard = ONE_AT_A_TIME.lock().await;
        let state = agent_state();
        let before: Vec<String> = state.list_local_devices().await.into_iter().map(|d| d.serial).collect();
        assert!(!before.is_empty());
        let free = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/ws/agent", free.local_addr().unwrap());
        drop(free);
        let worker = tokio::spawn(run_agent_client_with(state.clone(), url, quick()));
        assert!(wait_for(|| link_status().failures >= 2, 8).await);
        let after: Vec<String> = state.list_local_devices().await.into_iter().map(|d| d.serial).collect();
        assert_eq!(before, after);
        worker.abort();
        let _ = worker.await;
    }
}
