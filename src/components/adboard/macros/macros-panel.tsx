"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { Switch, SwitchRow } from "@/components/ui/switch";
import { useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Crosshair,
  Download,
  Pencil,
  Pause,
  Play,
  Plus,
  Square,
  Trash2,
  Upload,
  History,
} from "lucide-react";
import { saveBlob } from "@/lib/api/download";
import { devicesClient } from "@/lib/api/client";
import {
  MAX_REFERENCE,
  MAX_STEPS,
  MAX_TABS,
  MIN_REFERENCE,
  REFERENCE_PRESETS,
  cycleMs,
  exportAutoClickerFile,
  exportMacroFile,
  fileSafeName,
  orientationMismatch,
  rescaleTab,
  type ImportResult,
  type MacroStep,
  type MacroTab,
  type RunSnapshot,
  type Size,
} from "@/lib/macro/core";
import {
  addTab,
  deleteTab,
  duplicateTab,
  importTabs,
  moveTab,
  patchTab,
  pullMacrosFromAgent,
  restoreWorkspace,
  setActiveTab,
  useMacroWorkspace,
} from "@/lib/macro/store";
import {
  busyPhones,
  forgetRun,
  isPaused,
  isRunning,
  lastStartError,
  pauseRun,
  resumeRun,
  runFor,
  startRun,
  stopRun,
  useRunVersion,
} from "@/lib/macro/runs";
import type { Device } from "@/lib/devices/types";
import { cn } from "@/lib/utils";
import { useDesk } from "@/components/adboard/desk/desk-context";
import { ConfirmDialog, PanelFrame } from "@/components/adboard/desk/bits";
import { Card, GhostButton, IconButton, NumField, Segmented, formatMs } from "@/components/adboard/macros/fields";
import { LivePreview, MacroPreview, type FingerEnd } from "@/components/adboard/macros/preview";
import { AddStepBar, StepList, makeStep } from "@/components/adboard/macros/step-list";
import { ImportDialog } from "@/components/adboard/macros/import-dialog";
import { QueueCard, ScheduleCard } from "@/components/adboard/macros/automation-cards";
import { PhoneRunsCard } from "@/components/adboard/macros/phone-runs-card";
import { readBackups, useSyncStatus } from "@/lib/sync/agent-store";
import { agentBaseUrl, agentFetch } from "@/lib/api/auth";

/** Per-tab view state (selected step, preview screen) survives switching tabs. */
const viewState = new Map<string, { stepId: string | null; previewId: string }>();

/** Open `tabId` previewing `deviceId` next time the Macros page shows it (e.g. "Edit in Macros"). */
export function focusMacroPreview(tabId: string, deviceId: string) {
  viewState.set(tabId, { stepId: viewState.get(tabId)?.stepId ?? null, previewId: deviceId });
}

const hasScreen = (d: Device) => d.resolution.width > 0;

/** The phone to preview first: the one being controlled, else an online ticked phone, else any online phone. */
function defaultPreviewId(tab: MacroTab, devices: Device[], activeDevice: Device | null) {
  if (activeDevice && hasScreen(activeDevice)) return activeDevice.id;
  const online = devices.filter((d) => d.status === "online" && hasScreen(d));
  return (online.find((d) => tab.targetIds.includes(d.id)) ?? online[0])?.id ?? "reference";
}

export function MacrosPanel() {
  const workspace = useMacroWorkspace();
  useRunVersion();
  const desk = useDesk();
  const active = workspace.tabs.find((t) => t.id === workspace.activeId) ?? workspace.tabs[0] ?? null;
  const [pendingImport, setPendingImport] = useState<{ name: string; text: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <PanelFrame title="Macros" panel="macros">
      <MacroSyncNote />
      <TabStrip
        tabs={workspace.tabs}
        activeId={active?.id ?? null}
        onImportFile={(name, text) => setPendingImport({ name, text })}
        onNotice={setNotice}
      />
      {notice && (
        <p role="status" className="flex items-center justify-between gap-2 rounded-xl bg-[var(--pc-accent-soft)] px-3 py-2 text-xs text-[var(--pc-ink)]">
          {notice}
          <button type="button" className="h-8 px-2 text-[var(--pc-accent)]" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </p>
      )}
      {active && <TabWorkspace key={active.id} tab={active} devices={desk.devices} activeDevice={desk.activeDevice} />}
      <PhoneRunsCard tabs={workspace.tabs} devices={desk.devices} />
      <div className="grid gap-3 lg:grid-cols-2" data-macro-automation>
        <QueueCard tabs={workspace.tabs} activeTab={active} />
        <ScheduleCard tabs={workspace.tabs} activeTab={active} />
      </div>
      {pendingImport && (
        <ImportDialog
          fileName={pendingImport.name}
          text={pendingImport.text}
          devices={desk.devices}
          onCancel={() => setPendingImport(null)}
          onImport={(result: ImportResult, mode) => {
            const count = importTabs(result.tabs, mode);
            setPendingImport(null);
            setNotice(
              count === 0
                ? `No room: a browser keeps up to ${MAX_TABS} tabs.`
                : `Imported ${count} tab${count === 1 ? "" : "s"} from ${pendingImport.name}${count < result.tabs.length ? ` (${result.tabs.length - count} did not fit)` : ""}.`,
            );
          }}
        />
      )}
    </PanelFrame>
  );
}

/* ------------------------------------------------------------------ */

function TabStrip({
  tabs,
  activeId,
  onImportFile,
  onNotice,
}: {
  tabs: MacroTab[];
  activeId: string | null;
  onImportFile: (name: string, text: string) => void;
  onNotice: (message: string) => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<MacroTab | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const active = tabs.find((t) => t.id === activeId) ?? null;
  const index = active ? tabs.indexOf(active) : -1;

  const download = (text: string, name: string, type = "application/json") => saveBlob(new Blob([text], { type }), name);

  return (
    <div className="flex flex-col gap-2" data-macro-tabs>
      <div className="flex min-w-0 items-center gap-1.5">
        <div role="tablist" aria-label="Macro tabs" className="flex min-w-0 flex-1 gap-1 overflow-x-auto pb-1">
          {tabs.map((tab) => {
            const selected = tab.id === activeId;
            const running = isRunning(tab.id);
            if (renaming === tab.id) {
              return (
                <input
                  key={tab.id}
                  autoFocus
                  aria-label="Tab name"
                  defaultValue={tab.name}
                  maxLength={60}
                  className="h-10 w-40 shrink-0 rounded-xl border border-[var(--pc-accent)] bg-[var(--pc-paper)] px-2 text-sm text-[var(--pc-ink)] outline-none"
                  onBlur={(event) => {
                    const name = event.target.value.trim();
                    if (name) patchTab(tab.id, (t) => ({ ...t, name }));
                    setRenaming(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                    if (event.key === "Escape") setRenaming(null);
                  }}
                />
              );
            }
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={selected}
                data-macro-tab={tab.name}
                onClick={() => setActiveTab(tab.id)}
                onDoubleClick={() => setRenaming(tab.id)}
                className={cn(
                  "flex h-10 min-h-10 max-w-[12rem] shrink-0 items-center gap-1.5 rounded-xl border px-3 text-sm",
                  selected
                    ? "border-[var(--pc-accent)] bg-[var(--pc-accent-soft)] font-semibold text-[var(--pc-ink)]"
                    : "border-[var(--pc-line)] text-[var(--pc-muted)] hover:text-[var(--pc-ink)]",
                )}
              >
                {running && <span aria-label="running" className="size-2 shrink-0 animate-pulse rounded-full bg-[var(--pc-signal)]" />}
                <span className="truncate">{tab.name}</span>
                <span className="font-mono text-[10px] text-[var(--pc-muted)]">{tab.steps.length}</span>
              </button>
            );
          })}
        </div>
        <IconButton
          label="New tab"
          disabled={tabs.length >= MAX_TABS}
          onClick={() => addTab()}
          className="size-10 border-[var(--pc-line)]"
          data-macro-new-tab
        >
          <Plus className="size-4" aria-hidden />
        </IconButton>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {active && (
          <>
            <GhostButton onClick={() => setRenaming(active.id)}>
              <Pencil className="size-3.5" aria-hidden /> Rename
            </GhostButton>
            <GhostButton disabled={tabs.length >= MAX_TABS} onClick={() => duplicateTab(active.id)} data-macro-duplicate>
              <Copy className="size-3.5" aria-hidden /> Duplicate
            </GhostButton>
            <GhostButton onClick={() => setConfirmDelete(active)} data-macro-delete>
              <Trash2 className="size-3.5" aria-hidden /> Delete
            </GhostButton>
            <IconButton label="Move tab left" disabled={index <= 0} onClick={() => moveTab(active.id, -1)}>
              <ChevronLeft className="size-4" aria-hidden />
            </IconButton>
            <IconButton label="Move tab right" disabled={index < 0 || index >= tabs.length - 1} onClick={() => moveTab(active.id, 1)}>
              <ChevronRight className="size-4" aria-hidden />
            </IconButton>
          </>
        )}
        <span className="ml-auto flex flex-wrap gap-1.5">
          <GhostButton onClick={() => fileRef.current?.click()} data-macro-import-button>
            <Upload className="size-3.5" aria-hidden /> Import
          </GhostButton>
          <input
            ref={fileRef}
            type="file"
            accept=".json,.txt,application/json,text/plain"
            className="sr-only"
            data-macro-file
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              if (file.size > 20 * 1024 * 1024) {
                onNotice(`${file.name} is larger than 20 MB — not a macro file.`);
                return;
              }
              void file.text().then(
                (text) => onImportFile(file.name, text),
                () => onNotice(`Could not read ${file.name}.`),
              );
            }}
          />
          <VersionsMenu onNotice={onNotice} />
          <details className="relative" data-macro-export>
            <summary className="inline-flex h-9 min-h-9 cursor-pointer list-none items-center gap-1.5 rounded-lg border border-[var(--pc-line)] px-2.5 text-xs text-[var(--pc-ink)] hover:bg-[var(--pc-accent-soft)]">
              <Download className="size-3.5" aria-hidden /> Export
            </summary>
            <div className="absolute right-0 z-30 mt-1 flex w-60 flex-col rounded-xl border border-[var(--pc-line)] bg-[var(--pc-paper)] p-1 shadow-lg">
              {[
                { label: "This tab", disabled: !active, run: () => active && download(exportMacroFile([active]), `${fileSafeName(active.name)}.adboard-macros.json`) },
                { label: "All tabs", disabled: tabs.length === 0, run: () => download(exportMacroFile(tabs), "adboard-macros.json") },
                {
                  label: "This tab for Auto Clicker",
                  disabled: !active,
                  run: () => {
                    if (!active) return;
                    const warnings: string[] = [];
                    download(exportAutoClickerFile([active], warnings), `${fileSafeName(active.name)}-autoclicker.txt`, "text/plain");
                    if (warnings.length) onNotice(`${warnings[0]}${warnings.length > 1 ? ` (+${warnings.length - 1} more)` : ""}`);
                  },
                },
                {
                  label: "All tabs for Auto Clicker",
                  disabled: tabs.length === 0,
                  run: () => {
                    const warnings: string[] = [];
                    download(exportAutoClickerFile(tabs, warnings), "autoclicker-config.txt", "text/plain");
                    if (warnings.length) onNotice(`${warnings.length} multi-touch step${warnings.length === 1 ? " was" : "s were"} split into single targets for Auto Clicker.`);
                  },
                },
              ].map((item) => (
                <button
                  key={item.label}
                  type="button"
                  disabled={item.disabled}
                  className="flex h-10 items-center rounded-lg px-2 text-left text-xs text-[var(--pc-ink)] hover:bg-[var(--pc-accent-soft)] disabled:opacity-50"
                  onClick={(event) => {
                    item.run();
                    (event.currentTarget.closest("details") as HTMLDetailsElement | null)?.removeAttribute("open");
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </details>
        </span>
      </div>

      {confirmDelete && (
        <ConfirmDialog
          title={`Delete “${confirmDelete.name}”?`}
          body={
            <>
              Its {confirmDelete.steps.length} step{confirmDelete.steps.length === 1 ? "" : "s"} and settings are removed from this browser.
              {isRunning(confirmDelete.id) ? " It is running and will be stopped." : ""} Export it first to keep a copy.
            </>
          }
          confirmLabel="Delete tab"
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            forgetRun(confirmDelete.id);
            viewState.delete(confirmDelete.id);
            deleteTab(confirmDelete.id);
            setConfirmDelete(null);
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function TabWorkspace({ tab, devices, activeDevice }: { tab: MacroTab; devices: Device[]; activeDevice: Device | null }) {
  const saved = viewState.get(tab.id);
  const [selectedStepId, setSelectedStepIdState] = useState<string | null>(saved?.stepId ?? tab.steps[0]?.id ?? null);
  const [previewId, setPreviewIdState] = useState<string>(() => saved?.previewId ?? defaultPreviewId(tab, devices, activeDevice));
  const [placing, setPlacing] = useState(false);
  const running = isRunning(tab.id);

  const remember = (stepId: string | null, preview: string) => viewState.set(tab.id, { stepId, previewId: preview });
  const setSelectedStepId = (id: string | null) => {
    setSelectedStepIdState(id);
    remember(id, previewId);
  };
  const setPreviewId = (id: string) => {
    setPreviewIdState(id);
    remember(selectedStepId, id);
  };

  const update = (change: (t: MacroTab) => MacroTab) => patchTab(tab.id, change);
  const setSteps = (steps: MacroStep[]) => update((t) => ({ ...t, steps }));

  const previewDevice = devices.find((d) => d.id === previewId && d.resolution.width > 0) ?? null;
  const [live, setLive] = useState(true);
  const targets = devices.filter((d) => tab.targetIds.includes(d.id));

  const moveFinger = (stepId: string, fingerId: string, end: FingerEnd, point: { x: number; y: number }) =>
    setSteps(
      tab.steps.map((s) =>
        s.id !== stepId
          ? s
          : {
              ...s,
              fingers: s.fingers.map((f) =>
                f.id !== fingerId ? f : end === "start" ? { ...f, x: point.x, y: point.y } : { ...f, toX: point.x, toY: point.y },
              ),
            },
      ),
    );

  const previewProps = {
    tab,
    selectedStepId,
    placing,
    onSelectStep: setSelectedStepId,
    onMoveFinger: moveFinger,
    onPlace: (point: { x: number; y: number }) => {
      if (tab.steps.length >= MAX_STEPS) return;
      const step = makeStep("tap", tab, point);
      setSteps([...tab.steps, step]);
      setSelectedStepId(step.id);
    },
  };

  return (
    <div className="@container flex min-w-0 flex-col gap-3" data-macro-workspace={tab.name}>
      <div className="grid min-w-0 gap-3 @3xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="flex min-w-0 flex-col gap-3">
          <Card
            title="Preview"
            action={
              <GhostButton
                aria-pressed={placing}
                onClick={() => setPlacing(!placing)}
                data-macro-place
              >
                <Crosshair className="size-3.5" aria-hidden />
                {placing ? "Click the screen…" : "Click to add"}
              </GhostButton>
            }
          >
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between gap-2 text-xs text-[var(--pc-muted)]">
                <span id={`macro-preview-label-${tab.id}`}>Show on</span>
                {previewDevice && (
                  <label className="pc-choice-row shrink-0 gap-2 border border-[var(--pc-line)] px-3 text-xs">
                    Live
                    <Switch checked={live} onChange={() => setLive(!live)} data-macro-live-toggle aria-label="Live video" />
                  </label>
                )}
              </div>
              <div
                role="group"
                aria-labelledby={`macro-preview-label-${tab.id}`}
                className="flex gap-1.5 overflow-x-auto pb-1"
                data-macro-preview-chips
              >
                {devices.map((d) => {
                  const selected = previewDevice?.id === d.id;
                  return (
                    <button
                      key={d.id}
                      type="button"
                      aria-pressed={selected}
                      disabled={!hasScreen(d)}
                      title={hasScreen(d) ? `${d.name} · ${d.resolution.width}×${d.resolution.height} · ${d.status}` : `${d.name}: screen size unknown`}
                      onClick={() => setPreviewId(d.id)}
                      className={cn(
                        "inline-flex h-9 min-h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs disabled:opacity-40",
                        selected
                          ? "border-[var(--pc-accent)] bg-[var(--pc-accent-soft)] text-[var(--pc-ink)]"
                          : "border-[var(--pc-line)] text-[var(--pc-ink)] hover:bg-[var(--pc-accent-soft)]",
                      )}
                      data-macro-preview-chip={d.id}
                    >
                      <span
                        aria-hidden
                        className={cn("size-1.5 rounded-full", d.status === "online" ? "bg-[var(--pc-signal)]" : "bg-[var(--pc-muted)]")}
                      />
                      <span className="font-medium">{d.name}</span>
                      {d.id === activeDevice?.id && <span className="font-mono text-[10px] text-[var(--pc-muted)]">in Control</span>}
                    </button>
                  );
                })}
                <button
                  type="button"
                  aria-pressed={!previewDevice}
                  onClick={() => setPreviewId("reference")}
                  className={cn(
                    "inline-flex h-9 min-h-9 shrink-0 items-center rounded-full border px-3 text-xs",
                    !previewDevice
                      ? "border-[var(--pc-accent)] bg-[var(--pc-accent-soft)] text-[var(--pc-ink)]"
                      : "border-[var(--pc-line)] text-[var(--pc-muted)] hover:bg-[var(--pc-accent-soft)]",
                  )}
                  data-macro-preview-chip="reference"
                >
                  Reference {tab.reference.width}×{tab.reference.height}
                </button>
              </div>
            </div>
            {previewDevice ? (
              <LivePreview
                key={previewDevice.id}
                device={previewDevice}
                live={live && previewDevice.status === "online"}
                {...previewProps}
              />
            ) : (
              <MacroPreview frame={null} frameLabel="Reference screen" {...previewProps} />
            )}
          </Card>
          <RunCard tab={tab} devices={devices} targets={targets} />
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          <Card
            title={`Steps (${tab.steps.length})`}
            className="@container"
            action={<span className="font-mono text-[10px] text-[var(--pc-muted)]">cycle ≈ {formatMs(cycleMs(tab))}</span>}
          >
            <AddStepBar
              disabled={tab.steps.length >= MAX_STEPS}
              onAdd={(kind) => {
                const step = makeStep(kind, tab);
                setSteps([...tab.steps, step]);
                setSelectedStepId(step.id);
              }}
            />
            <StepList
              tab={tab}
              selectedStepId={selectedStepId}
              canTest={!running && targets.some((d) => d.status === "online")}
              onSelect={setSelectedStepId}
              onChange={setSteps}
              onTest={(stepId) => void startRun(tab, targets, stepId)}
            />
          </Card>
          <SettingsCard tab={tab} devices={devices} onChange={update} />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function SettingsCard({
  tab,
  devices,
  onChange,
}: {
  tab: MacroTab;
  devices: Device[];
  onChange: (change: (t: MacroTab) => MacroTab) => void;
}) {
  const [moveTouches, setMoveTouches] = useState(true);
  const setReference = (next: Size) =>
    onChange((t) => (moveTouches ? rescaleTab(t, next) : { ...t, reference: { ...next } }));
  const preset = REFERENCE_PRESETS.find((p) => p.width === tab.reference.width && p.height === tab.reference.height);

  return (
    <Card title="Settings" data-macro-settings>
      <div className="flex flex-col gap-2 rounded-xl border border-[var(--pc-line)] p-2">
        <p className="text-xs text-[var(--pc-ink)]">Reference screen</p>
        <p className="text-[11px] leading-relaxed text-[var(--pc-muted)]">
          The resolution the touch positions are written in. Each phone gets them scaled to its own screen.
        </p>
        <div className="grid grid-cols-2 gap-2 @lg:grid-cols-[1fr_1fr_minmax(0,1.4fr)]">
          <NumField
            label="Width"
            suffix="px"
            value={tab.reference.width}
            min={MIN_REFERENCE}
            max={MAX_REFERENCE}
            onChange={(width) => setReference({ ...tab.reference, width })}
            data-reference-width
          />
          <NumField
            label="Height"
            suffix="px"
            value={tab.reference.height}
            min={MIN_REFERENCE}
            max={MAX_REFERENCE}
            onChange={(height) => setReference({ ...tab.reference, height })}
            data-reference-height
          />
          <label className="col-span-2 flex min-w-0 flex-col gap-1 text-xs text-[var(--pc-muted)] @lg:col-span-1">
            Preset or phone
            <select
              value={preset ? `${preset.width}x${preset.height}` : ""}
              onChange={(event) => {
                const [w, h] = event.target.value.split("x").map(Number);
                if (w && h) setReference({ width: w, height: h });
              }}
              className="h-11 min-h-11 min-w-0 rounded-xl border border-[var(--pc-line)] bg-[var(--pc-paper)] px-2 text-xs text-[var(--pc-ink)]"
            >
              <option value="">Custom</option>
              <optgroup label="Common">
                {REFERENCE_PRESETS.map((p) => (
                  <option key={`${p.width}x${p.height}`} value={`${p.width}x${p.height}`}>
                    {p.width}×{p.height}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Phones">
                {devices
                  .filter((d) => d.resolution.width > 0)
                  .map((d) => (
                    <option key={d.id} value={`${d.resolution.width}x${d.resolution.height}`}>
                      {d.name} {d.resolution.width}×{d.resolution.height}
                    </option>
                  ))}
              </optgroup>
            </select>
          </label>
        </div>
        <ReferenceDensity tab={tab} devices={devices} onChange={onChange} />
        <SwitchRow
          label="Move touches with the resolution"
          description="Keeps every touch on the same spot when the reference size changes"
          checked={moveTouches}
          onChange={() => setMoveTouches(!moveTouches)}
          className="-mx-2"
        />
      </div>

      <div className="grid gap-2 @lg:grid-cols-2">
        <Segmented
          label="Other screen shapes"
          name={`scale-${tab.id}`}
          value={tab.scale}
          onChange={(scale) => onChange((t) => ({ ...t, scale }))}
          options={[
            { id: "stretch", label: "Stretch", hint: "Same relative spot on every screen" },
            { id: "fit", label: "Keep aspect", hint: "Letterbox the reference screen, centered" },
          ]}
        />
        <Segmented
          label="Other orientation"
          name={`orientation-${tab.id}`}
          value={tab.orientation}
          onChange={(orientation) => onChange((t) => ({ ...t, orientation }))}
          options={[
            { id: "match", label: "Skip phone" },
            { id: "any", label: "Run anyway" },
          ]}
        />
      </div>

      <div className="grid gap-2 @lg:grid-cols-[10rem_minmax(0,1fr)]">
        <NumField
          label="Random offset"
          suffix="px"
          value={tab.jitterPx}
          min={0}
          max={200}
          onChange={(jitterPx) => onChange((t) => ({ ...t, jitterPx }))}
          title="Moves each touch by up to this many reference pixels (Auto Clicker anti-detection)"
        />
        <label className="flex min-w-0 flex-col gap-1 text-xs text-[var(--pc-muted)]">
          Notes
          <textarea
            value={tab.notes}
            maxLength={2000}
            rows={2}
            onChange={(event) => onChange((t) => ({ ...t, notes: event.target.value }))}
            className="min-h-11 rounded-xl border border-[var(--pc-line)] bg-[var(--pc-paper)] px-2 py-2 text-xs text-[var(--pc-ink)] outline-none focus-visible:border-[var(--pc-accent)]"
          />
        </label>
      </div>
      {tab.source && tab.source.kind !== "adboard" && (
        <p className="font-mono text-[10px] text-[var(--pc-muted)]">
          Imported from {tab.source.kind === "autoclicker" ? "Auto Clicker" : "ADBoard Automate"}
          {tab.source.file ? ` · ${tab.source.file}` : ""}
        </p>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */

const STATE_LABEL: Record<string, string> = {
  waiting: "Waiting",
  ok: "Touching",
  stub: "Mock (not sent)",
  error: "Failed",
  skipped: "Skipped",
  busy: "Busy",
};

/** Wall clock that ticks while `active`, for elapsed / remaining time. */
function useNow(active: boolean) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!active) return;
    const tick = () => setNow(Date.now());
    const timer = setInterval(tick, 500);
    const first = setTimeout(tick, 0);
    return () => {
      clearInterval(timer);
      clearTimeout(first);
    };
  }, [active]);
  return now;
}

function RunCard({ tab, devices, targets }: { tab: MacroTab; devices: Device[]; targets: Device[] }) {
  useRunVersion();
  const running = isRunning(tab.id);
  const snapshot: RunSnapshot | null = runFor(tab.id);
  const busy = busyPhones(tab.id);
  const onlineTargets = targets.filter((d) => d.status === "online");
  const enabled = tab.steps.filter((s) => s.enabled).length;

  const toggleTarget = (id: string) =>
    patchTab(tab.id, (t) => ({
      ...t,
      targetIds: t.targetIds.includes(id) ? t.targetIds.filter((x) => x !== id) : [...t.targetIds, id],
    }));


  return (
    <Card title="Run" data-macro-run>
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 flex w-full items-center justify-between text-xs text-[var(--pc-muted)]">
          Phones for this tab
          <button
            type="button"
            className="h-8 px-1 text-[var(--pc-accent)]"
            onClick={() =>
              patchTab(tab.id, (t) => ({ ...t, targetIds: devices.filter((d) => d.status === "online").map((d) => d.id) }))
            }
          >
            All online
          </button>
        </legend>
        {devices.length === 0 && <p className="text-xs text-[var(--pc-muted)]">No phones connected.</p>}
        {devices.map((device) => {
          const checked = tab.targetIds.includes(device.id);
          const otherTab = busy[device.id];
          const mismatch = tab.orientation === "match" && orientationMismatch(tab.reference, device.resolution);
          return (
            <label key={device.id} className="pc-choice-row" aria-disabled={running || undefined}>
              <Checkbox checked={checked} disabled={running} onChange={() => toggleTarget(device.id)} data-macro-target={device.name} />
              <span className="font-medium">{device.name}</span>
              <span className="font-mono text-[10px] text-[var(--pc-muted)]">
                {device.resolution.width}×{device.resolution.height}
              </span>
              <span
                className={cn(
                  "ml-auto font-mono text-[10px] uppercase",
                  device.status === "online" ? "text-[var(--pc-signal)]" : "text-[var(--pc-muted)]",
                )}
              >
                {otherTab ? `in “${otherTab}”` : mismatch ? "other orientation" : device.status}
              </span>
            </label>
          );
        })}
      </fieldset>

      <LoopControl tab={tab} disabled={running} />

      <div className="flex items-center gap-2">
        {running && <PauseButton tabId={tab.id} />}
        {running ? (
          <button
            type="button"
            onClick={() => stopRun(tab.id)}
            disabled={snapshot?.status === "stopping"}
            className="inline-flex h-11 min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-[var(--pc-warn)] px-4 text-sm font-semibold text-[#1a0f08] disabled:opacity-70"
            data-macro-stop
          >
            <Square className="size-4" aria-hidden />
            {snapshot?.status === "stopping" ? "Stopping…" : "Stop"}
          </button>
        ) : (
          <button
            type="button"
            disabled={onlineTargets.length === 0 || enabled === 0}
            onClick={() => void startRun(tab, targets)}
            className="inline-flex h-11 min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-[var(--pc-accent-fill)] px-4 text-sm font-semibold text-white disabled:opacity-50"
            data-macro-start
          >
            <Play className="size-4" aria-hidden />
            {runLabel(tab, onlineTargets.length)}
          </button>
        )}
      </div>
      {!running && lastStartError?.tabId === tab.id && (
        <p className="text-xs text-[var(--pc-warn)]" data-macro-start-error>
          {lastStartError.message}
        </p>
      )}
      {!running && (onlineTargets.length === 0 || enabled === 0) && (
        <p className="text-xs text-[var(--pc-muted)]">
          {enabled === 0 ? "Add or enable a step to run." : "Tick at least one online phone."}
        </p>
      )}

      <RunStatus tab={tab} />
    </Card>
  );
}

/**
 * Density the macro was made at. Touch positions only scale with resolution,
 * but games lay out their buttons in dp: a phone at the same resolution and
 * another density shows them elsewhere. "Match phones" sets both.
 */
function ReferenceDensity({
  tab,
  devices,
  onChange,
}: {
  tab: MacroTab;
  devices: Device[];
  onChange: (change: (tab: MacroTab) => MacroTab) => void;
}) {
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dpi = tab.referenceDpi;
  const phones = devices.filter((d) => tab.targetIds.includes(d.id) && d.status === "online");
  const match = async () => {
    if (!dpi || phones.length === 0) return;
    setBusy(true);
    try {
      const result = await devicesClient.runCommand(phones, "displaySize", `${tab.reference.width}x${tab.reference.height}@${dpi}`);
      const failed = result.results.filter((r) => !r.ok);
      setNote(
        failed.length === 0
          ? `${phones.length} phone${phones.length === 1 ? "" : "s"} set to ${tab.reference.width}×${tab.reference.height} @ ${dpi} dpi`
          : failed.map((r) => `${r.deviceName}: ${r.error || "failed"}`).join(" · "),
      );
    } catch (error) {
      setNote(error instanceof Error ? error.message : "Could not set the screen");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-1.5" data-macro-dpi>
      <div className="flex flex-wrap items-end gap-2">
        <NumField
          label="Made at density"
          suffix="dpi"
          value={dpi ?? 0}
          min={0}
          max={640}
          onChange={(value) =>
            onChange((t) => {
              const next = { ...t };
              if (value >= 120 && value <= 640) next.referenceDpi = Math.round(value);
              else delete next.referenceDpi;
              return next;
            })
          }
          data-reference-dpi
        />
        <button
          type="button"
          className="pc-toggle pc-toggle-md"
          disabled={!dpi || phones.length === 0 || busy}
          onClick={() => void match()}
          title="Set this tab's phones to the reference resolution and density (wm size + wm density)"
          data-macro-match-screen
        >
          Match phones to {tab.reference.width}×{tab.reference.height}
          {dpi ? ` @ ${dpi}` : ""}
        </button>
      </div>
      <p className="text-[11px] leading-relaxed text-[var(--pc-muted)]">
        {dpi
          ? `Made for ${tab.reference.width}×${tab.reference.height} @ ${dpi} dpi. Touches scale with resolution; matching the density keeps game buttons where the macro expects them.`
          : "Optional: the dpi of the screen the macro was made on (e.g. 320 for a 900×1600 emulator). 0 = not set."}
      </p>
      {note && <p className="font-mono text-[10px] text-[var(--pc-muted)]" data-macro-dpi-note>{note}</p>}
    </div>
  );
}

/**
 * Earlier versions of the macros: the agent keeps the last 20 saves, and this
 * browser keeps its own copy whenever another copy replaced it. Restoring is
 * itself a new version, so it can be undone too.
 */
function VersionsMenu({ onNotice }: { onNotice: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [agent, setAgent] = useState<Array<{ rev: number; savedAt: number; items: number }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const backups = open ? readBackups("macros") : [];
  const base = agentBaseUrl();

  const load = async () => {
    setError(null);
    if (base === null) return;
    try {
      const res = await agentFetch(`${base}/api/store/macros/history`, { cache: "no-store" });
      setAgent(res.ok ? ((await res.json()) as Array<{ rev: number; savedAt: number; items: number }>) : []);
    } catch {
      setError("ADBoard is not reachable");
    }
  };
  const when = (ms: number) => (ms ? new Date(ms).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "earlier");
  const tabsIn = (value: unknown) => {
    const tabs = (value as { tabs?: unknown[] } | null)?.tabs;
    return Array.isArray(tabs) ? tabs.length : 0;
  };

  return (
    <details
      className="relative"
      data-macro-versions
      open={open}
      onToggle={(event) => {
        const next = (event.currentTarget as HTMLDetailsElement).open;
        setOpen(next);
        if (next) void load();
      }}
    >
      <summary className="inline-flex h-9 min-h-9 cursor-pointer list-none items-center gap-1.5 rounded-lg border border-[var(--pc-line)] px-2.5 text-xs text-[var(--pc-ink)] hover:bg-[var(--pc-accent-soft)]">
        <History className="size-3.5" aria-hidden /> Versions
      </summary>
      {open && (
        <div className="absolute right-0 z-30 mt-1 flex max-h-80 w-72 flex-col overflow-y-auto rounded-xl border border-[var(--pc-line)] bg-[var(--pc-paper)] p-1 shadow-lg">
          <p className="px-2 py-1 font-mono text-[10px] uppercase text-[var(--pc-muted)]">Saved on ADBoard</p>
          {error && <p className="px-2 py-1 text-xs text-[var(--pc-warn)]">{error}</p>}
          {agent?.length === 0 && <p className="px-2 py-1 text-xs text-[var(--pc-muted)]">No earlier versions yet.</p>}
          {agent?.map((entry) => (
            <button
              key={`a-${entry.rev}`}
              type="button"
              data-macro-version={entry.rev}
              className="flex h-10 items-center justify-between gap-2 rounded-lg px-2 text-left text-xs text-[var(--pc-ink)] hover:bg-[var(--pc-accent-soft)]"
              onClick={() => {
                void (async () => {
                  const res = await agentFetch(`${base}/api/store/macros/restore`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ rev: entry.rev }),
                  });
                  if (res.ok) {
                    await pullMacrosFromAgent();
                    onNotice(`Restored the version from ${when(entry.savedAt)} (${entry.items} tab${entry.items === 1 ? "" : "s"}).`);
                  } else onNotice("Could not restore that version.");
                  setOpen(false);
                })();
              }}
            >
              <span>{when(entry.savedAt)}</span>
              <span className="font-mono text-[10px] text-[var(--pc-muted)]">{entry.items} tabs · restore</span>
            </button>
          ))}
          <p className="mt-1 px-2 py-1 font-mono text-[10px] uppercase text-[var(--pc-muted)]">Kept in this browser</p>
          {backups.length === 0 && <p className="px-2 py-1 text-xs text-[var(--pc-muted)]">None.</p>}
          {backups.map((backup) => (
            <button
              key={`b-${backup.at}`}
              type="button"
              data-macro-backup={backup.at}
              className="flex h-10 items-center justify-between gap-2 rounded-lg px-2 text-left text-xs text-[var(--pc-ink)] hover:bg-[var(--pc-accent-soft)]"
              onClick={() => {
                restoreWorkspace(backup.value);
                onNotice(`Restored this browser's copy from ${when(backup.at)}.`);
                setOpen(false);
              }}
            >
              <span>{when(backup.at)}</span>
              <span className="font-mono text-[10px] text-[var(--pc-muted)]">{tabsIn(backup.value)} tabs · restore</span>
            </button>
          ))}
        </div>
      )}
    </details>
  );
}

/** Where macros are kept: shared through the agent, or only in this browser. */
export function MacroSyncNote() {
  const status = useSyncStatus("macros");
  if (status.state === "pending") return null;
  const text =
    status.state === "shared"
      ? "Shared with every browser on this ADBoard · runs keep going on the phones when a browser closes"
      : status.message ?? "Saved in this browser only";
  return (
    <p
      data-macro-sync={status.state}
      className={cn("font-mono text-[10px]", status.state === "conflict" ? "text-[var(--pc-warn)]" : "text-[var(--pc-muted)]")}
    >
      {text}
    </p>
  );
}

/** Pause before the next step / Resume. Shared by the Macros panel and dock. */
export function PauseButton({ tabId, attr = "data-macro-pause" }: { tabId: string; attr?: string }) {
  useRunVersion();
  const paused = isPaused(tabId);
  const stopping = runFor(tabId)?.status === "stopping";
  return (
    <button
      type="button"
      className="pc-toggle pc-toggle-md flex-1 gap-2"
      aria-pressed={paused}
      disabled={stopping}
      title={paused ? "Resume from the next step" : "Pause before the next step (phones stay reserved)"}
      onClick={() => (paused ? resumeRun(tabId) : pauseRun(tabId))}
      {...{ [attr]: paused ? "paused" : "running" }}
    >
      {paused ? <Play className="size-4" aria-hidden /> : <Pause className="size-4" aria-hidden />}
      {paused ? "Resume" : "Pause"}
    </button>
  );
}

/** Cycle / step / touches and each phone's state for a tab's current or last run. */
export function RunStatus({ tab }: { tab: MacroTab }) {
  useRunVersion();
  const running = isRunning(tab.id);
  const now = useNow(running);
  const snapshot: RunSnapshot | null = runFor(tab.id);
  if (!snapshot) return null;
  const elapsed = Math.max(0, ((snapshot.finishedAt ?? now) - snapshot.startedAt) / 1000);
  const cycles =
    tab.stop.mode === "cycles"
      ? `${snapshot.cycle}/${tab.stop.cycles}`
      : tab.stop.mode === "infinite"
        ? `${snapshot.cycle} · ∞ until stopped`
        : `${snapshot.cycle}`;
  return (
    <>
        <div className="flex flex-col gap-2" data-macro-status={snapshot.status} aria-live="polite">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-[var(--pc-ink)]">
            <span className="font-semibold uppercase">{snapshot.status}</span>
            <span>cycle {cycles}</span>
            <span>
              step {Math.min(snapshot.stepIndex + 1, snapshot.stepCount)}/{snapshot.stepCount}
            </span>
            <span>{snapshot.touches} touches</span>
            <span>{elapsed.toFixed(0)} s</span>
            {snapshot.deadline && running && <span>{Math.max(0, Math.ceil((snapshot.deadline - Math.max(now, snapshot.startedAt)) / 1000))} s left</span>}
          </div>
          {snapshot.stepCount > 0 && (
            <div className="h-1.5 overflow-hidden rounded-full bg-[var(--pc-line)]">
              <div
                className="h-full bg-[var(--pc-accent)] transition-[width]"
                style={{ width: `${((snapshot.stepIndex + 1) / snapshot.stepCount) * 100}%` }}
              />
            </div>
          )}
          {snapshot.message && <p className="text-xs text-[var(--pc-muted)]">{snapshot.message}</p>}
          <ul className="flex flex-col gap-0.5 font-mono text-[11px]" data-macro-devices>
            {Object.entries(snapshot.devices).map(([id, row]) => (
              <li key={id} className="flex items-baseline gap-2" data-macro-device={row.name} data-state={row.state}>
                <span className="w-24 shrink-0 truncate text-[var(--pc-ink)]">{row.name}</span>
                <span
                  className={cn(
                    row.state === "ok" && "text-[var(--pc-signal)]",
                    row.state === "error" && "text-[var(--pc-warn)]",
                    (row.state === "skipped" || row.state === "busy" || row.state === "stub") && "text-[var(--pc-muted)]",
                  )}
                >
                  {STATE_LABEL[row.state] ?? row.state}
                  {row.detail && row.state !== "ok" ? ` · ${row.detail}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
    </>
  );
}

/** "Run forever on 3 phones" / "Run ×10 on 3 phones" / "Run for 5 min on 3 phones". */
export function runLabel(tab: MacroTab, phones: number) {
  const on = `on ${phones} phone${phones === 1 ? "" : "s"}`;
  if (tab.stop.mode === "infinite") return `Run forever ${on}`;
  if (tab.stop.mode === "time") return `Run for ${formatMs(tab.stop.seconds * 1000)} ${on}`;
  return `Run ×${tab.stop.cycles} ${on}`;
}

/** How long a tab plays: loop forever, a number of cycles, or a time limit. */
export function LoopControl({ tab, disabled }: { tab: MacroTab; disabled?: boolean }) {
  const setStop = (patch: Partial<MacroTab["stop"]>) => patchTab(tab.id, (t) => ({ ...t, stop: { ...t.stop, ...patch } }));
  return (
    <div className={cn("flex flex-col gap-2", disabled && "pointer-events-none opacity-60")} data-macro-loop={tab.stop.mode} aria-disabled={disabled || undefined}>
      <Segmented
        label="Repeat"
        name={`loop-${tab.id}`}
        value={tab.stop.mode}
        onChange={(mode) => setStop({ mode })}
        options={[
          { id: "infinite", label: "Loop forever", hint: "Repeat all steps until you press Stop" },
          { id: "cycles", label: "Cycles", hint: "Play all steps this many times" },
          { id: "time", label: "For time", hint: "Repeat until the time is up" },
        ]}
      />
      {tab.stop.mode === "cycles" && (
        <NumField
          label="Cycles"
          suffix="×"
          value={tab.stop.cycles}
          min={1}
          max={1_000_000}
          onChange={(cycles) => setStop({ cycles })}
          data-stop-cycles
        />
      )}
      {tab.stop.mode === "time" && (
        <NumField
          label="Seconds"
          suffix="s"
          value={tab.stop.seconds}
          min={1}
          max={86_400 * 7}
          onChange={(seconds) => setStop({ seconds })}
          data-stop-seconds
        />
      )}
    </div>
  );
}
