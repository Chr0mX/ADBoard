//! Phone model names: maps an Android model code (`SM-S921B`) to its brand and
//! marketing name (`Samsung`, `Galaxy S24`).
//!
//! The database is the open `bsthen/device-models` JSON. It is downloaded with
//! `curl` and cached at `<data folder>/device/device-models.json`. The cache is read at startup and used whether it is fresh or
//! expired. A refresh runs in the background, at most once per 24 hours, and a
//! failed download never touches the cache. Device discovery never waits for it.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tracing::{debug, info, warn};

pub const SOURCE_URL: &str = "https://cdn.jsdelivr.net/gh/bsthen/device-models/devices.json";
/// Format of the cache file. Bump it when the layout changes; older files are ignored.
const SCHEMA_VERSION: u32 = 1;
/// A cache downloaded less than this long ago is fresh: it is used and not refreshed.
const FRESH_SECS: u64 = 24 * 60 * 60;
const FETCH_TIMEOUT_SECS: u64 = 20;
/// Largest download accepted (the dataset is about 3 MB).
const MAX_DOWNLOAD_BYTES: usize = 20 * 1024 * 1024;
/// A download or cache with fewer models than this is treated as broken.
const MIN_MODELS: usize = 1_000;
const CHECK_EVERY: Duration = Duration::from_secs(60 * 60);
const CACHE_FILE: &str = "device-models.json";

/// Brand and marketing name for one model code.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelName {
    pub brand: String,
    pub name: String,
}

/// The cache file: the model table plus the metadata needed to judge it later.
#[derive(Debug, Serialize, Deserialize)]
pub struct CacheFile {
    pub schema: u32,
    pub source: String,
    /// Unix seconds of the last successful download.
    pub fetched_at: u64,
    pub models: BTreeMap<String, ModelName>,
}

/// What the cache offers right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CacheState {
    /// Downloaded within the last 24 hours.
    Fresh,
    /// Usable, but older than 24 hours; a refresh is due.
    Expired,
    /// No usable cache; lookups return nothing until a download succeeds.
    Unavailable,
}

static DB: RwLock<Option<Arc<CacheFile>>> = RwLock::new(None);
/// When this process last tried to download (success or not).
static LAST_ATTEMPT: Mutex<Option<u64>> = Mutex::new(None);
/// Set while a download is running, so overlapping checks do not start a second one.
static IN_FLIGHT: AtomicBool = AtomicBool::new(false);

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Where the cache lives inside the ADBoard data folder.
pub fn cache_path(data_dir: &Path) -> PathBuf {
    data_dir.join("device").join(CACHE_FILE)
}

/// Fresh, expired or unavailable, judged against `now` (unix seconds).
pub fn state_at(file: Option<&CacheFile>, now: u64) -> CacheState {
    match file {
        None => CacheState::Unavailable,
        Some(file) if now.saturating_sub(file.fetched_at) < FRESH_SECS => CacheState::Fresh,
        Some(_) => CacheState::Expired,
    }
}

/// A download is attempted only when the cache is not fresh, and at most once per
/// 24 hours per process, so an offline machine does not retry on every check.
pub fn should_attempt(state: CacheState, last_attempt: Option<u64>, now: u64) -> bool {
    if state == CacheState::Fresh {
        return false;
    }
    match last_attempt {
        None => true,
        Some(last) => now.saturating_sub(last) >= FRESH_SECS,
    }
}

/// Reads and checks the cache file. Any problem makes it unusable.
pub fn read_cache(path: &Path) -> Result<CacheFile, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    let file: CacheFile =
        serde_json::from_slice(&bytes).map_err(|e| format!("cache is not valid JSON: {e}"))?;
    if file.schema != SCHEMA_VERSION {
        return Err(format!("cache schema {} is not {SCHEMA_VERSION}", file.schema));
    }
    if file.models.len() < MIN_MODELS {
        return Err(format!("cache has only {} models", file.models.len()));
    }
    Ok(file)
}

/// Checks downloaded bytes and turns them into a cache file. Nothing is written.
pub fn parse_download(bytes: &[u8], fetched_at: u64) -> Result<CacheFile, String> {
    if bytes.len() > MAX_DOWNLOAD_BYTES {
        return Err(format!("download is larger than {MAX_DOWNLOAD_BYTES} bytes"));
    }
    let models: BTreeMap<String, ModelName> = serde_json::from_slice(bytes)
        .map_err(|e| format!("download is not the expected JSON: {e}"))?;
    if models.len() < MIN_MODELS {
        return Err(format!("download has only {} models", models.len()));
    }
    Ok(CacheFile {
        schema: SCHEMA_VERSION,
        source: SOURCE_URL.to_string(),
        fetched_at,
        models,
    })
}

/// Saves the cache through a temporary file in the same folder, then renames it
/// over the old one. The old file stays in place if any step fails.
pub fn write_cache(path: &Path, file: &CacheFile) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| format!("cache path {} has no folder", path.display()))?;
    std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let bytes = serde_json::to_vec(file).map_err(|e| e.to_string())?;
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = dir.join(format!("{CACHE_FILE}.{}.{nanos}.tmp", std::process::id()));
    std::fs::write(&tmp, &bytes).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("cannot write {}: {e}", tmp.display())
    })?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("cannot replace {}: {e}", path.display())
    })
}

/// Validates a download and saves it. Returns the new cache file on success.
pub fn apply_download(path: &Path, bytes: &[u8], now: u64) -> Result<CacheFile, String> {
    let file = parse_download(bytes, now)?;
    write_cache(path, &file)?;
    Ok(file)
}

fn install(file: CacheFile) {
    let mut guard = DB.write().unwrap_or_else(|e| e.into_inner());
    *guard = Some(Arc::new(file));
}

fn current() -> Option<Arc<CacheFile>> {
    DB.read().unwrap_or_else(|e| e.into_inner()).clone()
}

/// The cache as it stands now. Safe to call from any thread.
// Used by the Hosts tab once it shows model names.
#[allow(dead_code)]
pub fn state() -> CacheState {
    state_at(current().as_deref(), now_secs())
}

/// Brand and marketing name for a model code, if the cache has it.
/// ADB reports `SM S921B`; the database keys are `SM-S921B`, so both spellings are tried.
pub fn lookup(model: &str) -> Option<ModelName> {
    let key = model.trim();
    if key.is_empty() {
        return None;
    }
    let db = current()?;
    let hit = find(&db.models, key);
    debug!(hit = hit.is_some(), "device model lookup");
    hit
}

fn find(models: &BTreeMap<String, ModelName>, key: &str) -> Option<ModelName> {
    let upper = key.to_ascii_uppercase();
    models
        .get(key)
        .or_else(|| models.get(&upper))
        .or_else(|| models.get(&upper.replace(' ', "-")))
        .cloned()
}

/// The label shown to people: "Samsung Galaxy S24". The name already carries the
/// brand for some entries ("Redmi Note 13 5G"), so it is not repeated.
pub fn display_name(model: &ModelName) -> String {
    if model.name.to_ascii_lowercase().starts_with(&model.brand.to_ascii_lowercase()) {
        model.name.clone()
    } else {
        format!("{} {}", model.brand, model.name)
    }
}

/// Clears the in-flight flag when a download ends, however it ends.
struct InFlight;

impl InFlight {
    fn claim() -> Option<InFlight> {
        if IN_FLIGHT.swap(true, Ordering::SeqCst) {
            None
        } else {
            Some(InFlight)
        }
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        IN_FLIGHT.store(false, Ordering::SeqCst);
    }
}

async fn download() -> Result<Vec<u8>, String> {
    let output = tokio::process::Command::new("curl")
        .args([
            "--fail",
            "--silent",
            "--show-error",
            "--location",
            "--max-time",
            &FETCH_TIMEOUT_SECS.to_string(),
            SOURCE_URL,
        ])
        .output()
        .await
        .map_err(|e| format!("cannot run curl: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "download failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(output.stdout)
}

/// Downloads and saves the database if a refresh is due. Never clears a good cache.
async fn refresh_if_due(path: &Path) {
    let now = now_secs();
    let state = state_at(current().as_deref(), now);
    let claim = match InFlight::claim() {
        Some(claim) => claim,
        None => return,
    };
    {
        let mut last = LAST_ATTEMPT.lock().unwrap_or_else(|e| e.into_inner());
        if !should_attempt(state, *last, now) {
            return;
        }
        *last = Some(now);
    }
    let outcome = match download().await {
        Ok(bytes) => apply_download(path, &bytes, now),
        Err(error) => Err(error),
    };
    drop(claim);
    match outcome {
        Ok(file) => {
            info!(models = file.models.len(), "device model database refreshed");
            install(file);
        }
        Err(error) => {
            warn!(%error, "device model refresh failed; keeping the last valid cache");
        }
    }
}

/// Loads the cache now and keeps it refreshed in the background. Call once at
/// startup, inside the Tokio runtime.
pub fn start(data_dir: PathBuf) {
    let path = cache_path(&data_dir);
    let now = now_secs();
    match read_cache(&path) {
        Ok(file) => {
            let state = state_at(Some(&file), now);
            info!(
                cache = ?state,
                models = file.models.len(),
                path = %path.display(),
                "device model cache loaded"
            );
            install(file);
        }
        Err(error) if path.exists() => {
            warn!(%error, path = %path.display(), "device model cache is unusable; downloading")
        }
        Err(_) => info!(path = %path.display(), "no device model cache yet; downloading"),
    }
    tokio::spawn(async move {
        loop {
            refresh_if_due(&path).await;
            tokio::time::sleep(CHECK_EVERY).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn models(count: usize) -> BTreeMap<String, ModelName> {
        let mut map = BTreeMap::new();
        map.insert(
            "SM-S921B".to_string(),
            ModelName {
                brand: "Samsung".into(),
                name: "Galaxy S24".into(),
            },
        );
        for i in 0..count {
            map.insert(
                format!("TEST-{i}"),
                ModelName {
                    brand: "Test".into(),
                    name: format!("Phone {i}"),
                },
            );
        }
        map
    }

    fn file(fetched_at: u64, count: usize) -> CacheFile {
        CacheFile {
            schema: SCHEMA_VERSION,
            source: SOURCE_URL.into(),
            fetched_at,
            models: models(count),
        }
    }

    fn dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "adboard-models-{name}-{}-{}",
            std::process::id(),
            now_secs()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn json(models: &BTreeMap<String, ModelName>) -> Vec<u8> {
        serde_json::to_vec(models).unwrap()
    }

    #[test]
    fn fresh_cache_is_used_without_a_download() {
        let now = 1_000_000;
        let fresh = file(now - 60, MIN_MODELS);
        assert_eq!(state_at(Some(&fresh), now), CacheState::Fresh);
        assert!(!should_attempt(CacheState::Fresh, None, now));
    }

    #[test]
    fn expired_cache_is_usable_and_a_refresh_is_due() {
        let now = 1_000_000;
        let old = file(now - FRESH_SECS - 1, MIN_MODELS);
        assert_eq!(state_at(Some(&old), now), CacheState::Expired);
        assert!(should_attempt(CacheState::Expired, None, now));
    }

    #[test]
    fn no_cache_means_unavailable() {
        assert_eq!(state_at(None, 1), CacheState::Unavailable);
        assert!(should_attempt(CacheState::Unavailable, None, 1));
    }

    #[test]
    fn at_most_one_attempt_per_day_when_offline() {
        let now = 2_000_000;
        assert!(!should_attempt(CacheState::Expired, Some(now - 3600), now));
        assert!(should_attempt(CacheState::Expired, Some(now - FRESH_SECS), now));
    }

    #[test]
    fn cache_round_trips_and_is_read_back() {
        let root = dir("roundtrip");
        let path = cache_path(&root);
        let now = 3_000_000;
        apply_download(&path, &json(&models(MIN_MODELS)), now).unwrap();
        let read = read_cache(&path).unwrap();
        assert_eq!(read.fetched_at, now);
        assert_eq!(state_at(Some(&read), now), CacheState::Fresh);
        assert_eq!(find(&read.models, "SM-S921B").unwrap().name, "Galaxy S24");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_folders_are_created() {
        let root = dir("missing-folders");
        let path = cache_path(&root);
        assert!(!path.parent().unwrap().exists());
        write_cache(&path, &file(5, MIN_MODELS)).unwrap();
        assert!(path.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn invalid_download_keeps_the_last_good_cache() {
        let root = dir("keep-good");
        let path = cache_path(&root);
        apply_download(&path, &json(&models(MIN_MODELS)), 10).unwrap();
        let before = std::fs::read(&path).unwrap();

        assert!(apply_download(&path, b"<html>blocked</html>", 20).is_err());
        assert!(apply_download(&path, b"[1,2,3]", 20).is_err());
        assert!(apply_download(&path, &json(&models(3)), 20).is_err());

        assert_eq!(std::fs::read(&path).unwrap(), before);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn corrupt_or_old_schema_cache_is_unusable() {
        let root = dir("corrupt");
        let path = cache_path(&root);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"{ not json").unwrap();
        assert!(read_cache(&path).is_err());

        let mut old = file(1, MIN_MODELS);
        old.schema = SCHEMA_VERSION + 1;
        std::fs::write(&path, serde_json::to_vec(&old).unwrap()).unwrap();
        assert!(read_cache(&path).unwrap_err().contains("schema"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn unwritable_location_is_an_error_not_a_panic() {
        let root = dir("unwritable");
        std::fs::create_dir_all(&root).unwrap();
        let blocker = root.join("device");
        std::fs::write(&blocker, b"a file, not a folder").unwrap();
        let path = cache_path(&root);
        assert!(write_cache(&path, &file(1, MIN_MODELS)).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn lookup_matches_exact_then_upper_case_and_misses_cleanly() {
        let map = models(0);
        assert_eq!(find(&map, "SM-S921B").unwrap().brand, "Samsung");
        assert_eq!(find(&map, "sm-s921b").unwrap().brand, "Samsung");
        assert!(find(&map, "NOT-A-MODEL").is_none());
    }

    #[test]
    fn adb_spelling_with_spaces_finds_the_dashed_key() {
        let map = models(0);
        assert_eq!(find(&map, "SM S921B").unwrap().name, "Galaxy S24");
    }

    #[test]
    fn display_name_adds_the_brand_only_when_the_name_lacks_it() {
        let galaxy = ModelName { brand: "Samsung".into(), name: "Galaxy S24".into() };
        let redmi = ModelName { brand: "Redmi".into(), name: "Redmi Note 13 5G".into() };
        assert_eq!(display_name(&galaxy), "Samsung Galaxy S24");
        assert_eq!(display_name(&redmi), "Redmi Note 13 5G");
    }
}
