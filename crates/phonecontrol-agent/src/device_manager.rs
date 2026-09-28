//! Device manager — owns the live fleet, ADB polling, mesh merge, and event fan-out.

use crate::adb::{self, AdbDeviceLine};
use crate::mesh::MeshRegistry;
use crate::mock::{self, MockProfile};
use crate::session::{scrcpy_binary, ScrcpyPrefs, SessionManager};
use crate::video::VideoHub;
use phonecontrol_protocol::{
    map_to_devices, AdbAvailability, ClipboardPullRequest, ClipboardResponse, ClipboardSetRequest,
    ControlMode, Device, DeviceCommandRequest, DeviceCommandResponse, DeviceOpResult, DeviceStatus,
    HostInfo, InjectMode, InjectStatus, InstallBroadcast, KeyInjectRequest, MappedTap,
    NavActionType, NavBroadcast, NavTargetResult, NormalizedPoint, PointerPhase, Role,
    ScrcpyAvailability, ScrcpyOptionsRequest, ScrcpyOptionsResponse, ServerEvent, SessionAction,
    SessionStatus, StreamState, TapBroadcast, TextInjectRequest,
};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{broadcast, RwLock};
use tracing::{info, warn};

const ADB_POLL_SECS: u64 = 2;
const SESSION_REAP_SECS: u64 = 3;

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
        let force_mock = env_truthy("PHONECONTROL_FORCE_MOCK");
        let adb_path = if force_mock {
            info!("PHONECONTROL_FORCE_MOCK set — using mock fleet");
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

    pub async fn list_local_devices(&self) -> Vec<Device> {
        self.inner.devices.read().await.clone()
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
        let devices = self.inner.devices.read().await;
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
        let local = self.inner.devices.read().await;
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

    pub async fn handle_tap(
        &self,
        mode: ControlMode,
        target_ids: &[String],
        point: NormalizedPoint,
    ) -> Result<TapBroadcast, String> {
        let devices = self.resolve_targets(target_ids).await?;
        if devices.is_empty() {
            return Err("no online targets for tap".into());
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

        let mut mapped: Vec<MappedTap> = Vec::new();
        if !local_group.is_empty() {
            let mut local = map_to_devices(point, &local_group);
            for (device, tap) in local_group.iter().zip(local.iter_mut()) {
                let result = self.inner.sessions.inject_tap(&device.serial, tap).await;
                tap.inject = result.status;
                tap.inject_detail = result.detail;
            }
            mapped.extend(local);
        }

        for (host_id, group) in by_remote {
            if self.inner.role != Role::Controller {
                return Err(format!("cannot reach remote host {host_id} from agent"));
            }
            let ids: Vec<String> = group.iter().map(|d| d.id.clone()).collect();
            match self.inner.mesh.proxy_tap(&host_id, mode, ids, point).await {
                Ok(remote) => mapped.extend(remote),
                Err(e) => {
                    for d in &group {
                        let mut tap = phonecontrol_protocol::map_point(point, d);
                        tap.inject = InjectStatus::Error;
                        tap.inject_detail = Some(e.clone());
                        mapped.push(tap);
                    }
                }
            }
        }

        let broadcast = TapBroadcast::new(mode, point, mapped);
        self.publish(ServerEvent::TapResult {
            broadcast: broadcast.clone(),
        });
        Ok(broadcast)
    }

    /// Local-only tap (used by agent when fulfilling controller proxy).
    pub async fn handle_tap_local(
        &self,
        mode: ControlMode,
        target_ids: &[String],
        point: NormalizedPoint,
    ) -> Result<TapBroadcast, String> {
        let devices = self.resolve_local_targets(target_ids).await?;
        if devices.is_empty() {
            return Err("no online local targets for tap".into());
        }
        let mut mapped: Vec<MappedTap> = map_to_devices(point, &devices);
        for (device, tap) in devices.iter().zip(mapped.iter_mut()) {
            let result = self.inner.sessions.inject_tap(&device.serial, tap).await;
            tap.inject = result.status;
            tap.inject_detail = result.detail;
        }
        Ok(TapBroadcast::new(mode, point, mapped))
    }

    /// Pass a finger event through to each device's scrcpy control socket.
    pub async fn handle_pointer(
        &self,
        mode: ControlMode,
        target_ids: &[String],
        phase: PointerPhase,
        point: NormalizedPoint,
        frame_width: u32,
        frame_height: u32,
    ) -> Result<TapBroadcast, String> {
        let devices = self.resolve_targets(target_ids).await?;
        if devices.is_empty() {
            return Err("no online targets for pointer".into());
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

        let mut mapped: Vec<MappedTap> = Vec::new();
        if !local_group.is_empty() {
            mapped.extend(
                self.inject_pointer_group(&local_group, phase, point, frame_width, frame_height)
                    .await,
            );
        }

        for (host_id, group) in by_remote {
            if self.inner.role != Role::Controller {
                return Err(format!("cannot reach remote host {host_id} from agent"));
            }
            let ids: Vec<String> = group.iter().map(|d| d.id.clone()).collect();
            match self
                .inner
                .mesh
                .proxy_pointer(&host_id, mode, ids, phase, point, frame_width, frame_height)
                .await
            {
                Ok(remote) => mapped.extend(remote),
                Err(e) => {
                    for d in &group {
                        let mut tap = frame_tap(point, d, frame_width, frame_height);
                        tap.inject = InjectStatus::Error;
                        tap.inject_detail = Some(e.clone());
                        mapped.push(tap);
                    }
                }
            }
        }

        let broadcast = TapBroadcast::new(mode, point, mapped);
        if phase != PointerPhase::Move {
            self.publish(ServerEvent::TapResult {
                broadcast: broadcast.clone(),
            });
        }
        Ok(broadcast)
    }

    pub async fn handle_pointer_local(
        &self,
        mode: ControlMode,
        target_ids: &[String],
        phase: PointerPhase,
        point: NormalizedPoint,
        frame_width: u32,
        frame_height: u32,
    ) -> Result<TapBroadcast, String> {
        let devices = self.resolve_local_targets(target_ids).await?;
        if devices.is_empty() {
            return Err("no online local targets for pointer".into());
        }
        let mapped = self
            .inject_pointer_group(&devices, phase, point, frame_width, frame_height)
            .await;
        Ok(TapBroadcast::new(mode, point, mapped))
    }

    async fn inject_pointer_group(
        &self,
        devices: &[Device],
        phase: PointerPhase,
        point: NormalizedPoint,
        frame_width: u32,
        frame_height: u32,
    ) -> Vec<MappedTap> {
        let mut mapped = Vec::with_capacity(devices.len());
        for device in devices {
            let mut tap = frame_tap(point, device, frame_width, frame_height);
            if frame_width == 0 || frame_height == 0 {
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
                .inject_pointer(&device.serial, phase, tap.x, tap.y, tap.width, tap.height)
                .await;
            tap.inject = result.status;
            tap.inject_detail = result.detail;
            mapped.push(tap);
        }
        mapped
    }

    pub async fn handle_nav(
        &self,
        mode: ControlMode,
        target_ids: &[String],
        action: NavActionType,
    ) -> Result<NavBroadcast, String> {
        let devices = self.resolve_targets(target_ids).await?;
        if devices.is_empty() {
            return Err("no online targets for nav".into());
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
        for d in &local_group {
            ids.push(d.id.clone());
            let result = self.inner.sessions.inject_nav(&d.serial, action).await;
            results.push(NavTargetResult {
                device_id: d.id.clone(),
                device_name: d.name.clone(),
                inject: result.status,
                detail: result.detail,
            });
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
                .inner
                .mesh
                .proxy_nav(&host_id, mode, group_ids, action)
                .await
            {
                Ok(remote) => results.extend(remote),
                Err(e) => {
                    for d in &group {
                        results.push(NavTargetResult {
                            device_id: d.id.clone(),
                            device_name: d.name.clone(),
                            inject: InjectStatus::Error,
                            detail: Some(e.clone()),
                        });
                    }
                }
            }
        }

        let broadcast = NavBroadcast::new(mode, action, ids, results);
        self.publish(ServerEvent::NavResult {
            broadcast: broadcast.clone(),
        });
        Ok(broadcast)
    }

    async fn local_serial_set(&self) -> std::collections::HashSet<String> {
        self.inner
            .devices
            .read()
            .await
            .iter()
            .map(|d| d.serial.clone())
            .collect()
    }

    pub async fn handle_nav_local(
        &self,
        mode: ControlMode,
        target_ids: &[String],
        action: NavActionType,
    ) -> Result<NavBroadcast, String> {
        let devices = self.resolve_local_targets(target_ids).await?;
        if devices.is_empty() {
            return Err("no online local targets for nav".into());
        }
        let mut results = Vec::with_capacity(devices.len());
        for device in &devices {
            let result = self.inner.sessions.inject_nav(&device.serial, action).await;
            results.push(NavTargetResult {
                device_id: device.id.clone(),
                device_name: device.name.clone(),
                inject: result.status,
                detail: result.detail,
            });
        }
        let ids: Vec<String> = devices.iter().map(|d| d.id.clone()).collect();
        Ok(NavBroadcast::new(mode, action, ids, results))
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
        let path = std::env::temp_dir().join(format!("phonecontrol-{}.apk", uuid::Uuid::new_v4()));
        if let Err(e) = tokio::fs::write(&path, bytes).await {
            return devices
                .iter()
                .map(|d| install_error(d, format!("failed to store apk: {e}")))
                .collect();
        }
        let mut results = Vec::with_capacity(devices.len());
        for device in devices {
            let result = self.inner.sessions.install_apk(&device.serial, &path).await;
            results.push(NavTargetResult {
                device_id: device.id.clone(),
                device_name: device.name.clone(),
                inject: result.status,
                detail: result.detail,
            });
        }
        let _ = tokio::fs::remove_file(&path).await;
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
        let (status, body) = http_post_bytes(
            &url,
            &[
                ("Content-Type", "application/vnd.android.package-archive"),
                ("X-Phonecontrol-Mode", mode_name),
                ("X-Phonecontrol-Targets", &target_ids.join(",")),
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

        let mut results = Vec::new();
        for device in local_group {
            results.push(
                self.command_one(
                    &device,
                    &op,
                    request.arg.as_deref(),
                    request.arg2.as_deref(),
                )
                .await,
            );
        }
        for (host_id, group) in by_remote {
            if self.inner.role != Role::Controller {
                for device in group {
                    results.push(op_error(
                        &device,
                        format!("cannot reach remote host {host_id}"),
                    ));
                }
                continue;
            }
            let ids: Vec<String> = group.iter().map(|d| d.id.clone()).collect();
            let forwarded = DeviceCommandRequest {
                target_ids: ids,
                op: op.clone(),
                arg: request.arg.clone(),
                arg2: request.arg2.clone(),
            };
            match self.proxy_command_http(&host_id, &forwarded).await {
                Ok(remote) => results.extend(remote),
                Err(error) => {
                    for device in group {
                        results.push(op_error(&device, error.clone()));
                    }
                }
            }
        }

        Ok(DeviceCommandResponse {
            id: format!("cmd-{}", uuid::Uuid::new_v4()),
            op,
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
        if matches!(op, "tap" | "swipe" | "longPress") {
            return self.gesture(device, op, arg, arg2).await;
        }
        let Some(adb) = self.inner.adb_path.clone() else {
            return op_error(device, "adb is not available");
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
            http_post_bytes(&url, &[("Content-Type", "application/json")], &body).await?;
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
        let local =
            std::env::temp_dir().join(format!("phonecontrol-push-{}", uuid::Uuid::new_v4()));
        tokio::fs::write(&local, bytes)
            .await
            .map_err(|e| format!("failed to store upload: {e}"))?;
        let dest = if dest.ends_with('/') {
            format!("{dest}{safe_name}")
        } else {
            dest.to_string()
        };
        let mut results = Vec::new();
        let Some(adb) = self.inner.adb_path.clone() else {
            let _ = tokio::fs::remove_file(&local).await;
            return Ok(DeviceCommandResponse {
                id: format!("push-{}", uuid::Uuid::new_v4()),
                op: "push".into(),
                results: devices
                    .iter()
                    .map(|d| op_error(d, "adb is not available"))
                    .collect(),
            });
        };
        for device in &devices {
            match crate::device_ops::adb_push(&adb, &device.serial, &local, &dest).await {
                Ok(output) => results.push(op_ok(device, output)),
                Err(error) => results.push(op_error(device, error)),
            }
        }
        let _ = tokio::fs::remove_file(&local).await;
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
        let local =
            std::env::temp_dir().join(format!("phonecontrol-pull-{}", uuid::Uuid::new_v4()));
        crate::device_ops::adb_pull(&adb, &device.serial, remote, &local).await?;
        let bytes = tokio::fs::read(&local)
            .await
            .map_err(|e| format!("failed to read pulled file: {e}"))?;
        let _ = tokio::fs::remove_file(&local).await;
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

        Ok(ScrcpyOptionsResponse {
            quality,
            audio: body.audio,
            screen_off: body.screen_off,
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

    pub async fn handle_text(&self, body: TextInjectRequest) -> Result<ClipboardResponse, String> {
        if body.text.is_empty() {
            return Err("empty text".into());
        }
        if body.text.len() > 300 {
            return Err("text is too long for one scrcpy inject".into());
        }
        let (local, by_remote) = self.split_targets(&body.target_ids).await?;
        let mut results = Vec::new();
        for device in local {
            match self
                .inner
                .sessions
                .inject_text(&device.serial, &body.text)
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
        }
        for (host_id, group) in by_remote {
            let forward = TextInjectRequest {
                mode: ControlMode::Selected,
                target_ids: group.iter().map(|d| d.id.clone()).collect(),
                text: body.text.clone(),
            };
            match self
                .proxy_json::<TextInjectRequest, ClipboardResponse>(
                    &host_id,
                    "/api/input/text",
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

    pub async fn handle_key(&self, body: KeyInjectRequest) -> Result<ClipboardResponse, String> {
        let action = match body.action.as_str() {
            "down" => 0u8,
            "up" => 1,
            _ => return Err("key action must be down or up".into()),
        };
        let (local, by_remote) = self.split_targets(&body.target_ids).await?;
        let mut results = Vec::new();
        for device in local {
            match self
                .inner
                .sessions
                .inject_keycode(
                    &device.serial,
                    action,
                    body.keycode,
                    body.repeat,
                    body.metastate,
                )
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
        }
        for (host_id, group) in by_remote {
            let forward = KeyInjectRequest {
                mode: ControlMode::Selected,
                target_ids: group.iter().map(|d| d.id.clone()).collect(),
                action: body.action.clone(),
                keycode: body.keycode,
                repeat: body.repeat,
                metastate: body.metastate,
            };
            match self
                .proxy_json::<KeyInjectRequest, ClipboardResponse>(
                    &host_id,
                    "/api/input/key",
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
            http_post_bytes(&url, &[("Content-Type", "application/json")], &bytes).await?;
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

    /// Background ADB poll loop (no-op when using mock fleet).
    pub fn spawn_adb_watcher(&self) {
        let Some(adb) = self.inner.adb_path.clone() else {
            info!("ADB not found — serving mock fleet compatible with the UI seed data");
            let state = self.clone();
            tokio::spawn(async move {
                let devices = state.list_local_devices().await;
                for d in devices {
                    let session = state.inner.sessions.ensure_session(&d.serial).await;
                    state.publish(ServerEvent::SessionUpdated { session });
                }
                state.publish_fleet().await;
            });
            return;
        };
        info!(path = %adb.display(), "ADB found — polling devices every {ADB_POLL_SECS}s");
        let state = self.clone();
        tokio::spawn(async move {
            let mut known_resolutions: HashMap<String, phonecontrol_protocol::DeviceResolution> =
                HashMap::new();
            loop {
                match adb::list_adb_devices(&adb).await {
                    Ok(lines) => {
                        state
                            .apply_adb_snapshot(&adb, &lines, &mut known_resolutions)
                            .await;
                    }
                    Err(e) => {
                        warn!(error = %e, "adb devices failed");
                        state.publish(ServerEvent::Notice {
                            message: format!("adb devices failed: {e}"),
                        });
                    }
                }
                tokio::time::sleep(Duration::from_secs(ADB_POLL_SECS)).await;
            }
        });
    }

    /// Periodically reap exited scrcpy children and publish session updates.
    pub fn spawn_session_reaper(&self) {
        let state = self.clone();
        tokio::spawn(async move {
            let mut last_recovery: HashMap<String, std::time::Instant> = HashMap::new();
            loop {
                tokio::time::sleep(Duration::from_secs(SESSION_REAP_SECS)).await;
                let changed = state.inner.sessions.reap().await;
                for session in changed {
                    if session.stream == StreamState::Error {
                        let due = last_recovery
                            .get(&session.serial)
                            .map(|at| at.elapsed() > Duration::from_secs(20))
                            .unwrap_or(true);
                        if due {
                            last_recovery.insert(session.serial.clone(), std::time::Instant::now());
                            if let Ok(restarted) = state.restart_session(&session.serial).await {
                                state.publish(ServerEvent::SessionUpdated { session: restarted });
                                continue;
                            }
                        }
                    }
                    state.publish(ServerEvent::SessionUpdated { session });
                }
            }
        });
    }

    async fn apply_adb_snapshot(
        &self,
        adb: &PathBuf,
        lines: &[AdbDeviceLine],
        known_resolutions: &mut HashMap<String, phonecontrol_protocol::DeviceResolution>,
    ) {
        let host_id = &self.inner.host_id;
        let host_name = &self.inner.host_name;
        let mut next = Vec::with_capacity(lines.len());
        for line in lines {
            let resolution = if let Some(res) = known_resolutions.get(&line.serial) {
                res.clone()
            } else if line.status == DeviceStatus::Online {
                let res = adb::query_resolution(adb, &line.serial).await;
                known_resolutions.insert(line.serial.clone(), res.clone());
                res
            } else {
                phonecontrol_protocol::DeviceResolution {
                    width: 1080,
                    height: 1920,
                }
            };
            next.push(adb::adb_line_to_device(
                line, host_id, host_name, resolution,
            ));
        }

        let auto = env_truthy("PHONECONTROL_AUTO_SESSION");
        for device in &next {
            let existing = self.inner.sessions.get_session(&device.serial).await;
            if existing.is_none() {
                let session = self.inner.sessions.ensure_session(&device.serial).await;
                self.publish(ServerEvent::SessionUpdated {
                    session: session.clone(),
                });
                if auto && device.status == DeviceStatus::Online {
                    let session = self.inner.sessions.start(&device.serial).await;
                    self.publish(ServerEvent::SessionUpdated { session });
                }
            }
        }

        let mut changed = false;
        {
            let mut guard = self.inner.devices.write().await;
            if !devices_equal(&guard, &next) {
                *guard = next.clone();
                changed = true;
            }
        }
        if changed {
            info!(count = next.len(), "device fleet updated from ADB");
            self.publish_fleet().await;
        }
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
    })
}

fn frame_tap(
    point: NormalizedPoint,
    device: &Device,
    frame_width: u32,
    frame_height: u32,
) -> MappedTap {
    let width = if frame_width > 0 {
        frame_width
    } else {
        device.resolution.width
    };
    let height = if frame_height > 0 {
        frame_height
    } else {
        device.resolution.height
    };
    let x = (point.x.clamp(0.0, 1.0) * f64::from(width)).round() as u32;
    let y = (point.y.clamp(0.0, 1.0) * f64::from(height)).round() as u32;
    MappedTap {
        device_id: device.id.clone(),
        device_name: device.name.clone(),
        x,
        y,
        width,
        height,
        inject: InjectStatus::Stub,
        inject_detail: None,
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

async fn http_post_bytes(
    url: &str,
    headers: &[(&str, &str)],
    body: &[u8],
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

    let mut stream = TcpStream::connect(hostport)
        .await
        .map_err(|e| format!("install proxy connect failed: {e}"))?;
    stream
        .write_all(header.as_bytes())
        .await
        .map_err(|e| format!("install proxy write failed: {e}"))?;
    stream
        .write_all(body)
        .await
        .map_err(|e| format!("install proxy write failed: {e}"))?;
    let mut buf = Vec::new();
    stream
        .read_to_end(&mut buf)
        .await
        .map_err(|e| format!("install proxy read failed: {e}"))?;
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

fn env_truthy(key: &str) -> bool {
    matches!(
        std::env::var(key).as_deref(),
        Ok("1") | Ok("true") | Ok("TRUE") | Ok("yes") | Ok("YES")
    )
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
mod tests {
    use super::*;

    #[tokio::test]
    async fn pointer_rejects_unknown_video_size_and_accepts_real_frame() {
        let state = AppState::new(
            Role::Controller,
            "pointer-test".into(),
            "pointer-test".into(),
            0,
            None,
        );
        let devices = state.list_devices().await;
        let device = devices
            .iter()
            .find(|d| d.status == DeviceStatus::Online)
            .expect("mock fleet has an online device");
        let id = device.id.clone();
        let point = NormalizedPoint { x: 0.25, y: 0.5 };

        let unknown = state
            .handle_pointer(
                ControlMode::Selected,
                &[id.clone()],
                PointerPhase::Down,
                point,
                0,
                0,
            )
            .await
            .expect("0×0 pointer still returns a broadcast");
        let rejected = &unknown.targets[0];
        assert_eq!(rejected.inject, InjectStatus::Error);
        assert_eq!(rejected.width, 0);
        assert_eq!(rejected.height, 0);
        let detail = rejected.inject_detail.as_deref().unwrap_or("");
        assert!(
            detail.contains("video size unknown"),
            "0×0 pointer should be rejected, got {detail}"
        );

        let known = state
            .handle_pointer(
                ControlMode::Selected,
                &[id],
                PointerPhase::Down,
                point,
                360,
                640,
            )
            .await
            .expect("sized pointer returns a broadcast");
        let sent = &known.targets[0];
        let detail = sent.inject_detail.as_deref().unwrap_or("");
        assert!(
            !detail.contains("video size unknown"),
            "real frame size must not be rejected as unknown, got {detail}"
        );
        assert_eq!(sent.width, 360);
        assert_eq!(sent.height, 640);
        assert_ne!(sent.width, device.resolution.width);
        assert_eq!(sent.x, 90);
        assert_eq!(sent.y, 320);
    }
}
