//! ADB discovery — poll `adb devices -l` when the binary exists.

use phonecontrol_protocol::{
    ConnectionType, Device, DeviceResolution, DeviceStatus,
};
use std::path::{Path, PathBuf};
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

#[derive(Debug, Clone, Copy, Default)]
pub struct BatterySample {
    pub level: Option<u8>,
    pub temperature_c: Option<f32>,
    /// Filled from the change in `cpu_times` between two polls.
    pub cpu_percent: Option<f32>,
    pub memory_percent: Option<f32>,
    /// Raw `/proc/stat` (total, idle) jiffies from this poll.
    pub cpu_times: Option<(u64, u64)>,
}

/// Marker between `dumpsys battery` and the /proc reads in one adb shell.
const VITALS_SPLIT: &str = "__ADBOARD_VITALS__";

/// `cpu  user nice system idle iowait irq softirq steal` → (total, idle+iowait).
pub fn parse_proc_stat_cpu(text: &str) -> Option<(u64, u64)> {
    let line = text.lines().find(|l| l.starts_with("cpu "))?;
    let nums: Vec<u64> = line.split_whitespace().skip(1).take(8).filter_map(|n| n.parse().ok()).collect();
    if nums.len() < 4 {
        return None;
    }
    let total: u64 = nums.iter().sum();
    let idle = nums[3] + nums.get(4).copied().unwrap_or(0);
    Some((total, idle))
}

/// Busy % between two `/proc/stat` samples.
pub fn cpu_percent_between(prev: (u64, u64), now: (u64, u64)) -> Option<f32> {
    let total = now.0.checked_sub(prev.0)?;
    let idle = now.1.checked_sub(prev.1)?;
    if total == 0 || idle > total {
        return None;
    }
    Some(((total - idle) as f32 / total as f32 * 1000.0).round() / 10.0)
}

/// RAM in use % from `MemTotal` / `MemAvailable` (kB).
pub fn parse_meminfo_percent(text: &str) -> Option<f32> {
    let value = |key: &str| -> Option<f64> {
        text.lines()
            .find(|l| l.starts_with(key))
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|n| n.parse().ok())
    };
    let total = value("MemTotal:")?;
    let available = value("MemAvailable:")?;
    if total <= 0.0 || available > total {
        return None;
    }
    Some((((total - available) / total) * 1000.0).round() as f32 / 10.0)
}

/// Battery plus CPU counters and memory from one combined adb shell output.
pub fn parse_vitals(text: &str) -> BatterySample {
    let (battery, rest) = text.split_once(VITALS_SPLIT).unwrap_or((text, ""));
    let mut sample = parse_dumpsys_battery(battery);
    sample.cpu_times = parse_proc_stat_cpu(rest);
    sample.memory_percent = parse_meminfo_percent(rest);
    sample
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
        ..Default::default()
    }
}

/// Battery, CPU counters and memory in a single adb round trip.
pub async fn query_battery(adb: &PathBuf, serial: &str) -> BatterySample {
    let script = format!(
        "dumpsys battery; echo {VITALS_SPLIT}; head -n 1 /proc/stat; grep -E '^(MemTotal|MemAvailable):' /proc/meminfo"
    );
    let output = Command::new(adb)
        .args(["-s", serial, "shell", script.as_str()])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .await;
    match output {
        Ok(out) if out.status.success() => parse_vitals(&String::from_utf8_lossy(&out.stdout)),
        _ => BatterySample::default(),
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
        cpu_percent: if online { battery.cpu_percent } else { None },
        memory_percent: if online { battery.memory_percent } else { None },
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WirelessEndpoint {
    pub host: String,
    pub port: u16,
}

impl WirelessEndpoint {
    pub fn display(&self) -> String {
        if self.host.contains(':') {
            format!("[{}]:{}", self.host, self.port)
        } else {
            format!("{}:{}", self.host, self.port)
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WirelessPairing {
    pub port: u16,
    pub code: String,
}

/// `address` is `host`, `host:port`, or `[ipv6]:port`. An explicit `port` is
/// used only when the address does not already include one. The default is 5555.
pub fn parse_wireless_endpoint(address: &str, port: Option<u16>) -> Result<WirelessEndpoint, String> {
    let address = address.trim();
    if address.is_empty() {
        return Err("enter the phone's IP address".into());
    }
    if address
        .chars()
        .any(|c| c.is_whitespace() || matches!(c, ';' | '&' | '|' | '`' | '$' | '\'' | '"' | '\\' | '<' | '>'))
    {
        return Err("address has invalid characters".into());
    }
    let (host, embedded) = split_host_port(address)?;
    validate_host(&host)?;
    let port = embedded.or(port).unwrap_or(5555);
    if port == 0 {
        return Err("port must be between 1 and 65535".into());
    }
    Ok(WirelessEndpoint { host, port })
}

/// Pairing is optional. A code requires the pairing port shown next to it.
pub fn parse_pairing(port: Option<u16>, code: Option<&str>) -> Result<Option<WirelessPairing>, String> {
    let code: String = code
        .unwrap_or("")
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    if code.is_empty() {
        if port.is_some() {
            return Err("enter the pairing code shown on the phone".into());
        }
        return Ok(None);
    }
    if !code.chars().all(|c| c.is_ascii_digit()) || !(4..=8).contains(&code.len()) {
        return Err("pairing code must be the digits shown on the phone".into());
    }
    let Some(port) = port.filter(|port| *port != 0) else {
        return Err("enter the pairing port shown on the phone".into());
    };
    Ok(Some(WirelessPairing { port, code }))
}

pub async fn connect_wireless(
    adb: &Path,
    endpoint: &WirelessEndpoint,
    pairing: Option<&WirelessPairing>,
) -> Result<String, String> {
    let mut notes = Vec::new();
    if let Some(pair) = pairing {
        let target = format!("{}:{}", endpoint.host_for_adb(), pair.port);
        let output = adb_output(adb, &["pair", &target, &pair.code]).await?;
        if wireless_failed(&output) {
            return Err(if output.is_empty() {
                "pairing failed".into()
            } else {
                output
            });
        }
        notes.push(if output.is_empty() {
            format!("paired {target}")
        } else {
            output
        });
    }
    let target = endpoint.display();
    let output = adb_output(adb, &["connect", &target]).await?;
    if wireless_failed(&output) {
        return Err(if output.is_empty() {
            format!("could not connect to {target}")
        } else {
            output
        });
    }
    notes.push(if output.is_empty() {
        format!("connected to {target}")
    } else {
        output
    });
    Ok(notes.join("\n"))
}

pub async fn disconnect_wireless(adb: &Path, endpoint: &WirelessEndpoint) -> Result<String, String> {
    let target = endpoint.display();
    let output = adb_output(adb, &["disconnect", &target]).await?;
    if wireless_failed(&output) {
        return Err(if output.is_empty() {
            format!("could not disconnect {target}")
        } else {
            output
        });
    }
    Ok(if output.is_empty() {
        format!("disconnected {target}")
    } else {
        output
    })
}

impl WirelessEndpoint {
    fn host_for_adb(&self) -> String {
        if self.host.contains(':') {
            format!("[{}]", self.host)
        } else {
            self.host.clone()
        }
    }
}

fn split_host_port(address: &str) -> Result<(String, Option<u16>), String> {
    if let Some(rest) = address.strip_prefix('[') {
        let Some((host, tail)) = rest.split_once(']') else {
            return Err("wrap an IPv6 address in brackets, like [fe80::1]:5555".into());
        };
        if host.is_empty() {
            return Err("address is not valid".into());
        }
        if tail.is_empty() {
            return Ok((host.to_string(), None));
        }
        let Some(port) = tail.strip_prefix(':') else {
            return Err("address is not valid".into());
        };
        return Ok((host.to_string(), Some(parse_port(port)?)));
    }
    if address.matches(':').count() > 1 {
        return Err("wrap an IPv6 address in brackets, like [fe80::1]:5555".into());
    }
    if let Some((host, port)) = address.rsplit_once(':') {
        if host.is_empty() {
            return Err("address is not valid".into());
        }
        return Ok((host.to_string(), Some(parse_port(port)?)));
    }
    Ok((address.to_string(), None))
}

fn parse_port(text: &str) -> Result<u16, String> {
    let port: u16 = text
        .parse()
        .map_err(|_| "port must be a number".to_string())?;
    if port == 0 {
        return Err("port must be between 1 and 65535".into());
    }
    Ok(port)
}

fn validate_host(host: &str) -> Result<(), String> {
    if host.is_empty() || host.len() > 253 {
        return Err("address is not valid".into());
    }
    if host.contains(':') {
        let (addr, zone) = host.split_once('%').unwrap_or((host, ""));
        let ok = !addr.is_empty()
            && addr.chars().all(|c| c.is_ascii_hexdigit() || c == ':')
            && (zone.is_empty()
                || zone
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.'));
        return if ok {
            Ok(())
        } else {
            Err("address is not valid".into())
        };
    }
    if host.split('.').count() == 4 && host.chars().all(|c| c.is_ascii_digit() || c == '.') {
        let octets: Vec<_> = host.split('.').collect();
        let valid = octets.iter().all(|octet| {
            !octet.is_empty() && octet.len() <= 3 && octet.parse::<u8>().is_ok()
        });
        return if valid {
            Ok(())
        } else {
            Err("address is not valid".into())
        };
    }
    let valid = host.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-')
    });
    if valid {
        Ok(())
    } else {
        Err("address is not valid".into())
    }
}

fn wireless_failed(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("failed")
        || lower.contains("cannot")
        || lower.contains("unable")
        || lower.contains("error")
}

async fn adb_output(adb: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new(adb)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("failed to spawn adb: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if output.status.success() {
        Ok(if stdout.is_empty() { stderr } else { stdout })
    } else {
        let detail = [stderr, stdout]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" | ");
        Err(if detail.is_empty() {
            format!("adb exited {}", output.status)
        } else {
            detail
        })
    }
}

fn wireless_store_path() -> PathBuf {
    if let Ok(path) = std::env::var("PHONECONTROL_WIRELESS") {
        return PathBuf::from(path);
    }
    std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("data")
        .join("wireless-adb.json")
}

fn store_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock().unwrap_or_else(|error| error.into_inner())
}

pub fn load_wireless() -> Vec<WirelessEndpoint> {
    let _guard = store_lock();
    let Ok(text) = std::fs::read_to_string(wireless_store_path()) else {
        return Vec::new();
    };
    #[derive(serde::Deserialize)]
    struct Saved {
        host: String,
        port: u16,
    }
    serde_json::from_str::<Vec<Saved>>(&text)
        .unwrap_or_default()
        .into_iter()
        .filter(|item| item.port != 0 && !item.host.is_empty())
        .map(|item| WirelessEndpoint {
            host: item.host,
            port: item.port,
        })
        .collect()
}

fn save_wireless(list: &[WirelessEndpoint]) -> Result<(), String> {
    let path = wireless_store_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("could not save wireless devices: {error}"))?;
    }
    #[derive(serde::Serialize)]
    struct Saved<'a> {
        host: &'a str,
        port: u16,
    }
    let saved: Vec<Saved> = list
        .iter()
        .map(|item| Saved {
            host: &item.host,
            port: item.port,
        })
        .collect();
    let text = serde_json::to_string_pretty(&saved).map_err(|error| error.to_string())?;
    std::fs::write(path, text).map_err(|error| format!("could not save wireless devices: {error}"))
}

pub fn remember_wireless(endpoint: &WirelessEndpoint) -> Result<(), String> {
    let _guard = store_lock();
    // load_wireless also locks. Read the file directly while holding the lock.
    let path = wireless_store_path();
    let mut list = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<Vec<serde_json::Value>>(&text).ok())
        .map(|values| {
            values
                .into_iter()
                .filter_map(|value| {
                    let host = value.get("host")?.as_str()?.to_string();
                    let port = value.get("port")?.as_u64()? as u16;
                    if host.is_empty() || port == 0 {
                        None
                    } else {
                        Some(WirelessEndpoint { host, port })
                    }
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if !list
        .iter()
        .any(|item| item.host == endpoint.host && item.port == endpoint.port)
    {
        list.push(endpoint.clone());
    }
    save_wireless(&list)
}

pub fn forget_wireless(endpoint: &WirelessEndpoint) -> Result<(), String> {
    let _guard = store_lock();
    let path = wireless_store_path();
    let list = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<Vec<serde_json::Value>>(&text).ok())
        .map(|values| {
            values
                .into_iter()
                .filter_map(|value| {
                    let host = value.get("host")?.as_str()?.to_string();
                    let port = value.get("port")?.as_u64()? as u16;
                    Some(WirelessEndpoint { host, port })
                })
                .filter(|item| item.host != endpoint.host || item.port != endpoint.port)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    save_wireless(&list)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MdnsKind {
    Pairing,
    Connect,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MdnsService {
    pub name: String,
    pub kind: MdnsKind,
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Clone)]
pub struct QrMaterial {
    pub name: String,
    pub password: String,
    pub payload: String,
}

#[derive(Debug, Clone, Default)]
pub struct QrPairProgress {
    pub paired_host: Option<String>,
}

/// `WIFI:T:ADB;S:<name>;P:<10 digits>;;` — the phone's camera starts a pairing server named `<name>`.
pub fn generate_qr_material() -> QrMaterial {
    let name = format!("studio-{}", random_chars(b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 10));
    let password = random_chars(b"0123456789", 10);
    let payload = format!("WIFI:T:ADB;S:{name};P:{password};;");
    QrMaterial {
        name,
        password,
        payload,
    }
}

pub fn qr_svg(payload: &str) -> Result<String, String> {
    let code = qrcode::QrCode::new(payload.as_bytes()).map_err(|error| error.to_string())?;
    Ok(code
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(220, 220)
        .dark_color(qrcode::render::svg::Color("#000000"))
        .light_color(qrcode::render::svg::Color("#ffffff"))
        .quiet_zone(true)
        .build())
}

pub fn parse_mdns_services(stdout: &str) -> Vec<MdnsService> {
    let mut services = Vec::new();
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with("List of") {
            continue;
        }
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 3 {
            continue;
        }
        let addr = parts[parts.len() - 1];
        let kind_text = parts[parts.len() - 2];
        let Some((host, port_text)) = addr.rsplit_once(':') else {
            continue;
        };
        let Ok(port) = port_text.parse::<u16>() else {
            continue;
        };
        if host.is_empty() || port == 0 {
            continue;
        }
        let kind = if kind_text.contains("_adb-tls-pairing") {
            MdnsKind::Pairing
        } else if kind_text.contains("_adb-tls-connect") {
            MdnsKind::Connect
        } else {
            MdnsKind::Other
        };
        services.push(MdnsService {
            name: parts[..parts.len() - 2].join(" "),
            kind,
            host: host.to_string(),
            port,
        });
    }
    services
}

/// One poll of `adb mdns services`. `Ok(None)` means the phone has not finished yet.
pub async fn qr_pair_once(
    adb: &Path,
    name: &str,
    password: &str,
    progress: &mut QrPairProgress,
) -> Result<Option<WirelessEndpoint>, String> {
    let listed = adb_output_timeout(adb, &["mdns", "services"], 8).await?;
    let services = parse_mdns_services(&listed);
    if progress.paired_host.is_none() {
        if let Some(service) = services
            .iter()
            .find(|service| service.kind == MdnsKind::Pairing && service.name == name)
        {
            let target = format!("{}:{}", service.host, service.port);
            let output = adb_output_timeout(adb, &["pair", &target, password], 20).await?;
            if wireless_failed(&output) {
                return Err(if output.is_empty() {
                    "pairing failed".into()
                } else {
                    output
                });
            }
            progress.paired_host = Some(service.host.clone());
        }
    }
    let Some(host) = progress.paired_host.clone() else {
        return Ok(None);
    };
    if let Some(service) = services
        .iter()
        .find(|service| service.kind == MdnsKind::Connect && service.host == host)
    {
        let endpoint = WirelessEndpoint {
            host: host.clone(),
            port: service.port,
        };
        let output = adb_output_timeout(adb, &["connect", &endpoint.display()], 15).await?;
        if wireless_failed(&output) {
            return Err(if output.is_empty() {
                format!("could not connect to {}", endpoint.display())
            } else {
                output
            });
        }
        return Ok(Some(endpoint));
    }
    let devices = adb_output_timeout(adb, &["devices", "-l"], 8).await.unwrap_or_default();
    if let Some(endpoint) = network_endpoint_for_host(&devices, &host) {
        return Ok(Some(endpoint));
    }
    Ok(None)
}

fn network_endpoint_for_host(stdout: &str, host: &str) -> Option<WirelessEndpoint> {
    let prefix = format!("{host}:");
    for line in parse_adb_devices_l(stdout) {
        let Some(port_text) = line.serial.strip_prefix(&prefix) else {
            continue;
        };
        let port = port_text.parse::<u16>().ok()?;
        if port == 0 {
            continue;
        }
        return Some(WirelessEndpoint {
            host: host.to_string(),
            port,
        });
    }
    None
}

fn random_chars(alphabet: &[u8], len: usize) -> String {
    let mut out = String::with_capacity(len);
    while out.len() < len {
        for byte in uuid::Uuid::new_v4().into_bytes() {
            out.push(alphabet[(byte as usize) % alphabet.len()] as char);
            if out.len() == len {
                break;
            }
        }
    }
    out
}

async fn adb_output_timeout(adb: &Path, args: &[&str], secs: u64) -> Result<String, String> {
    match tokio::time::timeout(
        std::time::Duration::from_secs(secs),
        adb_output(adb, args),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => Err("timed out talking to adb".into()),
    }
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
            display_size_command("900x1600").unwrap(),
            vec!["wm", "size", "900x1600"]
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
        assert_eq!(parsed.cpu_percent, None);
    }

    #[test]
    fn wireless_address_accepts_ip_host_and_ipv6() {
        let plain = parse_wireless_endpoint("192.168.1.20", None).unwrap();
        assert_eq!(plain.display(), "192.168.1.20:5555");
        let embedded = parse_wireless_endpoint("192.168.1.20:37123", Some(5555)).unwrap();
        assert_eq!(embedded.port, 37123);
        assert_eq!(
            parse_wireless_endpoint("phone.local", Some(5555))
                .unwrap()
                .display(),
            "phone.local:5555"
        );
        assert_eq!(
            parse_wireless_endpoint("[fe80::1]:5555", None)
                .unwrap()
                .display(),
            "[fe80::1]:5555"
        );
        assert!(parse_wireless_endpoint("", None).is_err());
        assert!(parse_wireless_endpoint("192.168.1.20;reboot", None).is_err());
        assert!(parse_wireless_endpoint("256.1.1.1", None).is_err());
        assert!(parse_wireless_endpoint("fe80::1", None).is_err());
        assert!(parse_pairing(None, None).unwrap().is_none());
        assert!(parse_pairing(Some(37123), Some("12 34 56")).unwrap().unwrap().code == "123456");
        assert!(parse_pairing(None, Some("123456")).is_err());
        assert!(parse_pairing(Some(37123), Some("abc")).is_err());
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn wireless_connect_pairs_then_connects() {
        let dir = std::env::temp_dir().join(format!("pc-adb-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("args.txt");
        let script = dir.join("adb");
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$*\" >> {}\ncase \"$1\" in\n  pair) echo \"Successfully paired to $2\" ;;\n  connect) echo \"connected to $2\" ;;\n  *) echo unexpected >&2; exit 1 ;;\nesac\n",
                super::shell_quote(&log)
            ),
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let endpoint = parse_wireless_endpoint("192.168.1.20:5555", None).unwrap();
        let pairing = parse_pairing(Some(37123), Some("123456")).unwrap().unwrap();
        let message = connect_wireless(&script, &endpoint, Some(&pairing))
            .await
            .unwrap();
        assert!(message.contains("Successfully paired"));
        assert!(message.contains("connected to 192.168.1.20:5555"));
        let args = std::fs::read_to_string(&log).unwrap();
        assert!(args.contains("pair 192.168.1.20:37123 123456\n"), "{args}");
        assert!(args.contains("connect 192.168.1.20:5555\n"), "{args}");

        std::fs::write(
            &script,
            "#!/bin/sh\necho 'failed to connect to 192.168.1.20:5555'\nexit 0\n",
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let err = connect_wireless(&script, &endpoint, None).await.unwrap_err();
        assert!(err.contains("failed to connect"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn wireless_list_remembers_and_forgets() {
        let path = std::env::temp_dir().join(format!("pc-wireless-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let previous = std::env::var("PHONECONTROL_WIRELESS").ok();
        std::env::set_var("PHONECONTROL_WIRELESS", &path);
        let endpoint = parse_wireless_endpoint("10.0.0.8", None).unwrap();
        remember_wireless(&endpoint).unwrap();
        remember_wireless(&endpoint).unwrap();
        assert_eq!(load_wireless(), vec![endpoint.clone()]);
        forget_wireless(&endpoint).unwrap();
        assert!(load_wireless().is_empty());
        match previous {
            Some(value) => std::env::set_var("PHONECONTROL_WIRELESS", value),
            None => std::env::remove_var("PHONECONTROL_WIRELESS"),
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn qr_payload_is_an_adb_wifi_code() {
        let material = generate_qr_material();
        assert!(material.name.starts_with("studio-"));
        assert_eq!(material.name.len(), "studio-".len() + 10);
        assert_eq!(material.password.len(), 10);
        assert!(material.password.chars().all(|c| c.is_ascii_digit()));
        assert_eq!(
            material.payload,
            format!("WIFI:T:ADB;S:{};P:{};;", material.name, material.password)
        );
        let svg = qr_svg(&material.payload).unwrap();
        assert!(svg.contains("<svg"));
        assert!(svg.contains("#000000"));
    }

    #[test]
    fn parses_adb_mdns_services() {
        let sample = "List of discovered mdns services\n\
studio-ABCDEFGHJK   _adb-tls-pairing._tcp   192.168.1.20:41000\n\
adb-guid            _adb-tls-connect._tcp    192.168.1.20:41001\n\
legacy              _adb._tcp                192.168.1.20:5555\n";
        let parsed = parse_mdns_services(sample);
        assert_eq!(parsed.len(), 3);
        assert_eq!(parsed[0].kind, MdnsKind::Pairing);
        assert_eq!(parsed[0].name, "studio-ABCDEFGHJK");
        assert_eq!(parsed[0].port, 41000);
        assert_eq!(parsed[1].kind, MdnsKind::Connect);
        assert_eq!(parsed[2].kind, MdnsKind::Other);
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn qr_pair_once_pairs_then_connects() {
        let dir = std::env::temp_dir().join(format!("pc-qr-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("args.txt");
        let script = dir.join("adb");
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$*\" >> {}\ncase \"$1\" in\n  mdns)\n    echo 'List of discovered mdns services'\n    echo 'studio-TESTNAME _adb-tls-pairing._tcp 10.1.2.3:41000'\n    echo 'adb-guid _adb-tls-connect._tcp 10.1.2.3:41001'\n    ;;\n  pair) echo \"Successfully paired to $2\" ;;\n  connect) echo \"connected to $2\" ;;\n  *) echo unexpected >&2; exit 1 ;;\nesac\n",
                super::shell_quote(&log)
            ),
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut progress = QrPairProgress::default();
        let endpoint = qr_pair_once(&script, "studio-TESTNAME", "1234567890", &mut progress)
            .await
            .unwrap()
            .expect("pairing and connect services were both listed");
        assert_eq!(endpoint.display(), "10.1.2.3:41001");
        let args = std::fs::read_to_string(&log).unwrap();
        assert!(args.contains("mdns services\n"), "{args}");
        assert!(args.contains("pair 10.1.2.3:41000 1234567890\n"), "{args}");
        assert!(args.contains("connect 10.1.2.3:41001\n"), "{args}");
        let _ = std::fs::remove_dir_all(&dir);
    }


    #[test]
    fn vitals_parse_battery_cpu_and_memory() {
        let text = "Current Battery Service state:\n  level: 81\n  temperature: 312\n__ADBOARD_VITALS__\ncpu  100 0 50 800 50 0 0 0 0 0\nMemTotal:        7800000 kB\nMemAvailable:    1950000 kB\n";
        let s = parse_vitals(text);
        assert_eq!(s.level, Some(81));
        assert_eq!(s.temperature_c, Some(31.2));
        assert_eq!(s.cpu_times, Some((1000, 850)));
        assert_eq!(s.memory_percent, Some(75.0));
        // 400 more jiffies, 100 of them idle → 75 % busy.
        assert_eq!(cpu_percent_between((1000, 850), (1400, 950)), Some(75.0));
        assert_eq!(cpu_percent_between((1000, 850), (1000, 850)), None);
        assert_eq!(cpu_percent_between((1000, 850), (900, 800)), None, "counter reset");
    }

    #[test]
    fn vitals_tolerate_missing_proc_reads() {
        let s = parse_vitals("  level: 50\n");
        assert_eq!(s.level, Some(50));
        assert_eq!(s.cpu_times, None);
        assert_eq!(s.memory_percent, None);
        assert_eq!(parse_meminfo_percent("MemTotal: 0 kB\nMemAvailable: 0 kB"), None);
    }
}

#[cfg(test)]
fn shell_quote(path: &std::path::Path) -> String {
    format!("'{}'", path.display().to_string().replace('\'', "'\\''"))
}
