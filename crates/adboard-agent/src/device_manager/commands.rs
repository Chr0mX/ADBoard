//! Device operations: the command fan-out to local and remote phones, per-phone commands, display size, and gestures.

use super::*;

impl AppState {
    pub async fn handle_command(
        &self,
        request: DeviceCommandRequest,
    ) -> Result<DeviceCommandResponse, String> {
        // Someone changing the sound by hand ends the repeating Quiet cycle.
        if request.op.trim() == "mute" {
            crate::quiet_cycle::manual_change();
        }
        self.run_command(request).await
    }

    /// The command fan-out itself; the Quiet cycle calls this directly so its own
    /// mute calls do not count as a manual change.
    pub async fn run_command(
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
            self.command_one(&device, op, command.arg.as_deref(), command.arg2.as_deref())
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

    pub(super) async fn command_one(
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
                Err(_) if self.inner.adb_path.is_none() => {
                    op_ok(device, "rotated (mock phone)".into())
                }
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

    pub(super) async fn apply_display_size(
        &self,
        device: &Device,
        arg: Option<&str>,
    ) -> DeviceOpResult {
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
    pub(super) async fn reset_overridden_display_size(&self, serial: &str) {
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
    pub(super) async fn apply_connect_display_size(&self, serial: &str) {
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

    pub(super) async fn gesture(
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

    pub(super) async fn proxy_command_http(
        &self,
        host_id: &str,
        request: &DeviceCommandRequest,
    ) -> Result<Vec<DeviceOpResult>, String> {
        let Some(base) = self.inner.mesh.http_base(host_id).await else {
            return Err(format!("agent {host_id} has no http_base"));
        };
        let url = format!("{}/api/device/command", base.trim_end_matches('/'));
        let body = serde_json::to_vec(request).map_err(|e| e.to_string())?;
        let (status, text) = http_post_bytes(
            &url,
            &[
                ("Content-Type", "application/json"),
                ("x-adboard-token", self.api_token()),
            ],
            &body,
        )
        .await?;
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
}
