//! Virtual displays: a second scrcpy session on a phone, created, listed, closed and fed input.

use super::*;

impl SessionManager {
    /// Inject a mapped tap. Real path: `adb -s SERIAL shell input tap X Y`.
    /// A virtual display's settings and display id, by index, for `serial`.
    pub async fn virtual_displays_of(
        &self,
        serial: &str,
    ) -> Vec<(u32, VirtualDisplaySpec, Option<u32>)> {
        let specs = self.virtual_specs.read().await;
        let sessions = self.sessions.read().await;
        let mut out: Vec<(u32, VirtualDisplaySpec, Option<u32>)> = specs
            .iter()
            .filter_map(|(key, spec)| {
                let (real, index) = virtual_display::parse_display_key(key)?;
                if real != serial {
                    return None;
                }
                let id = sessions
                    .get(key)
                    .and_then(|live| live.server_log.as_ref())
                    .and_then(|log| log.display_id());
                Some((index, spec.clone(), id))
            })
            .collect();
        out.sort_by_key(|(index, _, _)| *index);
        out
    }

    /// The Android display id the server printed for `key`, once known.
    pub async fn virtual_display_id(&self, key: &str) -> Option<u32> {
        self.sessions
            .read()
            .await
            .get(key)
            .and_then(|live| live.server_log.as_ref())
            .and_then(|log| log.display_id())
    }

    /// Create the next free virtual display of `serial` and start streaming it.
    /// Returns its key (`<serial>#vd<N>`) and session.
    pub async fn create_virtual_display(
        &self,
        serial: &str,
        spec: VirtualDisplaySpec,
    ) -> Result<(String, SessionStatus), String> {
        if virtual_display::parse_display_key(serial).is_some() {
            return Err("a virtual display cannot have its own virtual display".into());
        }
        spec.validate().map_err(|e| e.to_string())?;
        let limit = virtual_display::max_per_phone();
        let index = {
            let specs = self.virtual_specs.read().await;
            (1..=limit).find(|i| !specs.contains_key(&virtual_display::display_key(serial, *i)))
        }
        .ok_or_else(|| {
            format!(
                "this phone already has {limit} virtual display(s); close one, or raise ADBOARD_MAX_VIRTUAL_DISPLAYS"
            )
        })?;
        let real_phone =
            self.scrcpy_ready() && !should_use_testpattern(self.video_source, self.scrcpy_ready());
        if real_phone {
            if let Some(adb) = self.adb_path.clone() {
                let args: Vec<String> = vec![
                    "-s".into(),
                    serial.into(),
                    "shell".into(),
                    "getprop".into(),
                    "ro.build.version.sdk".into(),
                ];
                let sdk = run_adb_output(&adb, &args).await?;
                if !virtual_display::sdk_supported(&sdk) {
                    return Err(virtual_display::SpecError::Sdk(sdk.trim().to_string()).to_string());
                }
            }
        }
        let key = virtual_display::display_key(serial, index);
        self.virtual_specs.write().await.insert(key.clone(), spec);
        let status = self.start(&key).await;
        if status.stream == StreamState::Error {
            self.close_virtual_display(&key).await;
            return Err(status.note);
        }
        // The server prints the display id shortly after it starts.
        if real_phone {
            for _ in 0..20 {
                if self.virtual_display_id(&key).await.is_some() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            }
        }
        let status = self.get_session(&key).await.unwrap_or(status);
        Ok((key, status))
    }

    /// Close the virtual displays whose phone is no longer in `present` (it was
    /// unplugged), and return their keys.
    pub async fn prune_virtual_displays(
        &self,
        present: &std::collections::HashSet<String>,
    ) -> Vec<String> {
        let gone: Vec<String> = self
            .virtual_specs
            .read()
            .await
            .keys()
            .filter(|key| match virtual_display::parse_display_key(key) {
                Some((real, _)) => !present.contains(real),
                None => true,
            })
            .cloned()
            .collect();
        for key in &gone {
            self.close_virtual_display(key).await;
        }
        gone
    }

    /// Stop a virtual display and forget it. The apps on it close with it.
    pub async fn close_virtual_display(&self, key: &str) {
        let _ = self.stop(key).await;
        self.sessions.write().await.remove(key);
        self.virtual_specs.write().await.remove(key);
    }

    /// Start `component` (`pkg/.Activity`) on the virtual display `key`.
    pub async fn launch_on_virtual_display(
        &self,
        key: &str,
        component: &str,
    ) -> Result<(), String> {
        let id = self
            .virtual_display_id(key)
            .await
            .ok_or("the virtual display id is not known yet")?;
        let (real, _) = virtual_display::parse_display_key(key).ok_or("not a virtual display")?;
        let Some(adb) = self.adb_path.clone() else {
            return Err("adb is not available".into());
        };
        let mut args: Vec<String> = vec!["-s".into(), real.into()];
        args.extend(virtual_display::am_start_args(id, component).map_err(|e| e.to_string())?);
        run_adb(&adb, &args).await
    }

    /// `adb … shell input [-d ID] <rest>` for a virtual display. Plain `input`
    /// goes to the main display, so an unknown display id is an error, never
    /// a fallback to the physical screen.
    pub(super) async fn virtual_input_args(&self, key: &str, rest: &[String]) -> Result<Vec<String>, String> {
        let (real, _) = virtual_display::parse_display_key(key).ok_or("not a virtual display")?;
        let id = self
            .virtual_display_id(key)
            .await
            .ok_or("the virtual display id is not known yet")?;
        let mut args: Vec<String> = vec![
            "-s".into(),
            real.into(),
            "shell".into(),
            "input".into(),
            "-d".into(),
            id.to_string(),
        ];
        args.extend(rest.iter().cloned());
        Ok(args)
    }
}
