//! Session lifecycle for a phone: look up, start, stop and restart its live stream, locally or on the agent that owns it.

use super::*;

impl AppState {
    pub async fn session_status(&self, serial: &str) -> SessionStatus {
        if let Some(s) = self.inner.sessions.get_session(serial).await {
            return s;
        }
        // Remote session cache.
        for s in self.inner.mesh.remote_sessions().await {
            if s.serial == serial {
                return s;
            }
        }
        self.inner.sessions.ensure_session(serial).await
    }

    pub async fn start_session(&self, serial: &str) -> Result<SessionStatus, String> {
        if let Some(host_id) = self.remote_owner(serial).await {
            let session = self
                .inner
                .mesh
                .proxy_session(&host_id, serial, SessionAction::Start)
                .await?;
            self.inner.mesh.set_session(&host_id, session.clone()).await;
            self.publish(ServerEvent::SessionUpdated {
                session: session.clone(),
            });
            return Ok(session);
        }
        self.start_session_local(serial).await
    }

    pub async fn stop_session(&self, serial: &str) -> Result<SessionStatus, String> {
        if let Some(host_id) = self.remote_owner(serial).await {
            let session = self
                .inner
                .mesh
                .proxy_session(&host_id, serial, SessionAction::Stop)
                .await?;
            self.inner.mesh.set_session(&host_id, session.clone()).await;
            self.publish(ServerEvent::SessionUpdated {
                session: session.clone(),
            });
            return Ok(session);
        }
        self.stop_session_local(serial).await
    }

    pub async fn restart_session(&self, serial: &str) -> Result<SessionStatus, String> {
        if let Some(host_id) = self.remote_owner(serial).await {
            let session = self
                .inner
                .mesh
                .proxy_session(&host_id, serial, SessionAction::Restart)
                .await?;
            self.inner.mesh.set_session(&host_id, session.clone()).await;
            self.publish(ServerEvent::SessionUpdated {
                session: session.clone(),
            });
            return Ok(session);
        }
        self.restart_session_local(serial).await
    }

    pub async fn start_session_local(&self, serial: &str) -> Result<SessionStatus, String> {
        self.require_local_serial(serial).await?;
        let session = self.inner.sessions.start(serial).await;
        self.publish(ServerEvent::SessionUpdated {
            session: session.clone(),
        });
        Ok(session)
    }

    pub async fn stop_session_local(&self, serial: &str) -> Result<SessionStatus, String> {
        self.require_local_serial(serial).await?;
        let session = self.inner.sessions.stop(serial).await;
        self.publish(ServerEvent::SessionUpdated {
            session: session.clone(),
        });
        Ok(session)
    }

    pub async fn restart_session_local(&self, serial: &str) -> Result<SessionStatus, String> {
        self.require_local_serial(serial).await?;
        let session = self.inner.sessions.restart(serial).await;
        // A restarted stream is a new connection to the phone: the Quiet Mode Loop puts it
        // back into the current phase.
        crate::quiet_cycle::note_connected(serial);
        self.publish(ServerEvent::SessionUpdated {
            session: session.clone(),
        });
        Ok(session)
    }

    pub(super) async fn require_local_serial(&self, serial: &str) -> Result<(), String> {
        let devices = self.list_local_devices().await;
        if devices.iter().any(|d| d.serial == serial || d.id == serial) {
            Ok(())
        } else {
            Err(format!("unknown local device serial/id: {serial}"))
        }
    }
}
