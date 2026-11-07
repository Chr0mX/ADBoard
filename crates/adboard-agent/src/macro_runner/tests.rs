use super::*;
use std::sync::atomic::AtomicUsize;

fn tab_with(stop: (&str, f64, f64), steps: usize, delay: f64) -> MacroTab {
    MacroTab {
        id: format!("t-{}", uuid::Uuid::new_v4()),
        name: "Tab".into(),
        reference: Size { width: 1080.0, height: 2400.0 },
        scale: "stretch".into(),
        orientation: "any".into(),
        stop: MacroStop { mode: stop.0.into(), seconds: stop.1, cycles: stop.2 },
        jitter_px: 0.0,
        steps: (0..steps)
            .map(|i| MacroStep {
                id: format!("s{i}"),
                enabled: true,
                fingers: vec![MacroFinger { x: 540.0, y: 1200.0, to_x: None, to_y: None, start_ms: 0.0, duration_ms: 50.0 }],
                delay_ms: delay,
                kind: String::new(),
                text: None,
                app: None,
            })
            .collect(),
        target_ids: vec![],
    }
}

fn phone(id: &str) -> RunDevice {
    RunDevice { id: id.into(), name: id.to_uppercase(), online: true, resolution: Size { width: 1080.0, height: 2400.0 } }
}

fn counting_sender(count: Arc<AtomicUsize>, fail: Option<&'static str>) -> Sender {
    Arc::new(move |devices: Vec<RunDevice>, _strokes| {
        count.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            devices
                .iter()
                .map(|d| SendResult {
                    device_id: d.id.clone(),
                    inject: if Some(d.id.as_str()) == fail { "error".into() } else { "ok".into() },
                    detail: None,
                })
                .collect()
        })
    })
}

fn opts(tab: MacroTab, devices: Vec<RunDevice>, send: Sender, control: Arc<RunControl>) -> RunOptions {
    let first = devices.first().cloned().unwrap_or_else(|| phone("none"));
    let snapshot = Arc::new(Mutex::new(new_snapshot(&tab, &first)));
    RunOptions { tab, devices, busy: HashMap::new(), only_step_id: None, send, is_online: None, read: None, command: None, control, snapshot }
}

fn named(mut tab: MacroTab, name: &str) -> MacroTab {
    tab.name = name.into();
    tab
}

/// Records which tab each gesture came from, per phone.
fn recording_sender(log: Arc<Mutex<Vec<String>>>, fail: Option<&'static str>) -> Sender {
    Arc::new(move |devices: Vec<RunDevice>, _strokes| {
        let log = log.clone();
        Box::pin(async move {
            devices
                .iter()
                .map(|d| {
                    log.lock().unwrap().push(d.id.clone());
                    SendResult {
                        device_id: d.id.clone(),
                        inject: if Some(d.id.as_str()) == fail { "error".into() } else { "ok".into() },
                        detail: None,
                    }
                })
                .collect()
        })
    })
}

fn touches(log: &Arc<Mutex<Vec<String>>>, id: &str) -> usize {
    log.lock().unwrap().iter().filter(|d| d.as_str() == id).count()
}

fn leak() -> &'static MacroRuns {
    Box::leak(Box::new(MacroRuns::default()))
}

#[test]
fn placement_and_normalization_match_the_browser() {
    let reference = Size { width: 900.0, height: 1600.0 };
    // Stretch: straight fractions of the screen.
    let p = to_normalized(450.0, 400.0, reference, Some(Size { width: 1080.0, height: 2400.0 }), "stretch");
    assert!((p.x - 0.5).abs() < 1e-9 && (p.y - 0.25).abs() < 1e-9);
    // Fit on a taller screen: letterboxed top and bottom.
    let (left, top, w, h) = placement(reference, Some(Size { width: 1080.0, height: 2400.0 }), "fit");
    assert!((left - 0.0).abs() < 1e-9 && (w - 1.0).abs() < 1e-9);
    assert!((h - (1600.0 * 1.2 / 2400.0)).abs() < 1e-9);
    assert!((top - (1.0 - h) / 2.0).abs() < 1e-9);
    // Points outside the reference are clamped onto it.
    let q = to_normalized(-50.0, 99999.0, reference, None, "stretch");
    assert_eq!((q.x, q.y), (0.0, 1.0));
    assert!(orientation_mismatch(reference, Some(Size { width: 2400.0, height: 1080.0 })));
    assert!(!orientation_mismatch(reference, Some(Size { width: 1080.0, height: 2400.0 })));
}

#[test]
fn strokes_keep_timing_limits_and_swipes() {
    let mut tab = tab_with(("cycles", 0.0, 1.0), 1, 0.0);
    tab.steps[0].fingers = vec![
        MacroFinger { x: 100.0, y: 100.0, to_x: Some(900.0), to_y: Some(100.0), start_ms: -5.0, duration_ms: 1.0 },
        MacroFinger { x: 200.0, y: 200.0, to_x: None, to_y: None, start_ms: 30.0, duration_ms: 999_999.0 },
    ];
    let strokes = build_strokes(&tab.steps[0], &tab, None, &mut Rng::new(1));
    assert_eq!(strokes.len(), 2);
    assert_eq!(strokes[0].points.len(), 2);
    assert_eq!((strokes[0].start_ms, strokes[0].duration_ms), (0, 10));
    assert_eq!((strokes[1].pointer, strokes[1].start_ms, strokes[1].duration_ms), (1, 30, 60_000));
    // Jitter stays within ±jitter px of the reference point.
    tab.jitter_px = 5.0;
    for seed in 1..50 {
        let s = build_strokes(&tab.steps[0], &tab, None, &mut Rng::new(seed));
        let x = s[1].points[0].x * 1080.0;
        assert!((x - 200.0).abs() <= 5.0 + 1e-6);
    }
}

#[tokio::test]
async fn plays_cycles_then_finishes() {
    let count = Arc::new(AtomicUsize::new(0));
    let result = run_tab(opts(tab_with(("cycles", 0.0, 3.0), 2, 0.0), vec![phone("a")], counting_sender(count.clone(), None), Arc::default())).await;
    assert_eq!(result.status, "done");
    assert_eq!(count.load(Ordering::SeqCst), 6);
    assert_eq!(result.touches, 6);
}

#[tokio::test]
async fn failed_phone_drops_out_and_all_failing_fails() {
    let count = Arc::new(AtomicUsize::new(0));
    let result = run_tab(opts(tab_with(("cycles", 0.0, 2.0), 1, 0.0), vec![phone("a"), phone("b")], counting_sender(count.clone(), Some("b")), Arc::default())).await;
    assert_eq!(result.status, "done");
    assert_eq!(result.devices["b"].state, "error");
    let solo = run_tab(opts(tab_with(("cycles", 0.0, 2.0), 1, 0.0), vec![phone("b")], counting_sender(count, Some("b")), Arc::default())).await;
    assert_eq!(solo.status, "failed");
}

#[tokio::test]
async fn stop_and_time_limit() {
    let count = Arc::new(AtomicUsize::new(0));
    let control = Arc::new(RunControl::default());
    let c2 = control.clone();
    let handle = tokio::spawn(run_tab(opts(tab_with(("infinite", 0.0, 1.0), 1, 20.0), vec![phone("a")], counting_sender(count.clone(), None), control)));
    tokio::time::sleep(std::time::Duration::from_millis(120)).await;
    c2.stop();
    let stopped = handle.await.unwrap();
    assert_eq!(stopped.status, "stopped");
    assert!(count.load(Ordering::SeqCst) >= 2);

    let timed = run_tab(opts(tab_with(("time", 0.2, 1.0), 1, 30.0), vec![phone("a")], counting_sender(Arc::new(AtomicUsize::new(0)), None), Arc::default())).await;
    assert_eq!(timed.status, "done");
    assert_eq!(timed.message.as_deref(), Some("Time is up"));
}

#[tokio::test]
async fn pause_holds_steps_and_extends_the_time_limit() {
    let count = Arc::new(AtomicUsize::new(0));
    let control = Arc::new(RunControl::default());
    let c2 = control.clone();
    let started = std::time::Instant::now();
    let handle = tokio::spawn(run_tab(opts(tab_with(("time", 0.3, 1.0), 1, 20.0), vec![phone("a")], counting_sender(count.clone(), None), control)));
    tokio::time::sleep(std::time::Duration::from_millis(60)).await;
    c2.pause();
    tokio::time::sleep(std::time::Duration::from_millis(60)).await;
    let frozen = count.load(Ordering::SeqCst);
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert_eq!(count.load(Ordering::SeqCst), frozen, "no touches while paused");
    c2.resume();
    let result = handle.await.unwrap();
    assert_eq!(result.status, "done");
    assert!(count.load(Ordering::SeqCst) > frozen, "plays again after resume");
    // 0.3 s of play plus ~0.36 s paused: the pause did not eat the time limit.
    assert!(started.elapsed().as_millis() >= 600);
}

#[tokio::test]
async fn two_phones_run_different_macros_at_once() {
    let reg = leak();
    let log = Arc::new(Mutex::new(Vec::new()));
    let a = named(tab_with(("infinite", 0.0, 1.0), 1, 15.0), "Farm");
    let b = named(tab_with(("infinite", 0.0, 1.0), 2, 15.0), "Collect");
    reg.start_device(a.clone(), phone("s24"), None, RunTools { send: recording_sender(log.clone(), None), is_online: None, read: None, command: None }).unwrap();
    reg.start_device(b.clone(), phone("s23"), None, RunTools { send: recording_sender(log.clone(), None), is_online: None, read: None, command: None }).unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    let view = reg.view();
    let by = |id: &str| view.runs.iter().find(|r| r.device_id == id).cloned().unwrap();
    assert_eq!((by("s24").tab_name.as_str(), by("s23").tab_name.as_str()), ("Farm", "Collect"));
    assert!(touches(&log, "s24") >= 3 && touches(&log, "s23") >= 3);
    assert!(reg.is_running(&a.id) && reg.is_running(&b.id));

    // A second start on a busy phone is refused; the first run is untouched.
    let dup = reg.start_device(b.clone(), phone("s24"), None, RunTools { send: recording_sender(log.clone(), None), is_online: None, read: None, command: None });
    assert!(dup.unwrap_err().contains("already running \"Farm\""));

    // Stopping one phone leaves the other running.
    assert!(reg.stop_device("s24"));
    let s24 = reg.wait_devices(&["s24".to_string()]).await;
    assert_eq!(s24[0].status, "stopped");
    let before = touches(&log, "s23");
    tokio::time::sleep(std::time::Duration::from_millis(120)).await;
    assert!(touches(&log, "s23") > before, "s23 keeps playing");
    assert!(!reg.device_busy("s24") && reg.device_busy("s23"));

    // Pause is per phone too.
    assert!(reg.pause_device("s23"));
    assert_eq!(reg.view().paused, vec!["s23".to_string()]);
    assert!(reg.resume_device("s23"));
    reg.stop_all();
    reg.wait_devices(&["s23".to_string()]).await;
    assert!(!reg.device_busy("s23") && !reg.device_busy("s24"), "every lock is released");
}

#[tokio::test]
async fn one_phone_failing_does_not_stop_the_other() {
    let reg = leak();
    let log = Arc::new(Mutex::new(Vec::new()));
    let tab = tab_with(("infinite", 0.0, 1.0), 1, 15.0);
    // Same macro on both phones = two runs; s23's gestures fail.
    let started = reg.start(tab.clone(), vec![phone("s24"), phone("s23")], None, RunTools { send: recording_sender(log.clone(), Some("s23")), is_online: None, read: None, command: None }).unwrap().started;
    assert_eq!(started.len(), 2);
    let failed = reg.wait_devices(&["s23".to_string()]).await;
    assert_eq!(failed[0].status, "failed");
    let before = touches(&log, "s24");
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(touches(&log, "s24") > before);
    // A tab-level start skips the busy phone and reports when none is free.
    assert!(reg.start(tab.clone(), vec![phone("s24")], None, RunTools { send: recording_sender(log.clone(), None), is_online: None, read: None, command: None }).is_err());
    let other = tab_with(("cycles", 0.0, 1.0), 1, 0.0);
    let report = reg.start(other, vec![phone("s24"), phone("p3")], None, RunTools { send: recording_sender(log.clone(), None), is_online: None, read: None, command: None }).unwrap();
    assert_eq!(report.started, vec!["p3".to_string()]);
    assert_eq!(report.skipped["s24"].state, "busy");
    assert_eq!(report.skipped["s24"].detail.as_deref(), Some("running \"Tab\""));
    reg.wait_devices(&report.started).await;
    assert!(reg.stop(&tab.id));
    let done = reg.wait_devices(&started).await;
    assert_eq!(done.iter().find(|r| r.device_id == "s24").unwrap().status, "stopped");
    reg.forget(&tab.id);
    assert!(reg.view().runs.iter().all(|r| r.tab_id != tab.id), "forgotten tab leaves no results");
}

#[tokio::test]
async fn a_disconnected_phone_ends_only_its_run() {
    let reg = leak();
    let log = Arc::new(Mutex::new(Vec::new()));
    let unplugged = Arc::new(AtomicBool::new(false));
    let flag = unplugged.clone();
    let online: OnlineCheck = Arc::new(move |id: String| {
        let gone = flag.load(Ordering::SeqCst) && id == "s24";
        Box::pin(async move { !gone })
    });
    let tab = tab_with(("infinite", 0.0, 1.0), 1, 15.0);
    reg.start(tab.clone(), vec![phone("s24"), phone("s23")], None, RunTools { send: recording_sender(log.clone(), None), is_online: Some(online), read: None, command: None }).unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(60)).await;
    unplugged.store(true, Ordering::SeqCst);
    let ended = reg.wait_devices(&["s24".to_string()]).await;
    assert_eq!((ended[0].status.as_str(), ended[0].message.as_deref()), ("failed", Some(DISCONNECTED)));
    assert!(!reg.device_busy("s24"), "lock released");
    let before = touches(&log, "s23");
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(touches(&log, "s23") > before, "s23 keeps playing");
    reg.stop_all();
    reg.wait_devices(&["s23".to_string()]).await;
}

#[tokio::test]
async fn offline_phones_are_skipped_at_start() {
    let reg = leak();
    let mut off = phone("a52");
    off.online = false;
    let err = reg.start(tab_with(("cycles", 0.0, 1.0), 1, 0.0), vec![off], None, RunTools { send: counting_sender(Arc::default(), None), is_online: None, read: None, command: None }).unwrap_err();
    assert!(err.contains("offline"));
    assert!(reg.view().runs.is_empty());
}

/* --------------------------- text steps --------------------------- */

use crate::ocr::{ReadErrorKind, TextLine};

/// A screen with these lines (0.2 × 0.02 of the screen each, at x, y).
fn screen_of(lines: &[(&str, f64, f64)]) -> ScreenText {
    ScreenText {
        width: 1080,
        height: 2400,
        lines: lines
            .iter()
            .map(|&(text, x, y)| TextLine { text: text.into(), area: Area { x, y, width: 0.2, height: 0.02 }, confidence: None, chars: vec![] })
            .collect(),
        engine: "test".into(),
        ms: 1,
        cached: false,
    }
}

type Script = dyn Fn(&str, usize) -> Result<ScreenText, ReadError> + Send + Sync;

/// Answers each read from `script(device, nth read of that device)`; counts reads.
fn scripted(script: Arc<Script>) -> (ScreenReader, Arc<Mutex<HashMap<String, usize>>>) {
    let reads = Arc::new(Mutex::new(HashMap::<String, usize>::new()));
    let counter = reads.clone();
    let reader: ScreenReader = Arc::new(move |device: RunDevice, _area| {
        let n = {
            let mut map = counter.lock().unwrap();
            let entry = map.entry(device.id.clone()).or_default();
            *entry += 1;
            *entry
        };
        let answer = script(&device.id, n);
        Box::pin(async move { answer })
    });
    (reader, reads)
}

fn text_step(id: &str, action: &str, texts: &[&str], timeout_ms: f64) -> MacroStep {
    MacroStep {
        id: id.into(),
        enabled: true,
        fingers: vec![],
        delay_ms: 0.0,
        kind: "text".into(),
        app: None,
        text: Some(TextStep {
            action: action.into(),
            query: TextQuery { texts: texts.iter().map(|t| t.to_string()).collect(), mode: "contains".into(), case_sensitive: false },
            area: None,
            timeout_ms,
            interval_ms: MIN_TEXT_INTERVAL_MS,
            offset_x: 0.0,
            offset_y: 0.0,
            variable: String::new(),
            on_success: Outcome::next(),
            on_failure: Outcome::fail(),
        }),
    }
}

fn touch_step(id: &str, x: f64) -> MacroStep {
    MacroStep {
        id: id.into(),
        enabled: true,
        fingers: vec![MacroFinger { x, y: 1200.0, to_x: None, to_y: None, start_ms: 0.0, duration_ms: 20.0 }],
        delay_ms: 0.0,
        kind: String::new(),
        text: None,
        app: None,
    }
}

fn tab_of(steps: Vec<MacroStep>) -> MacroTab {
    let mut tab = tab_with(("cycles", 0.0, 1.0), 0, 0.0);
    tab.steps = steps;
    tab
}

fn edit(step: &mut MacroStep, change: impl FnOnce(&mut TextStep)) {
    change(step.text.as_mut().unwrap());
}

/// Records each gesture's first point (x as 0–1) per phone.
fn point_sender(log: Arc<Mutex<Vec<(String, f64, f64)>>>) -> Sender {
    Arc::new(move |devices: Vec<RunDevice>, strokes: Vec<GestureStroke>| {
        let log = log.clone();
        Box::pin(async move {
            devices
                .iter()
                .map(|d| {
                    let p = &strokes[0].points[0];
                    log.lock().unwrap().push((d.id.clone(), p.x, p.y));
                    SendResult { device_id: d.id.clone(), inject: "ok".into(), detail: None }
                })
                .collect()
        })
    })
}

fn text_opts(tab: MacroTab, devices: Vec<RunDevice>, send: Sender, read: ScreenReader, control: Arc<RunControl>) -> RunOptions {
    let mut options = opts(tab, devices, send, control);
    options.read = Some(read);
    options
}

#[tokio::test]
async fn tap_text_touches_the_center_of_the_match() {
    let log = Arc::new(Mutex::new(Vec::new()));
    let (reader, _) = scripted(Arc::new(|_, _| Ok(screen_of(&[("Welcome", 0.1, 0.1), ("Sign in", 0.4, 0.5)]))));
    let mut step = text_step("t", "tap", &["SIGN IN"], 1000.0);
    edit(&mut step, |t| t.offset_x = 108.0); // 10% of the 1080 reference width
    let result = run_tab(text_opts(tab_of(vec![step]), vec![phone("a")], point_sender(log.clone()), reader, Arc::default())).await;
    assert_eq!(result.status, "done", "{:?}", result.message);
    let sent = log.lock().unwrap().clone();
    assert_eq!(sent.len(), 1);
    assert!((sent[0].1 - 0.6).abs() < 1e-9 && (sent[0].2 - 0.51).abs() < 1e-9, "{sent:?}");
    assert_eq!(result.touches, 1);
    let text = result.text.unwrap();
    assert_eq!((text.state.as_str(), text.matched.as_deref(), text.detail.as_deref()), ("met", Some("Sign in"), Some("Tapped “Sign in”")));
}

#[tokio::test]
async fn wait_polls_until_the_text_appears_then_continues() {
    let log = Arc::new(Mutex::new(Vec::new()));
    // "Home" shows from the third read on.
    let (reader, reads) = scripted(Arc::new(|_, n| Ok(if n < 3 { screen_of(&[("Loading", 0.4, 0.5)]) } else { screen_of(&[("Home", 0.4, 0.1)]) })));
    let tab = tab_of(vec![text_step("w", "wait", &["home"], 5000.0), touch_step("after", 540.0)]);
    let result = run_tab(text_opts(tab, vec![phone("a")], point_sender(log.clone()), reader, Arc::default())).await;
    assert_eq!(result.status, "done");
    assert_eq!(reads.lock().unwrap()["a"], 3);
    assert_eq!(log.lock().unwrap().len(), 1, "the touch after the wait played");
    assert_eq!(result.text.unwrap().looks, 3);
}

#[tokio::test]
async fn a_wait_that_times_out_fails_the_run_with_a_reason() {
    let log = Arc::new(Mutex::new(Vec::new()));
    let (reader, reads) = scripted(Arc::new(|_, _| Ok(screen_of(&[("Loading", 0.4, 0.5)]))));
    let tab = tab_of(vec![text_step("w", "wait", &["Home", "Start"], 600.0), touch_step("after", 540.0)]);
    let started = std::time::Instant::now();
    let result = run_tab(text_opts(tab, vec![phone("a")], point_sender(log.clone()), reader, Arc::default())).await;
    assert_eq!(result.status, "failed");
    assert_eq!(result.message.as_deref(), Some("Step 1: “Home” or “Start” not found after 0.6 s"));
    assert!(started.elapsed().as_millis() >= 600);
    // Reads at 0, 250, 500 and the timeout itself.
    assert_eq!(reads.lock().unwrap()["a"], 4);
    assert!(log.lock().unwrap().is_empty(), "nothing after a failed wait");
    assert_eq!(result.devices["a"].state, "error");
}

#[tokio::test]
async fn gone_waits_for_the_text_to_disappear() {
    let (reader, reads) = scripted(Arc::new(|_, n| Ok(if n < 2 { screen_of(&[("Please wait", 0.4, 0.5)]) } else { screen_of(&[]) })));
    let result = run_tab(text_opts(tab_of(vec![text_step("g", "gone", &["please wait"], 3000.0)]), vec![phone("a")], counting_sender(Arc::default(), None), reader, Arc::default())).await;
    assert_eq!(result.status, "done");
    assert_eq!(reads.lock().unwrap()["a"], 2);
    assert_eq!(result.text.unwrap().detail.as_deref(), Some("“please wait” is gone"));
}

/// Login flow: check for an error message and branch on it.
#[tokio::test]
async fn check_branches_to_another_step() {
    for (screen, expect) in [("Login failed", vec![0.9]), ("Welcome back", vec![0.1, 0.5])] {
        let log = Arc::new(Mutex::new(Vec::new()));
        let (reader, _) = scripted(Arc::new(move |_, _| Ok(screen_of(&[(screen, 0.3, 0.3)]))));
        let mut check = text_step("check", "check", &["failed", "wrong password"], 0.0);
        edit(&mut check, |t| {
            t.on_success = Outcome { go: "step".into(), step_id: Some("retry".into()) };
            t.on_failure = Outcome::next();
        });
        let mut ok = touch_step("ok-1", 108.0);
        ok.delay_ms = 0.0;
        let mut end = text_step("end", "check", &["anything"], 0.0);
        edit(&mut end, |t| {
            t.on_success = Outcome { go: "end".into(), step_id: None };
            t.on_failure = Outcome { go: "end".into(), step_id: None };
        });
        let tab = tab_of(vec![check, ok, touch_step("ok-2", 540.0), end, touch_step("retry", 972.0)]);
        let result = run_tab(text_opts(tab, vec![phone("a")], point_sender(log.clone()), reader, Arc::default())).await;
        assert_eq!(result.status, "done", "{:?}", result.message);
        let xs: Vec<f64> = log.lock().unwrap().iter().map(|(_, x, _)| (x * 10.0).round() / 10.0).collect();
        assert_eq!(xs, expect, "screen “{screen}”");
        if screen == "Welcome back" {
            assert_eq!(result.message.as_deref(), Some("Ended at step 4: “anything” is not on screen"));
        }
    }
}

#[tokio::test]
async fn read_stores_a_variable_that_later_steps_use() {
    let (reader, _) = scripted(Arc::new(|_, _| Ok(screen_of(&[("Your code: 4821", 0.1, 0.2), ("Enter 4821 to continue", 0.1, 0.6)]))));
    let mut read = text_step("r", "read", &[r"code:\s*(\d+)"], 0.0);
    edit(&mut read, |t| {
        t.query.mode = "regex".into();
        t.variable = "code".into();
    });
    let log = Arc::new(Mutex::new(Vec::new()));
    let tab = tab_of(vec![read, text_step("t", "tap", &["enter {code}"], 0.0)]);
    let result = run_tab(text_opts(tab, vec![phone("a")], point_sender(log.clone()), reader, Arc::default())).await;
    assert_eq!(result.status, "done", "{:?}", result.message);
    assert_eq!(result.vars.get("code").map(String::as_str), Some("4821"));
    let sent = log.lock().unwrap().clone();
    assert!((sent[0].2 - 0.61).abs() < 1e-9, "tapped the line with the code: {sent:?}");
}

#[tokio::test]
async fn stop_ends_a_long_wait_at_once() {
    let (reader, _) = scripted(Arc::new(|_, _| Ok(screen_of(&[]))));
    let control = Arc::new(RunControl::default());
    let c2 = control.clone();
    let handle = tokio::spawn(run_tab(text_opts(tab_of(vec![text_step("w", "wait", &["never"], 600_000.0)]), vec![phone("a")], counting_sender(Arc::default(), None), reader, control)));
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    let asked = std::time::Instant::now();
    c2.stop();
    let result = handle.await.unwrap();
    assert_eq!(result.status, "stopped");
    assert!(asked.elapsed().as_millis() < 200, "stop is not held up by the wait");
}

#[tokio::test]
async fn stop_does_not_wait_for_a_slow_read() {
    // A read that never answers (e.g. a hung capture).
    let reader: ScreenReader = Arc::new(|_, _| Box::pin(std::future::pending()));
    let control = Arc::new(RunControl::default());
    let c2 = control.clone();
    let handle = tokio::spawn(run_tab(text_opts(tab_of(vec![text_step("w", "wait", &["x"], 10_000.0)]), vec![phone("a")], counting_sender(Arc::default(), None), reader, control)));
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    c2.stop();
    let result = tokio::time::timeout(std::time::Duration::from_millis(500), handle).await.expect("stopped in time").unwrap();
    assert_eq!(result.status, "stopped");
}

#[tokio::test]
async fn pause_holds_the_wait_and_its_timeout() {
    let (reader, reads) = scripted(Arc::new(|_, _| Ok(screen_of(&[]))));
    let control = Arc::new(RunControl::default());
    let c2 = control.clone();
    let started = std::time::Instant::now();
    let handle = tokio::spawn(run_tab(text_opts(tab_of(vec![text_step("w", "wait", &["x"], 500.0)]), vec![phone("a")], counting_sender(Arc::default(), None), reader, control)));
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    c2.pause();
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let frozen = reads.lock().unwrap()["a"];
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    assert_eq!(reads.lock().unwrap()["a"], frozen, "no reads while paused");
    c2.resume();
    let result = handle.await.unwrap();
    assert_eq!(result.status, "failed");
    // 0.5 s of looking plus ~0.6 s paused: the pause did not eat the timeout.
    assert!(started.elapsed().as_millis() >= 1000);
}

#[tokio::test]
async fn read_errors_are_retried_and_missing_models_fail_at_once() {
    // Two failed captures, then the text.
    let (reader, reads) = scripted(Arc::new(|_, n| if n <= 2 { Err(ReadError::failed("adb: device busy")) } else { Ok(screen_of(&[("Ready", 0.1, 0.1)])) }));
    let result = run_tab(text_opts(tab_of(vec![text_step("w", "wait", &["ready"], 5000.0)]), vec![phone("a")], counting_sender(Arc::default(), None), reader, Arc::default())).await;
    assert_eq!((result.status.as_str(), reads.lock().unwrap()["a"]), ("done", 3));

    let (reader, _) = scripted(Arc::new(|_, _| Err(ReadError::failed("adb: device offline"))));
    let result = run_tab(text_opts(tab_of(vec![text_step("w", "wait", &["ready"], 60_000.0)]), vec![phone("a")], counting_sender(Arc::default(), None), reader, Arc::default())).await;
    assert_eq!(result.status, "failed");
    assert_eq!(result.message.as_deref(), Some("Step 1: cannot read the screen: adb: device offline"));

    let (reader, reads) = scripted(Arc::new(|_, _| Err(ReadError { kind: ReadErrorKind::Unavailable, message: "no models".into() })));
    let result = run_tab(text_opts(tab_of(vec![text_step("w", "wait", &["ready"], 60_000.0)]), vec![phone("a")], counting_sender(Arc::default(), None), reader, Arc::default())).await;
    assert_eq!((result.status.as_str(), result.message.as_deref(), reads.lock().unwrap()["a"]), ("failed", Some("Step 1: no models"), 1));
}

#[tokio::test]
async fn a_phone_unplugged_during_a_wait_ends_its_run() {
    let unplugged = Arc::new(AtomicBool::new(false));
    let flag = unplugged.clone();
    let online: OnlineCheck = Arc::new(move |_| {
        let gone = flag.load(Ordering::SeqCst);
        Box::pin(async move { !gone })
    });
    let (reader, _) = scripted(Arc::new(|_, _| Ok(screen_of(&[]))));
    let mut options = text_opts(tab_of(vec![text_step("w", "wait", &["x"], 60_000.0)]), vec![phone("a")], counting_sender(Arc::default(), None), reader, Arc::default());
    options.is_online = Some(online);
    let handle = tokio::spawn(run_tab(options));
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    unplugged.store(true, Ordering::SeqCst);
    let result = tokio::time::timeout(std::time::Duration::from_secs(2), handle).await.unwrap().unwrap();
    assert_eq!((result.status.as_str(), result.message.as_deref()), ("failed", Some("Step 1: Phone disconnected")));
}

#[tokio::test]
async fn bad_text_steps_fail_with_a_reason_before_reading() {
    let (reader, reads) = scripted(Arc::new(|_, _| Ok(screen_of(&[]))));
    let mut regex = text_step("r", "wait", &["(oops"], 0.0);
    edit(&mut regex, |t| t.query.mode = "regex".into());
    let mut jump = text_step("j", "check", &["x"], 0.0);
    edit(&mut jump, |t| t.on_failure = Outcome { go: "step".into(), step_id: Some("deleted".into()) });
    for (step, expect) in [
        (regex, "not a valid pattern"),
        (text_step("e", "tap", &["  "], 0.0), "enter the text to look for"),
        (jump, "turned off or was deleted"),
    ] {
        let result = run_tab(text_opts(tab_of(vec![step]), vec![phone("a")], counting_sender(Arc::default(), None), reader.clone(), Arc::default())).await;
        assert_eq!(result.status, "failed");
        assert!(result.message.as_deref().unwrap_or_default().contains(expect), "{:?}", result.message);
    }
    assert_eq!(reads.lock().unwrap().get("a").copied().unwrap_or(0), 1, "only the jump step read the screen");
    // No OCR on this path at all.
    let result = run_tab(opts(tab_of(vec![text_step("w", "wait", &["x"], 0.0)]), vec![phone("a")], counting_sender(Arc::default(), None), Arc::default())).await;
    assert_eq!(result.message.as_deref(), Some("Step 1: text steps need the ADBoard agent"));
}

#[tokio::test]
async fn testing_one_text_step_reports_what_it_saw() {
    let (reader, _) = scripted(Arc::new(|_, _| Ok(screen_of(&[("Settings", 0.1, 0.1)]))));
    let mut step = text_step("c", "check", &["settings"], 0.0);
    edit(&mut step, |t| t.on_success = Outcome { go: "step".into(), step_id: Some("elsewhere".into()) });
    let mut options = text_opts(tab_of(vec![step]), vec![phone("a")], counting_sender(Arc::default(), None), reader, Arc::default());
    options.only_step_id = Some("c".into());
    let result = run_tab(options).await;
    assert_eq!((result.status.as_str(), result.message.as_deref()), ("done", Some("Found “Settings”")));
}

/// Two phones run the same macro: each reads its own screen and branches on it.
#[tokio::test]
async fn each_phone_branches_on_its_own_screen() {
    let reg = leak();
    let log = Arc::new(Mutex::new(Vec::new()));
    let (reader, _) = scripted(Arc::new(|device, _| Ok(screen_of(&[(if device == "s24" { "Error" } else { "Ready" }, 0.4, 0.4)]))));
    let mut check = text_step("check", "check", &["error"], 0.0);
    edit(&mut check, |t| {
        t.on_success = Outcome { go: "end".into(), step_id: None };
        t.on_failure = Outcome::next();
    });
    let tab = tab_of(vec![check, touch_step("go", 540.0)]);
    let report = reg.start(tab, vec![phone("s24"), phone("s23")], None, RunTools { send: point_sender(log.clone()), is_online: None, read: Some(reader), command: None }).unwrap();
    let done = reg.wait_devices(&report.started).await;
    let by = |id: &str| done.iter().find(|r| r.device_id == id).unwrap().clone();
    assert_eq!(by("s24").message.as_deref(), Some("Ended at step 1: Found “Error”"));
    assert_eq!(by("s23").message.as_deref(), Some("Finished 1 cycle"));
    let touched: Vec<String> = log.lock().unwrap().iter().map(|(d, _, _)| d.clone()).collect();
    assert_eq!(touched, vec!["s23".to_string()]);
}

/// Each run's start and end are in the event history, tied by its run id.
#[tokio::test]
async fn runs_are_recorded_in_the_event_history() {
    let reg = leak();
    let ok = named(tab_with(("cycles", 0.0, 2.0), 2, 0.0), "History OK");
    let bad = named(tab_with(("cycles", 0.0, 1.0), 1, 0.0), "History Bad");
    reg.start_device(ok, phone("hist-a"), None, RunTools { send: counting_sender(Arc::default(), None), is_online: None, read: None, command: None }).unwrap();
    reg.start_device(bad, phone("hist-b"), None, RunTools { send: counting_sender(Arc::default(), Some("hist-b")), is_online: None, read: None, command: None }).unwrap();
    let done = reg.wait_devices(&["hist-a".to_string(), "hist-b".to_string()]).await;
    for run in &done {
        let page = crate::events::log().query(&crate::events::Query { run: Some(run.run_id.clone()), ..Default::default() });
        let kinds: Vec<&str> = page.events.iter().map(|e| e.kind.as_str()).collect();
        let end = if run.device_id == "hist-a" { "macro.completed" } else { "macro.failed" };
        assert_eq!(kinds, vec![end, "macro.started"], "{}", run.device_id);
        let last = &page.events[0];
        assert_eq!(last.device_id.as_deref(), Some(run.device_id.as_str()));
        assert_eq!(last.meta["macro"], run.tab_name.as_str());
        if end == "macro.failed" {
            assert_eq!(last.severity, Severity::Error);
            assert_eq!(last.meta["step"], 1);
            assert_eq!(last.detail.as_deref(), Some("Phone failed"));
        } else {
            assert_eq!(last.meta["cycles"], 2);
            assert_eq!(last.meta["touches"], 4);
        }
    }
    // Testing one step is not a run worth recording.
    let quiet = named(tab_with(("cycles", 0.0, 1.0), 1, 0.0), "History Step");
    let step = quiet.steps[0].id.clone();
    reg.start_device(quiet, phone("hist-c"), Some(step), RunTools { send: counting_sender(Arc::default(), None), is_online: None, read: None, command: None }).unwrap();
    reg.wait_devices(&["hist-c".to_string()]).await;
    let page = crate::events::log().query(&crate::events::Query { device: Some("hist-c".into()), ..Default::default() });
    assert_eq!(page.total, 0);
}

/// Records each command (`phone op arg arg2`); launches fail on `fail`.
fn command_log(log: Arc<Mutex<Vec<String>>>, fail: Option<&'static str>) -> CommandRunner {
    Arc::new(move |device: RunDevice, op, arg, arg2| {
        let log = log.clone();
        Box::pin(async move {
            log.lock().unwrap().push(format!("{} {op} {} {}", device.id, arg.unwrap_or_default(), arg2.unwrap_or_default()).trim().to_string());
            if op == "launch" && Some(device.id.as_str()) == fail {
                Err("Error: Activity not started".into())
            } else {
                Ok(format!("launched on {}", device.id))
            }
        })
    })
}

fn app_step(id: &str, package: &str, activity: &str, restart: bool) -> MacroStep {
    MacroStep {
        id: id.into(),
        enabled: true,
        fingers: vec![],
        delay_ms: 0.0,
        kind: "app".into(),
        text: None,
        app: Some(AppStep { package_name: package.into(), activity: activity.into(), restart }),
    }
}

#[tokio::test]
async fn app_steps_open_the_app_then_the_macro_goes_on() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let touches = Arc::new(Mutex::new(Vec::new()));
    let tab = tab_of(vec![app_step("a", "com.game", ".Main --ez fresh true", true), touch_step("t", 540.0)]);
    let mut options = opts(tab, vec![phone("s24"), phone("s23")], point_sender(touches.clone()), Arc::default());
    options.command = Some(command_log(calls.clone(), None));
    let result = run_tab(options).await;
    assert_eq!(result.status, "done", "{:?}", result.message);
    let mut log = calls.lock().unwrap().clone();
    log.sort();
    assert_eq!(log, vec!["s23 forceStop com.game", "s23 launch com.game .Main --ez fresh true", "s24 forceStop com.game", "s24 launch com.game .Main --ez fresh true"]);
    assert_eq!(touches.lock().unwrap().len(), 2, "the touch after it played on both phones");
    assert_eq!(result.devices["s24"].state, "ok");
}

#[tokio::test]
async fn a_failed_launch_drops_that_phone_or_fails_the_run() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let tab = tab_of(vec![app_step("a", "com.game", "", false), touch_step("t", 540.0)]);
    let touches = Arc::new(Mutex::new(Vec::new()));
    let mut options = opts(tab.clone(), vec![phone("s24"), phone("s23")], point_sender(touches.clone()), Arc::default());
    options.command = Some(command_log(calls.clone(), Some("s23")));
    let result = run_tab(options).await;
    assert_eq!(result.status, "done");
    assert_eq!(result.devices["s23"].state, "error");
    assert_eq!(touches.lock().unwrap().iter().map(|(d, _, _)| d.as_str()).collect::<Vec<_>>(), vec!["s24"]);
    assert!(!calls.lock().unwrap().iter().any(|c| c.contains("forceStop")), "no restart unless asked");

    let mut solo = opts(tab, vec![phone("s23")], counting_sender(Arc::default(), None), Arc::default());
    solo.command = Some(command_log(calls, Some("s23")));
    let failed = run_tab(solo).await;
    assert_eq!((failed.status.as_str(), failed.message.as_deref()), ("failed", Some("Step 1: opening com.game failed: Error: Activity not started")));

    let empty = run_tab(opts(tab_of(vec![app_step("a", " ", "", false)]), vec![phone("a")], counting_sender(Arc::default(), None), Arc::default())).await;
    assert_eq!(empty.message.as_deref(), Some("Step 1: app steps need the ADBoard agent"));
}

/// Tabs saved before text steps existed still load and play the same.
#[tokio::test]
async fn older_macros_still_load_and_play() {
    let old = serde_json::json!({
        "id": "tab-old", "name": "Farm", "reference": {"width": 1080, "height": 2400},
        "scale": "stretch", "orientation": "any", "stop": {"mode": "cycles", "seconds": 300, "cycles": 2},
        "jitterPx": 0, "targetIds": ["a"], "notes": "", "createdAt": 1, "updatedAt": 2,
        "steps": [{"id": "s1", "label": "", "enabled": true, "delayMs": 0,
                   "fingers": [{"id": "f1", "x": 540, "y": 1200, "startMs": 0, "durationMs": 50}]}]
    });
    let tab: MacroTab = serde_json::from_value(old).unwrap();
    assert!(tab.steps[0].text_step().is_none());
    let count = Arc::new(AtomicUsize::new(0));
    let result = run_tab(opts(tab, vec![phone("a")], counting_sender(count.clone(), None), Arc::default())).await;
    assert_eq!((result.status.as_str(), count.load(Ordering::SeqCst)), ("done", 2));
    assert!(result.text.is_none() && result.vars.is_empty());
}

#[test]
fn text_step_json_from_the_browser() {
    let step: MacroStep = serde_json::from_value(serde_json::json!({
        "id": "s", "label": "", "enabled": true, "fingers": [], "delayMs": 300, "kind": "text",
        "text": {"action": "tap", "texts": ["OK"], "match": "exact", "caseSensitive": true,
                 "area": {"x": 0, "y": 1200, "width": 1080, "height": 1200},
                 "timeoutMs": 10000, "intervalMs": 1000, "offsetX": 0, "offsetY": -40, "variable": "",
                 "onSuccess": {"go": "next"}, "onFailure": {"go": "step", "stepId": "s9"}}
    }))
    .unwrap();
    let text = step.text_step().unwrap();
    assert_eq!((text.query.mode.as_str(), text.query.case_sensitive, text.offset_y), ("exact", true, -40.0));
    assert_eq!(text.on_failure, Outcome { go: "step".into(), step_id: Some("s9".into()) });
    // The bottom half of the reference maps to the bottom half of any screen (stretch).
    let tab = tab_of(vec![]);
    let area = screen_area(text.area.unwrap(), &tab, &phone("a"));
    assert_eq!(area, Area { x: 0.0, y: 0.5, width: 1.0, height: 0.5 });
}
