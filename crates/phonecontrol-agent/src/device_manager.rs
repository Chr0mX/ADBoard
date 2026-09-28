//! Device manager — owns the live fleet, ADB polling, mesh merge, and event fan-out.

use crate::adb::{self, AdbDeviceLine};
use crate::mesh::MeshRegistry;
use crate::mock::{self, MockProfile};
use crate::session::{scrcpy_binary, SessionManager};
use crate::video::VideoHub;
use phonecontrol_protocol::{
    map_to_devices, AdbAvailability, ControlMode, Device, DeviceStatus, HostInfo, InjectMode,
    InjectStatus, MappedTap, NavActionType, NavBroadcast, NavTargetResult, NormalizedPoint,
    PointerPhase, Role, ScrcpyAvailability, ServerEvent, SessionAction, SessionStatus, TapBroadcast,
};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
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
        Self {
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
        }
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
        if devices
            .iter()
            .any(|d| d.serial == serial || d.id == serial)
        {
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
            match self
                .inner
                .mesh
                .proxy_tap(&host_id, mode, ids, point)
                .await
            {
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
                .proxy_pointer(
                    &host_id,
                    mode,
                    ids,
                    phase,
                    point,
                    frame_width,
                    frame_height,
                )
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
            let result = self
                .inner
                .sessions
                .inject_nav(&d.serial, action)
                .await;
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
            let result = self
                .inner
                .sessions
                .inject_nav(&device.serial, action)
                .await;
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
            loop {
                tokio::time::sleep(Duration::from_secs(SESSION_REAP_SECS)).await;
                let changed = state.inner.sessions.reap().await;
                for session in changed {
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
            next.push(adb::adb_line_to_device(line, host_id, host_name, resolution));
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
