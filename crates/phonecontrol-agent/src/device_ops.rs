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
    Ok(root.join(rel))
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
        "screenshot" => capture_screenshot(adb, serial, arg, files_root).await,
        "recordStart" => start_record(adb, serial, arg, arg2).await,
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
            if text.is_empty() || text.contains('\n') {
                return Err("text must be one line".into());
            }
            adb_text(
                adb,
                &adb_args(serial, &["shell", &format!("input text {text}")]),
            )
            .await?;
            Ok("typed".into())
        }
        "info" => {
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
            Ok(format!("model: {model}\nandroid: {release}\n{battery}"))
        }
        "push" => Err("use the file upload".into()),
        other => Err(format!("unknown device operation: {other}")),
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
    let remote = format!("/sdcard/Movies/phonecontrol-{}.mp4", now_ms());
    let mut command = format!("screenrecord --bit-rate {bitrate} --time-limit 180");
    if let Some(size) = size {
        if !size.chars().all(|c| c.is_ascii_digit() || c == 'x') || !size.contains('x') {
            return Err("size must look like 1280x720".into());
        }
        command.push_str(" --size ");
        command.push_str(size);
    }
    command.push(' ');
    command.push_str(&remote);
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
    if let Some(activity) = activity.filter(|a| !a.is_empty()) {
        if !activity
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '/')
        {
            return Err("activity name is not valid".into());
        }
        let component = if activity.contains('/') {
            activity.to_string()
        } else {
            format!("{package}/{activity}")
        };
        adb_text(
            adb,
            &adb_args(serial, &["shell", &format!("am start -n {component}")]),
        )
        .await?;
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
    }
}
