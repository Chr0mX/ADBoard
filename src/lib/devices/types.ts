export type ConnectionType = "usb" | "network";
export type DeviceStatus = "online" | "offline" | "unauthorized";
export type ControlMode = "selected" | "multi" | "all";
export type InjectStatus = "ok" | "stub" | "error";
export type StreamState = "idle" | "starting" | "streaming" | "error";
export type HostStatus = "online" | "stale" | "offline";

export interface DeviceResolution {
  width: number;
  height: number;
}

export interface Device {
  id: string;
  name: string;
  model: string;
  androidVersion: string;
  serial: string;
  connection: ConnectionType;
  status: DeviceStatus;
  battery: number | null;
  temperatureC: number | null;
  resolution: DeviceResolution;
  fps: number | null;
  bitrateMbps: number | null;
  latencyMs: number | null;
  host: string;
  /** Stable mesh host id when provided by the agent. */
  hostId?: string;
  wallpaperHue: number;
}

export interface HostInfo {
  hostId: string;
  name: string;
  os: string;
  status: HostStatus;
  deviceCount: number;
  local: boolean;
  lastSeenMs?: number;
}

export interface NormalizedPoint {
  x: number;
  y: number;
}

export type PointerPhase = "down" | "move" | "up" | "cancel" | "hover" | "leave";
export type PointerTool = "finger" | "mouse";

export interface StreamStats {
  fps: number;
  bitrateKbps: number;
  width: number;
  height: number;
  codec: string;
}

export interface MappedTap {
  deviceId: string;
  deviceName: string;
  x: number;
  y: number;
  width: number;
  height: number;
  inject?: InjectStatus;
  injectDetail?: string;
}

export interface TapBroadcast {
  id: string;
  at: number;
  normalized: NormalizedPoint;
  mode: ControlMode;
  targets: MappedTap[];
}

export interface NavAction {
  type: "back" | "home" | "recent" | "volume_up" | "volume_down" | "power";
}

export interface NavTargetResult {
  deviceId: string;
  deviceName: string;
  inject: InjectStatus;
  detail?: string;
}

export interface NavBroadcast {
  id: string;
  at: number;
  mode: ControlMode;
  action: "back" | "home" | "recent" | "volume_up" | "volume_down" | "power";
  targetIds: string[];
  targets?: NavTargetResult[];
}

/** One finger of a timed gesture (POST /api/input/gesture). Points are 0–1. */
export interface GestureStroke {
  /** Finger slot 0–9. */
  pointer: number;
  startMs: number;
  durationMs: number;
  points: NormalizedPoint[];
}

export interface GestureResult {
  id: string;
  at: number;
  mode: ControlMode;
  targetIds: string[];
  targets: NavTargetResult[];
}

export interface InstallBroadcast {
  id: string;
  at: number;
  mode: ControlMode;
  targetIds: string[];
  targets: NavTargetResult[];
}

export interface DeviceOpResult {
  deviceId: string;
  deviceName: string;
  ok: boolean;
  output?: string;
  error?: string;
}

export interface DeviceCommandResponse {
  id: string;
  op: string;
  results: DeviceOpResult[];
}

export interface HostFileEntry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
}

export interface SessionStatus {
  serial: string;
  stream: StreamState;
  note: string;
  backend: string;
}
