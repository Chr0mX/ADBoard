//! Why a video WebSocket was closed, and the deadlines that decide it.
//!
//! A bare TCP close tells the browser nothing: a deliberate stop, a dead peer, a lost remote agent
//! and a failed start all look the same, so every one of them was "a reconnect". Each server-side
//! close now carries a code (4000 to 4999 is for applications) and a short reason, which the page
//! records next to its retry count. The browser's own closes (1000/1001) never need one.
use super::*;
use axum::extract::ws::CloseFrame;
use std::time::{Duration, Instant};

/// A frame, ping or heartbeat that cannot be written for this long means the peer stopped reading
/// (a frozen tab, a half-open connection): free the subscriber instead of waiting for the OS. Long enough
/// for a Wi-Fi roam or a throttled background tab to catch up, short enough to free a dead peer.
pub(super) const SEND_TIMEOUT: Duration = Duration::from_secs(30);
/// Browsers answer pings on their own. Nothing at all from the peer for this long (the ping goes out
/// every 25 s) means the connection is dead even if the OS has not noticed.
#[cfg(not(test))]
pub(super) const PEER_SILENT_AFTER: Duration = Duration::from_secs(70);
/// Short in tests, so a client that goes silent can be shown to be closed without a minute's wait.
#[cfg(test)]
pub(super) const PEER_SILENT_AFTER: Duration = Duration::from_secs(2);
/// A socket that has held back delta frames this long without a keyframe asks for one again.
pub(super) const KEYFRAME_STALL: Duration = Duration::from_secs(2);
/// A close frame is best effort: do not wait on it longer than this.
pub(super) const CLOSE_WRITE_LIMIT: Duration = Duration::from_secs(2);
/// Connecting to a remote agent's video socket may take this long before the stream is reported lost.
pub(super) const PROXY_CONNECT_TIMEOUT: Duration = Duration::from_secs(8);

/// What a video socket has sent, for the log line that explains how it ended. Written by the sending
/// task, read when the socket is done. Times are milliseconds since the socket opened (0: never).
#[derive(Default)]
pub(super) struct LinkStats {
    pub(super) frames: std::sync::atomic::AtomicU64,
    pub(super) last_frame_ms: std::sync::atomic::AtomicU64,
    pub(super) last_heartbeat_ms: std::sync::atomic::AtomicU64,
    /// The page told the agent this viewer is idle (no pictures wanted).
    pub(super) idle: std::sync::atomic::AtomicBool,
}

impl LinkStats {
    pub(super) fn note_frame(&self, since: Instant) {
        self.frames.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.last_frame_ms
            .store(since.elapsed().as_millis() as u64 + 1, std::sync::atomic::Ordering::Relaxed);
    }

    pub(super) fn note_heartbeat(&self, since: Instant) {
        self.last_heartbeat_ms
            .store(since.elapsed().as_millis() as u64 + 1, std::sync::atomic::Ordering::Relaxed);
    }

    /// How long before now the event stored in `at` happened, or `None` if it never did.
    pub(super) fn ago_ms(&self, at: &std::sync::atomic::AtomicU64, since: Instant) -> Option<u64> {
        let stored = at.load(std::sync::atomic::Ordering::Relaxed);
        (stored > 0).then(|| (since.elapsed().as_millis() as u64).saturating_sub(stored - 1))
    }
}

/// The page's message about its viewer: `{"type":"viewer","active":false}` stops the pictures and
/// `active: true` brings them back. Anything else a page sends on the socket is ignored.
pub(super) fn parse_viewer_message(text: &str) -> Option<bool> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    if value.get("type")?.as_str()? != "viewer" {
        return None;
    }
    value.get("active")?.as_bool()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CloseReason {
    /// The device or host is not known.
    UnknownDevice,
    /// The stream could not be started (the reason went out as a status frame first).
    StartFailed,
    /// The browser stopped reading for `SEND_TIMEOUT`.
    ClientTooSlow,
    /// The browser sent nothing, not even a pong, for `PEER_SILENT_AFTER`.
    ClientSilent,
    /// The remote agent's video socket could not be opened.
    AgentUnreachable,
    /// The remote agent's video socket ended while the browser was still connected.
    AgentLinkLost,
    /// The video channel for this phone was shut down by the agent.
    StreamShutDown,
}

impl CloseReason {
    pub(super) fn code(self) -> u16 {
        match self {
            CloseReason::UnknownDevice => 4004,
            CloseReason::StartFailed => 4005,
            CloseReason::ClientTooSlow => 4008,
            CloseReason::ClientSilent => 4009,
            CloseReason::AgentUnreachable => 4010,
            CloseReason::AgentLinkLost => 4011,
            CloseReason::StreamShutDown => 4012,
        }
    }

    pub(super) fn text(self) -> &'static str {
        match self {
            CloseReason::UnknownDevice => "unknown device",
            CloseReason::StartFailed => "stream could not start",
            CloseReason::ClientTooSlow => "client stopped reading",
            CloseReason::ClientSilent => "client sent nothing, not even a pong",
            CloseReason::AgentUnreachable => "remote agent video unreachable",
            CloseReason::AgentLinkLost => "remote agent video link ended",
            CloseReason::StreamShutDown => "video channel shut down",
        }
    }

    pub(super) fn frame(self) -> Message {
        Message::Close(Some(CloseFrame {
            code: self.code(),
            reason: self.text().into(),
        }))
    }
}

/// Has the peer been silent for longer than `limit`?
pub(super) fn peer_is_silent(last_heard: Instant, now: Instant, limit: Duration) -> bool {
    now.saturating_duration_since(last_heard) > limit
}

/// Why a write to the browser failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum WriteFailure {
    /// The socket is gone: nothing to tell it.
    PeerGone,
    /// The write did not finish in time: the browser is not reading.
    TooSlow,
}

impl WriteFailure {
    pub(super) fn reason(self) -> Option<CloseReason> {
        match self {
            WriteFailure::PeerGone => None,
            WriteFailure::TooSlow => Some(CloseReason::ClientTooSlow),
        }
    }
}

/// Write one message, but never wait longer than `limit` for a peer that has stopped reading.
pub(super) async fn write_within<S>(
    sender: &mut S,
    message: Message,
    limit: Duration,
) -> Result<(), WriteFailure>
where
    S: futures_util::Sink<Message> + Unpin,
{
    match tokio::time::timeout(limit, sender.send(message)).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(_)) => Err(WriteFailure::PeerGone),
        Err(_) => Err(WriteFailure::TooSlow),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_reason_has_its_own_application_code_and_text() {
        let all = [
            CloseReason::UnknownDevice,
            CloseReason::StartFailed,
            CloseReason::ClientTooSlow,
            CloseReason::ClientSilent,
            CloseReason::AgentUnreachable,
            CloseReason::AgentLinkLost,
            CloseReason::StreamShutDown,
        ];
        let mut codes: Vec<u16> = all.iter().map(|r| r.code()).collect();
        assert!(
            codes.iter().all(|c| (4000..5000).contains(c)),
            "application range"
        );
        codes.sort_unstable();
        codes.dedup();
        assert_eq!(codes.len(), all.len(), "codes are distinct");
        assert!(all
            .iter()
            .all(|r| !r.text().is_empty() && r.text().len() < 120));
    }

    #[test]
    fn the_viewer_message_is_read_strictly() {
        assert_eq!(parse_viewer_message(r#"{"type":"viewer","active":false}"#), Some(false));
        assert_eq!(parse_viewer_message(r#"{"type":"viewer","active":true}"#), Some(true));
        // Anything else is not a viewer message and changes nothing.
        assert_eq!(parse_viewer_message(r#"{"type":"viewer"}"#), None);
        assert_eq!(parse_viewer_message(r#"{"type":"other","active":false}"#), None);
        assert_eq!(parse_viewer_message(r#"{"active":false}"#), None);
        assert_eq!(parse_viewer_message(r#"{"type":"viewer","active":"no"}"#), None);
        assert_eq!(parse_viewer_message("not json"), None);
        assert_eq!(parse_viewer_message(""), None);
    }

    #[test]
    fn link_stats_report_when_things_last_happened_and_never_for_what_did_not() {
        let stats = LinkStats::default();
        let opened = Instant::now();
        assert_eq!(stats.ago_ms(&stats.last_frame_ms, opened), None);
        assert_eq!(stats.ago_ms(&stats.last_heartbeat_ms, opened), None);
        stats.note_frame(opened);
        stats.note_heartbeat(opened);
        assert_eq!(stats.frames.load(std::sync::atomic::Ordering::Relaxed), 1);
        assert!(stats.ago_ms(&stats.last_frame_ms, opened).unwrap() < 1000);
        assert!(stats.ago_ms(&stats.last_heartbeat_ms, opened).unwrap() < 1000);
    }

    #[test]
    fn silence_is_measured_from_the_last_thing_heard() {
        let start = Instant::now();
        let limit = Duration::from_secs(70);
        assert!(!peer_is_silent(
            start,
            start + Duration::from_secs(69),
            limit
        ));
        assert!(peer_is_silent(
            start,
            start + Duration::from_secs(71),
            limit
        ));
        // A clock that reads earlier than the last message is not silence.
        assert!(!peer_is_silent(
            start + Duration::from_secs(5),
            start,
            limit
        ));
    }

    #[tokio::test]
    async fn a_peer_that_stops_reading_is_reported_as_too_slow() {
        // A sink that never completes a write: a browser that froze with its buffers full.
        struct Stuck;
        impl futures_util::Sink<Message> for Stuck {
            type Error = ();
            fn poll_ready(
                self: std::pin::Pin<&mut Self>,
                _: &mut std::task::Context<'_>,
            ) -> std::task::Poll<Result<(), ()>> {
                std::task::Poll::Pending
            }
            fn start_send(self: std::pin::Pin<&mut Self>, _: Message) -> Result<(), ()> {
                Ok(())
            }
            fn poll_flush(
                self: std::pin::Pin<&mut Self>,
                _: &mut std::task::Context<'_>,
            ) -> std::task::Poll<Result<(), ()>> {
                std::task::Poll::Pending
            }
            fn poll_close(
                self: std::pin::Pin<&mut Self>,
                _: &mut std::task::Context<'_>,
            ) -> std::task::Poll<Result<(), ()>> {
                std::task::Poll::Pending
            }
        }
        let started = Instant::now();
        let result = write_within(
            &mut Stuck,
            Message::Text("x".into()),
            Duration::from_millis(60),
        )
        .await;
        assert_eq!(result, Err(WriteFailure::TooSlow));
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(
            result.unwrap_err().reason(),
            Some(CloseReason::ClientTooSlow)
        );
    }

    #[tokio::test]
    async fn a_closed_socket_is_peer_gone_not_too_slow() {
        struct Gone;
        impl futures_util::Sink<Message> for Gone {
            type Error = ();
            fn poll_ready(
                self: std::pin::Pin<&mut Self>,
                _: &mut std::task::Context<'_>,
            ) -> std::task::Poll<Result<(), ()>> {
                std::task::Poll::Ready(Err(()))
            }
            fn start_send(self: std::pin::Pin<&mut Self>, _: Message) -> Result<(), ()> {
                Err(())
            }
            fn poll_flush(
                self: std::pin::Pin<&mut Self>,
                _: &mut std::task::Context<'_>,
            ) -> std::task::Poll<Result<(), ()>> {
                std::task::Poll::Ready(Err(()))
            }
            fn poll_close(
                self: std::pin::Pin<&mut Self>,
                _: &mut std::task::Context<'_>,
            ) -> std::task::Poll<Result<(), ()>> {
                std::task::Poll::Ready(Ok(()))
            }
        }
        let result =
            write_within(&mut Gone, Message::Text("x".into()), Duration::from_secs(1)).await;
        assert_eq!(result, Err(WriteFailure::PeerGone));
        assert_eq!(WriteFailure::PeerGone.reason(), None);
    }
}
