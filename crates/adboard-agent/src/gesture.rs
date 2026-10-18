//! Timed single- and multi-touch gestures for macros.
//!
//! The browser sends a whole gesture (one stroke per finger) and the agent
//! plays it with its own clock. Every finger that goes down is lifted, even
//! when a write fails part-way or the browser disconnects, so a macro cannot
//! leave a touch stuck on the phone.

use adboard_protocol::{GestureStroke, NormalizedPoint, PointerPhase};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

pub const MAX_STROKES: usize = 10;
pub const MAX_POINTS: usize = 256;
pub const MAX_GESTURE_MS: u32 = 120_000;
/// Shortest finger contact. Auto Clicker's tap stroke is 10 ms too.
pub const MIN_STROKE_MS: u32 = 10;
/// Move events along a path, about one per frame.
const MOVE_STEP_MS: u32 = 16;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TouchEvent {
    pub at_ms: u32,
    pub slot: u8,
    pub phase: PointerPhase,
    pub x: f64,
    pub y: f64,
}

fn finite_point(p: &NormalizedPoint) -> bool {
    p.x.is_finite() && p.y.is_finite()
}

fn stroke_ms(stroke: &GestureStroke) -> u32 {
    stroke.duration_ms.max(MIN_STROKE_MS)
}

/// Reject gestures the agent cannot play safely.
pub fn validate(strokes: &[GestureStroke]) -> Result<(), String> {
    if strokes.is_empty() {
        return Err("gesture has no strokes".into());
    }
    if strokes.len() > MAX_STROKES {
        return Err(format!("gesture has more than {MAX_STROKES} strokes"));
    }
    for (index, stroke) in strokes.iter().enumerate() {
        let n = index + 1;
        if stroke.pointer > 9 {
            return Err(format!("stroke {n}: finger slot must be 0–9"));
        }
        if stroke.points.is_empty() {
            return Err(format!("stroke {n}: no points"));
        }
        if stroke.points.len() > MAX_POINTS {
            return Err(format!("stroke {n}: more than {MAX_POINTS} points"));
        }
        if !stroke.points.iter().all(finite_point) {
            return Err(format!("stroke {n}: point is not a number"));
        }
        let end = u64::from(stroke.start_ms) + u64::from(stroke_ms(stroke));
        if end > u64::from(MAX_GESTURE_MS) {
            return Err(format!("stroke {n}: gesture longer than {} s", MAX_GESTURE_MS / 1000));
        }
    }
    let mut by_slot: HashMap<u8, Vec<(u32, u32)>> = HashMap::new();
    for stroke in strokes {
        by_slot
            .entry(stroke.pointer)
            .or_default()
            .push((stroke.start_ms, stroke.start_ms + stroke_ms(stroke)));
    }
    for (slot, mut spans) in by_slot {
        spans.sort_unstable();
        for pair in spans.windows(2) {
            if pair[1].0 < pair[0].1 {
                return Err(format!("finger {} is used by two strokes at once", slot + 1));
            }
        }
    }
    Ok(())
}

/// Position along the path at `t` (0–1), each segment taking equal time.
fn point_at(points: &[NormalizedPoint], t: f64) -> (f64, f64) {
    if points.len() == 1 {
        return (points[0].x, points[0].y);
    }
    let segments = (points.len() - 1) as f64;
    let scaled = (t.clamp(0.0, 1.0) * segments).min(segments);
    let index = (scaled.floor() as usize).min(points.len() - 2);
    let local = scaled - index as f64;
    let a = points[index];
    let b = points[index + 1];
    (a.x + (b.x - a.x) * local, a.y + (b.y - a.y) * local)
}

fn clamp01(v: f64) -> f64 {
    v.clamp(0.0, 1.0)
}

/// Down, moves and up for every stroke, in play order. At the same instant a
/// release goes first, so one finger slot can end a stroke and start the next.
pub fn timeline(strokes: &[GestureStroke]) -> Result<Vec<TouchEvent>, String> {
    validate(strokes)?;
    let mut events = Vec::new();
    for stroke in strokes {
        let start = stroke.start_ms;
        let duration = stroke_ms(stroke);
        let end = start + duration;
        let first = stroke.points[0];
        let last = stroke.points[stroke.points.len() - 1];
        let ev = |at_ms, phase, x: f64, y: f64| TouchEvent {
            at_ms,
            slot: stroke.pointer,
            phase,
            x: clamp01(x),
            y: clamp01(y),
        };
        events.push(ev(start, PointerPhase::Down, first.x, first.y));
        if stroke.points.len() > 1 {
            let mut at = start + MOVE_STEP_MS;
            while at < end {
                let (x, y) = point_at(&stroke.points, f64::from(at - start) / f64::from(duration));
                events.push(ev(at, PointerPhase::Move, x, y));
                at += MOVE_STEP_MS;
            }
            events.push(ev(end, PointerPhase::Move, last.x, last.y));
        }
        events.push(ev(end, PointerPhase::Up, last.x, last.y));
    }
    let rank = |phase: PointerPhase| match phase {
        PointerPhase::Up | PointerPhase::Cancel | PointerPhase::Leave => 1,
        PointerPhase::Down => 2,
        PointerPhase::Move | PointerPhase::Hover => 0,
    };
    events.sort_by_key(|e| (e.at_ms, rank(e.phase)));
    Ok(events)
}

/// Length of the whole gesture in milliseconds.
pub fn total_ms(strokes: &[GestureStroke]) -> u32 {
    strokes
        .iter()
        .map(|s| s.start_ms + stroke_ms(s))
        .max()
        .unwrap_or(0)
}

/// `(from, to, duration)` when the gesture is one finger, which `adb shell
/// input swipe` can play without the live screen.
pub fn single_line(strokes: &[GestureStroke]) -> Option<(NormalizedPoint, NormalizedPoint, u32)> {
    if strokes.len() != 1 {
        return None;
    }
    let s = &strokes[0];
    let first = *s.points.first()?;
    let last = *s.points.last()?;
    Some((first, last, stroke_ms(s)))
}

/// One gesture at a time per phone, so two macros cannot reuse a finger slot
/// on the same screen and confuse Android's pointer tracking.
pub fn device_lock(serial: &str) -> Arc<tokio::sync::Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> = OnceLock::new();
    let map = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = map.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .entry(serial.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(x: f64, y: f64) -> NormalizedPoint {
        NormalizedPoint { x, y }
    }

    fn stroke(pointer: u8, start_ms: u32, duration_ms: u32, points: Vec<NormalizedPoint>) -> GestureStroke {
        GestureStroke {
            pointer,
            start_ms,
            duration_ms,
            points,
        }
    }

    #[test]
    fn tap_is_down_then_up() {
        let events = timeline(&[stroke(0, 0, 0, vec![p(0.5, 0.5)])]).unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].phase, PointerPhase::Down);
        assert_eq!(events[1].phase, PointerPhase::Up);
        assert_eq!(events[1].at_ms, MIN_STROKE_MS);
    }

    #[test]
    fn swipe_moves_along_the_path_and_ends_on_last_point() {
        let events = timeline(&[stroke(0, 0, 100, vec![p(0.0, 0.0), p(1.0, 1.0)])]).unwrap();
        assert_eq!(events.first().unwrap().phase, PointerPhase::Down);
        let up = events.last().unwrap();
        assert_eq!(up.phase, PointerPhase::Up);
        assert_eq!((up.x, up.y, up.at_ms), (1.0, 1.0, 100));
        let moves: Vec<_> = events.iter().filter(|e| e.phase == PointerPhase::Move).collect();
        assert!(moves.len() >= 6);
        assert!(moves.windows(2).all(|w| w[0].x <= w[1].x));
    }

    #[test]
    fn two_fingers_overlap_and_each_is_released() {
        let events = timeline(&[
            stroke(0, 0, 200, vec![p(0.2, 0.5)]),
            stroke(1, 50, 100, vec![p(0.8, 0.5), p(0.8, 0.2)]),
        ])
        .unwrap();
        let downs: Vec<_> = events.iter().filter(|e| e.phase == PointerPhase::Down).collect();
        let ups: Vec<_> = events.iter().filter(|e| e.phase == PointerPhase::Up).collect();
        assert_eq!(downs.len(), 2);
        assert_eq!(ups.len(), 2);
        // Finger 2 is down while finger 1 still holds.
        let second_down = downs.iter().find(|e| e.slot == 1).unwrap().at_ms;
        let first_up = ups.iter().find(|e| e.slot == 0).unwrap().at_ms;
        assert!(second_down < first_up);
        assert_eq!(total_ms(&[stroke(0, 0, 200, vec![p(0.0, 0.0)]), stroke(1, 50, 300, vec![p(0.0, 0.0)])]), 350);
    }

    #[test]
    fn same_slot_back_to_back_releases_before_next_down() {
        let events = timeline(&[
            stroke(0, 0, 50, vec![p(0.1, 0.1)]),
            stroke(0, 50, 50, vec![p(0.9, 0.9)]),
        ])
        .unwrap();
        let at_50: Vec<_> = events.iter().filter(|e| e.at_ms == 50).map(|e| e.phase).collect();
        assert_eq!(at_50, vec![PointerPhase::Up, PointerPhase::Down]);
    }

    #[test]
    fn rejects_unsafe_gestures() {
        assert!(validate(&[]).is_err());
        assert!(validate(&[stroke(10, 0, 10, vec![p(0.0, 0.0)])]).is_err());
        assert!(validate(&[stroke(0, 0, 10, vec![])]).is_err());
        assert!(validate(&[stroke(0, 0, 10, vec![p(f64::NAN, 0.0)])]).is_err());
        assert!(validate(&[stroke(0, 0, MAX_GESTURE_MS + 1, vec![p(0.0, 0.0)])]).is_err());
        let overlap = [
            stroke(2, 0, 100, vec![p(0.0, 0.0)]),
            stroke(2, 50, 100, vec![p(0.0, 0.0)]),
        ];
        assert!(validate(&overlap).unwrap_err().contains("finger 3"));
        let too_many: Vec<_> = (0..11).map(|i| stroke((i % 10) as u8, i * 100, 10, vec![p(0.0, 0.0)])).collect();
        assert!(validate(&too_many).is_err());
    }

    #[test]
    fn points_are_clamped_to_the_screen() {
        let events = timeline(&[stroke(0, 0, 10, vec![p(-0.5, 1.5)])]).unwrap();
        assert_eq!((events[0].x, events[0].y), (0.0, 1.0));
    }

    #[test]
    fn single_line_only_for_one_finger() {
        let one = [stroke(0, 0, 300, vec![p(0.1, 0.2), p(0.5, 0.5), p(0.9, 0.8)])];
        let (a, b, ms) = single_line(&one).unwrap();
        assert_eq!((a.x, b.x, ms), (0.1, 0.9, 300));
        let two = [stroke(0, 0, 10, vec![p(0.0, 0.0)]), stroke(1, 0, 10, vec![p(0.0, 0.0)])];
        assert!(single_line(&two).is_none());
    }
}
