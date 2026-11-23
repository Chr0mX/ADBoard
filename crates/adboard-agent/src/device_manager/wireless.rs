//! Wireless ADB: connecting by address, the saved endpoints, and pairing with a QR code.

use super::*;

impl AppState {
    pub async fn add_wireless(
        &self,
        address: &str,
        port: Option<u16>,
        pairing_port: Option<u16>,
        pairing_code: Option<&str>,
    ) -> Result<(String, String), String> {
        let endpoint = adb::parse_wireless_endpoint(address, port)?;
        let pairing = adb::parse_pairing(pairing_port, pairing_code)?;
        let Some(adb) = self.inner.adb_path.clone() else {
            return Err("adb is not available".into());
        };
        let message = match tokio::time::timeout(
            Duration::from_secs(12),
            adb::connect_wireless(&adb, &endpoint, pairing.as_ref()),
        )
        .await
        {
            Ok(result) => result?,
            Err(_) => return Err("timed out connecting to the phone".into()),
        };
        if let Err(error) = adb::remember_wireless(&endpoint) {
            warn!(%error, "wireless device connected but was not saved");
        }
        Ok((endpoint.display(), message))
    }

    pub fn list_wireless(&self) -> Vec<String> {
        adb::load_wireless()
            .into_iter()
            .map(|endpoint| endpoint.display())
            .collect()
    }

    pub async fn remove_wireless(&self, address: &str) -> Result<(String, String), String> {
        let endpoint = adb::parse_wireless_endpoint(address, None)?;
        let message = if let Some(adb) = self.inner.adb_path.clone() {
            match tokio::time::timeout(
                Duration::from_secs(8),
                adb::disconnect_wireless(&adb, &endpoint),
            )
            .await
            {
                Ok(Ok(message)) => message,
                Ok(Err(error)) => {
                    let lower = error.to_ascii_lowercase();
                    if lower.contains("no such") || lower.contains("not connected") {
                        format!("removed {}", endpoint.display())
                    } else {
                        let _ = adb::forget_wireless(&endpoint);
                        return Err(error);
                    }
                }
                Err(_) => {
                    let _ = adb::forget_wireless(&endpoint);
                    return Err("timed out disconnecting the phone".into());
                }
            }
        } else {
            "removed from the saved list".into()
        };
        adb::forget_wireless(&endpoint)?;
        Ok((endpoint.display(), message))
    }

    pub fn start_qr_pair(&self) -> Result<QrPairInfo, String> {
        let Some(adb) = self.inner.adb_path.clone() else {
            return Err("adb is not available".into());
        };
        let material = adb::generate_qr_material();
        let svg = adb::qr_svg(&material.payload)?;
        let id = uuid::Uuid::new_v4().to_string();
        let (cancel, cancel_rx) = tokio::sync::watch::channel(false);
        {
            let mut pairs = self
                .inner
                .qr_pairs
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            for slot in pairs.values() {
                let _ = slot.cancel.send(true);
            }
            pairs.clear();
            pairs.insert(
                id.clone(),
                QrPairSlot {
                    state: "waiting".into(),
                    message: "Waiting for the phone to scan.".into(),
                    endpoint: None,
                    cancel,
                },
            );
        }
        let state = self.clone();
        let name = material.name;
        let password = material.password;
        let session_id = id.clone();
        tokio::spawn(async move {
            state
                .run_qr_pair(session_id, adb, name, password, cancel_rx)
                .await;
        });
        Ok(QrPairInfo {
            id,
            payload: material.payload,
            svg,
        })
    }

    pub fn qr_pair_status(&self, id: &str) -> Option<QrPairStatus> {
        let pairs = self
            .inner
            .qr_pairs
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        pairs.get(id).map(|slot| QrPairStatus {
            id: id.to_string(),
            state: slot.state.clone(),
            message: slot.message.clone(),
            endpoint: slot.endpoint.clone(),
        })
    }

    pub fn cancel_qr_pair(&self, id: &str) -> bool {
        let pairs = self
            .inner
            .qr_pairs
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(slot) = pairs.get(id) {
            let _ = slot.cancel.send(true);
            true
        } else {
            false
        }
    }

    pub(super) async fn run_qr_pair(
        &self,
        id: String,
        adb: PathBuf,
        name: String,
        password: String,
        mut cancel: tokio::sync::watch::Receiver<bool>,
    ) {
        let deadline = std::time::Instant::now() + Duration::from_secs(90);
        let mut progress = adb::QrPairProgress::default();
        loop {
            if *cancel.borrow() {
                self.finish_qr(&id, "failed", "QR pairing was cancelled.", None);
                return;
            }
            if std::time::Instant::now() >= deadline {
                self.finish_qr(&id, "failed", "The phone did not scan the QR code.", None);
                return;
            }
            match adb::qr_pair_once(&adb, &name, &password, &mut progress).await {
                Ok(Some(endpoint)) => {
                    if let Err(error) = adb::remember_wireless(&endpoint) {
                        warn!(%error, "phone paired but the address was not saved");
                    }
                    let shown = endpoint.display();
                    self.finish_qr(&id, "paired", &format!("connected to {shown}"), Some(shown));
                    return;
                }
                Ok(None) => {}
                Err(error) => {
                    self.finish_qr(&id, "failed", &error, None);
                    return;
                }
            }
            tokio::select! {
                changed = cancel.changed() => {
                    if changed.is_err() || *cancel.borrow() {
                        self.finish_qr(&id, "failed", "QR pairing was cancelled.", None);
                        return;
                    }
                }
                _ = tokio::time::sleep(Duration::from_secs(1)) => {}
            }
        }
    }

    pub(super) fn finish_qr(&self, id: &str, state: &str, message: &str, endpoint: Option<String>) {
        let mut pairs = self
            .inner
            .qr_pairs
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(slot) = pairs.get_mut(id) {
            if slot.state == "waiting" || state == "paired" {
                slot.state = state.to_string();
                slot.message = message.to_string();
                slot.endpoint = endpoint;
            }
        }
    }
}
