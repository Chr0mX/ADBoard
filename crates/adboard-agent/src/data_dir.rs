//! Where ADBoard keeps user data.
//!
//! One folder per user, independent of where ADBoard is installed or started
//! from, so Git pulls, branch switches, updates and reinstalls never touch it:
//!
//! - `ADBOARD_DATA_DIR`, when set (explicit choice, e.g. a portable setup or tests)
//! - Windows: `%LOCALAPPDATA%\ADBoard`
//! - macOS: `~/Library/Application Support/ADBoard`
//! - Linux: `$XDG_DATA_HOME/ADBoard`, else `~/.local/share/ADBoard`
//!
//! The working directory is never used. Layout:
//!
//! ```text
//! macros/          one <Name>.adboard-macro.json per touch macro, _workspace.json
//! shell_scripts/   one <Name>.adboard-shell.json per Shell Automation script, _library.json
//! config/          user_config.json, browser_state.json, builder_state.json, …
//! logs/            adboard.log, shell_run_history.json
//! backups/         history/, deleted/, corrupt/, legacy-<date>/, backup-<date>/
//! files/           the Files area (Screenshots, APKs, Recordings, Downloads)
//! temp/            runtime scratch space
//! ```

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

pub const APP_DIR_NAME: &str = "ADBoard";

/// Where the root came from (shown in Settings and the log).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RootSource {
    Override,
    Platform,
    Fallback,
}

#[derive(Debug, Clone)]
pub struct DataRoot {
    pub path: PathBuf,
    pub source: RootSource,
}

/// The data root for this process (resolved once).
pub fn root() -> &'static DataRoot {
    static ROOT: OnceLock<DataRoot> = OnceLock::new();
    ROOT.get_or_init(|| resolve(&|name| std::env::var(name).ok(), cfg!(windows), cfg!(target_os = "macos")))
}

/// Resolve the root from an environment lookup (testable).
pub fn resolve(env: &dyn Fn(&str) -> Option<String>, windows: bool, macos: bool) -> DataRoot {
    let get = |name: &str| env(name).filter(|v| !v.trim().is_empty());
    if let Some(dir) = get("ADBOARD_DATA_DIR") {
        return DataRoot { path: PathBuf::from(dir), source: RootSource::Override };
    }
    let platform = if windows {
        get("LOCALAPPDATA")
            .map(PathBuf::from)
            .or_else(|| get("USERPROFILE").map(|home| Path::new(&home).join("AppData").join("Local")))
    } else if macos {
        get("HOME").map(|home| Path::new(&home).join("Library").join("Application Support"))
    } else {
        get("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| get("HOME").map(|home| Path::new(&home).join(".local").join("share")))
    };
    match platform {
        Some(base) => DataRoot { path: base.join(APP_DIR_NAME), source: RootSource::Platform },
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

    #[test]
    fn windows_uses_localappdata() {
        let root = resolve(&env(&[("LOCALAPPDATA", r"C:\Users\Admin\AppData\Local")]), true, false);
        assert_eq!(root.path, Path::new(r"C:\Users\Admin\AppData\Local").join("ADBoard"));
        assert_eq!(root.source, RootSource::Platform);
        let fallback = resolve(&env(&[("USERPROFILE", r"C:\Users\Admin")]), true, false);
        assert_eq!(fallback.path, Path::new(r"C:\Users\Admin").join("AppData").join("Local").join("ADBoard"));
    }

    #[test]
    fn override_wins_and_cwd_is_never_used() {
        let root = resolve(&env(&[("ADBOARD_DATA_DIR", "/srv/adboard"), ("LOCALAPPDATA", "C:/x")]), true, false);
        assert_eq!((root.path, root.source), (PathBuf::from("/srv/adboard"), RootSource::Override));
        // The legacy variable no longer chooses the root (it is only a migration source).
        let legacy = resolve(&env(&[("PHONECONTROL_DATA_DIR", "/old"), ("HOME", "/home/u")]), false, false);
        assert_eq!(legacy.path, PathBuf::from("/home/u/.local/share/ADBoard"));
        let xdg = resolve(&env(&[("XDG_DATA_HOME", "/data"), ("HOME", "/home/u")]), false, false);
        assert_eq!(xdg.path, PathBuf::from("/data/ADBoard"));
        let mac = resolve(&env(&[("HOME", "/Users/u")]), false, true);
        assert_eq!(mac.path, PathBuf::from("/Users/u/Library/Application Support/ADBoard"));
        let none = resolve(&env(&[]), false, false);
        assert_eq!(none.source, RootSource::Fallback);
        let cwd = std::env::current_dir().unwrap();
        assert!(!none.path.starts_with(&cwd) || cwd == std::env::temp_dir());
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
