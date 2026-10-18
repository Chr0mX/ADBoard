//! App icons from the phone, for apps saved without an icon of their own.
//!
//! `GET /api/apps/icon?serial=…&package=…` copies the app's APK off the phone
//! with adb, reads the launcher icon out of it and caches the picture in the
//! data folder (`cache/app-icons/<package>.png`), so each app is read from the
//! phone once. Answers 404 when there is no readable icon (the UI then shows a
//! letter badge).
//!
//! Reading an icon means: the manifest (binary XML) names the icon resource;
//! `resources.arsc` maps that resource to files per screen density; the
//! sharpest PNG/WebP is returned. An adaptive icon (an XML file) is followed to
//! its foreground picture.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::extract::{Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};

use crate::device_manager::AppState;

/// A picture found inside an APK.
#[derive(Debug, PartialEq)]
pub struct Icon {
    /// `png` or `webp`.
    pub ext: &'static str,
    pub bytes: Vec<u8>,
}

/* --------------------------- binary readers --------------------------- */

fn u16le(b: &[u8], o: usize) -> Option<u16> {
    b.get(o..o.checked_add(2)?).map(|x| u16::from_le_bytes([x[0], x[1]]))
}

fn u32le(b: &[u8], o: usize) -> Option<u32> {
    b.get(o..o.checked_add(4)?).map(|x| u32::from_le_bytes([x[0], x[1], x[2], x[3]]))
}

/// Android "string pool" chunk: the strings of a binary XML file or resource table.
struct Pool {
    strings: Vec<String>,
}

impl Pool {
    /// Parse the pool chunk at `start`; also returns the chunk's size.
    fn parse(b: &[u8], start: usize) -> Option<(Pool, usize)> {
        if u16le(b, start)? != 0x0001 {
            return None;
        }
        let header = u16le(b, start + 2)? as usize;
        let size = u32le(b, start + 4)? as usize;
        let count = u32le(b, start + 8)? as usize;
        let flags = u32le(b, start + 16)?;
        let strings_start = u32le(b, start + 20)? as usize;
        if count > 1_000_000 {
            return None;
        }
        let utf8 = flags & 0x100 != 0;
        let mut strings = Vec::with_capacity(count);
        for i in 0..count {
            let offset = u32le(b, start + header + i * 4)? as usize;
            let at = start.checked_add(strings_start)?.checked_add(offset)?;
            strings.push(if utf8 { read_utf8(b, at)? } else { read_utf16(b, at)? });
        }
        Some((Pool { strings }, size))
    }

    fn get(&self, index: u32) -> Option<&str> {
        self.strings.get(index as usize).map(String::as_str)
    }
}

fn read_len8(b: &[u8], p: &mut usize) -> Option<usize> {
    let first = *b.get(*p)? as usize;
    *p += 1;
    if first & 0x80 == 0 {
        return Some(first);
    }
    let second = *b.get(*p)? as usize;
    *p += 1;
    Some(((first & 0x7f) << 8) | second)
}

fn read_utf8(b: &[u8], mut p: usize) -> Option<String> {
    read_len8(b, &mut p)?; // length in UTF-16 units
    let len = read_len8(b, &mut p)?;
    Some(String::from_utf8_lossy(b.get(p..p.checked_add(len)?)?).into_owned())
}

fn read_utf16(b: &[u8], mut p: usize) -> Option<String> {
    let mut len = u16le(b, p)? as usize;
    p += 2;
    if len & 0x8000 != 0 {
        len = ((len & 0x7fff) << 16) | u16le(b, p)? as usize;
        p += 2;
    }
    let units: Vec<u16> = (0..len).map(|i| u16le(b, p + i * 2)).collect::<Option<_>>()?;
    Some(String::from_utf16_lossy(&units))
}

/* ----------------------------- binary XML ----------------------------- */

/// One attribute of an element: its name and a resource reference or string value.
#[derive(Clone)]
struct Attr {
    name: String,
    /// Resource id when the value is a reference (`@0x7f…`).
    reference: Option<u32>,
    /// The value when it is a plain string.
    string: Option<String>,
}

struct Element {
    name: String,
    attrs: Vec<Attr>,
}

/// Every element of a compiled XML file, in order.
fn axml_elements(b: &[u8]) -> Option<Vec<Element>> {
    if u16le(b, 0)? != 0x0003 {
        return None;
    }
    let mut pos = u16le(b, 2)? as usize;
    let mut pool: Option<Pool> = None;
    let mut out = Vec::new();
    while pos + 8 <= b.len() {
        let kind = u16le(b, pos)?;
        let size = u32le(b, pos + 4)? as usize;
        if size < 8 {
            return None;
        }
        match kind {
            0x0001 if pool.is_none() => pool = Some(Pool::parse(b, pos)?.0),
            0x0102 => {
                let pool = pool.as_ref()?;
                let name = pool.get(u32le(b, pos + 20)?)?.to_string();
                let attr_start = u16le(b, pos + 24)? as usize;
                let attr_size = (u16le(b, pos + 26)? as usize).max(20);
                let attr_count = u16le(b, pos + 28)? as usize;
                let mut attrs = Vec::new();
                for i in 0..attr_count.min(256) {
                    let at = pos + 16 + attr_start + i * attr_size;
                    let attr_name = pool.get(u32le(b, at + 4)?).unwrap_or("").to_string();
                    let raw = u32le(b, at + 8)?;
                    let data_type = *b.get(at + 15)?;
                    let data = u32le(b, at + 16)?;
                    attrs.push(Attr {
                        name: attr_name,
                        reference: (data_type == 0x01).then_some(data),
                        string: if data_type == 0x03 { pool.get(raw).map(str::to_string) } else { None },
                    });
                }
                out.push(Element { name, attrs });
            }
            _ => {}
        }
        pos += size;
    }
    Some(out)
}

/// The launcher icon the manifest names: the application's, else the first activity's.
fn manifest_icon(manifest: &[u8]) -> Option<Attr> {
    let elements = axml_elements(manifest)?;
    for wanted in ["application", "activity"] {
        for element in elements.iter().filter(|e| e.name == wanted) {
            if let Some(attr) = element.attrs.iter().find(|a| a.name == "icon" && (a.reference.is_some() || a.string.is_some())) {
                return Some(attr.clone());
            }
        }
    }
    None
}

/// The label (display name) the manifest names: the application's, else the first activity's.
fn manifest_label(manifest: &[u8]) -> Option<Attr> {
    let elements = axml_elements(manifest)?;
    for wanted in ["application", "activity"] {
        for element in elements.iter().filter(|e| e.name == wanted) {
            if let Some(attr) = element.attrs.iter().find(|a| a.name == "label" && (a.reference.is_some() || a.string.is_some())) {
                return Some(attr.clone());
            }
        }
    }
    None
}

/// The foreground picture an adaptive-icon XML points at.
fn adaptive_foreground(xml: &[u8]) -> Option<u32> {
    let elements = axml_elements(xml)?;
    elements
        .iter()
        .filter(|e| e.name == "foreground")
        .flat_map(|e| e.attrs.iter())
        .find(|a| a.name == "drawable")
        .and_then(|a| a.reference)
}

/* ---------------------------- resource table ---------------------------- */

/// One value a resource id has in one configuration.
struct Found {
    density: u16,
    /// No language or country: the app's default text.
    default_locale: bool,
    value: String,
}

/// Files a resource id maps to, with the screen density each is for.
fn resource_files(arsc: &[u8], id: u32) -> Option<Vec<(u16, String)>> {
    resource_values(arsc, id).map(|all| all.into_iter().map(|f| (f.density, f.value)).collect())
}

/// The app's default-language text for a string resource.
fn string_resource(arsc: &[u8], id: u32) -> Option<String> {
    let all = resource_values(arsc, id)?;
    all.iter().find(|f| f.default_locale).or(all.first()).map(|f| f.value.clone())
}

fn resource_values(arsc: &[u8], id: u32) -> Option<Vec<Found>> {
    if u16le(arsc, 0)? != 0x0002 {
        return None;
    }
    let (package_id, type_id, entry) = ((id >> 24) as u8, ((id >> 16) & 0xff) as u8, (id & 0xffff) as usize);
    let table_header = u16le(arsc, 2)? as usize;
    let (values, pool_size) = Pool::parse(arsc, table_header)?;
    let mut pos = table_header + pool_size;
    let mut files: Vec<Found> = Vec::new();
    while pos + 8 <= arsc.len() {
        let kind = u16le(arsc, pos)?;
        let size = u32le(arsc, pos + 4)? as usize;
        if size < 8 {
            return None;
        }
        if kind == 0x0200 && u32le(arsc, pos + 8)? as u8 == package_id {
            let mut at = pos + u16le(arsc, pos + 2)? as usize;
            let end = (pos + size).min(arsc.len());
            while at + 8 <= end {
                let child = u16le(arsc, at)?;
                let child_size = u32le(arsc, at + 4)? as usize;
                if child_size < 8 {
                    break;
                }
                if child == 0x0201 && *arsc.get(at + 8)? == type_id {
                    if let Some(found) = type_entry(arsc, at, entry, &values) {
                        files.push(found);
                    }
                }
                at += child_size;
            }
        }
        pos += size;
    }
    (!files.is_empty()).then_some(files)
}

/// The value `entry` has in one Type chunk, with that chunk's density and language.
fn type_entry(arsc: &[u8], at: usize, entry: usize, values: &Pool) -> Option<Found> {
    let header = u16le(arsc, at + 2)? as usize;
    let flags = *arsc.get(at + 9)?;
    let count = u32le(arsc, at + 12)? as usize;
    let entries_start = u32le(arsc, at + 16)? as usize;
    if flags & 0x01 != 0 || entry >= count {
        return None; // sparse tables are not used for icons
    }
    let offset = u32le(arsc, at + header + entry * 4)?;
    if offset == 0xFFFF_FFFF {
        return None;
    }
    let e = at.checked_add(entries_start)?.checked_add(offset as usize)?;
    if u16le(arsc, e + 2)? & 0x0001 != 0 {
        return None; // a bag (style, plurals), not a file
    }
    if *arsc.get(e + 11)? != 0x03 {
        return None; // not a string value
    }
    let path = values.get(u32le(arsc, e + 12)?)?.to_string();
    let density = u16le(arsc, at + 20 + 14)?; // ResTable_config.density
    let default_locale = u32le(arsc, at + 20 + 8)? == 0; // language and country both empty
    Some(Found { density, default_locale, value: path })
}

/* ------------------------------ the icon ------------------------------ */

fn is_picture(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".png") || lower.ends_with(".webp")
}

/// Sharpest picture among the files: highest density, not the "any density" XML.
fn best_picture(files: &[(u16, String)]) -> Option<&str> {
    files
        .iter()
        .filter(|(_, path)| is_picture(path))
        .max_by_key(|(density, _)| match *density {
            0 => 160, // no density in the name: treated as baseline
            0xFFFE | 0xFFFF => 0,
            d => d,
        })
        .map(|(_, path)| path.as_str())
}

fn read_entry(zip: &mut zip::ZipArchive<std::fs::File>, name: &str) -> Result<Vec<u8>, String> {
    let mut file = zip.by_name(name).map_err(|e| format!("{name}: {e}"))?;
    if file.size() > 64 * 1024 * 1024 {
        return Err(format!("{name} is too large"));
    }
    let mut bytes = Vec::with_capacity(file.size() as usize);
    file.read_to_end(&mut bytes).map_err(|e| format!("{name}: {e}"))?;
    Ok(bytes)
}

fn picture(zip: &mut zip::ZipArchive<std::fs::File>, path: &str) -> Result<Icon, String> {
    let ext = if path.to_ascii_lowercase().ends_with(".webp") { "webp" } else { "png" };
    Ok(Icon { ext, bytes: read_entry(zip, path)? })
}

/// Read the launcher icon out of an APK file.
pub fn icon_from_apk(path: &Path) -> Result<Icon, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("can't open the APK: {e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("not an APK: {e}"))?;
    icon_in(&mut zip)
}

/// The app's display name, if the APK has a readable one.
pub fn label_from_apk(path: &Path) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let mut zip = zip::ZipArchive::new(file).ok()?;
    label_in(&mut zip)
}

fn label_in(zip: &mut zip::ZipArchive<std::fs::File>) -> Option<String> {
    let manifest = read_entry(zip, "AndroidManifest.xml").ok()?;
    let label = manifest_label(&manifest)?;
    let text = match (label.string, label.reference) {
        (Some(text), _) => Some(text),
        (None, Some(id)) => {
            let arsc = read_entry(zip, "resources.arsc").ok()?;
            string_resource(&arsc, id)
        }
        _ => None,
    }?;
    let text = text.trim().to_string();
    (!text.is_empty() && text.len() <= 120).then_some(text)
}

fn icon_in(zip: &mut zip::ZipArchive<std::fs::File>) -> Result<Icon, String> {
    let manifest = read_entry(zip, "AndroidManifest.xml")?;
    let icon = manifest_icon(&manifest).ok_or("the app names no icon")?;
    if let Some(path) = icon.string.as_deref().filter(|p| is_picture(p)) {
        return picture(zip, path); // older apps point straight at a file
    }
    let id = icon.reference.ok_or("the app's icon is not a resource")?;
    let arsc = read_entry(zip, "resources.arsc")?;
    let files = resource_files(&arsc, id).ok_or("icon resource not found")?;
    if let Some(path) = best_picture(&files) {
        return picture(zip, path);
    }
    // Adaptive icon: an XML file naming a foreground picture.
    for (_, xml_path) in files.iter().filter(|(_, p)| p.to_ascii_lowercase().ends_with(".xml")) {
        let xml = read_entry(zip, xml_path)?;
        if let Some(foreground) = adaptive_foreground(&xml) {
            if let Some(pictures) = resource_files(&arsc, foreground) {
                if let Some(path) = best_picture(&pictures) {
                    return picture(zip, path);
                }
            }
        }
    }
    Err("the icon is a vector drawing, not a picture".into())
}

/* ------------------------------- endpoint ------------------------------- */

fn cache_dir() -> PathBuf {
    crate::data_dir::root().path.join("cache").join("app-icons")
}

/// Package ids are letters, digits, dots and underscores; nothing else reaches adb or a file name.
fn valid_package(package: &str) -> bool {
    !package.is_empty()
        && package.len() <= 200
        && package.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_')
}

fn cached(package: &str) -> Option<(Icon, PathBuf)> {
    for ext in ["png", "webp"] {
        let path = cache_dir().join(format!("{package}.{ext}"));
        if let Ok(bytes) = std::fs::read(&path) {
            return Some((Icon { ext: if ext == "png" { "png" } else { "webp" }, bytes }, path));
        }
    }
    None
}

/// Packages whose APK couldn't be read lately: not retried for a while, so a
/// big APK isn't copied again on every page load.
fn failed() -> &'static Mutex<HashMap<String, Instant>> {
    static FAILED: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    FAILED.get_or_init(Default::default)
}
const RETRY_AFTER: Duration = Duration::from_secs(10 * 60);

fn image_response(icon: Icon) -> Response {
    (
        [
            (header::CONTENT_TYPE, if icon.ext == "webp" { "image/webp" } else { "image/png" }),
            (header::CACHE_CONTROL, "private, max-age=86400"),
        ],
        icon.bytes,
    )
        .into_response()
}

fn not_found(why: &str) -> Response {
    (StatusCode::NOT_FOUND, why.to_string()).into_response()
}

#[derive(serde::Deserialize)]
pub struct IconQuery {
    serial: String,
    package: String,
}

/// What was read from an app's APK, kept next to its icon (`<package>.json`).
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    /// The app's display name, when the APK has a readable one.
    pub label: Option<String>,
    pub has_icon: bool,
}

fn meta_path(package: &str) -> PathBuf {
    cache_dir().join(format!("{package}.json"))
}

fn cached_meta(package: &str) -> Option<Meta> {
    serde_json::from_slice(&std::fs::read(meta_path(package)).ok()?).ok()
}

/// The APK path `pm path` prints (the base APK when the app is split).
fn apk_path(pm_path: &str) -> Option<String> {
    let paths: Vec<&str> = pm_path.lines().filter_map(|l| l.trim().strip_prefix("package:")).collect();
    paths.iter().find(|p| p.ends_with("base.apk")).or(paths.first()).map(|p| p.to_string())
}

/// Icon and name of an app: from the cache, else by copying its APK off the
/// phone once. An error means neither could be read.
async fn ensure(state: &AppState, query: &IconQuery) -> Result<Meta, String> {
    if !valid_package(&query.package) {
        return Err("bad package id".into());
    }
    if let Some(meta) = cached_meta(&query.package) {
        return Ok(meta);
    }
    if failed().lock().unwrap_or_else(|e| e.into_inner()).get(&query.package).is_some_and(|at| at.elapsed() < RETRY_AFTER) {
        return Err("not readable (tried recently)".into());
    }
    // One APK copy at a time: they can be large.
    static BUSY: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = BUSY.lock().await;
    if let Some(meta) = cached_meta(&query.package) {
        return Ok(meta);
    }
    match read_from_phone(state, query).await {
        Ok((icon, label)) => {
            let dir = cache_dir();
            let _ = std::fs::create_dir_all(&dir);
            let has_icon = match &icon {
                Ok(icon) => crate::shared_store::write_atomic(&dir.join(format!("{}.{}", query.package, icon.ext)), &icon.bytes).is_ok(),
                Err(_) => false,
            };
            if !has_icon && label.is_none() {
                let why = icon.err().unwrap_or_else(|| "nothing readable in the APK".into());
                failed().lock().unwrap_or_else(|e| e.into_inner()).insert(query.package.clone(), Instant::now());
                return Err(why);
            }
            let meta = Meta { label, has_icon };
            if let Ok(json) = serde_json::to_vec(&meta) {
                let _ = crate::shared_store::write_atomic(&meta_path(&query.package), &json);
            }
            Ok(meta)
        }
        Err(why) => {
            tracing::info!("app info for {}: {why}", query.package);
            failed().lock().unwrap_or_else(|e| e.into_inner()).insert(query.package.clone(), Instant::now());
            Err(why)
        }
    }
}

pub async fn app_icon(State(state): State<AppState>, Query(query): Query<IconQuery>) -> Response {
    if !valid_package(&query.package) {
        return (StatusCode::BAD_REQUEST, "bad package id").into_response();
    }
    if let Some((icon, _)) = cached(&query.package) {
        return image_response(icon);
    }
    match ensure(&state, &query).await {
        Ok(_) => match cached(&query.package) {
            Some((icon, _)) => image_response(icon),
            None => not_found("this app has no readable icon"),
        },
        Err(why) => not_found(&why),
    }
}

/// `GET /api/apps/meta?serial&package`: `{label, hasIcon}`.
pub async fn app_meta(State(state): State<AppState>, Query(query): Query<IconQuery>) -> Response {
    if !valid_package(&query.package) {
        return (StatusCode::BAD_REQUEST, "bad package id").into_response();
    }
    match ensure(&state, &query).await {
        Ok(meta) => axum::Json(meta).into_response(),
        Err(why) => not_found(&why),
    }
}

async fn read_from_phone(state: &AppState, query: &IconQuery) -> Result<(Result<Icon, String>, Option<String>), String> {
    // Test hook: read this APK instead of a phone's (the mock fleet has no apps).
    let fixture = crate::env::var("ICON_FIXTURE_APK").ok().filter(|p| !p.trim().is_empty());
    let temp = crate::paths::app_temp_dir().join(format!("icon-{}.apk", query.package));
    let (apk, remove) = if let Some(path) = fixture {
        (PathBuf::from(path), false)
    } else {
        let adb = state.inner.adb_path.clone().ok_or("no adb: the mock fleet has no apps")?;
        let serial = query.serial.as_str();
        let listed = crate::device_ops::adb_text(&adb, &["-s".into(), serial.into(), "shell".into(), format!("pm path {}", query.package)]).await?;
        let remote = apk_path(&listed).ok_or("the app isn't installed on this phone")?;
        let _ = std::fs::create_dir_all(temp.parent().unwrap_or(Path::new(".")));
        crate::device_ops::adb_text(&adb, &["-s".into(), serial.into(), "pull".into(), remote, temp.display().to_string()]).await?;
        (temp.clone(), true)
    };
    tokio::task::spawn_blocking(move || {
        let icon = icon_from_apk(&apk);
        let label = label_from_apk(&apk);
        if remove {
            let _ = std::fs::remove_file(&apk);
        }
        (icon, label)
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn package_ids_are_checked() {
        assert!(valid_package("com.example.app_1"));
        assert!(!valid_package(""));
        assert!(!valid_package("../etc"));
        assert!(!valid_package("a b"));
        assert!(!valid_package("a;rm"));
    }

    #[test]
    fn picks_the_base_apk() {
        let out = "package:/data/app/x/split_config.arm64.apk\npackage:/data/app/x/base.apk\n";
        assert_eq!(apk_path(out).as_deref(), Some("/data/app/x/base.apk"));
        assert_eq!(apk_path("package:/data/app/y/only.apk").as_deref(), Some("/data/app/y/only.apk"));
        assert_eq!(apk_path(""), None);
    }

    #[test]
    fn prefers_the_sharpest_picture() {
        let files = vec![
            (0xFFFE, "res/mipmap-anydpi-v26/ic_launcher.xml".to_string()),
            (160, "res/mipmap-mdpi/ic_launcher.png".to_string()),
            (480, "res/mipmap-xxhdpi/ic_launcher.png".to_string()),
            (320, "res/mipmap-xhdpi/ic_launcher.webp".to_string()),
        ];
        assert_eq!(best_picture(&files), Some("res/mipmap-xxhdpi/ic_launcher.png"));
        assert_eq!(best_picture(&files[..1]), None);
    }

    /// A real APK (Auto Clicker); set `ADBOARD_TEST_APK` to run against another.
    fn sample_apk() -> Option<PathBuf> {
        let path = std::env::var("ADBOARD_TEST_APK").unwrap_or_else(|_| "/tmp/claude-0/apk/ac.apk".into());
        let path = PathBuf::from(path);
        path.is_file().then_some(path)
    }

    #[test]
    fn reads_the_icon_of_a_real_apk() {
        let Some(apk) = sample_apk() else {
            eprintln!("no sample APK here; skipping");
            return;
        };
        let icon = icon_from_apk(&apk).expect("icon");
        assert!(icon.bytes.len() > 200, "{} bytes", icon.bytes.len());
        let magic: &[u8] = if icon.ext == "png" { b"\x89PNG" } else { b"RIFF" };
        assert!(icon.bytes.starts_with(magic));
    }

    #[test]
    fn reads_the_name_of_a_real_apk() {
        let Some(apk) = sample_apk() else {
            eprintln!("no sample APK here; skipping");
            return;
        };
        let label = label_from_apk(&apk).expect("label");
        assert!(label.len() >= 3 && !label.contains('\u{0}'), "{label:?}");
        eprintln!("label: {label}");
    }

    #[test]
    fn meta_round_trips_as_camel_case() {
        let meta = Meta { label: Some("Auto Clicker".into()), has_icon: true };
        let json = serde_json::to_string(&meta).unwrap();
        assert_eq!(json, r#"{"label":"Auto Clicker","hasIcon":true}"#);
        assert_eq!(serde_json::from_str::<Meta>(&json).unwrap(), meta);
    }

    #[test]
    fn rejects_files_that_are_not_apks() {
        let dir = std::env::temp_dir().join(format!("adboard-icon-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("x.apk");
        std::fs::write(&path, b"not a zip").unwrap();
        assert!(icon_from_apk(&path).is_err());
        assert!(icon_from_apk(&dir.join("missing.apk")).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn broken_binary_xml_is_an_error_not_a_panic() {
        assert!(axml_elements(&[]).is_none());
        assert!(axml_elements(&[3, 0, 8, 0, 4, 0, 0, 0]).unwrap_or_default().is_empty());
        assert!(resource_files(&[2, 0, 12, 0, 0, 0, 0, 0], 0x7f010000).is_none());
    }
}
