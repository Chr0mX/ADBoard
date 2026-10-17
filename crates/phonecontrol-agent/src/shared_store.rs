//! Small shared JSON store, so every browser connected to this ADBoard sees
//! the same macros, Automate library, macro queue and schedules (they used to
//! live only in each browser's localStorage). One file per name in
//! `adboard-data/` next to the executable; writes are atomic and guarded by a
//! revision number so a stale browser never overwrites a newer copy.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// Names the UI may read and write.
pub const STORE_NAMES: &[&str] = &["macros", "desk", "macro-queue", "macro-schedules"];
/// Largest value accepted (bytes of JSON).
pub const MAX_STORE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StoredValue {
    pub value: Value,
    pub rev: u64,
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
            .unwrap_or(StoredValue { value: Value::Null, rev: 0 })
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
        let next = StoredValue { value, rev: current.rev + 1 };
        write_atomic(&self.path(name), &serde_json::to_vec(&next).map_err(|e| PutError::Io(e.to_string()))?)
            .map_err(PutError::Io)?;
        let rev = next.rev;
        cache.insert(name.to_string(), next);
        Ok(rev)
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
    if let Ok(dir) = std::env::var("PHONECONTROL_DATA_DIR") {
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
        assert_eq!(empty, StoredValue { value: Value::Null, rev: 0 });

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
        assert_eq!(reopened.get("macros").unwrap(), StoredValue { value: json!({"tabs": [1, 2]}), rev: 2 });
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
}
