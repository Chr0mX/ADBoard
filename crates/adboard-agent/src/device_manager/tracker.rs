//! `adb track-devices`: the adb server tells us about every connect and disconnect as it
//! happens, so a phone that drops and returns between two polls is not missed.
//!
//! We speak the adb host protocol directly to the server (default port 5037): send
//! `host:track-devices`, expect `OKAY`, then read frames of `<4 hex digits of length><payload>`.
//! Each payload is the complete device list (`serial<TAB>state` per line). The stream is only a
//! source of events: every event is recorded idempotently (`connections.rs`) and wakes the poll,
//! whose `adb devices -l` snapshot stays the authority and the fallback when the stream is down.

use super::*;
use std::sync::atomic::Ordering;
use tokio::io::{AsyncRead, AsyncWrite};

/// `(serial, status)` for each well-formed line; lines that are not `serial<TAB>state` are skipped.
pub(super) fn parse_track_payload(payload: &str) -> Vec<(String, DeviceStatus)> {
    let mut out = Vec::new();
    for line in payload.lines() {
        let mut parts = line.split_whitespace();
        let (Some(serial), Some(state)) = (parts.next(), parts.next()) else {
            continue;
        };
        let status = match state {
            "device" => DeviceStatus::Online,
            "unauthorized" => DeviceStatus::Unauthorized,
            _ => DeviceStatus::Offline,
        };
        out.push((serial.to_string(), status));
    }
    out
}

pub(super) async fn read_frame<R: AsyncRead + Unpin>(reader: &mut R) -> Result<String, String> {
    let mut len = [0u8; 4];
    reader
        .read_exact(&mut len)
        .await
        .map_err(|e| format!("stream ended: {e}"))?;
    let len = std::str::from_utf8(&len)
        .ok()
        .and_then(|text| usize::from_str_radix(text, 16).ok())
        .ok_or_else(|| "malformed frame length".to_string())?;
    let mut payload = vec![0u8; len];
    reader
        .read_exact(&mut payload)
        .await
        .map_err(|e| format!("stream ended in a frame: {e}"))?;
    Ok(String::from_utf8_lossy(&payload).into_owned())
}

/// Ask for the stream and hand every frame to `on_frame`. Returns only when the stream ends or is
/// not understood (so the caller reconnects).
pub(super) async fn track_once<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
    mut on_frame: impl FnMut(Vec<(String, DeviceStatus)>),
) -> Result<(), String> {
    let request = "host:track-devices";
    stream
        .write_all(format!("{:04x}{request}", request.len()).as_bytes())
        .await
        .map_err(|e| format!("cannot ask adb to track devices: {e}"))?;
    let mut answer = [0u8; 4];
    stream
        .read_exact(&mut answer)
        .await
        .map_err(|e| format!("adb did not answer: {e}"))?;
    if &answer != b"OKAY" {
        let detail = read_frame(stream).await.unwrap_or_default();
        return Err(format!("adb refused track-devices: {detail}"));
    }
    loop {
        let payload = read_frame(stream).await?;
        on_frame(parse_track_payload(&payload));
    }
}

/// Fold one frame into the connection record. `last` is what the previous frame said (kept
/// across reconnects of the stream), so a phone missing from a frame counts as dropped.
pub(super) fn apply_frame(
    state: &AppState,
    last: &mut HashMap<String, DeviceStatus>,
    frame: Vec<(String, DeviceStatus)>,
) {
    let now: HashMap<String, DeviceStatus> = frame.into_iter().collect();
    for (serial, status) in &now {
        state.observe_connection(serial, *status == DeviceStatus::Online, "track-devices");
    }
    for serial in last.keys() {
        if !now.contains_key(serial) {
            state.observe_connection(serial, false, "track-devices");
        }
    }
    *last = now;
}

/// The adb server's address, or None when tracking is switched off (`ADBOARD_ADB_TRACK=0`).
pub(super) fn track_addr() -> Option<String> {
    if matches!(
        crate::env::var("ADB_TRACK").as_deref(),
        Ok("0") | Ok("off") | Ok("false")
    ) {
        return None;
    }
    if let Ok(addr) = crate::env::var("ADB_TRACK_ADDR") {
        return Some(addr);
    }
    let port = std::env::var("ANDROID_ADB_SERVER_PORT")
        .ok()
        .and_then(|p| p.trim().parse::<u16>().ok())
        .unwrap_or(5037);
    Some(format!("127.0.0.1:{port}"))
}

impl AppState {
    /// Keep a `track-devices` stream open for as long as the agent runs, reconnecting with growing,
    /// jittered delays when it ends (adb restarted, server killed, malformed data).
    pub(super) fn spawn_tracker(&self, addr: String) {
        let state = self.clone();
        tokio::spawn(async move {
            let mut backoff =
                crate::backoff::Backoff::new(Duration::from_secs(1), Duration::from_secs(30));
            let mut last: HashMap<String, DeviceStatus> = HashMap::new();
            loop {
                let started = std::time::Instant::now();
                let mut frames = 0u64;
                match tokio::time::timeout(Duration::from_secs(3), TcpStream::connect(&addr)).await
                {
                    Ok(Ok(mut stream)) => {
                        let result = track_once(&mut stream, |frame| {
                            frames += 1;
                            state
                                .inner
                                .connections
                                .tracker_up
                                .store(true, Ordering::Relaxed);
                            apply_frame(&state, &mut last, frame);
                        })
                        .await;
                        state
                            .inner
                            .connections
                            .tracker_up
                            .store(false, Ordering::Relaxed);
                        if let Err(error) = result {
                            warn!(%addr, %error, frames, "adb track-devices ended");
                        }
                    }
                    Ok(Err(error)) => {
                        warn!(%addr, %error, "cannot reach the adb server for track-devices")
                    }
                    Err(_) => warn!(%addr, "timed out reaching the adb server for track-devices"),
                }
                // The poll takes a snapshot now, whatever happened to the stream.
                state.inner.connections.poll_wake.notify_one();
                if frames > 0 && started.elapsed() > Duration::from_secs(10) {
                    backoff.reset();
                }
                tokio::time::sleep(backoff.next_delay()).await;
            }
        });
    }
}
