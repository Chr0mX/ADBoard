use super::watcher::{recovery_actions, RecoveryAction};
use super::*;

/// A stand-in for `adb` that answers every call after a delay. A serial
/// starting with `HUNG` never answers in time. Unix only (a shell script).
#[cfg(unix)]
fn fake_adb(delay_secs: &str, hung_secs: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let dir = std::env::temp_dir().join(format!("adboard-fake-adb-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("adb");
    let script = format!(
        "#!/bin/sh\ncase \"$2\" in HUNG*) sleep {hung_secs};; *) sleep {delay_secs};; esac\nexit 0\n"
    );
    std::fs::write(&path, script).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

/// `count` online phones with serials `FAKE1..`, plus optional hung ones, in a state that uses `adb`.
#[cfg(unix)]
async fn state_with_fake_phones(adb: PathBuf, serials: &[&str]) -> (AppState, Vec<String>) {
    let state = AppState::new(Role::Controller, "fan-test".into(), "fan-test".into(), 0, Some(adb));
    let template = AppState::new(Role::Controller, "tpl".into(), "tpl".into(), 0, None)
        .list_devices()
        .await
        .into_iter()
        .find(|d| d.status == DeviceStatus::Online)
        .expect("an online mock phone");
    let mut phones = Vec::new();
    for (i, serial) in serials.iter().enumerate() {
        let mut d = template.clone();
        d.id = format!("fake-{i}");
        d.serial = (*serial).to_string();
        d.name = format!("Fake {i}");
        d.host_id = Some("fan-test".into());
        phones.push(d);
    }
    let ids = phones.iter().map(|d| d.id.clone()).collect();
    *state.inner.devices.write().await = phones;
    (state, ids)
}

#[cfg(unix)]
#[tokio::test]
async fn nav_reaches_five_phones_at_once_and_a_hung_phone_only_delays_itself() {
    // Five phones that each take 200 ms to answer: one round trip, not five.
    let (state, ids) = state_with_fake_phones(
        fake_adb("0.2", "30"),
        &["FAKE1", "FAKE2", "FAKE3", "FAKE4", "FAKE5"],
    )
    .await;
    let started = std::time::Instant::now();
    let out = state
        .handle_nav(ControlMode::Multi, &ids, NavActionType::Back)
        .await
        .expect("nav runs");
    let elapsed = started.elapsed();
    eprintln!("NAV5_ELAPSED_MS={}", elapsed.as_millis());
    assert_eq!(out.targets.len(), 5);
    assert!(out.targets.iter().all(|t| t.inject == InjectStatus::Ok), "{:?}", out.targets);
    // Results come back in request order.
    let order: Vec<&str> = out.targets.iter().map(|t| t.device_id.as_str()).collect();
    assert_eq!(order, ids.iter().map(String::as_str).collect::<Vec<_>>());
    assert!(elapsed < Duration::from_millis(700), "five phones took {elapsed:?}");

    // A phone that never answers fails on its own after the time limit; the
    // phones around it are done long before.
    crate::adb::set_input_limit_for_tests(Some(Duration::from_millis(900)));
    let (state, ids) =
        state_with_fake_phones(fake_adb("0.2", "30"), &["FAKE1", "HUNG1", "FAKE2"]).await;
    let started = std::time::Instant::now();
    let out = state
        .handle_nav(ControlMode::Multi, &ids, NavActionType::Home)
        .await
        .expect("nav runs");
    let elapsed = started.elapsed();
    crate::adb::set_input_limit_for_tests(None);
    eprintln!("NAV_HUNG_ELAPSED_MS={}", elapsed.as_millis());
    let statuses: Vec<InjectStatus> = out.targets.iter().map(|t| t.inject).collect();
    assert_eq!(statuses, vec![InjectStatus::Ok, InjectStatus::Error, InjectStatus::Ok]);
    assert!(
        out.targets[1].detail.as_deref().unwrap_or("").contains("did not answer"),
        "{:?}",
        out.targets[1].detail
    );
    assert!(elapsed < Duration::from_secs(3), "took {elapsed:?}");
}

#[tokio::test]
async fn a_remote_agent_that_never_answers_or_is_gone_fails_fast() {
    let quick = Duration::from_millis(300);
    // Accepts the connection, then says nothing.
    let silent = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = silent.local_addr().unwrap();
    tokio::spawn(async move {
        let (_socket, _) = silent.accept().await.unwrap();
        tokio::time::sleep(Duration::from_secs(30)).await;
    });
    let started = std::time::Instant::now();
    let error = http_post_limited(&format!("http://{addr}/api/x"), &[], b"{}", quick, quick, quick)
        .await
        .expect_err("no reply");
    assert!(error.contains("no reply"), "{error}");
    assert!(started.elapsed() < Duration::from_secs(3));

    // Nothing is listening: refused at once, not hung.
    let free = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let gone = free.local_addr().unwrap();
    drop(free);
    let error = http_post_limited(&format!("http://{gone}/api/x"), &[], b"{}", quick, quick, quick)
        .await
        .expect_err("refused");
    assert!(error.contains("connect failed"), "{error}");
}

#[tokio::test]
async fn a_remote_reply_is_read_and_an_oversized_one_is_refused() {
    let server = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = server.local_addr().unwrap();
    tokio::spawn(async move {
        for big in [false, true] {
            let (mut socket, _) = server.accept().await.unwrap();
            let mut scratch = [0u8; 1024];
            let _ = socket.read(&mut scratch).await;
            let body = if big { "x".repeat(MAX_PROXY_REPLY + 10) } else { "{\"ok\":true}".to_string() };
            let reply = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            let _ = socket.write_all(reply.as_bytes()).await;
        }
    });
    let url = format!("http://{addr}/api/x");
    let secs = Duration::from_secs(5);
    let (code, body) = http_post_limited(&url, &[], b"{}", secs, secs, secs).await.unwrap();
    assert_eq!((code, body.as_str()), (200, "{\"ok\":true}"));
    let error = http_post_limited(&url, &[], b"{}", secs, secs, secs).await.expect_err("too large");
    assert!(error.contains("larger than"), "{error}");
}

#[cfg(unix)]
#[tokio::test]
async fn the_poll_asks_every_phone_at_once_and_a_hung_phone_costs_only_itself() {
    use crate::adb::AdbDeviceLine;
    let adb = fake_adb("0.2", "30");
    let (state, _ids) = state_with_fake_phones(adb.clone(), &[]).await;
    let line = |serial: &str| AdbDeviceLine {
        serial: serial.to_string(),
        status: DeviceStatus::Online,
        model: Some("Pixel".into()),
        product: None,
        transport_id: None,
        connection: adboard_protocol::ConnectionType::Usb,
    };
    let lines = vec![line("FAKE1"), line("FAKE2"), line("FAKE3"), line("HUNG1")];
    crate::adb::set_input_limit_for_tests(Some(Duration::from_millis(900)));
    let mut known = HashMap::new();
    let mut batteries = HashMap::new();
    let started = std::time::Instant::now();
    state.apply_adb_snapshot(&adb, &lines, &mut known, &mut batteries).await;
    let elapsed = started.elapsed();
    crate::adb::set_input_limit_for_tests(None);
    eprintln!("POLL4_ELAPSED_MS={}", elapsed.as_millis());
    // Done in about one time limit (the hung phone's), where reading the
    // phones one by one took 3 x 0.4 s plus 2 x 0.9 s.
    assert!(elapsed < Duration::from_millis(1600), "{elapsed:?}");
    let serials: Vec<String> = state.list_local_devices().await.into_iter().map(|d| d.serial).collect();
    assert_eq!(serials, vec!["FAKE1", "FAKE2", "FAKE3", "HUNG1"]);
}

#[cfg(unix)]
#[tokio::test]
async fn tap_and_commands_run_on_all_phones_at_once_in_request_order() {
    let (state, ids) =
        state_with_fake_phones(fake_adb("0.2", "30"), &["FAKE1", "FAKE2", "FAKE3", "FAKE4"]).await;

    let started = std::time::Instant::now();
    let tap = state
        .handle_tap(ControlMode::Multi, &ids, NormalizedPoint { x: 0.5, y: 0.5 })
        .await
        .expect("tap runs");
    let tap_elapsed = started.elapsed();
    eprintln!("TAP4_ELAPSED_MS={}", tap_elapsed.as_millis());
    assert_eq!(tap.targets.len(), 4);
    assert!(tap.targets.iter().all(|t| t.inject == InjectStatus::Ok), "{:?}", tap.targets);
    let tap_order: Vec<&str> = tap.targets.iter().map(|t| t.device_id.as_str()).collect();
    assert_eq!(tap_order, ids.iter().map(String::as_str).collect::<Vec<_>>());
    assert!(tap_elapsed < Duration::from_millis(600), "{tap_elapsed:?}");

    let started = std::time::Instant::now();
    let command = state
        .handle_command(DeviceCommandRequest {
            target_ids: ids.clone(),
            op: "shell".into(),
            arg: Some("id".into()),
            arg2: None,
        })
        .await
        .expect("command runs");
    let command_elapsed = started.elapsed();
    eprintln!("CMD4_ELAPSED_MS={}", command_elapsed.as_millis());
    assert_eq!(command.results.len(), 4);
    let cmd_order: Vec<&str> = command.results.iter().map(|r| r.device_id.as_str()).collect();
    assert_eq!(cmd_order, ids.iter().map(String::as_str).collect::<Vec<_>>());
    assert!(command_elapsed < Duration::from_millis(600), "{command_elapsed:?}");
}

#[tokio::test]
async fn gesture_plays_on_every_target_with_its_timing() {
    let state = AppState::new(
        Role::Controller,
        "gesture-test".into(),
        "gesture-test".into(),
        0,
        None,
    );
    let online: Vec<String> = state
        .list_devices()
        .await
        .into_iter()
        .filter(|d| d.status == DeviceStatus::Online)
        .map(|d| d.id)
        .collect();
    assert!(online.len() >= 2, "mock fleet has two online phones");
    let strokes = vec![
        GestureStroke {
            pointer: 0,
            start_ms: 0,
            duration_ms: 120,
            points: vec![NormalizedPoint { x: 0.2, y: 0.5 }],
        },
        GestureStroke {
            pointer: 1,
            start_ms: 20,
            duration_ms: 100,
            points: vec![
                NormalizedPoint { x: 0.8, y: 0.5 },
                NormalizedPoint { x: 0.8, y: 0.2 },
            ],
        },
    ];
    let started = std::time::Instant::now();
    let result = state
        .handle_gesture(GestureRequest {
            mode: ControlMode::Multi,
            target_ids: online.clone(),
            strokes,
        })
        .await
        .expect("gesture runs");
    assert!(started.elapsed() >= Duration::from_millis(120));
    // Both phones play at once, not one after the other.
    assert!(started.elapsed() < Duration::from_millis(1000));
    assert_eq!(result.targets.len(), online.len());
    assert!(result.targets.iter().all(|t| t.inject == InjectStatus::Stub));

    let bad = state
        .handle_gesture(GestureRequest {
            mode: ControlMode::Selected,
            target_ids: online[..1].to_vec(),
            strokes: vec![],
        })
        .await;
    assert!(bad.is_err());
}

#[tokio::test]
async fn pointer_rejects_unknown_video_size_and_accepts_real_frame() {
    let state = AppState::new(
        Role::Controller,
        "pointer-test".into(),
        "pointer-test".into(),
        0,
        None,
    );
    let devices = state.list_devices().await;
    let device = devices
        .iter()
        .find(|d| d.status == DeviceStatus::Online)
        .expect("mock fleet has an online device");
    let id = device.id.clone();
    let point = NormalizedPoint { x: 0.25, y: 0.5 };

    let unknown = state
        .handle_pointer(
            ControlMode::Selected,
            &[id.clone()],
            PointerPhase::Down,
            PointerTool::Finger,
            point,
            0,
            0,
        )
        .await
        .expect("0×0 pointer still returns a broadcast");
    let rejected = &unknown.targets[0];
    assert_eq!(rejected.inject, InjectStatus::Error);
    assert_eq!(rejected.width, 0);
    assert_eq!(rejected.height, 0);
    let detail = rejected.inject_detail.as_deref().unwrap_or("");
    assert!(
        detail.contains("video size unknown"),
        "0×0 pointer should be rejected, got {detail}"
    );

    let known = state
        .handle_pointer(
            ControlMode::Selected,
            &[id],
            PointerPhase::Down,
            PointerTool::Finger,
            point,
            360,
            640,
        )
        .await
        .expect("sized pointer returns a broadcast");
    let sent = &known.targets[0];
    let detail = sent.inject_detail.as_deref().unwrap_or("");
    assert!(
        !detail.contains("video size unknown"),
        "real frame size must not be rejected as unknown, got {detail}"
    );
    assert_eq!(sent.width, 360);
    assert_eq!(sent.height, 640);
    assert_ne!(sent.width, device.resolution.width);
    assert_eq!(sent.x, 90);
    assert_eq!(sent.y, 320);
}

#[tokio::test]
async fn multi_pointer_uses_each_devices_video_size() {
    let state = AppState::new(
        Role::Controller,
        "pointer-multi".into(),
        "pointer-multi".into(),
        0,
        None,
    );
    let devices = state.list_devices().await;
    let online: Vec<_> = devices
        .iter()
        .filter(|device| device.status == DeviceStatus::Online)
        .take(2)
        .cloned()
        .collect();
    assert!(online.len() == 2, "mock fleet needs two online phones");
    let first = &online[0];
    state
        .start_session_local(&first.serial)
        .await
        .expect("first phone streams");
    let ids = vec![first.id.clone(), online[1].id.clone()];
    let point = NormalizedPoint { x: 0.25, y: 0.5 };
    let broadcast = state
        .handle_pointer(
            ControlMode::Multi,
            &ids,
            PointerPhase::Down,
            PointerTool::Finger,
            point,
            1080,
            2400,
        )
        .await
        .expect("multi pointer returns every target");
    assert_eq!(broadcast.targets.len(), 2);
    let streamed = broadcast
        .targets
        .iter()
        .find(|tap| tap.device_id == first.id)
        .expect("first phone is in the broadcast");
    assert_eq!(streamed.width, 360);
    assert_eq!(streamed.height, 640);
    assert_eq!(streamed.x, 90);
    assert_eq!(streamed.y, 320);
    assert_ne!(streamed.width, 1080);
    let other = broadcast
        .targets
        .iter()
        .find(|tap| tap.device_id == online[1].id)
        .expect("second phone is in the broadcast");
    assert_eq!(
        (other.width, other.height),
        (360, 640),
        "second phone must use its own stream, not the 1080×2400 picture on screen ({})",
        other.inject_detail.as_deref().unwrap_or("")
    );
}

fn sample(serial: &str, status: DeviceStatus) -> Device {
    Device {
        id: serial.into(),
        name: serial.into(),
        model: "m".into(),
        model_name: None,
        android_version: "15".into(),
        serial: serial.into(),
        connection: adboard_protocol::ConnectionType::Usb,
        status,
        battery: None,
        temperature_c: None,
        cpu_percent: None,
        memory_percent: None,
        resolution: adboard_protocol::DeviceResolution {
            width: 1080,
            height: 1920,
        },
        fps: None,
        bitrate_mbps: None,
        latency_ms: None,
        host: "windows-host".into(),
        host_id: None,
        wallpaper_hue: 0,
    }
}

#[test]
fn note_display_size_override_tracks_and_clears() {
    let mut overrides = HashSet::new();
    note_display_size_override(&mut overrides, "s24", "1080x1920");
    assert!(overrides.contains("s24"));
    note_display_size_override(&mut overrides, "s24", "reset");
    assert!(!overrides.contains("s24"));
    note_display_size_override(&mut overrides, "s23", "1080x2400");
    note_display_size_override(&mut overrides, "s23", "native");
    assert!(!overrides.contains("s23"));
}

#[test]
fn recovery_restarts_only_the_device_that_dropped() {
    let mut previous = HashMap::new();
    previous.insert("s24".into(), DeviceStatus::Online);
    previous.insert("s23".into(), DeviceStatus::Online);
    let next = vec![
        sample("s24", DeviceStatus::Offline),
        sample("s23", DeviceStatus::Online),
    ];
    let actions = recovery_actions(&previous, &next, false);
    assert_eq!(
        actions,
        vec![RecoveryAction::RestartAdb {
            serial: "s24".into()
        }]
    );

    previous.insert("s24".into(), DeviceStatus::Offline);
    let back = vec![
        sample("s24", DeviceStatus::Online),
        sample("s23", DeviceStatus::Online),
    ];
    let actions = recovery_actions(&previous, &back, false);
    assert_eq!(
        actions,
        vec![RecoveryAction::RestartSession {
            serial: "s24".into()
        }]
    );
}

#[test]
fn recovery_sets_size_when_a_phone_first_appears_online() {
    let previous = HashMap::new();
    let next = vec![sample("s24", DeviceStatus::Online)];
    // With a connect size configured, a new phone restarts scrcpy after resizing.
    let actions = recovery_actions(&previous, &next, true);
    assert_eq!(
        actions,
        vec![RecoveryAction::RestartSession {
            serial: "s24".into()
        }]
    );
    // Default: first sight of a phone does not restart anything.
    assert!(recovery_actions(&previous, &next, false).is_empty());
}
