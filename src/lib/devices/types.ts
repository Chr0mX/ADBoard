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
  type: "back" | "home" | "recent";
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
  action: "back" | "home" | "recent";
  targetIds: string[];
  targets?: NavTargetResult[];
}

export interface SessionStatus {
  serial: string;
  stream: StreamState;
  note: string;
  backend: string;
}
