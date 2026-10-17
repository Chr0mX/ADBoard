//! The shared store: touch macros, Shell Automation scripts, automation
//! settings and saved preferences, kept in the ADBoard data folder
//! (`data_dir`) so every browser sees the same copy and nothing depends on
//! where ADBoard was started from.
//!
//! The browser API is name-based (`/api/store/{name}`, a revision number per
//! name, 409 on a stale write). On disk:
//!
//! - `macros` → one `macros/<Name>.adboard-macro.json` per touch macro (the
//!   same format as an exported macro) plus `macros/_workspace.json` (order,
//!   active tab).
//! - `desk` → one `shell_scripts/<Name>.adboard-shell.json` per Shell
//!   Automation script, `shell_scripts/_library.json` (apps, variables,
//!   groups, tags, profiles) and `logs/shell_run_history.json` (runs).
//! - everything else → one plain JSON file in `config/`.
//!
//! File names come from display names (`data_dir::safe_file_stem`), unique
//! case-insensitively. Renaming an item renames its file; a deleted item's
//! file moves to `backups/deleted/`. Earlier revisions are kept in
//! `backups/history/`. A file that can't be read is moved or copied to
//! `backups/corrupt/` and reported as a warning instead of being dropped.
//! Revisions live in `config/.revisions.json`; a file changed by hand while
//! ADBoard was closed gets a new revision at load so browsers pick it up.

use crate::data_dir::{safe_file_stem, stamp, unique_stem};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// Names the UI may read and write.
pub const STORE_NAMES: &[&str] = &[
    "macros",
    "desk",
    "macro-queue",
    "macro-schedules",
    "macro-assignments",
    "user-config",
    "browser-state",
    "builder-state",
];
/// Largest value accepted (bytes of JSON).
pub const MAX_STORE_BYTES: usize = 8 * 1024 * 1024;
/// Earlier revisions kept per name in `backups/history/`, so an overwrite can be undone.
pub const HISTORY_LIMIT: usize = 20;

pub const MACRO_EXT: &str = ".adboard-macro.json";
pub const SHELL_EXT: &str = ".adboard-shell.json";
pub const MACRO_FORMAT: &str = "adboard-macros";
pub const SHELL_FORMAT: &str = "adboard-shell-script";

/// One kept revision (listed without its value).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub rev: u64,
    pub saved_at: u64,
    /// Tabs in a macro workspace, or items in a list.
    pub items: usize,
}

fn count_items(value: &Value) -> usize {
    match value {
        Value::Array(list) => list.len(),
        Value::Object(map) => map
            .get("tabs")
            .or_else(|| map.get("macros"))
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(map.len()),
        _ => 0,
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StoredValue {
    pub value: Value,
    pub rev: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub saved_at: Option<u64>,
    /// Problems found reading the files (e.g. a corrupt file set aside).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

impl StoredValue {
    pub fn empty() -> Self {
        Self { value: Value::Null, rev: 0, saved_at: None, warnings: Vec::new() }
    }
}

#[derive(Debug, PartialEq)]
pub enum PutError {
    UnknownName,
    TooLarge,
    /// The caller's base revision is stale: here is the current copy.
    Conflict(StoredValue),
    Io(String),
}

pub fn valid_name(name: &str) -> bool {
    STORE_NAMES.contains(&name)
}

/* ------------------------------ layout ------------------------------ */

#[derive(Clone, Copy, PartialEq)]
enum ItemsKind {
    Macros,
    Desk,
}

impl ItemsKind {
    fn dir(self) -> &'static str {
        match self {
            ItemsKind::Macros => "macros",
            ItemsKind::Desk => "shell_scripts",
        }
    }
    fn ext(self) -> &'static str {
        match self {
            ItemsKind::Macros => MACRO_EXT,
            ItemsKind::Desk => SHELL_EXT,
        }
    }
    fn index(self) -> &'static str {
        match self {
            ItemsKind::Macros => "_workspace.json",
            ItemsKind::Desk => "_library.json",
        }
    }
    fn list_key(self) -> &'static str {
        match self {
            ItemsKind::Macros => "tabs",
            ItemsKind::Desk => "macros",
        }
    }
    fn fallback(self) -> &'static str {
        match self {
            ItemsKind::Macros => "Untitled_macro",
            ItemsKind::Desk => "Untitled_script",
        }
    }
    /// The file body for one item (the same format as its export).
    fn wrap(self, item: &Value) -> Value {
        match self {
            ItemsKind::Macros => json!({ "format": MACRO_FORMAT, "version": 1, "app": "ADBoard", "tabs": [item] }),
            ItemsKind::Desk => json!({ "format": SHELL_FORMAT, "version": 1, "app": "ADBoard", "script": item }),
        }
    }
    /// Items in a file: its own format, or a bare item.
    fn unwrap(self, body: Value) -> Result<Vec<Value>, String> {
        let Value::Object(map) = body else { return Err("not a JSON object".into()) };
        match self {
            ItemsKind::Macros => {
                if map.get("format").and_then(Value::as_str) == Some(MACRO_FORMAT) {
                    match map.get("tabs") {
                        Some(Value::Array(tabs)) if !tabs.is_empty() => Ok(tabs.clone()),
                        _ => Err("macro file has no tabs".into()),
                    }
                } else if map.contains_key("steps") && map.contains_key("reference") {
                    Ok(vec![Value::Object(map)])
                } else {
                    Err("not a touch macro file".into())
                }
            }
            ItemsKind::Desk => {
                if map.get("format").and_then(Value::as_str) == Some(SHELL_FORMAT) {
                    match map.get("script") {
                        Some(script @ Value::Object(_)) => Ok(vec![script.clone()]),
                        _ => Err("script file has no script".into()),
                    }
                } else if map.get("name").map(Value::is_string) == Some(true) && map.get("steps").map(Value::is_array) == Some(true) {
                    Ok(vec![Value::Object(map)])
                } else {
                    Err("not a Shell Automation script file".into())
                }
            }
        }
    }
}

#[derive(Clone, Copy)]
enum Layout {
    Items(ItemsKind),
    File(&'static str),
}

fn layout(name: &str) -> Option<Layout> {
    Some(match name {
        "macros" => Layout::Items(ItemsKind::Macros),
        "desk" => Layout::Items(ItemsKind::Desk),
        "macro-queue" => Layout::File("macro_queue.json"),
        "macro-schedules" => Layout::File("macro_schedules.json"),
        "macro-assignments" => Layout::File("macro_assignments.json"),
        "user-config" => Layout::File("user_config.json"),
        "browser-state" => Layout::File("browser_state.json"),
        "builder-state" => Layout::File("builder_state.json"),
        _ => return None,
    })
}

const DESK_HISTORY_FILE: &str = "shell_run_history.json";
const REVISIONS_FILE: &str = ".revisions.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RevInfo {
    rev: u64,
    #[serde(default)]
    saved_at: Option<u64>,
    #[serde(default)]
    hash: String,
}

struct Entry {
    stored: StoredValue,
    /// Item id → its file name (item layouts).
    files: HashMap<String, String>,
    /// Files read at load that held several items (e.g. a dropped export);
    /// set aside once their items are written to their own files.
    absorbed: Vec<String>,
}

struct State {
    cache: HashMap<String, Entry>,
    revisions: Option<HashMap<String, RevInfo>>,
}

pub struct SharedStore {
    root: PathBuf,
    state: Mutex<State>,
}

fn value_hash(value: &Value) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    serde_json::to_string(value).unwrap_or_default().hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn read_json(path: &Path) -> Result<Option<Value>, String> {
    match std::fs::read(path) {
        Ok(bytes) => {
            let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
            serde_json::from_slice(bytes).map(Some).map_err(|e| e.to_string())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn pretty(value: &Value) -> Result<Vec<u8>, String> {
    let mut bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    Ok(bytes)
}

pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("cannot replace {}: {e}", path.display()))
}

impl SharedStore {
    /// A store rooted at the ADBoard data folder (`data_dir::root()` in production).
    pub fn new(root: PathBuf) -> Self {
        Self { root, state: Mutex::new(State { cache: HashMap::new(), revisions: None }) }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn sub(&self, dir: &str) -> PathBuf {
        self.root.join(dir)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /* ---------------------------- revisions ---------------------------- */

    fn revisions<'a>(&self, state: &'a mut State) -> &'a mut HashMap<String, RevInfo> {
        if state.revisions.is_none() {
            let path = self.sub("config").join(REVISIONS_FILE);
            let loaded = match read_json(&path) {
                Ok(Some(value)) => serde_json::from_value(value).unwrap_or_default(),
                Ok(None) => HashMap::new(),
                Err(error) => {
                    tracing::warn!(path = %path.display(), %error, "revision list unreadable; starting it again");
                    HashMap::new()
                }
            };
            state.revisions = Some(loaded);
        }
        state.revisions.as_mut().expect("loaded")
    }

    fn save_revisions(&self, state: &mut State) {
        let revisions = self.revisions(state).clone();
        let path = self.sub("config").join(REVISIONS_FILE);
        if let Ok(bytes) = serde_json::to_vec_pretty(&revisions) {
            if let Err(error) = write_atomic(&path, &bytes) {
                tracing::warn!(%error, "could not save the revision list");
            }
        }
    }

    /* ---------------------------- quarantine ---------------------------- */

    /// Keep an unreadable file in `backups/corrupt/` (moved, or copied when
    /// the original will be rewritten anyway). Returns a warning for the UI.
    fn quarantine(&self, path: &Path, error: &str, move_it: bool) -> String {
        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let target = self.sub("backups").join("corrupt").join(format!("{name}.{}", stamp()));
        let _ = std::fs::create_dir_all(target.parent().expect("parent"));
        let kept = if move_it { std::fs::rename(path, &target) } else { std::fs::copy(path, &target).map(|_| ()) };
        let shown = target.strip_prefix(&self.root).unwrap_or(&target).display().to_string();
        let message = match kept {
            Ok(()) => format!("{name} could not be read ({error}); a copy is in {shown}"),
            Err(e) => format!("{name} could not be read ({error}) and could not be copied aside ({e})"),
        };
        tracing::warn!("{message}");
        message
    }

    /* ------------------------------ load ------------------------------ */

    fn load(&self, name: &str) -> Entry {
        let mut warnings = Vec::new();
        let mut files = HashMap::new();
        let mut absorbed = Vec::new();
        let value = match layout(name) {
            None => Value::Null,
            Some(Layout::File(file)) => {
                let path = self.sub("config").join(file);
                match read_json(&path) {
                    Ok(Some(value)) => value,
                    Ok(None) => Value::Null,
                    Err(error) => {
                        warnings.push(self.quarantine(&path, &error, false));
                        Value::Null
                    }
                }
            }
            Some(Layout::Items(kind)) => self.load_items(kind, &mut files, &mut absorbed, &mut warnings),
        };
        Entry { stored: StoredValue { value, rev: 0, saved_at: None, warnings }, files, absorbed }
    }

    fn load_items(&self, kind: ItemsKind, files: &mut HashMap<String, String>, absorbed: &mut Vec<String>, warnings: &mut Vec<String>) -> Value {
        let dir = self.sub(kind.dir());
        let index_path = dir.join(kind.index());
        let index = match read_json(&index_path) {
            Ok(Some(Value::Object(map))) => Some(map),
            Ok(Some(_)) => {
                warnings.push(self.quarantine(&index_path, "not a JSON object", false));
                None
            }
            Ok(None) => None,
            Err(error) => {
                warnings.push(self.quarantine(&index_path, &error, false));
                None
            }
        };
        let history = if kind == ItemsKind::Desk {
            let path = self.sub("logs").join(DESK_HISTORY_FILE);
            match read_json(&path) {
                Ok(value) => value,
                Err(error) => {
                    warnings.push(self.quarantine(&path, &error, false));
                    None
                }
            }
        } else {
            None
        };

        // Files on disk with this kind's extension.
        let mut on_disk: Vec<String> = std::fs::read_dir(&dir)
            .map(|entries| {
                entries
                    .flatten()
                    .filter(|e| e.path().is_file())
                    .map(|e| e.file_name().to_string_lossy().to_string())
                    .filter(|n| n.to_lowercase().ends_with(kind.ext()))
                    .collect()
            })
            .unwrap_or_default();
        on_disk.sort();
        let listed: Vec<String> = index
            .as_ref()
            .and_then(|m| m.get("items"))
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(|i| i.get("file").and_then(Value::as_str).map(str::to_string)).collect())
            .unwrap_or_default();
        let mut order: Vec<String> = Vec::new();
        for file in &listed {
            if on_disk.contains(file) {
                order.push(file.clone());
            } else {
                warnings.push(format!("{} is listed in {} but the file is missing", file, kind.index()));
            }
        }
        // Files added by hand (or not yet listed) come after, by name.
        order.extend(on_disk.iter().filter(|f| !listed.contains(f)).cloned());

        if index.is_none() && order.is_empty() && history.is_none() {
            return Value::Null;
        }
        let mut items = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        for file in order {
            let path = dir.join(&file);
            let parsed = read_json(&path).and_then(|v| v.ok_or_else(|| "file vanished".to_string())).and_then(|v| kind.unwrap(v));
            match parsed {
                Ok(found) => {
                    let single = found.len() == 1;
                    for mut item in found {
                        let Some(obj) = item.as_object_mut() else { continue };
                        let mut id = obj.get("id").and_then(Value::as_str).map(str::to_string).unwrap_or_default();
                        if id.is_empty() || seen.contains(&id) {
                            if !id.is_empty() {
                                warnings.push(format!("{file}: a second item with id {id} was given a new id"));
                            }
                            id = format!("{}-{}", if kind == ItemsKind::Macros { "tab" } else { "macro" }, uuid::Uuid::new_v4());
                            obj.insert("id".into(), Value::String(id.clone()));
                        }
                        seen.insert(id.clone());
                        if single {
                            files.insert(id, file.clone());
                        }
                        items.push(item);
                    }
                    if !single {
                        absorbed.push(file.clone());
                    }
                }
                Err(error) => warnings.push(self.quarantine(&path, &error, true)),
            }
        }
        let mut value = index.unwrap_or_default();
        value.remove("items");
        if kind == ItemsKind::Macros && !value.contains_key("version") {
            value.insert("version".into(), json!(1));
        }
        value.insert(kind.list_key().into(), Value::Array(items));
        if let Some(history) = history {
            value.insert("history".into(), history);
        }
        Value::Object(value)
    }

    /// Load `name` into the cache if needed and give it a revision.
    fn ensure<'a>(&self, state: &'a mut State, name: &str) -> &'a mut Entry {
        if !state.cache.contains_key(name) {
            let mut entry = self.load(name);
            let hash = value_hash(&entry.stored.value);
            let null = entry.stored.value.is_null();
            let revisions = self.revisions(state);
            let known = revisions.get(name).cloned();
            let mut changed = false;
            match known {
                Some(info) if info.hash == hash => {
                    entry.stored.rev = info.rev;
                    entry.stored.saved_at = info.saved_at;
                }
                // Changed on disk since ADBoard last wrote it (hand edit,
                // migration, restore from a backup): a new revision.
                Some(info) => {
                    entry.stored.rev = info.rev + 1;
                    entry.stored.saved_at = Some(now_ms());
                    changed = true;
                }
                None if null => {}
                None => {
                    entry.stored.rev = 1;
                    entry.stored.saved_at = Some(now_ms());
                    changed = true;
                }
            }
            if changed {
                revisions.insert(name.to_string(), RevInfo { rev: entry.stored.rev, saved_at: entry.stored.saved_at, hash });
                self.save_revisions(state);
            }
            state.cache.insert(name.to_string(), entry);
        }
        state.cache.get_mut(name).expect("cached")
    }

    /// Current copy (`value` is null and `rev` 0 when nothing was saved yet).
    pub fn get(&self, name: &str) -> Option<StoredValue> {
        if !valid_name(name) {
            return None;
        }
        let mut state = self.lock();
        Some(self.ensure(&mut state, name).stored.clone())
    }

    /// Save `value` if `base_rev` is the current revision. Returns the new rev.
    pub fn put(&self, name: &str, value: Value, base_rev: u64) -> Result<u64, PutError> {
        if !valid_name(name) {
            return Err(PutError::UnknownName);
        }
        let size = serde_json::to_vec(&value).map_err(|e| PutError::Io(e.to_string()))?.len();
        if size > MAX_STORE_BYTES {
            return Err(PutError::TooLarge);
        }
        let mut state = self.lock();
        let entry = self.ensure(&mut state, name);
        if entry.stored.rev != base_rev {
            return Err(PutError::Conflict(entry.stored.clone()));
        }
        // Keep the copy being replaced, so it can be restored.
        let previous = entry.stored.clone();
        let mut files = entry.files.clone();
        let mut absorbed = entry.absorbed.clone();
        if previous.rev > 0 && !previous.value.is_null() {
            self.keep_history(name, &previous);
        }
        match layout(name).expect("valid name") {
            Layout::File(file) => {
                let bytes = pretty(&value).map_err(PutError::Io)?;
                write_atomic(&self.sub("config").join(file), &bytes).map_err(PutError::Io)?;
            }
            Layout::Items(kind) => self.write_items(kind, &value, &mut files, &mut absorbed).map_err(PutError::Io)?,
        }
        let rev = previous.rev + 1;
        let saved_at = Some(now_ms());
        let hash = value_hash(&value);
        let entry = state.cache.get_mut(name).expect("cached");
        entry.stored = StoredValue { value, rev, saved_at, warnings: previous.warnings };
        entry.files = files;
        entry.absorbed = absorbed;
        self.revisions(&mut state).insert(name.to_string(), RevInfo { rev, saved_at, hash });
        self.save_revisions(&mut state);
        Ok(rev)
    }

    fn write_items(&self, kind: ItemsKind, value: &Value, files: &mut HashMap<String, String>, absorbed: &mut Vec<String>) -> Result<(), String> {
        let Value::Object(obj) = value else {
            return Err(format!("{} must be a JSON object", kind.dir()));
        };
        let dir = self.sub(kind.dir());
        std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
        let items: Vec<Value> = obj.get(kind.list_key()).and_then(Value::as_array).cloned().unwrap_or_default();
        let ext = kind.ext();
        let key_of = |index: usize, item: &Value| item.get("id").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| format!("#{index}"));
        let stem_of = |item: &Value| safe_file_stem(item.get("name").and_then(Value::as_str).unwrap_or(""), kind.fallback());

        // Pass 1: an item keeps its file when the name still matches it
        // (`Name` or a de-duplicated `Name_2`), so files don't churn.
        let mut taken: HashSet<String> = HashSet::new();
        let mut chosen: Vec<Option<String>> = vec![None; items.len()];
        for (i, item) in items.iter().enumerate() {
            let stem = stem_of(item);
            if let Some(file) = files.get(&key_of(i, item)) {
                let current = file.strip_suffix(ext).unwrap_or(file);
                let still_matches = current.eq_ignore_ascii_case(&stem)
                    || current
                        .to_lowercase()
                        .strip_prefix(&format!("{}_", stem.to_lowercase()))
                        .is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()));
                if still_matches && taken.insert(current.to_lowercase()) {
                    chosen[i] = Some(file.clone());
                }
            }
        }
        // Pass 2: new and renamed items get a free name.
        for (i, item) in items.iter().enumerate() {
            if chosen[i].is_none() {
                let stem = unique_stem(&stem_of(item), &taken);
                taken.insert(stem.to_lowercase());
                chosen[i] = Some(format!("{stem}{ext}"));
            }
        }
        let mut new_files: HashMap<String, String> = HashMap::new();
        let mut index_items = Vec::new();
        for (i, item) in items.iter().enumerate() {
            let file = chosen[i].clone().expect("chosen");
            let path = dir.join(&file);
            let bytes = pretty(&kind.wrap(item))?;
            if std::fs::read(&path).ok().as_deref() != Some(bytes.as_slice()) {
                write_atomic(&path, &bytes)?;
            }
            let key = key_of(i, item);
            index_items.push(json!({ "id": key, "file": file }));
            new_files.insert(key, file);
        }
        // Files no longer used: renamed items' old files go (their content is
        // in the new file); deleted items' files move to backups/deleted.
        let in_use: HashSet<String> = new_files.values().map(|f| f.to_lowercase()).collect();
        let still_present: HashSet<&String> = new_files.keys().collect();
        for (key, file) in files.iter() {
            if in_use.contains(&file.to_lowercase()) {
                continue;
            }
            let path = dir.join(file);
            if !path.exists() {
                continue;
            }
            if still_present.contains(key) {
                let _ = std::fs::remove_file(&path);
            } else {
                self.set_aside(&path, "deleted");
            }
        }
        for file in absorbed.drain(..) {
            let path = dir.join(&file);
            if path.exists() && !in_use.contains(&file.to_lowercase()) {
                self.set_aside(&path, "deleted");
            }
        }
        *files = new_files;

        let mut index: Map<String, Value> = obj.clone();
        index.remove(kind.list_key());
        let history = index.remove("history");
        index.insert("items".into(), Value::Array(index_items));
        write_atomic(&dir.join(kind.index()), &pretty(&Value::Object(index))?)?;
        if kind == ItemsKind::Desk {
            if let Some(history) = history {
                write_atomic(&self.sub("logs").join(DESK_HISTORY_FILE), &pretty(&history)?)?;
            }
        }
        Ok(())
    }

    /// Move a file into `backups/<kind>/` with a time stamp (never erased).
    fn set_aside(&self, path: &Path, kind: &str) {
        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let target = self.sub("backups").join(kind).join(format!("{}.{name}", stamp()));
        let _ = std::fs::create_dir_all(target.parent().expect("parent"));
        if let Err(error) = std::fs::rename(path, &target) {
            tracing::warn!(path = %path.display(), %error, "could not move file to backups");
        }
    }

    /// Which file holds each item of `name` (id → file name), for the UI.
    pub fn item_files(&self, name: &str) -> HashMap<String, String> {
        if !valid_name(name) {
            return HashMap::new();
        }
        let mut state = self.lock();
        self.ensure(&mut state, name).files.clone()
    }
}

/* ------------------------------ history ------------------------------ */

impl SharedStore {
    fn history_dir(&self) -> PathBuf {
        self.sub("backups").join("history")
    }

    fn keep_history(&self, name: &str, entry: &StoredValue) {
        let dir = self.history_dir();
        let kept = StoredValue { warnings: Vec::new(), ..entry.clone() };
        if let Ok(bytes) = serde_json::to_vec(&kept) {
            let _ = write_atomic(&dir.join(format!("{name}.{}.json", entry.rev)), &bytes);
        }
        let mut revs = self.history_revs(name);
        revs.sort_unstable();
        while revs.len() > HISTORY_LIMIT {
            let old = revs.remove(0);
            let _ = std::fs::remove_file(dir.join(format!("{name}.{old}.json")));
        }
    }

    fn history_revs(&self, name: &str) -> Vec<u64> {
        let prefix = format!("{name}.");
        std::fs::read_dir(self.history_dir())
            .map(|entries| {
                entries
                    .filter_map(|e| e.ok())
                    .filter_map(|e| {
                        let file = e.file_name().to_string_lossy().to_string();
                        file.strip_prefix(&prefix)?.strip_suffix(".json")?.parse::<u64>().ok()
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    fn history_value(&self, name: &str, rev: u64) -> Option<StoredValue> {
        let bytes = std::fs::read(self.history_dir().join(format!("{name}.{rev}.json"))).ok()?;
        serde_json::from_slice(&bytes).ok()
    }

    /// Earlier revisions, newest first.
    pub fn history(&self, name: &str) -> Option<Vec<HistoryEntry>> {
        if !valid_name(name) {
            return None;
        }
        let mut revs = self.history_revs(name);
        revs.sort_unstable_by(|a, b| b.cmp(a));
        Some(
            revs.into_iter()
                .filter_map(|rev| self.history_value(name, rev))
                .map(|v| HistoryEntry { rev: v.rev, saved_at: v.saved_at.unwrap_or(0), items: count_items(&v.value) })
                .collect(),
        )
    }

    /// Put an earlier revision back as a new revision (itself undoable).
    pub fn restore(&self, name: &str, rev: u64) -> Result<u64, PutError> {
        if !valid_name(name) {
            return Err(PutError::UnknownName);
        }
        let old = self.history_value(name, rev).ok_or_else(|| PutError::Io(format!("revision {rev} is not kept")))?;
        let current = self.get(name).map(|c| c.rev).unwrap_or(0);
        self.put(name, old.value, current)
    }
}

/* ------------------------------ backups ------------------------------ */

/// Copy a folder tree (files only; existing targets are kept).
pub fn copy_tree(from: &Path, to: &Path) -> Result<u64, String> {
    let mut count = 0;
    std::fs::create_dir_all(to).map_err(|e| format!("cannot create {}: {e}", to.display()))?;
    for entry in std::fs::read_dir(from).map_err(|e| format!("cannot read {}: {e}", from.display()))?.flatten() {
        let path = entry.path();
        let target = to.join(entry.file_name());
        if path.is_dir() {
            count += copy_tree(&path, &target)?;
        } else if path.is_file() && !target.exists() {
            std::fs::copy(&path, &target).map_err(|e| format!("cannot copy {}: {e}", path.display()))?;
            count += 1;
        }
    }
    Ok(count)
}

impl SharedStore {
    /// Back up macros, scripts, settings and logs to `backups/backup-<date>/`.
    pub fn backup_now(&self) -> Result<(PathBuf, u64), String> {
        let _guard = self.lock();
        let target = self.sub("backups").join(format!("backup-{}", stamp()));
        let mut count = 0;
        for dir in ["macros", "shell_scripts", "config", "logs"] {
            let from = self.sub(dir);
            if from.is_dir() {
                count += copy_tree(&from, &target.join(dir))?;
            }
        }
        Ok((target, count))
    }
}

/// The process-wide store, in the ADBoard data folder.
pub fn store() -> &'static SharedStore {
    static STORE: OnceLock<SharedStore> = OnceLock::new();
    STORE.get_or_init(|| SharedStore::new(crate::data_dir::root().path.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store() -> (SharedStore, PathBuf) {
        let dir = std::env::temp_dir().join(format!("adboard-store-test-{}", uuid::Uuid::new_v4()));
        (SharedStore::new(dir.clone()), dir)
    }

    fn tab(id: &str, name: &str) -> Value {
        json!({ "id": id, "name": name, "reference": { "width": 900, "height": 1600 }, "steps": [] })
    }

    fn workspace(tabs: Vec<Value>) -> Value {
        json!({ "version": 1, "activeId": tabs.first().and_then(|t| t.get("id")).cloned().unwrap_or(Value::Null), "tabs": tabs })
    }

    fn files_in(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .map(|e| e.flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect())
            .unwrap_or_default();
        names.sort();
        names
    }

    #[test]
    fn whitelist_round_trip_and_conflict() {
        let (store, dir) = temp_store();
        assert!(store.get("passwords").is_none());
        assert_eq!(store.put("passwords", json!(1), 0), Err(PutError::UnknownName));
        assert_eq!(store.get("macro-queue").unwrap(), StoredValue::empty());

        assert_eq!(store.put("macro-queue", json!([{ "id": "q1", "tabId": "t" }]), 0), Ok(1));
        // A stale writer gets the current copy back instead of overwriting it.
        match store.put("macro-queue", json!([]), 0) {
            Err(PutError::Conflict(current)) => assert_eq!(current.rev, 1),
            other => panic!("expected conflict, got {other:?}"),
        }
        assert_eq!(store.put("macro-queue", json!([{ "id": "q2" }]), 1), Ok(2));
        // Plain, hand-editable file in config/; survives a restart.
        let text = std::fs::read_to_string(dir.join("config/macro_queue.json")).unwrap();
        assert!(text.contains("\"q2\""), "{text}");
        let reopened = SharedStore::new(dir.clone());
        let back = reopened.get("macro-queue").unwrap();
        assert_eq!((back.value, back.rev), (json!([{ "id": "q2" }]), 2));
        assert!(!dir.join("config/macro_queue.tmp").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_oversized_values() {
        let (store, dir) = temp_store();
        let big = Value::String("x".repeat(MAX_STORE_BYTES + 1));
        assert_eq!(store.put("user-config", big, 0), Err(PutError::TooLarge));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn macros_are_one_named_file_each_and_rename_delete_are_safe() {
        let (store, dir) = temp_store();
        let mdir = dir.join("macros");
        store.put("macros", workspace(vec![tab("t1", "Daily Login"), tab("t2", "Collect:Rewards?")]), 0).unwrap();
        assert_eq!(files_in(&mdir), vec!["Collect_Rewards_.adboard-macro.json", "Daily_Login.adboard-macro.json", "_workspace.json"]);
        // Each file is a normal macro export (importable as is).
        let body: Value = serde_json::from_slice(&std::fs::read(mdir.join("Daily_Login.adboard-macro.json")).unwrap()).unwrap();
        assert_eq!(body["format"], MACRO_FORMAT);
        assert_eq!(body["tabs"][0]["name"], "Daily Login");
        // Same name twice → _2; rename moves the file, keeps the id.
        store.put("macros", workspace(vec![tab("t1", "Morning"), tab("t2", "Collect:Rewards?"), tab("t3", "Morning")]), 1).unwrap();
        assert_eq!(
            files_in(&mdir),
            vec!["Collect_Rewards_.adboard-macro.json", "Morning.adboard-macro.json", "Morning_2.adboard-macro.json", "_workspace.json"]
        );
        // Delete: the file goes to backups/deleted, nothing is erased.
        store.put("macros", workspace(vec![tab("t1", "Morning")]), 2).unwrap();
        assert_eq!(files_in(&mdir), vec!["Morning.adboard-macro.json", "_workspace.json"]);
        let deleted = files_in(&dir.join("backups/deleted"));
        assert_eq!(deleted.len(), 2, "{deleted:?}");
        // Round trip after a restart: same value, same order.
        let reopened = SharedStore::new(dir.clone());
        let back = reopened.get("macros").unwrap();
        assert_eq!(back.value, workspace(vec![tab("t1", "Morning")]));
        assert_eq!(back.rev, 3);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn shell_scripts_library_and_run_history_are_split() {
        let (store, dir) = temp_store();
        let desk = json!({
            "apps": [], "variables": { "USER": "farm01" }, "deviceVariables": {}, "tags": {}, "groups": [], "profiles": {},
            "macros": [
                { "id": "m1", "name": "Daily Device Setup", "folder": "Custom", "steps": [{ "id": "s1", "kind": "wait", "ms": 100 }] },
                { "id": "m2", "name": "Launch_Game", "folder": "Games", "steps": [] }
            ],
            "history": [{ "id": "r1", "macroId": "m1", "macroName": "Daily Device Setup", "at": 1, "parallel": true, "results": [] }]
        });
        store.put("desk", desk.clone(), 0).unwrap();
        assert_eq!(
            files_in(&dir.join("shell_scripts")),
            vec!["Daily_Device_Setup.adboard-shell.json", "Launch_Game.adboard-shell.json", "_library.json"]
        );
        let script: Value = serde_json::from_slice(&std::fs::read(dir.join("shell_scripts/Launch_Game.adboard-shell.json")).unwrap()).unwrap();
        assert_eq!((script["format"].as_str(), script["script"]["id"].as_str()), (Some(SHELL_FORMAT), Some("m2")));
        assert!(dir.join("logs/shell_run_history.json").is_file());
        let library = std::fs::read_to_string(dir.join("shell_scripts/_library.json")).unwrap();
        assert!(library.contains("farm01") && !library.contains("Launch_Game\""), "{library}");
        assert_eq!(SharedStore::new(dir.clone()).get("desk").unwrap().value, desk);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn hand_edits_get_a_new_revision_and_dropped_files_are_picked_up() {
        let (store, dir) = temp_store();
        store.put("macros", workspace(vec![tab("t1", "A")]), 0).unwrap();
        store.put("user-config", json!({ "keyboard": "1" }), 0).unwrap();
        // While ADBoard is closed: edit a config file, drop in an exported file with two tabs.
        std::fs::write(dir.join("config/user_config.json"), r#"{ "keyboard": "0" }"#).unwrap();
        let export = json!({ "format": MACRO_FORMAT, "version": 1, "tabs": [tab("x1", "B"), tab("t1", "Dup id")] });
        std::fs::write(dir.join("macros/Shared.adboard-macro.json"), serde_json::to_vec(&export).unwrap()).unwrap();

        let reopened = SharedStore::new(dir.clone());
        let config = reopened.get("user-config").unwrap();
        assert_eq!((config.value, config.rev), (json!({ "keyboard": "0" }), 2));
        let macros = reopened.get("macros").unwrap();
        assert_eq!(macros.rev, 2);
        let names: Vec<&str> = macros.value["tabs"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, vec!["A", "B", "Dup id"]);
        assert!(macros.warnings.iter().any(|w| w.contains("new id")), "{:?}", macros.warnings);
        // Next save gives each tab its own file and sets the combined file aside.
        reopened.put("macros", macros.value.clone(), 2).unwrap();
        assert_eq!(
            files_in(&dir.join("macros")),
            vec!["A.adboard-macro.json", "B.adboard-macro.json", "Dup_id.adboard-macro.json", "_workspace.json"]
        );
        assert!(files_in(&dir.join("backups/deleted")).iter().any(|f| f.ends_with("Shared.adboard-macro.json")));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn corrupt_files_are_set_aside_with_a_warning() {
        let (store, dir) = temp_store();
        store.put("macros", workspace(vec![tab("t1", "Good")]), 0).unwrap();
        std::fs::write(dir.join("macros/Broken.adboard-macro.json"), "{ not json").unwrap();
        std::fs::write(dir.join("config/user_config.json"), "{ truncated").unwrap();
        let reopened = SharedStore::new(dir.clone());
        let macros = reopened.get("macros").unwrap();
        assert_eq!(macros.value["tabs"].as_array().unwrap().len(), 1);
        assert!(macros.warnings.iter().any(|w| w.contains("Broken.adboard-macro.json")), "{:?}", macros.warnings);
        let config = reopened.get("user-config").unwrap();
        assert_eq!(config.value, Value::Null, "defaults");
        assert_eq!(config.warnings.len(), 1);
        assert_eq!(files_in(&dir.join("backups/corrupt")).len(), 2);
        assert!(!dir.join("macros/Broken.adboard-macro.json").exists(), "moved out of the way");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn keeps_history_and_restores_an_overwritten_copy() {
        let (store, dir) = temp_store();
        // Real macros, then a starter overwrites them (the bug this guards against).
        store.put("macros", workspace(vec![tab("farm", "Farm"), tab("collect", "Collect")]), 0).unwrap();
        store.put("macros", workspace(vec![tab("tab-1", "Tab 1")]), 1).unwrap();
        let history = store.history("macros").unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!((history[0].rev, history[0].items), (1, 2));
        assert!(dir.join("backups/history/macros.1.json").is_file());
        let rev = store.restore("macros", 1).unwrap();
        assert_eq!(rev, 3);
        assert_eq!(store.get("macros").unwrap().value, workspace(vec![tab("farm", "Farm"), tab("collect", "Collect")]));
        assert!(store.history("macros").unwrap().iter().any(|h| h.rev == 2));
        for i in 0..(HISTORY_LIMIT as u64 + 5) {
            let current = store.get("macros").unwrap().rev;
            store.put("macros", workspace(vec![tab(&format!("t{i}"), &format!("T{i}"))]), current).unwrap();
        }
        assert_eq!(store.history("macros").unwrap().len(), HISTORY_LIMIT);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn backup_now_copies_everything_important() {
        let (store, dir) = temp_store();
        store.put("macros", workspace(vec![tab("t1", "A")]), 0).unwrap();
        store.put("user-config", json!({ "a": 1 }), 0).unwrap();
        let (target, count) = store.backup_now().unwrap();
        assert!(count >= 3, "{count}");
        assert!(target.join("macros/A.adboard-macro.json").is_file());
        assert!(target.join("config/user_config.json").is_file());
        let _ = std::fs::remove_dir_all(dir);
    }
}
