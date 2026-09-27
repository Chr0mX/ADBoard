//! Device manager — owns the live fleet, ADB polling, and event fan-out.

use crate::adb::{self, AdbDeviceLine};
use crate::mock;
use crate::session::SessionManager;
use phonecontrol_protocol::{
    map_to_devices, AdbAvailability, ControlMode, Device, DeviceStatus, MappedTap, NavActionType,
    NavBroadcast, NormalizedPoint, ServerEvent, TapBroadcast,
};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{broadcast, RwLock};
use tracing::{info, warn};

const ADB_POLL_SECS: u64 = 2;

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
        let (events, _) = broadcast::channel(64);
        let initial = if adb_path.is_some() {
            Vec::new()
        } else {
            mock::mock_fleet(&host_name)
        };
        Self {
            inner: Arc::new(InnerState {
                host_name,
                port,
                adb_path,
                devices: RwLock::new(initial),
                events,
                sessions: SessionManager::new(),
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

    pub async fn list_devices(&self) -> Vec<Device> {
        self.inner.devices.read().await.clone()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<ServerEvent> {
        self.inner.events.subscribe()
    }

    pub fn publish(&self, event: ServerEvent) {
        let _ = self.inner.events.send(event);
    }

    #[allow(dead_code)]
    pub async fn broadcast_snapshot(&self) {
        let devices = self.list_devices().await;
        self.publish(ServerEvent::Devices { devices });
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
        let mapped: Vec<MappedTap> = map_to_devices(point, &devices);
        for (device, tap) in devices.iter().zip(mapped.iter()) {
            self.inner
                .sessions
                .inject_tap(&device.serial, tap)
                .await;
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
        for device in &devices {
            self.inner
                .sessions
                .inject_nav(&device.serial, action)
                .await;
        }
        let ids: Vec<String> = devices.iter().map(|d| d.id.clone()).collect();
        let broadcast = NavBroadcast::new(mode, action, ids);
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
