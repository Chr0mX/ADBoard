//! Keeps keyframe requests from piling up on one phone.
//!
//! A keyframe is asked for by scrcpy's `RESET_VIDEO`, which makes the encoder start over. Every viewer
//! asks on its own: each browser tab when it connects, again when it falls behind or comes back to the
//! foreground, and a hidden stream at one frame a second asks every second. With several viewers that
//! was a reset every few hundred milliseconds, which stalls the picture for all of them.
//!
//! The first request goes out at once. Others within `gap` of it are folded into one request sent when
//! the gap ends, so every asker still gets a keyframe that was produced after it asked.
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

/// Closest two resets of the same phone are sent.
pub(super) const RESET_GAP: Duration = Duration::from_millis(800);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ResetPlan {
    /// Send it now.
    Now,
    /// Send one after this long (it also serves anyone who asks before then).
    After(Duration),
    /// A request is already waiting to be sent after this one; nothing more to do.
    Covered,
}

pub(super) struct ResetGate {
    gap: Duration,
    last_sent: HashMap<String, Instant>,
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

    pub(super) fn request(&mut self, serial: &str, now: Instant) -> ResetPlan {
        if self.waiting.contains(serial) {
            return ResetPlan::Covered;
        }
        match self.last_sent.get(serial) {
            Some(previous) if now.saturating_duration_since(*previous) < self.gap => {
                self.waiting.insert(serial.to_string());
                ResetPlan::After(self.gap - now.saturating_duration_since(*previous))
            }
            _ => {
                self.last_sent.insert(serial.to_string(), now);
                ResetPlan::Now
            }
        }
    }

    /// The waiting request was sent (or failed): the next one starts the gap again from `now`.
    pub(super) fn sent(&mut self, serial: &str, now: Instant) {
        self.waiting.remove(serial);
        self.last_sent.insert(serial.to_string(), now);
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

    #[test]
    fn the_first_request_goes_out_at_once() {
        let mut gate = gate();
        assert_eq!(gate.request("A", Instant::now()), ResetPlan::Now);
    }

    #[test]
    fn a_burst_becomes_one_request_after_the_gap() {
        let mut gate = gate();
        let t = Instant::now();
        assert_eq!(gate.request("A", t), ResetPlan::Now);
        // Three more viewers ask within the gap.
        assert_eq!(
            gate.request("A", t + Duration::from_millis(100)),
            ResetPlan::After(Duration::from_millis(700))
        );
        assert_eq!(
            gate.request("A", t + Duration::from_millis(300)),
            ResetPlan::Covered
        );
        assert_eq!(
            gate.request("A", t + Duration::from_millis(500)),
            ResetPlan::Covered
        );
        // The waiting request goes out; the gap starts again from then.
        gate.sent("A", t + Duration::from_millis(800));
        assert_eq!(
            gate.request("A", t + Duration::from_millis(900)),
            ResetPlan::After(Duration::from_millis(700))
        );
    }

    #[test]
    fn a_request_after_the_gap_is_not_held_back() {
        let mut gate = gate();
        let t = Instant::now();
        assert_eq!(gate.request("A", t), ResetPlan::Now);
        assert_eq!(
            gate.request("A", t + Duration::from_millis(800)),
            ResetPlan::Now
        );
        assert_eq!(
            gate.request("A", t + Duration::from_secs(30)),
            ResetPlan::Now
        );
    }

    #[test]
    fn one_phone_never_delays_another() {
        let mut gate = gate();
        let t = Instant::now();
        assert_eq!(gate.request("A", t), ResetPlan::Now);
        assert_eq!(
            gate.request("B", t + Duration::from_millis(10)),
            ResetPlan::Now
        );
        assert_eq!(
            gate.request("A", t + Duration::from_millis(20)),
            ResetPlan::After(Duration::from_millis(780))
        );
        assert_eq!(
            gate.request("B", t + Duration::from_millis(30)),
            ResetPlan::After(Duration::from_millis(780))
        );
    }

    #[test]
    fn a_restarted_session_starts_clean() {
        let mut gate = gate();
        let t = Instant::now();
        gate.request("A", t);
        gate.request("A", t + Duration::from_millis(10));
        gate.forget("A");
        assert_eq!(
            gate.request("A", t + Duration::from_millis(20)),
            ResetPlan::Now
        );
    }
}
