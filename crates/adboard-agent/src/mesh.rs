//! Multi-host mesh: controller registry of remote agents + outbound agent client.

use adboard_protocol::{
    now_ms, ControlMode, ControllerToAgent, Device, DeviceStatus, HostInfo, HostStatus, MappedTap, NavActionType,
    NavTargetResult, NormalizedPoint, PointerPhase, Role, SessionAction, SessionStatus,
};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot, Mutex, RwLock};
use tracing::{info, warn};
use uuid::Uuid;

const AGENT_STALE_SECS: u64 = 15;
/// An agent connection silent for this long is closed by the controller (heartbeats come every 5 s).
pub const AGENT_DEAD_AFTER: Duration = Duration::from_secs(45);
const PROXY_TIMEOUT: Duration = Duration::from_secs(8);

/// A silent agent's phones: what was online is only "stale" now. Offline and unauthorized phones stay as reported.
fn devices_as_known(devices: &[Device], silent_for: Duration) -> Vec<Device> {
    let stale = silent_for > Duration::from_secs(AGENT_STALE_SECS);
    devices
        .iter()
        .cloned()
        .map(|mut device| {
            if stale && device.status == DeviceStatus::Online {
                device.status = DeviceStatus::Stale;
            }
            device
        })
        .collect()
}

pub type CmdTx = mpsc::UnboundedSender<ControllerToAgent>;

struct PendingTap {
    tx: oneshot::Sender<Result<Vec<MappedTap>, String>>,
}

struct PendingNav {
    tx: oneshot::Sender<Result<Vec<NavTargetResult>, String>>,
}

struct PendingSession {
    tx: oneshot::Sender<Result<SessionStatus, String>>,
}

struct Pending {
    taps: HashMap<String, PendingTap>,
    navs: HashMap<String, PendingNav>,
    sessions: HashMap<String, PendingSession>,
}

pub struct RemoteHost {
    pub host_id: String,
    pub host_name: String,
    pub os: String,
    pub last_seen: Instant,
    pub devices: Vec<Device>,
    pub sessions: HashMap<String, SessionStatus>,
    pub cmd_tx: CmdTx,
    /// Agent HTTP base for video WS proxy (`http://host:port`).
    pub http_base: Option<String>,
    /// Which connection registered this host. A connection that has been replaced must not
    /// remove its successor when it finally ends (`unregister_conn`).
    pub conn_id: u64,
    /// Wakes the connection's socket task so it stops (it was replaced, or went silent).
    pub cancel: Arc<tokio::sync::Notify>,
}

/// Controller-side registry of connected agents.
pub struct MeshRegistry {
    hosts: RwLock<HashMap<String, RemoteHost>>,
    pending: Mutex<Pending>,
    local_host_id: String,
    local_host_name: String,
    local_os: String,
}

impl MeshRegistry {
    pub fn new(local_host_id: String, local_host_name: String) -> Arc<Self> {
        Arc::new(Self {
            hosts: RwLock::new(HashMap::new()),
            pending: Mutex::new(Pending {
                taps: HashMap::new(),
                navs: HashMap::new(),
                sessions: HashMap::new(),
            }),
            local_host_id,
            local_host_name,
            local_os: detect_os(),
        })
    }

    #[allow(dead_code)]
    pub fn local_host_id(&self) -> &str {
        &self.local_host_id
    }

    #[allow(dead_code)]
    pub fn local_host_name(&self) -> &str {
        &self.local_host_name
    }

    #[allow(dead_code)]
    pub fn local_os(&self) -> &str {
        &self.local_os
    }

    pub async fn register(
        &self,
        host_id: String,
        host_name: String,
        os: String,
        cmd_tx: CmdTx,
        http_base: Option<String>,
        cancel: Arc<tokio::sync::Notify>,
    ) -> Result<u64, String> {
        static CONNECTIONS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let conn_id = CONNECTIONS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let mut hosts = self.hosts.write().await;
        if let Some(existing) = hosts.get(&host_id) {
            // The same agent connected again (it restarted, or its old connection died silently):
            // the old connection is finished, so stop its tasks instead of leaving them running.
            warn!(
                host_id = %host_id,
                old_connection = existing.conn_id,
                new_connection = conn_id,
                "replacing existing agent connection"
            );
            existing.cancel.notify_one();
        }
        hosts.insert(
            host_id.clone(),
            RemoteHost {
                host_id: host_id.clone(),
                host_name,
                os,
                last_seen: Instant::now(),
                devices: Vec::new(),
                sessions: HashMap::new(),
                cmd_tx,
                http_base,
                conn_id,
                cancel,
            },
        );
        info!(%host_id, conn_id, "agent registered");
        Ok(conn_id)
    }

    /// How long since the agent last sent anything (None when it is not registered).
    pub async fn silence_of(&self, host_id: &str, conn_id: u64) -> Option<Duration> {
        let hosts = self.hosts.read().await;
        hosts
            .get(host_id)
            .filter(|h| h.conn_id == conn_id)
            .map(|h| h.last_seen.elapsed())
    }

    pub async fn http_base(&self, host_id: &str) -> Option<String> {
        self.hosts
            .read()
            .await
            .get(host_id)
            .and_then(|h| h.http_base.clone())
    }

    /// Remove `host_id` only if it is still registered by connection `conn_id`. A connection that
    /// was replaced by a newer one (the agent reconnected) ends later and must not remove it.
    pub async fn unregister_conn(&self, host_id: &str, conn_id: u64) -> bool {
        let mut hosts = self.hosts.write().await;
        match hosts.get(host_id) {
            Some(host) if host.conn_id == conn_id => {
                hosts.remove(host_id);
                info!(%host_id, conn_id, "agent unregistered");
                true
            }
            Some(host) => {
                info!(%host_id, conn_id, current = host.conn_id, "an old agent connection ended; the newer one stays");
                false
            }
            None => false,
        }
    }

    pub async fn touch(&self, host_id: &str) {
        if let Some(h) = self.hosts.write().await.get_mut(host_id) {
            h.last_seen = Instant::now();
        }
    }

    pub async fn set_devices(&self, host_id: &str, devices: Vec<Device>) -> bool {
        let mut hosts = self.hosts.write().await;
        let Some(h) = hosts.get_mut(host_id) else {
            return false;
        };
        h.last_seen = Instant::now();
        let changed = !devices_shallow_eq(&h.devices, &devices);
        h.devices = devices;
        changed
    }

    pub async fn set_session(&self, host_id: &str, session: SessionStatus) {
        if let Some(h) = self.hosts.write().await.get_mut(host_id) {
            h.last_seen = Instant::now();
            h.sessions.insert(session.serial.clone(), session);
        }
    }

    /// The phones of every registered agent. While an agent is silent its last report is old, so its
    /// "online" phones are reported `stale` (nothing may treat them as ready) until it answers again
    /// or its connection is dropped.
    pub async fn remote_devices(&self) -> Vec<Device> {
        let hosts = self.hosts.read().await;
        let mut out = Vec::new();
        for h in hosts.values() {
            out.extend(devices_as_known(&h.devices, h.last_seen.elapsed()));
        }
        out
    }

    pub async fn remote_sessions(&self) -> Vec<SessionStatus> {
        let hosts = self.hosts.read().await;
        let mut out = Vec::new();
        for h in hosts.values() {
            out.extend(h.sessions.values().cloned());
        }
        out
    }

    pub async fn host_infos(&self, local_device_count: usize) -> Vec<HostInfo> {
        let mut list = vec![HostInfo {
            host_id: self.local_host_id.clone(),
            name: self.local_host_name.clone(),
            os: self.local_os.clone(),
            status: HostStatus::Online,
            device_count: local_device_count,
            local: true,
            last_seen_ms: Some(now_ms()),
        }];
        let hosts = self.hosts.read().await;
        for h in hosts.values() {
            let age = h.last_seen.elapsed();
            let status = if age > Duration::from_secs(AGENT_STALE_SECS) {
                HostStatus::Stale
            } else {
                HostStatus::Online
            };
            list.push(HostInfo {
                host_id: h.host_id.clone(),
                name: h.host_name.clone(),
                os: h.os.clone(),
                status,
                device_count: h.devices.len(),
                local: false,
                last_seen_ms: Some(now_ms().saturating_sub(age.as_millis() as u64)),
            });
        }
        list.sort_by(|a, b| a.name.cmp(&b.name));
        list
    }

    pub async fn registered_count(&self) -> usize {
        self.hosts.read().await.len()
    }

    pub async fn owner_of_serial(&self, serial_or_id: &str) -> Option<String> {
        let hosts = self.hosts.read().await;
        for h in hosts.values() {
            if h.devices
                .iter()
                .any(|d| d.serial == serial_or_id || d.id == serial_or_id)
            {
                return Some(h.host_id.clone());
            }
        }
        None
    }

    #[allow(dead_code)]
    pub async fn resolve_remote_serial(&self, id_or_serial: &str) -> Option<(String, String)> {
        let hosts = self.hosts.read().await;
        for h in hosts.values() {
            if let Some(d) = h
                .devices
                .iter()
                .find(|d| d.serial == id_or_serial || d.id == id_or_serial)
            {
                return Some((h.host_id.clone(), d.serial.clone()));
            }
        }
        None
    }

    /// Proxy a tap to a remote agent and wait for MappedTap results.
    pub async fn proxy_tap(
        &self,
        host_id: &str,
        mode: ControlMode,
        target_ids: Vec<String>,
        normalized: NormalizedPoint,
    ) -> Result<Vec<MappedTap>, String> {
        let request_id = Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().await;
            pending.taps.insert(request_id.clone(), PendingTap { tx });
        }
        self.send(
            host_id,
            ControllerToAgent::Tap {
                request_id: request_id.clone(),
                mode,
                target_ids,
                normalized,
            },
        )
        .await?;
        match tokio::time::timeout(PROXY_TIMEOUT, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("agent dropped tap response".into()),
            Err(_) => {
                self.pending.lock().await.taps.remove(&request_id);
                Err(format!("tap proxy timeout for host {host_id}"))
            }
        }
    }

    pub async fn proxy_pointer(
        &self,
        host_id: &str,
        mode: ControlMode,
        target_ids: Vec<String>,
        phase: PointerPhase,
        tool: adboard_protocol::PointerTool,
        normalized: NormalizedPoint,
        frame_width: u32,
        frame_height: u32,
    ) -> Result<Vec<MappedTap>, String> {
        let request_id = Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().await;
            pending.taps.insert(request_id.clone(), PendingTap { tx });
        }
        self.send(
            host_id,
            ControllerToAgent::Pointer {
                request_id: request_id.clone(),
                mode,
                target_ids,
                phase,
                tool,
                normalized,
                frame_width,
                frame_height,
            },
        )
        .await?;
        match tokio::time::timeout(PROXY_TIMEOUT, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("agent dropped pointer response".into()),
            Err(_) => {
                self.pending.lock().await.taps.remove(&request_id);
                Err(format!("pointer proxy timeout for host {host_id}"))
            }
        }
    }

    pub async fn proxy_nav(
        &self,
        host_id: &str,
        mode: ControlMode,
        target_ids: Vec<String>,
        action: NavActionType,
    ) -> Result<Vec<NavTargetResult>, String> {
        let request_id = Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().await;
            pending.navs.insert(request_id.clone(), PendingNav { tx });
        }
        self.send(
            host_id,
            ControllerToAgent::Nav {
                request_id: request_id.clone(),
                mode,
                target_ids,
                action,
            },
        )
        .await?;
        match tokio::time::timeout(PROXY_TIMEOUT, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("agent dropped nav response".into()),
            Err(_) => {
                self.pending.lock().await.navs.remove(&request_id);
                Err(format!("nav proxy timeout for host {host_id}"))
            }
        }
    }

    pub async fn proxy_session(
        &self,
        host_id: &str,
        serial: &str,
        action: SessionAction,
    ) -> Result<SessionStatus, String> {
        let request_id = Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().await;
            pending
                .sessions
                .insert(request_id.clone(), PendingSession { tx });
        }
        let msg = match action {
            SessionAction::Start => ControllerToAgent::SessionStart {
                request_id: request_id.clone(),
                serial: serial.into(),
            },
            SessionAction::Stop => ControllerToAgent::SessionStop {
                request_id: request_id.clone(),
                serial: serial.into(),
            },
            SessionAction::Restart => ControllerToAgent::SessionRestart {
                request_id: request_id.clone(),
                serial: serial.into(),
            },
        };
        self.send(host_id, msg).await?;
        match tokio::time::timeout(PROXY_TIMEOUT, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("agent dropped session response".into()),
            Err(_) => {
                self.pending.lock().await.sessions.remove(&request_id);
                Err(format!("session proxy timeout for host {host_id}"))
            }
        }
    }

    async fn send(&self, host_id: &str, msg: ControllerToAgent) -> Result<(), String> {
        let hosts = self.hosts.read().await;
        let h = hosts
            .get(host_id)
            .ok_or_else(|| format!("unknown remote host: {host_id}"))?;
        h.cmd_tx
            .send(msg)
            .map_err(|_| format!("agent {host_id} command channel closed"))
    }

    pub async fn complete_tap(
        &self,
        request_id: &str,
        result: Result<Vec<MappedTap>, String>,
    ) {
        if let Some(p) = self.pending.lock().await.taps.remove(request_id) {
            let _ = p.tx.send(result);
        }
    }

    pub async fn complete_nav(
        &self,
        request_id: &str,
        result: Result<Vec<NavTargetResult>, String>,
    ) {
        if let Some(p) = self.pending.lock().await.navs.remove(request_id) {
            let _ = p.tx.send(result);
        }
    }

    pub async fn complete_session(
        &self,
        request_id: &str,
        result: Result<SessionStatus, String>,
    ) {
        if let Some(p) = self.pending.lock().await.sessions.remove(request_id) {
            let _ = p.tx.send(result);
        }
    }
}

fn devices_shallow_eq(a: &[Device], b: &[Device]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b.iter()).all(|(x, y)| {
        x.serial == y.serial
            && x.status == y.status
            && x.model == y.model
            && x.host == y.host
            && x.host_id == y.host_id
            && x.resolution.width == y.resolution.width
            && x.resolution.height == y.resolution.height
    })
}

pub fn detect_os() -> String {
    std::env::consts::OS.to_string()
}

pub fn parse_role() -> Role {
    // Prefer CLI: --role controller|agent
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--role" {
            if let Some(v) = args.next() {
                return parse_role_str(&v);
            }
        } else if let Some(v) = arg.strip_prefix("--role=") {
            return parse_role_str(v);
        }
    }
    crate::env::var("ROLE")
        .ok()
        .map(|v| parse_role_str(&v))
        .unwrap_or(Role::Controller)
}

fn parse_role_str(v: &str) -> Role {
    match v.trim().to_ascii_lowercase().as_str() {
        "agent" => Role::Agent,
        _ => Role::Controller,
    }
}

pub fn controller_ws_url() -> Option<String> {
    crate::env::var("CONTROLLER_URL")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(|s| {
            // Accept http(s) base or full ws path.
            if s.contains("/ws/agent") {
                s.replace("http://", "ws://")
                    .replace("https://", "wss://")
            } else if let Some(rest) = s.strip_prefix("http://") {
                format!("ws://{rest}/ws/agent")
            } else if let Some(rest) = s.strip_prefix("https://") {
                format!("wss://{rest}/ws/agent")
            } else if let Some(rest) = s.strip_prefix("ws://") {
                if rest.contains("/ws/agent") {
                    s
                } else {
                    format!("ws://{}/ws/agent", rest.trim_end_matches('/'))
                }
            } else if let Some(rest) = s.strip_prefix("wss://") {
                if rest.contains("/ws/agent") {
                    s
                } else {
                    format!("wss://{}/ws/agent", rest.trim_end_matches('/'))
                }
            } else {
                format!("ws://{}/ws/agent", s.trim_end_matches('/'))
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry() -> Arc<MeshRegistry> {
        MeshRegistry::new("ctl".into(), "controller".into())
    }

    async fn register(mesh: &MeshRegistry, id: &str) -> (u64, Arc<tokio::sync::Notify>) {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let cancel = Arc::new(tokio::sync::Notify::new());
        let conn = mesh
            .register(id.into(), id.into(), "linux".into(), tx, None, cancel.clone())
            .await
            .unwrap();
        (conn, cancel)
    }

    fn phone(serial: &str, status: DeviceStatus) -> Device {
        let mut device = crate::mock::mock_fleet_of("test", "test", 1).remove(0);
        device.id = serial.into();
        device.serial = serial.into();
        device.status = status;
        device
    }

    #[test]
    fn a_silent_agents_online_phones_are_stale_and_the_rest_are_unchanged() {
        let phones = vec![
            phone("on", DeviceStatus::Online),
            phone("off", DeviceStatus::Offline),
            phone("auth", DeviceStatus::Unauthorized),
        ];
        let fresh = devices_as_known(&phones, Duration::from_secs(AGENT_STALE_SECS));
        assert_eq!(fresh[0].status, DeviceStatus::Online, "an agent heard from just now");
        let silent = devices_as_known(&phones, Duration::from_secs(AGENT_STALE_SECS + 1));
        assert_eq!(silent[0].status, DeviceStatus::Stale);
        assert_eq!(silent[1].status, DeviceStatus::Offline);
        assert_eq!(silent[2].status, DeviceStatus::Unauthorized);
    }

    #[tokio::test]
    async fn remote_phones_are_stale_while_the_agent_is_silent_and_online_again_when_it_speaks() {
        let mesh = registry();
        register(&mesh, "lxc").await;
        mesh.set_devices("lxc", vec![phone("remote-1", DeviceStatus::Online)]).await;
        assert_eq!(mesh.remote_devices().await[0].status, DeviceStatus::Online);

        // The agent has not been heard from for longer than the stale limit.
        mesh.hosts.write().await.get_mut("lxc").unwrap().last_seen = Instant::now() - Duration::from_secs(AGENT_STALE_SECS + 5);
        assert_eq!(mesh.remote_devices().await[0].status, DeviceStatus::Stale);
        assert_eq!(mesh.host_infos(0).await[1].status, HostStatus::Stale, "the host list says the same");

        mesh.touch("lxc").await;
        assert_eq!(mesh.remote_devices().await[0].status, DeviceStatus::Online);
    }

    #[tokio::test]
    async fn an_old_connection_ending_does_not_remove_the_newer_one() {
        let mesh = registry();
        let (old, old_cancel) = register(&mesh, "lxc").await;
        let (new, _new_cancel) = register(&mesh, "lxc").await; // the agent reconnected
        assert_ne!(old, new);
        // The old connection is told to stop...
        tokio::time::timeout(Duration::from_secs(1), old_cancel.notified()).await.expect("the old connection is cancelled");
        // ...and when it finally ends it must not take the new registration with it.
        assert!(!mesh.unregister_conn("lxc", old).await);
        assert!(mesh.silence_of("lxc", new).await.is_some(), "the host is still registered");
        assert!(mesh.unregister_conn("lxc", new).await);
        assert!(mesh.silence_of("lxc", new).await.is_none());
        assert!(!mesh.unregister_conn("lxc", new).await, "removing twice is harmless");
    }

    #[tokio::test]
    async fn several_agents_disconnecting_together_do_not_affect_each_other() {
        let mesh = registry();
        let mut conns = Vec::new();
        for id in ["a", "b", "c"] {
            conns.push((id, register(&mesh, id).await.0));
        }
        // a and b drop at the same moment; c keeps running.
        let (ra, rb) = tokio::join!(mesh.unregister_conn("a", conns[0].1), mesh.unregister_conn("b", conns[1].1));
        assert!(ra && rb);
        assert!(mesh.silence_of("c", conns[2].1).await.is_some());
        assert_eq!(mesh.registered_count().await, 1);
    }

    #[tokio::test]
    async fn the_silence_of_a_connection_resets_when_the_agent_is_heard() {
        let mesh = registry();
        let (conn, _) = register(&mesh, "lxc").await;
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert!(mesh.silence_of("lxc", conn).await.unwrap() >= Duration::from_millis(80));
        mesh.touch("lxc").await;
        assert!(mesh.silence_of("lxc", conn).await.unwrap() < Duration::from_millis(80));
        assert!(mesh.silence_of("lxc", conn + 1).await.is_none(), "another connection's number is not this host's");
    }

    #[test]
    fn parses_controller_url_variants() {
        assert_eq!(
            {
                std::env::set_var("ADBOARD_CONTROLLER_URL", "http://127.0.0.1:3848");
                let u = controller_ws_url();
                std::env::remove_var("ADBOARD_CONTROLLER_URL");
                u
            },
            Some("ws://127.0.0.1:3848/ws/agent".into())
        );
        assert_eq!(
            {
                std::env::set_var(
                    "ADBOARD_CONTROLLER_URL",
                    "ws://127.0.0.1:3848/ws/agent",
                );
                let u = controller_ws_url();
                std::env::remove_var("ADBOARD_CONTROLLER_URL");
                u
            },
            Some("ws://127.0.0.1:3848/ws/agent".into())
        );
    }

    #[test]
    fn parse_role_defaults_controller() {
        // Don't rely on env pollution — exercise the string parser via public API path.
        assert_eq!(parse_role_str("agent"), Role::Agent);
        assert_eq!(parse_role_str("CONTROLLER"), Role::Controller);
        assert_eq!(parse_role_str(""), Role::Controller);
    }
}
