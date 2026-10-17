//! Host file HTTP handlers (list, upload, delete, op, raw download).

use axum::body::Bytes;
use axum::extract::Query;
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use axum::Json;
use adboard_protocol::HostFileEntry;

#[derive(serde::Deserialize)]
pub struct HostPathQuery {
    #[serde(default)]
    pub path: String,
}

#[derive(serde::Deserialize)]
pub struct HostFileOpBody {
    pub op: String,
    pub path: String,
    #[serde(default)]
    pub dest: String,
}

pub async fn list_files(
    Query(query): Query<HostPathQuery>,
) -> Result<Json<Vec<HostFileEntry>>, (StatusCode, String)> {
    let root = crate::device_ops::files_root();
    let dir = crate::device_ops::host_path(&root, &query.path)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    let mut entries = Vec::new();
    let read = std::fs::read_dir(&dir).map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    for item in read.flatten() {
        let name = item.file_name().to_string_lossy().to_string();
        let meta = item.metadata().ok();
        let rel = if query.path.is_empty() {
            name.clone()
        } else {
            format!("{}/{}", query.path.trim_matches('/'), name)
        };
        entries.push(HostFileEntry {
            name,
            path: rel,
            dir: meta.as_ref().map(|m| m.is_dir()).unwrap_or(false),
            size: meta.map(|m| m.len()).unwrap_or(0),
        });
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(Json(entries))
}

pub async fn delete_file(
    Query(query): Query<HostPathQuery>,
) -> Result<StatusCode, (StatusCode, String)> {
    if query.path.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "path is required".into()));
    }
    let root = crate::device_ops::files_root();
    let path = crate::device_ops::host_path(&root, &query.path)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    if path == root {
        return Err((
            StatusCode::BAD_REQUEST,
            "refusing to delete the file root".into(),
        ));
    }
    if path.is_dir() {
        std::fs::remove_dir_all(&path).map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    } else {
        std::fs::remove_file(&path).map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    }
    Ok(StatusCode::NO_CONTENT)
}

pub async fn upload_file(
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<HostFileEntry>, (StatusCode, String)> {
    let body = crate::uploads::request_body(&headers, body).await?;
    let filename =
        header_value(&headers, "x-adboard-filename").unwrap_or_else(|| "upload.bin".into());
    let dir = header_value(&headers, "x-adboard-dir").unwrap_or_else(|| "Downloads".into());
    if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return Err((StatusCode::BAD_REQUEST, "invalid filename".into()));
    }
    let root = crate::device_ops::files_root();
    let rel = format!("{}/{}", dir.trim_matches('/'), filename);
    let path =
        crate::device_ops::host_path(&root, &rel).map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    }
    tokio::fs::write(&path, &body)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    Ok(Json(HostFileEntry {
        name: filename,
        path: rel,
        dir: false,
        size: body.len() as u64,
    }))
}

pub async fn apply_op(
    Json(body): Json<HostFileOpBody>,
) -> Result<Json<HostFileEntry>, (StatusCode, String)> {
    let root = crate::device_ops::files_root();
    let rel = crate::device_ops::apply_host_op(&root, &body.op, &body.path, &body.dest)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    let full = crate::device_ops::host_path(&root, &rel).map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    let meta = std::fs::metadata(&full).ok();
    let name = full
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&rel)
        .to_string();
    Ok(Json(HostFileEntry {
        name,
        path: rel,
        dir: meta.as_ref().map(|m| m.is_dir()).unwrap_or(false),
        size: meta.map(|m| m.len()).unwrap_or(0),
    }))
}

pub async fn raw_file(
    Query(query): Query<HostPathQuery>,
) -> Result<Response, (StatusCode, String)> {
    let root = crate::device_ops::files_root();
    let path = crate::device_ops::host_path(&root, &query.path)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| (StatusCode::NOT_FOUND, e.to_string()))?;
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    Response::builder()
        .header("content-type", "application/octet-stream")
        .header(
            "content-disposition",
            format!("attachment; filename=\"{name}\""),
        )
        .body(axum::body::Body::from(bytes))
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

fn header_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}
