//! One keyframe reset at a time per phone.
//!
//! A keyframe is asked for by scrcpy's `RESET_VIDEO`, which makes the phone's encoder start over. Many things
//! ask: every new viewer socket, a socket waiting for a keyframe, a lagging socket, a page whose decoder fell
//! behind or stalled, the input watch, a person pressing Refresh. Before, a reset that had not produced a
//! keyframe within 800 ms counted as lost, so the next ask sent another one while the encoder was still
//! restarting, and an encoder that takes longer than that was restarted again and again.
//!
//! Now each phone has at most one **outstanding** reset. Every ask while it is outstanding is merged into it
//! (counted, and named in its log line). It ends only when:
//!
//! - a keyframe is seen after it was sent (`answered`): the encoder did restart; or
//! - its deadline passes with no keyframe (`expired`): it is sent once more, and if that one is not answered
//!   either, the phone's stream is restarted (a controlled recovery), at most once per a growing interval.
//!
//! Between two resets that were answered the old spacing remains (`RESET_GAP`, or `BRAKE_GAP` once a phone
//! had `BRAKE_AFTER` resets inside `BRAKE_WINDOW`). Every reset actually written to the phone counts toward
//! that brake, whichever path sent it (at once, after the gap, the first-frame watch, a retry).
//!
//! Pure bookkeeping: no clock, no I/O; the session manager owns the timers.
use std::collections::{HashMap, VecDeque};
use std::time::Duration;
use std::time::Instant;

/// Resets sent in this long are counted for the brake.
pub(super) const BRAKE_WINDOW: Duration = Duration::from_secs(10);
/// This many resets of one phone inside `BRAKE_WINDOW` is a storm.
pub(super) const BRAKE_AFTER: usize = 4;
/// While the brake is on, resets of that phone go out no closer than this.
pub(super) const BRAKE_GAP: Duration = Duration::from_secs(4);
/// Closest two resets of the same phone are sent, after the first one was answered.
pub(super) const RESET_GAP: Duration = Duration::from_millis(800);
/// How long an outstanding reset waits for its keyframe before it counts as failed. An encoder restart is a
/// MediaCodec stop + configure + start and a new capture surface; how long that takes differs per phone, and the
/// log line `keyframe answered the reset` records it (`latency_ms`) so this can be tuned with
/// `ADBOARD_RESET_DEADLINE_MS`. The default leaves several times the 800 ms that used to be assumed.
pub(super) const DEFAULT_DEADLINE: Duration = Duration::from_millis(3000);
pub(super) const MIN_DEADLINE: Duration = Duration::from_millis(500);
pub(super) const MAX_DEADLINE: Duration = Duration::from_secs(30);
/// Resets sent for one outstanding ask before the stream is restarted instead (the first and one more).
pub(super) const MAX_ATTEMPTS: u32 = 2;
/// The first controlled restart may come at once; the next ones of the same phone wait this long, doubling.
pub(super) const ESCALATE_FIRST: Duration = Duration::from_secs(60);
pub(super) const ESCALATE_MAX: Duration = Duration::from_secs(600);

/// The deadline from `ADBOARD_RESET_DEADLINE_MS`, clamped; the default when unset or unreadable.
pub(super) fn deadline_from(raw: Option<&str>) -> Duration {
    raw.and_then(|v| v.trim().parse::<u64>().ok())
        .map(Duration::from_millis)
        .map(|d| d.clamp(MIN_DEADLINE, MAX_DEADLINE))
        .unwrap_or(DEFAULT_DEADLINE)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ResetPlan {
    /// Write a reset now. `generation` names this outstanding reset for its deadline watch.
    Send { generation: u64 },
    /// Write one after this long (`begin_delayed` then decides); it also serves anyone who asks meanwhile.
    After(Duration),
    /// A reset is already outstanding or scheduled: this ask is merged into it.
    Merged,
}

/// A reset that was answered by a keyframe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Answer {
    pub latency: Duration,
    pub attempt: u32,
    pub merged: u32,
    pub reasons: String,
    pub keyframes_before: u64,
}

/// What to do when an outstanding reset's deadline passed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Expiry {
    /// The keyframe did come (the watch was late): nothing to do.
    Answered(Answer),
    /// Another reset was sent and replaced this watch, or the phone's stream was restarted.
    Stale,
    /// Send the reset once more; `generation` names the new attempt.
    Retry { generation: u64, attempt: u32 },
    /// No keyframe after `MAX_ATTEMPTS` resets: restart the phone's stream.
    Escalate { escalations: u32, reasons: String },
    /// Same, but a restart of this phone happened too recently: wait for the next ask.
    GiveUp { retry_in: Duration },
}

/// Counters for the heartbeat and diagnostics.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ResetStats {
    /// Resets written to the phone (all paths) and asks merged into one already outstanding.
    pub sent: u64,
    pub merged: u64,
    /// Deadlines that passed with no keyframe, and controlled restarts that followed.
    pub expired: u64,
    pub escalated: u64,
    /// The attempt number of the outstanding reset (0: none outstanding).
    pub outstanding_attempt: u32,
    /// Time from the last answered reset to its keyframe.
    pub last_latency_ms: Option<u64>,
}

#[derive(Debug, Clone)]
struct Outstanding {
    generation: u64,
    first_sent_at: Instant,
    sent_at: Instant,
    keyframes: u64,
    attempt: u32,
    merged: u32,
    reasons: Vec<String>,
}

#[derive(Default)]
struct Phone {
    outstanding: Option<Outstanding>,
    /// A delayed send is scheduled (`After`): asks until then are merged into it.
    waiting: bool,
    waiting_reasons: Vec<String>,
    last_sent: Option<Instant>,
    sent_times: VecDeque<Instant>,
    asked: VecDeque<(Instant, String)>,
    braking: bool,
    escalations: u32,
    next_escalation_at: Option<Instant>,
    stats: ResetStats,
}

pub(super) struct ResetGate {
    gap: Duration,
    deadline: Duration,
    generation: u64,
    phones: HashMap<String, Phone>,
}

fn note_reason(reasons: &mut Vec<String>, reason: &str) {
    if !reasons.iter().any(|r| r == reason) && reasons.len() < 8 {
        reasons.push(reason.to_string());
    }
}

impl ResetGate {
    pub(super) fn new(gap: Duration) -> Self {
        Self::with_deadline(gap, DEFAULT_DEADLINE)
    }

    pub(super) fn with_deadline(gap: Duration, deadline: Duration) -> Self {
        Self { gap, deadline, generation: 0, phones: HashMap::new() }
    }

    pub(super) fn deadline(&self) -> Duration {
        self.deadline
    }

    #[cfg(test)]
    pub(super) fn set_deadline(&mut self, deadline: Duration) {
        self.deadline = deadline;
    }

    fn phone(&mut self, serial: &str) -> &mut Phone {
        self.phones.entry(serial.to_string()).or_default()
    }

    /// The gap in force for `serial`: normal, or the brake's when too many resets went out lately.
    fn gap_for(&mut self, serial: &str, now: Instant) -> Duration {
        let normal = self.gap;
        let phone = self.phone(serial);
        while phone.sent_times.front().is_some_and(|t| now.saturating_duration_since(*t) > BRAKE_WINDOW) {
            phone.sent_times.pop_front();
        }
        if phone.sent_times.len() >= BRAKE_AFTER {
            normal.max(BRAKE_GAP)
        } else {
            phone.braking = false;
            normal
        }
    }

    /// A reset is written to the phone now: it becomes the outstanding one and counts toward the brake.
    fn record_sent(&mut self, serial: &str, now: Instant, keyframes: u64, attempt: u32, reasons: Vec<String>) -> u64 {
        self.generation += 1;
        let generation = self.generation;
        let phone = self.phone(serial);
        let first_sent_at = phone.outstanding.as_ref().map_or(now, |o| o.first_sent_at);
        let merged = phone.outstanding.as_ref().map_or(0, |o| o.merged);
        phone.outstanding = Some(Outstanding { generation, first_sent_at, sent_at: now, keyframes, attempt, merged, reasons });
        phone.last_sent = Some(now);
        phone.sent_times.push_back(now);
        phone.stats.sent += 1;
        phone.stats.outstanding_attempt = attempt;
        generation
    }

    /// Someone asks for a keyframe of `serial`, whose stream has carried `keyframes` so far.
    pub(super) fn request(&mut self, serial: &str, now: Instant, keyframes: u64, reason: &str) -> (ResetPlan, Option<Answer>) {
        {
            let phone = self.phone(serial);
            phone.asked.push_back((now, reason.to_string()));
            while phone.asked.front().is_some_and(|(t, _)| now.saturating_duration_since(*t) > BRAKE_WINDOW) {
                phone.asked.pop_front();
            }
        }
        // The outstanding reset may have been answered already (its watch has not looked yet).
        let answer = self.answered(serial, now, keyframes);
        let gap = self.gap_for(serial, now);
        let phone = self.phone(serial);
        if let Some(out) = phone.outstanding.as_mut() {
            out.merged += 1;
            note_reason(&mut out.reasons, reason);
            phone.stats.merged += 1;
            return (ResetPlan::Merged, answer);
        }
        if phone.waiting {
            note_reason(&mut phone.waiting_reasons, reason);
            phone.stats.merged += 1;
            return (ResetPlan::Merged, answer);
        }
        if let Some(last) = phone.last_sent {
            let since = now.saturating_duration_since(last);
            if since < gap {
                phone.waiting = true;
                phone.waiting_reasons = vec![reason.to_string()];
                return (ResetPlan::After(gap - since), answer);
            }
        }
        let generation = self.record_sent(serial, now, keyframes, 1, vec![reason.to_string()]);
        (ResetPlan::Send { generation }, answer)
    }

    /// The delay of an `After` plan is over: write the reset now (`Some(generation)`), unless one went out
    /// meanwhile (`None`).
    pub(super) fn begin_delayed(&mut self, serial: &str, now: Instant, keyframes: u64) -> Option<u64> {
        let phone = self.phone(serial);
        let was_waiting = std::mem::take(&mut phone.waiting);
        let reasons = std::mem::take(&mut phone.waiting_reasons);
        if !was_waiting || phone.outstanding.is_some() {
            return None;
        }
        Some(self.record_sent(serial, now, keyframes, 1, if reasons.is_empty() { vec!["delayed".into()] } else { reasons }))
    }

    /// The first-frame watch wants to send its reset (a new stream that showed no frame): through the same
    /// rules, so it is merged into an outstanding reset and counts toward the brake.
    pub(super) fn first_frame(&mut self, serial: &str, now: Instant, keyframes: u64) -> Option<u64> {
        let (plan, _) = self.request(serial, now, keyframes, "first-frame");
        match plan {
            ResetPlan::Send { generation } => Some(generation),
            // Within the gap of an answered reset: that keyframe is recent enough for a stream that had none.
            ResetPlan::After(_) => {
                let phone = self.phone(serial);
                phone.waiting = false;
                phone.waiting_reasons.clear();
                None
            }
            ResetPlan::Merged => None,
        }
    }

    /// A keyframe count of `keyframes` was seen: if it is past the outstanding reset's, that reset is answered.
    pub(super) fn answered(&mut self, serial: &str, now: Instant, keyframes: u64) -> Option<Answer> {
        let phone = self.phones.get_mut(serial)?;
        let out = phone.outstanding.as_ref()?;
        if keyframes <= out.keyframes {
            return None;
        }
        let out = phone.outstanding.take()?;
        let latency = now.saturating_duration_since(out.sent_at);
        phone.stats.last_latency_ms = Some(latency.as_millis() as u64);
        phone.stats.outstanding_attempt = 0;
        // The encoder answers again: the next controlled restart, if one is ever needed, may come at once.
        phone.escalations = 0;
        phone.next_escalation_at = None;
        Some(Answer { latency, attempt: out.attempt, merged: out.merged, reasons: out.reasons.join(","), keyframes_before: out.keyframes })
    }

    /// The deadline of outstanding reset `generation` passed; the stream carries `keyframes` now.
    pub(super) fn expired(&mut self, serial: &str, now: Instant, keyframes: u64, generation: u64) -> Expiry {
        let current = self.phones.get(serial).and_then(|p| p.outstanding.as_ref()).map(|o| o.generation);
        if current != Some(generation) {
            return Expiry::Stale;
        }
        if let Some(answer) = self.answered(serial, now, keyframes) {
            return Expiry::Answered(answer);
        }
        let phone = self.phone(serial);
        phone.stats.expired += 1;
        let out = phone.outstanding.clone().expect("checked above");
        if out.attempt < MAX_ATTEMPTS {
            let attempt = out.attempt + 1;
            let generation = self.record_sent(serial, now, keyframes, attempt, out.reasons);
            return Expiry::Retry { generation, attempt };
        }
        let phone = self.phone(serial);
        phone.outstanding = None;
        phone.stats.outstanding_attempt = 0;
        if let Some(at) = phone.next_escalation_at {
            if now < at {
                return Expiry::GiveUp { retry_in: at - now };
            }
        }
        phone.escalations += 1;
        phone.stats.escalated += 1;
        let wait = ESCALATE_FIRST.saturating_mul(1u32 << (phone.escalations - 1).min(4)).min(ESCALATE_MAX);
        phone.next_escalation_at = Some(now + wait);
        Expiry::Escalate { escalations: phone.escalations, reasons: out.reasons.join(",") }
    }

    /// Once per storm: what is asking for so many keyframes of this phone, to put in the log.
    pub(super) fn brake_report(&mut self, serial: &str, now: Instant) -> Option<String> {
        let phone = self.phones.get_mut(serial)?;
        let sent = phone.sent_times.len();
        if sent < BRAKE_AFTER || phone.braking {
            return None;
        }
        phone.braking = true;
        let mut by_reason: Vec<(String, usize)> = Vec::new();
        for (at, reason) in &phone.asked {
            if now.saturating_duration_since(*at) > BRAKE_WINDOW {
                continue;
            }
            match by_reason.iter_mut().find(|(r, _)| r == reason) {
                Some((_, n)) => *n += 1,
                None => by_reason.push((reason.clone(), 1)),
            }
        }
        by_reason.sort_by(|a, b| b.1.cmp(&a.1));
        let who = by_reason.iter().map(|(r, n)| format!("{r} x{n}")).collect::<Vec<_>>().join(", ");
        Some(format!(
            "{sent} keyframe resets in {} s; slowing to one every {} s. Asked by: {who}",
            BRAKE_WINDOW.as_secs(),
            BRAKE_GAP.as_secs()
        ))
    }

    /// Is `generation` still the outstanding reset of `serial`?
    pub(super) fn is_outstanding(&self, serial: &str, generation: u64) -> bool {
        self.phones.get(serial).and_then(|p| p.outstanding.as_ref()).is_some_and(|o| o.generation == generation)
    }

    pub(super) fn stats(&self, serial: &str) -> ResetStats {
        self.phones.get(serial).map_or_else(ResetStats::default, |p| p.stats)
    }

    /// The phone's stream stopped (a stop, a restart, a crash): nothing outstanding belongs to the next one.
    /// The escalation backoff stays, so restarts of a phone that never answers stay spaced out.
    pub(super) fn forget(&mut self, serial: &str) {
        if let Some(phone) = self.phones.get_mut(serial) {
            phone.outstanding = None;
            phone.waiting = false;
            phone.waiting_reasons.clear();
            phone.last_sent = None;
            phone.stats.outstanding_attempt = 0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gate() -> ResetGate {
        ResetGate::with_deadline(Duration::from_millis(800), Duration::from_millis(3000))
    }

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    fn sent(plan: (ResetPlan, Option<Answer>)) -> u64 {
        match plan.0 {
            ResetPlan::Send { generation } => generation,
            other => panic!("expected a send, got {other:?}"),
        }
    }

    #[test]
    fn the_first_request_goes_out_at_once() {
        let mut gate = gate();
        sent(gate.request("A", Instant::now(), 0, "t"));
        assert_eq!(gate.stats("A").sent, 1);
    }

    #[test]
    fn asks_while_a_reset_is_outstanding_are_merged_however_long_it_takes() {
        let mut gate = gate();
        let t = Instant::now();
        sent(gate.request("A", t, 3, "connect"));
        // The page's ask, a second socket, the stall watch: none of them writes a second reset, also well
        // past the 800 ms after which a reset used to count as lost.
        for at in [10, 250, 900, 1600, 2400, 2999] {
            assert_eq!(gate.request("A", t + ms(at), 3, "stall").0, ResetPlan::Merged, "at {at} ms");
        }
        let stats = gate.stats("A");
        assert_eq!((stats.sent, stats.merged, stats.outstanding_attempt), (1, 6, 1));
    }

    #[test]
    fn a_slow_keyframe_answers_the_reset_without_another_one() {
        let mut gate = gate();
        let t = Instant::now();
        let generation = sent(gate.request("A", t, 3, "connect"));
        assert_eq!(gate.request("A", t + ms(1200), 3, "stall").0, ResetPlan::Merged);
        // The keyframe arrives after 2.5 s: answered, with its latency and who asked.
        let answer = gate.answered("A", t + ms(2500), 4).expect("answered");
        assert_eq!(answer.latency, ms(2500));
        assert_eq!(answer.reasons, "connect,stall");
        assert_eq!((answer.attempt, answer.merged, answer.keyframes_before), (1, 1, 3));
        assert_eq!(gate.expired("A", t + ms(3000), 4, generation), Expiry::Stale, "its deadline watch finds nothing to do");
        assert_eq!(gate.stats("A").sent, 1);
        assert_eq!(gate.stats("A").last_latency_ms, Some(2500));
    }

    #[test]
    fn a_reset_answered_before_its_watch_looked_lets_a_later_viewer_ask_for_its_own() {
        let mut gate = gate();
        let t = Instant::now();
        sent(gate.request("A", t, 3, "connect"));
        // The keyframe came out (3 -> 4); a socket that joined after it asks: it needs a newer keyframe.
        let (plan, answer) = gate.request("A", t + ms(200), 4, "connect");
        assert!(answer.is_some(), "the request itself noticed the answer");
        assert_eq!(plan, ResetPlan::After(ms(600)), "after the normal gap");
        assert_eq!(gate.request("A", t + ms(300), 4, "stall").0, ResetPlan::Merged, "scheduled: merged");
        assert!(gate.begin_delayed("A", t + ms(800), 4).is_some());
        assert_eq!(gate.stats("A").sent, 2);
    }

    #[test]
    fn a_missing_keyframe_is_retried_once_then_the_stream_is_restarted_then_spaced_out() {
        let mut gate = gate();
        let t = Instant::now();
        let first = sent(gate.request("A", t, 3, "connect"));
        let Expiry::Retry { generation: second, attempt } = gate.expired("A", t + ms(3000), 3, first) else {
            panic!("expected a retry");
        };
        assert_eq!(attempt, 2);
        assert_eq!(gate.stats("A").outstanding_attempt, 2);
        // Asks during the retry are still merged.
        assert_eq!(gate.request("A", t + ms(4000), 3, "stall").0, ResetPlan::Merged);
        match gate.expired("A", t + ms(6000), 3, second) {
            Expiry::Escalate { escalations, reasons } => {
                assert_eq!(escalations, 1);
                assert_eq!(reasons, "connect,stall");
            }
            other => panic!("expected a controlled restart, got {other:?}"),
        }
        let stats = gate.stats("A");
        assert_eq!((stats.sent, stats.expired, stats.escalated, stats.outstanding_attempt), (2, 2, 1, 0));
        // The restarted stream starts clean; it never answers either: the next restart waits a minute.
        gate.forget("A");
        let third = sent(gate.request("A", t + ms(10_000), 0, "connect"));
        let Expiry::Retry { generation: fourth, .. } = gate.expired("A", t + ms(13_000), 0, third) else { panic!() };
        assert!(matches!(gate.expired("A", t + ms(16_000), 0, fourth), Expiry::GiveUp { .. }), "no restart loop");
        // Nothing is stuck: the next ask sends a reset again.
        sent(gate.request("A", t + ms(20_000), 0, "stall"));
    }

    #[test]
    fn an_answer_ends_the_escalation_backoff() {
        let mut gate = gate();
        let t = Instant::now();
        let g = sent(gate.request("A", t, 0, "x"));
        let Expiry::Retry { generation, .. } = gate.expired("A", t + ms(3000), 0, g) else { panic!() };
        assert!(matches!(gate.expired("A", t + ms(6000), 0, generation), Expiry::Escalate { .. }));
        gate.forget("A");
        sent(gate.request("A", t + ms(9000), 0, "x"));
        assert!(gate.answered("A", t + ms(9500), 1).is_some());
        let g = sent(gate.request("A", t + ms(20_000), 1, "x"));
        let Expiry::Retry { generation, .. } = gate.expired("A", t + ms(23_000), 1, g) else { panic!() };
        assert!(matches!(gate.expired("A", t + ms(26_000), 1, generation), Expiry::Escalate { .. }), "allowed again at once");
    }

    #[test]
    fn every_kind_of_send_counts_toward_the_storm_brake() {
        let mut gate = gate();
        let t = Instant::now();
        // An immediate send, a delayed one, a first-frame-watch one and a retry, each answered in turn.
        let g = sent(gate.request("A", t, 0, "connect"));
        let _ = g;
        assert!(gate.answered("A", t + ms(100), 1).is_some());
        assert!(matches!(gate.request("A", t + ms(200), 1, "lag").0, ResetPlan::After(_)));
        assert!(gate.begin_delayed("A", t + ms(800), 1).is_some(), "delayed send");
        assert!(gate.answered("A", t + ms(900), 2).is_some());
        assert!(gate.first_frame("A", t + ms(1700), 2).is_some(), "first-frame watch send");
        let g = gate.phones["A"].outstanding.as_ref().unwrap().generation;
        let Expiry::Retry { .. } = gate.expired("A", t + ms(4700), 2, g) else { panic!("retry send") };
        assert_eq!(gate.stats("A").sent, 4);
        assert!(gate.brake_report("A", t + ms(4700)).is_some(), "four sends of any kind start the brake");
        assert!(gate.answered("A", t + ms(4800), 3).is_some());
        // Braking: the next ask waits for the 4 s gap from the last send.
        assert_eq!(gate.request("A", t + ms(5700), 3, "manual").0, ResetPlan::After(ms(3000)));
    }

    #[test]
    fn the_first_frame_watch_does_not_add_a_reset_to_an_outstanding_one() {
        let mut gate = gate();
        let t = Instant::now();
        sent(gate.request("A", t, 0, "connect"));
        assert_eq!(gate.first_frame("A", t + ms(100), 0), None);
        assert_eq!(gate.stats("A").sent, 1);
    }

    #[test]
    fn one_phone_never_delays_another() {
        let mut gate = gate();
        let t = Instant::now();
        let a = sent(gate.request("A", t, 0, "t"));
        sent(gate.request("B", t + ms(10), 0, "t"));
        assert_eq!(gate.request("A", t + ms(20), 0, "t").0, ResetPlan::Merged);
        // A's reset expires and escalates; B is untouched.
        let Expiry::Retry { generation, .. } = gate.expired("A", t + ms(3000), 0, a) else { panic!() };
        assert!(matches!(gate.expired("A", t + ms(6000), 0, generation), Expiry::Escalate { .. }));
        assert_eq!(gate.stats("B").outstanding_attempt, 1);
        assert_eq!(gate.stats("B").expired, 0);
        assert!(gate.answered("B", t + ms(6100), 1).is_some());
    }

    #[test]
    fn a_storm_report_names_who_asked() {
        let mut gate = gate();
        let t = Instant::now();
        for (i, at) in [0u64, 900, 1800, 2700].into_iter().enumerate() {
            let reason = if i % 2 == 0 { "decode-backlog" } else { "lag" };
            sent(gate.request("A", t + ms(at), i as u64, reason));
            assert!(gate.answered("A", t + ms(at + 100), i as u64 + 1).is_some());
        }
        assert!(gate.brake_report("A", t + ms(2700)).is_some_and(|m| m.contains("decode-backlog x2") && m.contains("lag x2")));
        assert!(gate.brake_report("A", t + ms(2800)).is_none(), "reported once per storm");
        // Long after the storm the normal gap is back.
        sent(gate.request("A", t + Duration::from_secs(30), 9, "connect"));
        assert!(gate.answered("A", t + Duration::from_secs(30) + ms(50), 10).is_some());
        assert_eq!(gate.request("A", t + Duration::from_secs(31), 10, "connect").0, ResetPlan::Send { generation: 6 }, "the normal 0.8 s gap");
    }

    #[test]
    fn a_restarted_session_starts_clean() {
        let mut gate = gate();
        let t = Instant::now();
        sent(gate.request("A", t, 0, "t"));
        gate.forget("A");
        sent(gate.request("A", t + ms(20), 0, "t"));
    }

    #[test]
    fn the_deadline_comes_from_the_environment_within_bounds() {
        assert_eq!(deadline_from(None), DEFAULT_DEADLINE);
        assert_eq!(deadline_from(Some("4500")), ms(4500));
        assert_eq!(deadline_from(Some("10")), MIN_DEADLINE);
        assert_eq!(deadline_from(Some("999999")), MAX_DEADLINE);
        assert_eq!(deadline_from(Some("soon")), DEFAULT_DEADLINE);
    }
}
