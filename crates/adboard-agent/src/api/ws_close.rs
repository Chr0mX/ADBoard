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
/// (a frozen tab, a half-open connection): free the subscriber instead of waiting for the OS.
pub(super) const SEND_TIMEOUT: Duration = Duration::from_secs(15);
/// Browsers answer pings on their own. Nothing at all from the peer for this long (the ping goes out
/// every 25 s) means the connection is dead even if the OS has not noticed.
pub(super) const PEER_SILENT_AFTER: Duration = Duration::from_secs(70);
/// A close frame is best effort: do not wait on it longer than this.
pub(super) const CLOSE_WRITE_LIMIT: Duration = Duration::from_secs(2);
/// Connecting to a remote agent's video socket may take this long before the stream is reported lost.
pub(super) const PROXY_CONNECT_TIMEOUT: Duration = Duration::from_secs(8);

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
