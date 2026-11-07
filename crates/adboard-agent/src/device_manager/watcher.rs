//! The ADB poll loop, the session reaper and the automatic recovery that goes with them.

use super::*;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum RecoveryAction {
    RestartAdb { serial: String },
    RestartSession { serial: String },
}

impl RecoveryAction {
    fn serial(&self) -> &str {
        match self {
            RecoveryAction::RestartAdb { serial } | RecoveryAction::RestartSession { serial } => {
                serial
            }
        }
    }
}

/// What to do after an ADB poll. One device dropping must not reconnect the others.
/// `restart_new` also restarts scrcpy for phones seen for the first time, so a
/// configured connect size is applied before the stream starts.
pub(super) fn recovery_actions(
    previous: &HashMap<String, DeviceStatus>,
    next: &[Device],
    restart_new: bool,
) -> Vec<RecoveryAction> {
    let mut actions = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for device in next {
        seen.insert(device.serial.as_str());
        match previous.get(&device.serial).copied() {
            Some(DeviceStatus::Online) if device.status != DeviceStatus::Online => {
                actions.push(RecoveryAction::RestartAdb {
                    serial: device.serial.clone(),
                });
            }
            // Returning from offline, or first seen when a connect size is set.
            Some(DeviceStatus::Offline) | Some(DeviceStatus::Unauthorized)
                if device.status == DeviceStatus::Online =>
            {
                actions.push(RecoveryAction::RestartSession {
                    serial: device.serial.clone(),
                });
            }
            None if restart_new && device.status == DeviceStatus::Online =>
            {
                actions.push(RecoveryAction::RestartSession {
                    serial: device.serial.clone(),
                });
            }
            _ => {}
        }
    }
    for (serial, status) in previous {
        if *status == DeviceStatus::Online && !seen.contains(serial.as_str()) {
            actions.push(RecoveryAction::RestartAdb {
                serial: serial.clone(),
            });
        }
    }
    actions
}

pub(super) struct CachedBattery {
    sample: adb::BatterySample,
    fetched: std::time::Instant,
}

/// The cached vitals of `serial` are recent enough to reuse.
fn battery_is_fresh(batteries: &HashMap<String, CachedBattery>, serial: &str) -> bool {
    batteries
        .get(serial)
        .map(|cached| cached.fetched.elapsed() < Duration::from_secs(15))
        .unwrap_or(false)
}

impl AppState {
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
            for endpoint in adb::load_wireless() {
                match tokio::time::timeout(
                    Duration::from_secs(8),
                    adb::connect_wireless(&adb, &endpoint, None),
                )
                .await
                {
                    Ok(Ok(message)) => {
                        info!(endpoint = %endpoint.display(), %message, "restored wireless device")
                    }
                    Ok(Err(error)) => {
                        warn!(endpoint = %endpoint.display(), %error, "could not restore wireless device")
                    }
                    Err(_) => {
                        warn!(endpoint = %endpoint.display(), "wireless restore timed out")
                    }
                }
            }
            let mut known_resolutions: HashMap<String, adboard_protocol::DeviceResolution> =
                HashMap::new();
            let mut batteries: HashMap<String, CachedBattery> = HashMap::new();
            let mut previous: HashMap<String, DeviceStatus> = HashMap::new();
            let mut last_recovery: HashMap<String, std::time::Instant> = HashMap::new();
            let mut adb_attempts: HashMap<String, u8> = HashMap::new();
            loop {
                match adb::list_adb_devices(&adb).await {
                    Ok(lines) => {
                        state
                            .apply_adb_snapshot(&adb, &lines, &mut known_resolutions, &mut batteries)
                            .await;
                        let next = state.list_local_devices().await;
                        for device in &next {
                            if device.status == DeviceStatus::Online {
                                adb_attempts.remove(&device.serial);
                            }
                        }
                        for action in
                            recovery_actions(&previous, &next, connect_display_size().is_some())
                        {
                            let serial = action.serial();
                            let due = last_recovery
                                .get(serial)
                                .map(|at| at.elapsed() > Duration::from_secs(20))
                                .unwrap_or(true);
                            if !due {
                                continue;
                            }
                            if matches!(action, RecoveryAction::RestartAdb { .. })
                                && adb_attempts.get(serial).copied().unwrap_or(0) >= 5
                            {
                                continue;
                            }
                            last_recovery.insert(serial.to_string(), std::time::Instant::now());
                            match action {
                                RecoveryAction::RestartAdb { serial } => {
                                    *adb_attempts.entry(serial.clone()).or_insert(0) += 1;
                                    let adb = adb.clone();
                                    let state = state.clone();
                                    info!(%serial, "phone disconnected — resetting wm size and restarting ADB");
                                    tokio::spawn(async move {
                                        // Best-effort: often fails if the cable is already gone.
                                        state.reset_overridden_display_size(&serial).await;
                                        let args =
                                            vec!["-s".into(), serial.clone(), "reconnect".into()];
                                        match crate::device_ops::adb_text(&adb, &args).await {
                                            Ok(output) => {
                                                info!(%serial, %output, "automatic adb reconnect")
                                            }
                                            Err(error) => {
                                                warn!(%serial, %error, "automatic adb reconnect failed")
                                            }
                                        }
                                    });
                                }
                                RecoveryAction::RestartSession { serial } => {
                                    info!(%serial, "device online — restarting scrcpy");
                                    // Restarting a stream takes several adb calls; it
                                    // must not hold up the poll for the other phones.
                                    let state = state.clone();
                                    tokio::spawn(async move {
                                        state.apply_connect_display_size(&serial).await;
                                        match state.restart_session_local(&serial).await {
                                            Ok(session) => {
                                                state.publish(ServerEvent::SessionUpdated { session });
                                            }
                                            Err(error) => {
                                                warn!(%serial, %error, "automatic scrcpy restart failed");
                                            }
                                        }
                                    });
                                }
                            }
                        }
                        let mut updated = HashMap::new();
                        for device in &next {
                            updated.insert(device.serial.clone(), device.status);
                        }
                        for serial in previous.keys() {
                            if !updated.contains_key(serial) {
                                updated.insert(serial.clone(), DeviceStatus::Offline);
                            }
                        }
                        previous = updated;
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
                            // One phone's slow restart must not delay reaping the others.
                            let state = state.clone();
                            tokio::spawn(async move {
                                match state.restart_session(&session.serial).await {
                                    Ok(restarted) => {
                                        state.publish(ServerEvent::SessionUpdated { session: restarted })
                                    }
                                    Err(_) => state.publish(ServerEvent::SessionUpdated { session }),
                                }
                            });
                            continue;
                        }
                    }
                    state.publish(ServerEvent::SessionUpdated { session });
                }
            }
        });
    }

    pub(super) async fn apply_adb_snapshot(
        &self,
        adb: &PathBuf,
        lines: &[AdbDeviceLine],
        known_resolutions: &mut HashMap<String, adboard_protocol::DeviceResolution>,
        batteries: &mut HashMap<String, CachedBattery>,
    ) {
        let host_id = &self.inner.host_id;
        let host_name = &self.inner.host_name;
        let refresh = {
            let mut guard = self
                .inner
                .resolution_refresh
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            std::mem::take(&mut *guard)
        };
        for line in lines {
            if refresh.contains(&line.serial) {
                known_resolutions.remove(&line.serial);
            }
        }
        // Ask every phone that needs it at the same time. Each query has its
        // own time limit, so a phone that does not answer costs only itself,
        // not the whole fleet's status updates.
        let need_resolution: Vec<String> = lines
            .iter()
            .filter(|l| l.status == DeviceStatus::Online && !known_resolutions.contains_key(&l.serial))
            .map(|l| l.serial.clone())
            .collect();
        let need_vitals: Vec<String> = lines
            .iter()
            .filter(|l| l.status == DeviceStatus::Online && !battery_is_fresh(batteries, &l.serial))
            .map(|l| l.serial.clone())
            .collect();
        let (resolutions, vitals) = tokio::join!(
            fanout::fan_out(need_resolution, fanout::DEFAULT_LIMIT, |serial| async move {
                let resolution = adb::query_resolution(adb, &serial).await;
                (serial, resolution)
            }),
            fanout::fan_out(need_vitals, fanout::DEFAULT_LIMIT, |serial| async move {
                let sample = adb::query_battery(adb, &serial).await;
                (serial, sample)
            }),
        );
        for (serial, resolution) in resolutions {
            known_resolutions.insert(serial, resolution);
        }
        for (serial, mut sample) in vitals {
            // CPU % is the busy share since the previous read (about 15 s ago).
            if let (Some(prev), Some(now)) = (
                batteries.get(&serial).and_then(|cached| cached.sample.cpu_times),
                sample.cpu_times,
            ) {
                sample.cpu_percent = adb::cpu_percent_between(prev, now);
            }
            batteries.insert(
                serial,
                CachedBattery {
                    sample,
                    fetched: std::time::Instant::now(),
                },
            );
        }
        let mut next = Vec::with_capacity(lines.len());
        for line in lines {
            let resolution = known_resolutions
                .get(&line.serial)
                .cloned()
                .unwrap_or(adboard_protocol::DeviceResolution {
                    width: 1080,
                    height: 1920,
                });
            let battery = if line.status == DeviceStatus::Online {
                batteries
                    .get(&line.serial)
                    .map(|cached| cached.sample)
                    .unwrap_or_default()
            } else {
                adb::BatterySample::default()
            };
            next.push(adb::adb_line_to_device(
                line, host_id, host_name, resolution, battery,
            ));
        }

        let auto = crate::env::truthy("AUTO_SESSION");
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
        // A virtual display cannot outlive its phone.
        let present: HashSet<String> = next.iter().map(|d| d.serial.clone()).collect();
        let gone = self.inner.sessions.prune_virtual_displays(&present).await;
        if !gone.is_empty() {
            info!(count = gone.len(), "closed virtual displays of unplugged phones");
            self.publish_fleet().await;
        }
    }
}
