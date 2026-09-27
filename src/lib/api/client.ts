import { MOCK_DEVICES } from "@/lib/devices/mock-data";
import type {
  ControlMode,
  Device,
  MappedTap,
  NavAction,
  NormalizedPoint,
  TapBroadcast,
} from "@/lib/devices/types";
import { mapToDevices } from "@/lib/devices/coords";

/**
 * Thin client API shape for the control plane.
 * Today: local mock. Tomorrow: HTTP/WebSocket to Rust PhoneControl backend.
 * The browser never talks to ADB directly.
 */
export interface DevicesClient {
  listDevices(): Promise<Device[]>;
  sendTap(
    mode: ControlMode,
    targets: Device[],
    point: NormalizedPoint,
  ): Promise<TapBroadcast>;
  sendNav(mode: ControlMode, targets: Device[], action: NavAction): Promise<void>;
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
      const mapped: MappedTap[] = mapToDevices(point, targets);
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
      console.info("[mock-control] nav", {
        mode,
        action,
        targets: targets.map((t) => t.serial),
      });
    },
  };
}

/** Singleton for the app — swap implementation when backend is ready. */
export const devicesClient: DevicesClient = createMockDevicesClient();
