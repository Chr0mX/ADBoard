mod adb;
mod api;
mod audio;
mod device_manager;
mod device_ops;
mod host_files;
mod mesh;
mod mesh_client;
mod mock;
mod paths;
mod scrcpy_control;
mod scrcpy_video;
mod session;
mod video;

use crate::adb::adb_binary;
use crate::device_manager::AppState;
use crate::mesh::{controller_ws_url, parse_role};
use phonecontrol_protocol::Role;
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

    let role = parse_role();
    let port: u16 = std::env::var("PHONECONTROL_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(match role {
            Role::Controller => DEFAULT_PORT,
            Role::Agent => DEFAULT_PORT + 1,
        });

    let host_name = std::env::var("PHONECONTROL_HOST").unwrap_or_else(|_| hostname_fallback());
    let host_id = std::env::var("PHONECONTROL_HOST_ID").unwrap_or_else(|_| host_name.clone());
    let bind_ip = parse_bind_ip();

    let adb = adb_binary();
    let state = AppState::new(role, host_id.clone(), host_name.clone(), port, adb);
    state.spawn_adb_watcher();
    state.spawn_session_reaper();

    if role == Role::Agent {
        let url = controller_ws_url().unwrap_or_else(|| "ws://127.0.0.1:3848/ws/agent".into());
        let agent_state = state.clone();
        tokio::spawn(async move {
            mesh_client::run_agent_client(agent_state, url).await;
        });
    }

    let app = api::router(state);
    let addr = SocketAddr::from((bind_ip, port));
    let listener = tokio::net::TcpListener::bind(addr).await?;

    info!(
        %addr,
        role = role.as_str(),
        host_id = %host_id,
        host = %host_name,
        "phonecontrol-agent listening (HTTP + WS)"
    );
    info!("  GET  /          (control UI)");
    info!("  GET  /health");
    info!("  GET  /api/bootstrap");
    info!("  GET  /api/devices");
    info!("  POST /api/devices/wireless");
    info!("  POST /api/devices/wireless/qr");
    info!("  GET  /api/hosts");
    info!("  GET  /api/sessions");
    info!("  POST /api/sessions/{{serial}}/start|stop|restart");
    info!("  POST /api/input/tap");
    info!("  POST /api/input/pointer");
    info!("  POST /api/input/nav");
    info!("  POST /api/input/install");
    info!("  GET  /api/scrcpy/options");
    info!("  POST /api/scrcpy/options");
    info!("  POST /api/input/clipboard");
    info!("  POST /api/input/clipboard/pull");
    info!("  POST /api/input/text");
    info!("  POST /api/input/key");
    info!("  WS   /ws/devices/{{serial}}/audio");
    info!("  POST /api/device/command");
    info!("  POST /api/device/push");
    info!("  GET  /api/device/pull");
    info!("  GET  /api/host/files");
    info!("  POST /api/host/files/op");
    info!("  WS   /ws");
    info!("  WS   /ws/agent   (controller: agent registration)");
    info!("  WS   /ws/devices/{{serial}}/video");

    axum::serve(listener, app).await?;
    Ok(())
}

/// `PHONECONTROL_BIND` — IP to listen on.
/// - `127.0.0.1` — local UI / loopback only (safer default on a Windows USB host)
/// - `0.0.0.0` — all interfaces (needed so a remote Linux LXC agent can reach `/ws/agent`)
fn parse_bind_ip() -> [u8; 4] {
    match std::env::var("PHONECONTROL_BIND")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .as_deref()
    {
        None | Some("0.0.0.0") | Some("*") => [0, 0, 0, 0],
        Some("127.0.0.1") | Some("localhost") => [127, 0, 0, 1],
        Some(other) => {
            if let Ok(ip) = other.parse::<std::net::Ipv4Addr>() {
                ip.octets()
            } else {
                tracing::warn!(bind = other, "invalid PHONECONTROL_BIND — using 0.0.0.0");
                [0, 0, 0, 0]
            }
        }
    }
}

fn hostname_fallback() -> String {
    hostname::get_os_hostname().unwrap_or_else(|| {
        if cfg!(windows) {
            "windows-host".into()
        } else {
            "linux-agent".into()
        }
    })
}

mod hostname {
    pub fn get_os_hostname() -> Option<String> {
        std::env::var("COMPUTERNAME")
            .ok()
            .filter(|s| !s.is_empty())
            .or_else(|| std::env::var("HOSTNAME").ok().filter(|s| !s.is_empty()))
            .or_else(|| {
                #[cfg(unix)]
                {
                    std::fs::read_to_string("/etc/hostname")
                        .ok()
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                }
                #[cfg(not(unix))]
                {
                    None
                }
            })
    }
}
