//! Mock fleets matching the Next.js UI seed data when ADB is unavailable.
//!
//! Profiles let a controller + agent demo share one pooled fleet across two
//! local processes without a second machine:
//! - `all` (default on standalone controller): full seed fleet
//! - `windows`: S24 + S23
//! - `lxc`: Pixel + A52

use phonecontrol_protocol::{ConnectionType, Device, DeviceResolution, DeviceStatus};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MockProfile {
    All,
    Windows,
    Lxc,
}

impl MockProfile {
    pub fn from_env() -> Self {
        match std::env::var("PHONECONTROL_MOCK_PROFILE")
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str()
        {
            "windows" | "win" | "controller" => MockProfile::Windows,
            "lxc" | "linux" | "agent" => MockProfile::Lxc,
            _ => MockProfile::All,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            MockProfile::All => "all",
            MockProfile::Windows => "windows",
            MockProfile::Lxc => "lxc",
        }
    }
}

fn tag(mut device: Device, host_id: &str, host_name: &str) -> Device {
    device.host = host_name.into();
    device.host_id = Some(host_id.into());
    device
}

fn s24(host_id: &str, host_name: &str) -> Device {
    tag(
        Device {
            id: "s24".into(),
            name: "S24".into(),
            model: "SM-S921B".into(),
            android_version: "14".into(),
            serial: "R5CW90ABC1".into(),
            connection: ConnectionType::Usb,
            status: DeviceStatus::Online,
            battery: Some(78),
            temperature_c: Some(34.2),
            cpu_percent: Some(23.0),
            memory_percent: Some(61.0),
            resolution: DeviceResolution {
                width: 1920,
                height: 1080,
            },
            fps: Some(60),
            bitrate_mbps: Some(12.4),
            latency_ms: Some(18),
            host: host_name.into(),
            host_id: Some(host_id.into()),
            wallpaper_hue: 210,
        },
        host_id,
        host_name,
    )
}

fn s23(host_id: &str, host_name: &str) -> Device {
    tag(
        Device {
            id: "s23".into(),
            name: "S23".into(),
            model: "SM-S911B".into(),
            android_version: "14".into(),
            serial: "R3CT50XYZ9".into(),
            connection: ConnectionType::Usb,
            status: DeviceStatus::Online,
            battery: Some(54),
            temperature_c: Some(36.8),
            cpu_percent: Some(41.0),
            memory_percent: Some(72.0),
            resolution: DeviceResolution {
                width: 2340,
                height: 1080,
            },
            fps: Some(60),
            bitrate_mbps: Some(10.1),
            latency_ms: Some(22),
            host: host_name.into(),
            host_id: Some(host_id.into()),
            wallpaper_hue: 165,
        },
        host_id,
        host_name,
    )
}

fn pixel(host_id: &str, host_name: &str) -> Device {
    tag(
        Device {
            id: "pixel".into(),
            name: "Pixel".into(),
            model: "Pixel 8".into(),
            android_version: "15".into(),
            serial: "35251FDH2001XY".into(),
            connection: ConnectionType::Network,
            status: DeviceStatus::Online,
            battery: Some(91),
            temperature_c: Some(31.5),
            cpu_percent: Some(12.0),
            memory_percent: Some(48.0),
            resolution: DeviceResolution {
                width: 2400,
                height: 1080,
            },
            fps: Some(60),
            bitrate_mbps: Some(8.7),
            latency_ms: Some(41),
            host: host_name.into(),
            host_id: Some(host_id.into()),
            wallpaper_hue: 28,
        },
        host_id,
        host_name,
    )
}

fn a52(host_id: &str, host_name: &str) -> Device {
    tag(
        Device {
            id: "a52".into(),
            name: "A52".into(),
            model: "SM-A525F".into(),
            android_version: "13".into(),
            serial: "R58M31DEAD".into(),
            connection: ConnectionType::Usb,
            status: DeviceStatus::Offline,
            battery: None,
            temperature_c: None,
            cpu_percent: None,
            memory_percent: None,
            resolution: DeviceResolution {
                width: 2400,
                height: 1080,
            },
            fps: None,
            bitrate_mbps: None,
            latency_ms: None,
            host: host_name.into(),
            host_id: Some(host_id.into()),
            wallpaper_hue: 300,
        },
        host_id,
        host_name,
    )
}

/// Build a mock fleet for the given profile, tagged to `host_id` / `host_name`.
pub fn mock_fleet(host_id: &str, host_name: &str, profile: MockProfile) -> Vec<Device> {
    match profile {
        MockProfile::All => {
            // Standalone controller: keep the seed split labels so the UI can
            // still show HOSTS grouping even without a second process.
            vec![
                s24(host_id, host_name),
                s23(host_id, host_name),
                pixel("lxc-agent-01", "lxc-agent-01"),
                a52("lxc-agent-01", "lxc-agent-01"),
            ]
        }
        MockProfile::Windows => vec![s24(host_id, host_name), s23(host_id, host_name)],
        MockProfile::Lxc => vec![pixel(host_id, host_name), a52(host_id, host_name)],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_profile_has_two_online() {
        let fleet = mock_fleet("windows-host", "windows-host", MockProfile::Windows);
        assert_eq!(fleet.len(), 2);
        assert!(fleet.iter().all(|d| d.effective_host_id() == "windows-host"));
        assert!(fleet.iter().all(|d| d.status == DeviceStatus::Online));
    }

    #[test]
    fn lxc_profile_includes_offline() {
        let fleet = mock_fleet("lxc-agent-01", "lxc-agent-01", MockProfile::Lxc);
        assert_eq!(fleet.len(), 2);
        assert_eq!(fleet.iter().filter(|d| d.status == DeviceStatus::Online).count(), 1);
    }
}
