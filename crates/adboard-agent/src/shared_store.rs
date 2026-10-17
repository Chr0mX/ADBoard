//! Small shared JSON store, so every browser connected to this ADBoard sees
//! the same macros, Automate library, macro queue, schedules and per-phone
//! macro choices (they used to
//! live only in each browser's localStorage). One file per name in
//! `adboard-data/` next to the executable; writes are atomic and guarded by a
//! revision number so a stale browser never overwrites a newer copy.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// Names the UI may read and write.
pub const STORE_NAMES: &[&str] = &["macros", "desk", "macro-queue", "macro-schedules", "macro-assignments"];
/// Largest value accepted (bytes of JSON).
pub const MAX_STORE_BYTES: usize = 8 * 1024 * 1024;
/// Earlier revisions kept per name in `history/`, so an overwrite can be undone.
pub const HISTORY_LIMIT: usize = 20;

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
}

#[derive(Debug, PartialEq)]
pub enum PutError {
    UnknownName,
    TooLarge,
    /// The caller's base revision is stale: here is the current copy.
    Conflict(StoredValue),
    Io(String),
}

pub struct SharedStore {
    dir: PathBuf,
    /// Cached entries (also serialises writes per process).
    cache: Mutex<HashMap<String, StoredValue>>,
}

pub fn valid_name(name: &str) -> bool {
    STORE_NAMES.contains(&name)
}

impl SharedStore {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir, cache: Mutex::new(HashMap::new()) }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.join(format!("{name}.json"))
    }

    fn load(&self, name: &str) -> StoredValue {
        std::fs::read(self.path(name))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<StoredValue>(&bytes).ok())
            .unwrap_or(StoredValue { value: Value::Null, rev: 0, saved_at: None })
    }

    /// Current copy (`value` is null and `rev` 0 when nothing was saved yet).
    pub fn get(&self, name: &str) -> Option<StoredValue> {
        if !valid_name(name) {
            return None;
        }
        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(hit) = cache.get(name) {
            return Some(hit.clone());
        }
        let loaded = self.load(name);
        cache.insert(name.to_string(), loaded.clone());
        Some(loaded)
    }

    /// Save `value` if `base_rev` is the current revision. Returns the new rev.
    pub fn put(&self, name: &str, value: Value, base_rev: u64) -> Result<u64, PutError> {
        if !valid_name(name) {
            return Err(PutError::UnknownName);
        }
        let bytes = serde_json::to_vec(&value).map_err(|e| PutError::Io(e.to_string()))?;
        if bytes.len() > MAX_STORE_BYTES {
            return Err(PutError::TooLarge);
        }
        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        let current = cache.get(name).cloned().unwrap_or_else(|| self.load(name));
        if current.rev != base_rev {
            cache.insert(name.to_string(), current.clone());
            return Err(PutError::Conflict(current));
        }
        // Keep the copy being replaced, so it can be restored.
        if current.rev > 0 && !current.value.is_null() {
            self.keep_history(name, &current);
        }
        let next = StoredValue { value, rev: current.rev + 1, saved_at: Some(now_ms()) };
        write_atomic(&self.path(name), &serde_json::to_vec(&next).map_err(|e| PutError::Io(e.to_string()))?)
            .map_err(PutError::Io)?;
        let rev = next.rev;
        cache.insert(name.to_string(), next);
        Ok(rev)
    }
}

impl SharedStore {
    fn history_dir(&self) -> PathBuf {
        self.dir.join("history")
    }

    fn keep_history(&self, name: &str, entry: &StoredValue) {
        let dir = self.history_dir();
        if let Ok(bytes) = serde_json::to_vec(entry) {
            let _ = write_atomic(&dir.join(format!("{name}.{}.json", entry.rev)), &bytes);
        }
        // Drop the oldest beyond the limit.
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

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, bytes).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("cannot replace {}: {e}", path.display()))
}

fn data_dir() -> PathBuf {
    if let Ok(dir) = crate::env::var("DATA_DIR") {
        if !dir.trim().is_empty() {
            return PathBuf::from(dir);
        }
    }
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("adboard-data")))
        .unwrap_or_else(|| PathBuf::from("adboard-data"))
}

/// The process-wide store.
pub fn store() -> &'static SharedStore {
    static STORE: OnceLock<SharedStore> = OnceLock::new();
    STORE.get_or_init(|| SharedStore::new(data_dir()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_store() -> (SharedStore, PathBuf) {
        let dir = std::env::temp_dir().join(format!("adboard-store-test-{}", uuid::Uuid::new_v4()));
        (SharedStore::new(dir.clone()), dir)
    }

    #[test]
    fn whitelist_round_trip_and_conflict() {
        let (store, dir) = temp_store();
        assert!(store.get("passwords").is_none());
        assert_eq!(store.put("passwords", json!(1), 0), Err(PutError::UnknownName));

        let empty = store.get("macros").unwrap();
        assert_eq!(empty, StoredValue { value: Value::Null, rev: 0, saved_at: None });

        assert_eq!(store.put("macros", json!({"tabs": [1]}), 0), Ok(1));
        assert_eq!(store.get("macros").unwrap().value, json!({"tabs": [1]}));

        // A stale writer gets the current copy back instead of overwriting it.
        match store.put("macros", json!({"tabs": []}), 0) {
            Err(PutError::Conflict(current)) => {
                assert_eq!(current.rev, 1);
                assert_eq!(current.value, json!({"tabs": [1]}));
            }
            other => panic!("expected conflict, got {other:?}"),
        }
        assert_eq!(store.put("macros", json!({"tabs": [1, 2]}), 1), Ok(2));

        // Survives a restart (fresh store reading the same directory); no temp file left.
        let reopened = SharedStore::new(dir.clone());
        let back = reopened.get("macros").unwrap();
        assert_eq!((back.value, back.rev), (json!({"tabs": [1, 2]}), 2));
        assert!(!dir.join("macros.json.tmp").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_oversized_values() {
        let (store, dir) = temp_store();
        let big = Value::String("x".repeat(MAX_STORE_BYTES + 1));
        assert_eq!(store.put("desk", big, 0), Err(PutError::TooLarge));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn keeps_history_and_restores_an_overwritten_copy() {
        let (store, dir) = temp_store();
        // Real macros, then a starter overwrites them (the bug this guards against).
        store.put("macros", json!({"tabs": [{"id": "farm"}, {"id": "collect"}]}), 0).unwrap();
        store.put("macros", json!({"tabs": [{"id": "tab-1"}]}), 1).unwrap();
        let history = store.history("macros").unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!((history[0].rev, history[0].items), (1, 2));
        let rev = store.restore("macros", 1).unwrap();
        assert_eq!(rev, 3);
        assert_eq!(store.get("macros").unwrap().value, json!({"tabs": [{"id": "farm"}, {"id": "collect"}]}));
        // The restore is itself undoable.
        assert!(store.history("macros").unwrap().iter().any(|h| h.rev == 2));
        // Old revisions are pruned beyond the limit.
        for i in 0..(HISTORY_LIMIT as u64 + 5) {
            let current = store.get("macros").unwrap().rev;
            store.put("macros", json!({"tabs": [i]}), current).unwrap();
        }
        assert_eq!(store.history("macros").unwrap().len(), HISTORY_LIMIT);
        let _ = std::fs::remove_dir_all(dir);
    }
}
