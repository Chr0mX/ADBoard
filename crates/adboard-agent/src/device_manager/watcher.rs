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

/// Online phones whose connection generation moved since the last poll that handled them: they
/// reconnected between two polls (the track-devices stream saw them drop and return), so their
/// stream must be restarted once. A phone seen for the first time is only recorded, and one that
/// already has a restart planned from the poll's own view is not planned twice.
pub(super) fn generation_restarts(
    online: &[&str],
    handled: &mut HashMap<String, u64>,
    current: &dyn Fn(&str) -> u64,
    already_planned: &std::collections::HashSet<String>,
) -> Vec<String> {
    let mut restart = Vec::new();
    for serial in online {
        let generation = current(serial);
        let before = handled.insert((*serial).to_string(), generation);
        if matches!(before, Some(old) if old != generation) && !already_planned.contains(*serial) {
            restart.push((*serial).to_string());
        }
    }
    restart
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

/// First wait before retrying a lost phone, doubling up to `RECONNECT_MAX_SECS`.
pub(super) const RECONNECT_FIRST_SECS: u64 = 10;
pub(super) const RECONNECT_MAX_SECS: u64 = 300;
/// After this many tries a phone is left alone until it shows up online again.
pub(super) const RECONNECT_MAX_ATTEMPTS: u32 = 10;

/// Wait after `attempts` tries: 10 s, 20 s, 40 s ... capped at 5 minutes.
pub(super) fn reconnect_delay(attempts: u32) -> Duration {
    let secs = RECONNECT_FIRST_SECS.saturating_mul(1u64 << attempts.min(16));
    Duration::from_secs(secs.min(RECONNECT_MAX_SECS))
}

/// Phones that were online and are gone, each retried on its own backoff.
/// One phone's retries never wait on, or repeat for, another.
#[derive(Default)]
pub(super) struct Reconnects {
    lost: HashMap<String, (u32, std::time::Instant)>,
}

impl Reconnects {
    /// Start tracking a phone that just dropped (its first try is due at once).
    pub(super) fn lost(&mut self, serial: &str, now: std::time::Instant) {
        self.lost.entry(serial.to_string()).or_insert((0, now));
    }

    /// The phone is back (or needs the user, not a retry): stop.
    pub(super) fn recovered(&mut self, serial: &str) {
        self.lost.remove(serial);
    }

    /// Phones whose try is due now, with the number of tries made before this one
    /// (0 is the first). Each is scheduled for its next try; one that has used all
    /// its tries is dropped.
    pub(super) fn due(&mut self, now: std::time::Instant) -> Vec<(String, u32)> {
        let mut out = Vec::new();
        self.lost.retain(|serial, (attempts, next_at)| {
            if *attempts >= RECONNECT_MAX_ATTEMPTS {
                return false;
            }
            if now >= *next_at {
                out.push((serial.clone(), *attempts));
                *attempts += 1;
                *next_at = now + reconnect_delay(*attempts);
            }
            true
        });
        out.sort();
        out
    }
}

/// What the poll loop does about the adb server after a failed `adb devices`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ServerFix {
    None,
    /// `adb start-server`: the server was probably still starting.
    Start,
    /// `adb kill-server` then `start-server`: it keeps not answering.
    Restart,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct FailureStep {
    /// Shown once per run of failures, not every poll.
    pub notice: Option<String>,
    pub fix: ServerFix,
    /// Time until the next poll.
    pub wait: Duration,
}

/// Consecutive `adb devices` failures, so the loop backs off and repairs the
/// server instead of failing (and notifying) every 2 s.
#[derive(Debug, Default)]
pub(super) struct PollHealth {
    failures: u32,
}

impl PollHealth {
    /// A poll answered. Returns a notice when it follows failures.
    pub fn success(&mut self) -> Option<String> {
        let was_failing = self.failures > 0;
        self.failures = 0;
        was_failing.then(|| "ADB is answering again.".to_string())
    }

    pub fn failure(&mut self, error: &str) -> FailureStep {
        self.failures = self.failures.saturating_add(1);
        let n = self.failures;
        let timed_out = error.contains("did not answer");
        let fix = match n {
            _ if !timed_out => ServerFix::None,
            1 => ServerFix::Start,
            3 => ServerFix::Restart,
            n if n > 3 && (n - 3) % 10 == 0 => ServerFix::Restart,
            _ => ServerFix::None,
        };
        let wait = match n {
            1 => ADB_POLL_SECS,
            2 => 4,
            3 => 8,
            _ => 10,
        };
        FailureStep {
            notice: (n == 1).then(|| describe_adb_failure(error)),
            fix,
            wait: Duration::from_secs(wait.max(ADB_POLL_SECS)),
        }
    }
}

/// The notice for a failed `adb devices`, with what to do about it.
pub(super) fn describe_adb_failure(error: &str) -> String {
    let lower = error.to_ascii_lowercase();
    if lower.contains("doesn't match") || lower.contains("does not match") {
        return "adb devices failed: another adb on this PC is a different version and keeps restarting the adb server. \
                Close Android Studio or other phone tools, or remove their adb from PATH."
            .to_string();
    }
    if error.contains("did not answer") {
        return format!("adb devices failed: {error}. The adb server may be starting or stuck; ADBoard is restarting it.");
    }
    format!("adb devices failed: {error}")
}

/// Reconnect the saved wireless phones (at start, and after the server restarts).
async fn restore_wireless(adb: &std::path::Path) {
    for endpoint in adb::load_wireless() {
        match tokio::time::timeout(Duration::from_secs(8), adb::connect_wireless(adb, &endpoint, None)).await {
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
    /// A phone that came back goes back to normal: screen on and awake, unless Quiet mode is
    /// on (its screen setting is off: the new stream already turned the screen off) or the
    /// Quiet Mode Loop is running (which puts the phone into Quiet mode itself, now that
    /// it has been told the phone just connected).
    pub(super) async fn restore_screen_after_reconnect(&self, serial: &str) {
        if crate::quiet_cycle::loop_running() {
            // A quick unplug and replug can fall between two checks of the loop: tell it.
            crate::quiet_cycle::note_connected(serial);
            return;
        }
        if self.inner.sessions.prefs().await.screen_off {
            return;
        }
        if let Err(error) = self.inner.sessions.set_display_power(serial, true).await {
            info!(%serial, %error, "could not turn the display back on through scrcpy");
        }
        if let Some(adb) = self.inner.adb_path.clone() {
            if let Err(error) = crate::device_ops::wake_screen(&adb, serial).await {
                info!(%serial, %error, "could not wake the screen after reconnect");
            }
        }
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
                // Benchmarks: change one mock phone's vitals every 2 s, the way
                // real phones' battery and CPU readings keep the fleet updating.
                if crate::env::truthy("MOCK_VITALS") {
                    let mut turn = 0usize;
                    loop {
                        tokio::time::sleep(Duration::from_secs(2)).await;
                        {
                            let mut guard = state.inner.devices.write().await;
                            let count = guard.len();
                            if count == 0 {
                                continue;
                            }
                            let device = &mut guard[turn % count];
                            device.cpu_percent = Some(((turn * 7) % 90) as f32 + 5.0);
                            turn += 1;
                        }
                        state.publish_fleet().await;
                    }
                }
            });
            return;
        };
        info!(path = %adb.display(), "ADB found — polling devices every {ADB_POLL_SECS}s");
        let state = self.clone();
        tokio::spawn(async move {
            // Start the server up front with a generous limit: the first
            // `adb devices` would otherwise have to start it inside its own limit.
            match adb::start_server(&adb).await {
                Ok(()) => info!("adb server running"),
                Err(error) => {
                    warn!(%error, "adb start-server failed");
                    state.publish(ServerEvent::Notice {
                        message: format!("Could not start the adb server: {error}"),
                    });
                }
            }
            restore_wireless(&adb).await;
            let mut health = PollHealth::default();
            let mut known_resolutions: HashMap<String, adboard_protocol::DeviceResolution> =
                HashMap::new();
            let mut batteries: HashMap<String, CachedBattery> = HashMap::new();
            let mut previous: HashMap<String, DeviceStatus> = HashMap::new();
            let mut last_recovery: HashMap<String, std::time::Instant> = HashMap::new();
            let mut reconnects = Reconnects::default();
            // The connection generation of each phone as of the last poll that handled it.
            let mut handled_generation: HashMap<String, u64> = HashMap::new();
            // The adb server's own connect / disconnect stream; the poll below stays the authority.
            if let Some(addr) = super::tracker::track_addr() {
                state.spawn_tracker(addr);
            }
            loop {
                // With the stream delivering, the poll is only a safety net and can relax.
                let mut wait = if state.inner.connections.tracker_up.load(std::sync::atomic::Ordering::Relaxed) {
                    Duration::from_secs(ADB_POLL_SECS_WITH_TRACKER)
                } else {
                    Duration::from_secs(ADB_POLL_SECS)
                };
                match adb::list_adb_devices(&adb).await {
                    Ok(lines) => {
                        if let Some(message) = health.success() {
                            info!("adb devices answering again");
                            state.publish(ServerEvent::Notice { message });
                        }
                        state
                            .apply_adb_snapshot(&adb, &lines, &mut known_resolutions, &mut batteries)
                            .await;
                        let next = state.list_local_devices().await;
                        for device in &next {
                            // Back online, or waiting for the user to allow it: no more retries.
                            if device.status != DeviceStatus::Offline {
                                reconnects.recovered(&device.serial);
                            }
                        }
                        // Record every connect and disconnect. This is idempotent: the track-devices stream
                        // may have reported the same change already, and it counts once.
                        for device in &next {
                            state.observe_connection(&device.serial, device.status == DeviceStatus::Online, "poll");
                        }
                        for (serial, status) in &previous {
                            if *status == DeviceStatus::Online && !next.iter().any(|d| &d.serial == serial) {
                                state.observe_connection(serial, false, "poll");
                            }
                        }
                        let mut actions = recovery_actions(&previous, &next, connect_display_size().is_some());
                        // A phone whose connection generation moved since we last looked reconnected between
                        // two polls (the stream saw it drop and return): restart its stream once, as for a
                        // reconnect the poll saw itself.
                        let already: std::collections::HashSet<String> = actions
                            .iter()
                            .filter_map(|a| match a {
                                RecoveryAction::RestartSession { serial } => Some(serial.clone()),
                                _ => None,
                            })
                            .collect();
                        let online: Vec<&str> = next
                            .iter()
                            .filter(|d| d.status == DeviceStatus::Online)
                            .map(|d| d.serial.as_str())
                            .collect();
                        let forced: std::collections::HashSet<String> =
                            generation_restarts(&online, &mut handled_generation, &|serial| state.connection_generation(serial), &already)
                                .into_iter()
                                .collect();
                        for serial in &forced {
                            actions.push(RecoveryAction::RestartSession { serial: serial.clone() });
                        }
                        for action in actions {
                            let serial = action.serial();
                            if let RecoveryAction::RestartAdb { serial } = &action {
                                reconnects.lost(serial, std::time::Instant::now());
                                continue;
                            }
                            let due = forced.contains(serial)
                                || last_recovery
                                    .get(serial)
                                    .map(|at| at.elapsed() > Duration::from_secs(20))
                                    .unwrap_or(true);
                            if !due {
                                continue;
                            }
                            last_recovery.insert(serial.to_string(), std::time::Instant::now());
                            match action {
                                RecoveryAction::RestartAdb { .. } => {}
                                RecoveryAction::RestartSession { serial } => {
                                    info!(%serial, "device online — restarting scrcpy");
                                    // Restarting a stream takes several adb calls; it
                                    // must not hold up the poll for the other phones.
                                    let state = state.clone();
                                    let generation = state.connection_generation(&serial);
                                    tokio::spawn(async move {
                                        let current = |state: &AppState| state.connection_generation(&serial) == generation;
                                        // The reset sent when the phone dropped fails if the cable was
                                        // pulled first; do it now that adb can reach the phone again.
                                        state.reset_overridden_display_size(&serial).await;
                                        if !current(&state) {
                                            info!(%serial, "phone reconnected again; this restart is out of date");
                                            return;
                                        }
                                        state.apply_connect_display_size(&serial).await;
                                        if !current(&state) {
                                            info!(%serial, "phone reconnected again; this restart is out of date");
                                            return;
                                        }
                                        match state.restart_session_local(&serial).await {
                                            Ok(session) => {
                                                state.publish(ServerEvent::SessionUpdated { session });
                                            }
                                            Err(error) => {
                                                warn!(%serial, %error, "automatic scrcpy restart failed");
                                            }
                                        }
                                        state.restore_screen_after_reconnect(&serial).await;
                                    });
                                }
                            }
                        }
                        // Retry phones that are still gone, each on its own backoff.
                        for (serial, tries) in reconnects.due(std::time::Instant::now()) {
                            let adb = adb.clone();
                            let state = state.clone();
                            let generation = state.connection_generation(&serial);
                            info!(%serial, tries, "phone disconnected — trying to reconnect");
                            tokio::spawn(async move {
                                // The phone came back (or dropped again) since this try was planned: skip it.
                                if state.connection_generation(&serial) != generation {
                                    return;
                                }
                                if tries == 0 {
                                    // Once per disconnect; best-effort, often fails if the cable is already gone.
                                    state.reset_overridden_display_size(&serial).await;
                                    if let Err(error) = crate::device_ops::wake_screen(&adb, &serial).await {
                                        info!(%serial, %error, "could not wake the screen of the disconnected phone");
                                    }
                                }
                                let args = vec!["-s".into(), serial.clone(), "reconnect".into()];
                                match crate::device_ops::adb_text(&adb, &args).await {
                                    Ok(output) => info!(%serial, %output, "automatic adb reconnect"),
                                    Err(error) => warn!(%serial, %error, "automatic adb reconnect failed"),
                                }
                            });
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
                        let step = health.failure(&e);
                        if let Some(message) = step.notice {
                            state.publish(ServerEvent::Notice { message });
                        }
                        match step.fix {
                            ServerFix::None => {}
                            ServerFix::Start => {
                                info!("adb did not answer — starting the adb server");
                                if let Err(error) = adb::start_server(&adb).await {
                                    warn!(%error, "adb start-server failed");
                                }
                            }
                            ServerFix::Restart => {
                                warn!("adb still not answering — restarting the adb server");
                                match adb::restart_server(&adb).await {
                                    Ok(()) => restore_wireless(&adb).await,
                                    Err(error) => warn!(%error, "adb server restart failed"),
                                }
                            }
                        }
                        wait = step.wait;
                    }
                }
                // An event (a connect or disconnect from the stream) cuts the wait short.
                tokio::select! {
                    _ = tokio::time::sleep(wait) => {}
                    _ = state.inner.connections.poll_wake.notified() => {}
                }
            }
        });
    }

    /// Periodically reap exited scrcpy children and publish session updates.
    pub fn spawn_session_reaper(&self) {
        let state = self.clone();
        tokio::spawn(async move {
            let mut last_recovery: HashMap<String, std::time::Instant> = HashMap::new();
            let mut retries = crate::session::RetryBook::new();
            let retrying: Arc<std::sync::Mutex<std::collections::HashSet<String>>> = Arc::default();
            loop {
                tokio::time::sleep(Duration::from_secs(SESSION_REAP_SECS)).await;
                state.retry_failed_starts(&mut retries, &retrying).await;
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

    /// A phone whose stream failed to start is tried again, slowly, while a page is watching it and the phone is
    /// online. Before this nothing did: the session stayed in Error with the page's socket open and waiting.
    async fn retry_failed_starts(
        &self,
        book: &mut crate::session::RetryBook,
        in_flight: &Arc<std::sync::Mutex<std::collections::HashSet<String>>>,
    ) {
        let pending = self.inner.sessions.pending_start_failures().await;
        if pending.is_empty() {
            book.due(&[], &[], std::time::Instant::now());
            return;
        }
        let online: std::collections::HashSet<String> = self
            .list_local_devices()
            .await
            .into_iter()
            .filter(|d| d.status == DeviceStatus::Online)
            .map(|d| d.serial)
            .collect();
        let hub = self.video_hub();
        let mut failed = Vec::new();
        let mut all = Vec::new();
        for (serial, stream) in pending {
            all.push(serial.clone());
            let starting_now = in_flight.lock().map(|set| set.contains(&serial)).unwrap_or(false);
            if stream == StreamState::Error && !starting_now && online.contains(&serial) && hub.subscriber_count(&serial).await > 0 {
                failed.push(serial);
            }
        }
        let now = std::time::Instant::now();
        for (serial, attempt) in book.due(&failed, &all, now) {
            let next_in = book.next_in(&serial, now).map(|d| d.as_secs()).unwrap_or(0);
            info!(%serial, attempt, next_retry_in_secs = next_in, "retrying the start of a phone's stream");
            if let Ok(mut set) = in_flight.lock() {
                set.insert(serial.clone());
            }
            let state = self.clone();
            let in_flight = in_flight.clone();
            tokio::spawn(async move {
                if let Ok(session) = state.restart_session(&serial).await {
                    state.publish(ServerEvent::SessionUpdated { session });
                }
                if let Ok(mut set) = in_flight.lock() {
                    set.remove(&serial);
                }
            });
        }
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
