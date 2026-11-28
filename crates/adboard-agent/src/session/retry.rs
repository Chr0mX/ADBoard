//! Trying again when a phone's stream failed to start.
//!
//! A start can fail for reasons that pass: the phone was busy, adb was restarting, a server from an earlier
//! run still held the socket. Until now nothing retried it: the session stayed in Error while the page's
//! socket sat open waiting for a picture that would never come. The reaper now asks this book which failed
//! phones are due a retry: slowly (growing delays, capped), and only while someone is watching.
use std::collections::HashMap;
use std::time::{Duration, Instant};

/// Delay before retry number `attempt` (0 is the first retry): 3, 6, 12, 24 s, then 30 s.
pub fn delay_for(attempt: u32) -> Duration {
    let secs = 3u64.saturating_mul(1u64 << attempt.min(5));
    Duration::from_secs(secs.min(30))
}

struct Entry {
    attempts: u32,
    next_at: Instant,
}

#[derive(Default)]
pub struct RetryBook {
    entries: HashMap<String, Entry>,
}

impl RetryBook {
    pub fn new() -> Self {
        Self::default()
    }

    /// `failed`: phones whose start failed and that are worth retrying now (online, watched). `pending`: every
    /// phone still carrying a failed start, including one being retried at this moment; a phone leaves the book
    /// only when its start succeeded (it is no longer pending), so a retry in progress keeps its attempt count.
    /// Returns the phones to restart now, with the number of this retry (1 for the first).
    pub fn due(&mut self, failed: &[String], pending: &[String], now: Instant) -> Vec<(String, u32)> {
        self.entries.retain(|serial, _| pending.contains(serial));
        let mut out = Vec::new();
        for serial in failed {
            let entry = self.entries.entry(serial.clone()).or_insert_with(|| Entry {
                attempts: 0,
                next_at: now + delay_for(0),
            });
            if now >= entry.next_at {
                entry.attempts += 1;
                entry.next_at = now + delay_for(entry.attempts);
                out.push((serial.clone(), entry.attempts));
            }
        }
        out
    }

    /// When the next retry of `serial` is due, if it is being tracked.
    pub fn next_in(&self, serial: &str, now: Instant) -> Option<Duration> {
        self.entries.get(serial).map(|e| e.next_at.saturating_duration_since(now))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(name: &str) -> String {
        name.to_string()
    }

    #[test]
    fn delays_grow_and_stop_at_thirty_seconds() {
        let secs: Vec<u64> = (0..8).map(|n| delay_for(n).as_secs()).collect();
        assert_eq!(secs, vec![3, 6, 12, 24, 30, 30, 30, 30]);
        assert_eq!(delay_for(u32::MAX).as_secs(), 30, "no overflow");
    }

    #[test]
    fn a_failed_start_is_retried_after_the_first_delay_and_then_more_slowly() {
        let mut book = RetryBook::new();
        let t = Instant::now();
        let failed = vec![s("A")];
        assert!(book.due(&failed, &failed, t).is_empty(), "first seen: wait the first delay");
        assert!(book.due(&failed, &failed, t + Duration::from_secs(2)).is_empty());
        assert_eq!(book.due(&failed, &failed, t + Duration::from_secs(3)), vec![(s("A"), 1)]);
        // That retry is running: the phone is pending but not failed. Its count must survive that.
        let pending = vec![s("A")];
        assert!(book.due(&[], &pending, t + Duration::from_secs(5)).is_empty());
        // It failed again: the next retry waits 6 s from the last one, and is number 2.
        assert!(book.due(&failed, &failed, t + Duration::from_secs(8)).is_empty());
        assert_eq!(book.due(&failed, &failed, t + Duration::from_secs(9)), vec![(s("A"), 2)]);
        assert_eq!(book.due(&failed, &failed, t + Duration::from_secs(21)), vec![(s("A"), 3)], "12 s later");
    }

    #[test]
    fn a_phone_whose_start_succeeded_starts_over_next_time() {
        let mut book = RetryBook::new();
        let t = Instant::now();
        let failed = vec![s("A")];
        book.due(&failed, &failed, t);
        assert_eq!(book.due(&failed, &failed, t + Duration::from_secs(3)).len(), 1);
        // It started: nothing is pending any more, so the book forgets it.
        assert!(book.due(&[], &[], t + Duration::from_secs(4)).is_empty());
        assert!(book.next_in("A", t + Duration::from_secs(4)).is_none());
        // A later failure begins again with the short delay.
        assert!(book.due(&failed, &failed, t + Duration::from_secs(100)).is_empty());
        assert_eq!(book.due(&failed, &failed, t + Duration::from_secs(103)), vec![(s("A"), 1)]);
    }

    #[test]
    fn phones_are_independent_and_unwatched_ones_are_not_retried() {
        let mut book = RetryBook::new();
        let t = Instant::now();
        let pending = vec![s("A"), s("B")];
        // B has no viewer (not in `failed`): it is kept in the book but never retried.
        let failed = vec![s("A")];
        book.due(&failed, &pending, t);
        let due = book.due(&failed, &pending, t + Duration::from_secs(3));
        assert_eq!(due, vec![(s("A"), 1)], "only the watched phone is retried");
    }
}
