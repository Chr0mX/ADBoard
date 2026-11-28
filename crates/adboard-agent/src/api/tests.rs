use super::*;
use axum::body::Body;
use axum::http::Request;
use http_body_util::BodyExt;
use adboard_protocol::Role;
use tower::ServiceExt;

fn apk_request(filename: &str, targets: &str, bytes: &'static [u8], token: &str) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri("/api/input/install")
        .header("x-adboard-mode", "selected")
        .header("x-adboard-targets", targets)
        .header("x-adboard-filename", filename)
        .header(TOKEN_HEADER, token)
        .body(Body::from(bytes))
        .unwrap()
}

async fn body_text(response: axum::response::Response) -> String {
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    String::from_utf8_lossy(&bytes).into_owned()
}

#[tokio::test]
async fn install_rejects_non_apk_and_reports_missing_adb() {
    let state = AppState::new(
        Role::Controller,
        "install-test".into(),
        "install-test".into(),
        0,
        None,
    );
    let token = state.api_token().to_string();
    let devices = state.list_devices().await;
    let id = devices
        .iter()
        .find(|d| d.status == adboard_protocol::DeviceStatus::Online)
        .expect("online device")
        .id
        .clone();
    let app = router_with_auth(state, WebAuth::new(None, false));

    let rejected = app
        .clone()
        .oneshot(apk_request("notes.txt", &id, b"PK\x03\x04nope", &token))
        .await
        .unwrap();
    assert_eq!(rejected.status(), StatusCode::BAD_REQUEST);
    let text = body_text(rejected).await;
    assert!(
        text.contains("apk"),
        "non-apk upload should be rejected, got {text}"
    );

    let not_zip = router_oneshot_note(&id).await;
    assert_eq!(not_zip.0, StatusCode::BAD_REQUEST);
    assert!(not_zip.1.contains("apk"), "got {}", not_zip.1);

    let response = app
        .oneshot(apk_request("demo.apk", &id, b"PK\x03\x04fake-apk", &token))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let text = body_text(response).await;
    assert!(
        text.contains("adb is not available"),
        "missing adb should be a clear error, got {text}"
    );
    assert!(text.contains("\"inject\":\"error\""), "{text}");
}

fn json_request(method: &str, uri: &str, token: &str, body: serde_json::Value) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json")
        .header(TOKEN_HEADER, token)
        .body(Body::from(body.to_string()))
        .unwrap()
}

/// Notification settings never show the webhook, bad input is refused,
/// and device commands and macro runs land in the event history.
#[tokio::test]
async fn events_and_notifications_api() {
    let state = AppState::new(Role::Controller, "events-test".into(), "events-test".into(), 0, None);
    let token = state.api_token().to_string();
    let id = state.list_devices().await.into_iter().find(|d| d.status == adboard_protocol::DeviceStatus::Online).expect("online").id;
    let app = router_with_auth(state, WebAuth::new(None, false));
    let call = |method: &str, uri: &str, body: serde_json::Value| json_request(method, uri, &token, body);

    let response = app.clone().oneshot(call("GET", "/api/notifications", serde_json::Value::Null)).await.unwrap();
    let settings: serde_json::Value = serde_json::from_str(&body_text(response).await).unwrap();
    assert!(settings.get("webhookUrl").is_none());
    assert!(settings["categories"]["device"].is_string());

    let bad = call("PUT", "/api/notifications", serde_json::json!({ "webhookUrl": "https://evil.example/api/webhooks/1/abcdefghijklmnopqrstuvwxyz" }));
    let response = app.clone().oneshot(bad).await.unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert!(!body_text(response).await.contains("evil.example"), "errors never echo the URL");
    let level = call("PUT", "/api/notifications", serde_json::json!({ "categories": { "scrcpy": "error" } }));
    let response = app.clone().oneshot(level).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bad_level = call("PUT", "/api/notifications", serde_json::json!({ "categories": { "scrcpy": "loud" } }));
    assert_eq!(app.clone().oneshot(bad_level).await.unwrap().status(), StatusCode::BAD_REQUEST);

    // A command that changes the phone is recorded.
    let reboot = call("POST", "/api/device/command", serde_json::json!({ "targetIds": [id], "op": "reboot" }));
    assert_eq!(app.clone().oneshot(reboot).await.unwrap().status(), StatusCode::OK);
    let list = call("GET", &format!("/api/events?device={id}&category=device,app"), serde_json::Value::Null);
    let page: serde_json::Value = serde_json::from_str(&body_text(app.clone().oneshot(list).await.unwrap()).await).unwrap();
    assert!(page["events"].as_array().unwrap().iter().any(|e| e["kind"].as_str().is_some_and(|k| k.starts_with("device.reboot"))), "{page}");

    let summary = call("GET", "/api/events/summary", serde_json::Value::Null);
    let summary: serde_json::Value = serde_json::from_str(&body_text(app.clone().oneshot(summary).await.unwrap()).await).unwrap();
    assert!(summary["total"].as_u64().unwrap() >= 1);
    let macros = call("GET", "/api/events/macros?since=0", serde_json::Value::Null);
    let response = app.clone().oneshot(macros).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(serde_json::from_str::<serde_json::Value>(&body_text(response).await).unwrap().is_array());
    // (Valid values are covered by notify's tests; changing the shared
    // settings here would race them.)
    let offline = call("PUT", "/api/notifications", serde_json::json!({ "offlineAlertMins": 99_999 }));
    assert_eq!(app.clone().oneshot(offline).await.unwrap().status(), StatusCode::BAD_REQUEST);
    let filtered = call("GET", "/api/events?severity=critical&q=zzz-nothing", serde_json::Value::Null);
    let page: serde_json::Value = serde_json::from_str(&body_text(app.clone().oneshot(filtered).await.unwrap()).await).unwrap();
    assert_eq!(page["total"], 0);
}

/// The mock fleet has a sample screen, so text steps run end to end
/// without phones: read, match, and a macro that taps found text.
#[tokio::test]
async fn ocr_reads_the_mock_screen_and_a_macro_taps_found_text() {
    let state = AppState::new(Role::Controller, "ocr-test".into(), "ocr-test".into(), 0, None);
    let token = state.api_token().to_string();
    let id = state.list_devices().await.into_iter().find(|d| d.status == adboard_protocol::DeviceStatus::Online).expect("online").id;
    let app = router_with_auth(state, WebAuth::new(None, false));

    let status = app.clone().oneshot(json_request("GET", "/api/ocr/status", &token, serde_json::Value::Null)).await.unwrap();
    let status: serde_json::Value = serde_json::from_str(&body_text(status).await).unwrap();
    assert_eq!((status["available"].as_bool(), status["engine"].as_str()), (Some(true), Some("mock")));

    let read = json_request("POST", "/api/ocr/read", &token, serde_json::json!({ "deviceId": id, "query": { "texts": ["sign IN"] } }));
    let response = app.clone().oneshot(read).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let screen: serde_json::Value = serde_json::from_str(&body_text(response).await).unwrap();
    assert_eq!(screen["matches"].as_array().map(Vec::len), Some(1));
    assert_eq!(screen["matches"][0]["text"], "Sign in");
    assert!(screen["lines"][0].get("chars").is_none(), "char boxes only when asked");

    let area = json_request("POST", "/api/ocr/read", &token, serde_json::json!({ "deviceId": id, "area": {"x": 0, "y": 0.8, "width": 1, "height": 0.2} }));
    let screen: serde_json::Value = serde_json::from_str(&body_text(app.clone().oneshot(area).await.unwrap()).await).unwrap();
    assert_eq!(screen["lines"].as_array().map(Vec::len), Some(1));

    let unknown = json_request("POST", "/api/ocr/read", &token, serde_json::json!({ "deviceId": "nope" }));
    assert_eq!(app.clone().oneshot(unknown).await.unwrap().status(), StatusCode::NOT_FOUND);
    let bad = json_request("POST", "/api/ocr/read", &token, serde_json::json!({ "deviceId": id, "query": { "texts": ["("], "match": "regex" } }));
    assert_eq!(app.clone().oneshot(bad).await.unwrap().status(), StatusCode::BAD_REQUEST);

    let tab = serde_json::json!({
        "id": "tab-ocr-api", "name": "OCR", "reference": {"width": 1080, "height": 2400},
        "stop": {"mode": "cycles", "cycles": 1},
        "steps": [{"id": "s1", "enabled": true, "fingers": [], "delayMs": 0, "kind": "text",
                   "text": {"action": "tap", "texts": ["continue"], "match": "exact", "timeoutMs": 0}}]
    });
    let start = json_request("POST", &format!("/api/macro/devices/{id}/start"), &token, serde_json::json!({ "tab": tab }));
    let response = app.clone().oneshot(start).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK, "{}", body_text(response).await);
    let done = crate::macro_runner::runs().wait_devices(std::slice::from_ref(&id)).await;
    assert_eq!(done[0].status, "done", "{:?}", done[0].message);
    assert_eq!(done[0].touches, 1);
    let text = done[0].text.clone().unwrap();
    assert_eq!(text.detail.as_deref(), Some("Tapped “Continue”"));
    // Mock "Continue" is centered at x 0.5, y 0.715.
    assert!((done[0].last_points[0].x - 0.5).abs() < 1e-6 && (done[0].last_points[0].y - 0.715).abs() < 1e-6);
    assert_eq!(done[0].devices[&id].state, "stub", "the mock fleet does not send touches");
}

#[tokio::test]
async fn command_reports_missing_adb_and_rejects_a_bad_shell() {
    let state = AppState::new(
        Role::Controller,
        "command-test".into(),
        "command-test".into(),
        0,
        None,
    );
    let token = state.api_token().to_string();
    let devices = state.list_devices().await;
    let id = devices
        .iter()
        .find(|d| d.status == adboard_protocol::DeviceStatus::Online)
        .expect("online device")
        .id
        .clone();
    let app = router_with_auth(state, WebAuth::new(None, false));
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/device/command")
                .header("content-type", "application/json")
                .header(TOKEN_HEADER, &token)
                .body(Body::from(format!(
                    "{{\"targetIds\":[\"{id}\"],\"op\":\"shell\",\"arg\":\"pm list packages\"}}"
                )))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let text = body_text(response).await;
    assert!(text.contains("adb is not available"), "{text}");
    assert!(text.contains("\"ok\":false"), "{text}");
}

#[tokio::test]
async fn app_controls_and_tweaks_run_on_the_mock_fleet() {
    let state = AppState::new(Role::Controller, "controls-test".into(), "controls-test".into(), 0, None);
    let token = state.api_token().to_string();
    let devices = state.list_devices().await;
    let ids: Vec<String> = devices.iter().filter(|d| d.status == adboard_protocol::DeviceStatus::Online).take(2).map(|d| d.id.clone()).collect();
    assert_eq!(ids.len(), 2);
    let app = router_with_auth(state, WebAuth::new(None, false));
    let run = |op: &str, arg: Option<&str>, arg2: Option<&str>| {
        let body = serde_json::json!({ "targetIds": ids, "op": op, "arg": arg, "arg2": arg2 }).to_string();
        let app = app.clone();
        let token = token.clone();
        async move {
            let response = app
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/api/device/command")
                        .header("content-type", "application/json")
                        .header(TOKEN_HEADER, &token)
                        .body(Body::from(body))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            serde_json::from_str::<serde_json::Value>(&body_text(response).await).unwrap()
        }
    };
    let ok = |v: &serde_json::Value| v["results"].as_array().unwrap().iter().all(|r| r["ok"] == true);
    let out = run("appop", Some("com.game"), Some("RUN_ANY_IN_BACKGROUND=ignore")).await;
    assert!(ok(&out), "{out}");
    let detail = run("appDetail", Some("com.game"), None).await;
    let parsed: serde_json::Value = serde_json::from_str(detail["results"][0]["output"].as_str().unwrap()).unwrap();
    assert_eq!(parsed["ops"]["RUN_ANY_IN_BACKGROUND"], "ignore");
    for (op, arg, arg2) in [
        ("permission", "com.game", "grant:android.permission.RECORD_AUDIO"),
        ("standby", "com.game", "active"),
        ("batteryExempt", "com.game", "on"),
        ("netBlock", "com.game", "on"),
        ("appState", "com.game", "suspend"),
        ("assistLaunch", "com.game", ".Hidden"),
        ("intent", "broadcast", "-a com.game.PING --ez on true"),
        ("shizuku", "start", ""),
        ("tweak", "phantomKillerOff", "on"),
    ] {
        let out = run(op, Some(arg), Some(arg2).filter(|a| !a.is_empty())).await;
        assert!(ok(&out), "{op}: {out}");
    }
    let tweaks = run("tweak", None, Some("status")).await;
    assert!(tweaks["results"][0]["output"].as_str().unwrap().contains("\"phantomKillerOff\":true"), "{tweaks}");
    let bad = run("intent", Some("broadcast"), Some("-a x.y; reboot")).await;
    assert_eq!(bad["results"][0]["ok"], false);
    let bad = run("appop", Some("com.game"), Some("CAMERA=always")).await;
    assert_eq!(bad["results"][0]["ok"], false);
}

#[tokio::test]
async fn api_rejects_missing_token_and_serves_bootstrap() {
    let state = AppState::new(
        Role::Controller,
        "token-test".into(),
        "token-test".into(),
        0,
        None,
    );
    let token = state.api_token().to_string();
    let app = router_with_auth(state, WebAuth::new(None, false));

    let denied = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/device/command")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"targetIds":["s24"],"op":"shell","arg":"id"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);

    let boot = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/bootstrap")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(boot.status(), StatusCode::OK);
    let boot_text = body_text(boot).await;
    assert!(boot_text.contains(&token), "{boot_text}");

    let forbidden = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/bootstrap")
                .header("origin", "https://evil.example")
                .header("host", "127.0.0.1:3848")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);

    let health = app
        .oneshot(
            Request::builder()
                .uri("/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(health.status(), StatusCode::OK);
}

#[tokio::test]
async fn api_accepts_new_and_legacy_token_headers() {
    let state = AppState::new(Role::Controller, "hdr-test".into(), "hdr-test".into(), 0, None);
    let token = state.api_token().to_string();
    let app = router_with_auth(state, WebAuth::new(None, false));
    for name in [TOKEN_HEADER, LEGACY_TOKEN_HEADER] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/devices")
                    .header(name, &token)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{name}");
    }
}

#[tokio::test]
async fn scrcpy_options_and_clipboard_on_a_mock_device() {
    let state = AppState::new(
        Role::Controller,
        "scrcpy-opt".into(),
        "scrcpy-opt".into(),
        0,
        None,
    );
    let token = state.api_token().to_string();
    let devices = state.list_devices().await;
    let id = devices
        .iter()
        .find(|d| d.status == adboard_protocol::DeviceStatus::Online)
        .expect("online device")
        .id
        .clone();
    let app = router_with_auth(state, WebAuth::new(None, false));

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/scrcpy/options")
                .header("content-type", "application/json")
                .header(TOKEN_HEADER, &token)
                .body(Body::from(format!(
                    r#"{{"mode":"selected","targetIds":["{id}"],"quality":"high","audio":true,"screenOff":false}}"#
                )))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let text = body_text(response).await;
    assert!(text.contains("\"quality\":\"high\""), "{text}");
    assert!(text.contains("\"audio\":true"), "{text}");

    let screen = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/scrcpy/options")
                .header("content-type", "application/json")
                .header(TOKEN_HEADER, &token)
                .body(Body::from(format!(
                    r#"{{"mode":"selected","targetIds":["{id}"],"quality":"high","audio":true,"screenOff":true}}"#
                )))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(screen.status(), StatusCode::OK);
    let screen_text = body_text(screen).await;
    assert!(screen_text.contains("\"screenOff\":true"), "{screen_text}");
    assert!(
        screen_text.contains("scrcpy control is not connected"),
        "screen-off on a mock session should say the control socket is missing, got {screen_text}"
    );

    let saved = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/scrcpy/options")
                .header(TOKEN_HEADER, &token)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(saved.status(), StatusCode::OK);
    let saved_text = body_text(saved).await;
    assert!(saved_text.contains("\"quality\":\"high\""), "{saved_text}");

    let clip = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/input/clipboard")
                .header("content-type", "application/json")
                .header(TOKEN_HEADER, &token)
                .body(Body::from(format!(
                    r#"{{"mode":"selected","targetIds":["{id}"],"text":"hello","paste":true}}"#
                )))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(clip.status(), StatusCode::OK);
    let clip_text = body_text(clip).await;
    assert!(
        clip_text.contains("scrcpy control is not connected"),
        "{clip_text}"
    );
    assert!(clip_text.contains("\"ok\":false"), "{clip_text}");
}

#[tokio::test]
async fn keyboard_routes_use_the_control_socket() {
    let state = AppState::new(Role::Controller, "keys".into(), "keys".into(), 0, None);
    let token = state.api_token().to_string();
    let devices = state.list_devices().await;
    let id = devices
        .iter()
        .find(|d| d.status == adboard_protocol::DeviceStatus::Online)
        .expect("online device")
        .id
        .clone();
    let app = router_with_auth(state, WebAuth::new(None, false));

    let text = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/input/text")
                .header("content-type", "application/json")
                .header(TOKEN_HEADER, &token)
                .body(Body::from(format!(
                    r#"{{"mode":"selected","targetIds":["{id}"],"text":"a"}}"#
                )))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(text.status(), StatusCode::OK);
    let text_body = body_text(text).await;
    assert!(
        text_body.contains("scrcpy control is not connected"),
        "{text_body}"
    );

    let key = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/input/key")
                .header("content-type", "application/json")
                .header(TOKEN_HEADER, &token)
                .body(Body::from(format!(
                    r#"{{"mode":"selected","targetIds":["{id}"],"action":"down","keycode":66,"repeat":0,"metastate":0}}"#
                )))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(key.status(), StatusCode::OK);
    let key_body = body_text(key).await;
    assert!(
        key_body.contains("scrcpy control is not connected"),
        "{key_body}"
    );
}

async fn router_oneshot_note(id: &str) -> (StatusCode, String) {
    let state = AppState::new(
        Role::Controller,
        "install-test-2".into(),
        "install-test-2".into(),
        0,
        None,
    );
    let token = state.api_token().to_string();
    let app = router_with_auth(state, WebAuth::new(None, false));
    let response = app
        .oneshot(apk_request("demo.apk", id, b"this is not a zip", &token))
        .await
        .unwrap();
    let status = response.status();
    let text = body_text(response).await;
    (status, text)
}

fn auth_state() -> AppState {
    AppState::new(Role::Controller, "auth-test".into(), "auth-test".into(), 0, None)
}

fn get(uri: &str, headers: &[(&str, &str)]) -> Request<Body> {
    let mut builder = Request::builder().uri(uri);
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    builder.body(Body::empty()).unwrap()
}

fn login_request(password: &str, headers: &[(&str, &str)]) -> Request<Body> {
    let mut builder = Request::builder()
        .method("POST")
        .uri("/api/login")
        .header("content-type", "application/json");
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    builder
        .body(Body::from(format!(r#"{{"password":"{password}"}}"#)))
        .unwrap()
}

#[tokio::test]
async fn bootstrap_refuses_proxied_requests_without_password() {
    let app = router_with_auth(auth_state(), WebAuth::new(None, false));
    let lan = app.clone().oneshot(get("/api/bootstrap", &[])).await.unwrap();
    assert_eq!(lan.status(), StatusCode::OK);

    let proxied = app
        .clone()
        .oneshot(get(
            "/api/bootstrap",
            &[("x-forwarded-for", "203.0.113.9"), ("cf-ray", "abc")],
        ))
        .await
        .unwrap();
    assert_eq!(proxied.status(), StatusCode::FORBIDDEN);
    assert!(body_text(proxied).await.contains("ADBOARD_PASSWORD"));

    let session = app
        .oneshot(get("/api/session", &[("x-forwarded-for", "203.0.113.9")]))
        .await
        .unwrap();
    assert!(body_text(session).await.contains(r#""proxyBlocked":true"#));

    let allowed = router_with_auth(auth_state(), WebAuth::new(None, true))
        .oneshot(get("/api/bootstrap", &[("x-forwarded-for", "203.0.113.9")]))
        .await
        .unwrap();
    assert_eq!(allowed.status(), StatusCode::OK);
}

#[tokio::test]
async fn password_sign_in_flow() {
    let state = auth_state();
    let token = state.api_token().to_string();
    let app = router_with_auth(state, WebAuth::new(Some("open sesame".into()), false));
    let proxy = [
        ("host", "adboard.example.com"),
        ("origin", "https://adboard.example.com"),
        ("x-forwarded-for", "203.0.113.9"),
        ("x-forwarded-proto", "https"),
    ];

    let anon = app.clone().oneshot(get("/api/bootstrap", &proxy)).await.unwrap();
    assert_eq!(anon.status(), StatusCode::UNAUTHORIZED);
    assert!(!body_text(anon).await.contains(&token));

    let wrong = app.clone().oneshot(login_request("nope", &proxy)).await.unwrap();
    assert_eq!(wrong.status(), StatusCode::UNAUTHORIZED);
    assert!(wrong.headers().get(header::SET_COOKIE).is_none());

    let evil = app
        .clone()
        .oneshot(login_request(
            "open sesame",
            &[("host", "adboard.example.com"), ("origin", "https://evil.example")],
        ))
        .await
        .unwrap();
    assert_eq!(evil.status(), StatusCode::FORBIDDEN);

    let ok = app.clone().oneshot(login_request("open sesame", &proxy)).await.unwrap();
    assert_eq!(ok.status(), StatusCode::OK);
    let set_cookie = ok.headers()[header::SET_COOKIE].to_str().unwrap().to_string();
    assert!(set_cookie.contains("HttpOnly") && set_cookie.contains("Secure"), "{set_cookie}");
    let cookie = set_cookie.split(';').next().unwrap().to_string();

    let mut with_cookie = proxy.to_vec();
    with_cookie.push(("cookie", cookie.as_str()));
    let boot = app.clone().oneshot(get("/api/bootstrap", &with_cookie)).await.unwrap();
    assert_eq!(boot.status(), StatusCode::OK);
    assert!(body_text(boot).await.contains(&token));

    let session = app.clone().oneshot(get("/api/session", &with_cookie)).await.unwrap();
    let text = body_text(session).await;
    assert!(text.contains(r#""authRequired":true"#) && text.contains(r#""authenticated":true"#), "{text}");

    let mut logout = Request::builder().method("POST").uri("/api/logout");
    for (name, value) in &with_cookie {
        logout = logout.header(*name, *value);
    }
    let out = app.clone().oneshot(logout.body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(out.status(), StatusCode::NO_CONTENT);
    assert!(out.headers()[header::SET_COOKIE].to_str().unwrap().contains("Max-Age=0"));

    let after = app.oneshot(get("/api/bootstrap", &with_cookie)).await.unwrap();
    assert_eq!(after.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn cache_headers_by_path() {
    let app: Router = Router::new()
        .route("/api/devices", axum::routing::get(|| async { "[]" }))
        .route("/_next/static/chunks/app.js", axum::routing::get(|| async { "js" }))
        .route("/sw.js", axum::routing::get(|| async { "sw" }))
        .route("/", axum::routing::get(|| async { "html" }))
        .layer(middleware::from_fn(cache_headers));
    for (path, expected) in [
        ("/api/devices", "no-store"),
        ("/_next/static/chunks/app.js", "public, max-age=31536000, immutable"),
        ("/sw.js", "no-cache"),
        ("/", "no-cache"),
    ] {
        let response = app.clone().oneshot(get(path, &[])).await.unwrap();
        assert_eq!(response.headers()[header::CACHE_CONTROL], expected, "{path}");
    }
}

fn hex(token: &str) -> String {
    token.bytes().map(|b| format!("{b:02x}")).collect()
}

#[tokio::test]
async fn websocket_accepts_token_as_subprotocol() {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let state = auth_state();
    let token = state.api_token().to_string();
    let app = router_with_auth(state, WebAuth::new(None, false));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    // No token anywhere: refused.
    assert!(tokio_tungstenite::connect_async(format!("ws://{addr}/ws")).await.is_err());

    // Token only in Sec-WebSocket-Protocol, nothing in the URL.
    let mut request = format!("ws://{addr}/ws").into_client_request().unwrap();
    request.headers_mut().insert(
        "sec-websocket-protocol",
        format!("adboard, adboard-token.{}", hex(&token)).parse().unwrap(),
    );
    let (_socket, response) = tokio_tungstenite::connect_async(request).await.unwrap();
    assert_eq!(response.headers()["sec-websocket-protocol"], "adboard");

    // A UI from before the rename (still open in a tab) keeps working.
    let mut legacy = format!("ws://{addr}/ws").into_client_request().unwrap();
    legacy.headers_mut().insert(
        "sec-websocket-protocol",
        format!("rasiel, rasiel-token.{}", hex(&token)).parse().unwrap(),
    );
    let (_legacy_socket, legacy_response) = tokio_tungstenite::connect_async(legacy).await.unwrap();
    assert_eq!(legacy_response.headers()["sec-websocket-protocol"], "rasiel");

    // Wrong token in the subprotocol: refused.
    let mut bad = format!("ws://{addr}/ws").into_client_request().unwrap();
    bad.headers_mut().insert(
        "sec-websocket-protocol",
        format!("adboard, adboard-token.{}", hex("nope")).parse().unwrap(),
    );
    assert!(tokio_tungstenite::connect_async(bad).await.is_err());

    // Server-to-server: the token header works too.
    let header = crate::mesh_client::ws_request_with_token(&format!("ws://{addr}/ws"), &token).unwrap();
    assert!(!header.uri().to_string().contains("token="));
    assert!(tokio_tungstenite::connect_async(header).await.is_ok());
}

#[tokio::test]
async fn upload_chunks_go_through_the_router() {
    let state = auth_state();
    let token = state.api_token().to_string();
    let app = router_with_auth(state, WebAuth::new(None, false));
    let id = format!("router-{}", uuid::Uuid::new_v4().simple());
    let response = app
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri(format!("/api/uploads/{id}"))
                .header(TOKEN_HEADER, &token)
                .header("x-adboard-offset", "0")
                .body(Body::from(vec![7u8; 1024]))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(body_text(response).await.contains(r#""received":1024"#));
    let mut headers = HeaderMap::new();
    headers.insert(crate::uploads::UPLOAD_HEADER, id.parse().unwrap());
    let staged = crate::uploads::request_body(&headers, Bytes::new()).await.unwrap();
    assert_eq!(staged.len(), 1024);
}

fn change_request(body: &str, headers: &[(&str, &str)]) -> Request<Body> {
    let mut builder = Request::builder()
        .method("POST")
        .uri("/api/account/password")
        .header("content-type", "application/json");
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    builder.body(Body::from(body.to_string())).unwrap()
}

#[tokio::test]
async fn password_can_be_set_and_changed() {
    // No account: refused through a proxy, allowed on the LAN.
    let app = router_with_auth(auth_state(), WebAuth::new(None, false));
    let proxied = app
        .clone()
        .oneshot(change_request(
            r#"{"newPassword":"lan-first-1"}"#,
            &[("x-forwarded-for", "203.0.113.9")],
        ))
        .await
        .unwrap();
    assert_eq!(proxied.status(), StatusCode::FORBIDDEN);
    let lan = app
        .clone()
        .oneshot(change_request(r#"{"username":"ops","newPassword":"lan-first-1"}"#, &[]))
        .await
        .unwrap();
    assert_eq!(lan.status(), StatusCode::OK);
    let cookie = lan.headers()[header::SET_COOKIE].to_str().unwrap().split(';').next().unwrap().to_string();

    // Now an account exists: changing needs a session and the current password.
    let anon = app
        .clone()
        .oneshot(change_request(r#"{"currentPassword":"lan-first-1","newPassword":"changed-22"}"#, &[]))
        .await
        .unwrap();
    assert_eq!(anon.status(), StatusCode::UNAUTHORIZED);
    let wrong = app
        .clone()
        .oneshot(change_request(
            r#"{"currentPassword":"nope","newPassword":"changed-22"}"#,
            &[("cookie", &cookie)],
        ))
        .await
        .unwrap();
    assert_eq!(wrong.status(), StatusCode::UNAUTHORIZED);
    let short = app
        .clone()
        .oneshot(change_request(
            r#"{"currentPassword":"lan-first-1","newPassword":"short"}"#,
            &[("cookie", &cookie)],
        ))
        .await
        .unwrap();
    assert_eq!(short.status(), StatusCode::BAD_REQUEST);
    let ok = app
        .clone()
        .oneshot(change_request(
            r#"{"currentPassword":"lan-first-1","newPassword":"changed-22"}"#,
            &[("cookie", &cookie)],
        ))
        .await
        .unwrap();
    assert_eq!(ok.status(), StatusCode::OK);

    // Old cookie is gone; new password signs in as the same user.
    let old = app.clone().oneshot(get("/api/bootstrap", &[("cookie", &cookie)])).await.unwrap();
    assert_eq!(old.status(), StatusCode::UNAUTHORIZED);
    let mut login = Request::builder()
        .method("POST")
        .uri("/api/login")
        .header("content-type", "application/json");
    login = login.header("x-test", "1");
    let signed = app
        .oneshot(login.body(Body::from(r#"{"username":"ops","password":"changed-22"}"#)).unwrap())
        .await
        .unwrap();
    assert_eq!(signed.status(), StatusCode::OK);
}

#[tokio::test]
async fn the_keyframe_reset_on_a_new_stream_waits_for_its_first_frame() {
    use crate::video::VideoPacket;
    let (tx, mut rx) = tokio::sync::broadcast::channel::<VideoPacket>(8);
    // Status frames are not video: still waiting when the limit passes.
    tx.send(VideoPacket::Status(VideoStatusFrame {
        serial: "A".into(),
        stream: adboard_protocol::StreamState::Starting,
        note: String::new(),
        backend: "scrcpy".into(),
        codec: None,
        codec_string: None,
        width: None,
        height: None,
        framing: None,
    }))
    .unwrap();
    assert!(!first_access_unit(&mut rx, std::time::Duration::from_millis(100)).await);
    // The first access unit ends the wait at once.
    let sender = tx.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let _ = sender.send(VideoPacket::AnnexB(vec![0, 0, 0, 1, 0x65].into()));
    });
    let started = std::time::Instant::now();
    assert!(first_access_unit(&mut rx, std::time::Duration::from_secs(5)).await);
    assert!(started.elapsed() < std::time::Duration::from_secs(2));
    // A stream that went away does not hold the socket for the whole limit.
    drop(tx);
    assert!(!first_access_unit(&mut rx, std::time::Duration::from_secs(5)).await);
}

#[test]
fn the_heartbeat_status_frame_keeps_every_field_and_adds_the_beat() {
    let frame = VideoStatusFrame {
        serial: "A".into(),
        stream: adboard_protocol::StreamState::Streaming,
        note: "ok".into(),
        backend: "scrcpy".into(),
        codec: Some("h264".into()),
        codec_string: None,
        width: Some(1080),
        height: Some(2400),
        framing: None,
    };
    let plain: serde_json::Value = serde_json::to_value(&frame).unwrap();
    let beat: serde_json::Value = serde_json::from_str(&status_with_heartbeat(&frame)).unwrap();
    assert_eq!(beat["heartbeat"], 5);
    for (key, value) in plain.as_object().unwrap() {
        assert_eq!(&beat[key], value, "{key}");
    }
}

// ---- video socket: how it ends, and why the browser is told ----

async fn serve(state: AppState) -> (std::net::SocketAddr, String) {
    let token = state.api_token().to_string();
    let app = router_with_auth(state, WebAuth::new(None, false));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (addr, token)
}

fn authed_ws(addr: std::net::SocketAddr, path: &str, token: &str) -> tokio_tungstenite::tungstenite::handshake::client::Request {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let mut request = format!("ws://{addr}{path}").into_client_request().unwrap();
    request.headers_mut().insert(
        "sec-websocket-protocol",
        format!("adboard, adboard-token.{}", hex(token)).parse().unwrap(),
    );
    request
}

/// Read until the server closes: the status frames it sent, and the close code and reason.
async fn read_until_close(
    socket: &mut tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
) -> (Vec<String>, Option<(u16, String)>) {
    let mut texts = Vec::new();
    let result = tokio::time::timeout(std::time::Duration::from_secs(20), async {
        while let Some(message) = socket.next().await {
            match message {
                Ok(tokio_tungstenite::tungstenite::Message::Text(text)) => texts.push(text.to_string()),
                Ok(tokio_tungstenite::tungstenite::Message::Close(frame)) => {
                    return frame.map(|f| (u16::from(f.code), f.reason.to_string()));
                }
                Ok(_) => {}
                Err(_) => return None,
            }
        }
        None
    })
    .await
    .expect("the server closed the socket");
    (texts, result)
}

#[tokio::test]
async fn an_unknown_phone_gets_an_error_frame_and_a_close_code_naming_the_reason() {
    let (addr, token) = serve(auth_state()).await;
    let (mut socket, _) = tokio_tungstenite::connect_async(authed_ws(addr, "/ws/devices/NO-SUCH-PHONE/video", &token))
        .await
        .unwrap();
    let (texts, close) = read_until_close(&mut socket).await;
    assert!(texts.iter().any(|t| t.contains("\"stream\":\"error\"")), "the page is told why: {texts:?}");
    let (code, reason) = close.expect("a close frame with a code, not a bare TCP close");
    assert_eq!(code, 4004);
    assert_eq!(reason, "unknown device");
}

#[tokio::test]
async fn a_remote_agent_whose_video_socket_cannot_be_opened_is_reported_as_the_agent() {
    let state = auth_state();
    // A phone that belongs to a remote host whose video port nothing listens on.
    let mut phone = state.list_devices().await.remove(0);
    phone.serial = "REMOTE-PHONE-1".into();
    phone.id = "REMOTE-PHONE-1".into();
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let cancel = Arc::new(tokio::sync::Notify::new());
    state
        .inner
        .mesh
        .register("lxc".into(), "lxc".into(), "linux".into(), tx, Some("http://127.0.0.1:1".into()), cancel)
        .await
        .unwrap();
    state.inner.mesh.set_devices("lxc", vec![phone]).await;

    let (addr, token) = serve(state).await;
    let (mut socket, _) = tokio_tungstenite::connect_async(authed_ws(addr, "/ws/devices/REMOTE-PHONE-1/video", &token))
        .await
        .unwrap();
    let (texts, close) = read_until_close(&mut socket).await;
    assert!(texts.iter().any(|t| t.contains("video proxy connect failed")), "{texts:?}");
    let (code, _) = close.expect("a close frame");
    assert_eq!(code, 4010, "the agent's video could not be reached, which is not the phone's fault");
}

#[tokio::test]
async fn a_remote_agent_going_away_leaves_the_local_phones_alone() {
    let state = auth_state();
    let ids = |devices: &[adboard_protocol::Device]| -> Vec<(String, adboard_protocol::DeviceStatus)> {
        let mut out: Vec<_> = devices.iter().map(|d| (d.id.clone(), d.status)).collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    };
    let local_before = ids(&state.list_devices().await);
    assert!(!local_before.is_empty());

    let mut remote = state.list_devices().await.remove(0);
    remote.id = "lxc-phone".into();
    remote.serial = "lxc-phone".into();
    remote.status = adboard_protocol::DeviceStatus::Online;
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let cancel = Arc::new(tokio::sync::Notify::new());
    let conn = state
        .inner
        .mesh
        .register("lxc".into(), "lxc".into(), "linux".into(), tx, None, cancel)
        .await
        .unwrap();
    state.inner.mesh.set_devices("lxc", vec![remote]).await;
    let with_remote = ids(&state.list_devices().await);
    assert!(with_remote.iter().any(|(id, s)| id == "lxc-phone" && *s == adboard_protocol::DeviceStatus::Online));

    // The agent drops: its phone leaves the list, and every local phone is exactly as it was.
    assert!(state.inner.mesh.unregister_conn("lxc", conn).await);
    let after = ids(&state.list_devices().await);
    assert_eq!(after, local_before, "a remote failure must not touch local phones or their state");
}

// ---- a viewer's socket stays up: only its own failure or its own close ends it ----

type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// What arrived in `ms`: pictures (binary), text frames, and the close code if the server closed it.
#[derive(Default, Debug)]
struct Window {
    pictures: usize,
    texts: Vec<String>,
    closed: Option<u16>,
}

async fn collect(socket: &mut Socket, ms: u64) -> Window {
    let mut seen = Window::default();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(ms);
    while let Ok(Some(message)) = tokio::time::timeout_at(deadline, socket.next()).await {
        match message {
            Ok(tokio_tungstenite::tungstenite::Message::Binary(_)) => seen.pictures += 1,
            Ok(tokio_tungstenite::tungstenite::Message::Text(text)) => seen.texts.push(text.to_string()),
            Ok(tokio_tungstenite::tungstenite::Message::Close(frame)) => {
                seen.closed = Some(frame.map(|f| u16::from(f.code)).unwrap_or(0));
                break;
            }
            Ok(_) => {}
            Err(_) => {
                seen.closed = Some(1006);
                break;
            }
        }
    }
    seen
}

/// Wait until `count` pictures have arrived (a live ffmpeg test pattern takes a moment to start).
async fn until_pictures(socket: &mut Socket, count: usize) -> Window {
    let mut total = Window::default();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    while total.pictures < count && total.closed.is_none() && tokio::time::Instant::now() < deadline {
        let step = collect(socket, 300).await;
        total.pictures += step.pictures;
        total.texts.extend(step.texts);
        total.closed = step.closed;
    }
    total
}

async fn open_video(addr: std::net::SocketAddr, serial: &str, token: &str) -> Socket {
    let (socket, _) = tokio_tungstenite::connect_async(authed_ws(addr, &format!("/ws/devices/{serial}/video"), token))
        .await
        .unwrap();
    socket
}

fn viewer(active: bool) -> tokio_tungstenite::tungstenite::Message {
    tokio_tungstenite::tungstenite::Message::Text(format!(r#"{{"type":"viewer","active":{active}}}"#).into())
}

fn heartbeats(window: &Window) -> usize {
    window.texts.iter().filter(|t| t.contains("\"heartbeat\"")).count()
}

#[tokio::test]
async fn an_idle_viewer_gets_no_pictures_but_keeps_its_heartbeat_and_comes_back_on_request() {
    let state = auth_state();
    let serial = state.list_devices().await[0].serial.clone();
    let (addr, token) = serve(state).await;
    let mut socket = open_video(addr, &serial, &token).await;

    let started = until_pictures(&mut socket, 5).await;
    assert!(started.pictures >= 5, "a new viewer is sent pictures: {started:?}");
    assert_eq!(started.closed, None);

    // The page goes idle (hidden window): pictures stop. The connection and its heartbeat do not.
    socket.send(viewer(false)).await.unwrap();
    let _drain = collect(&mut socket, 400).await;
    let idle = collect(&mut socket, 6500).await;
    assert_eq!(idle.pictures, 0, "no pictures while idle: {idle:?}");
    assert_eq!(idle.closed, None, "an idle viewer is not a dead one");
    assert!(heartbeats(&idle) >= 1, "the heartbeat continues while idle: {idle:?}");

    // Back in the foreground: pictures resume on the same socket, starting with a replayed keyframe.
    socket.send(viewer(true)).await.unwrap();
    let back = until_pictures(&mut socket, 3).await;
    assert!(back.pictures >= 3, "pictures resume: {back:?}");
    assert_eq!(back.closed, None);
}

#[tokio::test]
async fn a_phone_that_sends_no_video_does_not_close_its_viewers_socket() {
    let state = auth_state();
    let serial = state.list_devices().await[0].serial.clone();
    let (addr, token) = serve(state.clone()).await;
    let mut socket = open_video(addr, &serial, &token).await;
    assert!(until_pictures(&mut socket, 5).await.pictures >= 5);

    // The phone's stream stops (a still, dark or stopped screen): no pictures at all for longer than a heartbeat.
    state.inner.sessions.stop(&serial).await;
    let _drain = collect(&mut socket, 500).await;
    let quiet = collect(&mut socket, 6500).await;
    assert_eq!(quiet.pictures, 0, "{quiet:?}");
    assert_eq!(quiet.closed, None, "no video is not a reason to close the viewer: {quiet:?}");
    assert!(heartbeats(&quiet) >= 1, "heartbeats go on: {quiet:?}");

    // The stream comes back and reaches the same socket.
    state.inner.sessions.start(&serial).await;
    let again = until_pictures(&mut socket, 3).await;
    assert!(again.pictures >= 3, "the same socket carries the new stream: {again:?}");
    assert_eq!(again.closed, None);
}

#[tokio::test]
async fn viewers_of_different_phones_are_independent() {
    let state = auth_state();
    let phones: Vec<String> = state.list_devices().await.iter().map(|d| d.serial.clone()).take(2).collect();
    assert_eq!(phones.len(), 2);
    let (addr, token) = serve(state.clone()).await;
    let mut first = open_video(addr, &phones[0], &token).await;
    let mut second = open_video(addr, &phones[1], &token).await;
    assert!(until_pictures(&mut first, 5).await.pictures >= 5);
    assert!(until_pictures(&mut second, 5).await.pictures >= 5);

    // One phone's stream stops and its viewer goes idle; the other viewer carries on untouched.
    state.inner.sessions.stop(&phones[0]).await;
    first.send(viewer(false)).await.unwrap();
    let other = collect(&mut second, 2500).await;
    assert!(other.pictures > 10, "the other phone keeps streaming: {other:?}");
    assert_eq!(other.closed, None);
    let stopped = collect(&mut first, 500).await;
    assert_eq!(stopped.closed, None, "and the stopped one is still connected");
}

#[tokio::test]
async fn a_client_that_goes_completely_silent_is_still_closed() {
    // Not reading (so no pongs) and sending nothing: the one case that must still end the socket.
    let state = auth_state();
    let serial = state.list_devices().await[0].serial.clone();
    let (addr, token) = serve(state).await;
    let mut socket = open_video(addr, &serial, &token).await;
    // Say nothing and do not read for longer than the (test) silence limit plus one heartbeat tick.
    tokio::time::sleep(std::time::Duration::from_secs(8)).await;
    let seen = collect(&mut socket, 3000).await;
    // The close frame says 4009 when it reaches the client. The agent drops a connection that has unread data
    // queued, which can reset it before the frame is read; either way the socket is closed by the agent.
    assert!(
        matches!(seen.closed, Some(4009) | Some(1006)),
        "the agent closes a connection that shows no sign of life: {seen:?}"
    );
}

#[tokio::test]
async fn closing_the_viewer_releases_its_connection() {
    let state = auth_state();
    let serial = state.list_devices().await[0].serial.clone();
    let (addr, token) = serve(state.clone()).await;
    let mut socket = open_video(addr, &serial, &token).await;
    assert!(until_pictures(&mut socket, 3).await.pictures >= 3);
    socket.close(None).await.unwrap();
    drop(socket);
    // The subscriber is gone; the phone's session keeps running for the next viewer.
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    assert_eq!(
        state.inner.sessions.get_session(&serial).await.map(|s| s.stream),
        Some(adboard_protocol::StreamState::Streaming)
    );
    let mut again = open_video(addr, &serial, &token).await;
    assert!(until_pictures(&mut again, 3).await.pictures >= 3, "a new viewer connects cleanly");
}

#[tokio::test]
async fn a_remote_agent_that_drops_mid_stream_is_reported_as_the_agent_and_its_viewer_recovers_when_it_returns() {
    use tokio_tungstenite::tungstenite::Message as Wire;
    // A stand-in for a remote agent's video socket: the first connection streams a little and drops, the
    // second (the browser's retry) streams for as long as it is open.
    let fake = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let fake_addr = fake.local_addr().unwrap();
    tokio::spawn(async move {
        for attempt in 0..2 {
            let (stream, _) = fake.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            let status = r#"{"serial":"LXC-PHONE","stream":"streaming","note":"fake","backend":"scrcpy","heartbeat":5}"#;
            ws.send(Wire::Text(status.into())).await.unwrap();
            ws.send(Wire::Binary(vec![0, 0, 0, 1, 0x65, 0x88].into())).await.unwrap();
            if attempt == 0 {
                // Dropped without a word: the controller sees the agent's socket end.
                drop(ws);
            } else {
                for _ in 0..40 {
                    ws.send(Wire::Binary(vec![0, 0, 0, 1, 0x41, 0x9a].into())).await.ok();
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
            }
        }
    });

    let state = auth_state();
    let mut phone = state.list_devices().await.remove(0);
    phone.serial = "LXC-PHONE".into();
    phone.id = "LXC-PHONE".into();
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    state
        .inner
        .mesh
        .register("lxc".into(), "lxc".into(), "linux".into(), tx, Some(format!("http://{fake_addr}")), Arc::new(tokio::sync::Notify::new()))
        .await
        .unwrap();
    state.inner.mesh.set_devices("lxc", vec![phone]).await;
    let local_before: Vec<String> = state.list_devices().await.iter().filter(|d| d.id != "LXC-PHONE").map(|d| d.id.clone()).collect();

    let (addr, token) = serve(state.clone()).await;
    // First attempt: the agent's socket drops; the viewer is told it was the remote agent, with code 4011.
    let mut first = open_video(addr, "LXC-PHONE", &token).await;
    let seen = collect(&mut first, 4000).await;
    assert!(seen.pictures >= 1, "what the agent sent before it dropped is forwarded: {seen:?}");
    assert_eq!(seen.closed, Some(4011), "an agent link that ends is reported as the remote agent: {seen:?}");

    // The viewer's retry reaches the agent when it is back and streams on the same route.
    let mut second = open_video(addr, "LXC-PHONE", &token).await;
    let back = until_pictures(&mut second, 8).await;
    assert!(back.pictures >= 8, "the stream recovers once the agent is reachable: {back:?}");
    assert_eq!(back.closed, None);

    // Meanwhile nothing local was touched.
    let local_after: Vec<String> = state.list_devices().await.iter().filter(|d| d.id != "LXC-PHONE").map(|d| d.id.clone()).collect();
    assert_eq!(local_after, local_before, "a remote agent's trouble leaves local phones alone");
}

#[tokio::test]
async fn a_page_video_report_is_accepted_with_the_token_and_kept_to_one_bounded_line() {
    let state = auth_state();
    let token = state.api_token().to_string();
    let app = router_with_auth(state, WebAuth::new(None, false));
    let body = serde_json::json!({ "serial": "R5CR50A96VZ\nfake line", "event": "stall", "pipeline": { "acceptingVideo": false }, "pad": "x".repeat(5000) });
    let request = |token: Option<&str>| {
        let mut builder = Request::builder().method("POST").uri("/api/diagnostics/video").header("content-type", "application/json");
        if let Some(token) = token {
            builder = builder.header(TOKEN_HEADER, token);
        }
        builder.body(Body::from(body.to_string())).unwrap()
    };
    assert_eq!(app.clone().oneshot(request(Some(&token))).await.unwrap().status(), StatusCode::NO_CONTENT);
    assert_eq!(app.oneshot(request(None)).await.unwrap().status(), StatusCode::UNAUTHORIZED, "like every API route");

    let (serial, event, detail) = video_report_line(&body);
    assert_eq!(serial, "R5CR50A96VZfake line", "no line breaks from the page reach the log");
    assert_eq!(event, "stall");
    assert!(detail.len() <= 4000 + "…".len());
    assert!(detail.starts_with("pipeline={\"acceptingVideo\":false}"), "where the picture is held comes first: {}", &detail[..80]);
}

// ---- restart detection and where pictures stop ----

#[tokio::test]
async fn health_names_this_process_so_a_page_can_tell_a_restart() {
    let state = auth_state();
    let (addr, _token) = serve(state).await;
    let read = || async move {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        stream
            .write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        let mut raw = String::new();
        stream.read_to_string(&mut raw).await.unwrap();
        let body = &raw[raw.find('{').expect("a JSON body")..raw.rfind('}').unwrap() + 1];
        serde_json::from_str::<serde_json::Value>(body).unwrap()
    };
    let first = read().await;
    let second = read().await;
    let instance = first["instance"].as_str().unwrap_or_default().to_string();
    assert_eq!(instance.len(), 12, "{first}");
    assert_eq!(second["instance"], first["instance"], "the same process answers with the same id");
    assert!(first["uptimeSecs"].is_u64(), "{first}");
    assert!(first["ready"].is_boolean(), "{first}");
}

#[tokio::test]
async fn a_video_heartbeat_says_what_the_phone_produced_and_what_this_socket_was_sent() {
    let state = auth_state();
    let serial = state.list_devices().await[0].serial.clone();
    let (addr, token) = serve(state).await;
    let mut socket = open_video(addr, &serial, &token).await;
    let mut window = until_pictures(&mut socket, 3).await;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(8);
    while !window.texts.iter().any(|t| t.contains("\"sentFrames\"")) && tokio::time::Instant::now() < deadline {
        let more = collect(&mut socket, 500).await;
        window.pictures += more.pictures;
        window.texts.extend(more.texts);
    }
    let beat = window.texts.iter().rev().find(|t| t.contains("\"sentFrames\"")).expect("a heartbeat with link counters");
    let beat: serde_json::Value = serde_json::from_str(beat).unwrap();
    assert!(beat["sourceFrames"].as_u64().unwrap() >= 3, "{beat}");
    assert!(beat["sentFrames"].as_u64().unwrap() >= 3, "{beat}");
    assert!(beat["sourceIdleMs"].is_u64(), "{beat}");
    assert_eq!(beat["instance"].as_str().map(str::len), Some(12), "{beat}");
}
