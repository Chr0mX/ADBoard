//! Shared protocol types for Rasiel.
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
    /// `KEYCODE_VOLUME_UP` (24). Sent with the other nav keyevents.
    #[serde(rename = "volume_up")]
    VolumeUp,
    /// `KEYCODE_VOLUME_DOWN` (25).
    #[serde(rename = "volume_down")]
    VolumeDown,
    /// `KEYCODE_POWER` (26).
    Power,
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

/// Process role for the multi-host mesh.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    /// Serves UI API + aggregates local + remote agent fleets.
    Controller,
    /// Local ADB/scrcpy only; registers with a controller.
    Agent,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Controller => "controller",
            Role::Agent => "agent",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HostStatus {
    Online,
    Stale,
    Offline,
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
    /// Display label for the owning host (Windows PC, LXC, …).
    pub host: String,
    /// Stable host id for mesh routing (defaults to `host` when omitted by older peers).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_id: Option<String>,
    pub wallpaper_hue: u16,
}

impl Device {
    pub fn effective_host_id(&self) -> &str {
        self.host_id.as_deref().unwrap_or(self.host.as_str())
    }
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

/// One step of a finger gesture. Passed through as a scrcpy touch event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PointerPhase {
    Down,
    Move,
    Up,
    Cancel,
    /// Mouse moved over the picture with no button down. Scrcpy `ACTION_HOVER_MOVE`.
    Hover,
    /// Mouse left the picture. Scrcpy `ACTION_HOVER_EXIT`.
    Leave,
}

/// Finger touches use pointer id -2. A PC mouse uses id -1 so Android tracks a cursor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum PointerTool {
    #[default]
    Finger,
    Mouse,
}

/// POST /api/input/pointer
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PointerRequest {
    pub mode: ControlMode,
    pub target_ids: Vec<String>,
    pub phase: PointerPhase,
    pub normalized: NormalizedPoint,
    /// Decoded video size. Scrcpy drops a touch whose screen size is not the video size.
    #[serde(default)]
    pub frame_width: u32,
    #[serde(default)]
    pub frame_height: u32,
    /// `mouse` hovers with pointer id -1. Missing means a finger, so older clients still tap.
    #[serde(default)]
    pub tool: PointerTool,
}

/// POST /api/input/refresh — scrcpy `RESET_VIDEO` (a new keyframe, not a new server).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoRefreshRequest {
    pub mode: ControlMode,
    pub target_ids: Vec<String>,
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
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    pub host_id: String,
    pub name: String,
    pub os: String,
    pub status: HostStatus,
    pub device_count: usize,
    pub local: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_seen_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthResponse {
    pub status: String,
    pub agent: String,
    pub role: Role,
    pub host_id: String,
    pub host_name: String,
    pub adb: AdbAvailability,
    pub scrcpy: ScrcpyAvailability,
    pub inject: InjectMode,
    pub port: u16,
    #[serde(default)]
    pub registered_hosts: usize,
}

/// Server → UI WebSocket frames.
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
    /// Mesh host list changed.
    Hosts { hosts: Vec<HostInfo> },
    /// Phone clipboard text, pushed when the device sends one.
    Clipboard { serial: String, text: String },
    /// Non-fatal agent notice.
    Notice { message: String },
}

/// UI → server WebSocket frames (reserved; HTTP is primary for input today).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientCommand {
    Subscribe,
    Ping,
    Tap(TapRequest),
    Nav(NavRequest),
    Pointer(PointerRequest),
}

/// Text status frame on `/ws/devices/{serial}/video`.
/// Binary WebSocket messages on the same socket are Annex-B H264 access units
/// (each message = one AU: optional SPS/PPS + one VCL NAL, start-code delimited).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoStatusFrame {
    pub serial: String,
    pub stream: StreamState,
    pub note: String,
    /// `stub` | `scrcpy` | `testpattern`
    pub backend: String,
    /// Present when a real H264 pump is attached (e.g. `"h264"`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codec: Option<String>,
    /// WebCodecs-style codec string when known (e.g. `avc1.42E01E`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codec_string: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    /// Binary framing: always `"annexb"` when pumping H264.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub framing: Option<String>,
}

impl VideoStatusFrame {
    pub fn from_session(session: &SessionStatus) -> Self {
        Self {
            serial: session.serial.clone(),
            stream: session.stream,
            note: session.note.clone(),
            backend: session.backend.clone(),
            codec: None,
            codec_string: None,
            width: None,
            height: None,
            framing: None,
        }
    }

    pub fn with_h264(mut self, width: u32, height: u32, codec_string: &str) -> Self {
        self.codec = Some("h264".into());
        self.codec_string = Some(codec_string.into());
        self.width = Some(width);
        self.height = Some(height);
        self.framing = Some("annexb".into());
        self
    }
}

/// Text status on `/ws/devices/{serial}/audio`.
/// Binary messages are `opus-pts`: 8-byte big-endian PTS in microseconds, then one Opus packet.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioStatusFrame {
    pub serial: String,
    pub stream: StreamState,
    pub note: String,
    pub codec: String,
    pub sample_rate: u32,
    pub channels: u32,
    pub framing: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

// ── Mesh protocol (agent ↔ controller over `/ws/agent`) ─────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHello {
    pub host_id: String,
    pub host_name: String,
    pub os: String,
    pub adb: AdbAvailability,
    pub scrcpy: ScrcpyAvailability,
    pub inject: InjectMode,
    /// Agent HTTP base (`http://host:port`) so the controller can proxy video WS.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub http_base: Option<String>,
}

/// Agent → controller frames.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentToController {
    Hello(AgentHello),
    Heartbeat {
        host_id: String,
        #[serde(default = "now_ms")]
        at: u64,
    },
    Devices {
        host_id: String,
        devices: Vec<Device>,
    },
    SessionUpdated {
        host_id: String,
        session: SessionStatus,
    },
    TapResult {
        request_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
        #[serde(default)]
        targets: Vec<MappedTap>,
    },
    NavResult {
        request_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
        #[serde(default)]
        targets: Vec<NavTargetResult>,
    },
    SessionResult {
        request_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session: Option<SessionStatus>,
    },
}

/// Controller → agent frames.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ControllerToAgent {
    Welcome {
        controller_host_id: String,
        message: String,
    },
    Ping {
        at: u64,
    },
    Tap {
        request_id: String,
        mode: ControlMode,
        target_ids: Vec<String>,
        normalized: NormalizedPoint,
    },
    Pointer {
        request_id: String,
        mode: ControlMode,
        target_ids: Vec<String>,
        phase: PointerPhase,
        normalized: NormalizedPoint,
        #[serde(default)]
        frame_width: u32,
        #[serde(default)]
        frame_height: u32,
        #[serde(default)]
        tool: PointerTool,
    },
    Nav {
        request_id: String,
        mode: ControlMode,
        target_ids: Vec<String>,
        action: NavActionType,
    },
    SessionStart {
        request_id: String,
        serial: String,
    },
    SessionStop {
        request_id: String,
        serial: String,
    },
    SessionRestart {
        request_id: String,
        serial: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionAction {
    Start,
    Stop,
    Restart,
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

/// POST /api/input/install — raw APK bytes, targets match the nav broadcast.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallBroadcast {
    pub id: String,
    pub at: u64,
    pub mode: ControlMode,
    pub target_ids: Vec<String>,
    pub targets: Vec<NavTargetResult>,
}

impl InstallBroadcast {
    pub fn new(mode: ControlMode, target_ids: Vec<String>, targets: Vec<NavTargetResult>) -> Self {
        Self {
            id: format!("install-{}", Uuid::new_v4()),
            at: now_ms(),
            mode,
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
        NavActionType::Back => 4,        // KEYCODE_BACK
        NavActionType::Home => 3,        // KEYCODE_HOME
        NavActionType::Recent => 187,    // KEYCODE_APP_SWITCH
        NavActionType::VolumeUp => 24,   // KEYCODE_VOLUME_UP
        NavActionType::VolumeDown => 25, // KEYCODE_VOLUME_DOWN
        NavActionType::Power => 26,      // KEYCODE_POWER
    }
}

/// POST /api/device/command — one operation, fanned out to the same targets as nav.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCommandRequest {
    pub target_ids: Vec<String>,
    pub op: String,
    #[serde(default)]
    pub arg: Option<String>,
    #[serde(default)]
    pub arg2: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceOpResult {
    pub device_id: String,
    pub device_name: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCommandResponse {
    pub id: String,
    pub op: String,
    pub results: Vec<DeviceOpResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostFileEntry {
    pub name: String,
    pub path: String,
    pub dir: bool,
    pub size: u64,
}

/// POST /api/scrcpy/options — quality, audio, and screen power for the current targets.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrcpyOptionsRequest {
    pub mode: ControlMode,
    pub target_ids: Vec<String>,
    /// `low` | `balanced` | `high` | `original`
    pub quality: String,
    pub audio: bool,
    pub screen_off: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrcpyOptionsResponse {
    pub quality: String,
    pub audio: bool,
    pub screen_off: bool,
    #[serde(default)]
    pub restarted: Vec<String>,
    #[serde(default)]
    pub results: Vec<DeviceOpResult>,
}

/// POST /api/input/clipboard — PC text onto the phone clipboard.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardSetRequest {
    pub mode: ControlMode,
    pub target_ids: Vec<String>,
    pub text: String,
    /// When true, scrcpy also pastes into the focused field.
    #[serde(default)]
    pub paste: bool,
}

/// POST /api/input/clipboard/pull — ask the phone for its clipboard.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardPullRequest {
    pub mode: ControlMode,
    pub target_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardResponse {
    pub results: Vec<DeviceOpResult>,
}

/// POST /api/input/text — scrcpy `INJECT_TEXT` into the focused field.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextInjectRequest {
    pub mode: ControlMode,
    pub target_ids: Vec<String>,
    pub text: String,
}

/// POST /api/input/key — scrcpy `INJECT_KEYCODE`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyInjectRequest {
    pub mode: ControlMode,
    pub target_ids: Vec<String>,
    /// `down` or `up`.
    pub action: String,
    pub keycode: u32,
    #[serde(default)]
    pub repeat: u32,
    #[serde(default)]
    pub metastate: u32,
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

/// Build `adb -s SERIAL install -r PATH` argv (excluding the adb binary).
pub fn adb_install_args(serial: &str, apk_path: &str) -> Vec<String> {
    vec![
        "-s".into(),
        serial.into(),
        "install".into(),
        "-r".into(),
        apk_path.into(),
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
            host_id: Some("test".into()),
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
        assert_eq!(nav_keycode(NavActionType::VolumeUp), 24);
        assert_eq!(nav_keycode(NavActionType::VolumeDown), 25);
        assert_eq!(nav_keycode(NavActionType::Power), 26);
        let args = adb_keyevent_args("SERIAL", 24);
        assert_eq!(
            args,
            vec!["-s", "SERIAL", "shell", "input", "keyevent", "24"]
        );
    }

    #[test]
    fn volume_nav_json_uses_keyevent_codes() {
        let req: NavRequest = serde_json::from_str(
            r#"{"mode":"all","targetIds":["s24"],"action":{"type":"volume_down"}}"#,
        )
        .unwrap();
        assert_eq!(req.action.action_type, NavActionType::VolumeDown);
        assert_eq!(nav_keycode(req.action.action_type), 25);
        let args = adb_install_args("SERIAL", "/tmp/app.apk");
        assert_eq!(args, vec!["-s", "SERIAL", "install", "-r", "/tmp/app.apk"]);
    }

    #[test]
    fn mesh_hello_roundtrips() {
        let hello = AgentToController::Hello(AgentHello {
            host_id: "lxc-1".into(),
            host_name: "lxc-agent-01".into(),
            os: "linux".into(),
            adb: AdbAvailability::Mock,
            scrcpy: ScrcpyAvailability::Missing,
            inject: InjectMode::Stub,
            http_base: Some("http://127.0.0.1:3849".into()),
        });
        let json = serde_json::to_string(&hello).unwrap();
        let back: AgentToController = serde_json::from_str(&json).unwrap();
        match back {
            AgentToController::Hello(h) => {
                assert_eq!(h.host_id, "lxc-1");
                assert_eq!(h.os, "linux");
                assert_eq!(h.http_base.as_deref(), Some("http://127.0.0.1:3849"));
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn video_status_frame_h264_fields() {
        let session = SessionStatus {
            serial: "S".into(),
            stream: StreamState::Streaming,
            note: "test".into(),
            backend: "testpattern".into(),
        };
        let frame = VideoStatusFrame::from_session(&session).with_h264(360, 640, "avc1.42E01E");
        let json = serde_json::to_string(&frame).unwrap();
        assert!(json.contains("\"framing\":\"annexb\""));
        assert!(json.contains("\"codec\":\"h264\""));
        let back: VideoStatusFrame = serde_json::from_str(&json).unwrap();
        assert_eq!(back.width, Some(360));
        assert_eq!(back.height, Some(640));
    }

    #[test]
    fn device_effective_host_id_falls_back() {
        let mut d = sample_device(100, 100);
        d.host_id = None;
        d.host = "windows-host".into();
        assert_eq!(d.effective_host_id(), "windows-host");
    }
}
