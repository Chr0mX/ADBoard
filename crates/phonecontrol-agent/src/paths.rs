//! Resolve vendored ADB / scrcpy binaries under the project tree.
//!
//! Layout (populated by `make fetch-deps` / `scripts/fetch-deps.*`):
//! - Linux: `tools/linux/adb/adb`, `tools/linux/scrcpy/scrcpy` (+ `scrcpy-server`)
//! - Windows pack: `dist/windows/vendor/adb/adb.exe`, `dist/windows/vendor/scrcpy/scrcpy.exe`
//!
//! Also checks next to the running executable (for a copied `dist/windows/` folder).

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

fn project_roots() -> &'static [PathBuf] {
    static ROOTS: OnceLock<Vec<PathBuf>> = OnceLock::new();
    ROOTS.get_or_init(|| {
        let mut roots = Vec::new();
        if let Ok(cwd) = std::env::current_dir() {
            push_unique(&mut roots, cwd.clone());
            if let Some(r) = find_repo_root(&cwd) {
                push_unique(&mut roots, r);
            }
        }
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                push_unique(&mut roots, dir.to_path_buf());
                // ADBoard.exe lives in dist/windows/ — repo root is two up.
                if let Some(grand) = dir.parent().and_then(|p| p.parent()) {
                    push_unique(&mut roots, grand.to_path_buf());
                }
                if let Some(r) = find_repo_root(dir) {
                    push_unique(&mut roots, r);
                }
            }
        }
        roots
    })
}

/// Working folder for staged APKs, file pushes/pulls and upload chunks:
/// `PHONECONTROL_TEMP`, else `<repo root>/temp`, else `temp/` next to the
/// executable. Falls back to the OS temp dir if none can be created.
pub fn app_temp_dir() -> PathBuf {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(|| {
        let preferred = std::env::var("PHONECONTROL_TEMP")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| temp_root().join("temp"));
        match std::fs::create_dir_all(&preferred) {
            Ok(()) => preferred,
            Err(error) => {
                tracing::warn!(path = %preferred.display(), %error, "cannot create temp folder; using the system temp dir");
                std::env::temp_dir()
            }
        }
    })
    .clone()
}

fn temp_root() -> PathBuf {
    if let Ok(cwd) = std::env::current_dir() {
        if let Some(root) = find_repo_root(&cwd) {
            return root;
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            if let Some(root) = find_repo_root(dir) {
                return root;
            }
            return dir.to_path_buf();
        }
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn push_unique(roots: &mut Vec<PathBuf>, path: PathBuf) {
    if !roots.iter().any(|r| r == &path) {
        roots.push(path);
    }
}

fn find_repo_root(start: &Path) -> Option<PathBuf> {
    let mut cur = start.to_path_buf();
    loop {
        if cur.join("Cargo.toml").is_file()
            && (cur.join("scripts/fetch-deps.sh").is_file()
                || cur.join("tools/linux").is_dir()
                || cur.join("dist/windows").is_dir())
        {
            return Some(cur);
        }
        if !cur.pop() {
            return None;
        }
    }
}

fn first_existing(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates.iter().find(|p| p.is_file()).cloned()
}

/// Vendored `adb` / `adb.exe` (after env override is handled by caller).
pub fn vendored_adb() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    for root in project_roots() {
        candidates.push(root.join("tools/linux/adb/adb"));
        candidates.push(root.join("dist/windows/vendor/adb/adb.exe"));
        // Running from dist/windows/
        candidates.push(root.join("vendor/adb/adb.exe"));
        candidates.push(root.join("adb.exe"));
        candidates.push(root.join("adb"));
    }
    first_existing(&candidates)
}

/// Vendored `scrcpy` / `scrcpy.exe`.
pub fn vendored_scrcpy() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    for root in project_roots() {
        candidates.push(root.join("tools/linux/scrcpy/scrcpy"));
        candidates.push(root.join("dist/windows/vendor/scrcpy/scrcpy.exe"));
        candidates.push(root.join("vendor/scrcpy/scrcpy.exe"));
        candidates.push(root.join("scrcpy.exe"));
        candidates.push(root.join("scrcpy"));
    }
    first_existing(&candidates)
}

/// Vendored scrcpy-server jar/blob.
pub fn vendored_scrcpy_server() -> Option<PathBuf> {
    let mut dirs = Vec::new();
    for root in project_roots() {
        dirs.push(root.join("tools/linux/scrcpy"));
        dirs.push(root.join("dist/windows/vendor/scrcpy"));
        dirs.push(root.join("vendor/scrcpy"));
        dirs.push(root.clone());
    }
    for dir in dirs {
        if !dir.is_dir() {
            continue;
        }
        for name in ["scrcpy-server", "scrcpy-server.jar"] {
            let p = dir.join(name);
            if p.is_file() {
                return Some(p);
            }
        }
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name.starts_with("scrcpy-server") && entry.path().is_file() {
                    return Some(entry.path());
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vendored_lookups_do_not_panic() {
        let _ = vendored_adb();
        let _ = vendored_scrcpy();
        let _ = vendored_scrcpy_server();
    }
}

#[cfg(test)]
mod temp_dir_tests {
    #[test]
    fn temp_dir_is_repo_temp() {
        if std::env::var("PHONECONTROL_TEMP").is_ok() {
            return;
        }
        let dir = super::app_temp_dir();
        assert!(dir.is_dir(), "{}", dir.display());
        assert!(dir.ends_with("temp"), "{}", dir.display());
        assert!(dir.parent().unwrap().join("Cargo.toml").is_file(), "{}", dir.display());
    }
}
