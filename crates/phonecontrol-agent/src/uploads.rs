//! Chunked uploads so large files pass proxies with a per-request body cap
//! (Cloudflare Free/Pro: 100 MB). The browser sends `PUT /api/uploads/{id}`
//! chunks with `x-phonecontrol-offset`, then calls the real endpoint (install,
//! push, host upload) with `x-phonecontrol-upload: {id}` and an empty body.

use axum::body::Bytes;
use axum::extract::Path;
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};
use tokio::io::AsyncWriteExt;

pub const UPLOAD_HEADER: &str = "x-phonecontrol-upload";
const OFFSET_HEADER: &str = "x-phonecontrol-offset";
/// Same cap as a single-request upload.
pub const MAX_UPLOAD_BYTES: u64 = 256 * 1024 * 1024;
/// Per-chunk body limit (the browser sends 32 MB chunks).
pub const MAX_CHUNK_BYTES: usize = 64 * 1024 * 1024;
const STALE_AFTER: Duration = Duration::from_secs(60 * 60);

fn valid_id(id: &str) -> bool {
    (8..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn staged_path(id: &str) -> PathBuf {
    crate::paths::app_temp_dir().join(format!("adboard-upload-{id}.part"))
}

fn remove_stale() {
    let Ok(entries) = std::fs::read_dir(crate::paths::app_temp_dir()) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !(name.starts_with("adboard-upload-") && name.ends_with(".part")) {
            continue;
        }
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .is_some_and(|age| age > STALE_AFTER);
        if old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[derive(serde::Serialize)]
pub struct ChunkAck {
    received: u64,
}

pub async fn put_chunk(
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<ChunkAck>, (StatusCode, String)> {
    if !valid_id(&id) {
        return Err((StatusCode::BAD_REQUEST, "invalid upload id".into()));
    }
    let offset: u64 = headers
        .get(OFFSET_HEADER)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse().ok())
        .ok_or((StatusCode::BAD_REQUEST, "missing x-phonecontrol-offset".into()))?;
    let path = staged_path(&id);
    if offset == 0 {
        remove_stale();
    }
    let current = tokio::fs::metadata(&path).await.map(|m| m.len()).unwrap_or(0);
    if offset != current {
        return Err((
            StatusCode::CONFLICT,
            format!("upload is at byte {current}, chunk starts at {offset}"),
        ));
    }
    if current + body.len() as u64 > MAX_UPLOAD_BYTES {
        let _ = tokio::fs::remove_file(&path).await;
        return Err((StatusCode::PAYLOAD_TOO_LARGE, "upload is larger than 256 MB".into()));
    }
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    file.write_all(&body)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    file.flush()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(ChunkAck {
        received: current + body.len() as u64,
    }))
}

/// The request body, or the staged upload named by `x-phonecontrol-upload`.
/// A staged file is consumed (deleted) once read.
pub async fn request_body(headers: &HeaderMap, body: Bytes) -> Result<Bytes, (StatusCode, String)> {
    let Some(id) = headers.get(UPLOAD_HEADER).and_then(|v| v.to_str().ok()) else {
        return Ok(body);
    };
    let id = id.trim();
    if !valid_id(id) {
        return Err((StatusCode::BAD_REQUEST, "invalid upload id".into()));
    }
    let path = staged_path(id);
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|_| (StatusCode::BAD_REQUEST, "upload not found or expired".into()))?;
    let _ = tokio::fs::remove_file(&path).await;
    Ok(Bytes::from(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn offset(n: u64) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(OFFSET_HEADER, HeaderValue::from_str(&n.to_string()).unwrap());
        h
    }

    #[tokio::test]
    async fn chunks_assemble_in_order() {
        let id = format!("test-{}", uuid::Uuid::new_v4().simple());
        let _ = put_chunk(Path(id.clone()), offset(0), Bytes::from_static(b"hello "))
            .await
            .unwrap();
        // Out-of-order chunk is refused with the current position.
        let err = put_chunk(Path(id.clone()), offset(2), Bytes::from_static(b"x"))
            .await
            .err()
            .unwrap();
        assert_eq!(err.0, StatusCode::CONFLICT);
        let _ = put_chunk(Path(id.clone()), offset(6), Bytes::from_static(b"world"))
            .await
            .unwrap();

        let mut headers = HeaderMap::new();
        headers.insert(UPLOAD_HEADER, HeaderValue::from_str(&id).unwrap());
        let body = request_body(&headers, Bytes::new()).await.unwrap();
        assert_eq!(&body[..], b"hello world");
        // Consumed: a second read fails.
        assert!(request_body(&headers, Bytes::new()).await.is_err());
    }

    #[tokio::test]
    async fn rejects_bad_ids_and_passes_plain_bodies() {
        assert!(put_chunk(Path("../etc".into()), offset(0), Bytes::new()).await.is_err());
        let body = request_body(&HeaderMap::new(), Bytes::from_static(b"direct")).await.unwrap();
        assert_eq!(&body[..], b"direct");
    }
}
