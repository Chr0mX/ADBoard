//! Device manager — owns the live fleet, ADB polling, mesh merge, and event fan-out.

mod fanout;
mod input;
use input::frame_tap;
mod virtual_displays;
mod watcher;

use crate::adb::{self, AdbDeviceLine};
use crate::mesh::MeshRegistry;
use crate::mock::{self, MockProfile};
use crate::session::{scrcpy_binary, ScrcpyPrefs, SessionManager};
use crate::video::VideoHub;
use adboard_protocol::{
    map_to_devices, AdbAvailability, ClipboardPullRequest, ClipboardResponse, ClipboardSetRequest,
    ControlMode, Device, DeviceCommandRequest, GestureRequest, GestureResult, GestureStroke, DeviceCommandResponse, DeviceOpResult, DeviceStatus,
    HostInfo, InjectMode, InjectStatus, InstallBroadcast, KeyInjectRequest, MappedTap,
    NavActionType, NavBroadcast, NavTargetResult, NormalizedPoint, PointerPhase, PointerTool, Role,
    ScrcpyAvailability, ScrcpyOptionsRequest, ScrcpyOptionsResponse, ServerEvent, SessionAction,
    SessionStatus, StreamState, TapBroadcast, TextInjectRequest, VideoRefreshRequest,
};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{broadcast, RwLock};
use tracing::{info, warn};

const ADB_POLL_SECS: u64 = 2;
const SESSION_REAP_SECS: u64 = 3;
/// Optional `wm size` applied whenever a phone comes online, from
/// `ADBOARD_CONNECT_DISPLAY_SIZE` (e.g. `900x1600`). Off by default:
/// changing every phone's real resolution must be a deliberate choice.
fn connect_display_size() -> Option<&'static str> {
    static SIZE: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    SIZE.get_or_init(|| {
        let spec = crate::env::var("CONNECT_DISPLAY_SIZE").ok()?;
        let spec = spec.trim().to_string();
        if spec.is_empty() || spec == "native" || spec == "reset" {
            return None;
        }
        match crate::adb::display_size_command(&spec) {
            Ok(_) => {
                info!(size = %spec, "phones will be set to this wm size when they come online");
                Some(spec)
            }
            Err(error) => {
                warn!(size = %spec, %error, "ignoring ADBOARD_CONNECT_DISPLAY_SIZE");
                None
            }
        }
    })
    .as_deref()
}

#[derive(Clone)]
pub struct AppState {
    pub inner: Arc<InnerState>,
}

pub struct InnerState {
    pub role: Role,
    pub host_id: String,
    pub host_name: String,
    pub port: u16,
    pub adb_path: Option<PathBuf>,
    /// Local devices only (this process's ADB/mock).
    pub devices: RwLock<Vec<Device>>,
    pub events: broadcast::Sender<ServerEvent>,
    pub sessions: Arc<SessionManager>,
    /// Present on controller (and unused on pure agent for remote merge).
    pub mesh: Arc<MeshRegistry>,
    /// Serials whose `wm size` changed and must be read again on the next poll.
    pub resolution_refresh: Mutex<HashSet<String>>,
    /// Serials where ADBoard applied a non-native `wm size` override.
    /// Cleared on successful `wm size reset` (manual or on disconnect/reconnect).
    pub display_size_overrides: Mutex<HashSet<String>>,
    pub qr_pairs: Mutex<HashMap<String, QrPairSlot>>,
    /// Shared secret for HTTP and WebSocket API calls (`ADBOARD_TOKEN`).
    pub api_token: String,
}

pub struct QrPairSlot {
    pub state: String,
    pub message: String,
    pub endpoint: Option<String>,
    pub cancel: tokio::sync::watch::Sender<bool>,
}

pub struct QrPairInfo {
    pub id: String,
    pub payload: String,
    pub svg: String,
}

pub struct QrPairStatus {
    pub id: String,
    pub state: String,
    pub message: String,
    pub endpoint: Option<String>,
}

impl AppState {
    pub fn new(
        role: Role,
        host_id: String,
        host_name: String,
        port: u16,
        adb_path: Option<PathBuf>,
    ) -> Self {
        let (events, _) = broadcast::channel(256);
        let force_mock = crate::env::truthy("FORCE_MOCK");
        let adb_path = if force_mock {
            info!("ADBOARD_FORCE_MOCK set — using mock fleet");
            None
        } else {
            adb_path
        };
        let scrcpy = scrcpy_binary();
        let server = crate::scrcpy_video::scrcpy_server_jar(scrcpy.as_deref());
        match (&scrcpy, &server) {
            (Some(b), Some(s)) => info!(
                bin = %b.display(),
                server = %s.display(),
                "scrcpy binary + server found (raw H264 path ready when ADB present)"
            ),
            (None, Some(s)) => info!(
                server = %s.display(),
                "scrcpy-server found (binary optional for raw stream)"
            ),
            (Some(b), None) => info!(
                bin = %b.display(),
                "scrcpy binary found but scrcpy-server missing — set SCRCPY_SERVER_PATH"
            ),
            (None, None) => info!(
                "scrcpy not found — sessions use testpattern/stub (set SCRCPY_PATH / SCRCPY_SERVER_PATH)"
            ),
        }

        let profile = match role {
            Role::Agent if MockProfile::from_env() == MockProfile::All => {
                // Agents default to LXC slice so a dual-process demo doesn't duplicate ids.
                MockProfile::Lxc
            }
            _ => MockProfile::from_env(),
        };
        let initial = if adb_path.is_some() {
            Vec::new()
        } else {
            info!(
                profile = profile.as_str(),
                host_id = %host_id,
                "serving mock fleet"
            );
            mock::mock_fleet(&host_id, &host_name, profile)
        };
        let video_hub = VideoHub::new();
        let sessions = SessionManager::new(adb_path.clone(), scrcpy, video_hub);
        let mesh = MeshRegistry::new(host_id.clone(), host_name.clone());
        let api_token = resolve_api_token();
        let app = Self {
            inner: Arc::new(InnerState {
                role,
                host_id,
                host_name,
                port,
                adb_path,
                devices: RwLock::new(initial),
                events,
                sessions,
                mesh,
                resolution_refresh: Mutex::new(HashSet::new()),
                display_size_overrides: Mutex::new(HashSet::new()),
                qr_pairs: Mutex::new(HashMap::new()),
                api_token,
            }),
        };
        let events = app.inner.events.clone();
        let mut clip_rx = app.inner.sessions.subscribe_clipboard();
        tokio::spawn(async move {
            loop {
                match clip_rx.recv().await {
                    Ok((serial, text)) => {
                        let _ = events.send(ServerEvent::Clipboard { serial, text });
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });
        app
    }

    pub fn video_hub(&self) -> Arc<crate::video::VideoHub> {
        self.inner.sessions.video_hub()
    }

    /// Local only: start video pump if idle (video WS subscribe path).
    pub async fn ensure_local_streaming(&self, serial: &str) -> Result<SessionStatus, String> {
        self.require_local_serial(serial).await?;
        let session = self.inner.sessions.ensure_streaming(serial).await;
        self.publish(ServerEvent::SessionUpdated {
            session: session.clone(),
        });
        Ok(session)
    }

    /// Agent HTTP base for a remote host (video proxy), if advertised at hello.
    pub async fn remote_http_base(&self, host_id: &str) -> Option<String> {
        self.inner.mesh.http_base(host_id).await
    }

    pub fn role(&self) -> Role {
        self.inner.role
    }

    pub fn host_id(&self) -> &str {
        &self.inner.host_id
    }

    pub fn host_name(&self) -> &str {
        &self.inner.host_name
    }

    pub fn api_token(&self) -> &str {
        &self.inner.api_token
    }

    pub fn mesh(&self) -> Arc<MeshRegistry> {
        self.inner.mesh.clone()
    }

    pub fn adb_availability(&self) -> AdbAvailability {
        if self.inner.adb_path.is_some() {
            AdbAvailability::Available
        } else {
            AdbAvailability::Mock
        }
    }

    pub fn scrcpy_availability(&self) -> ScrcpyAvailability {
        self.inner.sessions.scrcpy_availability()
    }

    pub fn inject_mode(&self) -> InjectMode {
        self.inner.sessions.inject_mode()
    }

    /// The phones adb sees, then one entry per virtual display of each.
    pub async fn list_local_devices(&self) -> Vec<Device> {
        let mut devices = self.inner.devices.read().await.clone();
        let virtual_devices = self.virtual_devices_of(&devices).await;
        devices.extend(virtual_devices);
        devices
    }

    /// Merged fleet: local + remote agents (controller) or local only (agent).
    pub async fn list_devices(&self) -> Vec<Device> {
        let mut devices = self.list_local_devices().await;
        if self.inner.role == Role::Controller {
            devices.extend(self.inner.mesh.remote_devices().await);
        }
        devices
    }

    pub fn subscribe(&self) -> broadcast::Receiver<ServerEvent> {
        self.inner.events.subscribe()
    }

    pub fn publish(&self, event: ServerEvent) {
        let _ = self.inner.events.send(event);
    }

    pub async fn publish_fleet(&self) {
        let devices = self.list_devices().await;
        self.publish(ServerEvent::Devices { devices });
        let hosts = self.list_hosts().await;
        self.publish(ServerEvent::Hosts { hosts });
    }

    pub async fn list_hosts(&self) -> Vec<HostInfo> {
        let local_count = self.inner.devices.read().await.len();
        self.inner.mesh.host_infos(local_count).await
    }

    pub async fn list_local_sessions(&self) -> Vec<SessionStatus> {
        self.inner.sessions.list_sessions().await
    }

    pub async fn list_sessions(&self) -> Vec<SessionStatus> {
        let mut sessions = self.list_local_sessions().await;
        if self.inner.role == Role::Controller {
            sessions.extend(self.inner.mesh.remote_sessions().await);
        }
        sessions
    }

    pub async fn session_status(&self, serial: &str) -> SessionStatus {
        if let Some(s) = self.inner.sessions.get_session(serial).await {
            return s;
        }
        // Remote session cache.
        for s in self.inner.mesh.remote_sessions().await {
            if s.serial == serial {
                return s;
            }
        }
        self.inner.sessions.ensure_session(serial).await
    }

    pub async fn start_session(&self, serial: &str) -> Result<SessionStatus, String> {
        if let Some(host_id) = self.remote_owner(serial).await {
            let session = self
                .inner
                .mesh
                .proxy_session(&host_id, serial, SessionAction::Start)
                .await?;
            self.inner.mesh.set_session(&host_id, session.clone()).await;
            self.publish(ServerEvent::SessionUpdated {
                session: session.clone(),
            });
            return Ok(session);
        }
        self.start_session_local(serial).await
    }

    pub async fn stop_session(&self, serial: &str) -> Result<SessionStatus, String> {
        if let Some(host_id) = self.remote_owner(serial).await {
            let session = self
                .inner
                .mesh
                .proxy_session(&host_id, serial, SessionAction::Stop)
                .await?;
            self.inner.mesh.set_session(&host_id, session.clone()).await;
            self.publish(ServerEvent::SessionUpdated {
                session: session.clone(),
            });
            return Ok(session);
        }
        self.stop_session_local(serial).await
    }

    pub async fn restart_session(&self, serial: &str) -> Result<SessionStatus, String> {
        if let Some(host_id) = self.remote_owner(serial).await {
            let session = self
                .inner
                .mesh
                .proxy_session(&host_id, serial, SessionAction::Restart)
                .await?;
            self.inner.mesh.set_session(&host_id, session.clone()).await;
            self.publish(ServerEvent::SessionUpdated {
                session: session.clone(),
            });
            return Ok(session);
        }
        self.restart_session_local(serial).await
    }

    pub async fn start_session_local(&self, serial: &str) -> Result<SessionStatus, String> {
        self.require_local_serial(serial).await?;
        let session = self.inner.sessions.start(serial).await;
        self.publish(ServerEvent::SessionUpdated {
            session: session.clone(),
        });
        Ok(session)
    }

    pub async fn stop_session_local(&self, serial: &str) -> Result<SessionStatus, String> {
        self.require_local_serial(serial).await?;
        let session = self.inner.sessions.stop(serial).await;
        self.publish(ServerEvent::SessionUpdated {
            session: session.clone(),
        });
        Ok(session)
    }

    pub async fn restart_session_local(&self, serial: &str) -> Result<SessionStatus, String> {
        self.require_local_serial(serial).await?;
        let session = self.inner.sessions.restart(serial).await;
        self.publish(ServerEvent::SessionUpdated {
            session: session.clone(),
        });
        Ok(session)
    }

    async fn require_local_serial(&self, serial: &str) -> Result<(), String> {
        let devices = self.list_local_devices().await;
        if devices.iter().any(|d| d.serial == serial || d.id == serial) {
            Ok(())
        } else {
            Err(format!("unknown local device serial/id: {serial}"))
        }
    }

    pub async fn remote_owner(&self, serial_or_id: &str) -> Option<String> {
        if self.inner.role != Role::Controller {
            return None;
        }
        // Prefer remote only when not local.
        let local = self.list_local_devices().await;
        if local
            .iter()
            .any(|d| d.serial == serial_or_id || d.id == serial_or_id)
        {
            return None;
        }
        self.inner.mesh.owner_of_serial(serial_or_id).await
    }

    /// Resolve a path param that may be id or serial → canonical serial.
    pub async fn resolve_serial(&self, id_or_serial: &str) -> Result<String, String> {
        let devices = self.list_devices().await;
        devices
            .iter()
            .find(|d| d.serial == id_or_serial || d.id == id_or_serial)
            .map(|d| d.serial.clone())
            .ok_or_else(|| format!("unknown device serial/id: {id_or_serial}"))
    }

    async fn inject_pointer_group(
        &self,
        devices: &[Device],
        phase: PointerPhase,
        tool: PointerTool,
        point: NormalizedPoint,
        frame_width: u32,
        frame_height: u32,
    ) -> Vec<MappedTap> {
        let mut mapped = Vec::with_capacity(devices.len());
        for device in devices {
            // Each phone's scrcpy server ignores a touch whose width/height
            // is not that phone's encoded video. The picture on screen is
            // only one of the targets, so reuse its size only when this
            // device has not published its own yet.
            let mut size = self
                .inner
                .sessions
                .video_display_size(&device.serial)
                .await;
            if size.is_none() && frame_width > 0 && frame_height > 0 {
                let session = self.inner.sessions.get_session(&device.serial).await;
                let running = session
                    .as_ref()
                    .map(|status| {
                        matches!(status.stream, StreamState::Streaming | StreamState::Starting)
                    })
                    .unwrap_or(false);
                if !running {
                    let _ = self
                        .inner
                        .sessions
                        .ensure_streaming(&device.serial)
                        .await;
                    size = self
                        .inner
                        .sessions
                        .video_display_size(&device.serial)
                        .await;
                }
            }
            let (width, height) = size.unwrap_or((frame_width, frame_height));
            let mut tap = frame_tap(point, device, width, height);
            if width == 0 || height == 0 {
                // Do not fall through to wm size. Scrcpy drops a touch whose
                // screen size is not the encoded video size, and a 0×0 touch
                // is not a guess at that size.
                tap.x = 0;
                tap.y = 0;
                tap.width = 0;
                tap.height = 0;
                tap.inject = InjectStatus::Error;
                tap.inject_detail = Some("video size unknown — wait for the picture".into());
                mapped.push(tap);
                continue;
            }
            let result = self
                .inner
                .sessions
                .inject_pointer(
                    &device.serial,
                    phase,
                    tool,
                    tap.x,
                    tap.y,
                    tap.width,
                    tap.height,
                )
                .await;
            tap.inject = result.status;
            tap.inject_detail = result.detail;
            mapped.push(tap);
        }
        mapped
    }

    async fn proxy_gesture_http(
        &self,
        host_id: &str,
        request: &GestureRequest,
    ) -> Result<Vec<NavTargetResult>, String> {
        let Some(base) = self.inner.mesh.http_base(host_id).await else {
            return Err(format!("agent {host_id} has no http_base"));
        };
        let url = format!("{}/api/input/gesture", base.trim_end_matches('/'));
        let body = serde_json::to_vec(request).map_err(|e| e.to_string())?;
        let (status, text) =
            http_post_bytes(&url, &[("Content-Type", "application/json"), ("x-adboard-token", self.api_token())], &body).await?;
        if !(200..300).contains(&status) {
            return Err(if text.trim().is_empty() {
                format!("gesture proxy HTTP {status}")
            } else {
                text
            });
        }
        let response: GestureResult =
            serde_json::from_str(&text).map_err(|e| format!("gesture proxy JSON: {e}"))?;
        Ok(response.targets)
    }

    pub(crate) async fn local_serial_set(&self) -> std::collections::HashSet<String> {
        self.list_local_devices()
            .await
            .iter()
            .map(|d| d.serial.clone())
            .collect()
    }

    /// Install one APK on the same targets nav would use.
    pub async fn handle_install(
        &self,
        mode: ControlMode,
        target_ids: &[String],
        filename: &str,
        bytes: &[u8],
    ) -> Result<InstallBroadcast, String> {
        let devices = self.resolve_targets(target_ids).await?;
        if devices.is_empty() {
            return Err("no online targets for install".into());
        }

        let local_serials = self.local_serial_set().await;
        let mut local_group = Vec::new();
        let mut by_remote: HashMap<String, Vec<Device>> = HashMap::new();
        for d in devices {
            if local_serials.contains(&d.serial) {
                local_group.push(d);
            } else {
                by_remote
                    .entry(d.effective_host_id().to_string())
                    .or_default()
                    .push(d);
            }
        }

        let mut results = Vec::new();
        let mut ids = Vec::new();
        if !local_group.is_empty() {
            for d in &local_group {
                ids.push(d.id.clone());
            }
            results.extend(self.install_local_group(&local_group, bytes).await);
        }

        for (host_id, group) in by_remote {
            if self.inner.role != Role::Controller {
                return Err(format!("cannot reach remote host {host_id} from agent"));
            }
            for d in &group {
                ids.push(d.id.clone());
            }
            let group_ids: Vec<String> = group.iter().map(|d| d.id.clone()).collect();
            match self
                .proxy_install_http(&host_id, mode, &group_ids, filename, bytes)
                .await
            {
                Ok(remote) => results.extend(remote),
                Err(e) => {
                    for d in &group {
                        results.push(install_error(d, e.clone()));
                    }
                }
            }
        }

        Ok(InstallBroadcast::new(mode, ids, results))
    }

    async fn install_local_group(&self, devices: &[Device], bytes: &[u8]) -> Vec<NavTargetResult> {
        let staged = crate::paths::TempFile::new("adboard", ".apk");
        let path = staged.path().to_path_buf();
        if let Err(e) = tokio::fs::write(&path, bytes).await {
            return devices
                .iter()
                .map(|d| install_error(d, format!("failed to store apk: {e}")))
                .collect();
        }
        let sessions = &self.inner.sessions;
        let apk = &path;
        // Installs move a whole file over USB, so only a few run at once.
        let results = fanout::fan_out(devices.to_vec(), fanout::TRANSFER_LIMIT, |device| async move {
            let result = sessions.install_apk(&device.serial, apk).await;
            NavTargetResult {
                device_id: device.id.clone(),
                device_name: device.name.clone(),
                inject: result.status,
                detail: result.detail,
            }
        })
        .await;
        drop(staged);
        results
    }

    async fn proxy_install_http(
        &self,
        host_id: &str,
        mode: ControlMode,
        target_ids: &[String],
        filename: &str,
        bytes: &[u8],
    ) -> Result<Vec<NavTargetResult>, String> {
        let Some(base) = self.inner.mesh.http_base(host_id).await else {
            return Err(format!(
                "agent {host_id} has no http_base — cannot install APK"
            ));
        };
        let url = format!("{}/api/input/install", base.trim_end_matches('/'));
        let mode_name = match mode {
            ControlMode::Selected => "selected",
            ControlMode::Multi => "multi",
            ControlMode::All => "all",
        };
        let targets_joined = target_ids.join(",");
        let (status, body) = http_post_bytes(
            &url,
            &[
                ("Content-Type", "application/vnd.android.package-archive"),
                ("x-adboard-token", self.api_token()),
                ("X-Adboard-Mode", mode_name),
                ("X-Adboard-Targets", &targets_joined),
                ("X-Adboard-Filename", filename),
                // Legacy compatibility: agents from before the rename read these names.
                ("X-Phonecontrol-Mode", mode_name),
                ("X-Phonecontrol-Targets", &targets_joined),
                ("X-Phonecontrol-Filename", filename),
            ],
            bytes,
        )
        .await?;
        if !(200..300).contains(&status) {
            return Err(if body.trim().is_empty() {
                format!("install proxy HTTP {status}")
            } else {
                body
            });
        }
        let broadcast: InstallBroadcast = serde_json::from_str(&body)
            .map_err(|e| format!("install proxy returned invalid JSON: {e}"))?;
        Ok(broadcast.targets)
    }

    pub async fn handle_command(
        &self,
        request: DeviceCommandRequest,
    ) -> Result<DeviceCommandResponse, String> {
        let op = request.op.trim().to_string();
        if op.is_empty() {
            return Err("missing operation".into());
        }
        let devices = if op == "reconnect" || op == "restartAdb" {
            self.resolve_known(&request.target_ids).await?
        } else {
            self.resolve_targets(&request.target_ids).await?
        };
        if devices.is_empty() {
            return Err("no targets for command".into());
        }

        let local_serials = self.local_serial_set().await;
        let mut local_group = Vec::new();
        let mut by_remote: HashMap<String, Vec<Device>> = HashMap::new();
        for device in devices {
            if local_serials.contains(&device.serial) {
                local_group.push(device);
            } else {
                by_remote
                    .entry(device.effective_host_id().to_string())
                    .or_default()
                    .push(device);
            }
        }

        let command = &request;
        let op = &op;
        let local_run = fanout::fan_out(local_group, fanout::DEFAULT_LIMIT, |device| async move {
            self.command_one(
                &device,
                op,
                command.arg.as_deref(),
                command.arg2.as_deref(),
            )
            .await
        });
        let remote_run = fanout::fan_out_remote(
            by_remote,
            |host_id, group| {
                let forwarded = DeviceCommandRequest {
                    target_ids: group.iter().map(|d| d.id.clone()).collect(),
                    op: op.clone(),
                    arg: command.arg.clone(),
                    arg2: command.arg2.clone(),
                };
                async move {
                    if self.inner.role != Role::Controller {
                        return Err(format!("cannot reach remote host {host_id}"));
                    }
                    self.proxy_command_http(&host_id, &forwarded).await
                }
            },
            |device, error| op_error(device, error.to_string()),
        );
        let (mut results, remote) = tokio::join!(local_run, remote_run);
        results.extend(remote);

        Ok(DeviceCommandResponse {
            id: format!("cmd-{}", uuid::Uuid::new_v4()),
            op: op.clone(),
            results,
        })
    }

    async fn command_one(
        &self,
        device: &Device,
        op: &str,
        arg: Option<&str>,
        arg2: Option<&str>,
    ) -> DeviceOpResult {
        if op == "reconnect" {
            return match self.restart_session(&device.serial).await {
                Ok(session) => op_ok(device, session.note),
                Err(error) => op_error(device, error),
            };
        }
        if op == "displaySize" {
            return self.apply_display_size(device, arg).await;
        }
        if op == "rotate" {
            return match self.inner.sessions.rotate_device(&device.serial).await {
                Ok(()) => op_ok(device, "rotated".into()),
                // Mock fleet (no adb): the test-pattern stream has no control socket.
                Err(_) if self.inner.adb_path.is_none() => op_ok(device, "rotated (mock phone)".into()),
                Err(error) => op_error(device, error),
            };
        }
        if matches!(op, "tap" | "swipe" | "longPress") {
            return self.gesture(device, op, arg, arg2).await;
        }
        let Some(adb) = self.inner.adb_path.clone() else {
            return match op {
                "info" => op_ok(
                    device,
                    format!(
                        "model: {}\nandroid: {}\nserial: {}\nram: \nstorage: \nlevel: {}\ntemperature: {}",
                        device.model,
                        device.android_version,
                        device.serial,
                        device.battery.map(|n| n.to_string()).unwrap_or_default(),
                        device
                            .temperature_c
                            .map(|n| format!("{}", (n * 10.0).round() as i32))
                            .unwrap_or_default()
                    ),
                ),
                "mute" => match crate::device_ops::mute_arg(arg) {
                    Ok(want) => {
                        let mut map = mock_muted().lock().unwrap_or_else(|e| e.into_inner());
                        if let Some(on) = want {
                            map.insert(device.serial.clone(), on);
                        }
                        let on = map.get(&device.serial).copied().unwrap_or(false);
                        op_ok(device, if on { "on".into() } else { "off".into() })
                    }
                    Err(error) => op_error(device, error),
                },
                "stayAwake" => match crate::device_ops::stay_awake_arg(arg) {
                    Ok(want) => {
                        let mut map = mock_stay_awake().lock().unwrap_or_else(|e| e.into_inner());
                        if let Some(on) = want {
                            map.insert(device.serial.clone(), on);
                        }
                        let on = map.get(&device.serial).copied().unwrap_or(false);
                        op_ok(device, if on { "on".into() } else { "off".into() })
                    }
                    Err(error) => op_error(device, error),
                },
                "packages" => op_ok(
                    device,
                    {
                        // Mock phones: a few apps the user installed, plus system ones for "all".
                        let user = "package:jp.goodsmile.grandsummonersglobal_android\npackage:org.telegram.messenger\npackage:org.zwanoo.android.speedtest";
                        let system = "package:com.android.settings\npackage:com.android.chrome\npackage:com.google.android.youtube\npackage:com.android.camera";
                        if arg.map(str::trim) == Some("user") { user.to_string() } else { format!("{system}\n{user}") }
                    },
                ),
                "files" => op_ok(
                    device,
                    "Download/\nDCIM/\nPictures/\nMovies/\nAndroid/\nScreenshot_2026-09-28-14-08-00-very-long-camera-roll-name.png\n".into(),
                ),
                // Mock phones "open" apps so macros with app steps can be tried.
                "launch" | "forceStop" if arg.is_some_and(crate::device_ops::valid_package) => {
                    op_ok(device, format!("{} {} (mock phone)", if op == "launch" { "opened" } else { "stopped" }, arg.unwrap_or_default()))
                }
                "screenshot" if arg != Some("device") => {
                    match crate::device_ops::write_placeholder_screenshot(
                        &crate::device_ops::files_root(),
                        &device.serial,
                    ) {
                        Ok(rel) => op_ok(device, rel),
                        Err(error) => op_error(device, error),
                    }
                }
                _ => match crate::app_controls::mock::run(&device.serial, op, arg, arg2) {
                    Some(Ok(output)) => op_ok(device, output),
                    Some(Err(error)) => op_error(device, error),
                    None => op_error(device, "adb is not available"),
                },
            };
        };
        match crate::device_ops::run_adb_op(
            &adb,
            &device.serial,
            op,
            arg,
            arg2,
            &crate::device_ops::files_root(),
        )
        .await
        {
            Ok(output) => op_ok(device, output),
            Err(error) => op_error(device, error),
        }
    }

    async fn apply_display_size(&self, device: &Device, arg: Option<&str>) -> DeviceOpResult {
        let spec = arg.unwrap_or("").trim();
        if let Err(error) = adb::display_size_command(spec) {
            return op_error(device, error);
        }
        let Some(adb) = self.inner.adb_path.clone() else {
            return op_error(device, "adb is not available");
        };
        let output = match crate::device_ops::set_display_size(&adb, &device.serial, spec).await {
            Ok(output) => output,
            Err(error) => return op_error(device, error),
        };
        note_display_size_override(
            &mut self
                .inner
                .display_size_overrides
                .lock()
                .unwrap_or_else(|error| error.into_inner()),
            &device.serial,
            spec,
        );
        self.inner
            .resolution_refresh
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(device.serial.clone());
        let session = self.inner.sessions.get_session(&device.serial).await;
        let live = session
            .as_ref()
            .map(|status| {
                matches!(
                    status.stream,
                    StreamState::Streaming | StreamState::Starting | StreamState::Error
                )
            })
            .unwrap_or(false);
        if live {
            if let Err(error) = self.restart_session(&device.serial).await {
                return op_error(
                    device,
                    format!("{output}, but the stream did not restart: {error}"),
                );
            }
        }
        op_ok(device, output)
    }

    /// Best-effort `wm size reset` for phones we resized. Safe if the cable is
    /// already gone — the override flag stays so reconnect can retry.
    async fn reset_overridden_display_size(&self, serial: &str) {
        let needs_reset = self
            .inner
            .display_size_overrides
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .contains(serial);
        if !needs_reset {
            return;
        }
        let Some(adb) = self.inner.adb_path.clone() else {
            return;
        };
        match crate::device_ops::set_display_size(&adb, serial, "reset").await {
            Ok(output) => {
                info!(%serial, %output, "reset wm size after disconnect");
                self.inner
                    .display_size_overrides
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .remove(serial);
                self.inner
                    .resolution_refresh
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .insert(serial.to_string());
            }
            Err(error) => {
                warn!(
                    %serial,
                    %error,
                    "could not reset wm size; will retry when the phone returns"
                );
            }
        }
    }

    /// Set `wm size` to ADBOARD_CONNECT_DISPLAY_SIZE when a phone comes online.
    async fn apply_connect_display_size(&self, serial: &str) {
        let Some(size) = connect_display_size() else {
            return;
        };
        let Some(adb) = self.inner.adb_path.clone() else {
            return;
        };
        match crate::device_ops::set_display_size(&adb, serial, size).await {
            Ok(output) => {
                info!(%serial, %size, %output, "set wm size on connect");
                note_display_size_override(
                    &mut self
                        .inner
                        .display_size_overrides
                        .lock()
                        .unwrap_or_else(|error| error.into_inner()),
                    serial,
                    size,
                );
                self.inner
                    .resolution_refresh
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .insert(serial.to_string());
            }
            Err(error) => {
                warn!(%serial, %size, %error, "could not set wm size on connect");
            }
        }
    }

    async fn gesture(
        &self,
        device: &Device,
        op: &str,
        arg: Option<&str>,
        _arg2: Option<&str>,
    ) -> DeviceOpResult {
        let numbers = parse_fractions(arg.unwrap_or(""));
        let result = match op {
            "tap" if numbers.len() == 2 => {
                let down = self
                    .inner
                    .sessions
                    .inject_normalized(&device.serial, PointerPhase::Down, numbers[0], numbers[1])
                    .await;
                if down.status == InjectStatus::Error {
                    down
                } else {
                    self.inner
                        .sessions
                        .inject_normalized(&device.serial, PointerPhase::Up, numbers[0], numbers[1])
                        .await
                }
            }
            "longPress" if numbers.len() == 2 => {
                let down = self
                    .inner
                    .sessions
                    .inject_normalized(&device.serial, PointerPhase::Down, numbers[0], numbers[1])
                    .await;
                if down.status == InjectStatus::Error {
                    down
                } else {
                    tokio::time::sleep(Duration::from_millis(600)).await;
                    self.inner
                        .sessions
                        .inject_normalized(&device.serial, PointerPhase::Up, numbers[0], numbers[1])
                        .await
                }
            }
            "swipe" if numbers.len() == 4 => {
                let down = self
                    .inner
                    .sessions
                    .inject_normalized(&device.serial, PointerPhase::Down, numbers[0], numbers[1])
                    .await;
                if down.status == InjectStatus::Error {
                    down
                } else {
                    for step in 1..=4 {
                        let t = f64::from(step) / 4.0;
                        let x = numbers[0] + (numbers[2] - numbers[0]) * t;
                        let y = numbers[1] + (numbers[3] - numbers[1]) * t;
                        let moved = self
                            .inner
                            .sessions
                            .inject_normalized(&device.serial, PointerPhase::Move, x, y)
                            .await;
                        if moved.status == InjectStatus::Error {
                            return op_error(
                                device,
                                moved.detail.unwrap_or_else(|| "swipe failed".into()),
                            );
                        }
                    }
                    self.inner
                        .sessions
                        .inject_normalized(&device.serial, PointerPhase::Up, numbers[2], numbers[3])
                        .await
                }
            }
            _ => {
                return op_error(device, "tap and long press need x,y; swipe needs x,y,x2,y2");
            }
        };
        match result.status {
            InjectStatus::Error => op_error(
                device,
                result.detail.unwrap_or_else(|| "gesture failed".into()),
            ),
            _ => op_ok(device, result.detail.unwrap_or_else(|| "ok".into())),
        }
    }

    async fn proxy_command_http(
        &self,
        host_id: &str,
        request: &DeviceCommandRequest,
    ) -> Result<Vec<DeviceOpResult>, String> {
        let Some(base) = self.inner.mesh.http_base(host_id).await else {
            return Err(format!("agent {host_id} has no http_base"));
        };
        let url = format!("{}/api/device/command", base.trim_end_matches('/'));
        let body = serde_json::to_vec(request).map_err(|e| e.to_string())?;
        let (status, text) =
            http_post_bytes(&url, &[("Content-Type", "application/json"), ("x-adboard-token", self.api_token())], &body).await?;
        if !(200..300).contains(&status) {
            return Err(if text.trim().is_empty() {
                format!("command proxy HTTP {status}")
            } else {
                text
            });
        }
        let response: DeviceCommandResponse =
            serde_json::from_str(&text).map_err(|e| format!("command proxy JSON: {e}"))?;
        Ok(response.results)
    }

    pub async fn push_file(
        &self,
        target_ids: &[String],
        filename: &str,
        dest: &str,
        bytes: &[u8],
    ) -> Result<DeviceCommandResponse, String> {
        let devices = self.resolve_targets(target_ids).await?;
        if devices.is_empty() {
            return Err("no online targets for upload".into());
        }
        let safe_name = std::path::Path::new(filename)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("upload.bin");
        let staged = crate::paths::TempFile::new("adboard-push", "");
        let local = staged.path().to_path_buf();
        tokio::fs::write(&local, bytes)
            .await
            .map_err(|e| format!("failed to store upload: {e}"))?;
        let dest = if dest.ends_with('/') {
            format!("{dest}{safe_name}")
        } else {
            dest.to_string()
        };
        let Some(adb) = self.inner.adb_path.clone() else {
            return Ok(DeviceCommandResponse {
                id: format!("push-{}", uuid::Uuid::new_v4()),
                op: "push".into(),
                results: devices
                    .iter()
                    .map(|d| op_error(d, "adb is not available"))
                    .collect(),
            });
        };
        let (adb_ref, local_ref, dest_ref) = (&adb, &local, &dest);
        let results = fanout::fan_out(devices.clone(), fanout::TRANSFER_LIMIT, |device| async move {
            match crate::device_ops::adb_push(adb_ref, &device.serial, local_ref, dest_ref).await {
                Ok(output) => op_ok(&device, output),
                Err(error) => op_error(&device, error),
            }
        })
        .await;
        drop(staged);
        Ok(DeviceCommandResponse {
            id: format!("push-{}", uuid::Uuid::new_v4()),
            op: "push".into(),
            results,
        })
    }

    pub async fn pull_file(
        &self,
        device_id: &str,
        remote: &str,
    ) -> Result<(String, Vec<u8>), String> {
        let devices = self
            .resolve_targets(std::slice::from_ref(&device_id.to_string()))
            .await?;
        let Some(device) = devices.into_iter().next() else {
            return Err("device is not online".into());
        };
        let Some(adb) = self.inner.adb_path.clone() else {
            return Err("adb is not available".into());
        };
        let staged = crate::paths::TempFile::new("adboard-pull", "");
        let local = staged.path().to_path_buf();
        crate::device_ops::adb_pull(&adb, &device.serial, remote, &local).await?;
        let bytes = tokio::fs::read(&local)
            .await
            .map_err(|e| format!("failed to read pulled file: {e}"))?;
        drop(staged);
        let name = remote
            .rsplit('/')
            .next()
            .unwrap_or("download.bin")
            .to_string();
        Ok((name, bytes))
    }

    pub async fn handle_scrcpy_options(
        &self,
        body: ScrcpyOptionsRequest,
    ) -> Result<ScrcpyOptionsResponse, String> {
        let devices = self.resolve_targets(&body.target_ids).await?;
        if devices.is_empty() {
            return Err("no online targets".into());
        }
        let quality = SessionManager::parse_quality(&body.quality)?.to_string();
        let prefs = ScrcpyPrefs {
            quality: quality.clone(),
            audio: body.audio,
            screen_off: body.screen_off,
            max_size: body.max_size,
            video_bit_rate: body.video_bit_rate,
            max_fps: body.max_fps,
        };
        let local_serials = self.local_serial_set().await;
        let mut local = Vec::new();
        let mut by_remote: HashMap<String, Vec<Device>> = HashMap::new();
        for device in devices {
            if local_serials.contains(&device.serial) {
                local.push(device);
            } else {
                by_remote
                    .entry(device.effective_host_id().to_string())
                    .or_default()
                    .push(device);
            }
        }

        let mut restarted = Vec::new();
        let mut results = Vec::new();
        if !local.is_empty() {
            let serials: Vec<String> = local.iter().map(|d| d.serial.clone()).collect();
            let applied = self
                .inner
                .sessions
                .apply_options(prefs.clone(), &serials)
                .await?;
            restarted.extend(applied.restarted.clone());
            for (serial, result) in applied.power {
                let device = local.iter().find(|d| d.serial == serial);
                let (ok, error) = match result {
                    Ok(()) => (true, None),
                    Err(e) => (false, Some(e)),
                };
                results.push(DeviceOpResult {
                    device_id: device
                        .map(|d| d.id.clone())
                        .unwrap_or_else(|| serial.clone()),
                    device_name: device.map(|d| d.name.clone()).unwrap_or_default(),
                    ok,
                    output: None,
                    error,
                });
            }
            for serial in applied.restarted {
                if let Some(session) = self.inner.sessions.get_session(&serial).await {
                    self.publish(ServerEvent::SessionUpdated { session });
                }
            }
        }

        for (host_id, group) in by_remote {
            let ids: Vec<String> = group.iter().map(|d| d.id.clone()).collect();
            let forward = ScrcpyOptionsRequest {
                mode: ControlMode::Selected,
                target_ids: ids,
                quality: quality.clone(),
                audio: body.audio,
                screen_off: body.screen_off,
                max_size: body.max_size,
                video_bit_rate: body.video_bit_rate,
                max_fps: body.max_fps,
            };
            match self
                .proxy_json::<ScrcpyOptionsRequest, ScrcpyOptionsResponse>(
                    &host_id,
                    "/api/scrcpy/options",
                    &forward,
                )
                .await
            {
                Ok(remote) => {
                    restarted.extend(remote.restarted);
                    results.extend(remote.results);
                }
                Err(e) => {
                    for device in group {
                        results.push(op_error(&device, e.clone()));
                    }
                }
            }
        }

        let stored = self.inner.sessions.prefs().await;
        Ok(ScrcpyOptionsResponse {
            quality,
            audio: body.audio,
            screen_off: body.screen_off,
            max_size: stored.max_size,
            video_bit_rate: stored.video_bit_rate,
            max_fps: stored.max_fps,
            restarted,
            results,
        })
    }

    pub async fn handle_clipboard_set(
        &self,
        body: ClipboardSetRequest,
    ) -> Result<ClipboardResponse, String> {
        if body.text.len() > 256 * 1024 {
            return Err("clipboard text is too long".into());
        }
        let devices = self.resolve_targets(&body.target_ids).await?;
        if devices.is_empty() {
            return Err("no online targets".into());
        }
        let local_serials = self.local_serial_set().await;
        let mut results = Vec::new();
        let mut by_remote: HashMap<String, Vec<Device>> = HashMap::new();
        for device in devices {
            if local_serials.contains(&device.serial) {
                match self
                    .inner
                    .sessions
                    .set_clipboard(&device.serial, &body.text, body.paste)
                    .await
                {
                    Ok(()) => results.push(DeviceOpResult {
                        device_id: device.id.clone(),
                        device_name: device.name.clone(),
                        ok: true,
                        output: None,
                        error: None,
                    }),
                    Err(e) => results.push(op_error(&device, e)),
                }
            } else {
                by_remote
                    .entry(device.effective_host_id().to_string())
                    .or_default()
                    .push(device);
            }
        }
        for (host_id, group) in by_remote {
            let ids: Vec<String> = group.iter().map(|d| d.id.clone()).collect();
            let forward = ClipboardSetRequest {
                mode: ControlMode::Selected,
                target_ids: ids,
                text: body.text.clone(),
                paste: body.paste,
            };
            match self
                .proxy_json::<ClipboardSetRequest, ClipboardResponse>(
                    &host_id,
                    "/api/input/clipboard",
                    &forward,
                )
                .await
            {
                Ok(remote) => results.extend(remote.results),
                Err(e) => {
                    for device in group {
                        results.push(op_error(&device, e.clone()));
                    }
                }
            }
        }
        Ok(ClipboardResponse { results })
    }

    pub async fn handle_clipboard_pull(
        &self,
        body: ClipboardPullRequest,
    ) -> Result<ClipboardResponse, String> {
        let devices = self.resolve_targets(&body.target_ids).await?;
        if devices.is_empty() {
            return Err("no online targets".into());
        }
        let local_serials = self.local_serial_set().await;
        let mut results = Vec::new();
        let mut by_remote: HashMap<String, Vec<Device>> = HashMap::new();
        for device in devices {
            if local_serials.contains(&device.serial) {
                match self.inner.sessions.pull_clipboard(&device.serial).await {
                    Ok(text) => results.push(DeviceOpResult {
                        device_id: device.id.clone(),
                        device_name: device.name.clone(),
                        ok: true,
                        output: Some(text),
                        error: None,
                    }),
                    Err(e) => results.push(op_error(&device, e)),
                }
            } else {
                by_remote
                    .entry(device.effective_host_id().to_string())
                    .or_default()
                    .push(device);
            }
        }
        for (host_id, group) in by_remote {
            let ids: Vec<String> = group.iter().map(|d| d.id.clone()).collect();
            let forward = ClipboardPullRequest {
                mode: ControlMode::Selected,
                target_ids: ids,
            };
            match self
                .proxy_json::<ClipboardPullRequest, ClipboardResponse>(
                    &host_id,
                    "/api/input/clipboard/pull",
                    &forward,
                )
                .await
            {
                Ok(remote) => results.extend(remote.results),
                Err(e) => {
                    for device in group {
                        results.push(op_error(&device, e.clone()));
                    }
                }
            }
        }
        Ok(ClipboardResponse { results })
    }

    async fn split_targets(
        &self,
        target_ids: &[String],
    ) -> Result<(Vec<Device>, HashMap<String, Vec<Device>>), String> {
        let devices = self.resolve_targets(target_ids).await?;
        if devices.is_empty() {
            return Err("no online targets".into());
        }
        let local_serials = self.local_serial_set().await;
        let mut local = Vec::new();
        let mut by_remote: HashMap<String, Vec<Device>> = HashMap::new();
        for device in devices {
            if local_serials.contains(&device.serial) {
                local.push(device);
            } else {
                by_remote
                    .entry(device.effective_host_id().to_string())
                    .or_default()
                    .push(device);
            }
        }
        Ok((local, by_remote))
    }

    async fn proxy_json<T, R>(&self, host_id: &str, path: &str, body: &T) -> Result<R, String>
    where
        T: serde::Serialize,
        R: serde::de::DeserializeOwned,
    {
        if self.inner.role != Role::Controller {
            return Err(format!("cannot reach remote host {host_id} from agent"));
        }
        let base = self
            .remote_http_base(host_id)
            .await
            .ok_or_else(|| format!("agent {host_id} did not advertise http_base"))?;
        let url = format!(
            "{}/{}",
            base.trim_end_matches('/'),
            path.trim_start_matches('/')
        );
        let bytes = serde_json::to_vec(body).map_err(|e| e.to_string())?;
        let (status, text) =
            http_post_bytes(&url, &[("Content-Type", "application/json"), ("x-adboard-token", self.api_token())], &bytes).await?;
        if status != 200 {
            return Err(if text.trim().is_empty() {
                format!("remote {path} returned {status}")
            } else {
                text
            });
        }
        serde_json::from_str(&text).map_err(|e| format!("remote {path} response: {e}"))
    }

    async fn resolve_known(&self, target_ids: &[String]) -> Result<Vec<Device>, String> {
        let all = self.list_devices().await;
        let mut out = Vec::new();
        for id in target_ids {
            match all.iter().find(|d| d.id == *id || d.serial == *id) {
                Some(device) => out.push(device.clone()),
                None => return Err(format!("unknown device id: {id}")),
            }
        }
        Ok(out)
    }

    async fn resolve_targets(&self, target_ids: &[String]) -> Result<Vec<Device>, String> {
        let all = self.list_devices().await;
        let mut out = Vec::new();
        for id in target_ids {
            match all.iter().find(|d| d.id == *id || d.serial == *id) {
                Some(d) if d.status == DeviceStatus::Online => out.push(d.clone()),
                Some(_) => {}
                None => return Err(format!("unknown device id: {id}")),
            }
        }
        Ok(out)
    }

    async fn resolve_local_targets(&self, target_ids: &[String]) -> Result<Vec<Device>, String> {
        let all = self.list_local_devices().await;
        let mut out = Vec::new();
        for id in target_ids {
            match all.iter().find(|d| d.id == *id || d.serial == *id) {
                Some(d) if d.status == DeviceStatus::Online => out.push(d.clone()),
                Some(_) => {}
                None => return Err(format!("unknown local device id: {id}")),
            }
        }
        Ok(out)
    }

    pub async fn add_wireless(
        &self,
        address: &str,
        port: Option<u16>,
        pairing_port: Option<u16>,
        pairing_code: Option<&str>,
    ) -> Result<(String, String), String> {
        let endpoint = adb::parse_wireless_endpoint(address, port)?;
        let pairing = adb::parse_pairing(pairing_port, pairing_code)?;
        let Some(adb) = self.inner.adb_path.clone() else {
            return Err("adb is not available".into());
        };
        let message = match tokio::time::timeout(
            Duration::from_secs(12),
            adb::connect_wireless(&adb, &endpoint, pairing.as_ref()),
        )
        .await
        {
            Ok(result) => result?,
            Err(_) => return Err("timed out connecting to the phone".into()),
        };
        if let Err(error) = adb::remember_wireless(&endpoint) {
            warn!(%error, "wireless device connected but was not saved");
        }
        Ok((endpoint.display(), message))
    }

    pub fn list_wireless(&self) -> Vec<String> {
        adb::load_wireless()
            .into_iter()
            .map(|endpoint| endpoint.display())
            .collect()
    }

    pub async fn remove_wireless(&self, address: &str) -> Result<(String, String), String> {
        let endpoint = adb::parse_wireless_endpoint(address, None)?;
        let message = if let Some(adb) = self.inner.adb_path.clone() {
            match tokio::time::timeout(
                Duration::from_secs(8),
                adb::disconnect_wireless(&adb, &endpoint),
            )
            .await
            {
                Ok(Ok(message)) => message,
                Ok(Err(error)) => {
                    let lower = error.to_ascii_lowercase();
                    if lower.contains("no such") || lower.contains("not connected") {
                        format!("removed {}", endpoint.display())
                    } else {
                        let _ = adb::forget_wireless(&endpoint);
                        return Err(error);
                    }
                }
                Err(_) => {
                    let _ = adb::forget_wireless(&endpoint);
                    return Err("timed out disconnecting the phone".into());
                }
            }
        } else {
            "removed from the saved list".into()
        };
        adb::forget_wireless(&endpoint)?;
        Ok((endpoint.display(), message))
    }

    pub fn start_qr_pair(&self) -> Result<QrPairInfo, String> {
        let Some(adb) = self.inner.adb_path.clone() else {
            return Err("adb is not available".into());
        };
        let material = adb::generate_qr_material();
        let svg = adb::qr_svg(&material.payload)?;
        let id = uuid::Uuid::new_v4().to_string();
        let (cancel, cancel_rx) = tokio::sync::watch::channel(false);
        {
            let mut pairs = self
                .inner
                .qr_pairs
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            for slot in pairs.values() {
                let _ = slot.cancel.send(true);
            }
            pairs.clear();
            pairs.insert(
                id.clone(),
                QrPairSlot {
                    state: "waiting".into(),
                    message: "Waiting for the phone to scan.".into(),
                    endpoint: None,
                    cancel,
                },
            );
        }
        let state = self.clone();
        let name = material.name;
        let password = material.password;
        let session_id = id.clone();
        tokio::spawn(async move {
            state
                .run_qr_pair(session_id, adb, name, password, cancel_rx)
                .await;
        });
        Ok(QrPairInfo {
            id,
            payload: material.payload,
            svg,
        })
    }

    pub fn qr_pair_status(&self, id: &str) -> Option<QrPairStatus> {
        let pairs = self
            .inner
            .qr_pairs
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        pairs.get(id).map(|slot| QrPairStatus {
            id: id.to_string(),
            state: slot.state.clone(),
            message: slot.message.clone(),
            endpoint: slot.endpoint.clone(),
        })
    }

    pub fn cancel_qr_pair(&self, id: &str) -> bool {
        let pairs = self
            .inner
            .qr_pairs
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(slot) = pairs.get(id) {
            let _ = slot.cancel.send(true);
            true
        } else {
            false
        }
    }

    async fn run_qr_pair(
        &self,
        id: String,
        adb: PathBuf,
        name: String,
        password: String,
        mut cancel: tokio::sync::watch::Receiver<bool>,
    ) {
        let deadline = std::time::Instant::now() + Duration::from_secs(90);
        let mut progress = adb::QrPairProgress::default();
        loop {
            if *cancel.borrow() {
                self.finish_qr(&id, "failed", "QR pairing was cancelled.", None);
                return;
            }
            if std::time::Instant::now() >= deadline {
                self.finish_qr(&id, "failed", "The phone did not scan the QR code.", None);
                return;
            }
            match adb::qr_pair_once(&adb, &name, &password, &mut progress).await {
                Ok(Some(endpoint)) => {
                    if let Err(error) = adb::remember_wireless(&endpoint) {
                        warn!(%error, "phone paired but the address was not saved");
                    }
                    let shown = endpoint.display();
                    self.finish_qr(
                        &id,
                        "paired",
                        &format!("connected to {shown}"),
                        Some(shown),
                    );
                    return;
                }
                Ok(None) => {}
                Err(error) => {
                    self.finish_qr(&id, "failed", &error, None);
                    return;
                }
            }
            tokio::select! {
                changed = cancel.changed() => {
                    if changed.is_err() || *cancel.borrow() {
                        self.finish_qr(&id, "failed", "QR pairing was cancelled.", None);
                        return;
                    }
                }
                _ = tokio::time::sleep(Duration::from_secs(1)) => {}
            }
        }
    }

    fn finish_qr(&self, id: &str, state: &str, message: &str, endpoint: Option<String>) {
        let mut pairs = self
            .inner
            .qr_pairs
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(slot) = pairs.get_mut(id) {
            if slot.state == "waiting" || state == "paired" {
                slot.state = state.to_string();
                slot.message = message.to_string();
                slot.endpoint = endpoint;
            }
        }
    }

}

/// Track ADBoard `wm size` overrides so disconnect can restore the panel.
fn note_display_size_override(overrides: &mut HashSet<String>, serial: &str, spec: &str) {
    let spec = spec.trim();
    if spec.is_empty() || spec == "reset" || spec == "native" {
        overrides.remove(serial);
    } else {
        overrides.insert(serial.to_string());
    }
}

fn devices_equal(a: &[Device], b: &[Device]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b.iter()).all(|(x, y)| {
        x.serial == y.serial
            && x.status == y.status
            && x.model == y.model
            && x.resolution.width == y.resolution.width
            && x.resolution.height == y.resolution.height
            && x.connection == y.connection
            && x.host_id == y.host_id
            && x.battery == y.battery
            && temp_same(x.temperature_c, y.temperature_c)
            && temp_same(x.cpu_percent, y.cpu_percent)
            && temp_same(x.memory_percent, y.memory_percent)
    })
}

fn temp_same(left: Option<f32>, right: Option<f32>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(a), Some(b)) => (a - b).abs() < 0.05,
        _ => false,
    }
}

/// A phone's operation succeeded and has nothing to report.
fn op_done(device: &Device) -> DeviceOpResult {
    DeviceOpResult {
        device_id: device.id.clone(),
        device_name: device.name.clone(),
        ok: true,
        output: None,
        error: None,
    }
}

fn op_ok(device: &Device, output: String) -> DeviceOpResult {
    DeviceOpResult {
        device_id: device.id.clone(),
        device_name: device.name.clone(),
        ok: true,
        output: Some(output),
        error: None,
    }
}

fn op_error(device: &Device, error: impl Into<String>) -> DeviceOpResult {
    DeviceOpResult {
        device_id: device.id.clone(),
        device_name: device.name.clone(),
        ok: false,
        output: None,
        error: Some(error.into()),
    }
}

fn parse_fractions(raw: &str) -> Vec<f64> {
    raw.split(',')
        .filter_map(|part| part.trim().parse::<f64>().ok())
        .map(|n| if n > 1.0 { n / 100.0 } else { n })
        .collect()
}

fn install_error(device: &Device, detail: String) -> NavTargetResult {
    NavTargetResult {
        device_id: device.id.clone(),
        device_name: device.name.clone(),
        inject: InjectStatus::Error,
        detail: Some(detail),
    }
}

/// Biggest reply accepted from another agent. They answer with small JSON.
const MAX_PROXY_REPLY: usize = 8 * 1024 * 1024;

pub(crate) async fn http_post_bytes(
    url: &str,
    headers: &[(&str, &str)],
    body: &[u8],
) -> Result<(u16, String), String> {
    // Installs and pushes make the other agent run adb on each phone, which
    // can take minutes; everything else is quick.
    let slow = url.contains("/install") || url.contains("/push");
    let reply_wait = if slow { crate::adb::LIMIT_TRANSFER } else { crate::adb::LIMIT_SHELL }
        + Duration::from_secs(30);
    // A slow link still has to move the body: allow 256 KiB/s on top of 30 s.
    let send_wait = Duration::from_secs(30 + (body.len() / (256 * 1024)) as u64);
    http_post_limited(url, headers, body, Duration::from_secs(5), send_wait, reply_wait).await
}

/// POST over plain HTTP with a limit on connecting, sending and waiting for
/// the reply, so an agent that is gone or stuck cannot hold a request.
async fn http_post_limited(
    url: &str,
    headers: &[(&str, &str)],
    body: &[u8],
    connect_wait: Duration,
    send_wait: Duration,
    reply_wait: Duration,
) -> Result<(u16, String), String> {
    let rest = url
        .strip_prefix("http://")
        .ok_or_else(|| format!("install proxy only supports http:// bases, got {url}"))?;
    let (hostport, path) = match rest.split_once('/') {
        Some((host, path)) => (host, format!("/{path}")),
        None => (rest, "/".to_string()),
    };
    if hostport.is_empty() {
        return Err("install proxy URL is missing a host".into());
    }
    let mut header = format!(
        "POST {path} HTTP/1.1\r\nHost: {hostport}\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    );
    for (name, value) in headers {
        if value.contains('\r') || value.contains('\n') {
            return Err("invalid install proxy header".into());
        }
        header.push_str(name);
        header.push_str(": ");
        header.push_str(value);
        header.push_str("\r\n");
    }
    header.push_str("\r\n");

    let mut stream = tokio::time::timeout(connect_wait, TcpStream::connect(hostport))
        .await
        .map_err(|_| format!("agent at {hostport} did not answer within {} s", connect_wait.as_secs().max(1)))?
        .map_err(|e| format!("install proxy connect failed: {e}"))?;
    let send = async {
        stream.write_all(header.as_bytes()).await?;
        stream.write_all(body).await
    };
    tokio::time::timeout(send_wait, send)
        .await
        .map_err(|_| format!("sending to {hostport} timed out"))?
        .map_err(|e| format!("install proxy write failed: {e}"))?;
    let mut buf = Vec::new();
    let mut limited = (&mut stream).take(MAX_PROXY_REPLY as u64 + 1);
    tokio::time::timeout(reply_wait, limited.read_to_end(&mut buf))
        .await
        .map_err(|_| format!("agent at {hostport} sent no reply within {} s", reply_wait.as_secs().max(1)))?
        .map_err(|e| format!("install proxy read failed: {e}"))?;
    if buf.len() > MAX_PROXY_REPLY {
        return Err(format!("agent at {hostport} sent a reply larger than {} MiB", MAX_PROXY_REPLY / (1024 * 1024)));
    }
    let text = String::from_utf8_lossy(&buf);
    let (head, resp_body) = text
        .split_once("\r\n\r\n")
        .ok_or_else(|| "install proxy returned a short HTTP response".to_string())?;
    let status_line = head.lines().next().unwrap_or("");
    let code = status_line
        .split_whitespace()
        .nth(1)
        .unwrap_or("0")
        .parse::<u16>()
        .unwrap_or(0);
    Ok((code, resp_body.to_string()))
}

fn resolve_api_token() -> String {
    match crate::env::var("TOKEN") {
        Ok(value) if !value.trim().is_empty() => {
            info!("ADBOARD_TOKEN is set — API calls require x-adboard-token");
            value
        }
        _ => {
            let token = uuid::Uuid::new_v4().to_string();
            info!(
                "generated API token — same-origin UI reads it from GET /api/bootstrap; set ADBOARD_TOKEN when the bind is not loopback"
            );
            token
        }
    }
}

#[allow(dead_code)]
pub fn inject_summary(targets: &[MappedTap]) -> String {
    let ok = targets
        .iter()
        .filter(|t| t.inject == InjectStatus::Ok)
        .count();
    let stub = targets
        .iter()
        .filter(|t| t.inject == InjectStatus::Stub)
        .count();
    let err = targets
        .iter()
        .filter(|t| t.inject == InjectStatus::Error)
        .count();
    format!("inject ok={ok} stub={stub} error={err}")
}

#[cfg(test)]
mod tests;

/// Mock fleet only: Stay awake state per serial, so the UI round-trips.
fn mock_stay_awake() -> &'static std::sync::Mutex<HashMap<String, bool>> {
    static STATE: std::sync::OnceLock<std::sync::Mutex<HashMap<String, bool>>> =
        std::sync::OnceLock::new();
    STATE.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

/// Mock fleet only: Quiet mode mute state per serial.
fn mock_muted() -> &'static std::sync::Mutex<HashMap<String, bool>> {
    static STATE: std::sync::OnceLock<std::sync::Mutex<HashMap<String, bool>>> =
        std::sync::OnceLock::new();
    STATE.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}
