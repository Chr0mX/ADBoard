//! The loop's phases and clock: which phase it is in, how long each lasts, and how long the task sleeps.
use serde::{Deserialize, Serialize};
use std::time::Duration;

pub const DEFAULT_QUIET_SECS: u64 = 3600;
pub const DEFAULT_PEEK_SECS: u64 = 3;
pub const MIN_PEEK_SECS: u64 = 1;
pub const MAX_PEEK_SECS: u64 = 5;
pub(super) const MAX_SECS: u64 = 7 * 24 * 3600;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    /// Screen off, sound muted, for the quiet duration.
    Quiet,
    /// Screen on, sound still muted, for the screen-on duration.
    #[serde(alias = "normal")]
    Peek,
}

impl Phase {
    pub fn other(self) -> Phase {
        match self {
            Phase::Quiet => Phase::Peek,
            Phase::Peek => Phase::Quiet,
        }
    }
}

/// What is saved: the settings and where in the cycle we are (unix milliseconds).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cycle {
    pub enabled: bool,
    /// The quiet duration in seconds (the setting the loop always had).
    pub interval_secs: u64,
    /// The screen-on duration in seconds, 1 to 5.
    #[serde(default = "default_peek")]
    pub peek_secs: u64,
    pub phase: Phase,
    #[serde(default)]
    pub phase_started_ms: u64,
    #[serde(default)]
    pub phase_ends_ms: u64,
    /// When this run of the loop began; sound is muted once per run, not once per phase.
    #[serde(default)]
    pub run_id: u64,
}

fn default_peek() -> u64 {
    DEFAULT_PEEK_SECS
}

impl Default for Cycle {
    fn default() -> Self {
        Cycle {
            enabled: false,
            interval_secs: DEFAULT_QUIET_SECS,
            peek_secs: DEFAULT_PEEK_SECS,
            phase: Phase::Quiet,
            phase_started_ms: 0,
            phase_ends_ms: 0,
            run_id: 0,
        }
    }
}

/// The shortest quiet duration; `ADBOARD_QUIET_MIN_SECS` lowers it for testing.
fn min_secs() -> u64 {
    crate::env::var("QUIET_MIN_SECS")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|n| *n >= 1)
        .unwrap_or(60)
}

pub fn clamp_secs(secs: u64) -> u64 {
    secs.clamp(min_secs(), MAX_SECS)
}

/// A screen-on duration must be 1 to 5 seconds.
pub fn valid_peek(secs: u64) -> bool {
    (MIN_PEEK_SECS..=MAX_PEEK_SECS).contains(&secs)
}

impl Cycle {
    /// How long `phase` lasts, in milliseconds.
    pub fn duration_ms(&self, phase: Phase) -> u64 {
        1000 * match phase {
            Phase::Quiet => self.interval_secs,
            Phase::Peek => self.peek_secs,
        }
    }

    /// Begin the loop at `now_ms`: quiet immediately, for the full quiet duration.
    pub fn started(quiet_secs: u64, peek_secs: u64, now_ms: u64) -> Cycle {
        let mut cycle = Cycle {
            enabled: true,
            interval_secs: clamp_secs(quiet_secs),
            peek_secs: peek_secs.clamp(MIN_PEEK_SECS, MAX_PEEK_SECS),
            phase: Phase::Quiet,
            phase_started_ms: now_ms,
            phase_ends_ms: 0,
            run_id: now_ms,
        };
        cycle.phase_ends_ms = now_ms + cycle.duration_ms(Phase::Quiet);
        cycle
    }

    /// Move to the phase the clock says it is `now_ms`. Each phase starts where the last one
    /// ended (no drift, and the quiet time is never shortened by the screen-on time), and a
    /// long gap (the agent was off) lands in the right phase instead of replaying each flip.
    /// Returns whether it changed.
    pub fn advance(&mut self, now_ms: u64) -> bool {
        if !self.enabled || now_ms < self.phase_ends_ms {
            return false;
        }
        let period = self.duration_ms(Phase::Quiet) + self.duration_ms(Phase::Peek);
        // Whole periods (quiet + screen-on) that passed leave the phase unchanged.
        let skipped = (now_ms - self.phase_ends_ms) / period;
        let mut end = self.phase_ends_ms + skipped * period;
        let mut phase = self.phase;
        while now_ms >= end {
            phase = phase.other();
            end += self.duration_ms(phase);
        }
        self.phase = phase;
        self.phase_ends_ms = end;
        self.phase_started_ms = end - self.duration_ms(phase);
        true
    }
}

/// How long the background task sleeps: until the phase ends (so a 1 to 5 second screen-on
/// phase is not missed), but never longer than the normal check period, and never a busy loop.
pub fn next_wait(enabled: bool, now_ms: u64, phase_ends_ms: u64, tick: Duration) -> Duration {
    if !enabled {
        return tick;
    }
    let until = Duration::from_millis(phase_ends_ms.saturating_sub(now_ms));
    until.min(tick).max(Duration::from_millis(100))
}
