import { devicesClient } from "@/lib/api/client";
import { actionOf, touchGeometry, touchStrokes } from "@/lib/desk/actions";
import { replayGesture } from "@/lib/desk/gesture";
import type { DeviceProfile, MacroStep, SavedMacro } from "@/lib/desk/store";
import type { Device, NavAction } from "@/lib/devices/types";

/*
 * Plays Shell Automation jobs from this browser. Each step maps to a real
 * agent operation: adb shell commands (runCommand), timed touches (the same
 * gesture endpoint the Macros runner uses), keys or file transfers. Runs stop
 * if this page closes.
 */

export interface MacroProgress {
  deviceId: string;
  deviceName: string;
  step: number;
  total: number;
  status: "running" | "done" | "failed" | "skipped" | "stopped";
  detail?: string;
}

/** One line of a run's log. */
export interface StepLog {
  at: number;
  deviceId: string;
  deviceName: string;
  /** 1-based position in the job. */
  step: number;
  cycle: number;
  kind: MacroStep["kind"];
  status: "ok" | "failed" | "skipped" | "stopped";
  detail?: string;
}

class Stopped extends Error {}

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
  return response.results[0]?.output ?? "";
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Stopped());
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Stopped());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitUntil(timeoutMs: number, probe: () => Promise<boolean>, signal?: AbortSignal) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await probe()) return;
    await sleep(500, signal);
  }
  throw new Error(`timed out after ${Math.round(timeoutMs / 1000)} s`);
}

/** The step with this phone's coordinate overrides (Profiles) applied. */
function withProfile(step: MacroStep, profile: DeviceProfile | undefined): MacroStep {
  const override = profile?.overrides?.[step.id];
  return override ? { ...step, ...override } : step;
}

/** Run one step on one phone. Returns a short result for the log. */
async function runStep(
  device: Device,
  raw: MacroStep,
  values: Record<string, string>,
  profile: DeviceProfile | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const step = withProfile(raw, profile);
  const text = (value?: string) => fill(value ?? "", values);
  const geometry = touchGeometry(step);
  if (geometry) {
    let detail = "";
    for (const strokes of touchStrokes(step, geometry)) {
      const result = await devicesClient.sendGesture("selected", [device], strokes);
      const target = result.targets.find((t) => t.deviceId === device.id) ?? result.targets[0];
      if (!target) throw new Error("no result from the agent");
      if (target.inject === "error") throw new Error(target.detail || "touch failed");
      detail = target.inject === "stub" ? "mock phone: touch not sent" : "touched";
    }
    return detail;
  }
  switch (step.kind) {
    case "wait":
      await sleep(step.ms ?? 500, signal);
      return `waited ${step.ms ?? 500} ms`;
    case "timeout":
      return `wait limit ${step.ms ?? timeoutMs} ms`;
    case "waitDevice":
      await waitUntil(
        step.ms ?? timeoutMs,
        async () => {
          const devices = await devicesClient.listDevices();
          return devices.some((item) => item.id === device.id && item.status === "online");
        },
        signal,
      );
      return "phone online";
    case "waitApp":
      await waitUntil(
        step.ms ?? timeoutMs,
        async () => {
          const output = await command(device, "shell", `pidof ${text(step.packageName)}`);
          return Boolean(output && output.trim());
        },
        signal,
      );
      return `${text(step.packageName)} running`;
    case "waitScreen":
      if (!devicesClient.listSessions) throw new Error("live screen status needs the agent");
      await waitUntil(
        step.ms ?? timeoutMs,
        async () => {
          const sessions = (await devicesClient.listSessions?.()) ?? [];
          return sessions.some((session) => session.serial === device.serial && session.stream === "streaming");
        },
        signal,
      );
      return "live screen running";
    case "gesture": {
      const samples = step.samples ?? [];
      await replayGesture(
        samples,
        (sample) =>
          devicesClient.sendPointer(
            "selected",
            [device],
            sample.phase,
            { x: sample.x, y: sample.y },
            step.frameWidth ?? 0,
            step.frameHeight ?? 0,
            sample.tool,
          ),
        { shouldStop: () => Boolean(signal?.aborted) },
      );
      return `replayed ${samples.length} pointer events`;
    }
    case "text":
      return command(device, "text", text(step.text));
    case "nav": {
      const result = await devicesClient.sendNav("selected", [device], {
        type: (step.nav ?? "home") as NavAction["type"],
      });
      const target = result?.targets?.find((t) => t.deviceId === device.id);
      if (target?.inject === "error") throw new Error(target.detail || "key failed");
      return target?.inject === "stub" ? "mock phone: key not sent" : `pressed ${step.nav ?? "home"}`;
    }
    case "launch":
      return command(
        device,
        "launch",
        text(step.packageName),
        // Older jobs kept the activity in `text` (and sometimes a copy of the package there).
        step.activity || (step.text && step.text !== step.packageName ? step.text : undefined),
      );
    case "forceStop":
      return command(device, "forceStop", text(step.packageName));
    case "clearData":
      return command(device, "clearData", text(step.packageName));
    case "uninstall":
      return command(device, "uninstall", text(step.packageName));
    case "reboot":
      return command(device, "reboot");
    case "shutdown":
      return command(device, "shutdown");
    case "shell":
      return command(device, "shell", text(step.command || step.text));
    case "intent":
      return command(device, "intent", step.intentVerb === "start" ? "start" : "broadcast", text(step.command));
    case "startShizuku":
      return command(device, "shizuku", "start");
    case "tweak":
      return command(device, "tweak", step.tweak ?? "phantomKillerOff", step.tweakState === "off" ? "off" : "on");
    case "screenshot":
      return command(device, "screenshot");
    case "recordStart": {
      const size = [step.size, step.dest].filter(Boolean).join("|");
      return command(device, "recordStart", step.bitrate || "8000000", size || undefined);
    }
    case "recordStop":
      return command(device, "recordStop");
    case "upload": {
      const hostPath = text(step.hostPath || step.text);
      const blob = await devicesClient.fetchHostFile(hostPath);
      const name = hostPath.split("/").pop() || "file";
      const response = await devicesClient.pushToDevices([device], new File([blob], name), step.dest || "/sdcard/Download/");
      const failed = response.results.find((result) => !result.ok);
      if (failed) throw new Error(failed.error || "send failed");
      return `sent ${name}`;
    }
    case "download": {
      const remote = text(step.command);
      const blob = await devicesClient.pullFromDevice(device.id, remote);
      const name = remote.split("/").pop() || "file";
      await devicesClient.uploadHostFile(new File([blob], name), step.dest || "Downloads");
      return `saved ${name} to ${step.dest || "Downloads"}`;
    }
    case "deleteFile":
      return command(device, "delete", text(step.command));
    case "install": {
      const hostPath = text(step.hostPath || step.text);
      const blob = await devicesClient.fetchHostFile(hostPath);
      const name = hostPath.split("/").pop() || "app.apk";
      const result = await devicesClient.installApk("selected", [device], new File([blob], name));
      const failed = result.targets.find((target) => target.inject === "error");
      if (failed) throw new Error(failed.detail || "install failed");
      return `installed ${name}`;
    }
    default:
      throw new Error(`“${step.kind}” is not supported`);
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
  onLog?: (log: StepLog) => void;
  /** Stop: ends after the step in flight (waits end at once). */
  signal?: AbortSignal;
  /** Latest connection state; a phone that drops out fails at its next step. */
  isOnline?: (deviceId: string) => boolean;
  /** Play just this step once (Test). */
  onlyStepId?: string;
}) {
  const { macro, devices, parallel, variables, deviceVariables, profiles, onProgress, onLog, signal, isOnline, onlyStepId } = options;
  const total = macro.steps.length;
  const cycles = onlyStepId ? 1 : Math.max(1, Math.min(10_000, Math.round(macro.repeat ?? 1)));
  const keepGoing = macro.onError === "continue";

  const one = async (device: Device) => {
    const values = valuesFor(device, variables, deviceVariables);
    const profile = profiles?.[device.id];
    const report = (step: number, status: MacroProgress["status"], detail?: string) =>
      onProgress({ deviceId: device.id, deviceName: device.name, step, total, status, detail });
    const log = (step: number, cycle: number, kind: MacroStep["kind"], status: StepLog["status"], detail?: string) =>
      onLog?.({ at: Date.now(), deviceId: device.id, deviceName: device.name, step, cycle, kind, status, detail });
    if (device.status !== "online") {
      report(0, "skipped", "offline");
      return;
    }
    let timeoutMs = 15000;
    let failures = 0;
    for (let cycle = 1; cycle <= cycles; cycle += 1) {
      for (let index = 0; index < macro.steps.length; index += 1) {
        const step = macro.steps[index];
        if (onlyStepId && step.id !== onlyStepId) continue;
        if (signal?.aborted) {
          log(index + 1, cycle, step.kind, "stopped");
          report(index + 1, "stopped", "Stopped");
          return;
        }
        if (!onlyStepId && step.enabled === false) {
          log(index + 1, cycle, step.kind, "skipped", "turned off");
          continue;
        }
        if (step.kind === "timeout") timeoutMs = step.ms ?? timeoutMs;
        if (step.kind !== "waitDevice" && isOnline && !isOnline(device.id)) {
          log(index + 1, cycle, step.kind, "failed", "Phone disconnected");
          report(index + 1, "failed", "Phone disconnected");
          return;
        }
        if (!actionOf(step.kind)) {
          log(index + 1, cycle, step.kind, "failed", "not a supported action");
          failures += 1;
          if (!keepGoing) {
            report(index + 1, "failed", `step ${index + 1} is not a supported action`);
            return;
          }
          continue;
        }
        report(index + 1, "running");
        try {
          const detail = await runStep(device, step, values, profile, timeoutMs, signal);
          log(index + 1, cycle, step.kind, "ok", detail ? String(detail).slice(0, 2000) : undefined);
          if (step.delayAfterMs && !onlyStepId) await sleep(step.delayAfterMs, signal);
        } catch (error) {
          if (error instanceof Stopped) {
            log(index + 1, cycle, step.kind, "stopped");
            report(index + 1, "stopped", "Stopped");
            return;
          }
          const message = error instanceof Error ? error.message : "step failed";
          log(index + 1, cycle, step.kind, "failed", message);
          failures += 1;
          if (!keepGoing) {
            report(index + 1, "failed", message);
            return;
          }
        }
      }
    }
    report(total, failures > 0 ? "failed" : "done", failures > 0 ? `${failures} step${failures === 1 ? "" : "s"} failed` : undefined);
  };

  if (parallel) {
    await Promise.all(devices.map((device) => one(device)));
  } else {
    for (const device of devices) {
      if (signal?.aborted) break;
      await one(device);
    }
  }
}
