//! Shared protocol types for Phone Control.
//!
//! Mirrors `src/lib/devices/types.ts` so the Next.js UI and Rust agent
//! speak the same shape over HTTP + WebSocket.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionType {
    Usb,
    Network,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeviceStatus {
    Online,
    Offline,
    Unauthorized,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ControlMode {
    Selected,
    Multi,
    All,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NavActionType {
    Back,
    Home,
    Recent,
}

/// Result of attempting to inject input into a device.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InjectStatus {
    Ok,
    Stub,
    Error,
}

/// Per-device video / scrcpy session stream state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StreamState {
    Idle,
    Starting,
    Streaming,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AdbAvailability {
    Available,
    Mock,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScrcpyAvailability {
    Available,
    Missing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InjectMode {
    /// Real `adb shell input …` when ADB is present.
    Adb,
    /// Mock fleet / no ADB — inject logged only.
    Stub,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceResolution {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
    pub model: String,
    pub android_version: String,
    pub serial: String,
    pub connection: ConnectionType,
    pub status: DeviceStatus,
    pub battery: Option<u8>,
    pub temperature_c: Option<f32>,
    pub resolution: DeviceResolution,
    pub fps: Option<u32>,
    pub bitrate_mbps: Option<f32>,
    pub latency_ms: Option<u32>,
    pub host: String,
    pub wallpaper_hue: u16,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct NormalizedPoint {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MappedTap {
    pub device_id: String,
    pub device_name: String,
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    #[serde(default = "default_inject_stub")]
    pub inject: InjectStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inject_detail: Option<String>,
}

fn default_inject_stub() -> InjectStatus {
    InjectStatus::Stub
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TapBroadcast {
    pub id: String,
    pub at: u64,
    pub normalized: NormalizedPoint,
    pub mode: ControlMode,
    pub targets: Vec<MappedTap>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NavAction {
    #[serde(rename = "type")]
    pub action_type: NavActionType,
}

/// POST /api/input/tap
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TapRequest {
    pub mode: ControlMode,
    pub target_ids: Vec<String>,
    pub normalized: NormalizedPoint,
}

/// POST /api/input/nav
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NavRequest {
    pub mode: ControlMode,
    pub target_ids: Vec<String>,
    pub action: NavAction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NavTargetResult {
    pub device_id: String,
    pub device_name: String,
    pub inject: InjectStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NavBroadcast {
    pub id: String,
    pub at: u64,
    pub mode: ControlMode,
    pub action: NavActionType,
    pub target_ids: Vec<String>,
    #[serde(default)]
    pub targets: Vec<NavTargetResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatus {
    pub serial: String,
    pub stream: StreamState,
    pub note: String,
    /// `scrcpy` when a backend binary was found; `stub` otherwise.
    pub backend: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthResponse {
    pub status: String,
    pub agent: String,
    pub adb: AdbAvailability,
    pub scrcpy: ScrcpyAvailability,
    pub inject: InjectMode,
    pub port: u16,
}

/// Server → client WebSocket frames.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerEvent {
    /// Full fleet snapshot (sent on connect and on poll refresh).
    Devices { devices: Vec<Device> },
    /// Single device changed (status / metrics).
    DeviceUpdated { device: Device },
    /// Tap mapping result (mirrors HTTP response for live subscribers).
    TapResult { broadcast: TapBroadcast },
    /// Nav command ack.
    NavResult { broadcast: NavBroadcast },
    /// Per-device scrcpy / video session status.
    SessionUpdated { session: SessionStatus },
    /// Non-fatal agent notice.
    Notice { message: String },
}

/// Client → server WebSocket frames (reserved; HTTP is primary for input today).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientCommand {
    Subscribe,
    Ping,
    Tap(TapRequest),
    Nav(NavRequest),
}

/// Lightweight status frame for `/ws/devices/{serial}/video` until H264 pump lands.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoStatusFrame {
    pub serial: String,
    pub stream: StreamState,
    pub note: String,
    pub backend: String,
}

impl TapBroadcast {
    pub fn new(mode: ControlMode, normalized: NormalizedPoint, targets: Vec<MappedTap>) -> Self {
        Self {
            id: format!("tap-{}", Uuid::new_v4()),
            at: now_ms(),
            normalized,
            mode,
            targets,
        }
    }
}

impl NavBroadcast {
    pub fn new(
        mode: ControlMode,
        action: NavActionType,
        target_ids: Vec<String>,
        targets: Vec<NavTargetResult>,
    ) -> Self {
        Self {
            id: format!("nav-{}", Uuid::new_v4()),
            at: now_ms(),
            mode,
            action,
            target_ids,
            targets,
        }
    }
}

pub fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Map normalized 0–1 coords onto a device's native pixels.
pub fn map_point(point: NormalizedPoint, device: &Device) -> MappedTap {
    let x = (point.x.clamp(0.0, 1.0) * device.resolution.width as f64).round() as u32;
    let y = (point.y.clamp(0.0, 1.0) * device.resolution.height as f64).round() as u32;
    MappedTap {
        device_id: device.id.clone(),
        device_name: device.name.clone(),
        x,
        y,
        width: device.resolution.width,
        height: device.resolution.height,
        inject: InjectStatus::Stub,
        inject_detail: None,
    }
}

pub fn map_to_devices(point: NormalizedPoint, devices: &[Device]) -> Vec<MappedTap> {
    devices.iter().map(|d| map_point(point, d)).collect()
}

/// Android keycodes used for nav inject.
pub fn nav_keycode(action: NavActionType) -> i32 {
    match action {
        NavActionType::Back => 4,    // KEYCODE_BACK
        NavActionType::Home => 3,    // KEYCODE_HOME
        NavActionType::Recent => 187, // KEYCODE_APP_SWITCH
    }
}

/// Build `adb -s SERIAL shell input tap X Y` argv (excluding the adb binary).
pub fn adb_tap_args(serial: &str, x: u32, y: u32) -> Vec<String> {
    vec![
        "-s".into(),
        serial.into(),
        "shell".into(),
        "input".into(),
        "tap".into(),
        x.to_string(),
        y.to_string(),
    ]
}

/// Build `adb -s SERIAL shell input keyevent CODE` argv (excluding the adb binary).
pub fn adb_keyevent_args(serial: &str, keycode: i32) -> Vec<String> {
    vec![
        "-s".into(),
        serial.into(),
        "shell".into(),
        "input".into(),
        "keyevent".into(),
        keycode.to_string(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_device(width: u32, height: u32) -> Device {
        Device {
            id: "s24".into(),
            name: "S24".into(),
            model: "SM-S921B".into(),
            android_version: "14".into(),
            serial: "R5CW90ABC1".into(),
            connection: ConnectionType::Usb,
            status: DeviceStatus::Online,
            battery: Some(78),
            temperature_c: None,
            resolution: DeviceResolution { width, height },
            fps: Some(60),
            bitrate_mbps: Some(12.0),
            latency_ms: Some(18),
            host: "test".into(),
            wallpaper_hue: 210,
        }
    }

    #[test]
    fn maps_normalized_point_to_pixels() {
        let d = sample_device(1920, 1080);
        let tap = map_point(NormalizedPoint { x: 0.5, y: 0.4 }, &d);
        assert_eq!(tap.x, 960);
        assert_eq!(tap.y, 432);
        assert_eq!(tap.width, 1920);
        assert_eq!(tap.height, 1080);
    }

    #[test]
    fn clamps_out_of_range_normalized() {
        let d = sample_device(1000, 2000);
        let tap = map_point(NormalizedPoint { x: -0.2, y: 1.5 }, &d);
        assert_eq!(tap.x, 0);
        assert_eq!(tap.y, 2000);
    }

    #[test]
    fn builds_adb_tap_command() {
        let args = adb_tap_args("R5CW90ABC1", 960, 432);
        assert_eq!(
            args,
            vec!["-s", "R5CW90ABC1", "shell", "input", "tap", "960", "432"]
        );
    }

    #[test]
    fn builds_adb_keyevent_command() {
        assert_eq!(nav_keycode(NavActionType::Back), 4);
        assert_eq!(nav_keycode(NavActionType::Home), 3);
        assert_eq!(nav_keycode(NavActionType::Recent), 187);
        let args = adb_keyevent_args("SERIAL", 187);
        assert_eq!(
            args,
            vec!["-s", "SERIAL", "shell", "input", "keyevent", "187"]
        );
    }
}
