"use client";

import { useState } from "react";
import { ExternalLink, Pause, Play, Square } from "lucide-react";
import { stepKind, stepTouchMs, type MacroTab } from "@/lib/macro/core";
import { setActiveTab, useMacroWorkspace } from "@/lib/macro/store";
import {
  isRunning,
  pausePhone,
  phoneRun,
  phoneStartError,
  resumePhone,
  runFor,
  startPhone,
  startRun,
  stopPhone,
  stopRun,
  useRunVersion,
} from "@/lib/macro/runs";
import { assignMacro, useAssignments } from "@/lib/macro/assignments";
import type { Device } from "@/lib/devices/types";
import { cn } from "@/lib/utils";
import { useDeskOptional } from "@/components/adboard/desk/desk-context";
import { IconButton, Segmented, formatMs, stepColor } from "@/components/adboard/macros/fields";
import { LivePreview } from "@/components/adboard/macros/preview";
import { PhoneRunsCard } from "@/components/adboard/macros/phone-runs-card";
import {
  LoopControl,
  MacroSyncNote,
  PauseButton,
  RunStatus,
  focusMacroPreview,
  runLabel,
} from "@/components/adboard/macros/macros-panel";

type TargetSource = "phone" | "control" | "tab";

const STATUS_TONE: Record<string, string> = {
  running: "text-[var(--pc-accent)]",
  done: "text-[var(--pc-signal)]",
  failed: "text-[var(--pc-warn)]",
};

/**
 * Macros docked next to the phone in Control. Opened from a phone, it is that
 * phone's panel: its own macro (the per-phone choice, so other phones and the
 * Macros page don't move), its live screen and Start / Pause / Stop for it
 * alone. "Control targets" and "Tab's phones" still run a tab on several
 * phones. Editing stays in the Macros section.
 */
export function MacroDock({
  devices,
  controlTargets,
  activeDevice,
}: {
  devices: Device[];
  /** The Control view's current targets (Selected / Multi / All). */
  controlTargets: Device[];
  activeDevice: Device | null;
}) {
  const workspace = useMacroWorkspace();
  useRunVersion();
  const assignments = useAssignments();
  const desk = useDeskOptional();
  const phone = activeDevice;
  const assignedTab = phone ? workspace.tabs.find((t) => t.id === assignments[phone.id]) : undefined;
  const tab = assignedTab ?? workspace.tabs.find((t) => t.id === workspace.activeId) ?? workspace.tabs[0] ?? null;
  const [sourceChoice, setSource] = useState<TargetSource>("phone");
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);

  if (!tab) return null;
  const source: TargetSource = !phone && sourceChoice === "phone" ? "control" : sourceChoice;
  const phoneMode = source === "phone" && phone !== null;
  const run = phone ? phoneRun(phone.id) : null;
  const phoneLive = Boolean(run?.live);
  const tabRunning = isRunning(tab.id);
  const running = phoneMode ? phoneLive : tabRunning;
  const snapshot = runFor(tab.id);
  const targets = source === "control" ? controlTargets : devices.filter((d) => tab.targetIds.includes(d.id));
  const online = phoneMode ? (phone.status === "online" ? [phone] : []) : targets.filter((d) => d.status === "online");
  const enabled = tab.steps.filter((s) => s.enabled).length;
  const previewDevice =
    phone && phone.resolution.width > 0 ? phone : online.find((d) => d.resolution.width > 0) ?? null;
  const startError = phone ? phoneStartError(phone.id) : null;

  const startOnPhone = (stepId?: string) => {
    if (!phone) return;
    // Starting keeps this macro as the phone's choice.
    if (!assignedTab) assignMacro(phone.id, tab.id);
    void startPhone(phone, tab, stepId);
  };

  return (
    <div className="flex min-w-0 flex-col gap-3" data-macro-dock data-macro-dock-phone={phone?.id ?? ""}>
      {phone && (
        <div className="flex items-center gap-2" data-macro-dock-header>
          <span className="font-display text-sm font-semibold text-[var(--pc-ink)]">Macros · {phone.name}</span>
          <span className={cn("font-mono text-[11px] uppercase", phone.status === "online" ? "text-[var(--pc-signal)]" : "text-[var(--pc-muted)]")}>
            {phone.status}
          </span>
        </div>
      )}
      <label className="flex flex-col gap-1 text-xs text-[var(--pc-muted)]">
        {phone ? `Macro for ${phone.name}` : "Macro tab"}
        <select
          value={tab.id}
          disabled={phone !== null && phoneLive}
          onChange={(event) => {
            // From a phone: change only that phone's macro, not the shared tab.
            if (phone) assignMacro(phone.id, event.target.value);
            else setActiveTab(event.target.value);
            setSelectedStepId(null);
          }}
          className="h-11 min-h-11 rounded-xl border border-[var(--pc-line)] bg-[var(--pc-paper)] px-2 text-sm text-[var(--pc-ink)]"
          data-macro-dock-tab
        >
          {workspace.tabs.map((t) => (
            <option key={t.id} value={t.id}>
              {isRunning(t.id) ? "● " : ""}
              {t.name} ({t.steps.length} step{t.steps.length === 1 ? "" : "s"})
            </option>
          ))}
        </select>
        {phone && !assignedTab && <span className="text-[11px]">Not chosen yet: Start keeps it as {phone.name}&apos;s macro.</span>}
      </label>

      <Segmented
        label="Run on"
        name="macro-dock-source"
        value={source}
        onChange={setSource}
        options={[
          ...(phone ? [{ id: "phone" as const, label: `This phone (${phone.name})`, hint: "Only this phone; the others keep their own runs" }] : []),
          { id: "control" as const, label: `Control targets (${controlTargets.length})`, hint: "The phones Selected / Multi / All points at" },
          { id: "tab" as const, label: `Tab's phones (${tab.targetIds.length})`, hint: "The phones ticked in the Macros section" },
        ]}
      />

      <MacroSyncNote />

      <LoopControl tab={tab} disabled={running} />

      {phoneMode ? (
        phoneLive ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="pc-toggle pc-toggle-md flex-1 gap-2"
              aria-pressed={run!.paused}
              disabled={run!.status === "stopping"}
              onClick={() => (run!.paused ? resumePhone(phone.id) : pausePhone(phone.id))}
              data-macro-dock-pause={run!.paused ? "paused" : "running"}
            >
              {run!.paused ? <Play className="size-4" aria-hidden /> : <Pause className="size-4" aria-hidden />}
              {run!.paused ? "Resume" : "Pause"}
            </button>
            <button
              type="button"
              onClick={() => stopPhone(phone.id)}
              disabled={run!.status === "stopping"}
              className="inline-flex h-11 min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-[var(--pc-warn)] px-4 text-sm font-semibold text-[#1a0f08] disabled:opacity-70"
              data-macro-dock-stop
            >
              <Square className="size-4" aria-hidden />
              {run!.status === "stopping" ? "Stopping…" : `Stop on ${phone.name}`}
            </button>
          </div>
        ) : (
          <button
            type="button"
            disabled={online.length === 0 || enabled === 0}
            onClick={() => startOnPhone()}
            className="inline-flex h-11 min-h-11 items-center justify-center gap-2 rounded-xl bg-[var(--pc-accent-fill)] px-4 text-sm font-semibold text-white disabled:opacity-50"
            data-macro-dock-start
          >
            <Play className="size-4" aria-hidden />
            {runLabel(tab, 1).replace(/ on 1 phones?$/, "")} on {phone.name}
          </button>
        )
      ) : tabRunning ? (
        <div className="flex items-center gap-2">
          <PauseButton tabId={tab.id} attr="data-macro-dock-pause" />
          <button
            type="button"
            onClick={() => stopRun(tab.id)}
            disabled={snapshot?.status === "stopping"}
            className="inline-flex h-11 min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-[var(--pc-warn)] px-4 text-sm font-semibold text-[#1a0f08] disabled:opacity-70"
            data-macro-dock-stop
          >
            <Square className="size-4" aria-hidden />
            {snapshot?.status === "stopping" ? "Stopping…" : `Stop “${tab.name}”`}
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={online.length === 0 || enabled === 0}
          onClick={() => void startRun(tab, targets)}
          className="inline-flex h-11 min-h-11 items-center justify-center gap-2 rounded-xl bg-[var(--pc-accent-fill)] px-4 text-sm font-semibold text-white disabled:opacity-50"
          data-macro-dock-start
        >
          <Play className="size-4" aria-hidden />
          {runLabel(tab, online.length)}
        </button>
      )}
      {!running && enabled === 0 && <p className="text-xs text-[var(--pc-muted)]">This tab has no enabled steps.</p>}
      {!running && enabled > 0 && online.length === 0 && (
        <p className="text-xs text-[var(--pc-muted)]">
          {phoneMode ? `${phone.name} is offline.` : `No online phone in ${source === "control" ? "the control targets" : "this tab's phones"}.`}
        </p>
      )}
      {phoneMode && !phoneLive && startError && (
        <p className="text-xs text-[var(--pc-warn)]" data-macro-dock-error>
          {startError}
        </p>
      )}

      {phoneMode ? (
        run && (
          <p className="flex flex-wrap gap-x-3 font-mono text-[11px]" data-macro-dock-status={run.status} aria-live="polite">
            <span className={cn("font-semibold uppercase", STATUS_TONE[run.status] ?? "text-[var(--pc-muted)]")}>{run.status}</span>
            <span className="truncate">“{run.tabName}”</span>
            <span>cycle {run.cycle}</span>
            <span>
              step {Math.min(run.stepIndex + 1, run.stepCount)}/{run.stepCount}
            </span>
            <span data-macro-dock-touches={run.touches}>{run.touches} touches</span>
            {run.message && !phoneLive && <span className="text-[var(--pc-muted)]">{run.message}</span>}
          </p>
        )
      ) : (
        <RunStatus tab={tab} />
      )}

      {previewDevice && (
        <LivePreview
          key={`${tab.id}-${previewDevice.id}`}
          device={previewDevice}
          live={previewDevice.status === "online"}
          tab={tab}
          selectedStepId={selectedStepId}
          placing={false}
          onSelectStep={setSelectedStepId}
          onMoveFinger={() => {}}
          onPlace={() => {}}
          readOnly
        />
      )}

      <DockSteps
        tab={tab}
        selectedStepId={selectedStepId}
        canTest={!running && online.length > 0}
        onSelect={setSelectedStepId}
        onTest={(stepId) => (phoneMode ? startOnPhone(stepId) : void startRun(tab, targets, stepId))}
      />

      <PhoneRunsCard tabs={workspace.tabs} devices={devices} compact />

      {desk && (
        <button
          type="button"
          onClick={() => {
            if (phone) {
              // Open the editor on this phone's macro and live screen.
              setActiveTab(tab.id);
              focusMacroPreview(tab.id, phone.id);
              desk.open("macros", undefined, phone.id);
            } else desk.open("macros");
          }}
          className="inline-flex h-10 items-center justify-center gap-1.5 rounded-xl border border-[var(--pc-line)] text-xs text-[var(--pc-ink)] hover:bg-[var(--pc-accent-soft)]"
          data-macro-dock-edit
        >
          <ExternalLink className="size-3.5" aria-hidden />
          Edit in Macros
        </button>
      )}
    </div>
  );
}

function DockSteps({
  tab,
  selectedStepId,
  canTest,
  onSelect,
  onTest,
}: {
  tab: MacroTab;
  selectedStepId: string | null;
  canTest: boolean;
  onSelect: (id: string | null) => void;
  onTest: (id: string) => void;
}) {
  if (tab.steps.length === 0) return null;
  const KIND = { tap: "Tap", hold: "Hold", swipe: "Swipe", multi: "Multi-touch" } as const;
  return (
    <ol className="flex flex-col gap-1" aria-label="Steps" data-macro-dock-steps>
      {tab.steps.map((step, index) => {
        const selected = step.id === selectedStepId;
        return (
          <li
            key={step.id}
            className={cn(
              "flex items-center gap-1 rounded-xl border bg-[var(--pc-paper)] pl-1",
              selected ? "border-[var(--pc-accent)]" : "border-[var(--pc-line)]",
              !step.enabled && "opacity-50",
            )}
          >
            <button
              type="button"
              aria-pressed={selected}
              onClick={() => onSelect(selected ? null : step.id)}
              className="flex min-h-10 min-w-0 flex-1 items-center gap-2 text-left"
            >
              <span
                className="flex size-5 shrink-0 items-center justify-center rounded-full font-mono text-[11px] font-bold text-[#071016]"
                style={{ backgroundColor: stepColor(index) }}
              >
                {index + 1}
              </span>
              <span className="min-w-0 truncate text-xs text-[var(--pc-ink)]">
                {step.label || KIND[stepKind(step)]}
                <span className="ml-1.5 font-mono text-[11px] text-[var(--pc-muted)]">
                  {step.fingers.length > 1 ? `${step.fingers.length}f · ` : ""}
                  {formatMs(stepTouchMs(step))} · {formatMs(step.delayMs)}
                </span>
              </span>
            </button>
            <IconButton label={`Test step ${index + 1}`} disabled={!canTest} onClick={() => onTest(step.id)} tone="accent">
              <Play className="size-4" aria-hidden />
            </IconButton>
          </li>
        );
      })}
    </ol>
  );
}
