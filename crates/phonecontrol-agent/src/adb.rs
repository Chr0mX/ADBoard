//! ADB discovery — poll `adb devices -l` when the binary exists.

use phonecontrol_protocol::{
    ConnectionType, Device, DeviceResolution, DeviceStatus,
};
use std::path::PathBuf;
use std::process::Stdio;
use tokio::process::Command;
use tracing::{debug, warn};

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct AdbDeviceLine {
    pub serial: String,
    pub status: DeviceStatus,
    pub model: Option<String>,
    pub product: Option<String>,
    pub transport_id: Option<String>,
    pub connection: ConnectionType,
}

pub fn adb_binary() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("ADB_PATH") {
        let p = PathBuf::from(path);
        if p.is_file() {
            return Some(p);
        }
    }
    if let Some(p) = crate::paths::vendored_adb() {
        return Some(p);
    }
    which("adb")
}

fn which(bin: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        for dir in std::env::split_paths(&paths) {
            let candidate = dir.join(bin);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        None
    })
}

pub async fn list_adb_devices(adb: &PathBuf) -> Result<Vec<AdbDeviceLine>, String> {
    let output = Command::new(adb)
        .arg("devices")
        .arg("-l")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("failed to spawn adb: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("adb exited {}: {stderr}", output.status));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(parse_adb_devices_l(&stdout))
}

/// Parse `adb devices -l` output.
pub fn parse_adb_devices_l(stdout: &str) -> Vec<AdbDeviceLine> {
    let mut devices = Vec::new();
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with("List of devices") {
            continue;
        }
        let mut parts = line.split_whitespace();
        let Some(serial) = parts.next() else {
            continue;
        };
        let Some(state) = parts.next() else {
            continue;
        };
        let status = match state {
            "device" => DeviceStatus::Online,
            "offline" => DeviceStatus::Offline,
            "unauthorized" => DeviceStatus::Unauthorized,
            other => {
                debug!(serial, state = other, "unknown adb state → offline");
                DeviceStatus::Offline
            }
        };

        let mut model = None;
        let mut product = None;
        let mut transport_id = None;
        for token in parts {
            if let Some(v) = token.strip_prefix("model:") {
                model = Some(v.replace('_', " "));
            } else if let Some(v) = token.strip_prefix("product:") {
                product = Some(v.to_string());
            } else if let Some(v) = token.strip_prefix("transport_id:") {
                transport_id = Some(v.to_string());
            }
        }

        let connection = if serial.contains(':') {
            ConnectionType::Network
        } else {
            ConnectionType::Usb
        };

        devices.push(AdbDeviceLine {
            serial: serial.to_string(),
            status,
            model,
            product,
            transport_id,
            connection,
        });
    }
    devices
}

#[derive(Debug, Clone, Copy)]
pub struct BatterySample {
    pub level: Option<u8>,
    pub temperature_c: Option<f32>,
}

/// `dumpsys battery` level (percent) and temperature (tenths of a degree).
pub fn parse_dumpsys_battery(text: &str) -> BatterySample {
    let mut level = None;
    let mut temperature_c = None;
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("level:") {
            level = rest.trim().parse().ok();
        } else if let Some(rest) = line.strip_prefix("temperature:") {
            if let Ok(tenths) = rest.trim().parse::<f32>() {
                temperature_c = Some(tenths / 10.0);
            }
        }
    }
    BatterySample {
        level,
        temperature_c,
    }
}

pub async fn query_battery(adb: &PathBuf, serial: &str) -> BatterySample {
    let output = Command::new(adb)
        .args(["-s", serial, "shell", "dumpsys", "battery"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .await;
    match output {
        Ok(out) if out.status.success() => {
            parse_dumpsys_battery(&String::from_utf8_lossy(&out.stdout))
        }
        _ => BatterySample {
            level: None,
            temperature_c: None,
        },
    }
}

/// Best-effort `wm size` for resolution; falls back to 1080×1920.
pub async fn query_resolution(adb: &PathBuf, serial: &str) -> DeviceResolution {
    let output = Command::new(adb)
        .args(["-s", serial, "shell", "wm", "size"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .await;

    match output {
        Ok(out) if out.status.success() => {
            let text = String::from_utf8_lossy(&out.stdout);
            if let Some(res) = parse_wm_size(&text) {
                return res;
            }
            warn!(serial, "could not parse wm size: {text}");
        }
        Ok(_) => warn!(serial, "wm size command failed"),
        Err(e) => warn!(serial, error = %e, "wm size spawn failed"),
    }

    DeviceResolution {
        width: 1080,
        height: 1920,
    }
}

fn parse_wm_size(text: &str) -> Option<DeviceResolution> {
    // Physical size: 1440x3200
    // Override size: 1080x1920
    // The override is the size Android is actually composing, so it wins.
    let mut physical = None;
    let mut override_size = None;
    for line in text.lines() {
        let Some(rest) = line.split(':').nth(1) else {
            continue;
        };
        let mut it = rest.trim().split('x');
        let Ok(width) = it.next().unwrap_or("").trim().parse::<u32>() else {
            continue;
        };
        let Ok(height) = it.next().unwrap_or("").trim().parse::<u32>() else {
            continue;
        };
        if width == 0 || height == 0 {
            continue;
        }
        let resolution = DeviceResolution { width, height };
        if line.to_ascii_lowercase().contains("override") {
            override_size = Some(resolution);
        } else if physical.is_none() {
            physical = Some(resolution);
        }
    }
    override_size.or(physical)
}

/// `wm size` arguments. `reset` / `native` clears the override. A size is
/// `WIDTHxHEIGHT` in the display's natural orientation, 240–4096 on each side.
pub fn display_size_command(spec: &str) -> Result<Vec<String>, String> {
    let spec = spec.trim();
    if spec == "reset" || spec == "native" {
        return Ok(vec!["wm".into(), "size".into(), "reset".into()]);
    }
    let Some((width, height)) = spec.split_once('x') else {
        return Err("size must look like 1080x1920, or reset".into());
    };
    if width.is_empty()
        || height.is_empty()
        || !width.chars().all(|c| c.is_ascii_digit())
        || !height.chars().all(|c| c.is_ascii_digit())
    {
        return Err("size must look like 1080x1920, or reset".into());
    }
    let width: u32 = width
        .parse()
        .map_err(|_| "size must look like 1080x1920, or reset")?;
    let height: u32 = height
        .parse()
        .map_err(|_| "size must look like 1080x1920, or reset")?;
    if !(240..=4096).contains(&width) || !(240..=4096).contains(&height) {
        return Err("size must be between 240 and 4096 on each side".into());
    }
    Ok(vec!["wm".into(), "size".into(), format!("{width}x{height}")])
}

pub fn adb_line_to_device(
    line: &AdbDeviceLine,
    host_id: &str,
    host_name: &str,
    resolution: DeviceResolution,
    battery: BatterySample,
) -> Device {
    let short = short_name(&line.serial, line.model.as_deref());
    let id = sanitize_id(&line.serial);
    let hue = wallpaper_hue(&line.serial);
    let online = line.status == DeviceStatus::Online;

    Device {
        id,
        name: short,
        model: line
            .model
            .clone()
            .or_else(|| line.product.clone())
            .unwrap_or_else(|| "Android".into()),
        android_version: "—".into(),
        serial: line.serial.clone(),
        connection: line.connection,
        status: line.status,
        battery: if online { battery.level } else { None },
        temperature_c: if online { battery.temperature_c } else { None },
        resolution,
        fps: if online { Some(60) } else { None },
        bitrate_mbps: if online { Some(8.0) } else { None },
        latency_ms: if online { Some(30) } else { None },
        host: host_name.into(),
        host_id: Some(host_id.into()),
        wallpaper_hue: hue,
    }
}

fn short_name(serial: &str, model: Option<&str>) -> String {
    if let Some(m) = model {
        if m.len() <= 16 {
            return m.to_string();
        }
        return m.chars().take(12).collect::<String>() + "…";
    }
    if serial.len() <= 8 {
        serial.to_string()
    } else {
        format!("{}…", &serial[..6])
    }
}

fn sanitize_id(serial: &str) -> String {
    serial
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

fn wallpaper_hue(serial: &str) -> u16 {
    let hash: u32 = serial.bytes().fold(0u32, |acc, b| acc.wrapping_mul(31).wrapping_add(b as u32));
    (hash % 360) as u16
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_adb_devices_l() {
        let sample = r#"List of devices attached
R5CW90ABC1             device usb:1-1 product:dm1qxxx model:SM_S921B device:dm1q transport_id:1
192.168.1.20:5555      device product:shiba model:Pixel_8 device:shiba transport_id:2
DEADBEEF               unauthorized usb:1-2 transport_id:3
OFFLINE1               offline usb:1-3 transport_id:4
"#;
        let parsed = parse_adb_devices_l(sample);
        assert_eq!(parsed.len(), 4);
        assert_eq!(parsed[0].serial, "R5CW90ABC1");
        assert_eq!(parsed[0].status, DeviceStatus::Online);
        assert_eq!(parsed[0].model.as_deref(), Some("SM S921B"));
        assert_eq!(parsed[1].connection, ConnectionType::Network);
        assert_eq!(parsed[2].status, DeviceStatus::Unauthorized);
        assert_eq!(parsed[3].status, DeviceStatus::Offline);
    }

    #[test]
    fn parses_wm_size() {
        let res = parse_wm_size("Physical size: 1080x2400\n").unwrap();
        assert_eq!(res.width, 1080);
        assert_eq!(res.height, 2400);
        let overridden = parse_wm_size(
            "Physical size: 1440x3200\nOverride size: 1080x1920\n",
        )
        .unwrap();
        assert_eq!(overridden.width, 1080);
        assert_eq!(overridden.height, 1920);
    }

    #[test]
    fn display_size_command_accepts_a_shared_size_or_reset() {
        assert_eq!(
            display_size_command("1080x1920").unwrap(),
            vec!["wm", "size", "1080x1920"]
        );
        assert_eq!(
            display_size_command("reset").unwrap(),
            vec!["wm", "size", "reset"]
        );
        assert!(display_size_command("1080x1920; reboot").is_err());
        assert!(display_size_command("10x10").is_err());
        assert!(display_size_command("").is_err());
    }

    #[test]
    fn parses_dumpsys_battery() {
        let sample = "Current Battery Service state:\n  level: 78\n  temperature: 342\n";
        let parsed = parse_dumpsys_battery(sample);
        assert_eq!(parsed.level, Some(78));
        assert_eq!(parsed.temperature_c, Some(34.2));
    }
}
