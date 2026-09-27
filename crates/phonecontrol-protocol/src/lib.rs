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
pub struct NavBroadcast {
    pub id: String,
    pub at: u64,
    pub mode: ControlMode,
    pub action: NavActionType,
    pub target_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthResponse {
    pub status: String,
    pub agent: String,
    pub adb: AdbAvailability,
    pub port: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AdbAvailability {
    Available,
    Mock,
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
    pub fn new(mode: ControlMode, action: NavActionType, target_ids: Vec<String>) -> Self {
        Self {
            id: format!("nav-{}", Uuid::new_v4()),
            at: now_ms(),
            mode,
            action,
            target_ids,
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
    }
}

pub fn map_to_devices(point: NormalizedPoint, devices: &[Device]) -> Vec<MappedTap> {
    devices.iter().map(|d| map_point(point, d)).collect()
}
