//! One-time move of data kept by older versions into the ADBoard data folder.
//!
//! Older versions kept data next to the executable or under the folder they
//! were started from: `adboard-data/` (macros, scripts, queue…),
//! `adboard-auth.json` / `rasiel-auth.json` (sign-in account),
//! `data/phonecontrol-files/` (Files area) and `data/wireless-adb.json`.
//!
//! For each one found, at startup and before anything reads the store:
//! 1. copy it into the new layout, but never over data that already exists
//!    there (that data wins; the old copy is kept in backups to import);
//! 2. verify the copy (read back and compare, or count and size files);
//! 3. only then move the original into `backups/legacy-<date>/`, leaving
//!    `MOVED_TO_ADBOARD.txt` where it was. A failed step leaves the original
//!    untouched and is reported.
//!
//! The result is kept in `config/migration.json` and shown in Settings.

use crate::data_dir::stamp;
use crate::shared_store::{copy_tree, write_atomic, SharedStore, StoredValue};
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

/// Store names older versions used (one `<name>.json` each).
const LEGACY_STORE_NAMES: &[&str] = &["macros", "desk", "macro-queue", "macro-schedules", "macro-assignments"];
const NOTE: &str = "MOVED_TO_ADBOARD.txt";

/// Where to look (built from the environment by [`detect`]; tests pass their own).
#[derive(Debug, Default, Clone)]
pub struct Sources {
    pub store_dirs: Vec<PathBuf>,
    pub auth_files: Vec<PathBuf>,
    pub files_dirs: Vec<PathBuf>,
    pub wireless_files: Vec<PathBuf>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub kind: String,
    pub source: String,
    /// migrated | kept-existing | failed
    pub action: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub ran_at: u64,
    /// Where the originals went (`backups/legacy-<date>`), if anything moved.
    pub backup: Option<String>,
    pub items: Vec<Item>,
}

impl Report {
    pub fn failed(&self) -> bool {
        self.items.iter().any(|i| i.action == "failed")
    }
}

fn push_unique(list: &mut Vec<PathBuf>, path: PathBuf) {
    let key = path.canonicalize().unwrap_or_else(|_| path.clone());
    if !list.iter().any(|p| p.canonicalize().unwrap_or_else(|_| p.clone()) == key) {
        list.push(path);
    }
}

/// Legacy locations: next to the executable, the repo's `dist/windows`, the
/// working directory, and the legacy `PHONECONTROL_DATA_DIR`. Only places
/// that exist are returned; the new data folder itself is never a source.
pub fn detect(root: &Path) -> Sources {
    let mut bases: Vec<PathBuf> = Vec::new();
    if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)) {
        push_unique(&mut bases, dir.clone());
        if let Some(repo) = crate::paths::find_repo_root(&dir) {
            push_unique(&mut bases, repo.join("dist").join("windows"));
            push_unique(&mut bases, repo);
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        push_unique(&mut bases, cwd.clone());
        if let Some(repo) = crate::paths::find_repo_root(&cwd) {
            push_unique(&mut bases, repo.join("dist").join("windows"));
            push_unique(&mut bases, repo);
        }
    }
    let inside_root = |p: &Path| {
        let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
        p.canonicalize().map(|c| c.starts_with(&root)).unwrap_or(false)
    };
    let mut sources = Sources::default();
    // Legacy compatibility: the pre-rename variable named the old store folder.
    if let Ok(dir) = std::env::var("PHONECONTROL_DATA_DIR") {
        if !dir.trim().is_empty() {
            push_unique(&mut sources.store_dirs, PathBuf::from(dir));
        }
    }
    for base in &bases {
        push_unique(&mut sources.store_dirs, base.join("adboard-data"));
        push_unique(&mut sources.auth_files, base.join("adboard-auth.json"));
        push_unique(&mut sources.auth_files, base.join("rasiel-auth.json"));
        push_unique(&mut sources.files_dirs, base.join("data").join("phonecontrol-files"));
        push_unique(&mut sources.wireless_files, base.join("data").join("wireless-adb.json"));
    }
    sources.store_dirs.retain(|p| p.is_dir() && !inside_root(p));
    sources.auth_files.retain(|p| p.is_file() && !inside_root(p));
    sources.files_dirs.retain(|p| p.is_dir() && !inside_root(p));
    sources.wireless_files.retain(|p| p.is_file() && !inside_root(p));
    sources
}

/// A short folder label for the backup copy of `path` (e.g. `dist_windows_adboard-data`).
fn label(path: &Path) -> String {
    let parts: Vec<String> = path
        .components()
        .rev()
        .take(3)
        .map(|c| c.as_os_str().to_string_lossy().replace([':', '\\', '/'], ""))
        .filter(|s| !s.is_empty())
        .collect();
    parts.into_iter().rev().collect::<Vec<_>>().join("_")
}

struct Mover {
    backup_root: PathBuf,
    used: bool,
}

impl Mover {
    /// Move `path` into the backup folder (rename, or copy + verify + remove
    /// across drives) and leave a note where it was.
    fn retire(&mut self, path: &Path, new_home: &str) -> Result<PathBuf, String> {
        let mut target = self.backup_root.join(label(path));
        let mut n = 2;
        while target.exists() {
            target = self.backup_root.join(format!("{}_{n}", label(path)));
            n += 1;
        }
        std::fs::create_dir_all(&self.backup_root).map_err(|e| e.to_string())?;
        if std::fs::rename(path, &target).is_err() {
            if path.is_dir() {
                let copied = copy_tree(path, &target)?;
                let original = count_files(path).0;
                if copied != original {
                    return Err(format!("copied {copied} of {original} files"));
                }
                std::fs::remove_dir_all(path).map_err(|e| e.to_string())?;
            } else {
                std::fs::copy(path, &target).map_err(|e| e.to_string())?;
                std::fs::remove_file(path).map_err(|e| e.to_string())?;
            }
        }
        self.used = true;
        let note = format!(
            "ADBoard now keeps this data in its data folder:\n  {new_home}\n\nThe original was moved to:\n  {}\n\nThis note can be deleted.\n",
            target.display()
        );
        let note_path = if path.extension().is_some() { path.with_extension("MOVED_TO_ADBOARD.txt") } else { path.join(NOTE) };
        if let Some(dir) = note_path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(note_path, note);
        Ok(target)
    }
}

fn count_files(dir: &Path) -> (u64, u64) {
    let mut count = 0;
    let mut bytes = 0;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let (c, b) = count_files(&path);
                count += c;
                bytes += b;
            } else if path.is_file() && path.file_name().map(|n| n != NOTE).unwrap_or(true) {
                count += 1;
                bytes += entry.metadata().map(|m| m.len()).unwrap_or(0);
            }
        }
    }
    (count, bytes)
}

fn item(kind: &str, source: &Path, action: &str, detail: impl Into<String>) -> Item {
    Item { kind: kind.into(), source: source.display().to_string(), action: action.into(), detail: detail.into() }
}

/// Run the migration against `store` (rooted at the new data folder).
pub fn run(store: &SharedStore, sources: &Sources) -> Report {
    let root = store.root().to_path_buf();
    let mut report = Report { ran_at: crate::macro_runner::now_ms(), ..Default::default() };
    let mut mover = Mover { backup_root: root.join("backups").join(format!("legacy-{}", stamp())), used: false };

    for dir in &sources.store_dirs {
        let mut ok = true;
        let mut found = false;
        for name in LEGACY_STORE_NAMES {
            let path = dir.join(format!("{name}.json"));
            if !path.is_file() {
                continue;
            }
            found = true;
            let kind = format!("store:{name}");
            let legacy: StoredValue = match std::fs::read(&path).map_err(|e| e.to_string()).and_then(|b| serde_json::from_slice(&b).map_err(|e| e.to_string())) {
                Ok(v) => v,
                Err(error) => {
                    ok = false;
                    report.items.push(item(&kind, &path, "failed", format!("unreadable, left in place: {error}")));
                    continue;
                }
            };
            if legacy.value.is_null() {
                report.items.push(item(&kind, &path, "migrated", "empty"));
                continue;
            }
            let current = store.get(name).unwrap_or_else(StoredValue::empty);
            if !current.value.is_null() {
                report.items.push(item(&kind, &path, "kept-existing", "the data folder already has this; the old copy is kept in backups (import it from Settings → Data if needed)"));
                continue;
            }
            match store.put(name, legacy.value.clone(), current.rev) {
                Ok(_) => {
                    let back = store.get(name).map(|s| s.value).unwrap_or(Value::Null);
                    if same_data(name, &back, &legacy.value) {
                        report.items.push(item(&kind, &path, "migrated", format!("{} item(s)", count(&legacy.value))));
                    } else {
                        ok = false;
                        report.items.push(item(&kind, &path, "failed", "the copy did not read back the same; original left in place"));
                    }
                }
                Err(error) => {
                    ok = false;
                    report.items.push(item(&kind, &path, "failed", format!("could not save: {error:?}")));
                }
            }
        }
        // Earlier versions (Macros → Versions) come along.
        let history = dir.join("history");
        if history.is_dir() {
            let _ = copy_tree(&history, &root.join("backups").join("history"));
        }
        if found && ok {
            match mover.retire(dir, &root.display().to_string()) {
                Ok(target) => report.items.push(item("store-folder", dir, "migrated", format!("original moved to {}", target.display()))),
                Err(error) => report.items.push(item("store-folder", dir, "failed", format!("copied, but the original could not be moved: {error}"))),
            }
        }
    }

    let auth_target = root.join("config").join("auth.json");
    for path in &sources.auth_files {
        if !crate::web_auth::credentials_file_ok(path) {
            report.items.push(item("account", path, "failed", "unreadable account file, left in place"));
            continue;
        }
        if auth_target.exists() {
            report.items.push(item("account", path, "kept-existing", "an account already exists in the data folder; the old file is kept in backups"));
        } else {
            let copied = std::fs::create_dir_all(auth_target.parent().expect("parent"))
                .map_err(|e| e.to_string())
                .and_then(|_| std::fs::read(path).map_err(|e| e.to_string()))
                .and_then(|bytes| write_atomic(&auth_target, &bytes));
            restrict(&auth_target);
            if copied.is_err() || !crate::web_auth::credentials_file_ok(&auth_target) {
                report.items.push(item("account", path, "failed", format!("could not copy: {copied:?}")));
                continue;
            }
            report.items.push(item("account", path, "migrated", "sign-in account kept"));
        }
        if let Err(error) = mover.retire(path, &auth_target.display().to_string()) {
            report.items.push(item("account", path, "failed", format!("copied, but the original could not be moved: {error}")));
        }
    }

    let wireless_target = root.join("config").join("wireless_devices.json");
    for path in &sources.wireless_files {
        let legacy: Vec<Value> = match std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()) {
            Some(list) => list,
            None => {
                report.items.push(item("wireless", path, "failed", "unreadable, left in place"));
                continue;
            }
        };
        let mut merged: Vec<Value> = std::fs::read(&wireless_target).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let before = merged.len();
        for entry in legacy {
            if !merged.contains(&entry) {
                merged.push(entry);
            }
        }
        let saved = serde_json::to_vec_pretty(&merged).map_err(|e| e.to_string()).and_then(|b| write_atomic(&wireless_target, &b));
        if let Err(error) = saved {
            report.items.push(item("wireless", path, "failed", error));
            continue;
        }
        report.items.push(item("wireless", path, "migrated", format!("{} saved device(s) added", merged.len() - before)));
        let _ = mover.retire(path, &wireless_target.display().to_string());
    }

    let files_target = root.join("files");
    for dir in &sources.files_dirs {
        let (count, bytes) = count_files(dir);
        if count == 0 {
            continue;
        }
        let empty_target = count_files(&files_target).0 == 0;
        if empty_target {
            // Move the folder itself (no duplicate of large files).
            let _ = std::fs::remove_dir_all(&files_target);
            if std::fs::rename(dir, &files_target).is_ok() {
                report.items.push(item("files", dir, "migrated", format!("{count} file(s) moved")));
                let _ = std::fs::create_dir_all(dir);
                let _ = std::fs::write(dir.join(NOTE), format!("ADBoard's Files area is now:\n  {}\n", files_target.display()));
                continue;
            }
            let _ = std::fs::create_dir_all(&files_target);
        }
        // Different drive, or files already there: copy (existing files win), verify, then retire the original.
        if let Err(error) = copy_tree(dir, &files_target) {
            report.items.push(item("files", dir, "failed", format!("copy failed, original left in place: {error}")));
            continue;
        }
        let missing = missing_files(dir, &files_target);
        if empty_target && (!missing.is_empty() || count_files(&files_target) != (count, bytes)) {
            report.items.push(item("files", dir, "failed", "the copy does not match; original left in place"));
            continue;
        }
        let detail = if empty_target { format!("{count} file(s) copied") } else { format!("{count} file(s) merged; files already in the data folder were kept") };
        report.items.push(item("files", dir, "migrated", detail));
        let _ = mover.retire(dir, &files_target.display().to_string());
    }

    if mover.used {
        report.backup = Some(mover.backup_root.display().to_string());
    }
    if !report.items.is_empty() {
        save_report(&root, &report);
    }
    report
}

/// Files under `from` with no file of the same relative path under `to`.
fn missing_files(from: &Path, to: &Path) -> Vec<PathBuf> {
    let mut missing = Vec::new();
    if let Ok(entries) = std::fs::read_dir(from) {
        for entry in entries.flatten() {
            let path = entry.path();
            let target = to.join(entry.file_name());
            if path.is_dir() {
                missing.extend(missing_files(&path, &target));
            } else if !target.is_file() {
                missing.push(path);
            }
        }
    }
    missing
}

/// The value as the store gives it back (macros gain `version: 1` when missing).
fn same_data(name: &str, back: &Value, legacy: &Value) -> bool {
    if back == legacy {
        return true;
    }
    if name == "macros" {
        let mut expected = legacy.clone();
        if let Some(obj) = expected.as_object_mut() {
            obj.entry("version").or_insert(Value::from(1));
        }
        return back == &expected;
    }
    false
}

fn count(value: &Value) -> usize {
    match value {
        Value::Array(list) => list.len(),
        Value::Object(map) => map.get("tabs").or_else(|| map.get("macros")).and_then(Value::as_array).map(Vec::len).unwrap_or(map.len()),
        _ => 0,
    }
}

#[cfg(unix)]
fn restrict(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}
#[cfg(not(unix))]
fn restrict(_path: &Path) {}

const REPORT_FILE: &str = "migration.json";
const REPORT_KEEP: usize = 10;

fn save_report(root: &Path, report: &Report) {
    let path = root.join("config").join(REPORT_FILE);
    let mut runs: Vec<Value> = std::fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v.get("runs").and_then(Value::as_array).cloned())
        .unwrap_or_default();
    runs.push(serde_json::to_value(report).unwrap_or(Value::Null));
    if runs.len() > REPORT_KEEP {
        runs.drain(..runs.len() - REPORT_KEEP);
    }
    let body = serde_json::json!({ "version": 1, "runs": runs });
    if let Ok(bytes) = serde_json::to_vec_pretty(&body) {
        let _ = write_atomic(&path, &bytes);
    }
}

/// The most recent migration run, for Settings.
pub fn last_report(root: &Path) -> Option<Value> {
    let bytes = std::fs::read(root.join("config").join(REPORT_FILE)).ok()?;
    let body: Value = serde_json::from_slice(&bytes).ok()?;
    body.get("runs")?.as_array()?.last().cloned()
}

/// Detect and migrate at startup, logging the outcome.
pub fn run_at_startup() {
    let store = crate::shared_store::store();
    let sources = detect(store.root());
    if sources.store_dirs.is_empty() && sources.auth_files.is_empty() && sources.files_dirs.is_empty() && sources.wireless_files.is_empty() {
        return;
    }
    let report = run(store, &sources);
    for entry in &report.items {
        if entry.action == "failed" {
            tracing::warn!(kind = %entry.kind, source = %entry.source, "migration: {}", entry.detail);
        } else {
            tracing::info!(kind = %entry.kind, source = %entry.source, action = %entry.action, "migration: {}", entry.detail);
        }
    }
    if let Some(backup) = &report.backup {
        tracing::info!(%backup, "older data moved into the ADBoard data folder; originals kept in backups");
    }
    if report.failed() {
        tracing::warn!("some older data could not be moved and was left where it was; see Settings → Data");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("adboard-migrate-{name}-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn legacy_store(dir: &Path) {
        std::fs::create_dir_all(dir.join("history")).unwrap();
        let macros = json!({ "value": { "version": 1, "activeId": "t1", "tabs": [
            { "id": "t1", "name": "Daily Login", "reference": { "width": 900, "height": 1600 }, "steps": [] },
            { "id": "t2", "name": "Collect Rewards", "reference": { "width": 900, "height": 1600 }, "steps": [] }
        ] }, "rev": 7, "saved_at": 1 });
        let desk = json!({ "value": { "apps": [], "macros": [{ "id": "m1", "name": "Launch Game", "folder": "Games", "steps": [] }], "variables": {}, "deviceVariables": {}, "tags": {}, "groups": [], "profiles": {}, "history": [] }, "rev": 3 });
        std::fs::write(dir.join("macros.json"), serde_json::to_vec(&macros).unwrap()).unwrap();
        std::fs::write(dir.join("desk.json"), serde_json::to_vec(&desk).unwrap()).unwrap();
        std::fs::write(dir.join("history/macros.6.json"), serde_json::to_vec(&json!({ "value": { "tabs": [] }, "rev": 6 })).unwrap()).unwrap();
    }

    #[test]
    fn moves_old_store_files_and_account_into_the_data_folder() {
        let root = temp("root");
        let old = temp("old");
        let store_dir = old.join("adboard-data");
        legacy_store(&store_dir);
        let auth = old.join("rasiel-auth.json");
        let creds = json!({ "username": "ops", "salt": "00", "hash": "00", "iterations": 1 });
        std::fs::write(&auth, serde_json::to_vec(&creds).unwrap()).unwrap();
        let files = old.join("data").join("phonecontrol-files");
        std::fs::create_dir_all(files.join("APKs")).unwrap();
        std::fs::write(files.join("APKs").join("game.apk"), b"apk-bytes").unwrap();

        let store = SharedStore::new(root.clone());
        let sources = Sources { store_dirs: vec![store_dir.clone()], auth_files: vec![auth.clone()], files_dirs: vec![files.clone()], wireless_files: vec![] };
        let report = run(&store, &sources);
        assert!(!report.failed(), "{:?}", report.items);

        // Data is in the new layout, under descriptive file names.
        assert!(root.join("macros/Daily_Login.adboard-macro.json").is_file());
        assert!(root.join("macros/Collect_Rewards.adboard-macro.json").is_file());
        assert!(root.join("shell_scripts/Launch_Game.adboard-shell.json").is_file());
        assert_eq!(store.get("macros").unwrap().value["tabs"].as_array().unwrap().len(), 2);
        assert!(root.join("backups/history/macros.6.json").is_file(), "earlier versions kept");
        assert!(crate::web_auth::credentials_file_ok(&root.join("config/auth.json")));
        assert!(root.join("files/APKs/game.apk").is_file());

        // Originals moved into backups/legacy-*, notes left behind; nothing erased.
        let backup = PathBuf::from(report.backup.clone().unwrap());
        assert!(backup.starts_with(root.join("backups")));
        assert!(!store_dir.join("macros.json").exists());
        assert!(store_dir.join(NOTE).is_file());
        let kept: Vec<_> = std::fs::read_dir(&backup).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
        assert!(kept.iter().any(|n| n.ends_with("adboard-data")), "{kept:?}");
        assert!(kept.iter().any(|n| n.ends_with("rasiel-auth.json")), "{kept:?}");
        assert!(root.join("config/migration.json").is_file());

        // Running again finds nothing new to do and changes nothing.
        let again = run(&store, &Sources { store_dirs: vec![store_dir.clone()], ..Default::default() });
        assert!(again.items.is_empty(), "{:?}", again.items);
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(old);
    }

    #[test]
    fn never_overwrites_existing_data_and_leaves_unreadable_files() {
        let root = temp("root2");
        let old = temp("old2");
        let store = SharedStore::new(root.clone());
        store.put("macros", json!({ "version": 1, "activeId": null, "tabs": [{ "id": "n1", "name": "New", "reference": {}, "steps": [] }] }), 0).unwrap();
        let store_dir = old.join("adboard-data");
        legacy_store(&store_dir);
        std::fs::write(store_dir.join("macro-queue.json"), "{ broken").unwrap();

        let report = run(&store, &Sources { store_dirs: vec![store_dir.clone()], ..Default::default() });
        let macros = report.items.iter().find(|i| i.kind == "store:macros").unwrap();
        assert_eq!(macros.action, "kept-existing");
        assert_eq!(store.get("macros").unwrap().value["tabs"][0]["name"], "New", "existing data wins");
        assert!(report.items.iter().any(|i| i.kind == "store:macro-queue" && i.action == "failed"));
        // A failure anywhere in the folder: the original stays where it was.
        assert!(store_dir.join("macros.json").is_file());
        assert!(store_dir.join("macro-queue.json").is_file());
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(old);
    }

    #[test]
    fn labels_are_readable() {
        assert_eq!(label(Path::new("/repo/dist/windows/adboard-data")), "dist_windows_adboard-data");
    }
}
