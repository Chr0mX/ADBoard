"use client";

import { useState } from "react";
import { ExternalLink, Play, Square } from "lucide-react";
import { stepKind, stepTouchMs, type MacroTab } from "@/lib/macro/core";
import { setActiveTab, useMacroWorkspace } from "@/lib/macro/store";
import { isRunning, runFor, startRun, stopRun, useRunVersion } from "@/lib/macro/runs";
import type { Device } from "@/lib/devices/types";
import { cn } from "@/lib/utils";
import { useDeskOptional } from "@/components/phone-control/desk/desk-context";
import { IconButton, Segmented, formatMs, stepColor } from "@/components/phone-control/macros/fields";
import { LivePreview } from "@/components/phone-control/macros/preview";
import { PhoneRunsCard } from "@/components/phone-control/macros/phone-runs-card";
import { LoopControl, MacroSyncNote, PauseButton, RunStatus, runLabel } from "@/components/phone-control/macros/macros-panel";

type TargetSource = "control" | "tab";

/**
 * Macros docked next to the phone in Control: pick a tab, run it on the
 * phones you are controlling (or the tab's own phones), watch it live.
 * Editing stays in the Macros section.
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
  const desk = useDeskOptional();
  const tab = workspace.tabs.find((t) => t.id === workspace.activeId) ?? workspace.tabs[0] ?? null;
  const [source, setSource] = useState<TargetSource>("control");
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);

  if (!tab) return null;
  const running = isRunning(tab.id);
  const snapshot = runFor(tab.id);
  const targets = source === "control" ? controlTargets : devices.filter((d) => tab.targetIds.includes(d.id));
  const online = targets.filter((d) => d.status === "online");
  const enabled = tab.steps.filter((s) => s.enabled).length;
  const previewDevice = activeDevice && activeDevice.resolution.width > 0 ? activeDevice : online[0] ?? null;

  return (
    <div className="flex min-w-0 flex-col gap-3" data-macro-dock>
      <label className="flex flex-col gap-1 text-xs text-[var(--pc-muted)]">
        Macro tab
        <select
          value={tab.id}
          onChange={(event) => {
            setActiveTab(event.target.value);
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
      </label>

      <Segmented
        label="Run on"
        name="macro-dock-source"
        value={source}
        onChange={setSource}
        options={[
          { id: "control", label: `Control targets (${controlTargets.length})`, hint: "The phones Selected / Multi / All points at" },
          { id: "tab", label: `Tab's phones (${tab.targetIds.length})`, hint: "The phones ticked in the Macros section" },
        ]}
      />

      <MacroSyncNote />

      <LoopControl tab={tab} disabled={running} />

      {running ? (
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
        <p className="text-xs text-[var(--pc-muted)]">No online phone in {source === "control" ? "the control targets" : "this tab's phones"}.</p>
      )}

      <RunStatus tab={tab} />

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
        onTest={(stepId) => void startRun(tab, targets, stepId)}
      />

      <PhoneRunsCard tabs={workspace.tabs} devices={devices} compact />

      {desk && (
        <button
          type="button"
          onClick={() => desk.open("macros")}
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
                className="flex size-5 shrink-0 items-center justify-center rounded-full font-mono text-[10px] font-bold text-[#071016]"
                style={{ backgroundColor: stepColor(index) }}
              >
                {index + 1}
              </span>
              <span className="min-w-0 truncate text-xs text-[var(--pc-ink)]">
                {step.label || KIND[stepKind(step)]}
                <span className="ml-1.5 font-mono text-[10px] text-[var(--pc-muted)]">
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
