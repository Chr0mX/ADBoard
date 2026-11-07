//! Virtual displays: independent Android screens on a phone, listed as devices.

use super::*;

impl AppState {
    /// A virtual display looks like its phone (same host and model) with its own
    /// key as the serial, so the hub, the grid and the video socket treat it as
    /// one more screen.
    pub(super) async fn virtual_devices_of(&self, phones: &[Device]) -> Vec<Device> {
        let mut out = Vec::new();
        for phone in phones {
            for (index, spec, _id) in self.inner.sessions.virtual_displays_of(&phone.serial).await {
                let mut device = phone.clone();
                device.id = format!("{}#vd{index}", phone.id);
                device.serial = crate::virtual_display::display_key(&phone.serial, index);
                device.name = format!("{} (virtual {index})", phone.name);
                device.resolution = adboard_protocol::DeviceResolution {
                    width: spec.width,
                    height: spec.height,
                };
                device.fps = None;
                device.bitrate_mbps = None;
                device.latency_ms = None;
                out.push(device);
            }
        }
        out
    }

    async fn local_phone(&self, id_or_serial: &str) -> Result<Device, String> {
        self.inner
            .devices
            .read()
            .await
            .iter()
            .find(|d| d.serial == id_or_serial || d.id == id_or_serial)
            .cloned()
            .ok_or_else(|| {
                format!(
                    "{id_or_serial} is not a phone on this computer: use ADBoard on the computer it is plugged into"
                )
            })
    }

    async fn virtual_key(&self, id_or_key: &str) -> Result<String, String> {
        self.list_local_devices()
            .await
            .into_iter()
            .find(|d| {
                (d.serial == id_or_key || d.id == id_or_key)
                    && crate::virtual_display::parse_display_key(&d.serial).is_some()
            })
            .map(|d| d.serial)
            .ok_or_else(|| format!("{id_or_key} is not a virtual display on this computer"))
    }

    /// Create a virtual display on a local phone and start streaming it.
    pub async fn create_virtual_display(
        &self,
        id_or_serial: &str,
        spec: crate::virtual_display::VirtualDisplaySpec,
    ) -> Result<(Device, SessionStatus), String> {
        let phone = self.local_phone(id_or_serial).await?;
        if phone.status != DeviceStatus::Online {
            return Err(format!("{} is not online", phone.name));
        }
        let (key, session) = self
            .inner
            .sessions
            .create_virtual_display(&phone.serial, spec)
            .await?;
        self.publish(ServerEvent::SessionUpdated {
            session: session.clone(),
        });
        self.publish_fleet().await;
        let device = self
            .list_local_devices()
            .await
            .into_iter()
            .find(|d| d.serial == key)
            .ok_or("the virtual display is gone")?;
        Ok((device, session))
    }

    pub async fn close_virtual_display(&self, id_or_key: &str) -> Result<(), String> {
        let key = self.virtual_key(id_or_key).await?;
        self.inner.sessions.close_virtual_display(&key).await;
        self.publish_fleet().await;
        Ok(())
    }

    pub async fn launch_on_virtual_display(
        &self,
        id_or_key: &str,
        component: &str,
    ) -> Result<(), String> {
        let key = self.virtual_key(id_or_key).await?;
        self.inner
            .sessions
            .launch_on_virtual_display(&key, component)
            .await
    }

    /// Every virtual display on this computer: its phone, index, settings, display id.
    pub async fn all_virtual_displays(
        &self,
    ) -> Vec<(Device, u32, crate::virtual_display::VirtualDisplaySpec, Option<u32>)> {
        let phones = self.inner.devices.read().await.clone();
        let mut out = Vec::new();
        for phone in phones {
            for (index, spec, id) in self.inner.sessions.virtual_displays_of(&phone.serial).await {
                out.push((phone.clone(), index, spec, id));
            }
        }
        out
    }

    /// `(index, settings, display id)` of a local phone's virtual displays.
    pub async fn virtual_displays(
        &self,
        id_or_serial: &str,
    ) -> Result<Vec<(u32, crate::virtual_display::VirtualDisplaySpec, Option<u32>)>, String> {
        let phone = self.local_phone(id_or_serial).await?;
        Ok(self.inner.sessions.virtual_displays_of(&phone.serial).await)
    }
}
