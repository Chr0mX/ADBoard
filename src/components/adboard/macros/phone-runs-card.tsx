"use client";

import { Pause, Play, Square } from "lucide-react";
import type { Device } from "@/lib/devices/types";
import type { MacroTab } from "@/lib/macro/core";
import { assignMacro, useAssignments } from "@/lib/macro/assignments";
import {
  pausePhone,
  phoneRun,
  phoneStartError,
  resumePhone,
  startPhone,
  stopAllRuns,
  stopPhone,
  useRunVersion,
  type PhoneRun,
} from "@/lib/macro/runs";
import { cn } from "@/lib/utils";
import { Card, GhostButton } from "@/components/adboard/macros/fields";

const STATUS_TONE: Record<string, string> = {
  running: "text-[var(--pc-accent)]",
  paused: "text-[var(--pc-muted)]",
  stopping: "text-[var(--pc-muted)]",
  done: "text-[var(--pc-signal)]",
  stopped: "text-[var(--pc-muted)]",
  failed: "text-[var(--pc-warn)]",
};

const playable = (tab: MacroTab | undefined) => Boolean(tab && tab.steps.some((s) => s.enabled));

/**
 * One row per phone: its own macro, Start / Pause / Stop and live status.
 * Each phone's run lives on the agent and is independent of every other
 * phone, so stopping or unplugging one never touches the rest.
 */
export function PhoneRunsCard({ tabs, devices, compact = false }: { tabs: MacroTab[]; devices: Device[]; compact?: boolean }) {
  useRunVersion();
  const assignments = useAssignments();
  const tabOf = (deviceId: string) => tabs.find((t) => t.id === assignments[deviceId]);
  const startable = devices.filter((d) => d.status === "online" && !phoneRun(d.id)?.live && playable(tabOf(d.id)));
  const live = devices.filter((d) => phoneRun(d.id)?.live);

  return (
    <Card
      title="Phones"
      data-macro-phones
      action={
        <div className="flex items-center gap-1">
          <GhostButton
            disabled={startable.length === 0}
            onClick={() => startable.forEach((d) => void startPhone(d, tabOf(d.id)!))}
            data-macro-phones-start-all
          >
            <Play className="size-4" aria-hidden />
            Start all
          </GhostButton>
          <GhostButton disabled={live.length === 0} onClick={() => stopAllRuns()} data-macro-phones-stop-all>
            <Square className="size-4" aria-hidden />
            Stop all
          </GhostButton>
        </div>
      }
    >
      {!compact && (
        <p className="text-xs text-[var(--pc-muted)]">
          Pick a macro for each phone. Every phone runs on its own on ADBoard: it keeps going when this browser closes, and
          stopping or disconnecting one phone leaves the others running. Runs end if ADBoard itself is closed.
        </p>
      )}
      {devices.length === 0 && <p className="text-xs text-[var(--pc-muted)]">No phones connected.</p>}
      <ul className="flex flex-col gap-2">
        {devices.map((device) => (
          <PhoneRow key={device.id} device={device} tabs={tabs} tab={tabOf(device.id)} assigned={assignments[device.id] ?? ""} run={phoneRun(device.id)} />
        ))}
      </ul>
    </Card>
  );
}

function PhoneRow({
  device,
  tabs,
  tab,
  assigned,
  run,
}: {
  device: Device;
  tabs: MacroTab[];
  tab: MacroTab | undefined;
  assigned: string;
  run: PhoneRun | null;
}) {
  const online = device.status === "online";
  const live = Boolean(run?.live);
  const error = phoneStartError(device.id);
  const missing = assigned !== "" && !tab;
  return (
    <li
      className="flex flex-col gap-1.5 rounded-xl border border-[var(--pc-line)] p-2"
      data-macro-phone={device.name}
      data-phone-id={device.id}
      data-state={live ? run!.status : run ? run.status : "idle"}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-[var(--pc-ink)]">{device.name}</span>
        <span className={cn("font-mono text-[10px] uppercase", online ? "text-[var(--pc-signal)]" : "text-[var(--pc-muted)]")}>
          {device.status}
        </span>
        <select
          aria-label={`Macro for ${device.name}`}
          className="ml-auto h-9 min-w-0 max-w-[12rem] flex-1 rounded-lg border border-[var(--pc-line)] bg-[var(--pc-panel)] px-2 text-sm text-[var(--pc-ink)]"
          value={tab ? tab.id : ""}
          disabled={live}
          onChange={(event) => assignMacro(device.id, event.target.value || null)}
          data-macro-phone-select
        >
          <option value="">{missing ? "(deleted macro)" : "No macro"}</option>
          {tabs.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-center gap-2">
        {live ? (
          <>
            <button
              type="button"
              className="pc-toggle pc-toggle-md flex-1 gap-2"
              aria-pressed={run!.paused}
              disabled={run!.status === "stopping"}
              onClick={() => (run!.paused ? resumePhone(device.id) : pausePhone(device.id))}
              data-macro-phone-pause={run!.paused ? "paused" : "running"}
            >
              {run!.paused ? <Play className="size-4" aria-hidden /> : <Pause className="size-4" aria-hidden />}
              {run!.paused ? "Resume" : "Pause"}
            </button>
            <button
              type="button"
              onClick={() => stopPhone(device.id)}
              disabled={run!.status === "stopping"}
              className="inline-flex h-11 min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-[var(--pc-warn)] px-4 text-sm font-semibold text-[#1a0f08] disabled:opacity-70"
              data-macro-phone-stop
            >
              <Square className="size-4" aria-hidden />
              {run!.status === "stopping" ? "Stopping…" : "Stop"}
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={!online || !playable(tab)}
            onClick={() => tab && void startPhone(device, tab)}
            className="inline-flex h-11 min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-[var(--pc-accent-fill)] px-4 text-sm font-semibold text-white disabled:opacity-50"
            data-macro-phone-start
          >
            <Play className="size-4" aria-hidden />
            {tab ? `Start “${tab.name}”` : "Start"}
          </button>
        )}
      </div>
      {run && (
        <p className="flex flex-wrap gap-x-3 font-mono text-[11px]" data-macro-phone-status={run.status} aria-live="polite">
          <span className={cn("font-semibold uppercase", STATUS_TONE[run.status])}>{run.status}</span>
          <span className="truncate">“{run.tabName}”</span>
          <span>cycle {run.cycle}</span>
          <span>
            step {Math.min(run.stepIndex + 1, run.stepCount)}/{run.stepCount}
          </span>
          <span data-macro-phone-touches={run.touches}>{run.touches} touches</span>
          {run.message && !live && <span className="text-[var(--pc-muted)]">{run.message}</span>}
        </p>
      )}
      {!live && error && (
        <p className="text-xs text-[var(--pc-warn)]" data-macro-phone-error>
          {error}
        </p>
      )}
      {!live && !online && <p className="text-xs text-[var(--pc-muted)]">Offline: connect the phone to start.</p>}
      {!live && online && tab && !playable(tab) && <p className="text-xs text-[var(--pc-muted)]">“{tab.name}” has no enabled steps.</p>}
    </li>
  );
}
