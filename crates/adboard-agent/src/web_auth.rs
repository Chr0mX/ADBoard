//! Browser sign-in for remote access (reverse proxy / Cloudflare).
//!
//! The API token alone only stops other websites from driving ADBoard through
//! a visitor's browser: `/api/bootstrap` hands it to any same-origin caller.
//! That is fine on a LAN, not on a public hostname. Once an account exists,
//! bootstrap requires a session cookie from `POST /api/login` (username and
//! password form). Without an account, bootstrap refuses requests that
//! arrived through a proxy unless `ADBOARD_ALLOW_PROXY_WITHOUT_PASSWORD=1`.
//!
//! The account lives in `adboard-auth.json` (salted PBKDF2-SHA256), next to
//! the executable unless `ADBOARD_AUTH_FILE` says otherwise, so a password
//! changed in the UI survives restarts. `ADBOARD_PASSWORD` creates the
//! first account; `ADBOARD_RESET_PASSWORD=1` makes it overwrite the file
//! (for a forgotten password).

use axum::http::{header, HeaderMap, HeaderValue};
use ring::rand::SecureRandom;
use std::collections::HashMap;
use std::num::NonZeroU32;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};
use std::time::{Duration, Instant};

pub const SESSION_COOKIE: &str = "adboard_session";
pub const DEFAULT_USERNAME: &str = "admin";
pub const MIN_PASSWORD_LEN: usize = 8;
const SESSION_TTL: Duration = Duration::from_secs(30 * 24 * 60 * 60);
const MAX_SESSIONS: usize = 1024;
const PBKDF2_ITERATIONS: u32 = 210_000;

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct Credentials {
    username: String,
    /// Hex.
    salt: String,
    /// Hex PBKDF2-HMAC-SHA256 output.
    hash: String,
    iterations: u32,
}

impl Credentials {
    fn new(username: &str, password: &str) -> Self {
        let mut salt = [0u8; 16];
        ring::rand::SystemRandom::new()
            .fill(&mut salt)
            .expect("system randomness");
        let mut hash = [0u8; 32];
        ring::pbkdf2::derive(
            ring::pbkdf2::PBKDF2_HMAC_SHA256,
            NonZeroU32::new(PBKDF2_ITERATIONS).expect("non-zero"),
            &salt,
            password.as_bytes(),
            &mut hash,
        );
        Self {
            username: username.to_string(),
            salt: to_hex(&salt),
            hash: to_hex(&hash),
            iterations: PBKDF2_ITERATIONS,
        }
    }

    fn verify(&self, username: &str, password: &str) -> bool {
        let (Some(salt), Some(hash), Some(iterations)) = (
            from_hex(&self.salt),
            from_hex(&self.hash),
            NonZeroU32::new(self.iterations),
        ) else {
            return false;
        };
        let password_ok = ring::pbkdf2::verify(
            ring::pbkdf2::PBKDF2_HMAC_SHA256,
            iterations,
            &salt,
            password.as_bytes(),
            &hash,
        )
        .is_ok();
        // Check both so timing does not reveal which one was wrong.
        let user_ok = constant_time_eq(self.username.as_bytes(), username.as_bytes());
        password_ok && user_ok
    }
}

pub struct WebAuth {
    credentials: RwLock<Option<Credentials>>,
    file: Option<PathBuf>,
    allow_proxy_without_password: bool,
    sessions: Mutex<HashMap<String, Instant>>,
}

impl WebAuth {
    /// In-memory account (tests, or no writable location).
    pub fn new(password: Option<String>, allow_proxy_without_password: bool) -> Self {
        let credentials = password
            .filter(|p| !p.is_empty())
            .map(|p| Credentials::new(DEFAULT_USERNAME, &p));
        Self {
            credentials: RwLock::new(credentials),
            file: None,
            allow_proxy_without_password,
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// Account stored in `file`; env values seed it when the file is absent.
    pub fn with_file(
        file: PathBuf,
        env_username: Option<String>,
        env_password: Option<String>,
        reset: bool,
        allow_proxy_without_password: bool,
    ) -> Self {
        let stored = read_credentials(&file);
        let env_password = env_password.filter(|p| !p.is_empty());
        let username = env_username
            .filter(|u| !u.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_USERNAME.to_string());
        let credentials = match (stored, env_password) {
            (Some(stored), Some(password)) if reset => {
                tracing::warn!("ADBOARD_RESET_PASSWORD=1 — replacing the stored ADBoard account");
                let fresh = Credentials::new(&username, &password);
                write_or_warn(&file, &fresh);
                drop(stored);
                Some(fresh)
            }
            (Some(stored), Some(_)) => {
                tracing::info!(
                    path = %file.display(),
                    "using the stored ADBoard account; ADBOARD_PASSWORD only sets the first password (ADBOARD_RESET_PASSWORD=1 to replace it)"
                );
                Some(stored)
            }
            (Some(stored), None) => Some(stored),
            (None, Some(password)) => {
                let fresh = Credentials::new(&username, &password);
                write_or_warn(&file, &fresh);
                Some(fresh)
            }
            (None, None) => None,
        };
        Self {
            credentials: RwLock::new(credentials),
            file: Some(file),
            allow_proxy_without_password,
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub fn from_env() -> Self {
        let allow = matches!(
            crate::env::var("ALLOW_PROXY_WITHOUT_PASSWORD").as_deref(),
            Ok("1") | Ok("true") | Ok("TRUE") | Ok("yes") | Ok("YES")
        );
        let reset = matches!(
            crate::env::var("RESET_PASSWORD").as_deref(),
            Ok("1") | Ok("true") | Ok("TRUE") | Ok("yes") | Ok("YES")
        );
        let auth = Self::with_file(
            auth_file_path(),
            crate::env::var("USERNAME").ok(),
            crate::env::var("PASSWORD").ok(),
            reset,
            allow,
        );
        if auth.password_required() {
            tracing::info!("ADBoard account configured — the browser UI requires sign-in");
        } else if !allow {
            tracing::info!(
                "no ADBoard account yet — requests through a reverse proxy are refused; set a password from the UI on the LAN or with ADBOARD_PASSWORD"
            );
        }
        auth
    }

    pub fn password_required(&self) -> bool {
        self.credentials.read().unwrap_or_else(|e| e.into_inner()).is_some()
    }

    pub fn username(&self) -> Option<String> {
        self.credentials
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|c| c.username.clone())
    }

    pub fn check_login(&self, username: &str, password: &str) -> bool {
        match self.credentials.read().unwrap_or_else(|e| e.into_inner()).as_ref() {
            Some(credentials) => credentials.verify(username.trim(), password),
            None => false,
        }
    }

    /// Replace the account. Ends every session; the caller signs in afresh.
    pub fn set_credentials(&self, username: &str, password: &str) -> Result<(), String> {
        let username = username.trim();
        if username.is_empty() || username.len() > 64 {
            return Err("Username must be 1–64 characters.".into());
        }
        if password.chars().count() < MIN_PASSWORD_LEN {
            return Err(format!("Password must be at least {MIN_PASSWORD_LEN} characters."));
        }
        let fresh = Credentials::new(username, password);
        if let Some(file) = &self.file {
            write_credentials(file, &fresh)
                .map_err(|e| format!("Could not save the account to {}: {e}", file.display()))?;
        }
        *self.credentials.write().unwrap_or_else(|e| e.into_inner()) = Some(fresh);
        self.sessions.lock().unwrap_or_else(|e| e.into_inner()).clear();
        Ok(())
    }

    /// Without an account, a proxied request may not receive the API token.
    pub fn proxy_blocked(&self, headers: &HeaderMap) -> bool {
        !self.password_required() && !self.allow_proxy_without_password && is_proxied(headers)
    }

    pub fn create_session(&self) -> String {
        let id = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
        let now = Instant::now();
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        sessions.retain(|_, expires| *expires > now);
        if sessions.len() >= MAX_SESSIONS {
            if let Some(oldest) = sessions
                .iter()
                .min_by_key(|(_, expires)| **expires)
                .map(|(id, _)| id.clone())
            {
                sessions.remove(&oldest);
            }
        }
        sessions.insert(id.clone(), now + SESSION_TTL);
        id
    }

    pub fn session_valid(&self, headers: &HeaderMap) -> bool {
        let Some(id) = session_cookie(headers) else {
            return false;
        };
        let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        sessions.get(&id).is_some_and(|expires| *expires > Instant::now())
    }

    pub fn end_session(&self, headers: &HeaderMap) {
        if let Some(id) = session_cookie(headers) {
            let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            sessions.remove(&id);
        }
    }
}

fn auth_file_path() -> PathBuf {
    if let Ok(path) = crate::env::var("AUTH_FILE") {
        if !path.trim().is_empty() {
            return PathBuf::from(path);
        }
    }
    let path = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("adboard-auth.json")))
        .unwrap_or_else(|| PathBuf::from("adboard-auth.json"));
    migrate_legacy_auth_file(&path);
    path
}

/// Keep the account created before the ADBoard rename (`rasiel-auth.json`).
fn migrate_legacy_auth_file(path: &Path) {
    let legacy = path.with_file_name("rasiel-auth.json");
    if path.exists() || !legacy.exists() {
        return;
    }
    match std::fs::rename(&legacy, path) {
        Ok(()) => tracing::info!(from = %legacy.display(), to = %path.display(), "moved the sign-in account to its new file name"),
        Err(e) => tracing::warn!(error = %e, "could not rename rasiel-auth.json; sign in may need ADBOARD_RESET_PASSWORD"),
    }
}

fn read_credentials(path: &Path) -> Option<Credentials> {
    let text = std::fs::read_to_string(path).ok()?;
    match serde_json::from_str::<Credentials>(&text) {
        Ok(credentials) => Some(credentials),
        Err(e) => {
            tracing::warn!(path = %path.display(), error = %e, "ignoring unreadable ADBoard account file");
            None
        }
    }
}

fn write_credentials(path: &Path, credentials: &Credentials) -> std::io::Result<()> {
    let text = serde_json::to_string_pretty(credentials).map_err(std::io::Error::other)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(&tmp, path)
}

fn write_or_warn(path: &Path, credentials: &Credentials) {
    if let Err(e) = write_credentials(path, credentials) {
        tracing::warn!(path = %path.display(), error = %e, "could not save the ADBoard account; it lasts until restart");
    }
}

/// True when a reverse proxy or Cloudflare forwarded the request.
pub fn is_proxied(headers: &HeaderMap) -> bool {
    [
        "x-forwarded-for",
        "x-real-ip",
        "forwarded",
        "cf-connecting-ip",
        "cf-ray",
    ]
    .iter()
    .any(|name| headers.contains_key(*name))
}

/// The visitor reached the proxy over HTTPS, so cookies can be `Secure`.
pub fn is_https(headers: &HeaderMap) -> bool {
    let forwarded_proto = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.split(',').next().unwrap_or("").trim().eq_ignore_ascii_case("https"))
        .unwrap_or(false);
    let cf_visitor = headers
        .get("cf-visitor")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.contains("\"https\""))
        .unwrap_or(false);
    forwarded_proto || cf_visitor
}

fn session_cookie(headers: &HeaderMap) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .find_map(|pair| {
            let (name, value) = pair.trim().split_once('=')?;
            (name == SESSION_COOKIE && !value.is_empty()).then(|| value.to_string())
        })
}

pub fn session_set_cookie(id: &str, secure: bool) -> HeaderValue {
    let secure = if secure { "; Secure" } else { "" };
    let value = format!(
        "{SESSION_COOKIE}={id}; Path=/; HttpOnly; SameSite=Strict; Max-Age={}{secure}",
        SESSION_TTL.as_secs()
    );
    HeaderValue::from_str(&value).expect("cookie is ASCII")
}

pub fn session_clear_cookie(secure: bool) -> HeaderValue {
    let secure = if secure { "; Secure" } else { "" };
    HeaderValue::from_str(&format!(
        "{SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0{secure}"
    ))
    .expect("cookie is ASCII")
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn from_hex(hex: &str) -> Option<Vec<u8>> {
    if hex.len() % 2 != 0 {
        return None;
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(hex.get(i..i + 2)?, 16).ok())
        .collect()
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    let mut diff = a.len() ^ b.len();
    for i in 0..a.len().max(b.len()) {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        diff |= usize::from(x ^ y);
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.append(*name, HeaderValue::from_str(value).unwrap());
        }
        map
    }

    fn temp_file() -> PathBuf {
        std::env::temp_dir().join(format!("adboard-auth-test-{}.json", uuid::Uuid::new_v4().simple()))
    }

    #[test]
    fn detects_proxy_and_https() {
        assert!(!is_proxied(&headers(&[("host", "127.0.0.1:3848")])));
        assert!(is_proxied(&headers(&[("x-forwarded-for", "1.2.3.4")])));
        assert!(is_proxied(&headers(&[("cf-connecting-ip", "1.2.3.4")])));
        assert!(is_https(&headers(&[("x-forwarded-proto", "https")])));
        assert!(is_https(&headers(&[("cf-visitor", r#"{"scheme":"https"}"#)])));
        assert!(!is_https(&headers(&[("x-forwarded-proto", "http")])));
    }

    #[test]
    fn login_and_sessions() {
        let auth = WebAuth::new(Some("hunter2!".into()), false);
        assert!(auth.check_login("admin", "hunter2!"));
        assert!(!auth.check_login("admin", "hunter2"));
        assert!(!auth.check_login("root", "hunter2!"));
        let id = auth.create_session();
        let cookie = format!("other=1; {SESSION_COOKIE}={id}");
        let with = headers(&[("cookie", &cookie)]);
        assert!(auth.session_valid(&with));
        assert!(!auth.session_valid(&headers(&[("cookie", "adboard_session=nope")])));
        auth.end_session(&with);
        assert!(!auth.session_valid(&with));
    }

    #[test]
    fn changing_the_password_persists_and_ends_sessions() {
        let file = temp_file();
        let auth = WebAuth::with_file(file.clone(), None, Some("first-pass".into()), false, false);
        assert!(auth.check_login("admin", "first-pass"));
        let id = auth.create_session();
        let with = headers(&[("cookie", &format!("{SESSION_COOKIE}={id}"))]);

        assert!(auth.set_credentials("ops", "short").is_err());
        auth.set_credentials("ops", "second-pass").unwrap();
        assert!(!auth.session_valid(&with));
        assert!(auth.check_login("ops", "second-pass"));
        assert!(!auth.check_login("admin", "first-pass"));

        // A restart reads the file; the env password no longer applies.
        let restarted = WebAuth::with_file(file.clone(), None, Some("first-pass".into()), false, false);
        assert!(restarted.check_login("ops", "second-pass"));
        assert!(!restarted.check_login("admin", "first-pass"));
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(!text.contains("second-pass"), "password must not be stored in clear");

        // Reset replaces it.
        let reset = WebAuth::with_file(file.clone(), None, Some("third-pass".into()), true, false);
        assert!(reset.check_login("admin", "third-pass"));
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn legacy_auth_file_is_migrated() {
        let dir = std::env::temp_dir().join(format!("adboard-migrate-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let legacy = dir.join("rasiel-auth.json");
        let current = dir.join("adboard-auth.json");
        write_credentials(&legacy, &Credentials::new("ops", "kept-pass-1")).unwrap();
        migrate_legacy_auth_file(&current);
        assert!(current.exists() && !legacy.exists());
        let auth = WebAuth::with_file(current, None, None, false, false);
        assert!(auth.check_login("ops", "kept-pass-1"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn proxy_block_rules() {
        let proxied = headers(&[("x-forwarded-for", "1.2.3.4")]);
        assert!(WebAuth::new(None, false).proxy_blocked(&proxied));
        assert!(!WebAuth::new(None, true).proxy_blocked(&proxied));
        assert!(!WebAuth::new(Some("password1".into()), false).proxy_blocked(&proxied));
        assert!(!WebAuth::new(None, false).proxy_blocked(&HeaderMap::new()));
        assert!(!WebAuth::new(Some(String::new()), false).password_required());
    }

    #[test]
    fn cookie_flags() {
        let secure = session_set_cookie("abc", true);
        let s = secure.to_str().unwrap();
        assert!(s.contains("HttpOnly") && s.contains("SameSite=Strict") && s.ends_with("Secure"));
        assert!(!session_set_cookie("abc", false).to_str().unwrap().contains("Secure"));
    }
}
