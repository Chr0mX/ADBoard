//! One record of which phones are connected, and a connection generation for each.
//!
//! Two things report connections: the `adb track-devices` stream (`tracker.rs`) and the
//! periodic `adb devices` poll (`watcher.rs`). Both call `observe`, which only reports a change
//! when the phone's online flag really changes, so the same event arriving twice (or from both
//! sources) is counted once. Every change starts a new generation for that phone. Work that was
//! begun for an older generation (a retry, a session restart) checks the generation first and
//! stops if the phone has reconnected since, so it can never act on the new connection.

use super::*;
use std::sync::atomic::AtomicBool;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transition {
    Connected,
    Disconnected,
}

#[derive(Debug, Clone, Copy)]
struct Conn {
    online: bool,
    generation: u64,
}

#[derive(Default)]
pub struct ConnectionBook {
    map: Mutex<HashMap<String, Conn>>,
}

impl ConnectionBook {
    /// Record what was seen. Returns the change, if the online flag changed, and the new generation.
    /// A phone first seen offline is recorded without a change; first seen online counts as connected.
    pub fn observe(&self, serial: &str, online: bool) -> Option<(Transition, u64)> {
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        match map.get_mut(serial) {
            None => {
                map.insert(
                    serial.to_string(),
                    Conn {
                        online,
                        generation: u64::from(online),
                    },
                );
                online.then_some((Transition::Connected, 1))
            }
            Some(conn) if conn.online == online => None,
            Some(conn) => {
                conn.online = online;
                conn.generation += 1;
                let transition = if online {
                    Transition::Connected
                } else {
                    Transition::Disconnected
                };
                Some((transition, conn.generation))
            }
        }
    }

    /// The phone's current connection generation (0 when never seen).
    pub fn generation(&self, serial: &str) -> u64 {
        self.map
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(serial)
            .map(|c| c.generation)
            .unwrap_or(0)
    }

    #[cfg(test)]
    pub fn is_online(&self, serial: &str) -> bool {
        self.map
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(serial)
            .is_some_and(|c| c.online)
    }
}

/// State the connection sources share.
#[derive(Default)]
pub struct ConnectionHub {
    pub book: ConnectionBook,
    /// Wakes the poll loop now (an event arrived, so take an authoritative snapshot at once).
    pub poll_wake: tokio::sync::Notify,
    /// The `track-devices` stream is connected and delivering; the poll can relax.
    pub tracker_up: AtomicBool,
}

impl AppState {
    /// A phone was seen online or not online, by the tracker or by a poll. Idempotent: only a real
    /// change starts a new generation, tells the Quiet Mode Loop, and wakes the poll loop.
    pub(super) fn observe_connection(
        &self,
        serial: &str,
        online: bool,
        source: &str,
    ) -> Option<Transition> {
        let (transition, generation) = self.inner.connections.book.observe(serial, online)?;
        info!(%serial, ?transition, generation, source, "phone connection changed");
        match transition {
            Transition::Connected => crate::quiet_cycle::note_connected(serial),
            Transition::Disconnected => crate::quiet_cycle::note_disconnected(serial),
        }
        self.inner.connections.poll_wake.notify_one();
        Some(transition)
    }

    pub(super) fn connection_generation(&self, serial: &str) -> u64 {
        self.inner.connections.book.generation(serial)
    }
}
