//! Notifications for recorded events: Discord webhooks.
//!
//! Settings live in `config/monitoring.json` in the data folder, not in the
//! shared store: the store is sent to every browser, and the webhook URL is a
//! secret. The API only ever says whether a webhook is set (and the last
//! digits of its id); the URL is never returned, logged or put in an event.
//!
//! `offer` is called for every new event and never blocks: it applies the
//! rules (per-category level, cooldown per kind and phone) and puts the event
//! on a bounded queue. One worker sends the queue to Discord in batches (up
//! to 10 embeds per message), with timeouts and bounded retries that honour
//! Discord's rate limits. A full queue drops events (counted); a Discord
//! outage only fails notifications, never the event history, device
//! operations or macro runs.
//!
//! Another destination (a generic webhook, Telegram, email) would be a second
//! sender next to `deliver_discord`, reusing the same rules and queue.

use crate::events::{self, now_ms, redact, Event, Retention, Severity};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

const FILE_NAME: &str = "monitoring.json";
const QUEUE: usize = 256;
/// Events arriving this soon after the first one go in the same message.
const BATCH_WAIT: Duration = Duration::from_millis(1500);
const MAX_EMBEDS: usize = 10;
/// Discord allows 6000 characters of embeds per message; stay under it.
const EMBED_BUDGET: usize = 5500;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_ATTEMPTS: u32 = 4;
pub const MAX_COOLDOWN_SECS: u64 = 86_400;
/// A failing webhook is reported in the history at most this often.
const FAILURE_EVENT_EVERY_MS: u64 = 10 * 60_000;

/* ------------------------------ settings ------------------------------ */

/// Notification level per category: `off`, or the lowest severity sent.
pub const LEVELS: &[&str] = &["off", "info", "warning", "error", "critical"];

fn default_levels() -> BTreeMap<String, String> {
    [("device", "warning"), ("macro", "warning"), ("app", "error"), ("scrcpy", "off"), ("adb", "warning"), ("system", "warning")]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Discord on or off (the URL is kept when off).
    pub enabled: bool,
    pub webhook_url: String,
    /// Category → level (see [`LEVELS`]).
    pub categories: BTreeMap<String, String>,
    /// `brief` (title, phone, time) or `full` (also the details).
    pub detail: String,
    /// The same kind of event for the same phone is sent at most once per cooldown.
    pub cooldown_secs: u64,
    /// How much event history is kept.
    pub history: Retention,
}

impl Default for Settings {
    fn default() -> Self {
        Self { enabled: true, webhook_url: String::new(), categories: default_levels(), detail: "full".into(), cooldown_secs: 120, history: Retention::default() }
    }
}

impl Settings {
    fn level(&self, category: &str) -> Option<Severity> {
        match self.categories.get(category).map(String::as_str).unwrap_or("off") {
            "debug" => Some(Severity::Debug),
            "info" => Some(Severity::Info),
            "warning" => Some(Severity::Warning),
            "error" => Some(Severity::Error),
            "critical" => Some(Severity::Critical),
            _ => None,
        }
    }

    /// Would `event` be sent (before the cooldown)?
    pub fn wants(&self, event: &Event) -> bool {
        self.enabled
            && !self.webhook_url.is_empty()
            && event.category != "notification"
            && self.level(&event.category).is_some_and(|min| event.severity >= min)
    }
}

/// Discord's webhook hosts. Anything else is refused, so the setting cannot
/// be used to make ADBoard post to arbitrary addresses.
const DISCORD_HOSTS: &[&str] = &["discord.com", "discordapp.com", "ptb.discord.com", "canary.discord.com"];
const URL_HELP: &str = "Paste the webhook URL from Discord: channel settings → Integrations → Webhooks → Copy Webhook URL";

/// Checks a webhook URL. Errors never repeat the URL.
pub fn validate_webhook(url: &str) -> Result<(), String> {
    let url = url.trim();
    if url.len() > 512 {
        return Err("That webhook URL is too long".into());
    }
    let rest = url.strip_prefix("https://").ok_or_else(|| format!("Not a Discord webhook URL. {URL_HELP}"))?;
    let (host, path) = rest.split_once('/').ok_or_else(|| format!("Not a Discord webhook URL. {URL_HELP}"))?;
    if !DISCORD_HOSTS.contains(&host.to_ascii_lowercase().as_str()) {
        return Err(format!("Only Discord webhooks are supported. {URL_HELP}"));
    }
    static PATH: OnceLock<regex::Regex> = OnceLock::new();
    let pattern = PATH.get_or_init(|| regex::Regex::new(r"^api(?:/v\d{1,2})?/webhooks/\d{5,30}/[A-Za-z0-9_\-]{20,200}$").expect("regex"));
    if !pattern.is_match(path) {
        return Err(format!("That is not a complete webhook URL. {URL_HELP}"));
    }
    Ok(())
}

/// "…1234": the last digits of the webhook id, so users can tell webhooks apart.
fn webhook_hint(url: &str) -> Option<String> {
    let id = url.split("/webhooks/").nth(1)?.split('/').next()?;
    let tail: String = id.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
    (!tail.is_empty()).then(|| format!("…{tail}"))
}

/// Settings as the browser sees them: never the URL.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicSettings {
    pub enabled: bool,
    pub webhook_set: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub webhook_hint: Option<String>,
    pub categories: BTreeMap<String, String>,
    pub detail: String,
    pub cooldown_secs: u64,
    pub history: Retention,
    pub status: Status,
}

/// A change from the Settings page; missing fields stay as they are.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Update {
    pub enabled: Option<bool>,
    /// `""` removes the webhook.
    pub webhook_url: Option<String>,
    pub categories: Option<BTreeMap<String, String>>,
    pub detail: Option<String>,
    pub cooldown_secs: Option<u64>,
    pub history: Option<Retention>,
}

impl Settings {
    pub fn apply(&self, update: Update) -> Result<Settings, String> {
        let mut next = self.clone();
        if let Some(enabled) = update.enabled {
            next.enabled = enabled;
        }
        if let Some(url) = update.webhook_url {
            let url = url.trim().to_string();
            if !url.is_empty() {
                validate_webhook(&url)?;
            }
            next.webhook_url = url;
        }
        if let Some(categories) = update.categories {
            for (category, level) in categories {
                if !events::CATEGORIES.contains(&category.as_str()) || category == "notification" {
                    return Err(format!("Unknown event category “{category}”"));
                }
                if !LEVELS.contains(&level.as_str()) {
                    return Err(format!("“{level}” is not a notification level"));
                }
                next.categories.insert(category, level);
            }
        }
        if let Some(detail) = update.detail {
            if detail != "brief" && detail != "full" {
                return Err("Detail is brief or full".into());
            }
            next.detail = detail;
        }
        if let Some(cooldown) = update.cooldown_secs {
            if cooldown > MAX_COOLDOWN_SECS {
                return Err("The cooldown is at most 24 hours".into());
            }
            next.cooldown_secs = cooldown;
        }
        if let Some(history) = update.history {
            next.history = history.clamped();
        }
        Ok(next)
    }
}

/* ------------------------------ status ------------------------------ */

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_attempt_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_ok_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error_at: Option<u64>,
    /// Events sent, failed after every retry, dropped (queue full or
    /// Discord turned off meanwhile), and held back by the cooldown.
    pub sent: u64,
    pub failed: u64,
    pub dropped: u64,
    pub suppressed: u64,
    pub queued: usize,
}

struct Notifier {
    settings: RwLock<Settings>,
    /// Set by `init` in the real process; tests keep settings in memory.
    path: OnceLock<PathBuf>,
    status: Mutex<Status>,
    /// kind|phone → (last sent, held back since).
    cooldowns: Mutex<HashMap<String, (u64, u32)>>,
    queue: OnceLock<tokio::sync::mpsc::Sender<Event>>,
    last_offered: Mutex<u64>,
    last_failure_event: Mutex<u64>,
}

fn notifier() -> &'static Notifier {
    static N: OnceLock<Notifier> = OnceLock::new();
    N.get_or_init(|| Notifier {
        settings: RwLock::new(Settings::default()),
        path: OnceLock::new(),
        status: Mutex::new(Status::default()),
        cooldowns: Mutex::new(HashMap::new()),
        queue: OnceLock::new(),
        last_offered: Mutex::new(0),
        last_failure_event: Mutex::new(0),
    })
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn settings_path() -> PathBuf {
    crate::data_dir::config_dir().join(FILE_NAME)
}

/// Load the settings file (before the event history opens, for its retention).
pub fn init() -> Settings {
    let path = settings_path();
    let loaded = match std::fs::read(&path) {
        Ok(bytes) => match serde_json::from_slice::<Settings>(&bytes) {
            Ok(mut settings) => {
                // A hand-edited file with a bad URL turns Discord off rather than posting elsewhere.
                if !settings.webhook_url.is_empty() && validate_webhook(&settings.webhook_url).is_err() {
                    tracing::warn!("the Discord webhook in {FILE_NAME} is not a Discord webhook URL; ignoring it");
                    settings.webhook_url.clear();
                }
                settings.history = settings.history.clamped();
                settings
            }
            Err(error) => {
                tracing::warn!(%error, "cannot read {FILE_NAME}; using defaults");
                Settings::default()
            }
        },
        Err(_) => Settings::default(),
    };
    if notifier().path.set(path).is_ok() {
        *notifier().settings.write().unwrap_or_else(|e| e.into_inner()) = loaded.clone();
    }
    loaded
}

fn save(settings: &Settings) -> Result<(), String> {
    let Some(path) = notifier().path.get() else { return Ok(()) };
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_vec_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, body).map_err(|e| format!("cannot save the notification settings: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Holds the webhook token: readable by this user only.
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, path).map_err(|e| format!("cannot save the notification settings: {e}"))
}

pub fn settings() -> Settings {
    notifier().settings.read().unwrap_or_else(|e| e.into_inner()).clone()
}

pub fn public_settings() -> PublicSettings {
    let s = settings();
    let mut status = lock(&notifier().status).clone();
    status.queued = notifier().queue.get().map(|q| QUEUE - q.capacity()).unwrap_or(0);
    PublicSettings {
        enabled: s.enabled,
        webhook_set: !s.webhook_url.is_empty(),
        webhook_hint: webhook_hint(&s.webhook_url),
        categories: s.categories,
        detail: s.detail,
        cooldown_secs: s.cooldown_secs,
        history: s.history,
        status,
    }
}

pub fn update(change: Update) -> Result<PublicSettings, String> {
    let n = notifier();
    let (before, next) = {
        let mut guard = n.settings.write().unwrap_or_else(|e| e.into_inner());
        let before = guard.clone();
        let next = guard.apply(change)?;
        save(&next)?;
        *guard = next.clone();
        (before, next)
    };
    if before.history != next.history {
        events::log().set_retention(next.history);
    }
    if before.webhook_url != next.webhook_url {
        // A new webhook starts with a clean slate.
        *lock(&n.status) = Status::default();
        lock(&n.cooldowns).clear();
        let what = if next.webhook_url.is_empty() { "Discord webhook removed" } else { "Discord webhook changed" };
        events::record(Event::new("notification", "notification.configured", Severity::Info, what).source("settings"));
    }
    Ok(public_settings())
}

/* ------------------------------ queue ------------------------------ */

/// Offer a new event to Discord. Never blocks and never fails the caller.
pub fn offer(event: &Event) {
    let n = notifier();
    let Some(queue) = n.queue.get() else { return };
    {
        // Each event is offered once, even if a caller records it twice.
        let mut last = lock(&n.last_offered);
        if event.id != 0 && event.id <= *last {
            return;
        }
        *last = event.id;
    }
    let s = settings();
    if !s.wants(event) {
        return;
    }
    let key = format!("{}|{}", event.kind, event.device_id.as_deref().unwrap_or(""));
    let now = now_ms();
    let held = {
        let mut cooldowns = lock(&n.cooldowns);
        let entry = cooldowns.entry(key).or_insert((0, 0));
        if entry.0 > 0 && now.saturating_sub(entry.0) < s.cooldown_secs * 1000 {
            entry.1 += 1;
            lock(&n.status).suppressed += 1;
            return;
        }
        let held = entry.1;
        *entry = (now, 0);
        held
    };
    let mut event = event.clone();
    if held > 0 {
        event.meta.insert("heldBack".into(), held.into());
    }
    if queue.try_send(event).is_err() {
        lock(&n.status).dropped += 1;
    }
}

/// Start the sender (once per process).
pub fn start(host: String) {
    let n = notifier();
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Event>(QUEUE);
    if n.queue.set(tx).is_err() {
        return;
    }
    tokio::spawn(async move {
        while let Some(first) = rx.recv().await {
            let mut batch = vec![first];
            tokio::time::sleep(BATCH_WAIT).await;
            while let Ok(more) = rx.try_recv() {
                batch.push(more);
                if batch.len() >= 50 {
                    break;
                }
            }
            let s = settings();
            if !s.enabled || s.webhook_url.is_empty() {
                lock(&n.status).dropped += batch.len() as u64;
                continue;
            }
            for payload in discord_payloads(&batch, &s.detail, &host) {
                let count = payload["embeds"].as_array().map(Vec::len).unwrap_or(0) as u64;
                let result = deliver_discord(&s.webhook_url, &payload, &Backoff::default()).await;
                note_result(&result, count, true);
            }
        }
    });
}

/// Update the delivery status; `report` also notes failures and recovery in
/// the history (a test send reports its own result instead).
fn note_result(result: &Result<(), String>, count: u64, report: bool) {
    let n = notifier();
    let now = now_ms();
    let was_failing = {
        let mut status = lock(&n.status);
        let was_failing = status.last_error_at.is_some_and(|e| status.last_ok_at.is_none_or(|ok| e > ok));
        status.last_attempt_at = Some(now);
        match result {
            Ok(()) => {
                status.sent += count;
                status.last_ok_at = Some(now);
            }
            Err(error) => {
                status.failed += count;
                status.last_error = Some(error.clone());
                status.last_error_at = Some(now);
            }
        }
        was_failing
    };
    if !report {
        return;
    }
    match result {
        Ok(()) if was_failing => {
            events::record(Event::new("notification", "notification.recovered", Severity::Info, "Discord notifications are being delivered again").source("discord"));
        }
        Err(error) => {
            let mut last = lock(&n.last_failure_event);
            if now.saturating_sub(*last) >= FAILURE_EVENT_EVERY_MS {
                *last = now;
                drop(last);
                events::record(
                    Event::new("notification", "notification.failed", Severity::Warning, format!("{count} Discord notification(s) could not be sent"))
                        .detail(error.clone())
                        .source("discord"),
                );
            }
        }
        _ => {}
    }
}

/// Send a test message to the saved webhook, or to `url` before saving it.
pub async fn send_test(url: Option<String>, host: &str) -> Result<String, String> {
    let typed = url.map(|u| u.trim().to_string()).filter(|u| !u.is_empty());
    // A URL that is not saved yet does not change the saved webhook's status.
    let saved_webhook = typed.is_none();
    let url = match typed {
        Some(url) => {
            validate_webhook(&url)?;
            url
        }
        None => {
            let saved = settings().webhook_url;
            if saved.is_empty() {
                return Err("Add a Discord webhook URL first".into());
            }
            saved
        }
    };
    let event = Event::new("notification", "notification.test", Severity::Info, "Test notification from ADBoard")
        .detail("If you can read this, ADBoard can post to this channel.")
        .source("settings");
    let payload = discord_payloads(&[event], "full", host).remove(0);
    let result = deliver_discord(&url, &payload, &Backoff { attempts: 2, ..Backoff::default() }).await;
    if saved_webhook {
        note_result(&result, 1, false);
    }
    match result {
        Ok(()) => {
            events::record(Event::new("notification", "notification.test", Severity::Info, "Test notification sent to Discord").source("settings"));
            Ok("Sent. Check the Discord channel.".into())
        }
        Err(error) => {
            events::record(Event::new("notification", "notification.test_failed", Severity::Warning, "Test notification failed").detail(error.clone()).source("settings"));
            Err(error)
        }
    }
}

/* ------------------------------ Discord ------------------------------ */

fn color(severity: Severity) -> u32 {
    match severity {
        Severity::Debug => 0x95a5a6,
        Severity::Info => 0x3498db,
        Severity::Warning => 0xf1c40f,
        Severity::Error => 0xe74c3c,
        Severity::Critical => 0x8e44ad,
    }
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// RFC 3339 UTC time for Discord's embed timestamp.
pub fn iso_time(ms: u64) -> String {
    let secs = ms / 1000;
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z", rem / 3600, (rem % 3600) / 60, rem % 60, ms % 1000)
}

fn embed(event: &Event, detail: &str, host: &str) -> Value {
    let full = detail == "full";
    let mut fields = Vec::new();
    if let Some(name) = &event.device_name {
        let model = event.meta.get("model").and_then(Value::as_str);
        let phone = match model {
            Some(model) if !model.is_empty() => format!("{name} ({model})"),
            _ => name.clone(),
        };
        fields.push(json!({ "name": "Phone", "value": clip(&phone, 200), "inline": true }));
    }
    if let Some(tab) = event.meta.get("macro").and_then(Value::as_str) {
        fields.push(json!({ "name": "Macro", "value": clip(tab, 200), "inline": true }));
    }
    fields.push(json!({ "name": "Severity", "value": event.severity.as_str(), "inline": true }));
    if full {
        if let Some(seconds) = event.meta.get("durationSeconds").and_then(Value::as_u64) {
            fields.push(json!({ "name": "Duration", "value": events::duration_label(seconds), "inline": true }));
        }
        if let Some(run) = &event.run_id {
            fields.push(json!({ "name": "Run", "value": clip(run, 100), "inline": true }));
        }
        if let Some(phone_host) = event.meta.get("host").and_then(Value::as_str) {
            fields.push(json!({ "name": "Host", "value": clip(phone_host, 100), "inline": true }));
        }
    }
    let mut footer = format!("ADBoard · {host} · {}", event.kind);
    if event.repeats > 0 {
        footer.push_str(&format!(" · seen {} more time(s)", event.repeats));
    }
    if let Some(held) = event.meta.get("heldBack").and_then(Value::as_u64) {
        footer.push_str(&format!(" · {held} similar held back by the cooldown"));
    }
    let mut out = json!({
        "title": clip(&event.summary, 256),
        "color": color(event.severity),
        "timestamp": iso_time(event.at),
        "fields": fields,
        "footer": { "text": clip(&footer, 2000) },
    });
    if full {
        if let Some(text) = &event.detail {
            out["description"] = Value::String(clip(&redact(text), 1500));
        }
    }
    out
}

fn embed_size(embed: &Value) -> usize {
    let s = |v: &Value| v.as_str().map(|t| t.chars().count()).unwrap_or(0);
    s(&embed["title"])
        + s(&embed["description"])
        + s(&embed["footer"]["text"])
        + embed["fields"].as_array().map(|f| f.iter().map(|x| s(&x["name"]) + s(&x["value"])).sum()).unwrap_or(0)
}

/// Messages for a batch: up to 10 embeds and Discord's size limit each.
/// Mentions are switched off so event text can never ping anyone.
pub fn discord_payloads(batch: &[Event], detail: &str, host: &str) -> Vec<Value> {
    let mut messages: Vec<Vec<Value>> = vec![Vec::new()];
    let mut used = 0;
    for event in batch {
        let embed = embed(event, detail, host);
        let size = embed_size(&embed);
        let current = messages.last_mut().expect("one message");
        if !current.is_empty() && (current.len() >= MAX_EMBEDS || used + size > EMBED_BUDGET) {
            messages.push(Vec::new());
            used = 0;
        }
        used += size;
        messages.last_mut().expect("one message").push(embed);
    }
    messages
        .into_iter()
        .filter(|m| !m.is_empty())
        .map(|embeds| json!({ "username": "ADBoard", "allowed_mentions": { "parse": [] }, "embeds": embeds }))
        .collect()
}

#[derive(Debug, Clone, Copy)]
pub struct Backoff {
    pub attempts: u32,
    /// First wait after a failure; doubles each time.
    pub base: Duration,
    /// Longest wait, also for Discord's retry-after.
    pub max_wait: Duration,
    pub timeout: Duration,
}

impl Default for Backoff {
    fn default() -> Self {
        Self { attempts: MAX_ATTEMPTS, base: Duration::from_secs(2), max_wait: Duration::from_secs(60), timeout: REQUEST_TIMEOUT }
    }
}

/// POST one message, retrying rate limits, server errors and network
/// failures up to `backoff.attempts` times. Errors never contain the URL.
pub async fn deliver_discord(url: &str, payload: &Value, backoff: &Backoff) -> Result<(), String> {
    let body = serde_json::to_vec(payload).map_err(|e| e.to_string())?;
    let mut last = String::new();
    for attempt in 1..=backoff.attempts.max(1) {
        let wait = match post_json(url, &body, backoff.timeout).await {
            Ok(reply) if (200..300).contains(&reply.status) => return Ok(()),
            Ok(reply) if reply.status == 429 => {
                last = "Discord rate limit".into();
                Duration::from_millis(reply.retry_after_ms.unwrap_or(2000)).min(backoff.max_wait)
            }
            Ok(reply) if reply.status >= 500 => {
                last = format!("Discord is not answering properly (HTTP {})", reply.status);
                (backoff.base * 2u32.pow(attempt - 1)).min(backoff.max_wait)
            }
            Ok(reply) => {
                return Err(match reply.status {
                    401 | 403 => format!("Discord refused the webhook (HTTP {})", reply.status),
                    404 => "The webhook was deleted or the URL is wrong (HTTP 404)".into(),
                    status => format!("Discord rejected the message (HTTP {status}): {}", clip(&redact(reply.body.trim()), 200)),
                });
            }
            Err(error) => {
                last = error;
                (backoff.base * 2u32.pow(attempt - 1)).min(backoff.max_wait)
            }
        };
        if attempt < backoff.attempts {
            tokio::time::sleep(wait).await;
        }
    }
    Err(format!("{last} (gave up after {} attempts)", backoff.attempts.max(1)))
}

/* ------------------------------ HTTP ------------------------------ */

pub struct Reply {
    pub status: u16,
    /// From `Retry-After`, `X-RateLimit-Reset-After` or Discord's JSON `retry_after`.
    pub retry_after_ms: Option<u64>,
    pub body: String,
}

fn tls_config() -> Arc<rustls::ClientConfig> {
    static CONFIG: OnceLock<Arc<rustls::ClientConfig>> = OnceLock::new();
    CONFIG
        .get_or_init(|| {
            let roots = rustls::RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() };
            let config = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
                .with_safe_default_protocol_versions()
                .expect("TLS versions")
                .with_root_certificates(roots)
                .with_no_client_auth();
            Arc::new(config)
        })
        .clone()
}

/// A small HTTP/1.1 POST (https or http) on the TLS stack the agent already
/// uses for wss://. Errors name the host only, never the path (it holds the
/// webhook token).
pub async fn post_json(url: &str, body: &[u8], timeout: Duration) -> Result<Reply, String> {
    let (tls, rest) = if let Some(rest) = url.strip_prefix("https://") {
        (true, rest)
    } else if let Some(rest) = url.strip_prefix("http://") {
        (false, rest)
    } else {
        return Err("unsupported URL".into());
    };
    let (authority, path) = match rest.split_once('/') {
        Some((a, p)) => (a, format!("/{p}")),
        None => (rest, "/".into()),
    };
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) => (h, p.parse::<u16>().map_err(|_| "bad port".to_string())?),
        None => (authority, if tls { 443 } else { 80 }),
    };
    let head = format!(
        "POST {path} HTTP/1.1\r\nHost: {authority}\r\nUser-Agent: ADBoard/{}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        env!("CARGO_PKG_VERSION"),
        body.len()
    );
    let exchange = async {
        let tcp = tokio::net::TcpStream::connect((host, port)).await.map_err(|e| format!("cannot reach {host}: {e}"))?;
        let raw = if tls {
            let name = rustls::pki_types::ServerName::try_from(host.to_string()).map_err(|_| format!("bad host name {host}"))?;
            let mut stream = tokio_rustls::TlsConnector::from(tls_config()).connect(name, tcp).await.map_err(|e| format!("TLS with {host} failed: {e}"))?;
            talk(&mut stream, head.as_bytes(), body).await
        } else {
            let mut stream = tcp;
            talk(&mut stream, head.as_bytes(), body).await
        }
        .map_err(|e| format!("{host}: {e}"))?;
        parse_reply(&raw).ok_or_else(|| format!("{host} sent an unreadable answer"))
    };
    tokio::time::timeout(timeout, exchange).await.map_err(|_| format!("{host} did not answer within {} s", timeout.as_secs()))?
}

async fn talk<S: AsyncRead + AsyncWrite + Unpin>(stream: &mut S, head: &[u8], body: &[u8]) -> std::io::Result<Vec<u8>> {
    stream.write_all(head).await?;
    stream.write_all(body).await?;
    stream.flush().await?;
    let mut raw = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        match stream.read(&mut chunk).await {
            Ok(0) => break,
            Ok(n) => {
                raw.extend_from_slice(&chunk[..n]);
                if raw.len() > 1 << 20 {
                    break;
                }
            }
            // Servers often close TLS without close_notify after the answer.
            Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof && !raw.is_empty() => break,
            Err(error) => return Err(error),
        }
    }
    Ok(raw)
}

fn parse_reply(raw: &[u8]) -> Option<Reply> {
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n")?;
    let head = String::from_utf8_lossy(&raw[..split]);
    let mut body = raw[split + 4..].to_vec();
    let mut lines = head.lines();
    let status: u16 = lines.next()?.split_whitespace().nth(1)?.parse().ok()?;
    let mut retry_after_ms = None;
    let mut chunked = false;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else { continue };
        let value = value.trim();
        match name.trim().to_ascii_lowercase().as_str() {
            "retry-after" | "x-ratelimit-reset-after" if retry_after_ms.is_none() || name.eq_ignore_ascii_case("retry-after") => {
                if let Ok(secs) = value.parse::<f64>() {
                    retry_after_ms = Some((secs * 1000.0).ceil() as u64);
                }
            }
            "transfer-encoding" if value.to_ascii_lowercase().contains("chunked") => chunked = true,
            _ => {}
        }
    }
    if chunked {
        body = dechunk(&body);
    }
    let body = String::from_utf8_lossy(&body).into_owned();
    if status == 429 {
        if let Some(secs) = serde_json::from_str::<Value>(&body).ok().and_then(|v| v.get("retry_after").and_then(Value::as_f64)) {
            retry_after_ms = Some((secs * 1000.0).ceil() as u64);
        }
    }
    Some(Reply { status, retry_after_ms, body })
}

fn dechunk(mut data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    while let Some(end) = data.windows(2).position(|w| w == b"\r\n") {
        let size_text = String::from_utf8_lossy(&data[..end]);
        let Ok(size) = usize::from_str_radix(size_text.split(';').next().unwrap_or("").trim(), 16) else { break };
        data = &data[end + 2..];
        if size == 0 || data.len() < size {
            out.extend_from_slice(&data[..size.min(data.len())]);
            break;
        }
        out.extend_from_slice(&data[..size]);
        data = data.get(size + 2..).unwrap_or(&[]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A local HTTP server that answers each connection with the next canned
    /// response and keeps the bodies it got.
    async fn mock_server(responses: Vec<&'static str>) -> (String, Arc<Mutex<Vec<String>>>, Arc<AtomicUsize>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/api/webhooks/123456/token", listener.local_addr().unwrap());
        let bodies = Arc::new(Mutex::new(Vec::new()));
        let hits = Arc::new(AtomicUsize::new(0));
        let (b, h) = (bodies.clone(), hits.clone());
        tokio::spawn(async move {
            let mut responses = responses.into_iter();
            while let Ok((mut socket, _)) = listener.accept().await {
                let n = h.fetch_add(1, Ordering::SeqCst);
                let mut raw = Vec::new();
                let mut buf = [0u8; 4096];
                // Read the head, then Content-Length bytes.
                loop {
                    let read = socket.read(&mut buf).await.unwrap_or(0);
                    if read == 0 {
                        break;
                    }
                    raw.extend_from_slice(&buf[..read]);
                    if let Some(split) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&raw[..split]).to_lowercase();
                        let len: usize = head.lines().find_map(|l| l.strip_prefix("content-length:")).and_then(|v| v.trim().parse().ok()).unwrap_or(0);
                        if raw.len() >= split + 4 + len {
                            b.lock().unwrap().push(String::from_utf8_lossy(&raw[split + 4..]).into_owned());
                            break;
                        }
                    }
                }
                match responses.next() {
                    Some("hang") => {
                        tokio::time::sleep(Duration::from_secs(5)).await;
                    }
                    Some(response) => {
                        let _ = socket.write_all(response.as_bytes()).await;
                    }
                    None => {
                        let _ = socket.write_all(b"HTTP/1.1 204 No Content\r\n\r\n").await;
                    }
                }
                let _ = n;
            }
        });
        (url, bodies, hits)
    }

    fn quick() -> Backoff {
        Backoff { attempts: 4, base: Duration::from_millis(20), max_wait: Duration::from_millis(300), timeout: Duration::from_millis(500) }
    }

    fn sample(kind: &str, severity: Severity) -> Event {
        let category = kind.split('.').next().unwrap();
        Event::new(category, kind, severity, format!("S24: {kind}")).device("s24", "S24").meta("model", "Galaxy S24")
    }

    #[test]
    fn webhook_urls_are_checked_without_echoing_them() {
        let good = "https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz_-0123456789";
        assert!(validate_webhook(good).is_ok());
        assert!(validate_webhook(&good.replace("discord.com/api", "discord.com/api/v10")).is_ok());
        for bad in [
            "http://discord.com/api/webhooks/123456789/AbCdEfGhIjKlMnOpQrStUvWxYz",
            "https://evil.example/api/webhooks/123456789/AbCdEfGhIjKlMnOpQrStUvWxYz",
            "https://discord.com.evil.example/api/webhooks/123456789/AbCdEfGhIjKlMnOpQrStUvWxYz",
            "https://discord.com/api/webhooks/123456789",
            "https://discord.com/api/webhooks/123456789/AbCdEfGhIjKlMnOpQrStUvWxYz?wait=1",
            "not a url",
        ] {
            let error = validate_webhook(bad).unwrap_err();
            assert!(!error.contains("AbCdEf") && !error.contains("evil"), "{error}");
        }
        assert_eq!(webhook_hint(good).as_deref(), Some("…5678"));
    }

    #[test]
    fn settings_validate_and_never_show_the_url() {
        let s = Settings::default();
        assert!(s.apply(Update { categories: Some(BTreeMap::from([("macro".into(), "loud".into())])), ..Default::default() }).is_err());
        assert!(s.apply(Update { categories: Some(BTreeMap::from([("notification".into(), "info".into())])), ..Default::default() }).is_err());
        assert!(s.apply(Update { cooldown_secs: Some(MAX_COOLDOWN_SECS + 1), ..Default::default() }).is_err());
        assert!(s.apply(Update { webhook_url: Some("https://example.com/hook".into()), ..Default::default() }).is_err());
        let url = "https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz";
        let next = s
            .apply(Update {
                webhook_url: Some(url.into()),
                categories: Some(BTreeMap::from([("macro".into(), "info".into())])),
                history: Some(Retention { max_events: 1, max_days: 99_999 }),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(next.webhook_url, url);
        assert_eq!(next.history, Retention { max_events: events::MIN_MAX_EVENTS, max_days: events::MAX_MAX_DAYS });
        assert_eq!(next.categories["device"], "warning", "other categories keep their level");
        let cleared = next.apply(Update { webhook_url: Some("  ".into()), ..Default::default() }).unwrap();
        assert!(cleared.webhook_url.is_empty());
        let public = serde_json::to_string(&public_settings()).unwrap();
        let saved = settings().webhook_url;
        assert!(!public.contains("webhookUrl") && (saved.is_empty() || !public.contains(&saved)), "{public}");
    }

    #[test]
    fn rules_pick_events_by_category_level() {
        let mut s = Settings { webhook_url: "https://discord.com/api/webhooks/1/x".into(), ..Settings::default() };
        assert!(s.wants(&sample("device.disconnected", Severity::Warning)));
        assert!(!s.wants(&sample("device.connected", Severity::Info)), "routine events stay quiet by default");
        assert!(s.wants(&sample("macro.failed", Severity::Error)));
        assert!(!s.wants(&sample("macro.completed", Severity::Info)));
        assert!(!s.wants(&sample("scrcpy.failed", Severity::Error)), "off by default");
        assert!(!s.wants(&sample("notification.failed", Severity::Critical)), "never about itself");
        s.categories.insert("macro".into(), "info".into());
        assert!(s.wants(&sample("macro.completed", Severity::Info)));
        s.enabled = false;
        assert!(!s.wants(&sample("macro.failed", Severity::Error)));
    }

    #[test]
    fn embeds_are_readable_bounded_and_ping_no_one() {
        let mut long = sample("macro.failed", Severity::Error).run("run-1").meta("macro", "Farm @everyone").meta("durationSeconds", 125u64);
        long.detail = Some("x".repeat(5000));
        let payloads = discord_payloads(&vec![long.clone(); 25], "full", "pc");
        assert!(payloads.len() >= 3);
        for p in &payloads {
            assert_eq!(p["allowed_mentions"]["parse"], json!([]));
            let embeds = p["embeds"].as_array().unwrap();
            assert!(embeds.len() <= MAX_EMBEDS);
            assert!(embeds.iter().map(embed_size).sum::<usize>() <= 6000);
        }
        let e = &payloads[0]["embeds"][0];
        assert_eq!(e["title"], "S24: macro.failed");
        assert_eq!(e["color"], 0xe74c3c);
        assert_eq!(e["fields"][0]["value"], "S24 (Galaxy S24)");
        assert_eq!(e["fields"][1]["value"], "Farm @everyone");
        assert!(e["fields"].as_array().unwrap().iter().any(|f| f["name"] == "Duration" && f["value"] == "2 min"));
        let brief = discord_payloads(&[long], "brief", "pc");
        assert!(brief[0]["embeds"][0].get("description").is_none());
        assert_eq!(iso_time(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_time(1_792_906_636_769), "2026-10-25T05:37:16.769Z");
    }

    #[tokio::test]
    async fn delivers_and_retries_rate_limits_and_outages() {
        let (url, bodies, hits) = mock_server(vec![
            "HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nContent-Length: 20\r\n\r\n{\"retry_after\":0.05}",
            "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n",
            "HTTP/1.1 204 No Content\r\n\r\n",
        ])
        .await;
        let payload = discord_payloads(&[sample("device.disconnected", Severity::Warning)], "full", "pc").remove(0);
        deliver_discord(&url, &payload, &quick()).await.unwrap();
        assert_eq!(hits.load(Ordering::SeqCst), 3);
        let sent: Value = serde_json::from_str(&bodies.lock().unwrap()[2]).unwrap();
        assert_eq!(sent["embeds"][0]["title"], "S24: device.disconnected");
    }

    #[tokio::test]
    async fn gives_up_cleanly_and_never_names_the_url() {
        // Deleted webhook: no retry.
        let (url, _, hits) = mock_server(vec!["HTTP/1.1 404 Not Found\r\nContent-Length: 2\r\n\r\n{}"]).await;
        let payload = json!({ "embeds": [] });
        let error = deliver_discord(&url, &payload, &quick()).await.unwrap_err();
        assert!(error.contains("deleted"), "{error}");
        assert_eq!(hits.load(Ordering::SeqCst), 1);
        // Discord down for good: bounded attempts.
        let (url, _, hits) = mock_server(vec!["HTTP/1.1 502 Bad Gateway\r\n\r\n"; 4]).await;
        let error = deliver_discord(&url, &payload, &quick()).await.unwrap_err();
        assert_eq!(hits.load(Ordering::SeqCst), 4);
        assert!(error.contains("gave up after 4 attempts") && !error.contains("token"), "{error}");
        // No answer at all: the timeout ends each try.
        let (url, _, _) = mock_server(vec!["hang", "hang"]).await;
        let started = std::time::Instant::now();
        let error = deliver_discord(&url, &payload, &Backoff { attempts: 2, ..quick() }).await.unwrap_err();
        assert!(error.contains("did not answer"), "{error}");
        assert!(started.elapsed() < Duration::from_secs(3));
        // Nothing listening.
        let error = deliver_discord("http://127.0.0.1:9/api/webhooks/1/secret-token", &payload, &Backoff { attempts: 1, ..quick() }).await.unwrap_err();
        assert!(!error.contains("secret-token"), "{error}");
    }

    #[test]
    fn chunked_answers_and_retry_headers() {
        let raw = b"HTTP/1.1 429 Too Many Requests\r\nTransfer-Encoding: chunked\r\nRetry-After: 3\r\n\r\n6\r\n{\"a\":1\r\n1\r\n}\r\n0\r\n\r\n";
        let reply = parse_reply(raw).unwrap();
        assert_eq!((reply.status, reply.retry_after_ms, reply.body.as_str()), (429, Some(3000), "{\"a\":1}"));
        let reply = parse_reply(b"HTTP/1.1 429 X\r\nX-RateLimit-Reset-After: 0.25\r\n\r\n{\"retry_after\": 1.5}").unwrap();
        assert_eq!(reply.retry_after_ms, Some(1500), "Discord's JSON wins");
    }

    #[tokio::test]
    async fn queued_events_respect_rules_and_cooldowns_without_blocking() {
        // Drive offer() against a private queue to check the rules end to end.
        let (url, bodies, _) = mock_server(vec![]).await;
        let n = notifier();
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Event>(QUEUE);
        let _ = n.queue.set(tx);
        {
            let mut s = n.settings.write().unwrap();
            s.webhook_url = url.clone();
            s.cooldown_secs = 3600;
        }
        let mut next_id = 1_000_000;
        let mut offer_new = |e: Event| {
            next_id += 1;
            offer(&Event { id: next_id, ..e });
        };
        offer_new(sample("device.disconnected", Severity::Warning));
        offer_new(sample("device.disconnected", Severity::Warning)); // cooldown
        offer_new(sample("device.disconnected", Severity::Warning)); // cooldown
        offer_new(sample("device.connected", Severity::Info)); // below the level
        offer_new(sample("macro.failed", Severity::Error));
        offer_new(Event { device_id: Some("s23".into()), ..sample("device.disconnected", Severity::Warning) }); // other phone
        // Other tests may record into the same global meanwhile; count ours.
        let mut got = Vec::new();
        while let Ok(e) = rx.try_recv() {
            if e.summary.starts_with("S24: ") {
                got.push((e.kind.clone(), e.device_id.clone()));
            }
        }
        assert_eq!(got.len(), 3, "{got:?}");
        assert!(lock(&n.status).suppressed >= 2);
        // Deliver what was queued.
        let batch: Vec<Event> = vec![sample("macro.failed", Severity::Error)];
        for payload in discord_payloads(&batch, "full", "pc") {
            deliver_discord(&url, &payload, &quick()).await.unwrap();
        }
        assert_eq!(bodies.lock().unwrap().len(), 1);
    }
}
