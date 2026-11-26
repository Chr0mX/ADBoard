//! WebSockets: the UI event socket, the agent registration socket, and the video, audio and logcat streams.
use super::*;

pub(super) async fn ws_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.protocols([WS_PROTOCOL, LEGACY_WS_PROTOCOL])
        .on_upgrade(move |socket| handle_socket(socket, state))
}

pub(super) async fn ws_agent_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    if state.role() != Role::Controller {
        // Still upgrade so the peer gets a clean close rather than HTTP 404 mid-handshake.
        return ws.protocols([WS_PROTOCOL, LEGACY_WS_PROTOCOL]).on_upgrade(
            |mut socket| async move {
                let _ = socket
                    .send(Message::Text(
                        r#"{"type":"notice","message":"not a controller"}"#.into(),
                    ))
                    .await;
                let _ = socket.close().await;
            },
        );
    }
    ws.protocols([WS_PROTOCOL, LEGACY_WS_PROTOCOL])
        .on_upgrade(move |socket| handle_agent_socket(socket, state))
}

pub(super) async fn ws_video_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Path(serial): Path<String>,
) -> impl IntoResponse {
    ws.protocols([WS_PROTOCOL, LEGACY_WS_PROTOCOL])
        .on_upgrade(move |socket| handle_video_socket(socket, state, serial))
}

pub(super) async fn ws_audio_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Path(serial): Path<String>,
) -> impl IntoResponse {
    ws.protocols([WS_PROTOCOL, LEGACY_WS_PROTOCOL])
        .on_upgrade(move |socket| handle_audio_socket(socket, state, serial))
}

pub(super) async fn ws_logcat_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Path(serial): Path<String>,
) -> impl IntoResponse {
    ws.protocols([WS_PROTOCOL, LEGACY_WS_PROTOCOL])
        .on_upgrade(move |socket| handle_logcat_socket(socket, state, serial))
}

/// Live logcat: the first client message is the filter (`{package, level}`).
pub(super) async fn handle_logcat_socket(socket: WebSocket, state: AppState, serial: String) {
    let (mut sender, mut receiver) = socket.split();
    let note = |text: String| Message::Text(serde_json::json!({ "note": text }).to_string().into());
    let serial = match state.resolve_serial(&serial).await {
        Ok(serial) => serial,
        Err(e) => {
            let _ = sender.send(note(e)).await;
            return;
        }
    };
    if let Some(host_id) = state.remote_owner(&serial).await {
        match state.remote_http_base(&host_id).await {
            // The filter message is relayed like any other client message.
            Some(base) => {
                proxy_remote_stream(
                    sender,
                    receiver,
                    &base,
                    &serial,
                    "logcat",
                    state.api_token(),
                )
                .await
            }
            None => {
                let _ = sender
                    .send(note(format!(
                        "agent {host_id} did not advertise http_base — cannot proxy logcat"
                    )))
                    .await;
            }
        }
        return;
    }
    let filter =
        match tokio::time::timeout(std::time::Duration::from_secs(5), receiver.next()).await {
            Ok(Some(Ok(Message::Text(text)))) => {
                serde_json::from_str(text.as_str()).unwrap_or_default()
            }
            _ => crate::logcat::Filter::default(),
        };
    let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(64);
    let producer = tokio::spawn(crate::logcat::stream(
        state.inner.adb_path.clone(),
        serial.clone(),
        filter,
        tx,
    ));
    let mut send_task = tokio::spawn(async move {
        let mut keepalive = ws_keepalive();
        loop {
            tokio::select! {
                frame = rx.recv() => match frame {
                    Some(text) => {
                        if sender.send(Message::Text(text.into())).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                },
                _ = keepalive.tick() => {
                    if sender.send(ws_ping()).await.is_err() {
                        break;
                    }
                }
            }
        }
    });
    let mut recv_task = tokio::spawn(async move {
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
    // Dropping the producer kills its adb logcat process.
    producer.abort();
    info!(%serial, "logcat websocket disconnected");
}

pub(super) async fn handle_socket(socket: WebSocket, state: AppState) {
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
pub(super) async fn handle_agent_socket(socket: WebSocket, state: AppState) {
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

    let registered_host = std::sync::Arc::new(tokio::sync::Mutex::new(None::<(String, u64)>));
    // Wakes this connection's tasks when it is replaced by a newer one or goes silent.
    let cancel = std::sync::Arc::new(tokio::sync::Notify::new());

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
    let cancel_in = cancel.clone();
    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = receiver.next().await {
            match msg {
                Message::Text(text) => match serde_json::from_str::<AgentToController>(&text) {
                    Ok(frame) => {
                        if let Err(e) = handle_agent_frame(
                            &state_in,
                            &mesh,
                            &cmd_tx,
                            &cancel_in,
                            &registered_in,
                            frame,
                        )
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

    // An agent sends a heartbeat every few seconds; a connection that has gone silent for this
    // long (a half-open TCP connection after a network change or a crash) is closed, so the host
    // does not linger as connected and the agent's next attempt registers cleanly.
    let silent = async {
        let mut check = tokio::time::interval(std::time::Duration::from_secs(5));
        loop {
            check.tick().await;
            let registered = registered_host.lock().await.clone();
            if let Some((id, conn)) = registered {
                if let Some(age) = state.mesh().silence_of(&id, conn).await {
                    if age > crate::mesh::AGENT_DEAD_AFTER {
                        warn!(host_id = %id, silent_secs = age.as_secs(), "agent went silent; closing its connection");
                        return;
                    }
                }
            }
        }
    };
    tokio::select! {
        _ = &mut send_task => recv_task.abort(),
        _ = &mut recv_task => send_task.abort(),
        _ = cancel.notified() => { send_task.abort(); recv_task.abort(); }
        _ = silent => { send_task.abort(); recv_task.abort(); }
    }

    let registered = registered_host.lock().await.clone();
    if let Some((id, conn)) = registered {
        // Only the connection that is still the registered one removes the host.
        if state.mesh().unregister_conn(&id, conn).await {
            state.publish_fleet().await;
            state.publish(ServerEvent::Notice {
                message: format!("agent {id} disconnected"),
            });
        }
    }
    info!("agent websocket disconnected");
}

pub(super) async fn handle_agent_frame(
    state: &AppState,
    mesh: &std::sync::Arc<crate::mesh::MeshRegistry>,
    cmd_tx: &mpsc::UnboundedSender<ControllerToAgent>,
    cancel: &std::sync::Arc<tokio::sync::Notify>,
    registered_host: &std::sync::Arc<tokio::sync::Mutex<Option<(String, u64)>>>,
    frame: AgentToController,
) -> Result<(), String> {
    match frame {
        AgentToController::Hello(hello) => {
            let conn_id = mesh
                .register(
                    hello.host_id.clone(),
                    hello.host_name.clone(),
                    hello.os.clone(),
                    cmd_tx.clone(),
                    hello.http_base.clone(),
                    cancel.clone(),
                )
                .await?;
            *registered_host.lock().await = Some((hello.host_id.clone(), conn_id));
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
pub(super) async fn handle_video_socket(socket: WebSocket, state: AppState, id_or_serial: String) {
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
            let _ = write_within(&mut sender, CloseReason::UnknownDevice.frame(), CLOSE_WRITE_LIMIT).await;
            return;
        }
    };

    // Remote device → proxy agent video WS.
    if let Some(host_id) = state.remote_owner(&serial).await {
        match state.remote_http_base(&host_id).await {
            Some(base) => {
                info!(%serial, %host_id, %base, "proxying video WS to agent");
                proxy_remote_stream(sender, receiver, &base, &serial, "video", state.api_token())
                    .await;
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
                let _ = write_within(&mut sender, CloseReason::AgentUnreachable.frame(), CLOSE_WRITE_LIMIT).await;
            }
        }
        return;
    }

    // Was a stream already running before this socket? Only then can the
    // cached IDR be stale enough to need a fresh keyframe.
    let was_streaming = state
        .inner
        .sessions
        .get_session(&serial)
        .await
        .is_some_and(|session| session.stream == adboard_protocol::StreamState::Streaming);

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
        let _ = write_within(&mut sender, CloseReason::StartFailed.frame(), CLOSE_WRITE_LIMIT).await;
        return;
    }

    let frame = state.inner.sessions.video_status_frame(&serial).await;
    if sender
        .send(Message::Text(status_with_heartbeat(&frame).into()))
        .await
        .is_err()
    {
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
        // On a stream this socket just started, wait for scrcpy's first frame
        // before the reset (see FIRST_FRAME_WAIT).
        let mut first = if was_streaming {
            None
        } else {
            Some(hub.subscribe(&serial).await)
        };
        tokio::spawn(async move {
            if let Some(rx) = first.as_mut() {
                if !first_access_unit(rx, FIRST_FRAME_WAIT).await {
                    debug!(%serial_reset, "no first frame yet; asking for a keyframe anyway");
                }
            }
            drop(first);
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
    let sessions_lag = state.inner.sessions.clone();
    let mut events = state.subscribe();
    let serial_filter = serial.clone();
    let serial_lag = serial.clone();
    let serial_log = serial.clone();

    // Anything the browser sends, pongs included, proves it is alive.
    let connected_at = std::time::Instant::now();
    let last_heard_ms = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let heard = last_heard_ms.clone();

    let mut send_task = tokio::spawn(async move {
        // A write that cannot finish (the browser froze or the connection is half open) ends this
        // socket with a reason, instead of holding a subscriber until the OS gives up on the peer.
        macro_rules! put {
            ($label:lifetime, $message:expr) => {
                if let Err(failure) = write_within(&mut sender, $message, SEND_TIMEOUT).await {
                    break $label failure.reason();
                }
            };
        }
        let outcome: Option<CloseReason> = 'session: {
            for au in replay {
                put!('session, Message::Binary(au));
            }
            // Scrcpy sockets always wait: the replayed IDR must not be followed by
            // later P-frames. The keyframe requested above ends the wait.
            let mut wait_for_key = scrcpy_live;
            let mut keepalive = ws_keepalive();
            let mut heartbeat = video_heartbeat();
            let mut last_lag_reset: Option<std::time::Instant> = None;
            loop {
                tokio::select! {
                    _ = keepalive.tick() => {
                        put!('session, ws_ping());
                    }
                    _ = heartbeat.tick() => {
                        let last = connected_at + std::time::Duration::from_millis(heard.load(std::sync::atomic::Ordering::Relaxed));
                        if peer_is_silent(last, std::time::Instant::now(), PEER_SILENT_AFTER) {
                            break 'session Some(CloseReason::ClientSilent);
                        }
                        // Browsers cannot see WebSocket pings. A still screen sends no
                        // video, so the page needs this to tell "quiet" from "dead".
                        let frame = sessions_lag.video_status_frame(&serial_lag).await;
                        put!('session, Message::Text(status_with_heartbeat(&frame).into()));
                    }
                    packet = video_rx.recv() => {
                        match packet {
                            Ok(crate::video::VideoPacket::Status(frame)) => {
                                put!('session, Message::Text(serde_json::to_string(&frame).unwrap_or_default().into()));
                            }
                            Ok(crate::video::VideoPacket::AnnexB(bytes)) => {
                                if !crate::video::keep_after_gap(&mut wait_for_key, &bytes) {
                                    continue;
                                }
                                put!('session, Message::Binary(bytes));
                            }
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                                debug!(lagged = n, "video subscriber lagged");
                                // This viewer fell behind: ask the phone for a keyframe now
                                // instead of leaving it on the cached one until the next
                                // natural keyframe, which can be seconds away.
                                if scrcpy_live && last_lag_reset.is_none_or(|at: std::time::Instant| at.elapsed() >= LAG_KEYFRAME_EVERY) {
                                    last_lag_reset = Some(std::time::Instant::now());
                                    let sessions = sessions_lag.clone();
                                    let serial = serial_lag.clone();
                                    tokio::spawn(async move {
                                        let _ = sessions.reset_video(&serial).await;
                                    });
                                }
                                for au in hub_lag.replay_access_units(&serial_lag).await {
                                    put!('session, Message::Binary(au));
                                }
                                wait_for_key = true;
                            }
                            Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                                break 'session Some(CloseReason::StreamShutDown);
                            }
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
                                put!('session, Message::Text(serde_json::to_string(&frame).unwrap_or_default().into()));
                            }
                            Ok(_) => {}
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                            Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                                break 'session Some(CloseReason::StreamShutDown);
                            }
                        }
                    }
                }
            }
        };
        match outcome {
            Some(reason) => {
                info!(serial = %serial_log, code = reason.code(), reason = reason.text(), "video websocket closed by the agent");
                // Best effort: a peer that stopped reading will not take the close frame either.
                let _ = write_within(&mut sender, reason.frame(), CLOSE_WRITE_LIMIT).await;
            }
            None => debug!(serial = %serial_log, "video websocket ended: the browser went away"),
        }
    });

    // The code the browser closed with (0: it sent none, or the connection just ended).
    let browser_close = Arc::new(std::sync::atomic::AtomicU32::new(0));
    let browser_close_set = browser_close.clone();
    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(message)) = receiver.next().await {
            last_heard_ms.store(
                connected_at.elapsed().as_millis() as u64,
                std::sync::atomic::Ordering::Relaxed,
            );
            if let Message::Close(frame) = message {
                browser_close_set.store(frame.map(|f| u32::from(f.code)).unwrap_or(0), std::sync::atomic::Ordering::Relaxed);
                break;
            }
        }
    });

    tokio::select! {
        _ = &mut send_task => recv_task.abort(),
        _ = &mut recv_task => send_task.abort(),
    }
    info!(
        %serial,
        browser_close_code = browser_close.load(std::sync::atomic::Ordering::Relaxed),
        open_secs = connected_at.elapsed().as_secs(),
        "video websocket disconnected (session left running)"
    );
}

pub(super) async fn handle_audio_socket(socket: WebSocket, state: AppState, serial: String) {
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
                proxy_remote_stream(sender, receiver, &base, &serial, "audio", state.api_token())
                    .await;
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
pub(super) async fn proxy_remote_stream(
    mut client_out: futures_util::stream::SplitSink<WebSocket, Message>,
    mut client_in: futures_util::stream::SplitStream<WebSocket>,
    agent_http_base: &str,
    serial: &str,
    channel: &str,
    token: &str,
) {
    let ws_url = http_to_ws_device_url(agent_http_base, serial, channel);
    // Agents share ADBOARD_TOKEN with the controller; send it as a header.
    // A host that is gone or unreachable must not hold the browser's socket for the OS's own timeout.
    let connected = match crate::mesh_client::ws_request_with_token(&ws_url, token) {
        Ok(request) => {
            match tokio::time::timeout(PROXY_CONNECT_TIMEOUT, tokio_tungstenite::connect_async(request)).await {
                Ok(result) => result.map_err(|e| e.to_string()),
                Err(_) => Err(format!("no answer within {} s", PROXY_CONNECT_TIMEOUT.as_secs())),
            }
        }
        Err(e) => Err(e.to_string()),
    };
    let (agent_ws, _) = match connected {
        Ok(pair) => pair,
        Err(e) => {
            warn!(%serial, %channel, error = %e, "video proxy: could not open the agent's socket");
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
            let _ = write_within(&mut client_out, CloseReason::AgentUnreachable.frame(), CLOSE_WRITE_LIMIT).await;
            return;
        }
    };

    let (mut agent_out, mut agent_in) = agent_ws.split();
    let serial_log = serial.to_string();
    let channel_log = channel.to_string();

    let mut to_client = tokio::spawn(async move {
        // Why the agent's side ended: it said so (a close frame), the stream failed, or it just ended.
        let mut ended = String::from("the agent's socket ended");
        let mut browser_gone = false;
        while let Some(next) = agent_in.next().await {
            let msg = match next {
                Ok(msg) => msg,
                Err(e) => {
                    ended = format!("the agent's socket failed: {e}");
                    break;
                }
            };
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
                tokio_tungstenite::tungstenite::Message::Close(frame) => {
                    ended = match frame {
                        Some(f) => format!("the agent closed its socket ({} {})", u16::from(f.code), f.reason),
                        None => "the agent closed its socket".into(),
                    };
                    break;
                }
                tokio_tungstenite::tungstenite::Message::Frame(_) => continue,
            };
            // A browser that stopped reading must not hold the agent's stream open for the OS's sake.
            if write_within(&mut client_out, mapped, SEND_TIMEOUT).await.is_err() {
                browser_gone = true;
                break;
            }
        }
        if browser_gone {
            debug!(serial = %serial_log, channel = %channel_log, "video proxy: the browser stopped reading");
        } else {
            info!(serial = %serial_log, channel = %channel_log, %ended, "video proxy: the agent link ended");
            // Tell the browser which side failed: the agent, not this controller or the phone.
            let _ = write_within(&mut client_out, CloseReason::AgentLinkLost.frame(), CLOSE_WRITE_LIMIT).await;
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

pub(super) fn http_to_ws_device_url(http_base: &str, serial: &str, channel: &str) -> String {
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

pub(super) async fn send_event(
    sender: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    event: &ServerEvent,
) -> Result<(), ()> {
    send_json(sender, event).await
}

pub(super) async fn send_json<T: serde::Serialize>(
    sender: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    value: &T,
) -> Result<(), ()> {
    let text = serde_json::to_string(value).map_err(|_| ())?;
    sender
        .send(Message::Text(text.into()))
        .await
        .map_err(|_| ())
}
