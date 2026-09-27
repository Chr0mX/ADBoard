mod adb;
mod api;
mod device_manager;
mod mock;
mod session;

use crate::adb::adb_binary;
use crate::device_manager::AppState;
use std::net::SocketAddr;
use tracing::info;
use tracing_subscriber::EnvFilter;

/// Uncommon port — UI uses 3847; avoid 3000/5173/8080.
const DEFAULT_PORT: u16 = 3848;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,tower_http=info")),
        )
        .init();

    let port: u16 = std::env::var("PHONECONTROL_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_PORT);

    let host_name = std::env::var("PHONECONTROL_HOST")
        .unwrap_or_else(|_| hostname_fallback());

    let adb = adb_binary();
    let state = AppState::new(host_name.clone(), port, adb);
    state.spawn_adb_watcher();

    let app = api::router(state);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;

    info!(
        %addr,
        host = %host_name,
        "phonecontrol-agent listening (HTTP + WS)"
    );
    info!("  GET  /health");
    info!("  GET  /api/devices");
    info!("  POST /api/input/tap");
    info!("  POST /api/input/nav");
    info!("  WS   /ws");

    axum::serve(listener, app).await?;
    Ok(())
}

fn hostname_fallback() -> String {
    hostname::get_os_hostname().unwrap_or_else(|| "linux-agent".into())
}

mod hostname {
    pub fn get_os_hostname() -> Option<String> {
        std::fs::read_to_string("/etc/hostname")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .or_else(|| std::env::var("HOSTNAME").ok())
    }
}
