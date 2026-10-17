//! Data-folder routes for Settings → Data & storage.
//!
//! - `GET  /api/system/storage` — where everything is kept, which file holds
//!   each macro and script, and the last migration result.
//! - `POST /api/system/open-folder` `{ which }` — open a data folder in the
//!   file manager of the computer running ADBoard.
//! - `POST /api/system/backup` — copy macros, scripts, settings and logs to
//!   `backups/backup-<date>/`.

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
    let folders: serde_json::Map<String, serde_json::Value> = ["macros", "shell_scripts", "config", "logs", "backups", "files"]
        .iter()
        .map(|name| (name.to_string(), json!(root.path.join(name).display().to_string())))
        .collect();
    Json(json!({
        "dataDir": root.path.display().to_string(),
        "source": root.source,
        "platform": std::env::consts::OS,
        "folders": folders,
        "itemFiles": { "macros": s.item_files("macros"), "shellScripts": s.item_files("desk") },
        "migration": crate::migrate::last_report(&root.path),
        "editable": ["macros/*.adboard-macro.json", "shell_scripts/*.adboard-shell.json", "config/user_config.json"],
        "doNotEdit": ["config/.revisions.json", "config/browser_state.json", "config/builder_state.json", "config/migration.json", "config/auth.json"],
    }))
    .into_response()
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
