//! Scrcpy session manager — stubbed for this slice.
//!
//! TODO: spawn scrcpy-server per device, expose H264 over `/ws/devices/{serial}/video`,
//! and inject input via the scrcpy control socket (not stock scrcpy GUI).

use phonecontrol_protocol::{MappedTap, NavActionType};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::info;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
pub enum SessionState {
    Idle,
    Starting,
    Streaming,
    Error,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct SessionInfo {
    pub serial: String,
    pub state: SessionState,
    pub note: String,
}

#[derive(Default)]
pub struct SessionManager {
    sessions: RwLock<HashMap<String, SessionInfo>>,
}

impl SessionManager {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub async fn ensure_session(&self, serial: &str) -> SessionInfo {
        let mut guard = self.sessions.write().await;
        guard
            .entry(serial.to_string())
            .or_insert_with(|| SessionInfo {
                serial: serial.to_string(),
                // TODO: transition to Starting → Streaming once scrcpy-server is wired.
                state: SessionState::Idle,
                note: "scrcpy session stub — video pipeline not implemented yet".into(),
            })
            .clone()
    }

    /// Stub input inject: log the mapped pixels; real path will use scrcpy control messages.
    pub async fn inject_tap(&self, serial: &str, tap: &MappedTap) {
        let _ = self.ensure_session(serial).await;
        // TODO: send touch DOWN/UP via scrcpy control socket at (tap.x, tap.y).
        info!(
            serial,
            device_id = %tap.device_id,
            x = tap.x,
            y = tap.y,
            width = tap.width,
            height = tap.height,
            "[stub-inject] tap (not sent to device)"
        );
    }

    pub async fn inject_nav(&self, serial: &str, action: NavActionType) {
        let _ = self.ensure_session(serial).await;
        // TODO: inject KEYCODE_BACK / HOME / APP_SWITCH via scrcpy or `adb shell input keyevent`.
        info!(
            serial,
            ?action,
            "[stub-inject] nav (not sent to device)"
        );
    }

    #[allow(dead_code)]
    pub async fn list_sessions(&self) -> Vec<SessionInfo> {
        self.sessions.read().await.values().cloned().collect()
    }
}
