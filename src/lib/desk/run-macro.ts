import { devicesClient } from "@/lib/api/client";
import type { Device, NavAction } from "@/lib/devices/types";
import type { MacroStep, SavedMacro } from "@/lib/desk/store";

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

function valuesFor(device: Device, global: Record<string, string>, perDevice: Record<string, Record<string, string>>) {
  return { ...global, ...(perDevice[device.id] ?? {}) };
}

async function command(device: Device, op: string, arg?: string, arg2?: string) {
  const response = await devicesClient.runCommand([device], op, arg, arg2);
  const failed = response.results.find((result) => !result.ok);
  if (failed) throw new Error(failed.error || `${device.name} ${op} failed`);
}

async function runStep(device: Device, step: MacroStep, values: Record<string, string>) {
  switch (step.kind) {
    case "wait":
      await new Promise((resolve) => setTimeout(resolve, step.ms ?? 500));
      return;
    case "tap":
      await command(device, "tap", `${(step.x ?? 50) / 100},${(step.y ?? 50) / 100}`);
      return;
    case "swipe":
      await command(
        device,
        "swipe",
        `${(step.x ?? 50) / 100},${(step.y ?? 70) / 100},${(step.x2 ?? 50) / 100},${(step.y2 ?? 30) / 100}`,
      );
      return;
    case "text":
      await command(device, "text", fill(step.text ?? "", values));
      return;
    case "nav":
      await devicesClient.sendNav("selected", [device], {
        type: (step.nav ?? "home") as NavAction["type"],
      });
      return;
    case "launch":
      await command(device, "launch", step.packageName, step.activity);
      return;
    case "forceStop":
      await command(device, "forceStop", step.packageName);
      return;
    case "shell":
      await command(device, "shell", fill(step.command ?? "", values));
      return;
    case "screenshot":
      await command(device, "screenshot");
      return;
    default:
      return;
  }
}

export async function runMacro(options: {
  macro: SavedMacro;
  devices: Device[];
  parallel: boolean;
  variables: Record<string, string>;
  deviceVariables: Record<string, Record<string, string>>;
  onProgress: (progress: MacroProgress) => void;
}) {
  const { macro, devices, parallel, variables, deviceVariables, onProgress } = options;
  const total = macro.steps.length;

  const one = async (device: Device) => {
    const values = valuesFor(device, variables, deviceVariables);
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
    for (let index = 0; index < macro.steps.length; index += 1) {
      onProgress({
        deviceId: device.id,
        deviceName: device.name,
        step: index + 1,
        total,
        status: "running",
      });
      try {
        const result = await runStep(device, macro.steps[index], values);
        void result;
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
