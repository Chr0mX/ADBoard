use super::watcher::{
    describe_adb_failure, reconnect_delay, recovery_actions, FailureStep, PollHealth, RecoveryAction, Reconnects, ServerFix,
    RECONNECT_MAX_ATTEMPTS,
};
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
    let _guard = crate::adb::INPUT_LIMIT_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
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
    let _guard = crate::adb::INPUT_LIMIT_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
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

#[test]
fn a_timed_out_poll_starts_then_restarts_the_server_and_backs_off() {
    let timeout = "adb did not answer within 15 s: devices -l";
    let mut health = PollHealth::default();
    let first = health.failure(timeout);
    assert_eq!(first.fix, ServerFix::Start);
    assert_eq!(first.wait, Duration::from_secs(ADB_POLL_SECS));
    assert!(first.notice.as_deref().unwrap().contains("restarting it"));
    let steps: Vec<FailureStep> = (0..12).map(|_| health.failure(timeout)).collect();
    // Failures 2..=13: one notice only (the first), a restart at 3 and 13, waits up to 10 s.
    assert!(steps.iter().all(|step| step.notice.is_none()));
    let restarts: Vec<usize> = steps.iter().enumerate().filter(|(_, s)| s.fix == ServerFix::Restart).map(|(i, _)| i + 2).collect();
    assert_eq!(restarts, vec![3, 13]);
    assert_eq!(steps[0].wait, Duration::from_secs(4));
    assert_eq!(steps[1].wait, Duration::from_secs(8));
    assert_eq!(steps[11].wait, Duration::from_secs(10));
    // Recovery is announced once, and the next failure starts a fresh run.
    assert!(health.success().is_some());
    assert!(health.success().is_none());
    assert_eq!(health.failure(timeout).fix, ServerFix::Start);
}

#[test]
fn other_adb_errors_do_not_touch_the_server_and_name_a_version_fight() {
    let mut health = PollHealth::default();
    let step = health.failure("adb exited exit code: 1: adb server version (41) doesn't match this client (39)");
    assert_eq!(step.fix, ServerFix::None);
    assert!(step.notice.unwrap().contains("different version"));
    assert!(describe_adb_failure("adb exited 1: boom").ends_with("boom"));
}

// ---- Quiet cycle (repeat indefinitely) on the mock fleet ----

fn quiet_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

fn muted(serial: &str) -> bool {
    mock_muted().lock().unwrap_or_else(|e| e.into_inner()).get(serial).copied().unwrap_or(false)
}

async fn online_serials(state: &AppState) -> Vec<String> {
    state
        .list_devices()
        .await
        .into_iter()
        .filter(|d| d.status == DeviceStatus::Online)
        .map(|d| d.serial)
        .collect()
}

#[tokio::test]
async fn quiet_cycle_applies_each_phase_to_every_online_phone() {
    let _guard = quiet_lock();
    let state = AppState::new(Role::Controller, "q".into(), "q".into(), 0, None);
    let serials = online_serials(&state).await;
    assert!(serials.len() >= 2, "the mock fleet has several online phones");

    crate::quiet_cycle::start(600, crate::quiet_cycle::Phase::Quiet);
    crate::quiet_cycle::reconcile(&state).await;
    assert!(serials.iter().all(|s| muted(s)), "quiet phase mutes all online phones");
    assert!(state.inner.sessions.prefs().await.screen_off, "and turns their screens off");

    // The clock moves into the normal phase (as the saved file would say after a restart).
    crate::quiet_cycle::start(600, crate::quiet_cycle::Phase::Normal);
    crate::quiet_cycle::reconcile(&state).await;
    assert!(serials.iter().all(|s| !muted(s)), "normal phase restores the sound");
    assert!(!state.inner.sessions.prefs().await.screen_off);
    assert!(crate::quiet_cycle::status().cycle.enabled, "its own changes do not stop the cycle");
    crate::quiet_cycle::stop();
}

#[tokio::test]
async fn quiet_cycle_reaches_a_phone_that_appears_later() {
    let _guard = quiet_lock();
    let state = AppState::new(Role::Controller, "q".into(), "q".into(), 0, None);
    let all = state.list_devices().await;
    let late = all.iter().find(|d| d.status == DeviceStatus::Online).cloned().expect("online phone");
    // Start with that phone missing from the fleet, then bring it back.
    let without: Vec<_> = state.inner.devices.read().await.iter().filter(|d| d.serial != late.serial).cloned().collect();
    let full = state.inner.devices.read().await.clone();
    *state.inner.devices.write().await = without;
    mock_muted().lock().unwrap_or_else(|e| e.into_inner()).remove(&late.serial);

    crate::quiet_cycle::start(600, crate::quiet_cycle::Phase::Quiet);
    crate::quiet_cycle::reconcile(&state).await;
    assert!(!muted(&late.serial), "not connected yet");

    *state.inner.devices.write().await = full;
    crate::quiet_cycle::reconcile(&state).await;
    assert!(muted(&late.serial), "muted once it reconnects mid-quiet");
    crate::quiet_cycle::stop();
}

#[tokio::test]
async fn changing_quiet_mode_by_hand_stops_the_cycle() {
    let _guard = quiet_lock();
    let state = AppState::new(Role::Controller, "q".into(), "q".into(), 0, None);
    let ids: Vec<String> = state.list_devices().await.into_iter().filter(|d| d.status == DeviceStatus::Online).map(|d| d.id).collect();

    crate::quiet_cycle::start(600, crate::quiet_cycle::Phase::Quiet);
    state
        .handle_command(DeviceCommandRequest { target_ids: ids.clone(), op: "mute".into(), arg: Some("off".into()), arg2: None })
        .await
        .expect("mute runs");
    assert!(!crate::quiet_cycle::status().cycle.enabled, "a manual mute change stops it");

    // Other options (same screen power) leave a running cycle alone.
    crate::quiet_cycle::start(600, crate::quiet_cycle::Phase::Quiet);
    let prefs = state.inner.sessions.prefs().await;
    state
        .handle_scrcpy_options(ScrcpyOptionsRequest {
            mode: ControlMode::Selected,
            target_ids: ids.clone(),
            quality: prefs.quality.clone(),
            audio: prefs.audio,
            screen_off: prefs.screen_off,
            max_size: prefs.max_size,
            video_bit_rate: prefs.video_bit_rate,
            max_fps: prefs.max_fps,
        })
        .await
        .expect("options apply");
    assert!(crate::quiet_cycle::status().cycle.enabled);

    state
        .handle_scrcpy_options(ScrcpyOptionsRequest {
            mode: ControlMode::Selected,
            target_ids: ids,
            quality: prefs.quality,
            audio: prefs.audio,
            screen_off: !prefs.screen_off,
            max_size: prefs.max_size,
            video_bit_rate: prefs.video_bit_rate,
            max_fps: prefs.max_fps,
        })
        .await
        .expect("options apply");
    assert!(!crate::quiet_cycle::status().cycle.enabled, "a manual screen change stops it");
}

// ---- Unplug recovery and reconnect backoff ----

#[test]
fn reconnect_waits_longer_each_time_up_to_five_minutes() {
    let secs: Vec<u64> = (1..8).map(|n| reconnect_delay(n).as_secs()).collect();
    assert_eq!(secs, vec![20, 40, 80, 160, 300, 300, 300]);
    assert_eq!(reconnect_delay(0).as_secs(), 10);
}

#[test]
fn a_lost_phone_is_retried_on_a_backoff_and_not_every_poll() {
    let start = std::time::Instant::now();
    let mut r = Reconnects::default();
    r.lost("A", start);
    assert_eq!(r.due(start), vec![("A".to_string(), 0)], "first try at once");
    // Polls every 2 s in between do nothing.
    for secs in 1..19 {
        assert!(r.due(start + Duration::from_secs(secs)).is_empty(), "no retry at {secs}s");
    }
    assert_eq!(r.due(start + Duration::from_secs(20)), vec![("A".to_string(), 1)]);
    assert!(r.due(start + Duration::from_secs(20 + 39)).is_empty());
    assert_eq!(r.due(start + Duration::from_secs(20 + 40)), vec![("A".to_string(), 2)]);
}

#[test]
fn tracking_a_phone_twice_does_not_restart_its_backoff() {
    let start = std::time::Instant::now();
    let mut r = Reconnects::default();
    r.lost("A", start);
    r.due(start);
    r.lost("A", start + Duration::from_secs(5));
    assert!(r.due(start + Duration::from_secs(5)).is_empty());
}

#[test]
fn a_phone_that_returns_stops_being_retried_and_others_are_unaffected() {
    let start = std::time::Instant::now();
    let mut r = Reconnects::default();
    r.lost("A", start);
    r.lost("B", start);
    assert_eq!(r.due(start).len(), 2);
    r.recovered("A");
    let later = start + Duration::from_secs(20);
    assert_eq!(r.due(later), vec![("B".to_string(), 1)]);
}

#[test]
fn a_phone_that_never_comes_back_is_given_up_on() {
    let start = std::time::Instant::now();
    let mut r = Reconnects::default();
    r.lost("A", start);
    let mut tries = 0;
    for minute in 0..200u64 {
        tries += r.due(start + Duration::from_secs(minute * 60)).len() as u32;
    }
    assert_eq!(tries, RECONNECT_MAX_ATTEMPTS);
    assert!(r.due(start + Duration::from_secs(100_000)).is_empty());
}

/// A stand-in `adb` that records its arguments, one call per line.
#[cfg(unix)]
fn recording_adb() -> (PathBuf, PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let dir = std::env::temp_dir().join(format!("adboard-rec-adb-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let log = dir.join("calls.txt");
    let path = dir.join("adb");
    std::fs::write(&path, format!("#!/bin/sh\necho \"$@\" >> {}\nexit 0\n", log.display())).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    (path, log)
}

#[cfg(unix)]
fn calls(log: &std::path::Path) -> String {
    std::fs::read_to_string(log).unwrap_or_default()
}

#[cfg(unix)]
#[tokio::test]
async fn a_returning_phone_gets_its_screen_on_unless_the_loop_is_running() {
    let _guard = quiet_lock();
    let (adb, log) = recording_adb();
    let state = AppState::new(Role::Controller, "rec".into(), "rec".into(), 0, Some(adb));

    // The loop quiets a phone itself, so a returning phone is not woken, in either phase.
    for phase in [crate::quiet_cycle::Phase::Quiet, crate::quiet_cycle::Phase::Normal] {
        crate::quiet_cycle::start(600, phase);
        state.restore_screen_after_reconnect("FAKE1").await;
        assert!(!calls(&log).contains("KEYCODE_WAKEUP"), "{phase:?}");
    }

    crate::quiet_cycle::stop();
    state.restore_screen_after_reconnect("FAKE2").await;
    assert!(calls(&log).contains("-s FAKE2 shell input keyevent KEYCODE_WAKEUP"), "no loop: a returning phone is woken");
}

#[cfg(unix)]
#[tokio::test]
async fn an_unplugged_phone_gets_its_display_size_reset_once_and_only_that_phone() {
    let (adb, log) = recording_adb();
    let state = AppState::new(Role::Controller, "rec".into(), "rec".into(), 0, Some(adb));
    state.inner.display_size_overrides.lock().unwrap().insert("FAKE1".into());
    state.reset_overridden_display_size("FAKE1").await;
    assert!(calls(&log).contains("-s FAKE1 shell wm size reset"), "{}", calls(&log));
    assert!(!state.inner.display_size_overrides.lock().unwrap().contains("FAKE1"));
    // Already reset, and a phone ADBoard never resized: nothing more is sent.
    let sent = calls(&log).lines().count();
    state.reset_overridden_display_size("FAKE1").await;
    state.reset_overridden_display_size("FAKE2").await;
    assert_eq!(calls(&log).lines().count(), sent);
}

#[tokio::test]
async fn quiet_cycle_keeps_a_phone_pending_until_both_sound_and_screen_succeed() {
    let _guard = quiet_lock();
    let state = AppState::new(Role::Controller, "q".into(), "q".into(), 0, None);
    let serials = online_serials(&state).await;
    crate::quiet_cycle::start(600, crate::quiet_cycle::Phase::Quiet);
    crate::quiet_cycle::reconcile(&state).await;
    // The mock phones have no live scrcpy control, so the screen change fails for each of them
    // while the sound change succeeds: every phone is pending, with only the sound done.
    for serial in &serials {
        assert!(muted(serial));
        assert_eq!(crate::quiet_cycle::done_for(serial), Some((true, false)), "{serial}");
    }
    // The sound is not sent again on the retry: change it by hand and let the cycle run once more.
    {
        let mut map = mock_muted().lock().unwrap_or_else(|e| e.into_inner());
        for serial in &serials {
            map.insert(serial.clone(), false);
        }
    }
    crate::quiet_cycle::reconcile(&state).await;
    assert!(serials.iter().all(|s| !muted(s)), "an operation that already succeeded is not repeated");
    assert!(serials.iter().all(|s| crate::quiet_cycle::done_for(s) == Some((true, false))), "the screen is still pending");
    crate::quiet_cycle::stop();
}

#[tokio::test]
async fn a_phone_that_connects_during_a_normal_phase_goes_quiet_at_once() {
    let _guard = quiet_lock();
    let state = AppState::new(Role::Controller, "q".into(), "q".into(), 0, None);
    let full = state.inner.devices.read().await.clone();
    let late = full.iter().find(|d| d.status == DeviceStatus::Online).cloned().expect("online phone");
    let others: Vec<String> = online_serials(&state).await.into_iter().filter(|s| *s != late.serial).collect();
    mock_muted().lock().unwrap_or_else(|e| e.into_inner()).clear();

    // The loop starts in its Normal phase with the late phone not yet connected.
    *state.inner.devices.write().await = full.iter().filter(|d| d.serial != late.serial).cloned().collect();
    crate::quiet_cycle::start(600, crate::quiet_cycle::Phase::Normal);
    crate::quiet_cycle::reconcile(&state).await;
    assert!(others.iter().all(|s| !muted(s)), "phones that were already here stay normal in a Normal phase");

    // It connects: quiet right away, while the others are untouched.
    *state.inner.devices.write().await = full.clone();
    crate::quiet_cycle::reconcile(&state).await;
    assert!(muted(&late.serial), "the new phone is muted at once");
    assert!(others.iter().all(|s| !muted(s)), "the others stay normal");

    // It drops and comes back: new again, quiet again.
    mock_muted().lock().unwrap_or_else(|e| e.into_inner()).insert(late.serial.clone(), false);
    *state.inner.devices.write().await = full.iter().filter(|d| d.serial != late.serial).cloned().collect();
    crate::quiet_cycle::reconcile(&state).await;
    *state.inner.devices.write().await = full;
    crate::quiet_cycle::reconcile(&state).await;
    assert!(muted(&late.serial), "a reconnecting phone goes quiet too");
    crate::quiet_cycle::stop();
}

#[tokio::test]
async fn a_quick_replug_is_still_a_new_phone_for_the_loop() {
    let _guard = quiet_lock();
    let state = AppState::new(Role::Controller, "q".into(), "q".into(), 0, None);
    let serial = online_serials(&state).await.remove(0);
    mock_muted().lock().unwrap_or_else(|e| e.into_inner()).clear();
    crate::quiet_cycle::start(600, crate::quiet_cycle::Phase::Normal);
    crate::quiet_cycle::reconcile(&state).await; // baseline: nobody is new
    assert!(!muted(&serial));
    // The phone is unplugged and back between two checks: the watcher tells the loop.
    crate::quiet_cycle::note_connected(&serial);
    crate::quiet_cycle::reconcile(&state).await;
    assert!(muted(&serial), "the replugged phone goes quiet");
    crate::quiet_cycle::stop();
}

#[cfg(unix)]
#[tokio::test]
async fn a_returning_phone_keeps_its_screen_off_while_quiet_mode_is_on() {
    let _guard = quiet_lock();
    crate::quiet_cycle::stop();
    let (adb, log) = recording_adb();
    let state = AppState::new(Role::Controller, "rec".into(), "rec".into(), 0, Some(adb));
    let mut prefs = state.inner.sessions.prefs().await;
    prefs.screen_off = true;
    state.inner.sessions.apply_options(prefs.clone(), &[]).await.unwrap();
    state.restore_screen_after_reconnect("FAKE1").await;
    assert!(!calls(&log).contains("KEYCODE_WAKEUP"), "Quiet mode on: not woken");
    prefs.screen_off = false;
    state.inner.sessions.apply_options(prefs, &[]).await.unwrap();
    state.restore_screen_after_reconnect("FAKE1").await;
    assert!(calls(&log).contains("KEYCODE_WAKEUP"), "Quiet mode off: woken");
}
