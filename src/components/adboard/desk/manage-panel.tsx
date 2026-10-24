"use client";

import { SwitchRow } from "@/components/ui/switch";
import { saveBlob } from "@/lib/api/download";
import { useEffect, useState } from "react";
import { devicesClient } from "@/lib/api/client";
import { WirelessAdb } from "@/components/adboard/wireless-adb";
import type { Device } from "@/lib/devices/types";
import { downloadScreenshots } from "@/lib/desk/capture";
import { useDesk } from "@/components/adboard/desk/desk-context";
import {
  ConfirmDialog,
  PanelFrame,
  ResultList,
  TargetChecks,
  formatSeen,
  picked,
  rowsFromCommand,
  useChecked,
  type ResultRow,
} from "@/components/adboard/desk/bits";

const TABS = [
  { id: "actions", label: "Actions" },
  { id: "screenshot", label: "Screenshot" },
  { id: "record", label: "Record" },
  { id: "info", label: "Information" },
  { id: "wireless", label: "Wireless" },
] as const;

export function ManagePanel() {
  const desk = useDesk();
  const [tab, setTab] = useState(desk.focusTool && TABS.some((item) => item.id === desk.focusTool) ? desk.focusTool : "actions");
  const [checked, setChecked] = useChecked(desk.devices, desk.targets.length ? desk.targets : desk.devices.filter((d) => d.id === desk.activeDevice?.id));
  const [rows, setRows] = useState<ResultRow[]>([]);
  const [confirm, setConfirm] = useState<"reboot" | "shutdown" | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (desk.focusTool && TABS.some((item) => item.id === desk.focusTool)) setTab(desk.focusTool);
  }, [desk.focusTool]);

  const targets = picked(desk.devices, checked);

  async function run(op: string, arg?: string, arg2?: string) {
    if (targets.length === 0) return;
    setBusy(true);
    try {
      const response = await devicesClient.runCommand(targets, op, arg, arg2);
      setRows(rowsFromCommand(desk.devices, checked, response.results));
    } catch (error) {
      setRows([
        {
          deviceId: "error",
          deviceName: "Request",
          state: "error",
          detail: error instanceof Error ? error.message : "Failed",
        },
      ]);
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }

  return (
    <PanelFrame title="Device management" panel="manage" clean description="Actions for the phones you select.">
      <div className="flex flex-wrap gap-2">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={tab === item.id}
            className={`h-11 rounded-lg px-3 text-sm ${tab === item.id ? "bg-[var(--pc-accent-fill)] text-white" : "border border-[var(--pc-line)]"}`}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
        <TargetChecks devices={desk.devices} checked={checked} onChange={setChecked} />
        <div className="flex flex-col gap-3">
          {tab === "actions" && (
            <div className="flex flex-wrap gap-2">
              <Action label="Reconnect" disabled={busy} onClick={() => void run("reconnect")} />
              <Action label="Restart ADB" disabled={busy} onClick={() => void run("restartAdb")} />
              <Action label="Reboot" disabled={busy} onClick={() => setConfirm("reboot")} />
              <Action label="Shutdown" disabled={busy} onClick={() => setConfirm("shutdown")} />
            </div>
          )}
          {tab === "screenshot" && (
            <ScreenshotTools busy={busy} devices={targets} onDone={setRows} />
          )}
          {tab === "record" && <RecordTools busy={busy} onRun={run} />}
          {tab === "info" && <InfoPanel device={targets[0] ?? desk.activeDevice} />}
          {tab === "wireless" && <WirelessAdb initialOpen />}
          <ResultList rows={rows} />
          <RecoveryList />
        </div>
      </div>
      {confirm && (
        <ConfirmDialog
          title={
            confirm === "reboot"
              ? targets.length > 1
                ? `Reboot ${targets.length} devices?`
                : "Reboot Device?"
              : targets.length > 1
                ? `Shut down ${targets.length} devices?`
                : "Shut down device?"
          }
          body={
            <div className="flex flex-col gap-2">
              <p>
                {targets.map((device) => device.name).join(", ") || "No devices selected"}
              </p>
              {targets.length > 1 && (
                <p className="text-[var(--pc-warn)]">
                  This affects every checked phone. It cannot be undone from here.
                </p>
              )}
            </div>
          }
          confirmLabel={confirm === "reboot" ? "Reboot" : "Shutdown"}
          requirePhrase={targets.length > 1 ? confirm : undefined}
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void run(confirm)}
        />
      )}
    </PanelFrame>
  );
}

function Action({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="h-11 rounded-lg border border-[var(--pc-line)] bg-[var(--pc-panel)] px-3 text-sm disabled:opacity-60"
    >
      {label}
    </button>
  );
}

function ScreenshotTools({
  devices,
  busy,
  onDone,
}: {
  devices: Device[];
  busy: boolean;
  onDone: (rows: ResultRow[]) => void;
}) {
  const [working, setWorking] = useState(false);

  async function shoot(mode: "local" | "clipboard" | "device") {
    if (devices.length === 0) return;
    setWorking(true);
    try {
      if (mode === "local") {
        onDone(await downloadScreenshots(devices));
        return;
      }
      const response = await devicesClient.runCommand(
        devices,
        "screenshot",
        mode === "device" ? "device" : undefined,
      );
      const rows: ResultRow[] = response.results.map((result) => ({
        deviceId: result.deviceId,
        deviceName: result.deviceName,
        state: result.ok ? "ok" : "error",
        detail: result.ok ? result.output || "Saved" : result.error || "Failed",
      }));
      if (mode === "clipboard" && rows[0]?.state === "ok" && response.results[0]?.output) {
        try {
          const file = await devicesClient.fetchHostFile(response.results[0].output);
          await navigator.clipboard.write([new ClipboardItem({ "image/png": file })]);
          rows[0].detail = "Copied to clipboard";
        } catch (error) {
          rows[0].detail = error instanceof Error ? error.message : "Clipboard unavailable";
          rows[0].state = "error";
        }
      }
      onDone(rows);
    } catch (error) {
      onDone([
        {
          deviceId: "shot",
          deviceName: "Screenshot",
          state: "error",
          detail: error instanceof Error ? error.message : "Failed",
        },
      ]);
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-[var(--pc-muted)]">
        Saves land in Screenshots/&lt;serial&gt;/ on the host. Several phones each get their own folder.
      </p>
      <div className="flex flex-wrap gap-2">
        <Action label="Save locally" disabled={busy || working} onClick={() => void shoot("local")} />
        <Action label="Copy to clipboard" disabled={busy || working} onClick={() => void shoot("clipboard")} />
        <Action label="Save to device" disabled={busy || working} onClick={() => void shoot("device")} />
      </div>
    </div>
  );
}

function RecordTools({
  busy,
  onRun,
}: {
  busy: boolean;
  onRun: (op: string, arg?: string, arg2?: string) => Promise<void>;
}) {
  const [size, setSize] = useState("1280x720");
  const [fps, setFps] = useState("device");
  const [bitrate, setBitrate] = useState("8000000");
  const [dest, setDest] = useState("/sdcard/Movies");

  return (
    <form
      className="grid gap-2 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        const packed = [size === "device" ? "" : size, dest].filter(Boolean).join("|");
        void onRun("recordStart", bitrate, packed);
      }}
    >
      <label className="text-sm">
        Resolution
        <select
          value={size}
          onChange={(event) => setSize(event.target.value)}
          className="mt-1 h-11 w-full rounded-lg border border-[var(--pc-line)] bg-[var(--pc-panel)] text-[var(--pc-ink)] px-2"
        >
          <option value="1280x720">1280 × 720</option>
          <option value="1920x1080">1920 × 1080</option>
          <option value="device">Device size</option>
        </select>
      </label>
      <label className="text-sm">
        FPS
        <select
          value={fps}
          onChange={(event) => setFps(event.target.value)}
          className="mt-1 h-11 w-full rounded-lg border border-[var(--pc-line)] bg-[var(--pc-panel)] text-[var(--pc-ink)] px-2"
        >
          <option value="device">Device default</option>
          <option value="30">30</option>
          <option value="60">60</option>
        </select>
      </label>
      <label className="text-sm">
        Bitrate
        <input
          value={bitrate}
          onChange={(event) => setBitrate(event.target.value)}
          className="mt-1 h-11 w-full rounded-lg border border-[var(--pc-line)] bg-[var(--pc-panel)] text-[var(--pc-ink)] px-2 font-mono text-xs"
        />
      </label>
      <label className="text-sm">
        Format
        <input value="mp4" readOnly className="mt-1 h-11 w-full rounded-lg border border-[var(--pc-line)] bg-[var(--pc-panel)] text-[var(--pc-ink)] px-2" />
      </label>
      <SwitchRow label="Audio" description="Android screenrecord has no audio" disabled checked={false} readOnly className="-mx-2" />
      <label className="text-sm">
        Output directory
        <input
          value={dest}
          onChange={(event) => setDest(event.target.value)}
          className="mt-1 h-11 w-full rounded-lg border border-[var(--pc-line)] bg-[var(--pc-panel)] text-[var(--pc-ink)] px-2 font-mono text-xs"
        />
      </label>
      <div className="flex gap-2 sm:col-span-2">
        <button
          type="submit"
          disabled={busy}
          className="h-11 rounded-lg bg-[var(--pc-accent-fill)] px-4 text-sm font-semibold text-white"
        >
          Start
        </button>
        <Action label="Stop" disabled={busy} onClick={() => void onRun("recordStop")} />
      </div>
      {fps !== "device" && (
        <p className="text-xs text-[var(--pc-muted)] sm:col-span-2">
          Requested {fps} fps. screenrecord uses the device frame rate.
        </p>
      )}
    </form>
  );
}

function InfoPanel({ device }: { device: Device | null }) {
  const [extra, setExtra] = useState<string>("");
  useEffect(() => {
    if (!device) return;
    let cancel = false;
    void devicesClient
      .runCommand([device], "info")
      .then((response) => {
        if (!cancel) setExtra(response.results[0]?.output || response.results[0]?.error || "");
      })
      .catch((error: unknown) => {
        if (!cancel) setExtra(error instanceof Error ? error.message : "info failed");
      });
    return () => {
      cancel = true;
    };
  }, [device]);

  if (!device) return <p className="text-sm text-[var(--pc-muted)]">Select a device.</p>;
  const fields = parseInfo(extra);
  const rows: Array<[string, string]> = [
    ["Name", device.name],
    ["Model", fields.model || device.model],
    ["Android", fields.android || device.androidVersion],
    ["Serial", device.serial],
    ["Resolution", `${device.resolution.width} × ${device.resolution.height}`],
    ["Refresh Rate", device.fps ? `${device.fps} Hz` : "—"],
    ["Battery", fields.level ? `${fields.level}%` : device.battery != null ? `${device.battery}%` : "—"],
    ["Temperature", fields.temperature || (device.temperatureC != null ? `${device.temperatureC}°C` : "—")],
    ["Storage", fields.storage || "—"],
    ["RAM", fields.ram || "—"],
    ["Connection", device.connection === "usb" ? "USB" : "Network"],
    ["Host", device.host],
    ["ADB", device.status === "online" ? "Connected" : device.status],
  ];
  return (
    <dl data-device-info className="grid grid-cols-[8rem_minmax(0,1fr)] gap-y-1 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-[var(--pc-muted)]">{label}</dt>
          <dd className="font-mono text-xs text-[var(--pc-ink)]">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function parseInfo(text: string) {
  const fields: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const [key, ...rest] = line.split(":");
    if (!key || rest.length === 0) continue;
    fields[key.trim().toLowerCase()] = rest.join(":").trim();
  }
  const temp = fields.temperature;
  return {
    model: fields.model,
    android: fields.android,
    level: fields.level,
    temperature: temp ? `${(Number(temp) / 10).toFixed(0)}°C` : "",
    storage: fields.storage,
    ram: fields.ram,
  };
}

function RecoveryList() {
  const desk = useDesk();
  const offline = desk.devices.filter((device) => device.status !== "online");
  if (offline.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {offline.map((device) => (
        <article
          key={device.id}
          data-recovery={device.id}
          className="rounded-xl border border-[var(--pc-warn)]/40 bg-[var(--pc-warn-soft)] p-3"
        >
          <p className="font-display text-sm font-semibold text-[var(--pc-warn)]">
            ⚠ {device.name} Offline
          </p>
          <p className="mt-1 font-mono text-xs text-[var(--pc-muted)]">
            Last seen: {formatSeen(desk.lastSeen[device.id])}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Action label="Reconnect" onClick={() => void devicesClient.runCommand([device], "reconnect")} />
            <Action label="Restart ADB" onClick={() => void devicesClient.runCommand([device], "restartAdb")} />
            <Action label="View Logs" onClick={() => desk.open("developer", "logs", device.id)} />
          </div>
        </article>
      ))}
    </div>
  );
}
