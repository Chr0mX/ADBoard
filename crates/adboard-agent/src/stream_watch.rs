//! Restarting a phone's encoder when input gets no pictures.
//!
//! A phone's video can stop while its control channel keeps working: touches still reach the phone, but the
//! encoder (Android's MediaCodec inside scrcpy-server) produces nothing more and the page shows the last
//! picture for ever. Nothing on the socket looks wrong: the heartbeat goes on and a still screen legitimately
//! sends no frames. Input is what tells the two apart: a touch, key or text normally changes the screen, so
//! pictures must follow it.
//!
//! When input was sent and no access unit came out for `NO_FRAMES_AFTER_INPUT`, the encoder is asked for a
//! keyframe (scrcpy `RESET_VIDEO`, which also restarts it). If that brings nothing within
//! `RESTART_AFTER_RESET`, the phone's stream is restarted, at most once per `RESTART_EVERY`. Each input is
//! handled once: a phone that stays dark (locked, screen off) is not restarted again until new input comes.
//!
//! The decision is a pure function (`step`), tested below; `spawn` runs it once a second for every phone
//! someone is watching.
use std::collections::HashMap;
use std::time::{Duration, Instant};

use tracing::{info, warn};

pub const NO_FRAMES_AFTER_INPUT: Duration = Duration::from_millis(3000);
pub const RESTART_AFTER_RESET: Duration = Duration::from_millis(4000);
pub const RESTART_EVERY: Duration = Duration::from_secs(60);
/// Input older than this is not followed up (the watch was not running, or the phone had no viewer).
pub const INPUT_RELEVANT_FOR: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchAction {
    Nothing,
    AskKeyframe,
    RestartStream,
}

#[derive(Debug, Default, Clone)]
pub struct WatchState {
    /// A keyframe was asked for at this time, when the phone had produced this many frames.
    reset: Option<(Instant, u64)>,
    /// The input already followed up all the way (a restart, or a keyframe that answered it).
    handled_input: Option<Instant>,
    last_restart: Option<Instant>,
}

pub struct Observation {
    /// The phone's stream is a live scrcpy stream with someone watching it.
    pub live: bool,
    pub input_at: Option<Instant>,
    pub frame_at: Option<Instant>,
    pub frames: u64,
}

pub fn step(state: &mut WatchState, now: Instant, seen: &Observation) -> WatchAction {
    if !seen.live {
        state.reset = None;
        return WatchAction::Nothing;
    }
    let Some(input) = seen.input_at else {
        return WatchAction::Nothing;
    };
    if state.handled_input == Some(input) {
        return WatchAction::Nothing;
    }
    if seen.frame_at.is_some_and(|frame| frame >= input) {
        // Pictures followed the input: the encoder is working.
        state.reset = None;
        return WatchAction::Nothing;
    }
    let since_input = now.saturating_duration_since(input);
    if since_input > INPUT_RELEVANT_FOR && state.reset.is_none() {
        state.handled_input = Some(input);
        return WatchAction::Nothing;
    }
    match state.reset {
        None => {
            if since_input >= NO_FRAMES_AFTER_INPUT {
                state.reset = Some((now, seen.frames));
                return WatchAction::AskKeyframe;
            }
            WatchAction::Nothing
        }
        Some((asked_at, frames_then)) => {
            if seen.frames > frames_then {
                // The keyframe came (frames moved even if `frame_at` raced the input): answered.
                state.reset = None;
                state.handled_input = Some(input);
                return WatchAction::Nothing;
            }
            if now.saturating_duration_since(asked_at) < RESTART_AFTER_RESET {
                return WatchAction::Nothing;
            }
            state.reset = None;
            state.handled_input = Some(input);
            if state.last_restart.is_none_or(|at| now.saturating_duration_since(at) >= RESTART_EVERY) {
                state.last_restart = Some(now);
                WatchAction::RestartStream
            } else {
                WatchAction::Nothing
            }
        }
    }
}

/// Run the watch once a second for every watched phone.
pub fn spawn(state: crate::device_manager::AppState) {
    tokio::spawn(async move {
        let mut book: HashMap<String, WatchState> = HashMap::new();
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            let hub = state.video_hub();
            let watched = hub.watched_serials().await;
            book.retain(|serial, _| watched.contains(serial));
            for serial in watched {
                let stats = hub.source_stats(&serial).await;
                let live = match state.inner.sessions.get_session(&serial).await {
                    Some(session) => {
                        session.stream == adboard_protocol::StreamState::Streaming && session.backend == "scrcpy"
                    }
                    None => false,
                };
                let seen = Observation { live, input_at: stats.input_at, frame_at: stats.frame_at, frames: stats.frames };
                let entry = book.entry(serial.clone()).or_default();
                match step(entry, Instant::now(), &seen) {
                    WatchAction::Nothing => {}
                    WatchAction::AskKeyframe => {
                        info!(%serial, frames = stats.frames, last_frame_ago_ms = stats.idle.map(|d| d.as_millis() as u64), "input got no pictures: asking the encoder for a keyframe");
                        let sessions = state.inner.sessions.clone();
                        tokio::spawn(async move {
                            let _ = sessions.reset_video_for(&serial, "input-no-frames").await;
                        });
                    }
                    WatchAction::RestartStream => {
                        warn!(%serial, frames = stats.frames, last_frame_ago_ms = stats.idle.map(|d| d.as_millis() as u64), "video stopped while input still reaches the phone: restarting its stream");
                        let state = state.clone();
                        tokio::spawn(async move {
                            match state.restart_session(&serial).await {
                                Ok(session) => state.publish(adboard_protocol::ServerEvent::SessionUpdated { session }),
                                Err(error) => warn!(%serial, %error, "could not restart the stalled stream"),
                            }
                        });
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seen(live: bool, input_at: Option<Instant>, frame_at: Option<Instant>, frames: u64) -> Observation {
        Observation { live, input_at, frame_at, frames }
    }

    #[test]
    fn pictures_after_input_need_nothing() {
        let t = Instant::now();
        let mut st = WatchState::default();
        let ms = Duration::from_millis;
        let obs = seen(true, Some(t), Some(t + ms(40)), 10);
        assert_eq!(step(&mut st, t + ms(5000), &obs), WatchAction::Nothing);
    }

    #[test]
    fn a_still_screen_without_input_needs_nothing() {
        let t = Instant::now();
        let mut st = WatchState::default();
        let obs = seen(true, None, Some(t), 10);
        assert_eq!(step(&mut st, t + Duration::from_secs(120), &obs), WatchAction::Nothing);
    }

    #[test]
    fn input_without_pictures_asks_then_restarts_once() {
        let t = Instant::now();
        let ms = Duration::from_millis;
        let mut st = WatchState::default();
        let frame = Some(t);
        let input = Some(t + ms(1000));
        let obs = seen(true, input, frame, 50);
        assert_eq!(step(&mut st, t + ms(3000), &obs), WatchAction::Nothing, "too soon");
        assert_eq!(step(&mut st, t + ms(4000), &obs), WatchAction::AskKeyframe);
        assert_eq!(step(&mut st, t + ms(6000), &obs), WatchAction::Nothing, "waiting for the keyframe");
        assert_eq!(step(&mut st, t + ms(8000), &obs), WatchAction::RestartStream);
        // The same input is never followed up again: a phone that stays dark is not restarted in a loop.
        for s in 9..40 {
            assert_eq!(step(&mut st, t + Duration::from_secs(s), &obs), WatchAction::Nothing);
        }
    }

    #[test]
    fn a_keyframe_that_answers_ends_the_follow_up() {
        let t = Instant::now();
        let ms = Duration::from_millis;
        let mut st = WatchState::default();
        let input = Some(t + ms(1000));
        assert_eq!(step(&mut st, t + ms(4000), &seen(true, input, Some(t), 50)), WatchAction::AskKeyframe);
        assert_eq!(step(&mut st, t + ms(5000), &seen(true, input, Some(t + ms(4800)), 51)), WatchAction::Nothing);
        assert_eq!(step(&mut st, t + ms(9000), &seen(true, input, Some(t + ms(4800)), 51)), WatchAction::Nothing);
    }

    #[test]
    fn restarts_are_spaced_out() {
        let t = Instant::now();
        let s = Duration::from_secs;
        let mut st = WatchState::default();
        let first = Some(t + s(1));
        assert_eq!(step(&mut st, t + s(4), &seen(true, first, Some(t), 5)), WatchAction::AskKeyframe);
        assert_eq!(step(&mut st, t + s(8), &seen(true, first, Some(t), 5)), WatchAction::RestartStream);
        // New input 10 s later, still nothing: a keyframe is asked, but the restart waits for RESTART_EVERY.
        let second = Some(t + s(20));
        assert_eq!(step(&mut st, t + s(23), &seen(true, second, Some(t), 5)), WatchAction::AskKeyframe);
        assert_eq!(step(&mut st, t + s(27), &seen(true, second, Some(t), 5)), WatchAction::Nothing);
        let third = Some(t + s(70));
        assert_eq!(step(&mut st, t + s(73), &seen(true, third, Some(t), 5)), WatchAction::AskKeyframe);
        assert_eq!(step(&mut st, t + s(77), &seen(true, third, Some(t), 5)), WatchAction::RestartStream);
    }

    #[test]
    fn a_stream_that_is_not_live_is_left_alone() {
        let t = Instant::now();
        let mut st = WatchState::default();
        let obs = seen(false, Some(t + Duration::from_secs(1)), Some(t), 5);
        assert_eq!(step(&mut st, t + Duration::from_secs(10), &obs), WatchAction::Nothing);
    }

    #[test]
    fn old_input_is_not_followed_up() {
        let t = Instant::now();
        let mut st = WatchState::default();
        let obs = seen(true, Some(t), None, 0);
        assert_eq!(step(&mut st, t + Duration::from_secs(45), &obs), WatchAction::Nothing);
        assert_eq!(step(&mut st, t + Duration::from_secs(50), &obs), WatchAction::Nothing);
    }
}
