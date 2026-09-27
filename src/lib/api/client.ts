import { MOCK_DEVICES } from "@/lib/devices/mock-data";
import type {
  ControlMode,
  Device,
  MappedTap,
  NavAction,
  NavBroadcast,
  NormalizedPoint,
  SessionStatus,
  TapBroadcast,
} from "@/lib/devices/types";
import { mapToDevices } from "@/lib/devices/coords";

/**
 * Thin client API shape for the control plane.
 * Uses the Rust phonecontrol-agent when NEXT_PUBLIC_AGENT_URL is set;
 * otherwise falls back to the local mock fleet.
 * The browser never talks to ADB directly.
 */
export interface DevicesClient {
  listDevices(): Promise<Device[]>;
  sendTap(
    mode: ControlMode,
    targets: Device[],
    point: NormalizedPoint,
  ): Promise<TapBroadcast>;
  sendNav(
    mode: ControlMode,
    targets: Device[],
    action: NavAction,
  ): Promise<NavBroadcast | void>;
  listSessions?(): Promise<SessionStatus[]>;
  /** Optional live device events from the agent WebSocket. */
  subscribeDevices?(
    onDevices: (devices: Device[]) => void,
    onSession?: (session: SessionStatus) => void,
  ): () => void;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createMockDevicesClient(): DevicesClient {
  return {
    async listDevices() {
      return MOCK_DEVICES.map((d) => ({ ...d }));
    },

    async sendTap(mode, targets, point) {
      await delay(16);
      const mapped: MappedTap[] = mapToDevices(point, targets).map((t) => ({
        ...t,
        inject: "stub" as const,
        injectDetail: "mock client",
      }));
      const broadcast: TapBroadcast = {
        id: `tap-${Date.now()}`,
        at: Date.now(),
        normalized: point,
        mode,
        targets: mapped,
      };
      console.info("[mock-control] tap", broadcast);
      return broadcast;
    },

    async sendNav(mode, targets, action) {
      await delay(30);
      const broadcast: NavBroadcast = {
        id: `nav-${Date.now()}`,
        at: Date.now(),
        mode,
        action: action.type,
        targetIds: targets.map((t) => t.id),
        targets: targets.map((t) => ({
          deviceId: t.id,
          deviceName: t.name,
          inject: "stub",
          detail: "mock client",
        })),
      };
      console.info("[mock-control] nav", broadcast);
      return broadcast;
    },
  };
}

function agentBaseUrl(): string | null {
  const raw = process.env.NEXT_PUBLIC_AGENT_URL?.trim();
  if (!raw) return null;
  return raw.replace(/\/$/, "");
}

function httpToWs(base: string): string {
  if (base.startsWith("https://")) return `wss://${base.slice("https://".length)}`;
  if (base.startsWith("http://")) return `ws://${base.slice("http://".length)}`;
  return base;
}

export function createAgentDevicesClient(baseUrl: string): DevicesClient {
  const base = baseUrl.replace(/\/$/, "");

  return {
    async listDevices() {
      const res = await fetch(`${base}/api/devices`, { cache: "no-store" });
      if (!res.ok) {
        throw new Error(`agent listDevices failed: ${res.status}`);
      }
      return (await res.json()) as Device[];
    },

    async sendTap(mode, targets, point) {
      const res = await fetch(`${base}/api/input/tap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          targetIds: targets.map((t) => t.id),
          normalized: point,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `agent sendTap failed: ${res.status}`);
      }
      return (await res.json()) as TapBroadcast;
    },

    async sendNav(mode, targets, action) {
      const res = await fetch(`${base}/api/input/nav`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          targetIds: targets.map((t) => t.id),
          action,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `agent sendNav failed: ${res.status}`);
      }
      return (await res.json()) as NavBroadcast;
    },

    async listSessions() {
      const res = await fetch(`${base}/api/sessions`, { cache: "no-store" });
      if (!res.ok) {
        throw new Error(`agent listSessions failed: ${res.status}`);
      }
      return (await res.json()) as SessionStatus[];
    },

    subscribeDevices(onDevices, onSession) {
      const wsUrl = `${httpToWs(base)}/ws`;
      let closed = false;
      let socket: WebSocket | null = null;
      let retryTimer: ReturnType<typeof setTimeout> | null = null;

      const connect = () => {
        if (closed) return;
        socket = new WebSocket(wsUrl);
        socket.onmessage = (event) => {
          try {
            const msg = JSON.parse(String(event.data)) as {
              type?: string;
              devices?: Device[];
              device?: Device;
              session?: SessionStatus;
            };
            if (msg.type === "devices" && Array.isArray(msg.devices)) {
              onDevices(msg.devices);
            } else if (msg.type === "device_updated" && msg.device) {
              // Soft refresh: re-list so the hook stays simple.
              void fetch(`${base}/api/devices`, { cache: "no-store" })
                .then((r) => r.json())
                .then((devices: Device[]) => {
                  if (!closed) onDevices(devices);
                })
                .catch(() => {});
            } else if (msg.type === "session_updated" && msg.session) {
              onSession?.(msg.session);
            }
          } catch {
            // ignore malformed frames
          }
        };
        socket.onclose = () => {
          if (!closed) {
            retryTimer = setTimeout(connect, 2000);
          }
        };
        socket.onerror = () => {
          socket?.close();
        };
      };

      connect();

      return () => {
        closed = true;
        if (retryTimer) clearTimeout(retryTimer);
        socket?.close();
      };
    },
  };
}

function createDevicesClient(): DevicesClient {
  const agent = agentBaseUrl();
  if (agent) {
    console.info("[phone-control] using agent at", agent);
    return createAgentDevicesClient(agent);
  }
  console.info("[phone-control] NEXT_PUBLIC_AGENT_URL unset — using mock client");
  return createMockDevicesClient();
}

/** Singleton for the app — agent when configured, mock otherwise. */
export const devicesClient: DevicesClient = createDevicesClient();

export function isAgentConfigured(): boolean {
  return agentBaseUrl() !== null;
}
