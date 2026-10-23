//! Data-folder routes for Settings → Data & storage.
//!
//! - `GET  /api/system/storage` — where everything is kept, which file holds
//!   each macro and script, and the last migration result.
//! - `POST /api/system/open-folder` `{ which }` — open a data folder in the
//!   file manager of the computer running ADBoard.
//! - `POST /api/system/backup` — copy macros, scripts, settings and logs to
//!   `backups/backup-<date>/`.
//! - `POST /api/system/location` `{ path, mode }` — `use` saves a folder as the
//!   data location; `move` copies the data there first, checks the copy, then
//!   saves it. Takes effect on the next start. The old folder is kept.

use crate::data_dir;
use crate::shared_store::store;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;
use std::path::PathBuf;

/// Folders the UI may ask to open (never an arbitrary path).
fn folder(which: &str) -> Option<PathBuf> {
    let root = data_dir::root().path.clone();
    Some(match which {
        "root" => root,
        "macros" | "shell_scripts" | "config" | "logs" | "backups" | "files" => root.join(which),
        _ => return None,
    })
}

fn error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

pub async fn storage() -> Response {
    let root = data_dir::root();
    let s = store();
    let root_path = root.path.clone();
    let sizes = tokio::task::spawn_blocking(move || {
        ["macros", "shell_scripts", "config", "logs", "backups", "files", "temp"]
            .iter()
            .map(|name| {
                let (files, bytes) = data_dir::tree_stats(&root_path.join(name));
                (name.to_string(), json!({ "files": files, "bytes": bytes }))
            })
            .collect::<serde_json::Map<String, serde_json::Value>>()
    })
    .await
    .unwrap_or_default();
    let folders: serde_json::Map<String, serde_json::Value> = ["macros", "shell_scripts", "config", "logs", "backups", "files", "temp"]
        .iter()
        .map(|name| (name.to_string(), json!(root.path.join(name).display().to_string())))
        .collect();
    let saved = data_dir::app_dir().and_then(|dir| data_dir::read_location(&dir));
    Json(json!({
        "dataDir": root.path.display().to_string(),
        "source": root.source,
        "platform": std::env::consts::OS,
        "folders": folders,
        "sizes": sizes,
        "targets": {
            "app": data_dir::app_data_folder().map(|p| p.display().to_string()),
            "user": data_dir::user_folder().map(|p| p.display().to_string()),
            "appHasData": data_dir::app_data_folder().is_some_and(|p| data_dir::has_data(&p)),
            "userHasData": data_dir::user_folder().is_some_and(|p| data_dir::has_data(&p)),
        },
        "location": {
            "appFolder": data_dir::app_dir().map(|dir| dir.display().to_string()),
            "file": data_dir::app_dir().map(|dir| dir.join(data_dir::LOCATION_FILE).display().to_string()),
            "saved": saved.as_ref().map(|p| p.display().to_string()),
            "restartRequired": saved.as_ref().is_some_and(|p| p != &root.path),
        },
        "itemFiles": { "macros": s.item_files("macros"), "shellScripts": s.item_files("desk") },
        "migration": crate::migrate::last_report(&root.path),
        "editable": ["macros/*.json", "shell_scripts/*.json", "config/user_config.json"],
        "doNotEdit": ["config/.revisions.json", "config/browser_state.json", "config/builder_state.json", "config/migration.json", "config/auth.json"],
    }))
    .into_response()
}

#[derive(serde::Deserialize)]
pub struct LocationBody {
    path: String,
    /// `use` saves the folder as it is; `move` copies the data there first;
    /// `switch` saves the folder, copying first only if it holds no data yet.
    mode: String,
}

pub async fn set_location(Json(body): Json<LocationBody>) -> Response {
    tokio::task::spawn_blocking(move || set_location_blocking(body))
        .await
        .unwrap_or_else(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "The location change stopped unexpectedly."))
}

/// Copies the data to an empty `target`, checks the copy, then saves the location.
/// The old folder is never changed or deleted.
fn copy_and_save(from: &std::path::Path, target: &std::path::Path, app: &std::path::Path) -> Response {
    // What should arrive: everything except the scratch folder.
    let (all_files, all_bytes) = data_dir::tree_stats(from);
    let (temp_files, temp_bytes) = data_dir::tree_stats(&from.join("temp"));
    let expected = (all_files - temp_files, all_bytes - temp_bytes);
    let (files, bytes) = match data_dir::copy_tree(from, target) {
        Ok(copied) => copied,
        Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, &format!("The copy failed, nothing was changed: {e}")),
    };
    if data_dir::tree_stats(target) != expected || (files, bytes) != expected {
        return error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "The copy did not match the original, so the location was not changed. Your data is still in the old folder.",
        );
    }
    if let Err(e) = data_dir::write_location(app, target) {
        return error(StatusCode::INTERNAL_SERVER_ERROR, &e);
    }
    tracing::info!(from = %from.display(), to = %target.display(), files, bytes, "data copied (restart to use it)");
    Json(json!({
        "ok": true,
        "copied": true,
        "from": from.display().to_string(),
        "to": target.display().to_string(),
        "files": files,
        "bytes": bytes,
        "restartRequired": true,
    }))
    .into_response()
}

fn set_location_blocking(body: LocationBody) -> Response {
    let target = PathBuf::from(body.path.trim());
    let from = data_dir::root().path.clone();
    let Some(app) = data_dir::app_dir() else {
        return error(StatusCode::INTERNAL_SERVER_ERROR, "The app folder is not known, so the location can't be saved.");
    };
    match body.mode.as_str() {
        "use" => {
            if !target.is_absolute() {
                return error(StatusCode::BAD_REQUEST, "The folder must be a full path, for example D:\\adboard-data.");
            }
            if let Err(e) = std::fs::create_dir_all(&target) {
                return error(StatusCode::BAD_REQUEST, &format!("Can't use {}: {e}", target.display()));
            }
            if let Err(e) = data_dir::write_location(&app, &target) {
                return error(StatusCode::INTERNAL_SERVER_ERROR, &e);
            }
            tracing::info!(to = %target.display(), "data location saved (restart to use it)");
            Json(json!({ "ok": true, "mode": "use", "path": target.display().to_string(), "restartRequired": true })).into_response()
        }
        "move" => {
            if let Some(reason) = data_dir::move_refusal(&from, &target) {
                return error(StatusCode::CONFLICT, &reason);
            }
            copy_and_save(&from, &target, &app)
        }
        "switch" => {
            if !target.is_absolute() {
                return error(StatusCode::BAD_REQUEST, "The folder must be a full path.");
            }
            // The other copy already holds data: point at it, touch nothing.
            if data_dir::has_data(&target) {
                if let Err(e) = data_dir::write_location(&app, &target) {
                    return error(StatusCode::INTERNAL_SERVER_ERROR, &e);
                }
                tracing::info!(to = %target.display(), "data location switched (restart to use it)");
                return Json(json!({ "ok": true, "mode": "switch", "copied": false, "path": target.display().to_string(), "restartRequired": true })).into_response();
            }
            if let Some(reason) = data_dir::move_refusal(&from, &target) {
                return error(StatusCode::CONFLICT, &reason);
            }
            copy_and_save(&from, &target, &app)
        }
        _ => error(StatusCode::BAD_REQUEST, "mode must be \"use\", \"move\" or \"switch\""),
    }
}

#[derive(serde::Deserialize)]
pub struct OpenFolderBody {
    which: String,
}

pub async fn open_folder(Json(body): Json<OpenFolderBody>) -> Response {
    let Some(path) = folder(&body.which) else {
        return error(StatusCode::BAD_REQUEST, "unknown folder");
    };
    let _ = std::fs::create_dir_all(&path);
    let program = if cfg!(windows) {
        "explorer"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    // Explorer exits with 1 even when it opened the window: only a failure to
    // start the program is an error.
    match std::process::Command::new(program).arg(&path).spawn() {
        Ok(_) => Json(json!({ "ok": true, "path": path.display().to_string() })).into_response(),
        Err(e) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("Couldn't open a file manager on the ADBoard computer ({program}: {e}). The folder is {}", path.display()),
        ),
    }
}

pub async fn backup() -> Response {
    match store().backup_now() {
        Ok((path, files)) => Json(json!({ "ok": true, "path": path.display().to_string(), "files": files })).into_response(),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, &format!("Back up failed: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_folders_can_be_opened() {
        assert!(folder("macros").unwrap().ends_with("macros"));
        assert!(folder("root").is_some());
        assert!(folder("../etc").is_none());
        assert!(folder("C:\\Windows").is_none());
    }
}

#[cfg(test)]
mod switch_tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("adboard-switch-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn copy_and_save_copies_checks_and_keeps_the_source() {
        let base = temp("copy");
        let from = base.join("from");
        let to = base.join("to");
        let app = base.join("app");
        std::fs::create_dir_all(from.join("config")).unwrap();
        std::fs::create_dir_all(from.join("temp")).unwrap();
        std::fs::write(from.join("config").join("a.json"), b"hello").unwrap();
        std::fs::write(from.join("temp").join("scratch"), b"skip").unwrap();
        let response = copy_and_save(&from, &to, &app);
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(data_dir::tree_stats(&to), (1, 5));
        assert_eq!(data_dir::tree_stats(&from), (2, 9), "the source is unchanged");
        assert_eq!(data_dir::read_location(&app), Some(to.clone()));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn switch_saves_without_copying_when_the_other_copy_has_data() {
        let base = temp("switch");
        let other = base.join("other");
        let app = base.join("app");
        std::fs::create_dir_all(other.join("macros")).unwrap();
        assert!(data_dir::has_data(&other), "a folder with macros counts as data");
        // Switching to it is a save only; the existing copy is not touched.
        data_dir::write_location(&app, &other).unwrap();
        assert_eq!(data_dir::read_location(&app), Some(other.clone()));
        assert_eq!(data_dir::tree_stats(&other), (0, 0));
        let _ = std::fs::remove_dir_all(&base);
    }
}
