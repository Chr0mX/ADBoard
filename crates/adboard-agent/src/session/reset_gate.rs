//! Keeps keyframe requests from piling up on one phone.
//!
//! A keyframe is asked for by scrcpy's `RESET_VIDEO`, which makes the encoder start over. Every viewer
//! asks on its own: each browser tab when it connects, again when it falls behind or comes back to the
//! foreground, and a hidden stream at one frame a second asks every second. With several viewers that
//! was a reset every few hundred milliseconds, which stalls the picture for all of them.
//!
//! The first request goes out at once. While its keyframe has not been produced yet, a request that
//! follows rides on it: every viewer subscribed by then receives it. Once that keyframe has gone out, a
//! request inside the gap is held and sent when the gap ends, so the asker still gets a keyframe that was
//! produced after it asked. The gate watches the phone's keyframe count to tell the two apart, not a
//! guessed delay.
use std::collections::{HashMap, HashSet, VecDeque};
use std::time::{Duration, Instant};

/// Resets sent in this long are counted for the brake.
pub(super) const BRAKE_WINDOW: Duration = Duration::from_secs(10);
/// This many resets of one phone inside `BRAKE_WINDOW` is a storm: every restart of the encoder makes the
/// next keyframe a burst of data, which on a slow decoder or link makes another viewer fall behind and ask.
pub(super) const BRAKE_AFTER: usize = 4;
/// While the brake is on, resets of that phone go out no closer than this.
pub(super) const BRAKE_GAP: Duration = Duration::from_secs(4);
/// Closest two resets of the same phone are sent. Also how long a reset that never produced a keyframe
/// counts as pending.
pub(super) const RESET_GAP: Duration = Duration::from_millis(800);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ResetPlan {
    /// Send it now.
    Now,
    /// Send one after this long (it also serves anyone who asks before then).
    After(Duration),
    /// A reset is already on its way (sent, keyframe not produced yet, or waiting to be sent): nothing to do.
    Covered,
}

#[derive(Clone, Copy)]
struct Sent {
    at: Instant,
    /// The phone's keyframe count when it was sent.
    keyframes: u64,
}

pub(super) struct ResetGate {
    gap: Duration,
    last_sent: HashMap<String, Sent>,
    waiting: HashSet<String>,
    /// When resets of each phone were sent, and who asked for each request, inside `BRAKE_WINDOW`.
    sent_times: HashMap<String, VecDeque<Instant>>,
    asked: HashMap<String, VecDeque<(Instant, String)>>,
    /// Phones whose storm brake is on and already reported.
    braking: HashSet<String>,
}

impl ResetGate {
    pub(super) fn new(gap: Duration) -> Self {
        Self {
            gap,
            last_sent: HashMap::new(),
            waiting: HashSet::new(),
            sent_times: HashMap::new(),
            asked: HashMap::new(),
            braking: HashSet::new(),
        }
    }

    /// The gap in force for `serial`: normal, or the brake's when too many resets went out lately.
    fn gap_for(&mut self, serial: &str, now: Instant) -> Duration {
        let times = self.sent_times.entry(serial.to_string()).or_default();
        while times.front().is_some_and(|t| now.saturating_duration_since(*t) > BRAKE_WINDOW) {
            times.pop_front();
        }
        if times.len() >= BRAKE_AFTER {
            self.gap.max(BRAKE_GAP)
        } else {
            self.braking.remove(serial);
            self.gap
        }
    }

    /// `keyframes`: how many keyframes the phone's stream has carried right now. `reason`: who is asking.
    pub(super) fn request(&mut self, serial: &str, now: Instant, keyframes: u64, reason: &str) -> ResetPlan {
        let asks = self.asked.entry(serial.to_string()).or_default();
        asks.push_back((now, reason.to_string()));
        while asks.front().is_some_and(|(t, _)| now.saturating_duration_since(*t) > BRAKE_WINDOW) {
            asks.pop_front();
        }
        let gap = self.gap_for(serial, now);
        if self.waiting.contains(serial) {
            return ResetPlan::Covered;
        }
        match self.last_sent.get(serial).copied() {
            Some(previous) if now.saturating_duration_since(previous.at) < gap => {
                if keyframes == previous.keyframes && gap == self.gap {
                    // Sent, and the keyframe it asks for has not come out yet: this asker gets it too.
                    ResetPlan::Covered
                } else if keyframes == previous.keyframes {
                    // Braking: even a keyframe that is on its way is not worth another reset yet.
                    ResetPlan::Covered
                } else {
                    // That keyframe has already gone by: this asker needs its own, once the gap is over.
                    self.waiting.insert(serial.to_string());
                    ResetPlan::After(gap - now.saturating_duration_since(previous.at))
                }
            }
            _ => {
                self.record_sent(serial, now, keyframes);
                ResetPlan::Now
            }
        }
    }

    fn record_sent(&mut self, serial: &str, now: Instant, keyframes: u64) {
        self.last_sent.insert(serial.to_string(), Sent { at: now, keyframes });
        self.sent_times.entry(serial.to_string()).or_default().push_back(now);
    }

    /// Once per storm: what is asking for so many keyframes of this phone, to put in the log.
    pub(super) fn brake_report(&mut self, serial: &str, now: Instant) -> Option<String> {
        let sent = self.sent_times.get(serial).map_or(0, |t| t.len());
        if sent < BRAKE_AFTER || self.braking.contains(serial) {
            return None;
        }
        self.braking.insert(serial.to_string());
        let mut by_reason: Vec<(String, usize)> = Vec::new();
        for (at, reason) in self.asked.get(serial).into_iter().flatten() {
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

    /// A reset was sent (the waiting one, or one sent outside the gate): the next one starts the gap from `now`.
    pub(super) fn sent(&mut self, serial: &str, now: Instant, keyframes: u64) {
        self.waiting.remove(serial);
        self.last_sent
            .insert(serial.to_string(), Sent { at: now, keyframes });
    }

    pub(super) fn forget(&mut self, serial: &str) {
        self.waiting.remove(serial);
        self.last_sent.remove(serial);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gate() -> ResetGate {
        ResetGate::new(Duration::from_millis(800))
    }

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    #[test]
    fn the_first_request_goes_out_at_once() {
        let mut gate = gate();
        assert_eq!(gate.request("A", Instant::now(), 0, "t"), ResetPlan::Now);
    }

    #[test]
    fn a_request_before_the_keyframe_it_follows_is_out_rides_on_it() {
        let mut gate = gate();
        let t = Instant::now();
        assert_eq!(gate.request("A", t, 3, "t"), ResetPlan::Now);
        // The same viewer's second ask (the agent on connect, then the page), and a second tab's. However slow
        // the encoder is, none of them needs another reset until a keyframe has actually come out.
        assert_eq!(gate.request("A", t + ms(10), 3, "t"), ResetPlan::Covered);
        assert_eq!(gate.request("A", t + ms(250), 3, "t"), ResetPlan::Covered);
        assert_eq!(gate.request("A", t + ms(700), 3, "t"), ResetPlan::Covered);
    }

    #[test]
    fn a_request_after_that_keyframe_went_out_gets_its_own_once_the_gap_is_over() {
        let mut gate = gate();
        let t = Instant::now();
        assert_eq!(gate.request("A", t, 3, "t"), ResetPlan::Now);
        // The keyframe came out (count 3 -> 4) 120 ms later; a viewer that joined after it still needs one.
        assert_eq!(gate.request("A", t + ms(200), 4, "t"), ResetPlan::After(ms(600)));
        assert_eq!(gate.request("A", t + ms(300), 4, "t"), ResetPlan::Covered);
        gate.sent("A", t + ms(800), 4);
        // The new gap starts at 800 ms; its keyframe has not come out yet.
        assert_eq!(gate.request("A", t + ms(900), 4, "t"), ResetPlan::Covered);
        assert_eq!(
            gate.request("A", t + ms(1000), 5, "t"),
            ResetPlan::After(ms(600))
        );
    }

    #[test]
    fn a_reset_that_never_produced_a_keyframe_is_not_waited_on_forever() {
        let mut gate = gate();
        let t = Instant::now();
        assert_eq!(gate.request("A", t, 3, "t"), ResetPlan::Now);
        assert_eq!(gate.request("A", t + ms(500), 3, "t"), ResetPlan::Covered);
        // Past the gap with still no keyframe: ask again.
        assert_eq!(gate.request("A", t + ms(800), 3, "t"), ResetPlan::Now);
    }

    #[test]
    fn a_request_after_the_gap_is_not_held_back() {
        let mut gate = gate();
        let t = Instant::now();
        assert_eq!(gate.request("A", t, 0, "t"), ResetPlan::Now);
        assert_eq!(gate.request("A", t + ms(800), 1, "t"), ResetPlan::Now);
        assert_eq!(
            gate.request("A", t + Duration::from_secs(30), 9, "t"),
            ResetPlan::Now
        );
    }

    #[test]
    fn one_phone_never_delays_another() {
        let mut gate = gate();
        let t = Instant::now();
        assert_eq!(gate.request("A", t, 0, "t"), ResetPlan::Now);
        assert_eq!(gate.request("B", t + ms(10), 0, "t"), ResetPlan::Now);
        assert_eq!(gate.request("A", t + ms(20), 0, "t"), ResetPlan::Covered);
        assert_eq!(gate.request("B", t + ms(400), 1, "t"), ResetPlan::After(ms(410)));
        assert_eq!(gate.request("A", t + ms(500), 0, "t"), ResetPlan::Covered);
    }

    #[test]
    fn a_storm_of_resets_is_slowed_and_the_report_names_who_asked() {
        let mut gate = gate();
        let t = Instant::now();
        // Four resets go out inside ten seconds (each after the previous keyframe came out).
        for (i, at) in [0u64, 900, 1800, 2700].into_iter().enumerate() {
            let reason = if i % 2 == 0 { "decode-backlog" } else { "view-change" };
            assert_eq!(gate.request("A", t + ms(at), i as u64, reason), ResetPlan::Now);
        }
        assert!(gate.brake_report("A", t + ms(2700)).is_some_and(|m| m.contains("decode-backlog x2") && m.contains("view-change x2")));
        assert!(gate.brake_report("A", t + ms(2800)).is_none(), "reported once per storm");
        // The brake is on: a request 1 s after the last send is held until 4 s have passed.
        assert_eq!(gate.request("A", t + ms(3700), 4, "decode-backlog"), ResetPlan::After(ms(3000)));
        gate.sent("A", t + ms(6700), 4); // the held request goes out
        // Another phone is not slowed.
        assert_eq!(gate.request("B", t + ms(3700), 0, "connect"), ResetPlan::Now);
        // Long after the storm the normal gap is back, and a new storm can be reported again.
        assert_eq!(gate.request("A", t + Duration::from_secs(30), 9, "connect"), ResetPlan::Now);
        assert_eq!(gate.request("A", t + Duration::from_secs(31), 10, "connect"), ResetPlan::Now, "the normal 0.8 s gap is back");
    }

    #[test]
    fn a_restarted_session_starts_clean() {
        let mut gate = gate();
        let t = Instant::now();
        gate.request("A", t, 0, "t");
        gate.request("A", t + ms(10), 1, "t");
        gate.forget("A");
        assert_eq!(gate.request("A", t + ms(20), 0, "t"), ResetPlan::Now);
    }
}
