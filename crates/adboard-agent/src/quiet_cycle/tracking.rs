//! What has been done for each phone: sound muted once per run, screen set once per phase, and how a round's results are recorded without ever counting a stale one.
use std::collections::HashMap;

/// What has been done for one phone: the run the sound was muted for, and the phase the
/// screen was set for. A phone is finished only when both are current.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Done {
    pub(super) audio: Option<u64>,
    pub(super) screen: Option<u64>,
}

impl Done {
    fn complete(&self, run_id: u64, phase_started: u64) -> bool {
        self.audio == Some(run_id) && self.screen == Some(phase_started)
    }
}

/// Phones that are online and are missing a muted sound or the screen state of this phase.
pub fn pending(
    online: &[String],
    done: &HashMap<String, Done>,
    run_id: u64,
    phase_started: u64,
) -> Vec<String> {
    online
        .iter()
        .filter(|serial| {
            !done
                .get(*serial)
                .copied()
                .unwrap_or_default()
                .complete(run_id, phase_started)
        })
        .cloned()
        .collect()
}

/// For the pending phones: who still needs muting (once per run) and who still needs the
/// screen change for this phase. An operation that already succeeded is not sent again.
pub fn plan(
    pending: &[String],
    done: &HashMap<String, Done>,
    run_id: u64,
    phase_started: u64,
) -> (Vec<String>, Vec<String>) {
    let get = |serial: &String| done.get(serial).copied().unwrap_or_default();
    let audio = pending
        .iter()
        .filter(|s| get(s).audio != Some(run_id))
        .cloned()
        .collect();
    let screen = pending
        .iter()
        .filter(|s| get(s).screen != Some(phase_started))
        .cloned()
        .collect();
    (audio, screen)
}

/// Remember what succeeded for `serial`. `None` means the operation was not tried this time;
/// `Some(false)` is a failure and leaves it pending (an older success is kept).
pub fn record(
    done: &mut HashMap<String, Done>,
    serial: &str,
    run_id: u64,
    phase_started: u64,
    audio: Option<bool>,
    screen: Option<bool>,
) {
    let entry = done.entry(serial.to_string()).or_default();
    if audio == Some(true) {
        entry.audio = Some(run_id);
    }
    if screen == Some(true) {
        entry.screen = Some(phase_started);
    }
}

/// Record the outcome of one round, ignoring what is stale: a phone whose connection
/// generation changed while its operations were running (it reconnected) is skipped, and a
/// screen result only counts for the phase it was sent for. Sound is per run (the caller has
/// checked the run is the same).
#[allow(clippy::too_many_arguments)]
pub fn settle(
    done: &mut HashMap<String, Done>,
    gens_then: &HashMap<String, u64>,
    gens_now: &HashMap<String, u64>,
    run_id: u64,
    phase_started_then: u64,
    phase_started_now: u64,
    audio_out: &HashMap<String, bool>,
    screen_out: &HashMap<String, bool>,
) {
    let mut serials: Vec<&String> = audio_out.keys().chain(screen_out.keys()).collect();
    serials.sort();
    serials.dedup();
    for serial in serials {
        if gens_then.get(serial) != gens_now.get(serial) {
            continue;
        }
        let screen = if phase_started_then == phase_started_now {
            screen_out.get(serial).copied()
        } else {
            None
        };
        record(
            done,
            serial,
            run_id,
            phase_started_then,
            audio_out.get(serial).copied(),
            screen,
        );
    }
}
