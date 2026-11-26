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
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

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
}

impl ResetGate {
    pub(super) fn new(gap: Duration) -> Self {
        Self {
            gap,
            last_sent: HashMap::new(),
            waiting: HashSet::new(),
        }
    }

    /// `keyframes`: how many keyframes the phone's stream has carried right now.
    pub(super) fn request(&mut self, serial: &str, now: Instant, keyframes: u64) -> ResetPlan {
        if self.waiting.contains(serial) {
            return ResetPlan::Covered;
        }
        match self.last_sent.get(serial).copied() {
            Some(previous) if now.saturating_duration_since(previous.at) < self.gap => {
                if keyframes == previous.keyframes {
                    // Sent, and the keyframe it asks for has not come out yet: this asker gets it too.
                    ResetPlan::Covered
                } else {
                    // That keyframe has already gone by: this asker needs its own, once the gap is over.
                    self.waiting.insert(serial.to_string());
                    ResetPlan::After(self.gap - now.saturating_duration_since(previous.at))
                }
            }
            _ => {
                self.last_sent
                    .insert(serial.to_string(), Sent { at: now, keyframes });
                ResetPlan::Now
            }
        }
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
        assert_eq!(gate.request("A", Instant::now(), 0), ResetPlan::Now);
    }

    #[test]
    fn a_request_before_the_keyframe_it_follows_is_out_rides_on_it() {
        let mut gate = gate();
        let t = Instant::now();
        assert_eq!(gate.request("A", t, 3), ResetPlan::Now);
        // The same viewer's second ask (the agent on connect, then the page), and a second tab's. However slow
        // the encoder is, none of them needs another reset until a keyframe has actually come out.
        assert_eq!(gate.request("A", t + ms(10), 3), ResetPlan::Covered);
        assert_eq!(gate.request("A", t + ms(250), 3), ResetPlan::Covered);
        assert_eq!(gate.request("A", t + ms(700), 3), ResetPlan::Covered);
    }

    #[test]
    fn a_request_after_that_keyframe_went_out_gets_its_own_once_the_gap_is_over() {
        let mut gate = gate();
        let t = Instant::now();
        assert_eq!(gate.request("A", t, 3), ResetPlan::Now);
        // The keyframe came out (count 3 -> 4) 120 ms later; a viewer that joined after it still needs one.
        assert_eq!(gate.request("A", t + ms(200), 4), ResetPlan::After(ms(600)));
        assert_eq!(gate.request("A", t + ms(300), 4), ResetPlan::Covered);
        gate.sent("A", t + ms(800), 4);
        // The new gap starts at 800 ms; its keyframe has not come out yet.
        assert_eq!(gate.request("A", t + ms(900), 4), ResetPlan::Covered);
        assert_eq!(
            gate.request("A", t + ms(1000), 5),
            ResetPlan::After(ms(600))
        );
    }

    #[test]
    fn a_reset_that_never_produced_a_keyframe_is_not_waited_on_forever() {
        let mut gate = gate();
        let t = Instant::now();
        assert_eq!(gate.request("A", t, 3), ResetPlan::Now);
        assert_eq!(gate.request("A", t + ms(500), 3), ResetPlan::Covered);
        // Past the gap with still no keyframe: ask again.
        assert_eq!(gate.request("A", t + ms(800), 3), ResetPlan::Now);
    }

    #[test]
    fn a_request_after_the_gap_is_not_held_back() {
        let mut gate = gate();
        let t = Instant::now();
        assert_eq!(gate.request("A", t, 0), ResetPlan::Now);
        assert_eq!(gate.request("A", t + ms(800), 1), ResetPlan::Now);
        assert_eq!(
            gate.request("A", t + Duration::from_secs(30), 9),
            ResetPlan::Now
        );
    }

    #[test]
    fn one_phone_never_delays_another() {
        let mut gate = gate();
        let t = Instant::now();
        assert_eq!(gate.request("A", t, 0), ResetPlan::Now);
        assert_eq!(gate.request("B", t + ms(10), 0), ResetPlan::Now);
        assert_eq!(gate.request("A", t + ms(20), 0), ResetPlan::Covered);
        assert_eq!(gate.request("B", t + ms(400), 1), ResetPlan::After(ms(410)));
        assert_eq!(gate.request("A", t + ms(500), 0), ResetPlan::Covered);
    }

    #[test]
    fn a_restarted_session_starts_clean() {
        let mut gate = gate();
        let t = Instant::now();
        gate.request("A", t, 0);
        gate.request("A", t + ms(10), 1);
        gate.forget("A");
        assert_eq!(gate.request("A", t + ms(20), 0), ResetPlan::Now);
    }
}
