//! Device manager — owns the live fleet, ADB polling, and event fan-out.

use crate::adb::{self, AdbDeviceLine};
use crate::mock;
use crate::session::{scrcpy_binary, SessionManager};
use phonecontrol_protocol::{
    map_to_devices, AdbAvailability, ControlMode, Device, DeviceStatus, InjectMode, InjectStatus,
    MappedTap, NavActionType, NavBroadcast, NavTargetResult, NormalizedPoint, ScrcpyAvailability,
    ServerEvent, SessionStatus, TapBroadcast,
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
    pub host_name: String,
    pub port: u16,
    pub adb_path: Option<PathBuf>,
    pub devices: RwLock<Vec<Device>>,
    pub events: broadcast::Sender<ServerEvent>,
    pub sessions: Arc<SessionManager>,
}

impl AppState {
    pub fn new(host_name: String, port: u16, adb_path: Option<PathBuf>) -> Self {
        let (events, _) = broadcast::channel(128);
        let force_mock = env_truthy("PHONECONTROL_FORCE_MOCK");
        let adb_path = if force_mock {
            info!("PHONECONTROL_FORCE_MOCK set — using mock fleet");
            None
        } else {
            adb_path
        };
        let scrcpy = scrcpy_binary();
        match &scrcpy {
            Some(p) => info!(path = %p.display(), "scrcpy backend found"),
            None => info!("scrcpy not found — sessions stay idle stub (set SCRCPY_PATH to enable)"),
        }
        let initial = if adb_path.is_some() {
            Vec::new()
        } else {
            mock::mock_fleet(&host_name)
        };
        let sessions = SessionManager::new(adb_path.clone(), scrcpy);
        Self {
            inner: Arc::new(InnerState {
                host_name,
                port,
                adb_path,
                devices: RwLock::new(initial),
                events,
                sessions,
            }),
        }
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

    pub async fn list_devices(&self) -> Vec<Device> {
        self.inner.devices.read().await.clone()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<ServerEvent> {
        self.inner.events.subscribe()
    }

    pub fn publish(&self, event: ServerEvent) {
        let _ = self.inner.events.send(event);
    }

    pub async fn list_sessions(&self) -> Vec<SessionStatus> {
        self.inner.sessions.list_sessions().await
    }

    pub async fn session_status(&self, serial: &str) -> SessionStatus {
        if let Some(s) = self.inner.sessions.get_session(serial).await {
            return s;
        }
        self.inner.sessions.ensure_session(serial).await
    }

    pub async fn start_session(&self, serial: &str) -> Result<SessionStatus, String> {
        self.require_known_serial(serial).await?;
        let session = self.inner.sessions.start(serial).await;
        self.publish(ServerEvent::SessionUpdated {
            session: session.clone(),
        });
        Ok(session)
    }

    pub async fn stop_session(&self, serial: &str) -> Result<SessionStatus, String> {
        self.require_known_serial(serial).await?;
        let session = self.inner.sessions.stop(serial).await;
        self.publish(ServerEvent::SessionUpdated {
            session: session.clone(),
        });
        Ok(session)
    }

    pub async fn restart_session(&self, serial: &str) -> Result<SessionStatus, String> {
        self.require_known_serial(serial).await?;
        let session = self.inner.sessions.restart(serial).await;
        self.publish(ServerEvent::SessionUpdated {
            session: session.clone(),
        });
        Ok(session)
    }

    async fn require_known_serial(&self, serial: &str) -> Result<(), String> {
        let devices = self.inner.devices.read().await;
        if devices
            .iter()
            .any(|d| d.serial == serial || d.id == serial)
        {
            Ok(())
        } else {
            Err(format!("unknown device serial/id: {serial}"))
        }
    }

    /// Resolve a path param that may be id or serial → canonical serial.
    pub async fn resolve_serial(&self, id_or_serial: &str) -> Result<String, String> {
        let devices = self.inner.devices.read().await;
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
        let mut mapped: Vec<MappedTap> = map_to_devices(point, &devices);
        for (device, tap) in devices.iter().zip(mapped.iter_mut()) {
            let result = self.inner.sessions.inject_tap(&device.serial, tap).await;
            tap.inject = result.status;
            tap.inject_detail = result.detail;
        }
        let broadcast = TapBroadcast::new(mode, point, mapped);
        self.publish(ServerEvent::TapResult {
            broadcast: broadcast.clone(),
        });
        Ok(broadcast)
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
        let broadcast = NavBroadcast::new(mode, action, ids, results);
        self.publish(ServerEvent::NavResult {
            broadcast: broadcast.clone(),
        });
        Ok(broadcast)
    }

    async fn resolve_targets(&self, target_ids: &[String]) -> Result<Vec<Device>, String> {
        let all = self.inner.devices.read().await;
        let mut out = Vec::new();
        for id in target_ids {
            match all.iter().find(|d| d.id == *id || d.serial == *id) {
                Some(d) if d.status == DeviceStatus::Online => out.push(d.clone()),
                Some(_) => {
                    // skip offline/unauthorized silently for broadcast modes
                }
                None => return Err(format!("unknown device id: {id}")),
            }
        }
        Ok(out)
    }

    /// Background ADB poll loop (no-op when using mock fleet).
    pub fn spawn_adb_watcher(&self) {
        let Some(adb) = self.inner.adb_path.clone() else {
            info!("ADB not found — serving mock fleet compatible with the UI seed data");
            // Still register idle stub sessions for mock devices so /api/sessions works.
            let state = self.clone();
            tokio::spawn(async move {
                let devices = state.list_devices().await;
                for d in devices {
                    let session = state.inner.sessions.ensure_session(&d.serial).await;
                    state.publish(ServerEvent::SessionUpdated { session });
                }
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
        let host = &self.inner.host_name;
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
            next.push(adb::adb_line_to_device(line, host, resolution));
        }

        // Ensure sessions exist for every known serial; auto-start when configured.
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
            self.publish(ServerEvent::Devices { devices: next });
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
    })
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
