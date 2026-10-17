//! Device operations that share one command API: ADB shell, files, and captures.
//! The browser never talks to ADB. The agent runs these on the device host.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::process::Command;

pub fn valid_package(package: &str) -> bool {
    !package.is_empty()
        && package.len() < 200
        && package
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_')
        && package.contains('.')
}

pub fn device_path(path: &str) -> Result<&str, String> {
    if !path.starts_with('/')
        || path.contains('\n')
        || path.contains('\0')
        || path.split('/').any(|part| part == "..")
    {
        return Err("path must be an absolute device path".into());
    }
    Ok(path)
}

fn sh_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub fn shell_line(command: &str) -> Result<&str, String> {
    let command = command.trim();
    if command.is_empty() || command.len() > 2000 || command.contains('\n') || command.contains('\0')
    {
        return Err("shell command must be a single line".into());
    }
    Ok(command)
}

pub fn safe_input_text(text: &str) -> bool {
    !text.is_empty()
        && !text.contains('\n')
        && !text.contains('\0')
        && !text.chars().any(|c| {
            matches!(
                c,
                ';' | '|' | '&' | '`' | '$' | '(' | ')' | '<' | '>' | '\'' | '"' | '\\' | '\r'
            )
        })
}

pub fn files_root() -> PathBuf {
    let base = std::env::var("PHONECONTROL_FILES")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            std::env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join("data")
                .join("phonecontrol-files")
        });
    for name in ["Screenshots", "APKs", "Recordings", "Downloads"] {
        let _ = std::fs::create_dir_all(base.join(name));
    }
    base
}

pub fn host_path(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if rel.contains('\0') || rel.split(['/', '\\']).any(|part| part == "..") {
        return Err("invalid path".into());
    }
    let rel = rel.trim_start_matches(['/', '\\']);
    let joined = root.join(rel);
    let canonical_root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    // Walk up until an existing ancestor can be canonicalized (uploads create the leaf).
    let mut probe = joined.clone();
    let mut suffix = Vec::new();
    while !probe.exists() {
        match probe.file_name() {
            Some(name) => {
                suffix.push(name.to_os_string());
                probe = probe
                    .parent()
                    .map(Path::to_path_buf)
                    .ok_or_else(|| "invalid path".to_string())?;
            }
            None => return Err("invalid path".into()),
        }
    }
    let mut canonical = std::fs::canonicalize(&probe).map_err(|e| e.to_string())?;
    if !canonical.starts_with(&canonical_root) {
        return Err("path escapes the file root".into());
    }
    let creating = !suffix.is_empty();
    for part in suffix.into_iter().rev() {
        canonical.push(part);
    }
    if !canonical.starts_with(&canonical_root) {
        return Err("path escapes the file root".into());
    }
    // Keep the logical joined path for create operations after the existing
    // ancestor proved it stays under the root.
    Ok(if creating { joined } else { canonical })
}

pub async fn adb_text(adb: &Path, args: &[String]) -> Result<String, String> {
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
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" | ");
        Err(if detail.is_empty() {
            format!("adb exited {}", output.status)
        } else {
            detail
        })
    }
}

pub async fn adb_bytes(adb: &Path, args: &[String]) -> Result<Vec<u8>, String> {
    let output = Command::new(adb)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("failed to spawn adb: {e}"))?;
    if output.status.success() {
        Ok(output.stdout)
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn adb_args(serial: &str, rest: &[&str]) -> Vec<String> {
    let mut args = vec!["-s".into(), serial.into()];
    args.extend(rest.iter().map(|s| (*s).to_string()));
    args
}

/// `mute` argument: `on` mutes, `off` restores, `status` (or none) only reads.
pub fn mute_arg(arg: Option<&str>) -> Result<Option<bool>, String> {
    match arg.map(str::trim).unwrap_or("status") {
        "on" => Ok(Some(true)),
        "off" => Ok(Some(false)),
        "status" | "" => Ok(None),
        _ => Err("mute takes on, off or status".into()),
    }
}

/// `cmd media_session volume --get` → (volume, max), from a line like
/// `[V] volume is 7 in range [0..15]`.
pub fn parse_media_volume(raw: &str) -> Option<(u32, u32)> {
    let at = raw.find("volume is ")?;
    let rest = &raw[at + "volume is ".len()..];
    let volume: u32 = rest.split_whitespace().next()?.parse().ok()?;
    let range = rest.split('[').nth(1)?.split(']').next()?;
    let max: u32 = range.split("..").nth(1)?.trim().parse().ok()?;
    Some((volume, max))
}

/// Media volume before Quiet mode muted each phone, to put back afterwards.
fn saved_volumes() -> &'static std::sync::Mutex<std::collections::HashMap<String, u32>> {
    static SAVED: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, u32>>> =
        std::sync::OnceLock::new();
    SAVED.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Mute / restore the phone's media sound (music stream 3), which is what
/// games and videos play on. Answers `on` when muted.
async fn mute_media(adb: &Path, serial: &str, arg: Option<&str>) -> Result<String, String> {
    let want = mute_arg(arg)?;
    let read = || async {
        let raw = adb_text(
            adb,
            &adb_args(serial, &["shell", "cmd", "media_session", "volume", "--stream", "3", "--get"]),
        )
        .await?;
        parse_media_volume(&raw).ok_or_else(|| "phone did not report its media volume".to_string())
    };
    let set = |level: u32| async move {
        let level = level.to_string();
        adb_text(
            adb,
            &adb_args(serial, &["shell", "cmd", "media_session", "volume", "--stream", "3", "--set", &level]),
        )
        .await
        .map(|_| ())
    };
    let (volume, max) = read().await?;
    match want {
        Some(true) => {
            if volume > 0 {
                saved_volumes()
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(serial.to_string(), volume);
            }
            set(0).await?;
        }
        Some(false) => {
            let saved = saved_volumes().lock().unwrap_or_else(|e| e.into_inner()).remove(serial);
            // Unknown (e.g. the agent restarted while muted): half volume.
            let level = saved.unwrap_or((max / 2).max(1)).min(max.max(1));
            if volume == 0 {
                set(level).await?;
            }
        }
        None => {}
    }
    let (now, _) = read().await?;
    Ok(if now == 0 { "on".into() } else { "off".into() })
}

/// `stayAwake` argument: `on` / `off` set it, `status` (or none) only reads.
pub fn stay_awake_arg(arg: Option<&str>) -> Result<Option<bool>, String> {
    match arg.map(str::trim).unwrap_or("status") {
        "on" => Ok(Some(true)),
        "off" => Ok(Some(false)),
        "status" | "" => Ok(None),
        _ => Err("stayAwake takes on, off or status".into()),
    }
}

/// `stay_on_while_plugged_in` is a bit mask (AC/USB/wireless); any bit means on.
pub fn stay_awake_is_on(raw: &str) -> bool {
    raw.trim().parse::<u32>().map(|n| n != 0).unwrap_or(false)
}

/// Run one non-gesture operation. `reconnect` is handled by the session manager.
pub async fn run_adb_op(
    adb: &Path,
    serial: &str,
    op: &str,
    arg: Option<&str>,
    arg2: Option<&str>,
    files_root: &Path,
) -> Result<String, String> {
    match op {
        "restartAdb" => {
            adb_text(adb, &adb_args(serial, &["reconnect"])).await?;
            Ok("adb reconnect sent".into())
        }
        "reboot" => {
            adb_text(adb, &adb_args(serial, &["reboot"])).await?;
            Ok("rebooting".into())
        }
        "shutdown" => {
            adb_text(adb, &adb_args(serial, &["shell", "reboot", "-p"])).await?;
            Ok("shutting down".into())
        }
        "mute" => mute_media(adb, serial, arg).await,
        "stayAwake" => {
            // `svc power stayon` keeps the phone awake; it does not touch the
            // screen-off (display power) state used by "Screen off".
            if let Some(on) = stay_awake_arg(arg)? {
                let value = if on { "true" } else { "false" };
                adb_text(adb, &adb_args(serial, &["shell", "svc", "power", "stayon", value])).await?;
            }
            let raw = adb_text(
                adb,
                &adb_args(serial, &["shell", "settings", "get", "global", "stay_on_while_plugged_in"]),
            )
            .await?;
            Ok(if stay_awake_is_on(&raw) { "on".into() } else { "off".into() })
        }
        "screenshot" => capture_screenshot(adb, serial, arg, files_root).await,
        "recordStart" => start_record(adb, serial, arg, arg2).await,
        "copy" => {
            let from = device_path(arg.unwrap_or(""))?;
            let to = device_path(arg2.unwrap_or(""))?;
            let command = format!("cp -r {} {}", sh_quote(from), sh_quote(to));
            adb_text(adb, &adb_args(serial, &["shell", &command])).await?;
            Ok(format!("copied to {to}"))
        }
        "recordStop" => {
            adb_text(adb, &adb_args(serial, &["shell", "pkill -2 screenrecord"])).await?;
            Ok("recording stopped".into())
        }
        "shell" => {
            let command = shell_line(arg.unwrap_or(""))?;
            adb_text(adb, &adb_args(serial, &["shell", command])).await
        }
        "uninstall" => {
            let package = arg.unwrap_or("");
            if !valid_package(package) {
                return Err("package name is not valid".into());
            }
            adb_text(
                adb,
                &adb_args(serial, &["shell", &format!("pm uninstall --user 0 {package}")]),
            )
            .await
        }
        "launch" => launch_app(adb, serial, arg, arg2).await,
        "forceStop" => {
            let package = arg.unwrap_or("");
            if !valid_package(package) {
                return Err("package name is not valid".into());
            }
            adb_text(
                adb,
                &adb_args(serial, &["shell", &format!("am force-stop {package}")]),
            )
            .await?;
            Ok(format!("stopped {package}"))
        }
        "clearData" => {
            let package = arg.unwrap_or("");
            if !valid_package(package) {
                return Err("package name is not valid".into());
            }
            adb_text(
                adb,
                &adb_args(serial, &["shell", &format!("pm clear {package}")]),
            )
            .await
        }
        "packages" => adb_text(adb, &adb_args(serial, &["shell", "pm list packages"])).await,
        "files" => {
            let path = device_path(arg.unwrap_or("/sdcard"))?;
            let command = format!("ls -1p {}", sh_quote(path));
            adb_text(adb, &adb_args(serial, &["shell", &command])).await
        }
        "mkdir" => {
            let path = device_path(arg.unwrap_or(""))?;
            let command = format!("mkdir -p {}", sh_quote(path));
            adb_text(adb, &adb_args(serial, &["shell", &command])).await?;
            Ok(path.into())
        }
        "delete" => {
            let path = device_path(arg.unwrap_or(""))?;
            if path == "/" || path == "/sdcard" || path == "/storage" {
                return Err("refusing to delete a storage root".into());
            }
            let command = format!("rm -rf {}", sh_quote(path));
            adb_text(adb, &adb_args(serial, &["shell", &command])).await?;
            Ok(format!("deleted {path}"))
        }
        "rename" => {
            let from = device_path(arg.unwrap_or(""))?;
            let to = device_path(arg2.unwrap_or(""))?;
            let command = format!("mv {} {}", sh_quote(from), sh_quote(to));
            adb_text(adb, &adb_args(serial, &["shell", &command])).await?;
            Ok(format!("renamed to {to}"))
        }
        "text" => {
            let text = arg.unwrap_or("").replace(' ', "%s");
            if !safe_input_text(&text) {
                return Err("text has characters that input text cannot type safely".into());
            }
            adb_text(
                adb,
                &adb_args(serial, &["shell", &format!("input text {text}")]),
            )
            .await?;
            Ok("typed".into())
        }
        "info" => device_info(adb, serial).await,
        "displaySize" => set_display_size(adb, serial, arg.unwrap_or("")).await,
        "push" => Err("use the file upload".into()),
        other => Err(format!("unknown device operation: {other}")),
    }
}

pub async fn set_display_size(adb: &Path, serial: &str, spec: &str) -> Result<String, String> {
    let wm = crate::adb::display_size_command(spec)?;
    let mut rest = vec!["shell".to_string()];
    rest.extend(wm);
    let refs: Vec<&str> = rest.iter().map(String::as_str).collect();
    adb_text(adb, &adb_args(serial, &refs)).await?;
    if spec.trim() == "reset" || spec.trim() == "native" {
        Ok("display size reset to the panel".into())
    } else {
        Ok(format!("display size {}", spec.trim()))
    }
}

async fn capture_screenshot(
    adb: &Path,
    serial: &str,
    arg: Option<&str>,
    files_root: &Path,
) -> Result<String, String> {
    if arg == Some("device") {
        let remote = format!("/sdcard/Pictures/phonecontrol-{}.png", now_ms());
        let command = format!("screencap -p {}", sh_quote(&remote));
        adb_text(adb, &adb_args(serial, &["shell", &command])).await?;
        return Ok(remote);
    }
    let bytes = adb_bytes(adb, &adb_args(serial, &["exec-out", "screencap", "-p"])).await?;
    if bytes.len() < 8 || &bytes[..4] != b"\x89PNG" {
        return Err("screencap did not return a PNG".into());
    }
    let rel = format!("Screenshots/{serial}/{}.png", now_ms());
    let path = host_path(files_root, &rel)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    tokio::fs::write(&path, &bytes)
        .await
        .map_err(|e| e.to_string())?;
    Ok(rel)
}

/// `arg2` is `1280x720`, `/sdcard/Movies`, or `1280x720|/sdcard/Movies`.
pub fn split_record_arg(raw: Option<&str>) -> Result<(Option<&str>, Option<&str>), String> {
    let Some(raw) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok((None, None));
    };
    if let Some((size, dest)) = raw.split_once('|') {
        let size = if size.is_empty() { None } else { Some(size) };
        let dest = if dest.is_empty() { None } else { Some(dest) };
        return Ok((size, dest));
    }
    if raw.starts_with('/') {
        return Ok((None, Some(raw)));
    }
    Ok((Some(raw), None))
}

fn valid_record_size(size: &str) -> bool {
    let Some((w, h)) = size.split_once('x') else {
        return false;
    };
    !w.is_empty()
        && !h.is_empty()
        && w.chars().all(|c| c.is_ascii_digit())
        && h.chars().all(|c| c.is_ascii_digit())
}

async fn start_record(
    adb: &Path,
    serial: &str,
    bitrate: Option<&str>,
    size: Option<&str>,
) -> Result<String, String> {
    let bitrate = bitrate.unwrap_or("8000000");
    if !bitrate.chars().all(|c| c.is_ascii_digit()) {
        return Err("bitrate must be a number".into());
    }
    let (size, dest) = split_record_arg(size)?;
    if let Some(size) = size {
        if !valid_record_size(size) {
            return Err("size must look like 1280x720".into());
        }
    }
    let remote = match dest {
        Some(dir) => {
            let dir = device_path(dir)?;
            format!(
                "{}/phonecontrol-{}.mp4",
                dir.trim_end_matches('/'),
                now_ms()
            )
        }
        None => format!("/sdcard/Movies/phonecontrol-{}.mp4", now_ms()),
    };
    let mut command = format!("screenrecord --bit-rate {bitrate} --time-limit 180");
    if let Some(size) = size {
        command.push_str(" --size ");
        command.push_str(size);
    }
    command.push(' ');
    command.push_str(&sh_quote(&remote));
    let adb = adb.to_path_buf();
    let serial = serial.to_string();
    tokio::spawn(async move {
        let args = vec!["-s".into(), serial, "shell".into(), command];
        let _ = Command::new(adb).args(args).output().await;
    });
    Ok(format!(
        "{remote} (screenrecord has no audio; the device picks the frame rate)"
    ))
}

pub async fn adb_push(adb: &Path, serial: &str, local: &Path, dest: &str) -> Result<String, String> {
    let dest = device_path(dest)?;
    let local = local.to_string_lossy().to_string();
    adb_text(adb, &adb_args(serial, &["push", &local, dest])).await?;
    Ok(dest.into())
}

pub async fn adb_pull(adb: &Path, serial: &str, remote: &str, local: &Path) -> Result<(), String> {
    let remote = device_path(remote)?;
    if let Some(parent) = local.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let local = local.to_string_lossy().to_string();
    adb_text(adb, &adb_args(serial, &["pull", remote, &local])).await?;
    Ok(())
}

pub fn split_activity(raw: &str) -> (&str, &str) {
    match raw.split_once(' ') {
        Some((activity, extra)) => (activity, extra.trim()),
        None => (raw, ""),
    }
}

fn safe_am_extra(extra: &str) -> bool {
    !extra.is_empty()
        && extra.len() < 300
        && extra
            .chars()
            .all(|c| c.is_ascii_graphic() || c == ' ')
        && !extra
            .chars()
            .any(|c| matches!(c, ';' | '|' | '&' | '$' | '`' | '\\' | '\'' | '"' | '\n'))
}

async fn device_info(adb: &Path, serial: &str) -> Result<String, String> {
    let model = adb_text(adb, &adb_args(serial, &["shell", "getprop ro.product.model"]))
        .await
        .unwrap_or_default();
    let release = adb_text(
        adb,
        &adb_args(serial, &["shell", "getprop ro.build.version.release"]),
    )
    .await
    .unwrap_or_default();
    let battery = adb_text(adb, &adb_args(serial, &["shell", "dumpsys battery"]))
        .await
        .unwrap_or_default();
    let ram = adb_text(
        adb,
        &adb_args(serial, &["shell", "grep MemTotal /proc/meminfo"]),
    )
    .await
    .unwrap_or_default();
    let storage = adb_text(adb, &adb_args(serial, &["shell", "df /data"]))
        .await
        .unwrap_or_default();
    let storage_line = storage.lines().last().unwrap_or("").trim();
    Ok(format!(
        "model: {model}\nandroid: {release}\nram: {ram}\nstorage: {storage_line}\n{battery}"
    ))
}

const PLACEHOLDER_PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x50,
    0x0f, 0x00, 0x04, 0x85, 0x01, 0x80, 0x84, 0xa9, 0x8c, 0x21, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
    0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
];

/// PC-side capture used when ADB cannot read the framebuffer.
pub fn write_placeholder_screenshot(root: &Path, serial: &str) -> Result<String, String> {
    let rel = format!("Screenshots/{serial}/{}.png", now_ms());
    let path = host_path(root, &rel)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, PLACEHOLDER_PNG).map_err(|e| e.to_string())?;
    Ok(rel)
}

pub fn apply_host_op(root: &Path, op: &str, path: &str, dest: &str) -> Result<String, String> {
    match op {
        "mkdir" => {
            let dir = require_child(root, path)?;
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            Ok(path.trim_matches('/').to_string())
        }
        "rename" | "move" => {
            let from = require_child(root, path)?;
            let to = require_child(root, dest)?;
            if let Some(parent) = to.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::rename(&from, &to).map_err(|e| e.to_string())?;
            Ok(dest.trim_matches('/').to_string())
        }
        "copy" => {
            let from = require_child(root, path)?;
            let to = require_child(root, dest)?;
            copy_path(&from, &to)?;
            Ok(dest.trim_matches('/').to_string())
        }
        other => Err(format!("unknown file operation: {other}")),
    }
}

fn require_child(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if rel.trim().is_empty() {
        return Err("path is required".into());
    }
    let path = host_path(root, rel)?;
    if path == root {
        return Err("refusing to change the file root".into());
    }
    Ok(path)
}

fn copy_path(from: &Path, to: &Path) -> Result<(), String> {
    let meta = std::fs::symlink_metadata(from).map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() {
        return Err("refusing to copy a symlink".into());
    }
    if meta.is_dir() {
        std::fs::create_dir_all(to).map_err(|e| e.to_string())?;
        for entry in std::fs::read_dir(from).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            copy_path(&entry.path(), &to.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::copy(from, to)
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

async fn launch_app(
    adb: &Path,
    serial: &str,
    package: Option<&str>,
    activity: Option<&str>,
) -> Result<String, String> {
    let package = package.unwrap_or("");
    if !valid_package(package) {
        return Err("package name is not valid".into());
    }
    if let Some(raw) = activity.filter(|a| !a.is_empty()) {
        let (activity, extra) = split_activity(raw);
        if !activity
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '/')
        {
            return Err("activity name is not valid".into());
        }
        if !extra.is_empty() && !safe_am_extra(extra) {
            return Err("activity arguments are not valid".into());
        }
        let component = if activity.contains('/') {
            activity.to_string()
        } else {
            format!("{package}/{activity}")
        };
        let mut command = format!("am start -n {component}");
        if !extra.is_empty() {
            command.push(' ');
            command.push_str(extra);
        }
        adb_text(adb, &adb_args(serial, &["shell", &command])).await?;
        Ok(format!("launched {component}"))
    } else {
        adb_text(
            adb,
            &adb_args(
                serial,
                &[
                    "shell",
                    &format!("monkey -p {package} -c android.intent.category.LAUNCHER 1"),
                ],
            ),
        )
        .await?;
        Ok(format!("launched {package}"))
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn media_volume_and_mute_args() {
        let raw = "[V] will get volume\n[V] Connecting to AudioService\n[V] volume is 7 in range [0..15]\n";
        assert_eq!(super::parse_media_volume(raw), Some((7, 15)));
        assert_eq!(super::parse_media_volume("volume is 0 in range [0..25]"), Some((0, 25)));
        assert_eq!(super::parse_media_volume("Error: unknown command"), None);
        assert_eq!(super::mute_arg(Some("on")), Ok(Some(true)));
        assert_eq!(super::mute_arg(Some("off")), Ok(Some(false)));
        assert_eq!(super::mute_arg(None), Ok(None));
        assert!(super::mute_arg(Some("loud")).is_err());
    }

    #[test]
    fn stay_awake_args_and_status() {
        assert_eq!(super::stay_awake_arg(Some("on")), Ok(Some(true)));
        assert_eq!(super::stay_awake_arg(Some("off")), Ok(Some(false)));
        assert_eq!(super::stay_awake_arg(None), Ok(None));
        assert!(super::stay_awake_arg(Some("maybe")).is_err());
        assert!(super::stay_awake_is_on("7\n"));
        assert!(!super::stay_awake_is_on("0"));
        assert!(!super::stay_awake_is_on("null"));
    }

    use super::*;

    #[test]
    fn package_and_path_rules() {
        assert!(valid_package("com.example.game"));
        assert!(!valid_package("rm -rf"));
        assert!(!valid_package("com example"));
        assert!(device_path("/sdcard/Download").is_ok());
        assert!(device_path("/sdcard/../data").is_err());
        assert!(shell_line("pm list packages").is_ok());
        assert!(shell_line("one\ntwo").is_err());
        assert!(safe_input_text("hello%sworld"));
        assert!(!safe_input_text("hello;reboot"));
        assert_eq!(
            split_activity("com.example.game.MainActivity --es user bob"),
            ("com.example.game.MainActivity", "--es user bob")
        );
        assert!(safe_am_extra("--es user bob"));
        assert!(!safe_am_extra("x; rm"));
        let (size, dest) = split_record_arg(Some("1280x720|/sdcard/Movies")).unwrap();
        assert_eq!(size, Some("1280x720"));
        assert_eq!(dest, Some("/sdcard/Movies"));
    }

    #[test]
    fn host_file_ops_stay_inside_the_root() {
        let root = std::env::temp_dir().join(format!("pc-files-{}", now_ms()));
        std::fs::create_dir_all(&root).unwrap();
        assert!(apply_host_op(&root, "mkdir", "Downloads/APKs", "").is_ok());
        assert!(root.join("Downloads/APKs").is_dir());
        std::fs::write(root.join("Downloads/APKs/app.txt"), b"apk").unwrap();
        assert!(apply_host_op(&root, "copy", "Downloads/APKs/app.txt", "Downloads/app.txt").is_ok());
        assert_eq!(std::fs::read(root.join("Downloads/app.txt")).unwrap(), b"apk");
        assert!(apply_host_op(&root, "mkdir", "../escape", "").is_err());
        assert!(apply_host_op(&root, "rename", "", "Downloads/x").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn host_path_rejects_a_symlink_escape() {
        let root = std::env::temp_dir().join(format!("pc-link-{}", now_ms()));
        let outside = std::env::temp_dir().join(format!("pc-out-{}", now_ms()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), b"nope").unwrap();
        let link = root.join("leak");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        assert!(host_path(&root, "leak/secret.txt").is_err());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }
}
