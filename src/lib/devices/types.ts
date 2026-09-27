export type ConnectionType = "usb" | "network";
export type DeviceStatus = "online" | "offline" | "unauthorized";
export type ControlMode = "selected" | "multi" | "all";

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
  wallpaperHue: number;
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
