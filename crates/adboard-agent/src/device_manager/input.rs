//! Input to phones: taps, finger events, gestures, nav keys, typed text, key events and video refresh.
//! Several phones are driven at once (see `fanout`); each phone still gets its own events in order.

use super::*;

pub(super) fn frame_tap(
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

impl AppState {
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

        if let Some(host_id) = by_remote.keys().next() {
            if self.inner.role != Role::Controller {
                return Err(format!("cannot reach remote host {host_id} from agent"));
            }
        }
        let local_taps = map_to_devices(point, &local_group);
        let pairs: Vec<(Device, MappedTap)> = local_group.into_iter().zip(local_taps).collect();
        let sessions = &self.inner.sessions;
        let local_run = fanout::fan_out(pairs, fanout::DEFAULT_LIMIT, |(device, mut tap)| async move {
            let result = sessions.inject_tap(&device.serial, &tap).await;
            tap.inject = result.status;
            tap.inject_detail = result.detail;
            tap
        });
        let remote_run = fanout::fan_out_remote(
            by_remote,
            |host_id, group| {
                let ids: Vec<String> = group.iter().map(|d| d.id.clone()).collect();
                async move { self.inner.mesh.proxy_tap(&host_id, mode, ids, point).await }
            },
            |d, error| {
                let mut tap = adboard_protocol::map_point(point, d);
                tap.inject = InjectStatus::Error;
                tap.inject_detail = Some(error.to_string());
                tap
            },
        );
        let (mut mapped, remote) = tokio::join!(local_run, remote_run);
        mapped.extend(remote);

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
        let taps: Vec<MappedTap> = map_to_devices(point, &devices);
        let pairs: Vec<(Device, MappedTap)> = devices.into_iter().zip(taps).collect();
        let sessions = &self.inner.sessions;
        let mapped = fanout::fan_out(pairs, fanout::DEFAULT_LIMIT, |(device, mut tap)| async move {
            let result = sessions.inject_tap(&device.serial, &tap).await;
            tap.inject = result.status;
            tap.inject_detail = result.detail;
            tap
        })
        .await;
        Ok(TapBroadcast::new(mode, point, mapped))
    }

    /// Pass a finger event through to each device's scrcpy control socket.
    pub async fn handle_pointer(
        &self,
        mode: ControlMode,
        target_ids: &[String],
        phase: PointerPhase,
        tool: PointerTool,
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
                self.inject_pointer_group(
                    &local_group,
                    phase,
                    tool,
                    point,
                    frame_width,
                    frame_height,
                )
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
                    tool,
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
        if !matches!(
            phase,
            PointerPhase::Move | PointerPhase::Hover | PointerPhase::Leave
        ) {
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
        tool: PointerTool,
        point: NormalizedPoint,
        frame_width: u32,
        frame_height: u32,
    ) -> Result<TapBroadcast, String> {
        let devices = self.resolve_local_targets(target_ids).await?;
        if devices.is_empty() {
            return Err("no online local targets for pointer".into());
        }
        let mapped = self
            .inject_pointer_group(&devices, phase, tool, point, frame_width, frame_height)
            .await;
        Ok(TapBroadcast::new(mode, point, mapped))
    }

    /// Play a timed single- or multi-touch gesture on every target at once.
    /// Each phone runs on its own task, so a browser that disconnects
    /// mid-gesture still gets every finger lifted.
    pub async fn handle_gesture(&self, request: GestureRequest) -> Result<GestureResult, String> {
        crate::gesture::validate(&request.strokes)?;
        let devices = self.resolve_targets(&request.target_ids).await?;
        if devices.is_empty() {
            return Err("no online targets for gesture".into());
        }
        let local_serials = self.local_serial_set().await;
        let mut tasks = Vec::new();
        let mut by_remote: HashMap<String, Vec<Device>> = HashMap::new();
        for device in devices {
            if local_serials.contains(&device.serial) {
                let state = self.clone();
                let strokes = request.strokes.clone();
                let (id, name) = (device.id.clone(), device.name.clone());
                tasks.push((id, name, tokio::spawn(async move {
                    state.play_gesture_local(&device, &strokes).await
                })));
            } else {
                by_remote
                    .entry(device.effective_host_id().to_string())
                    .or_default()
                    .push(device);
            }
        }
        let mut remote_tasks = Vec::new();
        for (host_id, group) in by_remote {
            if self.inner.role != Role::Controller {
                return Err(format!("cannot reach remote host {host_id} from agent"));
            }
            let state = self.clone();
            let body = GestureRequest {
                mode: request.mode,
                target_ids: group.iter().map(|d| d.id.clone()).collect(),
                strokes: request.strokes.clone(),
            };
            let phones: Vec<(String, String)> =
                group.iter().map(|d| (d.id.clone(), d.name.clone())).collect();
            remote_tasks.push((phones, tokio::spawn(async move {
                match state.proxy_gesture_http(&host_id, &body).await {
                    Ok(targets) => targets,
                    Err(e) => group
                        .iter()
                        .map(|d| NavTargetResult {
                            device_id: d.id.clone(),
                            device_name: d.name.clone(),
                            inject: InjectStatus::Error,
                            detail: Some(e.clone()),
                        })
                        .collect(),
                }
            })));
        }
        let mut targets = Vec::new();
        // A task that panicked or was cancelled still gets a result row for
        // its phone, so the reply never claims fewer targets than were asked.
        for (device_id, device_name, task) in tasks {
            match task.await {
                Ok(result) => targets.push(result),
                Err(e) => {
                    warn!(error = %e, "[gesture] task failed");
                    targets.push(NavTargetResult {
                        device_id,
                        device_name,
                        inject: InjectStatus::Error,
                        detail: Some(format!("gesture task failed: {e}")),
                    });
                }
            }
        }
        for (phones, task) in remote_tasks {
            match task.await {
                Ok(result) => targets.extend(result),
                Err(e) => {
                    warn!(error = %e, "[gesture] remote task failed");
                    targets.extend(phones.into_iter().map(|(device_id, device_name)| NavTargetResult {
                        device_id,
                        device_name,
                        inject: InjectStatus::Error,
                        detail: Some(format!("gesture task failed: {e}")),
                    }));
                }
            }
        }
        Ok(GestureResult::new(request.mode, request.target_ids, targets))
    }

    async fn play_gesture_local(&self, device: &Device, strokes: &[GestureStroke]) -> NavTargetResult {
        let lock = crate::gesture::device_lock(&device.serial);
        let _held = lock.lock().await;
        let result = |inject: InjectStatus, detail: Option<String>| NavTargetResult {
            device_id: device.id.clone(),
            device_name: device.name.clone(),
            inject,
            detail,
        };
        let sessions = &self.inner.sessions;

        if !sessions.adb_available() {
            // Mock fleet: keep the timing so a macro runs at its real pace.
            tokio::time::sleep(Duration::from_millis(u64::from(crate::gesture::total_ms(strokes))))
                .await;
            info!(serial = %device.serial, strokes = strokes.len(), "[stub-inject] gesture");
            return result(InjectStatus::Stub, Some("no ADB — mock fleet stub inject".into()));
        }

        let mut size = sessions.video_display_size(&device.serial).await;
        if size.is_none() || !sessions.has_control(&device.serial).await {
            let _ = sessions.ensure_streaming(&device.serial).await;
            for _ in 0..20 {
                size = sessions.video_display_size(&device.serial).await;
                if size.is_some() && sessions.has_control(&device.serial).await {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
        let live = match size {
            Some(size) if sessions.has_control(&device.serial).await => Some(size),
            _ => None,
        };

        let Some((width, height)) = live else {
            // No live screen: one finger still works through `adb input`.
            if let Some((from, to, ms)) = crate::gesture::single_line(strokes) {
                let w = device.resolution.width.max(1);
                let h = device.resolution.height.max(1);
                let px = |p: NormalizedPoint| {
                    (
                        (p.x.clamp(0.0, 1.0) * f64::from(w - 1)).round() as u32,
                        (p.y.clamp(0.0, 1.0) * f64::from(h - 1)).round() as u32,
                    )
                };
                let start = strokes[0].start_ms;
                if start > 0 {
                    tokio::time::sleep(Duration::from_millis(u64::from(start))).await;
                }
                let r = sessions.adb_swipe(&device.serial, px(from), px(to), ms).await;
                return result(r.status, r.detail);
            }
            return result(
                InjectStatus::Error,
                Some("multi-touch needs the live screen (scrcpy) — open the phone first".into()),
            );
        };

        let events = match crate::gesture::timeline(strokes) {
            Ok(events) => events,
            Err(e) => return result(InjectStatus::Error, Some(e)),
        };
        let started = tokio::time::Instant::now();
        let mut down: HashMap<u8, (u32, u32)> = HashMap::new();
        let to_px = |v: f64, size: u32| (v * f64::from(size.saturating_sub(1))).round() as u32;
        let mut failure: Option<String> = None;
        for event in &events {
            tokio::time::sleep_until(started + Duration::from_millis(u64::from(event.at_ms))).await;
            let x = to_px(event.x, width);
            let y = to_px(event.y, height);
            let r = sessions
                .inject_slot(&device.serial, event.phase, event.slot, x, y, width, height)
                .await;
            if r.status == InjectStatus::Error {
                failure = Some(r.detail.unwrap_or_else(|| "touch failed".into()));
                break;
            }
            match event.phase {
                PointerPhase::Down | PointerPhase::Move => {
                    down.insert(event.slot, (x, y));
                }
                _ => {
                    down.remove(&event.slot);
                }
            }
        }
        // Lift anything still down so the phone is never left with a stuck finger.
        for (slot, (x, y)) in down {
            let _ = sessions
                .inject_slot(&device.serial, PointerPhase::Up, slot, x, y, width, height)
                .await;
        }
        match failure {
            Some(e) => {
                warn!(serial = %device.serial, error = %e, "[gesture] failed");
                result(InjectStatus::Error, Some(e))
            }
            None => {
                info!(serial = %device.serial, strokes = strokes.len(), "[gesture] played");
                result(InjectStatus::Ok, Some("scrcpy".into()))
            }
        }
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

        if let Some(host_id) = by_remote.keys().next() {
            if self.inner.role != Role::Controller {
                return Err(format!("cannot reach remote host {host_id} from agent"));
            }
        }
        let ids: Vec<String> = local_group
            .iter()
            .chain(by_remote.values().flatten())
            .map(|d| d.id.clone())
            .collect();
        let sessions = &self.inner.sessions;
        let local_run = fanout::fan_out(local_group, fanout::DEFAULT_LIMIT, |d| async move {
            let result = sessions.inject_nav(&d.serial, action).await;
            NavTargetResult {
                device_id: d.id.clone(),
                device_name: d.name.clone(),
                inject: result.status,
                detail: result.detail,
            }
        });
        let remote_run = fanout::fan_out_remote(
            by_remote,
            |host_id, group| {
                let group_ids: Vec<String> = group.iter().map(|d| d.id.clone()).collect();
                async move {
                    self.inner
                        .mesh
                        .proxy_nav(&host_id, mode, group_ids, action)
                        .await
                }
            },
            |d, error| NavTargetResult {
                device_id: d.id.clone(),
                device_name: d.name.clone(),
                inject: InjectStatus::Error,
                detail: Some(error.to_string()),
            },
        );
        let (mut results, remote) = tokio::join!(local_run, remote_run);
        results.extend(remote);

        let broadcast = NavBroadcast::new(mode, action, ids, results);
        self.publish(ServerEvent::NavResult {
            broadcast: broadcast.clone(),
        });
        Ok(broadcast)
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
        let ids: Vec<String> = devices.iter().map(|d| d.id.clone()).collect();
        let sessions = &self.inner.sessions;
        let results = fanout::fan_out(devices, fanout::DEFAULT_LIMIT, |device| async move {
            let result = sessions.inject_nav(&device.serial, action).await;
            NavTargetResult {
                device_id: device.id.clone(),
                device_name: device.name.clone(),
                inject: result.status,
                detail: result.detail,
            }
        })
        .await;
        Ok(NavBroadcast::new(mode, action, ids, results))
    }

    /// Ask each device's scrcpy server for a new video keyframe. The H264 process stays up.
    pub async fn handle_video_refresh(
        &self,
        body: VideoRefreshRequest,
    ) -> Result<ClipboardResponse, String> {
        let (local, by_remote) = self.split_targets(&body.target_ids).await?;
        let sessions = &self.inner.sessions;
        let local_run = fanout::fan_out(local, fanout::DEFAULT_LIMIT, |device| async move {
            match sessions.reset_video(&device.serial).await {
                Ok(()) => op_done(&device),
                Err(e) => op_error(&device, e),
            }
        });
        let remote_run = fanout::fan_out_remote(
            by_remote,
            |host_id, group| {
                let forward = VideoRefreshRequest {
                    mode: ControlMode::Selected,
                    target_ids: group.iter().map(|d| d.id.clone()).collect(),
                };
                async move {
                    self.proxy_json::<VideoRefreshRequest, ClipboardResponse>(
                        &host_id,
                        "/api/input/refresh",
                        &forward,
                    )
                    .await
                    .map(|remote| remote.results)
                }
            },
            |device, error| op_error(device, error.to_string()),
        );
        let (mut results, remote) = tokio::join!(local_run, remote_run);
        results.extend(remote);
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
        let sessions = &self.inner.sessions;
        let text = &body.text;
        let local_run = fanout::fan_out(local, fanout::DEFAULT_LIMIT, |device| async move {
            match sessions.inject_text(&device.serial, text).await {
                Ok(()) => op_done(&device),
                Err(e) => op_error(&device, e),
            }
        });
        let remote_run = fanout::fan_out_remote(
            by_remote,
            |host_id, group| {
                let forward = TextInjectRequest {
                    mode: ControlMode::Selected,
                    target_ids: group.iter().map(|d| d.id.clone()).collect(),
                    text: body.text.clone(),
                };
                async move {
                    self.proxy_json::<TextInjectRequest, ClipboardResponse>(
                        &host_id,
                        "/api/input/text",
                        &forward,
                    )
                    .await
                    .map(|remote| remote.results)
                }
            },
            |device, error| op_error(device, error.to_string()),
        );
        let (mut results, remote) = tokio::join!(local_run, remote_run);
        results.extend(remote);
        Ok(ClipboardResponse { results })
    }

    pub async fn handle_key(&self, body: KeyInjectRequest) -> Result<ClipboardResponse, String> {
        let action = match body.action.as_str() {
            "down" => 0u8,
            "up" => 1,
            _ => return Err("key action must be down or up".into()),
        };
        let (local, by_remote) = self.split_targets(&body.target_ids).await?;
        let sessions = &self.inner.sessions;
        let local_run = fanout::fan_out(local, fanout::DEFAULT_LIMIT, |device| async move {
            match sessions
                .inject_keycode(&device.serial, action, body.keycode, body.repeat, body.metastate)
                .await
            {
                Ok(()) => op_done(&device),
                Err(e) => op_error(&device, e),
            }
        });
        let remote_run = fanout::fan_out_remote(
            by_remote,
            |host_id, group| {
                let forward = KeyInjectRequest {
                    mode: ControlMode::Selected,
                    target_ids: group.iter().map(|d| d.id.clone()).collect(),
                    action: body.action.clone(),
                    keycode: body.keycode,
                    repeat: body.repeat,
                    metastate: body.metastate,
                };
                async move {
                    self.proxy_json::<KeyInjectRequest, ClipboardResponse>(
                        &host_id,
                        "/api/input/key",
                        &forward,
                    )
                    .await
                    .map(|remote| remote.results)
                }
            },
            |device, error| op_error(device, error.to_string()),
        );
        let (mut results, remote) = tokio::join!(local_run, remote_run);
        results.extend(remote);
        Ok(ClipboardResponse { results })
    }
}
