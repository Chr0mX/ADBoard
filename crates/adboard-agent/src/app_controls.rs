//! Per-app controls, phone tweaks and Shizuku, all as `adb shell` commands.
//!
//! The recipes follow Shizuku-Next (github.com/rushiranpise/Shizuku-Next,
//! Apache-2.0), whose adb-started server has the same "shell" rights the agent
//! has over adb. Every value that reaches the phone's shell is checked against
//! an allow-list or quoted; nothing is passed through as free text.

use std::collections::BTreeMap;
use std::path::Path;

use serde::Serialize;

use crate::device_ops::{adb_text, sh_quote, valid_package};

/// The package Shizuku and its forks (thedjchi, Shizuku-Next) install as.
pub const SHIZUKU_PACKAGE: &str = "moe.shizuku.privileged.api";

/* ------------------------------ allow-lists ------------------------------ */

/// App-op names are upper-case words (`RUN_ANY_IN_BACKGROUND`, `CAMERA`).
pub fn valid_op(op: &str) -> bool {
    !op.is_empty() && op.len() <= 64 && op.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
}

pub const OP_MODES: [&str; 5] = ["allow", "ignore", "deny", "default", "foreground"];

pub const BUCKETS: [&str; 5] = ["active", "working_set", "frequent", "rare", "restricted"];

/// `android.permission.CAMERA`, `com.app.permission.X`.
pub fn valid_permission(name: &str) -> bool {
    valid_package(name)
}

/// `.MainActivity`, `com.app.Main$Inner`.
fn valid_class(name: &str) -> bool {
    !name.is_empty()
        && name.len() < 300
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '$'))
}

fn on_off(arg: Option<&str>) -> Result<bool, String> {
    match arg.map(str::trim) {
        Some("on") => Ok(true),
        Some("off") => Ok(false),
        _ => Err("use on or off".into()),
    }
}

/* -------------------------------- parsers -------------------------------- */

/// `cmd appops get <pkg>`: op → mode. Package-level entries win over the
/// `Uid mode:` lines, which apply to every package of the uid.
pub fn parse_appops(text: &str) -> BTreeMap<String, String> {
    let mut package = BTreeMap::new();
    let mut uid = BTreeMap::new();
    for line in text.lines() {
        let line = line.trim();
        let (target, line) = match line.strip_prefix("Uid mode:") {
            Some(rest) => (&mut uid, rest.trim()),
            None => (&mut package, line),
        };
        let Some((name, rest)) = line.split_once(':') else { continue };
        let name = name.trim();
        if !valid_op(name) {
            continue;
        }
        let mode = rest.split(';').next().unwrap_or("").trim();
        let mode = mode.strip_prefix("mode=").unwrap_or(mode);
        if OP_MODES.contains(&mode) {
            target.insert(name.to_string(), mode.to_string());
        }
    }
    for (name, mode) in uid {
        package.entry(name).or_insert(mode);
    }
    package
}

/// `am get-standby-bucket`: a number on most versions, a name on some.
pub fn parse_bucket(text: &str) -> Option<String> {
    let raw = text.trim().lines().last()?.trim();
    let name = match raw {
        "5" => "exempted",
        "10" => "active",
        "20" => "working_set",
        "30" => "frequent",
        "40" => "rare",
        "45" => "restricted",
        "50" => "never",
        other if BUCKETS.contains(&other) || other == "exempted" || other == "never" => other,
        _ => return None,
    };
    Some(name.to_string())
}

/// `dumpsys deviceidle whitelist` lines look like `user,com.app,10234`.
/// Returns how the app is exempt: `user` (can be removed) or `system`.
pub fn parse_idle_exempt(text: &str, package: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let mut parts = line.trim().split(',');
        let kind = parts.next()?;
        (parts.next()? == package).then(|| if kind == "user" { "user".to_string() } else { "system".to_string() })
    })
}

/// `cmd connectivity get-package-networking-enabled`: allowed, blocked, or
/// `None` when the phone has no such command.
pub fn parse_networking(text: &str) -> Option<bool> {
    let t = text.trim().to_ascii_lowercase();
    if t.contains("unknown") || t.contains("usage") || t.contains("error") || t.contains("exception") {
        return None;
    }
    if t.ends_with("true") || t.ends_with("enabled") || t.ends_with("allowed") {
        Some(true)
    } else if t.ends_with("false") || t.ends_with("disabled") || t.ends_with("blocked") {
        Some(false)
    } else {
        None
    }
}

#[derive(Debug, Default, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Permission {
    pub name: String,
    pub granted: bool,
}

/// What `dumpsys package <pkg>` says about one app.
#[derive(Debug, Default, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageDump {
    pub uid: Option<u32>,
    pub version_name: Option<String>,
    pub version_code: Option<String>,
    pub target_sdk: Option<u32>,
    /// Installed for user 0.
    pub installed: bool,
    pub suspended: bool,
    /// `enabled=` of user 0: 2, 3 and 4 are the disabled states.
    pub disabled: bool,
    pub system: bool,
    /// Runtime ("dangerous") permissions: the ones `pm grant` can change.
    pub permissions: Vec<Permission>,
    #[serde(skip)]
    pub library_dir: Option<String>,
    #[serde(skip)]
    pub cpu_abi: Option<String>,
}

fn field<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    line.split_whitespace().find_map(|part| part.strip_prefix(key)?.strip_prefix('='))
}

/// Read the `Package [<pkg>]` block of `dumpsys package <pkg>`.
pub fn parse_package_dump(text: &str, package: &str) -> Option<PackageDump> {
    let header = format!("Package [{package}]");
    let mut lines = text.lines().skip_while(|l| !l.trim_start().starts_with(&header));
    let first = lines.next()?;
    let indent = first.len() - first.trim_start().len();
    let mut dump = PackageDump::default();
    let mut section = "";
    let mut runtime: BTreeMap<String, bool> = BTreeMap::new();
    let mut user_zero = false;
    for line in lines {
        let trimmed = line.trim();
        let depth = line.len() - line.trim_start().len();
        if !trimmed.is_empty() && depth <= indent {
            break; // the next package or section
        }
        if let Some(rest) = trimmed.strip_prefix("User ") {
            user_zero = rest.starts_with("0:");
            if user_zero {
                dump.installed = field(trimmed, "installed") == Some("true");
                dump.suspended = field(trimmed, "suspended") == Some("true");
                dump.disabled = matches!(field(trimmed, "enabled"), Some("2" | "3" | "4"));
            }
            section = "";
            continue;
        }
        if trimmed.ends_with(':') && !trimmed.contains('=') {
            section = match trimmed {
                "runtime permissions:" if user_zero => "runtime",
                "requested permissions:" => "requested",
                "install permissions:" => "install",
                _ => "",
            };
            continue;
        }
        if section == "runtime" {
            if let Some((name, rest)) = trimmed.split_once(':') {
                if valid_permission(name) {
                    runtime.insert(name.to_string(), rest.contains("granted=true"));
                }
                continue;
            }
        }
        if let Some(v) = field(trimmed, "userId").or_else(|| field(trimmed, "appId")) {
            dump.uid = dump.uid.or(v.parse().ok());
        }
        if let Some(v) = field(trimmed, "versionCode") {
            dump.version_code = Some(v.to_string());
        }
        if let Some(v) = field(trimmed, "targetSdk") {
            dump.target_sdk = v.parse().ok();
        }
        if let Some(v) = trimmed.strip_prefix("versionName=") {
            dump.version_name = Some(v.to_string());
        }
        if let Some(v) = trimmed.strip_prefix("legacyNativeLibraryDir=") {
            dump.library_dir = Some(v.to_string());
        }
        if let Some(v) = trimmed.strip_prefix("primaryCpuAbi=") {
            dump.cpu_abi = (v != "null").then(|| v.to_string());
        }
        if let Some(v) = trimmed.strip_prefix("pkgFlags=[") {
            dump.system |= v.split_whitespace().any(|f| f == "SYSTEM");
        }
    }
    dump.permissions = runtime.into_iter().map(|(name, granted)| Permission { name, granted }).collect();
    Some(dump)
}

/// The folder name an ABI's native libraries are unpacked to.
pub fn abi_dir(abi: &str) -> Option<&'static str> {
    match abi {
        "arm64-v8a" => Some("arm64"),
        "armeabi-v7a" | "armeabi" => Some("arm"),
        "x86_64" => Some("x86_64"),
        "x86" => Some("x86"),
        _ => None,
    }
}

/// The command Shizuku's "Start via computer" screen shows, for this phone.
pub fn shizuku_starter(dump: &PackageDump) -> Option<String> {
    let dir = dump.library_dir.as_deref()?;
    let abi = abi_dir(dump.cpu_abi.as_deref()?)?;
    Some(format!("{dir}/{abi}/libshizuku.so"))
}

/* ------------------------------- intents ------------------------------- */

/// Split an intent line into words: spaces separate, `'…'` and `"…"` group.
pub fn split_words(line: &str) -> Result<Vec<String>, String> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut quote: Option<char> = None;
    let mut started = false;
    for c in line.chars() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), c) => word.push(c),
            (None, '\'' | '"') => {
                quote = Some(c);
                started = true;
            }
            (None, c) if c.is_whitespace() => {
                if started {
                    words.push(std::mem::take(&mut word));
                    started = false;
                }
            }
            (None, c) => {
                word.push(c);
                started = true;
            }
        }
    }
    if quote.is_some() {
        return Err("a quote is not closed".into());
    }
    if started {
        words.push(word);
    }
    Ok(words)
}

fn plain(value: &str, extra: &[char]) -> bool {
    !value.is_empty() && value.len() < 300 && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_') || extra.contains(&c))
}

/// `am broadcast` / `am start` arguments, from a line like
/// `-a com.app.START -n com.app/.Receiver --es mode fast --ez on true`.
/// Every word is checked by its flag and quoted.
pub fn intent_args(line: &str) -> Result<String, String> {
    let words = split_words(line)?;
    if words.is_empty() {
        return Err("enter at least an action (-a) or a component (-n)".into());
    }
    let mut out: Vec<String> = Vec::new();
    let mut it = words.iter();
    let next = |it: &mut std::slice::Iter<String>, flag: &str| it.next().cloned().ok_or_else(|| format!("{flag} needs a value"));
    while let Some(flag) = it.next() {
        let flag = flag.as_str();
        let ok = match flag {
            "-a" | "-c" => {
                let v = next(&mut it, flag)?;
                plain(&v, &[]).then_some(vec![v])
            }
            "-n" => {
                let v = next(&mut it, flag)?;
                (plain(&v, &['/', '$']) && v.contains('/')).then_some(vec![v])
            }
            "-p" => {
                let v = next(&mut it, flag)?;
                valid_package(&v).then_some(vec![v])
            }
            "-t" => {
                let v = next(&mut it, flag)?;
                plain(&v, &['/', '*', '+', '-']).then_some(vec![v])
            }
            "-f" => {
                let v = next(&mut it, flag)?;
                let n = v.strip_prefix("0x").map(|h| u32::from_str_radix(h, 16).is_ok()).unwrap_or_else(|| v.parse::<u32>().is_ok());
                n.then_some(vec![v])
            }
            "-d" | "--es" | "--ez" | "--ei" | "--el" | "--ef" | "--ed" => {
                let mut values = Vec::new();
                if flag != "-d" {
                    let key = next(&mut it, flag)?;
                    if !plain(&key, &['-']) {
                        return Err(format!("{flag}: the extra name {key:?} is not valid"));
                    }
                    values.push(key);
                }
                let value = next(&mut it, flag)?;
                if value.len() > 1000 || value.contains(['\n', '\0']) {
                    return Err(format!("{flag}: the value is not valid"));
                }
                let typed = match flag {
                    "--ez" => matches!(value.as_str(), "true" | "false"),
                    "--ei" | "--el" => value.parse::<i64>().is_ok(),
                    "--ef" | "--ed" => value.parse::<f64>().is_ok(),
                    _ => true,
                };
                if !typed {
                    return Err(format!("{flag}: {value:?} is not the right type"));
                }
                values.push(value);
                Some(values)
            }
            "--receiver-foreground" | "--include-stopped-packages" => Some(vec![]),
            other => return Err(format!("{other:?} is not an allowed intent flag")),
        };
        let Some(values) = ok else {
            return Err(format!("{flag}: the value is not valid"));
        };
        out.push(flag.to_string());
        out.extend(values.iter().map(|v| sh_quote(v)));
    }
    Ok(out.join(" "))
}

/* -------------------------------- tweaks -------------------------------- */

pub const TWEAKS: [&str; 3] = ["devOptionsHidden", "phantomKillerOff", "forceDark"];

#[derive(Debug, Default, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TweakStatus {
    pub dev_options_hidden: bool,
    pub phantom_killer_off: bool,
    pub force_dark: bool,
}

const TWEAK_STATUS: &str = "echo dev=$(settings get global development_settings_enabled); \
echo phantom=$(settings get global settings_enable_monitor_phantom_procs); \
echo dark=$(getprop debug.hwui.force_dark); \
echo darkg=$(settings get global force_dark_mode_on)";

pub fn parse_tweaks(text: &str) -> TweakStatus {
    let value = |key: &str| {
        text.lines()
            .find_map(|l| l.trim().strip_prefix(key)?.strip_prefix('=').map(str::trim))
            .unwrap_or("")
            .to_string()
    };
    TweakStatus {
        dev_options_hidden: value("dev") == "0",
        phantom_killer_off: matches!(value("phantom").as_str(), "0" | "false"),
        force_dark: value("dark") == "true" || value("darkg") == "1",
    }
}

/// The shell line that turns one tweak on or off.
pub fn tweak_command(name: &str, on: bool) -> Result<&'static str, String> {
    Ok(match (name, on) {
        // adbd keeps running while adb_enabled (and wireless debugging) stay
        // on. Never write adb_enabled 0: that would cut ADBoard's own link.
        ("devOptionsHidden", true) => "w=$(settings get global adb_wifi_enabled); \
settings put global development_settings_enabled 0; settings put global adb_enabled 1; \
if [ \"$w\" = 1 ]; then settings put global adb_wifi_enabled 1; fi; true",
        ("devOptionsHidden", false) => "settings put global development_settings_enabled 1",
        ("phantomKillerOff", true) => "settings put global settings_enable_monitor_phantom_procs 0",
        ("phantomKillerOff", false) => "settings delete global settings_enable_monitor_phantom_procs",
        // A phone ignores keys it doesn't know; each vendor reads a different one.
        ("forceDark", true) => "setprop debug.hwui.force_dark true; settings put global force_dark_mode_on 1; \
settings put secure hwui_force_dark 1; settings put secure aosp_force_dark_mode 1; \
settings put secure op_force_dark_entire_world 1; true",
        ("forceDark", false) => "setprop debug.hwui.force_dark false; settings put global force_dark_mode_on 0; \
settings put secure hwui_force_dark 0; settings put secure aosp_force_dark_mode 0; \
settings put secure op_force_dark_entire_world 0; true",
        _ => return Err(format!("unknown tweak (use one of {})", TWEAKS.join(", "))),
    })
}

/* ------------------------------ app detail ------------------------------ */

#[derive(Debug, Default, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppDetail {
    pub package: String,
    #[serde(flatten)]
    pub dump: PackageDump,
    pub ops: BTreeMap<String, String>,
    pub bucket: Option<String>,
    /// `user`, `system`, or null when the app is not exempt from Doze.
    pub battery_exempt: Option<String>,
    /// Null when the phone cannot block one app's network.
    pub network_allowed: Option<bool>,
}

fn detail_script(package: &str) -> String {
    format!(
        "echo @@ops; cmd appops get {p} 2>/dev/null || appops get {p} 2>&1; \
echo @@bucket; am get-standby-bucket {p} 2>&1; \
echo @@idle; dumpsys deviceidle whitelist 2>&1; \
echo @@net; cmd connectivity get-package-networking-enabled {p} 2>&1; \
echo @@pkg; dumpsys package {p} 2>&1; true",
        p = package
    )
}

/// Split the detail script's output at its `@@name` markers.
fn sections(text: &str) -> BTreeMap<&str, String> {
    const NAMES: [&str; 5] = ["ops", "bucket", "idle", "net", "pkg"];
    let mut out: BTreeMap<&str, String> = BTreeMap::new();
    let mut current = "";
    for line in text.lines() {
        if let Some(name) = line.trim().strip_prefix("@@").and_then(|n| NAMES.into_iter().find(|m| *m == n)) {
            current = name;
            continue;
        }
        let entry = out.entry(current).or_default();
        entry.push_str(line);
        entry.push('\n');
    }
    out
}

pub fn parse_detail(text: &str, package: &str) -> Result<AppDetail, String> {
    let parts = sections(text);
    let get = |name: &str| parts.get(name).map(String::as_str).unwrap_or("");
    let dump = parse_package_dump(get("pkg"), package).ok_or_else(|| format!("{package} is not installed on this phone"))?;
    Ok(AppDetail {
        package: package.to_string(),
        dump,
        ops: parse_appops(get("ops")),
        bucket: parse_bucket(get("bucket")),
        battery_exempt: parse_idle_exempt(get("idle"), package),
        network_allowed: parse_networking(get("net")),
    })
}

/* --------------------------------- ops --------------------------------- */

async fn shell(adb: &Path, serial: &str, command: &str) -> Result<String, String> {
    adb_text(adb, &[String::from("-s"), serial.into(), "shell".into(), command.into()]).await
}

fn package_arg(arg: Option<&str>) -> Result<&str, String> {
    let package = arg.unwrap_or("").trim();
    if valid_package(package) {
        Ok(package)
    } else {
        Err("package name is not valid".into())
    }
}

pub async fn app_detail(adb: &Path, serial: &str, package: &str) -> Result<AppDetail, String> {
    parse_detail(&shell(adb, serial, &detail_script(package)).await?, package)
}

fn json<T: Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string(value).map_err(|e| e.to_string())
}

/// The ops this module handles; `None` for any other op name.
pub async fn run(adb: &Path, serial: &str, op: &str, arg: Option<&str>, arg2: Option<&str>) -> Option<Result<String, String>> {
    let result = match op {
        "appDetail" => async {
            let package = package_arg(arg)?;
            json(&app_detail(adb, serial, package).await?)
        }
        .await,
        "appop" => async {
            let package = package_arg(arg)?;
            let (name, mode) = arg2.unwrap_or("").split_once('=').ok_or("use OP=mode")?;
            if !valid_op(name) || !OP_MODES.contains(&mode) {
                return Err(format!("app op must be NAME=one of {}", OP_MODES.join("/")));
            }
            shell(adb, serial, &format!("cmd appops set {package} {name} {mode}")).await?;
            let now = shell(adb, serial, &format!("cmd appops get {package} {name}")).await.unwrap_or_default();
            let read = parse_appops(&now).get(name).cloned();
            match read {
                Some(got) if got == mode || mode == "default" => Ok(format!("{name}: {got}")),
                Some(got) => Err(format!("{name} is still {got}")),
                None => Ok(format!("{name}: {mode}")),
            }
        }
        .await,
        "permission" => async {
            let package = package_arg(arg)?;
            let (verb, name) = arg2.unwrap_or("").split_once(':').ok_or("use grant:PERMISSION or revoke:PERMISSION")?;
            if !matches!(verb, "grant" | "revoke") || !valid_permission(name) {
                return Err("use grant:PERMISSION or revoke:PERMISSION".into());
            }
            shell(adb, serial, &format!("pm {verb} --user 0 {package} {name}")).await?;
            Ok(format!("{} {name}", if verb == "grant" { "granted" } else { "revoked" }))
        }
        .await,
        "standby" => async {
            let package = package_arg(arg)?;
            let bucket = arg2.unwrap_or("").trim();
            if !BUCKETS.contains(&bucket) {
                return Err(format!("bucket must be one of {}", BUCKETS.join(", ")));
            }
            shell(adb, serial, &format!("am set-standby-bucket {package} {bucket}")).await?;
            let now = shell(adb, serial, &format!("am get-standby-bucket {package}")).await.unwrap_or_default();
            Ok(format!("bucket: {}", parse_bucket(&now).unwrap_or_else(|| bucket.to_string())))
        }
        .await,
        "batteryExempt" => async {
            let package = package_arg(arg)?;
            let sign = if on_off(arg2)? { '+' } else { '-' };
            shell(
                adb,
                serial,
                &format!("dumpsys deviceidle whitelist {sign}{package} 2>&1 || cmd deviceidle whitelist {sign}{package} 2>&1"),
            )
            .await?;
            let list = shell(adb, serial, "dumpsys deviceidle whitelist").await.unwrap_or_default();
            match (sign, parse_idle_exempt(&list, package)) {
                ('+', Some(_)) => Ok("exempt from battery optimisation".into()),
                ('-', None) => Ok("battery optimised".into()),
                ('-', Some(kind)) if kind == "system" => Err("the phone itself keeps this app exempt".into()),
                _ => Err("the phone did not take the change".into()),
            }
        }
        .await,
        "netBlock" => async {
            let package = package_arg(arg)?;
            let block = on_off(arg2)?;
            let set = format!(
                "{}cmd connectivity set-package-networking-enabled {} {package} 2>&1",
                if block { "cmd connectivity set-chain3-enabled true 2>&1; " } else { "" },
                !block
            );
            let said = shell(adb, serial, &set).await.unwrap_or_else(|e| e);
            let now = shell(adb, serial, &format!("cmd connectivity get-package-networking-enabled {package} 2>&1")).await.unwrap_or_else(|e| e);
            match parse_networking(&now) {
                Some(allowed) if allowed != block => Ok(if block { "network blocked".into() } else { "network allowed".into() }),
                Some(_) => Err(format!("the phone did not take the change: {}", said.trim())),
                None => Err("this phone cannot block one app's network (Android 13+ with cmd connectivity)".into()),
            }
        }
        .await,
        "appState" => async {
            let package = package_arg(arg)?;
            let command = match arg2.unwrap_or("") {
                "suspend" => "pm suspend --user 0",
                "unsuspend" => "pm unsuspend --user 0",
                "disable" => "pm disable-user --user 0",
                "enable" => "pm enable --user 0",
                "uninstallUser" => "pm uninstall -k --user 0",
                "restore" => "cmd package install-existing --user 0",
                _ => return Err("use suspend, unsuspend, disable, enable, uninstallUser or restore".into()),
            };
            shell(adb, serial, &format!("{command} {package}")).await
        }
        .await,
        "activities" => async {
            let package = package_arg(arg)?;
            json(&activities(adb, serial, package).await?)
        }
        .await,
        "assistLaunch" => async {
            let package = package_arg(arg)?;
            let activity = arg2.unwrap_or("").trim();
            if !valid_class(activity) {
                return Err("activity name is not valid".into());
            }
            let component = sh_quote(&format!("{package}/{activity}"));
            // The assist key opens the "assistant" component, even one the app
            // does not export. Both settings are put back afterwards.
            let script = format!(
                "a=$(settings get secure assistant); v=$(settings get secure voice_interaction_service); \
settings put secure assistant {component}; settings put secure voice_interaction_service ''; \
input keyevent 219; sleep 1; \
if [ \"$a\" = null ]; then settings delete secure assistant; else settings put secure assistant \"$a\"; fi; \
if [ \"$v\" = null ]; then settings delete secure voice_interaction_service; else settings put secure voice_interaction_service \"$v\"; fi; \
echo opened"
            );
            shell(adb, serial, &script).await.map(|_| format!("opened {package}/{activity}"))
        }
        .await,
        "intent" => async {
            let verb = match arg.unwrap_or("").trim() {
                "broadcast" => "broadcast",
                "start" => "start",
                _ => return Err("use broadcast or start".into()),
            };
            let args = intent_args(arg2.unwrap_or(""))?;
            shell(adb, serial, &format!("am {verb} {args}")).await
        }
        .await,
        "shizuku" => shizuku(adb, serial, arg.unwrap_or("status")).await,
        "tweak" => async {
            let name = arg.unwrap_or("").trim();
            match arg2.map(str::trim).unwrap_or("status") {
                "status" => {}
                state => {
                    let command = tweak_command(name, on_off(Some(state))?)?;
                    shell(adb, serial, command).await?;
                }
            }
            json(&parse_tweaks(&shell(adb, serial, TWEAK_STATUS).await?))
        }
        .await,
        _ => return None,
    };
    Some(result)
}

/// Activities from the app's manifest: the APK is copied to the computer and read there.
async fn activities(adb: &Path, serial: &str, package: &str) -> Result<Vec<crate::app_icon::ManifestActivity>, String> {
    let listed = shell(adb, serial, &format!("pm path {package}")).await?;
    let remote = listed
        .lines()
        .filter_map(|l| l.trim().strip_prefix("package:"))
        .find(|p| p.ends_with("base.apk"))
        .or_else(|| listed.lines().find_map(|l| l.trim().strip_prefix("package:")))
        .ok_or("the app isn't installed on this phone")?
        .to_string();
    let temp = crate::paths::app_temp_dir().join(format!("activities-{}-{package}.apk", serial.replace([':', '/', '\\'], "_")));
    let _ = std::fs::create_dir_all(temp.parent().unwrap_or(Path::new(".")));
    adb_text(adb, &["-s".into(), serial.into(), "pull".into(), remote, temp.display().to_string()]).await?;
    let read = tokio::task::spawn_blocking({
        let temp = temp.clone();
        move || crate::app_icon::activities_from_apk(&temp)
    })
    .await
    .map_err(|e| e.to_string());
    let _ = std::fs::remove_file(&temp);
    read?
}

async fn shizuku(adb: &Path, serial: &str, action: &str) -> Result<String, String> {
    let status = || async {
        let pid = shell(adb, serial, "pidof shizuku_server 2>/dev/null; true").await.unwrap_or_default();
        let pid = pid.trim().to_string();
        if !pid.is_empty() {
            return Ok::<_, String>(format!("running (pid {pid})"));
        }
        let path = shell(adb, serial, &format!("pm path {SHIZUKU_PACKAGE} 2>/dev/null; true")).await.unwrap_or_default();
        Ok(if path.contains("package:") { "not running".to_string() } else { "not installed".to_string() })
    };
    match action {
        "status" => status().await,
        "start" => {
            if status().await?.starts_with("running") {
                return status().await;
            }
            let dump = shell(adb, serial, &format!("dumpsys package {SHIZUKU_PACKAGE}")).await?;
            let dump = parse_package_dump(&dump, SHIZUKU_PACKAGE).ok_or("Shizuku is not installed on this phone")?;
            let starter = shizuku_starter(&dump);
            // Newer Shizuku ships the starter as a native library; old releases
            // wrote start.sh to shared storage.
            let script = match starter {
                Some(path) => format!(
                    "if [ -f {q} ]; then {q}; elif [ -f /sdcard/Android/data/{SHIZUKU_PACKAGE}/start.sh ]; then sh /sdcard/Android/data/{SHIZUKU_PACKAGE}/start.sh; else echo 'Shizuku start file is missing: open Shizuku once on the phone'; exit 1; fi",
                    q = sh_quote(&path)
                ),
                None => format!("sh /sdcard/Android/data/{SHIZUKU_PACKAGE}/start.sh"),
            };
            let out = tokio::time::timeout(std::time::Duration::from_secs(30), shell(adb, serial, &script))
                .await
                .map_err(|_| "Shizuku did not start within 30 s".to_string())??;
            let now = status().await?;
            if now.starts_with("running") {
                Ok(now)
            } else {
                Err(format!("Shizuku did not start: {}", out.lines().last().unwrap_or("").trim()))
            }
        }
        _ => Err("use status or start".into()),
    }
}

/* ------------------------------ mock fleet ------------------------------ */

/// Answers for the mock fleet (no adb), so the UI can be used and tested.
pub mod mock {
    use super::*;
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};

    #[derive(Default)]
    struct Phone {
        ops: BTreeMap<String, String>,
        permissions: BTreeMap<String, bool>,
        bucket: Option<String>,
        exempt: bool,
        blocked: bool,
        suspended: bool,
        disabled: bool,
        tweaks: TweakStatus,
        shizuku: bool,
    }

    fn phones() -> &'static Mutex<HashMap<String, Phone>> {
        static PHONES: OnceLock<Mutex<HashMap<String, Phone>>> = OnceLock::new();
        PHONES.get_or_init(Default::default)
    }

    fn fresh() -> Phone {
        Phone {
            ops: [("CAMERA", "allow"), ("RUN_ANY_IN_BACKGROUND", "allow"), ("WAKE_LOCK", "allow"), ("SYSTEM_ALERT_WINDOW", "default")]
                .into_iter()
                .map(|(a, b)| (a.to_string(), b.to_string()))
                .collect(),
            permissions: [("android.permission.CAMERA", true), ("android.permission.POST_NOTIFICATIONS", false), ("android.permission.RECORD_AUDIO", false)]
                .into_iter()
                .map(|(a, b)| (a.to_string(), b))
                .collect(),
            bucket: Some("working_set".into()),
            ..Default::default()
        }
    }

    pub fn run(device: &str, op: &str, arg: Option<&str>, arg2: Option<&str>) -> Option<Result<String, String>> {
        let mut all = phones().lock().unwrap_or_else(|e| e.into_inner());
        let phone = all.entry(device.to_string()).or_insert_with(fresh);
        let result = (|| match op {
            "appDetail" => {
                let package = package_arg(arg)?;
                json(&AppDetail {
                    package: package.into(),
                    dump: PackageDump {
                        uid: Some(10234),
                        version_name: Some("1.0".into()),
                        version_code: Some("1".into()),
                        target_sdk: Some(34),
                        installed: true,
                        suspended: phone.suspended,
                        disabled: phone.disabled,
                        system: false,
                        permissions: phone.permissions.iter().map(|(n, g)| Permission { name: n.clone(), granted: *g }).collect(),
                        library_dir: None,
                        cpu_abi: None,
                    },
                    ops: phone.ops.clone(),
                    bucket: phone.bucket.clone(),
                    battery_exempt: phone.exempt.then(|| "user".into()),
                    network_allowed: Some(!phone.blocked),
                })
            }
            "appop" => {
                package_arg(arg)?;
                let (name, mode) = arg2.unwrap_or("").split_once('=').ok_or("use OP=mode")?;
                if !valid_op(name) || !OP_MODES.contains(&mode) {
                    return Err("app op must be NAME=mode".into());
                }
                phone.ops.insert(name.into(), mode.into());
                Ok(format!("{name}: {mode}"))
            }
            "permission" => {
                package_arg(arg)?;
                let (verb, name) = arg2.unwrap_or("").split_once(':').ok_or("use grant:PERMISSION")?;
                if !matches!(verb, "grant" | "revoke") || !valid_permission(name) {
                    return Err("use grant:PERMISSION or revoke:PERMISSION".into());
                }
                phone.permissions.insert(name.into(), verb == "grant");
                Ok(format!("{} {name}", if verb == "grant" { "granted" } else { "revoked" }))
            }
            "standby" => {
                package_arg(arg)?;
                let bucket = arg2.unwrap_or("");
                if !BUCKETS.contains(&bucket) {
                    return Err("bucket is not valid".into());
                }
                phone.bucket = Some(bucket.into());
                Ok(format!("bucket: {bucket}"))
            }
            "batteryExempt" => {
                package_arg(arg)?;
                phone.exempt = on_off(arg2)?;
                Ok(if phone.exempt { "exempt from battery optimisation".into() } else { "battery optimised".into() })
            }
            "netBlock" => {
                package_arg(arg)?;
                phone.blocked = on_off(arg2)?;
                Ok(if phone.blocked { "network blocked".into() } else { "network allowed".into() })
            }
            "appState" => {
                let package = package_arg(arg)?;
                match arg2.unwrap_or("") {
                    "suspend" => phone.suspended = true,
                    "unsuspend" => phone.suspended = false,
                    "disable" => phone.disabled = true,
                    "enable" => phone.disabled = false,
                    "uninstallUser" | "restore" => {}
                    _ => return Err("use suspend, unsuspend, disable, enable, uninstallUser or restore".into()),
                }
                Ok(format!("{} {package}", arg2.unwrap_or("")))
            }
            "activities" => {
                let package = package_arg(arg)?;
                json(&[
                    crate::app_icon::ManifestActivity { name: format!("{package}.MainActivity"), exported: true, launcher: true },
                    crate::app_icon::ManifestActivity { name: format!("{package}.SettingsActivity"), exported: false, launcher: false },
                ])
            }
            "assistLaunch" => {
                let package = package_arg(arg)?;
                let activity = arg2.unwrap_or("");
                if !valid_class(activity) {
                    return Err("activity name is not valid".into());
                }
                Ok(format!("opened {package}/{activity}"))
            }
            "intent" => {
                if !matches!(arg.unwrap_or(""), "broadcast" | "start") {
                    return Err("use broadcast or start".into());
                }
                intent_args(arg2.unwrap_or("")).map(|args| format!("sent: {args}"))
            }
            "shizuku" => match arg.unwrap_or("status") {
                "status" => Ok(if phone.shizuku { "running (pid 4242)".into() } else { "not running".into() }),
                "start" => {
                    phone.shizuku = true;
                    Ok("running (pid 4242)".into())
                }
                _ => Err("use status or start".into()),
            },
            "tweak" => {
                let name = arg.unwrap_or("");
                match arg2.unwrap_or("status") {
                    "status" => {}
                    state => {
                        let on = on_off(Some(state))?;
                        tweak_command(name, on)?;
                        match name {
                            "devOptionsHidden" => phone.tweaks.dev_options_hidden = on,
                            "phantomKillerOff" => phone.tweaks.phantom_killer_off = on,
                            _ => phone.tweaks.force_dark = on,
                        }
                    }
                }
                json(&phone.tweaks)
            }
            _ => Err(String::new()),
        })();
        match result {
            Err(e) if e.is_empty() => None,
            other => Some(other),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_ops_prefer_package_lines() {
        let text = "Uid mode: COARSE_LOCATION: ignore\nUid mode: CAMERA: deny\nCAMERA: allow; time=+2d3h ago; duration=+1ms\nWAKE_LOCK: mode=ignore; rejectTime=+1h\nRUN_ANY_IN_BACKGROUND: allow\nNo operations.\nbad line\n";
        let ops = parse_appops(text);
        assert_eq!(ops.get("CAMERA").map(String::as_str), Some("allow"));
        assert_eq!(ops.get("COARSE_LOCATION").map(String::as_str), Some("ignore"));
        assert_eq!(ops.get("WAKE_LOCK").map(String::as_str), Some("ignore"));
        assert_eq!(ops.len(), 4);
    }

    #[test]
    fn buckets_and_doze() {
        assert_eq!(parse_bucket("10\n").as_deref(), Some("active"));
        assert_eq!(parse_bucket("45").as_deref(), Some("restricted"));
        assert_eq!(parse_bucket("rare").as_deref(), Some("rare"));
        assert_eq!(parse_bucket("Error"), None);
        let list = "system-excidle,com.android.shell,2000\nsystem,com.google.gms,10100\nuser,com.game,10234\n";
        assert_eq!(parse_idle_exempt(list, "com.game").as_deref(), Some("user"));
        assert_eq!(parse_idle_exempt(list, "com.google.gms").as_deref(), Some("system"));
        assert_eq!(parse_idle_exempt(list, "com.other"), None);
    }

    #[test]
    fn networking_answers() {
        assert_eq!(parse_networking("true"), Some(true));
        assert_eq!(parse_networking("false\n"), Some(false));
        assert_eq!(parse_networking("Unknown command: get-package-networking-enabled"), None);
        assert_eq!(parse_networking(""), None);
    }

    const DUMP: &str = "Activity Resolver Table:\n  Non-Data Actions:\n      android.intent.action.MAIN:\n        1a2b com.game/.Main filter 3c\nPackages:\n  Package [com.game] (8d1c2e4):\n    userId=10234\n    pkg=Package{8d1c2e4 com.game}\n    codePath=/data/app/~~AbC==/com.game-XyZ==\n    legacyNativeLibraryDir=/data/app/~~AbC==/com.game-XyZ==/lib\n    primaryCpuAbi=arm64-v8a\n    secondaryCpuAbi=null\n    versionCode=321 minSdk=24 targetSdk=34\n    versionName=3.2.1\n    flags=[ HAS_CODE ALLOW_CLEAR_USER_DATA ]\n    pkgFlags=[ HAS_CODE ALLOW_CLEAR_USER_DATA ]\n    requested permissions:\n      android.permission.INTERNET\n      android.permission.CAMERA\n    install permissions:\n      android.permission.INTERNET: granted=true\n    User 0: ceDataInode=123 installed=true hidden=false suspended=true distractionFlags=0 stopped=false notLaunched=false enabled=3 instant=false virtual=false\n      gids=[3003]\n      runtime permissions:\n        android.permission.CAMERA: granted=false, flags=[ USER_SENSITIVE_WHEN_GRANTED ]\n        android.permission.POST_NOTIFICATIONS: granted=true, flags=[ USER_SET ]\n    User 10: ceDataInode=0 installed=false hidden=false suspended=false enabled=0\n      runtime permissions:\n        android.permission.RECORD_AUDIO: granted=true\n  Package [com.other] (1):\n    userId=10300\n\nQueries:\n";

    #[test]
    fn reads_the_package_block() {
        let dump = parse_package_dump(DUMP, "com.game").expect("package");
        assert_eq!(dump.uid, Some(10234));
        assert_eq!(dump.version_name.as_deref(), Some("3.2.1"));
        assert_eq!(dump.version_code.as_deref(), Some("321"));
        assert_eq!(dump.target_sdk, Some(34));
        assert!(dump.installed && dump.suspended && dump.disabled && !dump.system);
        assert_eq!(
            dump.permissions,
            vec![
                Permission { name: "android.permission.CAMERA".into(), granted: false },
                Permission { name: "android.permission.POST_NOTIFICATIONS".into(), granted: true },
            ]
        );
        assert_eq!(shizuku_starter(&dump).as_deref(), Some("/data/app/~~AbC==/com.game-XyZ==/lib/arm64/libshizuku.so"));
        assert_eq!(parse_package_dump(DUMP, "com.other").and_then(|d| d.uid), Some(10300));
        assert_eq!(parse_package_dump(DUMP, "com.missing"), None);
    }

    #[test]
    fn detail_splits_the_script_output() {
        let text = format!("@@ops\nCAMERA: ignore\n@@bucket\n40\n@@idle\nuser,com.game,10234\n@@net\nfalse\n@@pkg\n{DUMP}");
        let detail = parse_detail(&text, "com.game").unwrap();
        assert_eq!(detail.ops.get("CAMERA").map(String::as_str), Some("ignore"));
        assert_eq!(detail.bucket.as_deref(), Some("rare"));
        assert_eq!(detail.battery_exempt.as_deref(), Some("user"));
        assert_eq!(detail.network_allowed, Some(false));
        let json = serde_json::to_value(&detail).unwrap();
        assert_eq!(json["uid"], 10234);
        assert_eq!(json["networkAllowed"], false);
        assert!(json.get("libraryDir").is_none());
        assert!(parse_detail("@@pkg\nUnable to find package: com.x\n", "com.x").is_err());
    }

    #[test]
    fn intent_args_are_checked_and_quoted() {
        assert_eq!(
            intent_args("-a com.app.START -n com.app/.Rx --es mode 'fast lane' --ez on true --ei n 3").unwrap(),
            "-a 'com.app.START' -n 'com.app/.Rx' --es 'mode' 'fast lane' --ez 'on' 'true' --ei 'n' '3'"
        );
        assert_eq!(intent_args("-d \"x; rm -rf /\"").unwrap(), "-d 'x; rm -rf /'");
        assert!(intent_args("-a com.app.START; reboot").is_err());
        assert!(intent_args("--ez on maybe").is_err());
        assert!(intent_args("--ei n 3.5").is_err());
        assert!(intent_args("-n noslash").is_err());
        assert!(intent_args("--user 0").is_err());
        assert!(intent_args("-a 'open").is_err());
        assert!(intent_args("").is_err());
        assert!(intent_args("-f 0x10000000 -a x.y").is_ok());
    }

    #[test]
    fn tweaks_never_turn_adb_off() {
        for name in TWEAKS {
            for on in [true, false] {
                let command = tweak_command(name, on).unwrap();
                assert!(!command.contains("adb_enabled 0"), "{command}");
            }
        }
        assert!(tweak_command("devOptionsHidden", true).unwrap().contains("adb_enabled 1"));
        assert!(tweak_command("nope", true).is_err());
        let status = parse_tweaks("dev=0\nphantom=false\ndark=\ndarkg=1\n");
        assert_eq!(status, TweakStatus { dev_options_hidden: true, phantom_killer_off: true, force_dark: true });
        assert_eq!(parse_tweaks("dev=1\nphantom=null\ndark=false\ndarkg=null\n"), TweakStatus::default());
    }

    #[test]
    fn allow_lists() {
        assert!(valid_op("RUN_ANY_IN_BACKGROUND"));
        assert!(!valid_op("camera"));
        assert!(!valid_op("A;B"));
        assert!(valid_class(".Main$Inner"));
        assert!(!valid_class("a b"));
        assert_eq!(abi_dir("armeabi-v7a"), Some("arm"));
        assert_eq!(abi_dir("mips"), None);
    }

    #[test]
    fn mock_ops_keep_state_per_phone() {
        let set = mock::run("mock-a", "appop", Some("com.game"), Some("CAMERA=ignore")).unwrap();
        assert_eq!(set.unwrap(), "CAMERA: ignore");
        let detail = mock::run("mock-a", "appDetail", Some("com.game"), None).unwrap().unwrap();
        assert!(detail.contains("\"CAMERA\":\"ignore\""), "{detail}");
        let other = mock::run("mock-b", "appDetail", Some("com.game"), None).unwrap().unwrap();
        assert!(other.contains("\"CAMERA\":\"allow\""));
        assert!(mock::run("mock-a", "tweak", Some("forceDark"), Some("on")).unwrap().unwrap().contains("\"forceDark\":true"));
        assert!(mock::run("mock-a", "nothing", None, None).is_none());
        assert!(mock::run("mock-a", "appop", Some("bad pkg"), Some("CAMERA=allow")).unwrap().is_err());
    }
}
