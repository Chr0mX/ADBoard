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
async fn changing_quiet_mode_by_hand_stops_the_cycle() {
    let _guard = quiet_lock();
    let state = AppState::new(Role::Controller, "q".into(), "q".into(), 0, None);
    let ids: Vec<String> = state.list_devices().await.into_iter().filter(|d| d.status == DeviceStatus::Online).map(|d| d.id).collect();

    crate::quiet_cycle::start(600, 3);
    state
        .handle_command(DeviceCommandRequest { target_ids: ids.clone(), op: "mute".into(), arg: Some("off".into()), arg2: None })
        .await
        .expect("mute runs");
    assert!(!crate::quiet_cycle::status().cycle.enabled, "a manual mute change stops it");

    // Other options (same screen power) leave a running cycle alone.
    crate::quiet_cycle::start(600, 3);
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

#[cfg(unix)]
#[tokio::test]
async fn a_failed_size_reset_is_remembered_and_done_when_the_phone_is_back() {
    use std::os::unix::fs::PermissionsExt;
    let dir = std::env::temp_dir().join(format!("adboard-fail-adb-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let failing = dir.join("adb");
    std::fs::write(&failing, "#!/bin/sh\necho 'device not found' >&2\nexit 1\n").unwrap();
    std::fs::set_permissions(&failing, std::fs::Permissions::from_mode(0o755)).unwrap();
    let state = AppState::new(Role::Controller, "f".into(), "f".into(), 0, Some(failing));
    state.inner.display_size_overrides.lock().unwrap().insert("FAKE1".into());
    // Cable pulled first: the reset cannot reach the phone, so the override is kept.
    state.reset_overridden_display_size("FAKE1").await;
    assert!(state.inner.display_size_overrides.lock().unwrap().contains("FAKE1"));
    // The phone is back (adb answers): the same call now resets it and forgets the override.
    let (adb, log) = recording_adb();
    let back = AppState::new(Role::Controller, "b".into(), "b".into(), 0, Some(adb));
    back.inner.display_size_overrides.lock().unwrap().insert("FAKE1".into());
    back.reset_overridden_display_size("FAKE1").await;
    assert!(calls(&log).contains("-s FAKE1 shell wm size reset"));
    assert!(!back.inner.display_size_overrides.lock().unwrap().contains("FAKE1"));
}

// ---- Quiet Mode Loop: quiet for the full duration, a brief muted screen-on, repeat ----

fn screen_off_now(state: &AppState) -> bool {
    tokio::task::block_in_place(|| {
        tokio::runtime::Handle::current().block_on(async { state.inner.sessions.prefs().await.screen_off })
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn the_loop_goes_quiet_instantly_and_keeps_the_sound_muted_in_both_phases() {
    let _guard = quiet_lock();
    let state = AppState::new(Role::Controller, "q".into(), "q".into(), 0, None);
    let serials = online_serials(&state).await;
    assert!(serials.len() >= 2, "the mock fleet has several online phones");
    mock_muted().lock().unwrap_or_else(|e| e.into_inner()).clear();

    // Enabling it: quiet at once, no waiting for an interval.
    let status = crate::quiet_cycle::start(600, 3);
    assert_eq!(status.phase, crate::quiet_cycle::Phase::Quiet);
    crate::quiet_cycle::reconcile(&state).await;
    assert!(serials.iter().all(|s| muted(s)), "muted at once");
    assert!(screen_off_now(&state), "screen off at once");

    // The screen-on phase: screen on, sound still muted.
    crate::quiet_cycle::force_phase(crate::quiet_cycle::Phase::Peek);
    crate::quiet_cycle::reconcile(&state).await;
    assert!(serials.iter().all(|s| muted(s)), "never unmuted during the screen-on phase");
    assert!(!screen_off_now(&state), "screen on");

    // Back to quiet, and again: it repeats and the sound never comes back.
    for _ in 0..3 {
        crate::quiet_cycle::force_phase(crate::quiet_cycle::Phase::Quiet);
        crate::quiet_cycle::reconcile(&state).await;
        assert!(screen_off_now(&state));
        crate::quiet_cycle::force_phase(crate::quiet_cycle::Phase::Peek);
        crate::quiet_cycle::reconcile(&state).await;
        assert!(!screen_off_now(&state));
        assert!(serials.iter().all(|s| muted(s)));
    }
    assert!(crate::quiet_cycle::status().cycle.enabled, "the loop's own changes do not stop it");
    crate::quiet_cycle::stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn turning_the_loop_off_restores_sound_and_screen_in_either_phase() {
    let _guard = quiet_lock();
    for phase in [crate::quiet_cycle::Phase::Quiet, crate::quiet_cycle::Phase::Peek] {
        let state = AppState::new(Role::Controller, "q".into(), "q".into(), 0, None);
        let serials = online_serials(&state).await;
        crate::quiet_cycle::start(600, 3);
        crate::quiet_cycle::force_phase(phase);
        crate::quiet_cycle::reconcile(&state).await;
        assert!(serials.iter().all(|s| muted(s)), "{phase:?}");
        let status = crate::quiet_cycle::stop_and_restore(&state).await;
        assert!(!status.enabled);
        assert!(serials.iter().all(|s| !muted(s)), "sound restored when turned off during {phase:?}");
        assert!(!screen_off_now(&state), "screen on when turned off during {phase:?}");
        // Nothing is applied after it is off.
        mock_muted().lock().unwrap_or_else(|e| e.into_inner()).clear();
        crate::quiet_cycle::reconcile(&state).await;
        assert!(serials.iter().all(|s| !muted(s)));
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_phone_that_connects_in_either_phase_gets_that_phase_at_once() {
    let _guard = quiet_lock();
    for phase in [crate::quiet_cycle::Phase::Quiet, crate::quiet_cycle::Phase::Peek] {
        let state = AppState::new(Role::Controller, "q".into(), "q".into(), 0, None);
        let full = state.inner.devices.read().await.clone();
        let late = full.iter().find(|d| d.status == DeviceStatus::Online).cloned().expect("online phone");
        let others: Vec<String> = online_serials(&state).await.into_iter().filter(|s| *s != late.serial).collect();
        mock_muted().lock().unwrap_or_else(|e| e.into_inner()).clear();

        *state.inner.devices.write().await = full.iter().filter(|d| d.serial != late.serial).cloned().collect();
        crate::quiet_cycle::start(600, 3);
        crate::quiet_cycle::force_phase(phase);
        crate::quiet_cycle::reconcile(&state).await;
        assert!(others.iter().all(|s| muted(s)));
        assert!(!muted(&late.serial), "not connected yet");

        *state.inner.devices.write().await = full;
        crate::quiet_cycle::reconcile(&state).await;
        assert!(muted(&late.serial), "muted at once, {phase:?}");
        crate::quiet_cycle::stop();
    }
}

#[tokio::test]
async fn a_quick_replug_between_two_checks_is_not_missed() {
    let _guard = quiet_lock();
    let state = AppState::new(Role::Controller, "q".into(), "q".into(), 0, None);
    let serial = online_serials(&state).await.remove(0);
    mock_muted().lock().unwrap_or_else(|e| e.into_inner()).clear();
    crate::quiet_cycle::start(600, 3);
    crate::quiet_cycle::reconcile(&state).await;
    assert!(muted(&serial));
    // It was unplugged and replugged (volume back to normal) before the next check; the
    // watcher tells the loop, so the phone is put back into the current phase.
    mock_muted().lock().unwrap_or_else(|e| e.into_inner()).insert(serial.clone(), false);
    crate::quiet_cycle::note_connected(&serial);
    crate::quiet_cycle::reconcile(&state).await;
    assert!(muted(&serial), "muted again");
    // Duplicate connect events do no harm.
    crate::quiet_cycle::note_connected(&serial);
    crate::quiet_cycle::note_connected(&serial);
    crate::quiet_cycle::reconcile(&state).await;
    assert!(muted(&serial));
    crate::quiet_cycle::stop();
}

#[tokio::test]
async fn sound_is_muted_once_per_run_and_the_screen_retried_on_its_own() {
    let _guard = quiet_lock();
    let state = AppState::new(Role::Controller, "q".into(), "q".into(), 0, None);
    let serials = online_serials(&state).await;
    mock_muted().lock().unwrap_or_else(|e| e.into_inner()).clear();
    crate::quiet_cycle::start(600, 3);
    crate::quiet_cycle::reconcile(&state).await;
    // The mock phones have no live scrcpy control, so the screen change fails for each while the
    // sound succeeds: pending, with only the sound done.
    for serial in &serials {
        assert!(muted(serial));
        assert_eq!(crate::quiet_cycle::done_for(serial), Some((true, false)), "{serial}");
    }
    // The mute is not sent again on the retry: change it by hand and let the loop run once more.
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
async fn a_returning_phone_is_not_woken_while_the_loop_runs() {
    let _guard = quiet_lock();
    let (adb, log) = recording_adb();
    let state = AppState::new(Role::Controller, "rec".into(), "rec".into(), 0, Some(adb));
    for phase in [crate::quiet_cycle::Phase::Quiet, crate::quiet_cycle::Phase::Peek] {
        crate::quiet_cycle::start(600, 3);
        crate::quiet_cycle::force_phase(phase);
        state.restore_screen_after_reconnect("FAKE1").await;
        assert!(!calls(&log).contains("KEYCODE_WAKEUP"), "{phase:?}");
    }
    crate::quiet_cycle::stop();
    state.restore_screen_after_reconnect("FAKE2").await;
    assert!(calls(&log).contains("-s FAKE2 shell input keyevent KEYCODE_WAKEUP"), "no loop: woken");
}

// ---- Quiet Mode Loop: waking at once, and reconnect handling ----

fn device_at(template: &Device, serial: &str, status: DeviceStatus) -> Device {
    let mut d = template.clone();
    d.serial = serial.to_string();
    d.id = format!("id-{serial}");
    d.status = status;
    d
}


#[tokio::test(flavor = "multi_thread")]
async fn enabling_the_loop_wakes_a_sleeping_task_and_phones_go_quiet_at_once() {
    let _guard = quiet_lock();
    crate::quiet_cycle::stop();
    let state = AppState::new(Role::Controller, "q".into(), "q".into(), 0, None);
    let serials = online_serials(&state).await;
    mock_muted().lock().unwrap_or_else(|e| e.into_inner()).clear();
    // A task whose normal check is an hour away: only the wake can make this quick.
    let task = crate::quiet_cycle::spawn_for_test(state.clone(), std::time::Duration::from_secs(3600));
    tokio::time::sleep(std::time::Duration::from_millis(300)).await; // it is asleep now
    assert!(serials.iter().all(|s| !muted(s)));
    crate::quiet_cycle::start(600, 3);
    let started = std::time::Instant::now();
    while !serials.iter().all(|s| muted(s)) && started.elapsed() < std::time::Duration::from_secs(3) {
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert!(serials.iter().all(|s| muted(s)), "muted without waiting for a check");
    assert!(started.elapsed() < std::time::Duration::from_secs(3));
    assert!(screen_off_now(&state), "screen off too");
    task.abort();
    crate::quiet_cycle::stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_connect_event_wakes_the_sleeping_task_which_puts_the_phone_in_the_current_phase() {
    let _guard = quiet_lock();
    for phase in [crate::quiet_cycle::Phase::Quiet, crate::quiet_cycle::Phase::Peek] {
        let state = AppState::new(Role::Controller, "q".into(), "q".into(), 0, None);
        let serial = online_serials(&state).await.remove(0);
        mock_muted().lock().unwrap_or_else(|e| e.into_inner()).clear();
        crate::quiet_cycle::start(600, 3);
        crate::quiet_cycle::force_phase(phase);
        let task = crate::quiet_cycle::spawn_for_test(state.clone(), std::time::Duration::from_secs(3600));
        let wait_muted = |want: bool| {
            let serial = serial.clone();
            async move {
                let t = std::time::Instant::now();
                while muted(&serial) != want && t.elapsed() < std::time::Duration::from_secs(3) {
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                }
                muted(&serial) == want
            }
        };
        assert!(wait_muted(true).await, "{phase:?}: muted by the first round");
        // The phone was unplugged and replugged: its volume is back, and nothing else has happened.
        mock_muted().lock().unwrap_or_else(|e| e.into_inner()).insert(serial.clone(), false);
        crate::quiet_cycle::note_connected(&serial);
        assert!(wait_muted(true).await, "{phase:?}: muted again without waiting for a check");
        // The timer was not restarted by the reconnect.
        assert_eq!(crate::quiet_cycle::status().cycle.phase, phase);
        task.abort();
        crate::quiet_cycle::stop();
    }
}

#[tokio::test]
async fn duplicate_connect_events_are_harmless() {
    let _guard = quiet_lock();
    let state = AppState::new(Role::Controller, "q".into(), "q".into(), 0, None);
    let serial = online_serials(&state).await.remove(0);
    mock_muted().lock().unwrap_or_else(|e| e.into_inner()).clear();
    crate::quiet_cycle::start(600, 3);
    let before = crate::quiet_cycle::status().cycle;
    for _ in 0..5 {
        crate::quiet_cycle::note_connected(&serial);
        crate::quiet_cycle::note_disconnected(&serial);
    }
    crate::quiet_cycle::reconcile(&state).await;
    crate::quiet_cycle::reconcile(&state).await;
    assert!(muted(&serial));
    let after = crate::quiet_cycle::status().cycle;
    assert_eq!((before.phase, before.phase_started_ms, before.phase_ends_ms), (after.phase, after.phase_started_ms, after.phase_ends_ms), "the timer did not move");
    crate::quiet_cycle::stop();
}

#[tokio::test]
async fn phones_reconnecting_are_redone_one_by_one() {
    let _guard = quiet_lock();
    let state = AppState::new(Role::Controller, "q".into(), "q".into(), 0, None);
    let serials = online_serials(&state).await;
    let (a, b) = (serials[0].clone(), serials[1].clone());
    mock_muted().lock().unwrap_or_else(|e| e.into_inner()).clear();
    crate::quiet_cycle::start(600, 3);
    crate::quiet_cycle::reconcile(&state).await;
    {
        let mut map = mock_muted().lock().unwrap_or_else(|e| e.into_inner());
        map.insert(a.clone(), false);
        map.insert(b.clone(), false);
    }
    // Only A reconnected: only A is sent its changes again.
    crate::quiet_cycle::note_connected(&a);
    crate::quiet_cycle::reconcile(&state).await;
    assert!(muted(&a));
    assert!(!muted(&b), "B did not reconnect and is not touched");
    crate::quiet_cycle::note_connected(&b);
    crate::quiet_cycle::reconcile(&state).await;
    assert!(muted(&b));
    crate::quiet_cycle::stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn turning_the_loop_off_while_a_round_runs_still_ends_restored() {
    let _guard = quiet_lock();
    let state = AppState::new(Role::Controller, "q".into(), "q".into(), 0, None);
    let serials = online_serials(&state).await;
    mock_muted().lock().unwrap_or_else(|e| e.into_inner()).clear();
    crate::quiet_cycle::start(600, 3);
    // A round and the restore at the same time: the restore is the last word.
    let (_, status) = tokio::join!(crate::quiet_cycle::reconcile(&state), crate::quiet_cycle::stop_and_restore(&state));
    assert!(!status.enabled);
    assert!(serials.iter().all(|s| !muted(s)), "restored, not left quiet by the round");
    assert!(!screen_off_now(&state));
}

// ---- adb track-devices, connection generations ----

mod tracking {
    use super::super::connections::{ConnectionBook, Transition};
    use super::super::tracker::{apply_frame, parse_track_payload, read_frame, track_once};
    use super::super::watcher::generation_restarts;
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn state() -> AppState {
        AppState::new(Role::Controller, "t".into(), "t".into(), 0, None)
    }

    fn frame(lines: &[(&str, DeviceStatus)]) -> Vec<(String, DeviceStatus)> {
        lines.iter().map(|(s, st)| (s.to_string(), *st)).collect()
    }

    #[test]
    fn a_track_payload_is_parsed_and_malformed_lines_are_skipped() {
        let parsed = parse_track_payload("R5CW\tdevice\nAAA\toffline\nBBB\tunauthorized\ngarbage\n\n192.168.1.5:5555\tdevice\nXYZ\trecovery\n");
        assert_eq!(
            parsed,
            vec![
                ("R5CW".to_string(), DeviceStatus::Online),
                ("AAA".to_string(), DeviceStatus::Offline),
                ("BBB".to_string(), DeviceStatus::Unauthorized),
                ("192.168.1.5:5555".to_string(), DeviceStatus::Online),
                ("XYZ".to_string(), DeviceStatus::Offline),
            ]
        );
        assert!(parse_track_payload("").is_empty());
    }

    #[tokio::test]
    async fn frames_are_read_and_a_malformed_or_cut_frame_is_an_error() {
        let mut ok: &[u8] = b"000bR5CW\tdevice";
        assert_eq!(read_frame(&mut ok).await.unwrap(), "R5CW\tdevice");
        let mut bad_hex: &[u8] = b"zzzzabc";
        assert!(read_frame(&mut bad_hex).await.unwrap_err().contains("malformed"));
        // The longest possible frame (0xffff) announced but not delivered: the stream ended mid-frame.
        let mut huge: &[u8] = b"ffffabc";
        assert!(read_frame(&mut huge).await.unwrap_err().contains("ended"));
        let mut cut: &[u8] = b"0010short";
        assert!(read_frame(&mut cut).await.unwrap_err().contains("ended"));
        let mut empty: &[u8] = b"";
        assert!(read_frame(&mut empty).await.is_err());
    }

    #[tokio::test]
    async fn the_handshake_asks_for_track_devices_and_delivers_each_frame() {
        let (mut client, mut server) = tokio::io::duplex(1024);
        let server_task = tokio::spawn(async move {
            let mut request = vec![0u8; 22];
            server.read_exact(&mut request).await.unwrap();
            assert_eq!(&request, b"0012host:track-devices");
            server.write_all(b"OKAY").await.unwrap();
            server.write_all(b"000bR5CW\tdevice").await.unwrap();
            server.write_all(b"0000").await.unwrap(); // an empty list: everything dropped
            // dropping the stream ends it
        });
        let mut seen: Vec<usize> = Vec::new();
        let result = track_once(&mut client, |f| seen.push(f.len())).await;
        server_task.await.unwrap();
        assert!(result.unwrap_err().contains("ended"), "the end of the stream is reported, so the caller reconnects");
        assert_eq!(seen, vec![1, 0]);
    }

    #[tokio::test]
    async fn a_refusal_from_adb_is_an_error() {
        let (mut client, mut server) = tokio::io::duplex(1024);
        tokio::spawn(async move {
            let mut request = vec![0u8; 22];
            server.read_exact(&mut request).await.unwrap();
            server.write_all(b"FAIL0005nope!").await.unwrap();
        });
        let error = track_once(&mut client, |_| {}).await.unwrap_err();
        assert!(error.contains("refused") && error.contains("nope!"), "{error}");
    }

    #[test]
    fn the_connection_book_counts_each_change_once() {
        let book = ConnectionBook::default();
        assert_eq!(book.observe("A", true), Some((Transition::Connected, 1)));
        assert_eq!(book.observe("A", true), None, "the same event again is nothing");
        assert_eq!(book.observe("A", false), Some((Transition::Disconnected, 2)));
        assert_eq!(book.observe("A", false), None);
        assert_eq!(book.observe("A", true), Some((Transition::Connected, 3)));
        assert_eq!(book.generation("A"), 3);
        assert_eq!(book.observe("B", false), None, "first seen offline is only recorded");
        assert_eq!(book.generation("B"), 0);
        assert_eq!(book.observe("B", true), Some((Transition::Connected, 1)));
        assert_eq!(book.generation("A"), 3, "each phone has its own generation");
    }

    #[tokio::test]
    async fn a_disconnect_and_reconnect_between_two_polls_is_caught_by_the_stream() {
        let state = state();
        let mut last = HashMap::new();
        apply_frame(&state, &mut last, frame(&[("A", DeviceStatus::Online)]));
        let before = state.connection_generation("A");
        // Unplugged and replugged: two frames, then the poll only ever sees A online.
        apply_frame(&state, &mut last, frame(&[]));
        apply_frame(&state, &mut last, frame(&[("A", DeviceStatus::Online)]));
        assert_eq!(state.connection_generation("A"), before + 2, "a drop and a return are both counted");
        // The poll sees A online and reports nothing new: it is the same connection state.
        assert!(state.observe_connection("A", true, "poll").is_none());
        // And the watcher turns the generation change into one restart.
        let mut handled = HashMap::from([("A".to_string(), before)]);
        let restarts = generation_restarts(&["A"], &mut handled, &|s| state.connection_generation(s), &Default::default());
        assert_eq!(restarts, vec!["A".to_string()]);
        let again = generation_restarts(&["A"], &mut handled, &|s| state.connection_generation(s), &Default::default());
        assert!(again.is_empty(), "handled once");
    }

    #[tokio::test]
    async fn duplicate_frames_and_a_stream_plus_poll_report_nothing_twice() {
        let state = state();
        let mut last = HashMap::new();
        let f = frame(&[("A", DeviceStatus::Online), ("B", DeviceStatus::Unauthorized)]);
        apply_frame(&state, &mut last, f.clone());
        let (ga, gb) = (state.connection_generation("A"), state.connection_generation("B"));
        for _ in 0..5 {
            apply_frame(&state, &mut last, f.clone());
        }
        assert_eq!((state.connection_generation("A"), state.connection_generation("B")), (ga, gb));
        assert!(state.observe_connection("A", true, "poll").is_none());
        assert!(state.observe_connection("B", false, "poll").is_none());
    }

    #[tokio::test]
    async fn after_the_stream_restarts_a_phone_missing_from_the_first_new_frame_dropped() {
        let state = state();
        let mut last = HashMap::new();
        apply_frame(&state, &mut last, frame(&[("A", DeviceStatus::Online), ("B", DeviceStatus::Online)]));
        // The stream broke and came back (`last` is kept by the caller): B is gone from its first list.
        apply_frame(&state, &mut last, frame(&[("A", DeviceStatus::Online)]));
        assert!(!state.inner.connections.book.is_online("B"));
        assert!(state.inner.connections.book.is_online("A"));
        assert_eq!(state.connection_generation("A"), 1, "A was untouched");
    }

    #[test]
    fn a_planned_restart_is_not_doubled_and_a_new_phone_is_only_recorded() {
        let mut handled = HashMap::new();
        let generations = |s: &str| if s == "A" { 5 } else { 1 };
        assert!(generation_restarts(&["A", "B"], &mut handled, &generations, &Default::default()).is_empty(), "first sight");
        let planned: std::collections::HashSet<String> = ["A".to_string()].into();
        let moved = |s: &str| if s == "A" { 7 } else { 1 };
        assert!(generation_restarts(&["A", "B"], &mut handled, &moved, &planned).is_empty(), "the poll already plans A");
        assert_eq!(handled["A"], 7, "but it is marked as handled");
        let both = |s: &str| if s == "B" { 3 } else { 7 };
        assert_eq!(generation_restarts(&["A", "B"], &mut handled, &both, &Default::default()), vec!["B".to_string()], "only the phone that moved");
    }

    /// A fake adb server: each connection gets the script's next entry (frames to send, then the
    /// connection is closed), so a test can break the stream and watch the tracker come back.
    async fn fake_adb(script: Vec<Vec<String>>) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let handle = tokio::spawn(async move {
            for frames in script {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = vec![0u8; 22];
                if socket.read_exact(&mut request).await.is_err() {
                    continue;
                }
                let _ = socket.write_all(b"OKAY").await;
                for payload in frames {
                    let wire = if payload.starts_with("RAW:") { payload[4..].to_string() } else { format!("{:04x}{payload}", payload.len()) };
                    let _ = socket.write_all(wire.as_bytes()).await;
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            }
            tokio::time::sleep(Duration::from_secs(60)).await;
        });
        (addr, handle)
    }

    async fn until(mut check: impl FnMut() -> bool, secs: u64) -> bool {
        let start = std::time::Instant::now();
        while !check() && start.elapsed() < Duration::from_secs(secs) {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        check()
    }

    #[tokio::test]
    async fn the_tracker_follows_a_real_stream_wakes_the_poll_and_recovers_after_failures() {
        let (addr, server) = fake_adb(vec![
            // 1st connection: A appears, then the stream ends.
            vec!["AAA\tdevice\n".into()],
            // 2nd: garbage that is not a frame length: the tracker must give up on it and reconnect.
            vec!["RAW:zzzzgarbage".into()],
            // 3rd: A is gone from the first list, B appears.
            vec!["BBB\tdevice\n".into()],
        ])
        .await;
        let state = state();
        state.spawn_tracker(addr);
        let woke = tokio::time::timeout(Duration::from_secs(5), state.inner.connections.poll_wake.notified()).await.is_ok();
        assert!(woke, "an event wakes the poll loop");
        assert!(until(|| state.inner.connections.book.is_online("AAA"), 5).await, "the first frame is applied");
        assert!(until(|| state.inner.connections.book.is_online("BBB"), 20).await, "after a broken stream and a malformed frame it reconnects");
        assert!(!state.inner.connections.book.is_online("AAA"), "AAA was missing from the list after the restart: dropped");
        assert_eq!(state.connection_generation("AAA"), 2);
        server.abort();
    }

    #[tokio::test]
    async fn an_unreachable_adb_server_is_retried_quietly_and_changes_nothing() {
        let state = state();
        state.spawn_tracker("127.0.0.1:1".into());
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(!state.inner.connections.tracker_up.load(std::sync::atomic::Ordering::Relaxed));
        assert_eq!(state.connection_generation("AAA"), 0);
    }
}
