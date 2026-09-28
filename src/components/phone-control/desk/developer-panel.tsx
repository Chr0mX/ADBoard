"use client";

import { useEffect, useState } from "react";
import { devicesClient } from "@/lib/api/client";
import { useDesk } from "@/components/phone-control/desk/desk-context";
import {
  PanelFrame,
  PrimaryButton,
  ResultList,
  TargetChecks,
  TextField,
  picked,
  rowsFromCommand,
  useChecked,
  type ResultRow,
} from "@/components/phone-control/desk/bits";

const HISTORY_KEY = "phonecontrol-shell-history";

function readHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const parsed = raw ? (JSON.parse(raw) as string[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function DeveloperPanel() {
  const desk = useDesk();
  const [tab, setTab] = useState(desk.focusTool === "logs" || desk.focusTool === "info" ? desk.focusTool : "shell");
  const [checked, setChecked] = useChecked(desk.devices, desk.targets);
  const [command, setCommand] = useState("pm list packages");
  const [history, setHistory] = useState<string[]>([]);
  const [rows, setRows] = useState<ResultRow[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setHistory(readHistory());
  }, []);

  useEffect(() => {
    if (desk.focusTool === "logs" || desk.focusTool === "shell" || desk.focusTool === "info") {
      setTab(desk.focusTool);
    }
  }, [desk.focusTool]);

  async function run() {
    const targets = picked(desk.devices, checked);
    if (!command.trim() || targets.length === 0) return;
    setBusy(true);
    const nextHistory = [command, ...history.filter((item) => item !== command)].slice(0, 40);
    setHistory(nextHistory);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(nextHistory));
    try {
      const response = await devicesClient.runCommand(targets, "shell", command);
      const next = rowsFromCommand(desk.devices, checked, response.results);
      setRows(next);
      setLog((prev) => [
        `$ ${command}`,
        ...next.map((row) => `${row.deviceName} ${row.state === "ok" ? "✓" : row.state === "skipped" ? "—" : "✕"} ${row.detail ?? ""}`),
        ...prev,
      ].slice(0, 80));
    } catch (error) {
      setRows([
        {
          deviceId: "shell",
          deviceName: "Shell",
          state: "error",
          detail: error instanceof Error ? error.message : "Failed",
        },
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <PanelFrame title="Developer" panel="developer">
      <div className="flex gap-2">
        {(
          [
            ["shell", "ADB Shell"],
            ["logs", "Logs"],
            ["info", "Device Information"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={tab === id}
            className={`h-11 rounded-lg px-3 text-sm ${tab === id ? "bg-[var(--pc-accent-fill)] text-white" : "border border-[var(--pc-line)]"}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "shell" && (
        <form
          className="flex flex-col gap-3"
          data-shell
          onSubmit={(event) => {
            event.preventDefault();
            void run();
          }}
        >
          <TextField label="Command" value={command} onChange={setCommand} placeholder="dumpsys battery" />
          <label className="text-sm">
            History
            <select
              className="mt-1 h-11 w-full rounded-lg border px-2 font-mono text-xs"
              value=""
              onChange={(event) => {
                if (event.target.value) setCommand(event.target.value);
              }}
            >
              <option value="">Recent commands</option>
              {history.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <TargetChecks devices={desk.devices} checked={checked} onChange={setChecked} />
          <PrimaryButton type="submit" disabled={busy}>
            RUN
          </PrimaryButton>
          <ResultList rows={rows} />
          <pre data-shell-log className="overflow-x-auto rounded-xl bg-[var(--pc-frame)] p-3 font-mono text-xs text-white">
            {log.join("\n") || "$"}
          </pre>
        </form>
      )}
      {tab === "logs" && (
        <ul data-session-logs className="flex flex-col gap-2 font-mono text-xs">
          {desk.devices.map((device) => {
            const session = desk.sessions.get(device.serial);
            return (
              <li key={device.id} className="rounded-lg border border-[var(--pc-line)] p-2">
                <span className="font-semibold">{device.name}</span> {session?.stream ?? device.status}
                <p className="text-[var(--pc-muted)]">{session?.note || "No session note yet."}</p>
              </li>
            );
          })}
        </ul>
      )}
      {tab === "info" && desk.activeDevice && (
        <button type="button" className="h-11 self-start text-sm text-[var(--pc-accent)]" onClick={() => desk.open("manage", "info", desk.activeDevice?.id)}>
          Open {desk.activeDevice.name} information
        </button>
      )}
    </PanelFrame>
  );
}
