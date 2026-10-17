import { MOCK_DEVICES } from "@/lib/devices/mock-data";
import { responseError } from "@/lib/api/http-error";
import type {
  ControlMode,
  Device,
  MappedTap,
  NavAction,
  NavBroadcast,
  GestureResult,
  GestureStroke,
  NormalizedPoint,
  PointerPhase,
  PointerTool,
  DeviceCommandResponse,
  HostFileEntry,
  InstallBroadcast,
  SessionStatus,
  TapBroadcast,
} from "@/lib/devices/types";
import { mapToDevices } from "@/lib/devices/coords";
import {
  agentBaseUrl,
  agentFetch,
  agentWsUrl,
  ensureAgentToken,
  agentWsProtocols,
} from "@/lib/api/auth";

/**
 * Thin client API shape for the control plane.
 * Uses the Rust adboard-agent when NEXT_PUBLIC_AGENT_URL is set;
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
  sendPointer(
    mode: ControlMode,
    targets: Device[],
    phase: PointerPhase,
    point: NormalizedPoint,
    frameWidth: number,
    frameHeight: number,
    tool?: PointerTool,
  ): Promise<TapBroadcast>;
  sendNav(
    mode: ControlMode,
    targets: Device[],
    action: NavAction,
  ): Promise<NavBroadcast | void>;
  /** Timed single/multi-touch gesture, played by the agent. Resolves when it has finished. */
  sendGesture(
    mode: ControlMode,
    targets: Device[],
    strokes: GestureStroke[],
  ): Promise<GestureResult>;
  sendText(
    mode: ControlMode,
    targets: Device[],
    text: string,
  ): Promise<ControlInjectResult>;
  sendKey(
    mode: ControlMode,
    targets: Device[],
    key: { action: "down" | "up"; keycode: number; repeat: number; metastate: number },
  ): Promise<ControlInjectResult>;
  installApk(
    mode: ControlMode,
    targets: Device[],
    file: File,
  ): Promise<InstallBroadcast>;
  runCommand(
    targets: Device[],
    op: string,
    arg?: string,
    arg2?: string,
  ): Promise<DeviceCommandResponse>;
  listHostFiles(path?: string): Promise<HostFileEntry[]>;
  uploadHostFile(file: File, dir: string): Promise<HostFileEntry>;
  deleteHostFile(path: string): Promise<void>;
  /** Download a host file with the API token in a header (never in the URL). */
  fetchHostFile(path: string): Promise<Blob>;
  pushToDevices(targets: Device[], file: File, dest: string): Promise<DeviceCommandResponse>;
  pullFromDevice(deviceId: string, path: string): Promise<Blob>;
  hostFileOp(
    op: "mkdir" | "rename" | "move" | "copy",
    path: string,
    dest?: string,
  ): Promise<HostFileEntry>;
  listHosts(): Promise<import("@/lib/devices/types").HostInfo[]>;
  connectWireless(input: WirelessConnectInput): Promise<WirelessConnectResult>;
  listWireless(): Promise<string[]>;
  disconnectWireless(address: string): Promise<WirelessConnectResult>;
  startWirelessQr(): Promise<WirelessQrSession>;
  wirelessQrStatus(id: string): Promise<WirelessQrStatus>;
  cancelWirelessQr(id: string): Promise<void>;
  listSessions?(): Promise<SessionStatus[]>;
  /** Optional live device events from the agent WebSocket. */
  subscribeDevices?(
    onDevices: (devices: Device[]) => void,
    onSession?: (session: SessionStatus) => void,
  ): () => void;
}

export interface WirelessConnectInput {
  address: string;
  port?: number;
  pairingPort?: number;
  pairingCode?: string;
}

export interface WirelessConnectResult {
  endpoint: string;
  message: string;
}

export interface WirelessQrSession {
  id: string;
  payload: string;
  svg: string;
}

export interface WirelessQrStatus {
  id: string;
  state: "waiting" | "paired" | "failed" | string;
  message: string;
  endpoint?: string | null;
}

export interface ControlInjectResult {
  results: Array<{
    deviceId: string;
    deviceName: string;
    ok: boolean;
    error?: string | null;
  }>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


/** Files above this go up in chunks: Cloudflare Free/Pro reject request bodies over 100 MB. */
export const DIRECT_UPLOAD_MAX = 64 * 1024 * 1024;
export const UPLOAD_CHUNK = 32 * 1024 * 1024;

/**
 * Small files are sent as the request body. Large ones are staged with
 * PUT /api/uploads/{id} chunks and referenced by the x-adboard-upload header.
 */
async function stageUpload(
  base: string,
  file: Blob,
): Promise<{ body: Blob | null; headers: Record<string, string> }> {
  if (file.size <= DIRECT_UPLOAD_MAX) return { body: file, headers: {} };
  const id = crypto.randomUUID();
  for (let offset = 0; offset < file.size; offset += UPLOAD_CHUNK) {
    const res = await agentFetch(`${base}/api/uploads/${id}`, {
      method: "PUT",
      headers: { "X-Adboard-Offset": String(offset) },
      body: file.slice(offset, offset + UPLOAD_CHUNK),
    });
    if (!res.ok) throw await responseError(res, "upload failed");
  }
  return { body: null, headers: { "X-Adboard-Upload": id } };
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

    async sendPointer(mode, targets, _phase, point, frameWidth, frameHeight, _tool) {
      await delay(8);
      const width = frameWidth || targets[0]?.resolution.width || 0;
      const height = frameHeight || targets[0]?.resolution.height || 0;
      const mapped: MappedTap[] = targets.map((device) => ({
        deviceId: device.id,
        deviceName: device.name,
        x: Math.round(point.x * width),
        y: Math.round(point.y * height),
        width,
        height,
        inject: "stub" as const,
        injectDetail: "mock client",
      }));
      const broadcast: TapBroadcast = {
        id: `pointer-${Date.now()}`,
        at: Date.now(),
        normalized: point,
        mode,
        targets: mapped,
      };
      console.info("[mock-control] pointer", broadcast);
      return broadcast;
    },

    async sendGesture(mode, targets, strokes) {
      const total = Math.max(0, ...strokes.map((s) => s.startMs + Math.max(10, s.durationMs)));
      await delay(total);
      const result: GestureResult = {
        id: `gesture-${Date.now()}`,
        at: Date.now(),
        mode,
        targetIds: targets.map((t) => t.id),
        targets: targets.map((t) => ({
          deviceId: t.id,
          deviceName: t.name,
          inject: "stub",
          detail: "mock client",
        })),
      };
      console.info("[mock-control] gesture", strokes.length, result);
      return result;
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

    async sendText(mode, targets, text) {
      console.info("[mock-control] text", mode, text);
      return {
        results: targets.map((device) => ({
          deviceId: device.id,
          deviceName: device.name,
          ok: false,
          error: "scrcpy control is not connected",
        })),
      };
    },

    async sendKey(mode, targets, key) {
      console.info("[mock-control] key", mode, key);
      return {
        results: targets.map((device) => ({
          deviceId: device.id,
          deviceName: device.name,
          ok: false,
          error: "scrcpy control is not connected",
        })),
      };
    },

    async installApk(mode, targets, file) {
      if (!file.name.toLowerCase().endsWith(".apk")) {
        throw new Error("only .apk files can be installed");
      }
      return {
        id: `install-${Date.now()}`,
        at: Date.now(),
        mode,
        targetIds: targets.map((t) => t.id),
        targets: targets.map((t) => ({
          deviceId: t.id,
          deviceName: t.name,
          inject: "error" as const,
          detail: "adb is not available — cannot install APK",
        })),
      };
    },

    async runCommand(targets, op, arg, arg2) {
      return {
        id: `cmd-${Date.now()}`,
        op,
        results: targets.map((device) => ({
          deviceId: device.id,
          deviceName: device.name,
          ok: false,
          error:
            op === "reconnect"
              ? "mock fleet has no live ADB session to restart"
              : "adb is not available",
          output: arg && arg2 ? undefined : undefined,
        })),
      };
    },

    async listHostFiles() {
      return [
        { name: "Screenshots", path: "Screenshots", dir: true, size: 0 },
        { name: "Downloads", path: "Downloads", dir: true, size: 0 },
      ];
    },

    async uploadHostFile(file, dir) {
      return { name: file.name, path: `${dir}/${file.name}`, dir: false, size: file.size };
    },

    async deleteHostFile() {},

    async fetchHostFile(path) {
      return new Blob([`mock host file: ${path}`], { type: "text/plain" });
    },

    async pushToDevices(targets) {
      return {
        id: `push-${Date.now()}`,
        op: "push",
        results: targets.map((device) => ({
          deviceId: device.id,
          deviceName: device.name,
          ok: false,
          error: "adb is not available",
        })),
      };
    },

    async pullFromDevice() {
      throw new Error("adb is not available");
    },

    async hostFileOp(op, path, dest) {
      const name = (dest || path).split("/").pop() || path;
      return { name, path: dest || path, dir: op === "mkdir", size: 0 };
    },

    async connectWireless() {
      throw new Error("adb is not available");
    },

    async listWireless() {
      return [];
    },

    async disconnectWireless() {
      throw new Error("adb is not available");
    },

    async startWirelessQr() {
      throw new Error("adb is not available");
    },

    async wirelessQrStatus(id) {
      return { id, state: "failed", message: "adb is not available", endpoint: null };
    },

    async cancelWirelessQr() {},

    async listHosts() {
      return [
        {
          hostId: "windows-host",
          name: "Windows PC",
          os: "windows",
          status: "online",
          deviceCount: 2,
          local: true,
        },
        {
          hostId: "lxc-agent-01",
          name: "Proxmox LXC",
          os: "linux",
          status: "online",
          deviceCount: 2,
          local: false,
        },
      ];
    },
  };
}

export function createAgentDevicesClient(baseUrl: string): DevicesClient {
  const base = baseUrl.replace(/\/$/, "");

  return {
    async listDevices() {
      const res = await agentFetch(`${base}/api/devices`, { cache: "no-store" });
      if (!res.ok) {
        throw await responseError(res, "agent listDevices failed");
      }
      return (await res.json()) as Device[];
    },

    async sendTap(mode, targets, point) {
      const res = await agentFetch(`${base}/api/input/tap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          targetIds: targets.map((t) => t.id),
          normalized: point,
        }),
      });
      if (!res.ok) {
        throw await responseError(res, "agent sendTap failed");
      }
      return (await res.json()) as TapBroadcast;
    },

    async sendPointer(mode, targets, phase, point, frameWidth, frameHeight, tool = "finger") {
      const res = await agentFetch(`${base}/api/input/pointer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          targetIds: targets.map((t) => t.id),
          phase,
          normalized: point,
          frameWidth,
          frameHeight,
          tool,
        }),
      });
      if (!res.ok) {
        throw await responseError(res, "agent sendPointer failed");
      }
      return (await res.json()) as TapBroadcast;
    },

    async sendGesture(mode, targets, strokes) {
      const res = await agentFetch(`${base}/api/input/gesture`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, targetIds: targets.map((t) => t.id), strokes }),
      });
      if (!res.ok) {
        throw await responseError(res, "agent sendGesture failed");
      }
      return (await res.json()) as GestureResult;
    },

    async sendNav(mode, targets, action) {
      const res = await agentFetch(`${base}/api/input/nav`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          targetIds: targets.map((t) => t.id),
          action,
        }),
      });
      if (!res.ok) {
        throw await responseError(res, "agent sendNav failed");
      }
      return (await res.json()) as NavBroadcast;
    },

    async sendText(mode, targets, text) {
      const res = await agentFetch(`${base}/api/input/text`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          targetIds: targets.map((t) => t.id),
          text,
        }),
      });
      if (!res.ok) {
        throw await responseError(res, "agent sendText failed");
      }
      return (await res.json()) as ControlInjectResult;
    },

    async sendKey(mode, targets, key) {
      const res = await agentFetch(`${base}/api/input/key`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          targetIds: targets.map((t) => t.id),
          action: key.action,
          keycode: key.keycode,
          repeat: key.repeat,
          metastate: key.metastate,
        }),
      });
      if (!res.ok) {
        throw await responseError(res, "agent sendKey failed");
      }
      return (await res.json()) as ControlInjectResult;
    },

    async installApk(mode, targets, file) {
      if (!file.name.toLowerCase().endsWith(".apk")) {
        throw new Error("only .apk files can be installed");
      }
      const upload = await stageUpload(base, file);
      const res = await agentFetch(`${base}/api/input/install`, {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.android.package-archive",
          "X-Adboard-Mode": mode,
          "X-Adboard-Targets": targets.map((t) => t.id).join(","),
          "X-Adboard-Filename": file.name,
          ...upload.headers,
        },
        body: upload.body,
      });
      if (!res.ok) {
        throw await responseError(res, "agent install failed");
      }
      return (await res.json()) as InstallBroadcast;
    },

    async runCommand(targets, op, arg, arg2) {
      const res = await agentFetch(`${base}/api/device/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetIds: targets.map((t) => t.id),
          op,
          arg,
          arg2,
        }),
      });
      if (!res.ok) {
        throw await responseError(res, "command failed");
      }
      return (await res.json()) as DeviceCommandResponse;
    },

    async listHostFiles(path = "") {
      const res = await agentFetch(`${base}/api/host/files?path=${encodeURIComponent(path)}`, {
        cache: "no-store",
      });
      if (!res.ok) throw await responseError(res, "request failed");
      return (await res.json()) as HostFileEntry[];
    },

    async uploadHostFile(file, dir) {
      const upload = await stageUpload(base, file);
      const res = await agentFetch(`${base}/api/host/files`, {
        method: "POST",
        headers: {
          "X-Adboard-Filename": file.name,
          "X-Adboard-Dir": dir,
          ...upload.headers,
        },
        body: upload.body,
      });
      if (!res.ok) throw await responseError(res, "request failed");
      return (await res.json()) as HostFileEntry;
    },

    async deleteHostFile(path) {
      const res = await agentFetch(`${base}/api/host/files?path=${encodeURIComponent(path)}`, {
        method: "DELETE",
      });
      if (!res.ok && res.status !== 204) throw await responseError(res, "request failed");
    },

    async fetchHostFile(path) {
      const res = await agentFetch(`${base}/api/host/files/raw?path=${encodeURIComponent(path)}`);
      if (!res.ok) throw await responseError(res, "download failed");
      return res.blob();
    },

    async pushToDevices(targets, file, dest) {
      const upload = await stageUpload(base, file);
      const res = await agentFetch(`${base}/api/device/push`, {
        method: "POST",
        headers: {
          "X-Adboard-Targets": targets.map((t) => t.id).join(","),
          "X-Adboard-Filename": file.name,
          "X-Adboard-Dest": dest,
          ...upload.headers,
        },
        body: upload.body,
      });
      if (!res.ok) throw await responseError(res, "request failed");
      return (await res.json()) as DeviceCommandResponse;
    },

    async pullFromDevice(deviceId, path) {
      const res = await agentFetch(
        `${base}/api/device/pull?deviceId=${encodeURIComponent(deviceId)}&path=${encodeURIComponent(path)}`,
      );
      if (!res.ok) throw await responseError(res, "request failed");
      return res.blob();
    },

    async hostFileOp(op, path, dest) {
      const res = await agentFetch(`${base}/api/host/files/op`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op, path, dest: dest ?? "" }),
      });
      if (!res.ok) throw await responseError(res, "request failed");
      return (await res.json()) as HostFileEntry;
    },

    async connectWireless(input) {
      const res = await agentFetch(`${base}/api/devices/wireless`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: input.address,
          port: input.port,
          pairingPort: input.pairingPort,
          pairingCode: input.pairingCode,
        }),
      });
      if (!res.ok) {
        throw await responseError(res, "wireless connect failed");
      }
      return (await res.json()) as WirelessConnectResult;
    },

    async listWireless() {
      const res = await agentFetch(`${base}/api/devices/wireless`, { cache: "no-store" });
      if (!res.ok) throw await responseError(res, "request failed");
      const body = (await res.json()) as { endpoints?: string[] };
      return body.endpoints ?? [];
    },

    async startWirelessQr() {
      const res = await agentFetch(`${base}/api/devices/wireless/qr`, { method: "POST" });
      if (!res.ok) {
        throw await responseError(res, "QR pairing failed");
      }
      return (await res.json()) as WirelessQrSession;
    },

    async wirelessQrStatus(id) {
      const res = await agentFetch(`${base}/api/devices/wireless/qr/${encodeURIComponent(id)}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        throw await responseError(res, "QR status failed");
      }
      return (await res.json()) as WirelessQrStatus;
    },

    async cancelWirelessQr(id) {
      const res = await agentFetch(`${base}/api/devices/wireless/qr/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!res.ok && res.status !== 204) {
        throw await responseError(res, "QR cancel failed");
      }
    },

    async disconnectWireless(address) {
      const res = await agentFetch(`${base}/api/devices/wireless`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address }),
      });
      if (!res.ok) {
        throw await responseError(res, "wireless disconnect failed");
      }
      return (await res.json()) as WirelessConnectResult;
    },

    async listHosts() {
      const res = await agentFetch(`${base}/api/hosts`, { cache: "no-store" });
      if (!res.ok) throw await responseError(res, "request failed");
      return (await res.json()) as import("@/lib/devices/types").HostInfo[];
    },

    async listSessions() {
      const res = await agentFetch(`${base}/api/sessions`, { cache: "no-store" });
      if (!res.ok) {
        throw new Error(`agent listSessions failed: ${res.status}`);
      }
      return (await res.json()) as SessionStatus[];
    },

    subscribeDevices(onDevices, onSession) {
      let closed = false;
      let socket: WebSocket | null = null;
      let retryTimer: ReturnType<typeof setTimeout> | null = null;

      const connect = () => {
        if (closed) return;
        void agentWsUrl("/ws")
          .then((wsUrl) => {
            if (closed) return;
            socket = new WebSocket(wsUrl, agentWsProtocols());
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
                  void agentFetch(`${base}/api/devices`, { cache: "no-store" })
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
          })
          .catch(() => {
            if (!closed) {
              retryTimer = setTimeout(connect, 2000);
            }
          });
      };

      void ensureAgentToken().finally(connect);

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
  if (agent !== null) {
    console.info(
      "[adboard] using agent at",
      agent || "same origin",
    );
    return createAgentDevicesClient(agent);
  }
  console.info("[adboard] NEXT_PUBLIC_AGENT_URL unset — using mock client");
  return createMockDevicesClient();
}

/** Singleton for the app — agent when configured, mock otherwise. */
export const devicesClient: DevicesClient = createDevicesClient();

export function isAgentConfigured(): boolean {
  return agentBaseUrl() !== null;
}
