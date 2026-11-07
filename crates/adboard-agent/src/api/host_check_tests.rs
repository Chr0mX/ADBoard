use super::*;

#[test]
fn tokens_match_only_when_identical() {
    assert!(tokens_match("abc-123", "abc-123"));
    assert!(!tokens_match("abc-124", "abc-123"));
    assert!(!tokens_match("abc-12", "abc-123"));
    assert!(!tokens_match("abc-1234", "abc-123"));
    assert!(!tokens_match("", "abc-123"));
    assert!(tokens_match("", ""));
}
use axum::http::HeaderValue;

fn with_host(host: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(header::HOST, HeaderValue::from_str(host).unwrap());
    headers
}

#[test]
fn host_name_strips_port_and_brackets() {
    assert_eq!(host_name("attacker.example:3848"), "attacker.example");
    assert_eq!(host_name("192.168.69.174:3848"), "192.168.69.174");
    assert_eq!(host_name("[::1]:3848"), "::1");
    assert_eq!(host_name("::1"), "::1");
    assert_eq!(host_name("localhost"), "localhost");
}

#[test]
fn direct_addresses_are_allowed_and_rebinding_names_are_not() {
    assert!(host_is_direct(&with_host("127.0.0.1:3848")));
    assert!(host_is_direct(&with_host("192.168.69.174:3848")));
    assert!(host_is_direct(&with_host("[::1]:3848")));
    assert!(host_is_direct(&with_host("localhost:3848")));
    assert!(!host_is_direct(&with_host("attacker.example:3848")));
    // No Host names no domain to rebind to; browsers always send one.
    assert!(host_is_direct(&HeaderMap::new()));
}
