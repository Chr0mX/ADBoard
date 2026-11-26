//! Moving bytes to and from phones: APK installs, file push and pull, and the clipboard.
//! Each works on a set of target phones, installs locally and proxies the rest to the agent that owns them.

use super::*;

impl AppState {
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

    pub(super) async fn install_local_group(
        &self,
        devices: &[Device],
        bytes: &[u8],
    ) -> Vec<NavTargetResult> {
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
        let results = fanout::fan_out(
            devices.to_vec(),
            fanout::TRANSFER_LIMIT,
            |device| async move {
                let result = sessions.install_apk(&device.serial, apk).await;
                NavTargetResult {
                    device_id: device.id.clone(),
                    device_name: device.name.clone(),
                    inject: result.status,
                    detail: result.detail,
                }
            },
        )
        .await;
        drop(staged);
        results
    }

    pub(super) async fn proxy_install_http(
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
        let results = fanout::fan_out(
            devices.clone(),
            fanout::TRANSFER_LIMIT,
            |device| async move {
                match crate::device_ops::adb_push(adb_ref, &device.serial, local_ref, dest_ref)
                    .await
                {
                    Ok(output) => op_ok(&device, output),
                    Err(error) => op_error(&device, error),
                }
            },
        )
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
}
