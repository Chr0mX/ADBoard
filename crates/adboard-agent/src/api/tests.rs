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
