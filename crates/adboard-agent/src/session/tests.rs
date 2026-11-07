use super::*;
use adboard_protocol::InjectStatus;

#[tokio::test]
async fn stub_inject_without_adb() {
    let hub = VideoHub::new();
    let mgr = SessionManager::new(None, None, hub);
    let tap = MappedTap {
        device_id: "s24".into(),
        device_name: "S24".into(),
        x: 10,
        y: 20,
        width: 100,
        height: 200,
        inject: InjectStatus::Stub,
        inject_detail: None,
    };
    let r = mgr.inject_tap("R5CW90ABC1", &tap).await;
    assert_eq!(r.status, InjectStatus::Stub);
    let session = mgr.ensure_session("R5CW90ABC1").await;
    assert_eq!(session.stream, StreamState::Idle);
}

#[tokio::test]
async fn start_testpattern_streams() {
    let hub = VideoHub::new();
    let mgr =
        SessionManager::new_with_source(None, None, hub.clone(), VideoSourceKind::TestPattern);
    let session = mgr.start("SERIAL").await;
    assert_eq!(session.stream, StreamState::Streaming);
    assert_eq!(session.backend, "testpattern");
    let frame = mgr.video_status_frame("SERIAL").await;
    assert_eq!(frame.framing.as_deref(), Some("annexb"));
    assert_eq!(frame.width, Some(TESTPATTERN_WIDTH));
    // Wait briefly for at least one AU.
    let mut rx = hub.subscribe("SERIAL").await;
    let mut got_binary = false;
    for _ in 0..50 {
        match tokio::time::timeout(std::time::Duration::from_millis(200), rx.recv()).await {
            Ok(Ok(crate::video::VideoPacket::AnnexB(b))) if !b.is_empty() => {
                got_binary = true;
                break;
            }
            Ok(Ok(_)) => {}
            Ok(Err(_)) => break,
            Err(_) => {} // timeout — keep waiting
        }
    }
    assert!(got_binary, "expected annex-B packets from testpattern");
    let stopped = mgr.stop("SERIAL").await;
    assert_eq!(stopped.stream, StreamState::Idle);
}

#[tokio::test]
async fn stopped_session_stays_idle_after_reap() {
    let hub = VideoHub::new();
    let mgr =
        SessionManager::new_with_source(None, None, hub, VideoSourceKind::TestPattern);
    let started = mgr.start("SERIAL").await;
    assert_eq!(started.stream, StreamState::Streaming);
    let stopped = mgr.stop("SERIAL").await;
    assert_eq!(stopped.stream, StreamState::Idle);
    let changed = mgr.reap().await;
    assert!(
        changed.iter().all(|session| session.serial != "SERIAL"),
        "a stopped session must not be reported as Error by reap"
    );
    let after = mgr.get_session("SERIAL").await.expect("session");
    assert_eq!(after.stream, StreamState::Idle);
}

#[tokio::test]
async fn start_off_stays_idle() {
    let hub = VideoHub::new();
    let mgr = SessionManager::new_with_source(None, None, hub, VideoSourceKind::Off);
    let session = mgr.start("SERIAL").await;
    assert_eq!(session.stream, StreamState::Idle);
    assert!(session.backend == "stub" || session.note.contains("off"));
}

#[tokio::test]
async fn scrcpy_fixture_mock_streams_as_scrcpy() {
    std::env::set_var("ADBOARD_SCRCPY_FIXTURE", "1");
    let hub = VideoHub::new();
    let mgr = SessionManager::new_with_source(None, None, hub.clone(), VideoSourceKind::Scrcpy);
    let session = mgr.start("SCRCPY-MOCK").await;
    assert_eq!(session.stream, StreamState::Streaming);
    assert_eq!(session.backend, "scrcpy");
    let frame = mgr.video_status_frame("SCRCPY-MOCK").await;
    assert_eq!(frame.backend, "scrcpy");
    assert_eq!(frame.framing.as_deref(), Some("annexb"));
    let mut rx = hub.subscribe("SCRCPY-MOCK").await;
    let mut got_binary = false;
    for _ in 0..30 {
        match tokio::time::timeout(std::time::Duration::from_millis(200), rx.recv()).await {
            Ok(Ok(crate::video::VideoPacket::AnnexB(b))) if !b.is_empty() => {
                got_binary = true;
                break;
            }
            Ok(Ok(_)) => {}
            _ => break,
        }
    }
    assert!(got_binary, "expected annex-B from scrcpy fixture path");
    let _ = mgr.stop("SCRCPY-MOCK").await;
    std::env::remove_var("ADBOARD_SCRCPY_FIXTURE");
}

#[tokio::test]
async fn auto_without_scrcpy_uses_testpattern() {
    let hub = VideoHub::new();
    // No adb / no server → auto falls back to testpattern.
    let mgr = SessionManager::new_with_source(None, None, hub, VideoSourceKind::Auto);
    assert!(!mgr.scrcpy_ready());
    let session = mgr.start("AUTO").await;
    assert_eq!(session.backend, "testpattern");
    assert_eq!(session.stream, StreamState::Streaming);
    let _ = mgr.stop("AUTO").await;
}

#[tokio::test]
async fn a_virtual_display_closes_with_its_phone_and_never_touches_the_others() {
    let mgr = SessionManager::new_with_source(None, None, VideoHub::new(), VideoSourceKind::TestPattern);
    let (key_a, _) = mgr
        .create_virtual_display("PHONE-A", VirtualDisplaySpec::default())
        .await
        .expect("display on A");
    let (key_b, _) = mgr
        .create_virtual_display("PHONE-B", VirtualDisplaySpec::default())
        .await
        .expect("display on B");
    assert_eq!(key_a, "PHONE-A#vd1");
    assert_eq!(key_b, "PHONE-B#vd1");
    assert_eq!(mgr.virtual_displays_of("PHONE-A").await.len(), 1);

    // Phone A is unplugged; B is still there.
    let present: std::collections::HashSet<String> = ["PHONE-B".to_string()].into();
    let closed = mgr.prune_virtual_displays(&present).await;
    assert_eq!(closed, vec![key_a.clone()]);
    assert!(mgr.virtual_displays_of("PHONE-A").await.is_empty());
    assert_eq!(mgr.virtual_displays_of("PHONE-B").await.len(), 1);
    assert!(mgr.get_session(&key_a).await.is_none(), "A's session is gone");
    assert_eq!(
        mgr.get_session(&key_b).await.map(|s| s.stream),
        Some(StreamState::Streaming),
        "B keeps streaming"
    );
    // Nothing left to prune.
    assert!(mgr.prune_virtual_displays(&present).await.is_empty());
}

#[tokio::test]
async fn the_per_phone_limit_is_enforced_and_a_closed_slot_is_reused() {
    let _guard = crate::virtual_display::LIMIT_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mgr = SessionManager::new_with_source(None, None, VideoHub::new(), VideoSourceKind::TestPattern);
    let before = crate::virtual_display::limit_override();
    crate::virtual_display::set_limit_override(Some(2));
    let spec = || VirtualDisplaySpec::default();
    let (one, _) = mgr.create_virtual_display("P", spec()).await.unwrap();
    let (two, _) = mgr.create_virtual_display("P", spec()).await.unwrap();
    assert_eq!((one.as_str(), two.as_str()), ("P#vd1", "P#vd2"));
    let refused = mgr.create_virtual_display("P", spec()).await.expect_err("over the limit");
    assert!(refused.contains("already has 2"), "{refused}");
    mgr.close_virtual_display(&one).await;
    let (again, _) = mgr.create_virtual_display("P", spec()).await.unwrap();
    assert_eq!(again, "P#vd1", "the freed slot is used again");
    // A virtual display cannot have a virtual display of its own, and bad settings are refused.
    assert!(mgr.create_virtual_display("P#vd1", spec()).await.is_err());
    let bad = VirtualDisplaySpec { start_app: Some("x;reboot".into()), ..spec() };
    assert!(mgr.create_virtual_display("Q", bad).await.is_err());
    crate::virtual_display::set_limit_override(before);
}

#[tokio::test]
async fn shell_input_for_a_virtual_display_is_refused_until_its_id_is_known() {
    let mgr = SessionManager::new_with_source(None, None, VideoHub::new(), VideoSourceKind::TestPattern);
    let (key, _) = mgr.create_virtual_display("PHONE", VirtualDisplaySpec::default()).await.unwrap();
    // The test-pattern stream never prints a display id, so input must not fall back to the main screen.
    let error = mgr
        .virtual_input_args(&key, &["tap".to_string(), "1".to_string(), "2".to_string()])
        .await
        .expect_err("no display id yet");
    assert!(error.contains("not known"), "{error}");
    assert!(mgr.virtual_input_args("PHONE", &[]).await.is_err(), "a physical serial is not a virtual display");
}
