use super::*;
use std::os::unix::fs::PermissionsExt;

fn fake_adb(dir: &std::path::Path, script: &str) -> PathBuf {
    let path = dir.join("adb");
    std::fs::write(&path, format!("#!/bin/sh\necho \"$@\" >> \"{}/calls\"\n{script}\n", dir.display())).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

fn temp_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("adboard-fakeadb-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

const SPLICE: &str = "echo 'adb: failed to install x.apk: Error: failed to write; splice failed: EINVAL (Invalid argument)' >&2; echo 'Performing Streamed Install'; exit 1";

#[test]
fn detects_streamed_install_failures() {
    assert!(streamed_install_failed("failed to write; splice failed: EINVAL (Invalid argument) | Performing Streamed Install"));
    assert!(!streamed_install_failed("Failure [INSTALL_FAILED_VERSION_DOWNGRADE]"));
}

#[tokio::test]
async fn retries_without_streaming() {
    let dir = temp_dir();
    let adb = fake_adb(&dir, &format!("case \"$*\" in *--no-streaming*) echo Success; exit 0;; *) {SPLICE};; esac"));
    let apk = dir.join("app.apk");
    std::fs::write(&apk, b"PK").unwrap();
    install_with_fallback(&adb, "SER1", &apk).await.unwrap();
    let calls = std::fs::read_to_string(dir.join("calls")).unwrap();
    assert_eq!(calls.lines().count(), 2, "{calls}");
    assert!(calls.lines().nth(1).unwrap().contains("--no-streaming"));
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn falls_back_to_push_and_pm_install() {
    let dir = temp_dir();
    let adb = fake_adb(
        &dir,
        &format!("case \"$*\" in *' push '*) exit 0;; *'pm install'*) echo Success; exit 0;; *' rm '*) exit 0;; *) {SPLICE};; esac"),
    );
    let apk = dir.join("app.apk");
    std::fs::write(&apk, b"PK").unwrap();
    install_with_fallback(&adb, "SER1", &apk).await.unwrap();
    let calls = std::fs::read_to_string(dir.join("calls")).unwrap();
    assert!(calls.contains("push") && calls.contains("pm install") && calls.contains("rm -f"), "{calls}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn other_failures_are_not_retried() {
    let dir = temp_dir();
    let adb = fake_adb(&dir, "echo 'Failure [INSTALL_FAILED_VERSION_DOWNGRADE]'; exit 1");
    let apk = dir.join("app.apk");
    std::fs::write(&apk, b"PK").unwrap();
    let err = install_with_fallback(&adb, "SER1", &apk).await.unwrap_err();
    assert!(err.contains("VERSION_DOWNGRADE"));
    let calls = std::fs::read_to_string(dir.join("calls")).unwrap();
    assert_eq!(calls.lines().count(), 1);
    let _ = std::fs::remove_dir_all(&dir);
}
