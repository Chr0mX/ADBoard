//! The per-phone virtual display limit chosen in Settings, saved in
//! `config/virtual-display.json` in the ADBoard data folder. Without it the
//! limit comes from `ADBOARD_MAX_VIRTUAL_DISPLAYS` (default 1).

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

const FILE_NAME: &str = "virtual-display.json";

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Saved {
    #[serde(default)]
    max_per_phone: Option<u32>,
}

fn path() -> PathBuf {
    crate::data_dir::config_dir().join(FILE_NAME)
}

/// Read the saved limit at startup. A missing or unreadable file means the
/// environment decides.
pub fn load() {
    let Ok(bytes) = std::fs::read(path()) else {
        return;
    };
    match serde_json::from_slice::<Saved>(&bytes) {
        Ok(saved) => crate::virtual_display::set_limit_override(saved.max_per_phone),
        Err(error) => tracing::warn!(%error, "cannot read {FILE_NAME}; using the default limit"),
    }
}

/// Save the limit (`None` goes back to the environment's) and apply it now.
pub fn save_limit(limit: Option<u32>) -> Result<(), String> {
    let saved = Saved {
        max_per_phone: limit.map(|n| n.clamp(1, crate::virtual_display::CEILING_PER_PHONE)),
    };
    let mut body = serde_json::to_vec_pretty(&saved).map_err(|e| e.to_string())?;
    body.push(b'\n');
    crate::shared_store::write_atomic(&path(), &body)?;
    crate::virtual_display::set_limit_override(saved.max_per_phone);
    Ok(())
}
