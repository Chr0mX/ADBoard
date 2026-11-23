//! Retry delays that grow while something stays away, with jitter so many clients do not
//! knock at the same instant. Same rule as the browser's (`src/lib/api/reconnect-core.ts`):
//! the ceiling grows by half each try up to a maximum, and the delay is between half and all of it.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone)]
pub struct Backoff {
    base: Duration,
    max: Duration,
    attempt: u32,
}

impl Backoff {
    pub fn new(base: Duration, max: Duration) -> Self {
        Backoff {
            base,
            max,
            attempt: 0,
        }
    }

    /// The next delay, for a `jitter` in `0.0..=1.0` (so tests can choose it).
    pub fn next_with(&mut self, jitter: f64) -> Duration {
        let ceiling = self
            .base
            .mul_f64(1.5f64.powi(self.attempt.min(30) as i32))
            .min(self.max);
        self.attempt = (self.attempt + 1).min(30);
        let jitter = jitter.clamp(0.0, 1.0);
        ceiling.mul_f64(0.5 + 0.5 * jitter)
    }

    pub fn next_delay(&mut self) -> Duration {
        self.next_with(random_fraction())
    }

    /// The connection worked: start from the short delay again.
    pub fn reset(&mut self) {
        self.attempt = 0;
    }

    #[cfg(test)]
    pub fn attempts(&self) -> u32 {
        self.attempt
    }
}

/// A cheap, dependency-free value in `0.0..1.0` that differs between processes and calls
/// (clock nanoseconds mixed with a counter, then scrambled). Not for security.
pub fn random_fraction() -> f64 {
    static COUNTER: AtomicU64 = AtomicU64::new(0x9E37_79B9_7F4A_7C15);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let mut x = nanos
        ^ COUNTER.fetch_add(0x9E37_79B9_7F4A_7C15, Ordering::Relaxed)
        ^ u64::from(std::process::id()).rotate_left(32);
    x ^= x >> 33;
    x = x.wrapping_mul(0xff51_afd7_ed55_8ccd);
    x ^= x >> 33;
    x = x.wrapping_mul(0xc4ce_b9fe_1a85_ec53);
    x ^= x >> 33;
    (x >> 11) as f64 / (1u64 << 53) as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delays_grow_to_the_maximum_and_reset() {
        let mut b = Backoff::new(Duration::from_secs(1), Duration::from_secs(30));
        let seq: Vec<u64> = (0..12)
            .map(|_| b.next_with(1.0).as_millis() as u64)
            .collect();
        assert_eq!(seq[0], 1000);
        assert_eq!(seq[1], 1500);
        assert!(
            seq.windows(2).all(|w| w[1] >= w[0]),
            "never shorter than before: {seq:?}"
        );
        assert_eq!(*seq.last().unwrap(), 30_000, "capped");
        b.reset();
        assert_eq!(
            b.next_with(1.0),
            Duration::from_secs(1),
            "a success starts again from the short delay"
        );
    }

    #[test]
    fn jitter_spreads_the_delay_between_half_and_all_of_the_ceiling() {
        let mut low = Backoff::new(Duration::from_secs(4), Duration::from_secs(60));
        let mut high = low.clone();
        assert_eq!(low.next_with(0.0), Duration::from_secs(2));
        assert_eq!(high.next_with(1.0), Duration::from_secs(4));
        assert_eq!(
            Backoff::new(Duration::from_secs(4), Duration::from_secs(60)).next_with(7.0),
            Duration::from_secs(4),
            "out of range is clamped"
        );
    }

    #[test]
    fn many_agents_do_not_retry_in_lockstep() {
        let delays: std::collections::HashSet<u64> = (0..50)
            .map(|_| {
                Backoff::new(Duration::from_secs(2), Duration::from_secs(60))
                    .next_delay()
                    .as_millis() as u64
            })
            .collect();
        assert!(
            delays.len() > 25,
            "50 agents drew only {} different first delays",
            delays.len()
        );
        for d in &delays {
            assert!((1000..=2000).contains(d));
        }
    }

    #[test]
    fn the_random_fraction_stays_in_range() {
        for _ in 0..1000 {
            let f = random_fraction();
            assert!((0.0..1.0).contains(&f));
        }
    }
}
