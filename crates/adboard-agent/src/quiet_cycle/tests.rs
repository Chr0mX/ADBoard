use super::*;

const QUIET: u64 = 600; // seconds
const T0: u64 = 1_000_000; // ms

fn running(peek: u64) -> Cycle {
    Cycle::started(QUIET, peek, T0)
}

fn s(name: &str) -> String {
    name.to_string()
}

// ---- timing ----

#[test]
fn it_starts_quiet_immediately_for_the_full_quiet_duration() {
    let c = running(3);
    assert!(c.enabled);
    assert_eq!(c.phase, Phase::Quiet);
    assert_eq!(c.phase_started_ms, T0);
    assert_eq!(c.phase_ends_ms, T0 + 600_000);
    assert_eq!(c.run_id, T0);
}

#[test]
fn the_screen_on_time_is_not_part_of_the_quiet_time() {
    // 600 s quiet, 3 s screen on, 600 s quiet, 3 s screen on ...
    let mut c = running(3);
    assert!(!c.advance(T0 + 599_999));
    assert!(c.advance(T0 + 600_000));
    assert_eq!(c.phase, Phase::Peek);
    assert_eq!(
        (c.phase_started_ms, c.phase_ends_ms),
        (T0 + 600_000, T0 + 603_000)
    );
    assert!(!c.advance(T0 + 602_999));
    assert!(c.advance(T0 + 603_000));
    assert_eq!(c.phase, Phase::Quiet);
    // The new quiet countdown starts after the screen-on phase: another full 600 s.
    assert_eq!(
        (c.phase_started_ms, c.phase_ends_ms),
        (T0 + 603_000, T0 + 1_203_000)
    );
    assert!(c.advance(T0 + 1_203_000));
    assert_eq!(c.phase, Phase::Peek);
    assert_eq!(c.phase_ends_ms, T0 + 1_206_000);
}

#[test]
fn screen_on_durations_of_one_three_and_five_seconds() {
    for peek in [1u64, 3, 5] {
        let mut c = running(peek);
        c.advance(T0 + 600_000);
        assert_eq!(c.phase, Phase::Peek, "peek {peek}");
        assert_eq!(c.phase_ends_ms - c.phase_started_ms, peek * 1000);
        c.advance(c.phase_ends_ms);
        assert_eq!(c.phase, Phase::Quiet);
        assert_eq!(
            c.phase_ends_ms - c.phase_started_ms,
            600_000,
            "quiet is always the full time"
        );
    }
}

#[test]
fn a_late_check_does_not_drift_the_schedule() {
    let mut c = running(3);
    assert!(c.advance(T0 + 601_700)); // checked 1.7 s late
    assert_eq!(c.phase, Phase::Peek);
    assert_eq!(
        c.phase_ends_ms,
        T0 + 603_000,
        "the next change is still on schedule"
    );
}

#[test]
fn it_repeats_indefinitely_and_lands_on_the_right_phase_after_a_long_gap() {
    // The period is 603 s: quiet [0,600), screen on [600,603), repeating.
    for peek_us in [
        0u64,
        599_999,
        600_000,
        602_999,
        603_000,
        1_202_999,
        1_203_000,
        603_000 * 1_000 + 1,
        603_000 * 1_000 + 600_500,
    ] {
        let mut c = running(3);
        c.advance(T0 + peek_us);
        let in_period = peek_us % 603_000;
        let want = if in_period < 600_000 {
            Phase::Quiet
        } else {
            Phase::Peek
        };
        assert_eq!(c.phase, want, "at +{peek_us} ms");
        assert!(c.phase_started_ms <= T0 + peek_us && T0 + peek_us < c.phase_ends_ms);
    }
}

#[test]
fn a_stopped_loop_never_moves() {
    let mut c = running(3);
    c.enabled = false;
    assert!(!c.advance(T0 + 99_999_999));
    assert_eq!(c.phase, Phase::Quiet);
}

#[test]
fn settings_are_limited() {
    assert_eq!(clamp_secs(1), 60);
    assert_eq!(clamp_secs(u64::MAX), MAX_SECS);
    assert!(valid_peek(1) && valid_peek(3) && valid_peek(5));
    assert!(!valid_peek(0) && !valid_peek(6));
    assert_eq!(Cycle::started(600, 99, T0).peek_secs, 5);
    assert_eq!(Cycle::started(600, 0, T0).peek_secs, 1);
}

// ---- saving and restarts ----

#[test]
fn a_saved_loop_resumes_after_a_restart_in_the_right_phase() {
    let dir = std::env::temp_dir().join(format!("adboard-quiet-{}", uuid::Uuid::new_v4()));
    let path = dir.join(FILE_NAME);
    let c = running(5);
    save_to(&path, &c).unwrap();
    let mut loaded = load_from(&path);
    assert_eq!(
        loaded, c,
        "the quiet duration and the screen-on duration are both saved"
    );
    // Restarted in the middle of the screen-on phase, then in the next quiet phase.
    loaded.advance(T0 + 600_000 + 2_000);
    assert_eq!(loaded.phase, Phase::Peek);
    loaded.advance(T0 + 605_000 + 10_000);
    assert_eq!(loaded.phase, Phase::Quiet);
    assert_eq!(loaded.phase_started_ms, T0 + 605_000);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn an_older_saved_file_still_loads() {
    let dir = std::env::temp_dir().join(format!("adboard-quiet-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("old.json");
    std::fs::write(
        &path,
        br#"{"enabled":true,"intervalSecs":1800,"phase":"normal","phaseStartedAt":1,"phaseEndsAt":2}"#,
    )
    .unwrap();
    let loaded = load_from(&path);
    assert!(loaded.enabled);
    assert_eq!(loaded.interval_secs, 1800);
    assert_eq!(
        loaded.peek_secs, DEFAULT_PEEK_SECS,
        "the screen-on time defaults to 3 s"
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_missing_or_broken_file_means_no_loop() {
    let dir = std::env::temp_dir().join(format!("adboard-quiet-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    assert!(!load_from(&dir.join("none.json")).enabled);
    std::fs::write(dir.join("bad.json"), b"{nope").unwrap();
    assert!(!load_from(&dir.join("bad.json")).enabled);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn the_status_reports_seconds_for_the_screen() {
    let c = running(3);
    let status = status_at(&c, T0 + 1_500);
    assert_eq!(status.seconds_left, 599);
    assert_eq!(status.peek_secs, 3);
    assert_eq!(status.interval_secs, 600);
    assert_eq!(status_at(&Cycle::default(), T0).seconds_left, 0);
}

#[test]
fn the_task_wakes_for_the_end_of_a_short_screen_on_phase() {
    let tick = Duration::from_secs(5);
    assert_eq!(
        next_wait(true, 1_000, 1_800, tick),
        Duration::from_millis(800)
    );
    assert_eq!(
        next_wait(true, 1_000, 99_000, tick),
        tick,
        "never longer than a normal check"
    );
    assert_eq!(
        next_wait(true, 1_000, 900, tick),
        Duration::from_millis(100),
        "never a busy loop"
    );
    assert_eq!(next_wait(false, 1_000, 1_100, tick), tick);
}

// ---- per-phone tracking ----

#[test]
fn a_phone_is_finished_only_with_the_run_muted_and_this_phase_screen_set() {
    let mut done = HashMap::new();
    record(&mut done, "A", 7, 100, Some(true), Some(true));
    record(&mut done, "B", 7, 100, Some(true), Some(false));
    let online = vec![s("A"), s("B"), s("C")];
    assert_eq!(pending(&online, &done, 7, 100), vec![s("B"), s("C")]);
    // A new phase: only the screen is needed again; the sound stays muted for the run.
    let next = pending(&online, &done, 7, 200);
    assert_eq!(next, online);
    let (audio, screen) = plan(&next, &done, 7, 200);
    assert_eq!(
        audio,
        vec![s("C")],
        "A and B are already muted for this run"
    );
    assert_eq!(screen, online);
}

#[test]
fn audio_ok_screen_failed_stays_pending_and_only_the_screen_is_retried() {
    let mut done = HashMap::new();
    record(&mut done, "A", 7, 100, Some(true), Some(false));
    assert_eq!(pending(&[s("A")], &done, 7, 100), vec![s("A")]);
    let (audio, screen) = plan(&[s("A")], &done, 7, 100);
    assert!(audio.is_empty(), "the mute is not sent again");
    assert_eq!(screen, vec![s("A")]);
    record(&mut done, "A", 7, 100, None, Some(true));
    assert!(pending(&[s("A")], &done, 7, 100).is_empty());
}

#[test]
fn audio_failed_screen_ok_stays_pending_and_only_the_sound_is_retried() {
    let mut done = HashMap::new();
    record(&mut done, "A", 7, 100, Some(false), Some(true));
    assert_eq!(pending(&[s("A")], &done, 7, 100), vec![s("A")]);
    let (audio, screen) = plan(&[s("A")], &done, 7, 100);
    assert_eq!(audio, vec![s("A")]);
    assert!(screen.is_empty());
    record(&mut done, "A", 7, 100, Some(true), None);
    assert!(pending(&[s("A")], &done, 7, 100).is_empty());
}

#[test]
fn phones_keep_their_own_state() {
    let mut done = HashMap::new();
    record(&mut done, "A", 7, 100, Some(true), Some(true));
    record(&mut done, "B", 7, 100, Some(true), Some(false));
    record(&mut done, "C", 7, 100, Some(false), Some(false));
    let (audio, screen) = plan(
        &pending(&[s("A"), s("B"), s("C")], &done, 7, 100),
        &done,
        7,
        100,
    );
    assert_eq!(audio, vec![s("C")]);
    assert_eq!(screen, vec![s("B"), s("C")]);
    record(&mut done, "B", 7, 100, None, Some(false)); // B fails again: its mute stays recorded
    assert_eq!(
        done["B"],
        Done {
            audio: Some(7),
            screen: None
        }
    );
    assert_eq!(
        done["A"],
        Done {
            audio: Some(7),
            screen: Some(100)
        }
    );
}

fn gens(pairs: &[(&str, u64)]) -> HashMap<String, u64> {
    pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()
}

fn outcomes(pairs: &[(&str, bool)]) -> HashMap<String, bool> {
    pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()
}

#[test]
fn a_result_for_a_phone_that_reconnected_meanwhile_is_stale_and_ignored() {
    let mut done = HashMap::new();
    // A reconnected while its operations ran (generation 1 -> 2); B did not.
    settle(
        &mut done,
        &gens(&[("A", 1), ("B", 1)]),
        &gens(&[("A", 2), ("B", 1)]),
        7,
        100,
        100,
        &outcomes(&[("A", true), ("B", true)]),
        &outcomes(&[("A", true), ("B", true)]),
    );
    assert!(!done.contains_key("A"), "A stays pending and is redone");
    assert_eq!(
        done["B"],
        Done {
            audio: Some(7),
            screen: Some(100)
        },
        "B is unaffected"
    );
}

#[test]
fn a_screen_result_never_marks_a_newer_phase_done() {
    let mut done = HashMap::new();
    // The phase changed (100 -> 200) while the screen change for phase 100 was in flight.
    settle(
        &mut done,
        &gens(&[("A", 1)]),
        &gens(&[("A", 1)]),
        7,
        100,
        200,
        &outcomes(&[("A", true)]),
        &outcomes(&[("A", true)]),
    );
    assert_eq!(
        done["A"],
        Done {
            audio: Some(7),
            screen: None
        },
        "the mute still counts, the screen does not"
    );
    assert_eq!(pending(&[s("A")], &done, 7, 200), vec![s("A")]);
}

#[test]
fn a_failure_for_one_phone_leaves_the_others_recorded() {
    let mut done = HashMap::new();
    settle(
        &mut done,
        &gens(&[]),
        &gens(&[]),
        7,
        100,
        100,
        &outcomes(&[("A", true), ("B", false), ("C", true)]),
        &outcomes(&[("A", true), ("B", true), ("C", false)]),
    );
    assert_eq!(
        done["A"],
        Done {
            audio: Some(7),
            screen: Some(100)
        }
    );
    assert_eq!(
        done["B"],
        Done {
            audio: None,
            screen: Some(100)
        }
    );
    assert_eq!(
        done["C"],
        Done {
            audio: Some(7),
            screen: None
        }
    );
}

#[test]
fn a_new_run_mutes_again() {
    let mut done = HashMap::new();
    record(&mut done, "A", 7, 100, Some(true), Some(true));
    assert_eq!(
        plan(&[s("A")], &done, 8, 100).0,
        vec![s("A")],
        "a restarted loop mutes again"
    );
}

#[test]
fn saved_volumes_survive_a_restart() {
    let dir = std::env::temp_dir().join(format!("adboard-quiet-{}", uuid::Uuid::new_v4()));
    let path = dir.join("quiet-volumes.json");
    let mut map = HashMap::new();
    map.insert("SERIAL1".to_string(), 9u32);
    crate::device_ops::store_volumes(&path, &map).unwrap();
    assert_eq!(
        crate::device_ops::load_volumes(&path).get("SERIAL1"),
        Some(&9)
    );
    let _ = std::fs::remove_dir_all(dir);
}
