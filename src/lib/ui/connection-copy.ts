import type { Device, SessionStatus, StreamState } from "@/lib/devices/types";

/** Short status-line problem label (fits StatsLine). */
export function connectionProblemLabel(
  device: Device,
  session?: SessionStatus | null,
): string | null {
  if (device.status === "unauthorized") return "unauthorized — unlock USB debugging";
  if (device.status === "offline") return "ADB offline — reconnect";
  if (device.status !== "online") return device.status;

  const stream = session?.stream;
  if (stream === "error") {
    return session?.note?.trim() || "stream error — tap Refresh or Reconnect";
  }
  if (stream === "starting") return "stream starting…";
  if (stream === "idle" && session?.note?.trim()) {
    return session.note.trim();
  }
  return null;
}

/** Longer copy for the Control offline / no-signal overlay. */
export function offlineOverlayCopy(device: Device | null): {
  title: string;
  body: string;
  showReconnect: boolean;
} {
  if (!device) {
    return {
      title: "No device",
      body: "Select an online phone to preview the stream.",
      showReconnect: false,
    };
  }
  if (device.status === "unauthorized") {
    return {
      title: "Unauthorized",
      body: "Accept the USB debugging prompt on the phone, then tap Reconnect.",
      showReconnect: true,
    };
  }
  if (device.status !== "online") {
    return {
      title: "ADB offline",
      body: "The agent cannot reach this phone. Check the cable or Wi‑Fi ADB, then tap Reconnect.",
      showReconnect: true,
    };
  }
  return {
    title: "No signal",
    body: "Stream unavailable for this device.",
    showReconnect: false,
  };
}

/** Copy when the device is online but the scrcpy/video path is down. */
export function streamOverlayCopy(
  stream: StreamState | undefined,
  note?: string,
): { title: string; body: string } | null {
  if (stream === "error") {
    return {
      title: "Stream error",
      body: note?.trim() || "Video dropped. Tap Refresh, or Reconnect if it stays blank.",
    };
  }
  if (stream === "starting") {
    return {
      title: "Connecting",
      body: note?.trim() || "Starting the scrcpy stream…",
    };
  }
  return null;
}
