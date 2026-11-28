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

/// A real loopback socket standing in for scrcpy-server's control socket: what the phone would receive.
async fn session_with_control_socket(serial: &str) -> (Arc<SessionManager>, Arc<VideoHub>, tokio::net::TcpStream) {
    let hub = VideoHub::new();
    let mgr = SessionManager::new_with_source(None, None, hub.clone(), VideoSourceKind::Off);
    let phone_side = attach_control_socket(&mgr, serial).await;
    (mgr, hub, phone_side)
}

/// Another streaming phone on the same manager, with its own control socket.
async fn attach_control_socket(mgr: &Arc<SessionManager>, serial: &str) -> tokio::net::TcpStream {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let client = tokio::net::TcpStream::connect(addr).await.unwrap();
    let (phone_side, _) = listener.accept().await.unwrap();
    let mut guard = mgr.sessions.write().await;
    guard.insert(
        serial.to_string(),
        LiveSession {
            info: SessionStatus {
                serial: serial.to_string(),
                stream: StreamState::Streaming,
                note: String::new(),
                backend: "scrcpy".into(),
            },
            child: None,
            video: None,
            forward_port: None,
            server_log: None,
            control: Some(ControlSender::spawn(client)),
            audio_child: None,
            audio_port: None,
        },
    );
    drop(guard);
    phone_side
}

async fn bytes_within(socket: &mut tokio::net::TcpStream, ms: u64) -> Vec<u8> {
    use tokio::io::AsyncReadExt;
    let mut buf = [0u8; 64];
    match tokio::time::timeout(std::time::Duration::from_millis(ms), socket.read(&mut buf)).await {
        Ok(Ok(n)) => buf[..n].to_vec(),
        _ => Vec::new(),
    }
}

#[tokio::test]
async fn no_keyframe_reset_reaches_a_stream_that_has_not_produced_its_first_frame() {
    // scrcpy-server dies with a NullPointerException when RESET_VIDEO arrives before its capture runs;
    // the log showed it 6 ms after the pump attached. The first frame is a keyframe anyway.
    let (mgr, hub, mut phone) = session_with_control_socket("FRESH").await;
    mgr.first_frame_grace_ms.store(400, std::sync::atomic::Ordering::Relaxed);
    // The call returns at once: the page ignores video until it does.
    let started = std::time::Instant::now();
    assert_eq!(mgr.reset_video("FRESH").await, Ok(()));
    assert!(started.elapsed() < std::time::Duration::from_millis(100), "it must not wait for the first frame");
    assert!(bytes_within(&mut phone, 150).await.is_empty(), "nothing is sent while the first frame is awaited");
    // The first frame arrives inside the grace period: it answers the ask, and nothing is ever sent.
    hub.publish_annexb("FRESH", vec![0, 0, 0, 1, 0x65, 0x88, 0x80]).await;
    assert!(bytes_within(&mut phone, 700).await.is_empty(), "the first frame was the keyframe");

    // Once the stream has a keyframe the capture is running and a reset is sent.
    assert_eq!(mgr.reset_video("FRESH").await, Ok(()));
    assert_eq!(bytes_within(&mut phone, 1000).await, vec![17], "RESET_VIDEO (type 17)");
}

#[tokio::test]
async fn a_restarted_stream_is_protected_again_until_its_new_first_frame() {
    let (mgr, hub, mut phone) = session_with_control_socket("RESTARTED").await;
    mgr.first_frame_grace_ms.store(2000, std::sync::atomic::Ordering::Relaxed);
    hub.publish_annexb("RESTARTED", vec![0, 0, 0, 1, 0x65, 0x88, 0x80]).await;
    // The producer stopped (a crash, a restart): its keyframe no longer counts.
    hub.clear_cache("RESTARTED").await;
    assert_eq!(mgr.reset_video("RESTARTED").await, Ok(()));
    assert!(bytes_within(&mut phone, 300).await.is_empty(), "no reset while the new stream has no frame yet");
    // The new stream's first frame arrives: nothing is sent to the phone.
    hub.publish_annexb("RESTARTED", vec![0, 0, 0, 1, 0x65, 0x11, 0x22]).await;
    assert!(bytes_within(&mut phone, 400).await.is_empty());
}

#[tokio::test]
async fn two_asks_at_connect_make_one_reset_and_without_a_control_socket_the_caller_hears_it() {
    let (mgr, hub, mut phone) = session_with_control_socket("TWICE").await;
    hub.publish_annexb("TWICE", vec![0, 0, 0, 1, 0x65, 0x88, 0x80]).await;
    // The agent's own connect-time ask and the page's ask arrive within milliseconds of each other.
    assert_eq!(mgr.reset_video("TWICE").await, Ok(()));
    assert_eq!(mgr.reset_video("TWICE").await, Ok(()));
    assert_eq!(bytes_within(&mut phone, 600).await, vec![17], "one RESET_VIDEO, not two");
    assert!(bytes_within(&mut phone, 600).await.is_empty(), "and no second one afterwards");
    // A phone with no control connection still reports it, so the connect-time retry loop keeps trying.
    assert!(mgr.reset_video("NO-SUCH-PHONE").await.is_err());
}

#[tokio::test]
async fn a_viewer_that_joins_after_the_keyframe_went_out_gets_a_new_one() {
    // The old 300 ms guess let a viewer 250 ms later "ride on" a keyframe that had already gone by, and its
    // socket then waited for the encoder's next natural one. Now the keyframe count decides.
    let (mgr, hub, mut phone) = session_with_control_socket("LATE").await;
    hub.publish_annexb("LATE", vec![0, 0, 0, 1, 0x65, 0x01]).await;
    assert_eq!(mgr.reset_video("LATE").await, Ok(()));
    assert_eq!(bytes_within(&mut phone, 600).await, vec![17]);
    // The keyframe that reset asked for comes out.
    hub.publish_annexb("LATE", vec![0, 0, 0, 1, 0x65, 0x02]).await;
    // A second viewer connects now and asks: it needs a keyframe made after it joined.
    assert_eq!(mgr.reset_video("LATE").await, Ok(()));
    assert_eq!(bytes_within(&mut phone, 1500).await, vec![17], "a second reset, after the gap");
}

#[tokio::test]
async fn a_still_screen_that_never_sends_a_frame_still_gets_its_reset_after_the_grace() {
    let (mgr, _hub, mut phone) = session_with_control_socket("STILL").await;
    mgr.first_frame_grace_ms.store(150, std::sync::atomic::Ordering::Relaxed);
    assert_eq!(mgr.reset_video("STILL").await, Ok(()));
    assert!(bytes_within(&mut phone, 60).await.is_empty(), "not before the grace");
    assert_eq!(bytes_within(&mut phone, 1000).await, vec![17], "then the reset, so the encoder produces a frame");
}

#[cfg(unix)]
#[tokio::test]
async fn a_failed_start_is_remembered_and_the_next_start_clears_a_leftover_server_first() {
    use std::os::unix::fs::PermissionsExt;
    let dir = std::env::temp_dir().join(format!("adboard-retry-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let log = dir.join("adb.log");
    let _ = std::fs::remove_file(&log);
    // A stand-in adb that records every call and fails all of them: the start cannot succeed.
    let adb = dir.join("adb");
    std::fs::write(&adb, format!("#!/bin/sh\necho \"$@\" >> {}\nexit 1\n", log.display())).unwrap();
    std::fs::set_permissions(&adb, std::fs::Permissions::from_mode(0o755)).unwrap();
    let jar = dir.join("scrcpy-server-v3.3.1");
    std::fs::write(&jar, b"jar").unwrap();
    // SAFETY of the global: only read by `scrcpy_server_jar` when a manager is built.
    unsafe { std::env::set_var("SCRCPY_SERVER_PATH", &jar) };
    let hub = VideoHub::new();
    let mgr = SessionManager::new_with_source(Some(adb.clone()), None, hub, VideoSourceKind::Scrcpy);
    unsafe { std::env::remove_var("SCRCPY_SERVER_PATH") };

    let first = mgr.start("PH1").await;
    assert_eq!(first.stream, StreamState::Error, "{first:?}");
    assert_eq!(mgr.pending_start_failures().await, vec![("PH1".to_string(), StreamState::Error)]);
    let calls = std::fs::read_to_string(&log).unwrap();
    assert!(!calls.contains("pkill"), "a first start does not touch the phone's processes: {calls}");

    // The retry clears what an earlier run may have left behind, before it pushes and forwards.
    let second = mgr.start("PH1").await;
    assert_eq!(second.stream, StreamState::Error);
    let calls = std::fs::read_to_string(&log).unwrap();
    let kill_at = calls.find("pkill -f com.genymobile.scrcpy.Server").expect("the retry ended a leftover server");
    let second_push = calls.rmatches("push").count();
    assert_eq!(second_push, 2, "both starts reached the push: {calls}");
    assert!(calls[..kill_at].matches("push").count() == 1, "the cleanup came after the first push and before the second: {calls}");
    let _ = std::fs::remove_dir_all(&dir);
}

// ---- one outstanding reset per phone ----

const IDR: [u8; 7] = [0, 0, 0, 1, 0x65, 0x88, 0x80];

/// Every RESET_VIDEO (type 17) the phone receives in `ms`.
async fn resets_within(socket: &mut tokio::net::TcpStream, ms: u64) -> usize {
    use tokio::io::AsyncReadExt;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(ms);
    let mut count = 0;
    let mut buf = [0u8; 64];
    while let Ok(Ok(n)) = tokio::time::timeout_at(deadline, socket.read(&mut buf)).await {
        if n == 0 {
            break;
        }
        count += buf[..n].iter().filter(|b| **b == 17).count();
    }
    count
}

fn set_deadline(mgr: &Arc<SessionManager>, ms: u64) {
    mgr.reset_gate.lock().unwrap().set_deadline(std::time::Duration::from_millis(ms));
}

#[tokio::test]
async fn a_reset_is_not_sent_again_while_it_waits_for_its_keyframe() {
    let (mgr, hub, mut phone) = session_with_control_socket("WAIT").await;
    set_deadline(&mgr, 2500);
    hub.publish_annexb("WAIT", IDR.to_vec()).await;
    // Two sockets open at once (each asks on connect), then the stall watch asks every second: one reset.
    for reason in ["connect", "connect", "manual"] {
        assert_eq!(mgr.reset_video_for("WAIT", reason).await, Ok(()));
    }
    for _ in 0..2 {
        tokio::time::sleep(std::time::Duration::from_millis(900)).await;
        assert_eq!(mgr.reset_video_for("WAIT", "stall").await, Ok(()));
    }
    assert_eq!(resets_within(&mut phone, 300).await, 1, "one RESET_VIDEO, well past the old 800 ms");
    let stats = mgr.reset_stats("WAIT");
    assert_eq!((stats.sent, stats.merged, stats.outstanding_attempt), (1, 4, 1));
}

#[tokio::test]
async fn a_keyframe_that_comes_late_answers_the_reset_without_another_one() {
    let (mgr, hub, mut phone) = session_with_control_socket("SLOW").await;
    set_deadline(&mgr, 3000);
    hub.publish_annexb("SLOW", IDR.to_vec()).await;
    mgr.reset_video_for("SLOW", "connect").await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    mgr.reset_video_for("SLOW", "stall").await.unwrap();
    // The encoder took 1.6 s to restart: its keyframe header arrives.
    hub.note_keyframe_started("SLOW").await;
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let stats = mgr.reset_stats("SLOW");
    assert_eq!(stats.outstanding_attempt, 0, "answered");
    assert!(stats.last_latency_ms.is_some_and(|ms| (1500..2000).contains(&ms)), "{stats:?}");
    assert_eq!(resets_within(&mut phone, 3000).await, 1, "no second reset, before or after the deadline");
    assert_eq!(mgr.reset_stats("SLOW").expired, 0);
}

#[tokio::test]
async fn a_reset_that_is_never_answered_is_retried_once_then_the_stream_is_restarted() {
    let (mgr, hub, mut phone) = session_with_control_socket("DEAD").await;
    set_deadline(&mgr, 600);
    hub.publish_annexb("DEAD", IDR.to_vec()).await;
    mgr.reset_video_for("DEAD", "connect").await.unwrap();
    // First reset, then one more at the deadline; then the control socket closes, because the stream restarts.
    assert_eq!(resets_within(&mut phone, 2500).await, 2);
    let stats = mgr.reset_stats("DEAD");
    assert_eq!((stats.sent, stats.expired, stats.escalated, stats.outstanding_attempt), (2, 2, 1, 0), "{stats:?}");
    let session = mgr.get_session("DEAD").await.unwrap();
    assert_ne!(session.stream, StreamState::Streaming, "the controlled recovery restarted the stream: {session:?}");
}

#[tokio::test]
async fn the_first_frame_watch_counts_like_any_reset_and_absorbs_asks() {
    let (mgr, _hub, mut phone) = session_with_control_socket("NEW").await;
    mgr.first_frame_grace_ms.store(150, std::sync::atomic::Ordering::Relaxed);
    set_deadline(&mgr, 3000);
    mgr.reset_video_for("NEW", "connect").await.unwrap();
    assert_eq!(resets_within(&mut phone, 400).await, 1, "sent after the grace");
    assert_eq!(mgr.reset_stats("NEW").sent, 1, "counted by the gate");
    // The first frame (a keyframe) answers it; the next ask within the gap waits for the gap.
    _hub.publish_annexb("NEW", IDR.to_vec()).await;
    tokio::time::sleep(std::time::Duration::from_millis(120)).await;
    assert_eq!(mgr.reset_stats("NEW").outstanding_attempt, 0, "answered by the first frame");
}

#[tokio::test]
async fn each_phone_keeps_its_own_reset_state() {
    let (mgr, hub, mut a) = session_with_control_socket("PA").await;
    let mut b = attach_control_socket(&mgr, "PB").await;
    set_deadline(&mgr, 3000);
    hub.publish_annexb("PA", IDR.to_vec()).await;
    hub.publish_annexb("PB", IDR.to_vec()).await;
    mgr.reset_video_for("PA", "connect").await.unwrap();
    mgr.reset_video_for("PB", "connect").await.unwrap();
    mgr.reset_video_for("PA", "stall").await.unwrap();
    assert_eq!(resets_within(&mut a, 300).await, 1);
    assert_eq!(resets_within(&mut b, 300).await, 1, "A's outstanding reset does not hold B back");
    hub.note_keyframe_started("PB").await;
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    assert_eq!(mgr.reset_stats("PB").outstanding_attempt, 0);
    assert_eq!(mgr.reset_stats("PA").outstanding_attempt, 1, "A still waits");
}

#[tokio::test]
async fn manual_refresh_still_resets_once_the_previous_reset_was_answered() {
    let (mgr, hub, mut phone) = session_with_control_socket("MAN").await;
    hub.publish_annexb("MAN", IDR.to_vec()).await;
    mgr.reset_video_for("MAN", "connect").await.unwrap();
    hub.note_keyframe_started("MAN").await;
    tokio::time::sleep(std::time::Duration::from_millis(900)).await;
    mgr.reset_video_for("MAN", "manual").await.unwrap();
    assert_eq!(resets_within(&mut phone, 400).await, 2, "the connect reset and the manual one");
}
