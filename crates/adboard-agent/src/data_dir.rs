//! Where ADBoard keeps user data.
//!
//! Chosen in this order:
//!
//! 1. `ADBOARD_DATA_DIR`, when set (explicit choice, e.g. a portable setup or tests).
//! 2. The location saved in `adboard-location.json` in the app folder (set from
//!    the Storage tab). It takes effect on the next start.
//! 3. `adboard-data` beside the executable. Development builds (executable under
//!    `target/`) use `adboard-data` in the repository root instead.
//! 4. The per-user folder, when it already holds data and the app folder does
//!    not. Existing data is kept where it is, and the Storage tab offers to move it.
//! 5. The per-user folder otherwise: `%LOCALAPPDATA%\ADBoard` (Windows),
//!    `~/Library/Application Support/ADBoard` (macOS), `$XDG_DATA_HOME/ADBoard`
//!    or `~/.local/share/ADBoard` (Linux).
//!
//! The working directory is never used. Layout:
//!
//! ```text
//! macros/          one <Name>.json per touch macro, _workspace.json
//! shell_scripts/   one <Name>.json per Shell Automation script, _library.json
//! config/          user_config.json, browser_state.json, builder_state.json, …
//! logs/            adboard.log, shell_run_history.json
//! backups/         history/, deleted/, corrupt/, legacy-<date>/, backup-<date>/
//! files/           the Files area (Screenshots, APKs, Recordings, Downloads)
//! temp/            runtime scratch space (not copied when the folder moves)
//! ```

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

pub const APP_DIR_NAME: &str = "ADBoard";
/// Default data folder beside the executable.
pub const APP_FOLDER_DATA_NAME: &str = "adboard-data";
/// Saved location, in the app folder. Read at startup only.
pub const LOCATION_FILE: &str = "adboard-location.json";

/// Where the root came from (shown in Settings and the log).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RootSource {
    /// `ADBOARD_DATA_DIR`.
    Override,
    /// Chosen in the Storage tab (`adboard-location.json`).
    Chosen,
    /// `adboard-data` beside the executable (or in the repo for dev builds).
    AppFolder,
    /// The per-user folder, because it already holds data.
    Platform,
    /// No home folder: the system temp folder.
    Fallback,
}

#[derive(Debug, Clone)]
pub struct DataRoot {
    pub path: PathBuf,
    pub source: RootSource,
}

/// Inputs to root selection, gathered once (see `inputs()`), so the rule is testable.
#[derive(Debug, Clone, Default)]
pub struct Inputs {
    /// The app folder: holds `adboard-location.json` and `adboard-data/`.
    pub app_dir: Option<PathBuf>,
    /// The folder used as the default data location and as the Switch target
    /// (`ADBOARD_APP_DATA_DIR`, else `adboard-data` beside the executable).
    pub app_data: Option<PathBuf>,
    /// Target of a saved location, if the file exists and is valid.
    pub chosen: Option<PathBuf>,
    /// Whether the per-user folder already has data (`config/` or `macros/` present).
    pub platform_has_data: bool,
}

/// The data root for this process (resolved once).
pub fn root() -> &'static DataRoot {
    static ROOT: OnceLock<DataRoot> = OnceLock::new();
    ROOT.get_or_init(|| {
        let env = |name: &str| std::env::var(name).ok();
        let platform = platform_base(&env, cfg!(windows), cfg!(target_os = "macos"));
        let inputs = Inputs {
            app_dir: app_dir(),
            app_data: app_data_folder(),
            chosen: app_dir().and_then(|dir| read_location(&dir)),
            platform_has_data: platform
                .as_ref()
                .map(|base| base.join(APP_DIR_NAME))
                .map(|dir| has_data(&dir))
                .unwrap_or(false),
        };
        resolve(&env, cfg!(windows), cfg!(target_os = "macos"), &inputs)
    })
}

/// The app folder: the executable's folder, or the repository root for a
/// development build (the executable under `target/`).
pub fn app_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?.to_path_buf();
    if exe.components().any(|c| c.as_os_str() == "target") {
        // Walk up to the repository root (the folder with Cargo.toml).
        let mut cur: Option<&Path> = Some(dir.as_path());
        while let Some(d) = cur {
            if d.join("Cargo.toml").is_file() {
                return Some(d.to_path_buf());
            }
            cur = d.parent();
        }
        return None;
    }
    Some(dir)
}

/// Reads `adboard-location.json` in the app folder. Returns the saved folder.
pub fn read_location(app_dir: &Path) -> Option<PathBuf> {
    let bytes = std::fs::read(app_dir.join(LOCATION_FILE)).ok()?;
    let body: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let dir = body.get("dataDir")?.as_str()?.trim();
    (!dir.is_empty()).then(|| PathBuf::from(dir))
}

/// Writes `adboard-location.json` atomically (temp file, then rename).
pub fn write_location(app_dir: &Path, data_dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(app_dir).map_err(|e| format!("cannot create {}: {e}", app_dir.display()))?;
    let target = app_dir.join(LOCATION_FILE);
    let tmp = app_dir.join(format!("{LOCATION_FILE}.tmp"));
    let body = serde_json::json!({ "dataDir": data_dir.display().to_string() });
    std::fs::write(&tmp, serde_json::to_vec_pretty(&body).unwrap_or_default())
        .map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &target).map_err(|e| format!("cannot save {}: {e}", target.display()))
}

/// The data folder inside the app folder (the switch target beside ADBoard.exe).
pub fn app_data_folder() -> Option<PathBuf> {
    let set = std::env::var("ADBOARD_APP_DATA_DIR").ok().filter(|v| !v.trim().is_empty());
    set.map(|v| normalize_path(Path::new(&v))).or_else(|| app_dir().map(|dir| default_app_data(&dir)))
}

/// Resolves `.` and `..` parts without touching the disk (`D:\a\dist\windows\..\..\ADBoard` becomes `D:\a\ADBoard`).
pub fn normalize_path(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                let last_is_normal = matches!(out.components().next_back(), Some(Component::Normal(_)));
                if last_is_normal {
                    out.pop();
                } else {
                    out.push("..");
                }
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Default app folder for an app folder: the Windows pack (`<repo>\dist\windows`)
/// uses `<repo>\ADBoard`; anything else uses `adboard-data` beside the executable.
pub fn default_app_data(app: &Path) -> PathBuf {
    let parts: Vec<String> = app.components().rev().take(2).map(|c| c.as_os_str().to_string_lossy().to_lowercase()).collect();
    if parts == ["windows", "dist"] {
        if let Some(repo) = app.parent().and_then(|p| p.parent()) {
            return repo.join("ADBoard");
        }
    }
    app.join(APP_FOLDER_DATA_NAME)
}

/// The per-user data folder (`%LOCALAPPDATA%\ADBoard` and its equivalents).
pub fn user_folder() -> Option<PathBuf> {
    let env = |name: &str| std::env::var(name).ok();
    platform_base(&env, cfg!(windows), cfg!(target_os = "macos")).map(|base| base.join(APP_DIR_NAME))
}

/// Whether a folder already holds ADBoard data.
pub fn has_data(dir: &Path) -> bool {
    dir.join("config").is_dir() || dir.join("macros").is_dir()
}

/// The per-user base folder (the parent of `ADBoard`), per platform.
fn platform_base(env: &dyn Fn(&str) -> Option<String>, windows: bool, macos: bool) -> Option<PathBuf> {
    let get = |name: &str| env(name).filter(|v| !v.trim().is_empty());
    if windows {
        get("LOCALAPPDATA")
            .map(PathBuf::from)
            .or_else(|| get("USERPROFILE").map(|home| Path::new(&home).join("AppData").join("Local")))
    } else if macos {
        get("HOME").map(|home| Path::new(&home).join("Library").join("Application Support"))
    } else {
        get("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| get("HOME").map(|home| Path::new(&home).join(".local").join("share")))
    }
}

/// Select the root from the environment and the gathered inputs (testable).
pub fn resolve(env: &dyn Fn(&str) -> Option<String>, windows: bool, macos: bool, inputs: &Inputs) -> DataRoot {
    let get = |name: &str| env(name).filter(|v| !v.trim().is_empty());
    if let Some(dir) = get("ADBOARD_DATA_DIR") {
        return DataRoot { path: PathBuf::from(dir), source: RootSource::Override };
    }
    if let Some(dir) = inputs.chosen.clone() {
        return DataRoot { path: dir, source: RootSource::Chosen };
    }
    let platform = platform_base(env, windows, macos).map(|base| base.join(APP_DIR_NAME));
    let app_data = inputs.app_data.clone().or_else(|| inputs.app_dir.as_ref().map(|dir| dir.join(APP_FOLDER_DATA_NAME)));
    if let Some(app_data) = app_data {
        // Data already in the per-user folder stays there until the user moves it.
        if inputs.platform_has_data && !has_data(&app_data) {
            if let Some(base) = platform.clone() {
                return DataRoot { path: base, source: RootSource::Platform };
            }
        }
        return DataRoot { path: app_data, source: RootSource::AppFolder };
    }
    match platform {
        Some(path) => DataRoot { path, source: RootSource::Platform },
        // No home folder at all (unusual service setups): the system temp
        // folder, never the working directory.
        None => DataRoot { path: std::env::temp_dir().join(APP_DIR_NAME), source: RootSource::Fallback },
    }
}

pub fn path(sub: &str) -> PathBuf {
    root().path.join(sub)
}

pub fn macros_dir() -> PathBuf {
    path("macros")
}
pub fn shell_scripts_dir() -> PathBuf {
    path("shell_scripts")
}
pub fn config_dir() -> PathBuf {
    path("config")
}
pub fn logs_dir() -> PathBuf {
    path("logs")
}
pub fn backups_dir() -> PathBuf {
    path("backups")
}
pub fn files_dir() -> PathBuf {
    path("files")
}
pub fn temp_dir() -> PathBuf {
    path("temp")
}

/// Create the standard folders (first launch). Errors are returned, not fatal.
pub fn ensure_layout() -> Result<(), String> {
    for dir in [macros_dir(), shell_scripts_dir(), config_dir(), logs_dir(), backups_dir(), files_dir(), temp_dir()] {
        std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    }
    Ok(())
}

/// Files and bytes under a folder (0, 0 if it does not exist).
pub fn tree_stats(dir: &Path) -> (u64, u64) {
    let mut files = 0u64;
    let mut bytes = 0u64;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            match entry.file_type() {
                Ok(t) if t.is_dir() => stack.push(path),
                Ok(t) if t.is_file() => {
                    files += 1;
                    bytes += entry.metadata().map(|m| m.len()).unwrap_or(0);
                }
                _ => {}
            }
        }
    }
    (files, bytes)
}

/// Why `target` cannot receive a move of `from`, or `None` if it can.
/// The target must be absolute, not inside the source (or the other way round),
/// and empty (or not exist yet). Existing data is never merged or overwritten.
pub fn move_refusal(from: &Path, target: &Path) -> Option<String> {
    if !target.is_absolute() {
        return Some("The folder must be a full path, for example D:\\adboard-data.".into());
    }
    if target.starts_with(from) || from.starts_with(target) {
        return Some("The new folder can't be inside the current one, or contain it.".into());
    }
    if target.exists() {
        if !target.is_dir() {
            return Some(format!("{} is a file, not a folder.", target.display()));
        }
        // The scratch folder does not count: it is created on every start.
        let non_empty = std::fs::read_dir(target)
            .map(|entries| entries.flatten().any(|entry| entry.file_name() != "temp"))
            .unwrap_or(true);
        if non_empty {
            return Some(format!("{} is not empty. Choose an empty folder, or use it as it is.", target.display()));
        }
    }
    None
}

/// Copies the data folder to `to`, leaving out `temp/` (scratch space). Returns
/// the files and bytes copied. The source is never changed.
pub fn copy_tree(from: &Path, to: &Path) -> Result<(u64, u64), String> {
    std::fs::create_dir_all(to).map_err(|e| format!("cannot create {}: {e}", to.display()))?;
    let mut files = 0u64;
    let mut bytes = 0u64;
    let mut stack = vec![(from.to_path_buf(), to.to_path_buf())];
    while let Some((src, dst)) = stack.pop() {
        std::fs::create_dir_all(&dst).map_err(|e| format!("cannot create {}: {e}", dst.display()))?;
        let entries = std::fs::read_dir(&src).map_err(|e| format!("cannot read {}: {e}", src.display()))?;
        for entry in entries {
            let entry = entry.map_err(|e| format!("cannot read {}: {e}", src.display()))?;
            let name = entry.file_name();
            let from_path = entry.path();
            let to_path = dst.join(&name);
            let file_type = entry.file_type().map_err(|e| format!("cannot read {}: {e}", from_path.display()))?;
            if file_type.is_dir() {
                if src == from && name == "temp" {
                    continue;
                }
                stack.push((from_path, to_path));
            } else if file_type.is_file() {
                let copied = std::fs::copy(&from_path, &to_path)
                    .map_err(|e| format!("cannot copy {}: {e}", from_path.display()))?;
                files += 1;
                bytes += copied;
            }
        }
    }
    Ok((files, bytes))
}

const LOG_FILE: &str = "adboard.log";
const LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;
const LOG_KEEP: u32 = 3;

/// `logs/adboard.log`, opened for appending. A log over 5 MB is rotated
/// first (`adboard.log.1` … `.3`; the oldest is dropped).
pub fn open_log_file() -> Result<std::fs::File, String> {
    let dir = logs_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let path = dir.join(LOG_FILE);
    if std::fs::metadata(&path).map(|m| m.len() > LOG_MAX_BYTES).unwrap_or(false) {
        for n in (1..LOG_KEEP).rev() {
            let _ = std::fs::rename(dir.join(format!("{LOG_FILE}.{n}")), dir.join(format!("{LOG_FILE}.{}", n + 1)));
        }
        let _ = std::fs::rename(&path, dir.join(format!("{LOG_FILE}.1")));
    }
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("cannot open {}: {e}", path.display()))
}

/// `yyyy-mm-dd_hhmmss` in UTC, for backup folder names.
pub fn stamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (y, m, d) = civil_from_days((secs / 86_400) as i64);
    let rem = secs % 86_400;
    format!("{y:04}-{m:02}-{d:02}_{:02}{:02}{:02}", rem / 3600, (rem / 60) % 60, rem % 60)
}

/// Days since 1970-01-01 → (year, month, day) (Howard Hinnant's algorithm).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// A display name → a safe file name stem, for Windows and every other OS.
/// Keeps letters, digits and `-_.()`; spaces become `_`; invalid characters
/// (`<>:"/\|?*`, control characters) become `_`; reserved Windows names get a
/// trailing `_`; trailing dots/spaces are trimmed; at most 80 characters.
pub fn safe_file_stem(name: &str, fallback: &str) -> String {
    let cleaned: String = name
        .trim()
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() || c.is_whitespace() => '_',
            c => c,
        })
        .take(80)
        .collect();
    // Windows drops trailing dots; a name of only placeholders is no name.
    let trimmed = cleaned.trim_end_matches('.');
    let mut out = if trimmed.chars().all(|c| c == '_') { fallback.to_string() } else { trimmed.to_string() };
    let upper = out.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((upper.starts_with("COM") || upper.starts_with("LPT")) && upper.len() == 4 && upper.as_bytes()[3].is_ascii_digit());
    if reserved {
        out.push('_');
    }
    out
}

/// `stem`, or `stem_2`, `stem_3`… — the first not in `taken` (case-insensitive,
/// as Windows file names are).
pub fn unique_stem(stem: &str, taken: &std::collections::HashSet<String>) -> String {
    if !taken.contains(&stem.to_lowercase()) {
        return stem.to_string();
    }
    (2..)
        .map(|n| format!("{stem}_{n}"))
        .find(|candidate| !taken.contains(&candidate.to_lowercase()))
        .expect("an unused name")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |name| map.get(name).cloned()
    }

    fn none() -> Inputs {
        Inputs::default()
    }

    #[test]
    fn windows_uses_localappdata_without_an_app_folder() {
        let root = resolve(&env(&[("LOCALAPPDATA", r"C:\Users\Admin\AppData\Local")]), true, false, &none());
        assert_eq!(root.path, Path::new(r"C:\Users\Admin\AppData\Local").join("ADBoard"));
        assert_eq!(root.source, RootSource::Platform);
        let fallback = resolve(&env(&[("USERPROFILE", r"C:\Users\Admin")]), true, false, &none());
        assert_eq!(fallback.path, Path::new(r"C:\Users\Admin").join("AppData").join("Local").join("ADBoard"));
    }

    #[test]
    fn default_is_the_app_folder() {
        let inputs = Inputs { app_dir: Some(PathBuf::from("/opt/adboard")), ..none() };
        let root = resolve(&env(&[("HOME", "/home/u")]), false, false, &inputs);
        assert_eq!((root.path, root.source), (PathBuf::from("/opt/adboard/adboard-data"), RootSource::AppFolder));
    }

    #[test]
    fn parent_parts_are_resolved_in_the_app_data_path() {
        assert_eq!(normalize_path(Path::new("/repo/dist/windows/../../ADBoard")), PathBuf::from("/repo/ADBoard"));
        assert_eq!(normalize_path(Path::new("/a/./b")), PathBuf::from("/a/b"));
    }

    #[test]
    fn windows_pack_defaults_to_the_repo_root_adboard_folder() {
        assert_eq!(default_app_data(Path::new("/repo/dist/windows")), PathBuf::from("/repo/ADBoard"));
        assert_eq!(default_app_data(Path::new("/opt/adboard")), PathBuf::from("/opt/adboard/adboard-data"));
    }

    #[test]
    fn app_data_setting_moves_the_default_and_the_switch_target() {
        let inputs = Inputs { app_dir: Some(PathBuf::from("/opt/adboard")), app_data: Some(PathBuf::from("/repo/ADBoard")), ..none() };
        let root = resolve(&env(&[]), false, false, &inputs);
        assert_eq!((root.path, root.source), (PathBuf::from("/repo/ADBoard"), RootSource::AppFolder));
        // A full override still beats it.
        let root = resolve(&env(&[("ADBOARD_DATA_DIR", "/srv/x")]), false, false, &inputs);
        assert_eq!(root.source, RootSource::Override);
    }

    #[test]
    fn saved_location_wins_over_the_app_folder() {
        let inputs = Inputs { app_dir: Some(PathBuf::from("/opt/adboard")), chosen: Some(PathBuf::from("/srv/data")), ..none() };
        let root = resolve(&env(&[]), false, false, &inputs);
        assert_eq!((root.path, root.source), (PathBuf::from("/srv/data"), RootSource::Chosen));
    }

    #[test]
    fn override_beats_everything() {
        let inputs = Inputs { app_dir: Some(PathBuf::from("/opt/adboard")), chosen: Some(PathBuf::from("/srv/data")), ..none() };
        let root = resolve(&env(&[("ADBOARD_DATA_DIR", "/srv/adboard")]), true, false, &inputs);
        assert_eq!((root.path, root.source), (PathBuf::from("/srv/adboard"), RootSource::Override));
    }

    #[test]
    fn existing_per_user_data_is_kept_until_moved() {
        let inputs = Inputs { app_dir: Some(PathBuf::from("/opt/adboard")), platform_has_data: true, ..none() };
        let root = resolve(&env(&[("HOME", "/home/u")]), false, false, &inputs);
        assert_eq!((root.path, root.source), (PathBuf::from("/home/u/.local/share/ADBoard"), RootSource::Platform));
        // Once the app folder has data of its own, it is used.
        let app = std::env::temp_dir().join(format!("adboard-app-{}", std::process::id()));
        std::fs::create_dir_all(app.join(APP_FOLDER_DATA_NAME).join("config")).unwrap();
        let inputs = Inputs { app_dir: Some(app.clone()), platform_has_data: true, ..none() };
        let root = resolve(&env(&[("HOME", "/home/u")]), false, false, &inputs);
        assert_eq!((root.path, root.source), (app.join(APP_FOLDER_DATA_NAME), RootSource::AppFolder));
        let _ = std::fs::remove_dir_all(&app);
    }

    #[test]
    fn legacy_variable_and_platform_paths() {
        // The legacy variable no longer chooses the root (it is only a migration source).
        let legacy = resolve(&env(&[("PHONECONTROL_DATA_DIR", "/old"), ("HOME", "/home/u")]), false, false, &none());
        assert_eq!(legacy.path, PathBuf::from("/home/u/.local/share/ADBoard"));
        let xdg = resolve(&env(&[("XDG_DATA_HOME", "/data"), ("HOME", "/home/u")]), false, false, &none());
        assert_eq!(xdg.path, PathBuf::from("/data/ADBoard"));
        let mac = resolve(&env(&[("HOME", "/Users/u")]), false, true, &none());
        assert_eq!(mac.path, PathBuf::from("/Users/u/Library/Application Support/ADBoard"));
        let no_home = resolve(&env(&[]), false, false, &none());
        assert_eq!(no_home.source, RootSource::Fallback);
        let cwd = std::env::current_dir().unwrap();
        assert!(!no_home.path.starts_with(&cwd) || cwd == std::env::temp_dir());
    }

    #[test]
    fn location_file_round_trips_and_ignores_garbage() {
        let dir = std::env::temp_dir().join(format!("adboard-loc-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(read_location(&dir), None);
        write_location(&dir, Path::new("/srv/adboard data")).unwrap();
        assert_eq!(read_location(&dir), Some(PathBuf::from("/srv/adboard data")));
        std::fs::write(dir.join(LOCATION_FILE), b"not json").unwrap();
        assert_eq!(read_location(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn move_refusals() {
        let base = std::env::temp_dir().join(format!("adboard-move-{}", std::process::id()));
        let from = base.join("from");
        std::fs::create_dir_all(&from).unwrap();
        assert!(move_refusal(&from, Path::new("relative/dir")).is_some());
        assert!(move_refusal(&from, &from.join("inside")).is_some());
        assert!(move_refusal(&from.join("sub"), &from).is_some());
        let busy = base.join("busy");
        std::fs::create_dir_all(&busy).unwrap();
        std::fs::write(busy.join("x"), b"1").unwrap();
        assert!(move_refusal(&from, &busy).is_some());
        let empty = base.join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        assert!(move_refusal(&from, &empty).is_none());
        let scratch_only = base.join("scratch");
        std::fs::create_dir_all(scratch_only.join("temp")).unwrap();
        assert!(move_refusal(&from, &scratch_only).is_none(), "a folder with only temp/ is empty");
        assert!(move_refusal(&from, &base.join("new")).is_none());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn copy_keeps_files_and_leaves_out_temp() {
        let base = std::env::temp_dir().join(format!("adboard-copy-{}", std::process::id()));
        let from = base.join("from");
        let to = base.join("to");
        std::fs::create_dir_all(from.join("config")).unwrap();
        std::fs::create_dir_all(from.join("temp")).unwrap();
        std::fs::write(from.join("config").join("a.json"), b"hello").unwrap();
        std::fs::write(from.join("temp").join("scratch"), b"skip").unwrap();
        let (files, bytes) = copy_tree(&from, &to).unwrap();
        assert_eq!((files, bytes), (1, 5));
        assert_eq!(tree_stats(&to), (1, 5));
        assert!(!to.join("temp").exists());
        assert_eq!(tree_stats(&from), (2, 9));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn file_stems_are_safe_and_unique() {
        assert_eq!(safe_file_stem("Daily Login", "x"), "Daily_Login");
        assert_eq!(safe_file_stem("Daily:Login?", "x"), "Daily_Login_");
        assert_eq!(safe_file_stem("  a/b\\c<d>e|f*g\"h  ", "x"), "a_b_c_d_e_f_g_h");
        assert_eq!(safe_file_stem("", "Untitled_macro"), "Untitled_macro");
        assert_eq!(safe_file_stem("???", "Untitled_macro"), "Untitled_macro");
        assert_eq!(safe_file_stem("trailing...", "x"), "trailing");
        assert_eq!(safe_file_stem("CON", "x"), "CON_");
        assert_eq!(safe_file_stem("com1", "x"), "com1_");
        assert_eq!(safe_file_stem("Collect Rewards (v2)", "x"), "Collect_Rewards_(v2)");
        assert_eq!(safe_file_stem(&"a".repeat(200), "x").len(), 80);
        let taken: std::collections::HashSet<String> = ["daily_login".into(), "daily_login_2".into()].into_iter().collect();
        assert_eq!(unique_stem("Daily_Login", &taken), "Daily_Login_3");
        assert_eq!(unique_stem("Other", &taken), "Other");
    }

    #[test]
    fn stamp_is_a_date() {
        let s = stamp();
        assert_eq!(s.len(), 17, "{s}");
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(20_743), (2026, 10, 17));
    }
}
