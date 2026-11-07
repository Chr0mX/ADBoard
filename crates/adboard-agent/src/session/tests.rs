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
