//! Browser sign-in for remote access (reverse proxy / Cloudflare).
//!
//! The API token alone only stops other websites from driving Rasiel through
//! a visitor's browser: `/api/bootstrap` hands it to any same-origin caller.
//! That is fine on a LAN, not on a public hostname. With
//! `PHONECONTROL_PASSWORD` set, bootstrap requires a session cookie obtained
//! from `POST /api/login`. Without a password, bootstrap refuses requests that
//! arrived through a proxy unless `PHONECONTROL_ALLOW_PROXY_WITHOUT_PASSWORD=1`
//! (for setups that put Cloudflare Access or similar in front).

use axum::http::{header, HeaderMap, HeaderValue};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const SESSION_COOKIE: &str = "rasiel_session";
const SESSION_TTL: Duration = Duration::from_secs(30 * 24 * 60 * 60);
const MAX_SESSIONS: usize = 1024;

pub struct WebAuth {
    password: Option<String>,
    allow_proxy_without_password: bool,
    sessions: Mutex<HashMap<String, Instant>>,
}

impl WebAuth {
    pub fn new(password: Option<String>, allow_proxy_without_password: bool) -> Self {
        Self {
            password: password.filter(|p| !p.is_empty()),
            allow_proxy_without_password,
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub fn from_env() -> Self {
        let password = std::env::var("PHONECONTROL_PASSWORD").ok();
        let allow = matches!(
            std::env::var("PHONECONTROL_ALLOW_PROXY_WITHOUT_PASSWORD").as_deref(),
            Ok("1") | Ok("true") | Ok("TRUE") | Ok("yes") | Ok("YES")
        );
        let auth = Self::new(password, allow);
        if auth.password_required() {
            tracing::info!("PHONECONTROL_PASSWORD is set — the browser UI requires sign-in");
        } else if !allow {
            tracing::info!(
                "no PHONECONTROL_PASSWORD — requests through a reverse proxy are refused; set one for remote access"
            );
        }
        auth
    }

    pub fn password_required(&self) -> bool {
        self.password.is_some()
    }

    pub fn check_password(&self, candidate: &str) -> bool {
        match &self.password {
            Some(password) => constant_time_eq(password.as_bytes(), candidate.as_bytes()),
            None => false,
        }
    }

    /// Without a password, a proxied request may not receive the API token.
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
    fn password_and_sessions() {
        let auth = WebAuth::new(Some("hunter2".into()), false);
        assert!(auth.check_password("hunter2"));
        assert!(!auth.check_password("hunter"));
        assert!(!auth.check_password("hunter22"));
        let id = auth.create_session();
        let cookie = format!("other=1; {SESSION_COOKIE}={id}");
        let with = headers(&[("cookie", &cookie)]);
        assert!(auth.session_valid(&with));
        assert!(!auth.session_valid(&headers(&[("cookie", "rasiel_session=nope")])));
        auth.end_session(&with);
        assert!(!auth.session_valid(&with));
    }

    #[test]
    fn proxy_block_rules() {
        let proxied = headers(&[("x-forwarded-for", "1.2.3.4")]);
        assert!(WebAuth::new(None, false).proxy_blocked(&proxied));
        assert!(!WebAuth::new(None, true).proxy_blocked(&proxied));
        assert!(!WebAuth::new(Some("pw".into()), false).proxy_blocked(&proxied));
        assert!(!WebAuth::new(None, false).proxy_blocked(&HeaderMap::new()));
        // An empty password counts as unset.
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
