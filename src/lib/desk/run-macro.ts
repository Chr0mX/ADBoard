import { devicesClient } from "@/lib/api/client";
import { replayGesture } from "@/lib/desk/gesture";
import type { DeviceProfile, MacroStep, SavedMacro } from "@/lib/desk/store";
import type { Device, NavAction } from "@/lib/devices/types";

export interface MacroProgress {
  deviceId: string;
  deviceName: string;
  step: number;
  total: number;
  status: "running" | "done" | "failed" | "skipped";
  detail?: string;
}

function fill(template: string, values: Record<string, string>) {
  return template.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => values[name] ?? "");
}

function valuesFor(
  device: Device,
  global: Record<string, string>,
  perDevice: Record<string, Record<string, string>>,
) {
  return { ...global, ...(perDevice[device.id] ?? {}) };
}

async function command(device: Device, op: string, arg?: string, arg2?: string) {
  const response = await devicesClient.runCommand([device], op, arg, arg2);
  const failed = response.results.find((result) => !result.ok);
  if (failed) throw new Error(failed.error || `${device.name} ${op} failed`);
  return response.results[0]?.output;
}

function percent(
  step: MacroStep,
  profile: DeviceProfile | undefined,
  field: "x" | "y" | "x2" | "y2",
  fallback: number,
) {
  const override = profile?.overrides?.[step.id]?.[field];
  const value = override ?? step[field] ?? fallback;
  return value / 100;
}

async function waitUntil(timeoutMs: number, probe: () => Promise<boolean>) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("timed out");
}

async function runStep(
  device: Device,
  step: MacroStep,
  values: Record<string, string>,
  profile: DeviceProfile | undefined,
  timeoutMs: number,
) {
  const text = (value?: string) => fill(value ?? "", values);
  switch (step.kind) {
    case "wait":
      await new Promise((resolve) => setTimeout(resolve, step.ms ?? 500));
      return;
    case "timeout":
      return;
    case "waitDevice":
      await waitUntil(step.ms ?? timeoutMs, async () => {
        const devices = await devicesClient.listDevices();
        return devices.some((item) => item.id === device.id && item.status === "online");
      });
      return;
    case "waitApp":
      await waitUntil(step.ms ?? timeoutMs, async () => {
        const output = await command(device, "shell", `pidof ${step.packageName ?? ""}`);
        return Boolean(output && output.trim());
      });
      return;
    case "waitScreen":
      await waitUntil(step.ms ?? timeoutMs, async () => {
        const sessions = (await devicesClient.listSessions?.()) ?? [];
        return sessions.some(
          (session) => session.serial === device.serial && session.stream === "streaming",
        );
      });
      return;
    case "gesture": {
      const samples = step.samples ?? [];
      await replayGesture(samples, (sample) =>
        devicesClient.sendPointer(
          "selected",
          [device],
          sample.phase,
          { x: sample.x, y: sample.y },
          step.frameWidth ?? 0,
          step.frameHeight ?? 0,
          sample.tool,
        ),
      );
      return;
    }
    case "tap":
    case "doubleTap": {
      const point = `${percent(step, profile, "x", 50)},${percent(step, profile, "y", 50)}`;
      await command(device, "tap", point);
      if (step.kind === "doubleTap") await command(device, "tap", point);
      return;
    }
    case "longPress":
      await command(
        device,
        "longPress",
        `${percent(step, profile, "x", 50)},${percent(step, profile, "y", 50)}`,
      );
      return;
    case "swipe":
    case "scroll":
    case "drag":
    case "pinch": {
      if (step.kind === "pinch") {
        const x = percent(step, profile, "x", 50);
        const y = percent(step, profile, "y", 50);
        await command(device, "swipe", `${x},${y},${Math.max(0, x - 0.2)},${y}`);
        await command(device, "swipe", `${x},${y},${Math.min(1, x + 0.2)},${y}`);
        return;
      }
      const y2 =
        step.kind === "scroll" ? percent(step, profile, "y", 70) - 0.3 : percent(step, profile, "y2", 30);
      await command(
        device,
        "swipe",
        `${percent(step, profile, "x", 50)},${percent(step, profile, "y", 70)},${percent(step, profile, "x2", 50)},${y2}`,
      );
      return;
    }
    case "text":
      await command(device, "text", text(step.text));
      return;
    case "nav":
      await devicesClient.sendNav("selected", [device], {
        type: (step.nav ?? "home") as NavAction["type"],
      });
      return;
    case "launch":
      await command(
        device,
        "launch",
        text(step.packageName),
        [step.activity, step.text].filter(Boolean).join(" ") || undefined,
      );
      return;
    case "forceStop":
      await command(device, "forceStop", text(step.packageName));
      return;
    case "reboot":
      await command(device, "reboot");
      return;
    case "shutdown":
      await command(device, "shutdown");
      return;
    case "shell":
      await command(device, "shell", text(step.command));
      return;
    case "screenshot":
      await command(device, "screenshot");
      return;
    case "recordStart": {
      const size = [step.size, step.dest].filter(Boolean).join("|");
      await command(device, "recordStart", step.bitrate || "8000000", size || undefined);
      return;
    }
    case "recordStop":
      await command(device, "recordStop");
      return;
    case "upload": {
      const hostPath = text(step.hostPath || step.text);
      const blob = await devicesClient.fetchHostFile(hostPath);
      const name = hostPath.split("/").pop() || "file";
      await devicesClient.pushToDevices(
        [device],
        new File([blob], name),
        step.dest || "/sdcard/Download/",
      );
      return;
    }
    case "download": {
      const remote = text(step.command);
      const blob = await devicesClient.pullFromDevice(device.id, remote);
      const name = remote.split("/").pop() || "file";
      await devicesClient.uploadHostFile(new File([blob], name), step.dest || "Downloads");
      return;
    }
    case "deleteFile":
      await command(device, "delete", text(step.command));
      return;
    case "install": {
      const hostPath = text(step.hostPath || step.text);
      const blob = await devicesClient.fetchHostFile(hostPath);
      const name = hostPath.split("/").pop() || "app.apk";
      const result = await devicesClient.installApk("selected", [device], new File([blob], name));
      const failed = result.targets.find((target) => target.inject === "error");
      if (failed) throw new Error(failed.detail || "install failed");
      return;
    }
    default:
      throw new Error(`unsupported step ${step.kind}`);
  }
}

export async function runMacro(options: {
  macro: SavedMacro;
  devices: Device[];
  parallel: boolean;
  variables: Record<string, string>;
  deviceVariables: Record<string, Record<string, string>>;
  profiles?: Record<string, DeviceProfile>;
  onProgress: (progress: MacroProgress) => void;
}) {
  const { macro, devices, parallel, variables, deviceVariables, profiles, onProgress } = options;
  const total = macro.steps.length;

  const one = async (device: Device) => {
    const values = valuesFor(device, variables, deviceVariables);
    const profile = profiles?.[device.id];
    if (device.status !== "online") {
      onProgress({
        deviceId: device.id,
        deviceName: device.name,
        step: 0,
        total,
        status: "skipped",
        detail: "offline",
      });
      return;
    }
    let timeoutMs = 15000;
    for (let index = 0; index < macro.steps.length; index += 1) {
      const step = macro.steps[index];
      if (step.kind === "timeout") timeoutMs = step.ms ?? timeoutMs;
      onProgress({
        deviceId: device.id,
        deviceName: device.name,
        step: index + 1,
        total,
        status: "running",
      });
      try {
        await runStep(device, step, values, profile, timeoutMs);
      } catch (error) {
        onProgress({
          deviceId: device.id,
          deviceName: device.name,
          step: index + 1,
          total,
          status: "failed",
          detail: error instanceof Error ? error.message : "step failed",
        });
        return;
      }
    }
    onProgress({
      deviceId: device.id,
      deviceName: device.name,
      step: total,
      total,
      status: "done",
    });
  };

  if (parallel) {
    await Promise.all(devices.map((device) => one(device)));
  } else {
    for (const device of devices) {
      await one(device);
    }
  }
}
