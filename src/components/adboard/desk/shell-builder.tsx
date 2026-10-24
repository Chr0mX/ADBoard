"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Copy, Crosshair, Play, Square, Trash2 } from "lucide-react";
import {
  ACTIONS,
  CATEGORIES,
  MECHANISM_LABEL,
  actionOf,
  copyStep,
  newStep,
  summarizeStep,
  touchGeometry,
  validateStep,
  type FieldDef,
  type Mechanism,
} from "@/lib/desk/actions";
import { runMacro, type MacroProgress, type StepLog } from "@/lib/desk/run-macro";
import { MACRO_FOLDERS, getLibrary, newId, updateLibrary, useLibrary, type MacroStep, type MacroStepKind, type SavedMacro } from "@/lib/desk/store";
import type { Device } from "@/lib/devices/types";
import { cn } from "@/lib/utils";
import { readUiState, writeUiState } from "@/lib/ui-state";
import { UNTITLED_SCRIPT, uniqueName } from "@/lib/adboard-files";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { useDesk } from "@/components/adboard/desk/desk-context";
import { ConfirmDialog, PrimaryButton, TargetChecks, TextField, picked, useChecked } from "@/components/adboard/desk/bits";
import { Card, GhostButton, IconButton, stepColor } from "@/components/adboard/macros/fields";
import { ShellPreview, type PointEnd } from "@/components/adboard/desk/shell-preview";

const LOG_LIMIT = 500;

export function MechanismBadge({ mechanism }: { mechanism: Mechanism }) {
  const info = MECHANISM_LABEL[mechanism];
  return (
    <span
      title={info.hint}
      data-mechanism={mechanism}
      className={cn(
 "inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 font-mono text-[11px] font-semibold tracking-wider",
        mechanism === "touch" && "bg-[var(--pc-accent-soft)] text-[var(--pc-accent)]",
        mechanism === "shell" && "bg-[color-mix(in_srgb,#ffb86b_18%,transparent)] text-[#ffb86b]",
        mechanism === "key" && "bg-[color-mix(in_srgb,#c3a6ff_18%,transparent)] text-[#c3a6ff]",
        mechanism === "file" && "bg-[color-mix(in_srgb,#7cc4ff_18%,transparent)] text-[#7cc4ff]",
        mechanism === "wait" && "bg-[var(--pc-line)] text-[var(--pc-muted)]",
      )}
    >
      {info.label}
    </span>
  );
}

/** Steps grouped by category for the Add picker (recorded touches are made in Control). */
export function ActionPicker({ value, onChange, id }: { value: MacroStepKind; onChange: (kind: MacroStepKind) => void; id?: string }) {
  return (
    <select
      id={id}
      value={value}
      onChange={(event) => onChange(event.target.value as MacroStepKind)}
      className="h-11 min-h-11 min-w-0 flex-1 rounded-xl border border-[var(--pc-line)] bg-[var(--pc-panel)] px-2 text-sm text-[var(--pc-ink)]"
      data-shell-add-kind
    >
      {CATEGORIES.map((category) => (
        <optgroup key={category} label={category}>
          {ACTIONS.filter((a) => a.category === category && !a.recordedOnly).map((a) => (
            <option key={a.kind} value={a.kind}>
              {a.label} · {MECHANISM_LABEL[a.mechanism].label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

function errorCount(steps: MacroStep[]) {
  return steps.filter((s) => s.enabled !== false && Object.keys(validateStep(s)).length > 0).length;
}

export function ShellBuilder({
  macro,
  focusStepId,
  onCreate,
}: {
  macro: SavedMacro | null;
  /** Select this step when the Builder opens (e.g. just added from the Library). */
  focusStepId: string | null;
  onCreate: (macro: SavedMacro) => void;
}) {
  if (!macro) return <CreateJob onCreate={onCreate} />;
  return <JobEditor key={macro.id} macro={macro} focusStepId={focusStepId} />;
}

function CreateJob({ onCreate }: { onCreate: (macro: SavedMacro) => void }) {
  const library = useLibrary();
  const [name, setName] = useState("");
  const [folder, setFolder] = useState<string>("Custom");
  const folders = [...new Set<string>([...MACRO_FOLDERS, ...library.macros.map((m) => m.folder || "Custom")])];
  return (
    <form
      className="flex flex-wrap items-end gap-2 rounded-2xl border border-[var(--pc-line)] p-3"
      data-macro-builder
      onSubmit={(event) => {
        event.preventDefault();
        const unique = uniqueName(name, getLibrary().macros.map((m) => m.name), UNTITLED_SCRIPT);
        const created: SavedMacro = { id: newId("macro"), name: unique, folder, steps: [] };
        updateLibrary((current) => ({ ...current, macros: [...current.macros, created] }));
        onCreate(created);
      }}
    >
      <TextField label="Job name" value={name} onChange={setName} placeholder="Morning restart" />
      <label className="flex flex-col gap-1 text-sm text-[var(--pc-ink)]">
        Folder
        <select value={folder} onChange={(event) => setFolder(event.target.value)} className="h-11 min-h-11 rounded-xl border border-[var(--pc-line)] bg-[var(--pc-panel)] px-2 text-sm">
          {folders.map((item) => (
            <option key={item}>{item}</option>
          ))}
        </select>
      </label>
      <PrimaryButton type="submit">Create job</PrimaryButton>
      <p className="w-full text-xs text-[var(--pc-muted)]">Or open a saved job from the Library.</p>
    </form>
  );
}

const BUILDER_KEY = "adboard-shell-builder";
interface BuilderView {
  jobs: Record<string, { selectedStepId: string | null; previewId: string | null; live: boolean }>;
  targets: string[];
  parallel: boolean;
}

function JobEditor({ macro, focusStepId }: { macro: SavedMacro; focusStepId: string | null }) {
  const desk = useDesk();
  const library = useLibrary();
  const devices = desk.devices;
  // Selected step, preview phone, Live, run targets and parallel are remembered
  // per job (builder_state.json), so a reload reopens the editor as it was.
  const [saved] = useState(() => readUiState<BuilderView>(BUILDER_KEY, { jobs: {}, targets: [], parallel: true }));
  const savedJob = saved.jobs?.[macro.id];
  const savedStep = macro.steps.some((s) => s.id === savedJob?.selectedStepId) ? savedJob!.selectedStepId : null;
  const savedTargets = devices.filter((d) => saved.targets?.includes(d.id));
  const [selectedStepId, setSelectedStepId] = useState<string | null>(focusStepId ?? savedStep ?? macro.steps[0]?.id ?? null);
  const [addKind, setAddKind] = useState<MacroStepKind>("tap");
  const [placing, setPlacing] = useState<PointEnd | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(savedJob?.previewId ?? null);
  const [live, setLive] = useState(savedJob?.live ?? true);
  const [checked, setChecked] = useChecked(devices, desk.targets.length > 0 ? desk.targets : savedTargets);
  const [parallel, setParallel] = useState(saved.parallel ?? true);
  useEffect(() => {
    const current = readUiState<BuilderView>(BUILDER_KEY, { jobs: {}, targets: [], parallel: true });
    writeUiState(BUILDER_KEY, {
      jobs: { ...current.jobs, [macro.id]: { selectedStepId, previewId, live } },
      targets: [...checked],
      parallel,
    });
  }, [macro.id, selectedStepId, previewId, live, checked, parallel]);
  const [progress, setProgress] = useState<Record<string, MacroProgress>>({});
  const [logs, setLogs] = useState<StepLog[]>([]);
  const [running, setRunning] = useState(false);
  const [confirm, setConfirm] = useState<{ title: string; body: string; run: () => void } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const devicesRef = useRef(devices);
  useEffect(() => {
    devicesRef.current = devices;
  }, [devices]);

  const steps = macro.steps;
  const selectedIndex = steps.findIndex((s) => s.id === selectedStepId);
  const selected = selectedIndex >= 0 ? steps[selectedIndex] : null;
  const withScreen = (d: Device | null | undefined) => (d && d.resolution.width > 0 ? d : null);
  const previewDevice =
    devices.find((d) => d.id === previewId) ??
    withScreen(desk.activeDevice) ??
    withScreen(devices.find((d) => checked.has(d.id) && d.status === "online")) ??
    withScreen(devices.find((d) => d.status === "online")) ??
    devices[0] ??
    null;
  const targets = picked(devices, checked);
  const invalid = errorCount(steps);

  const patchJob = (change: (job: SavedMacro) => SavedMacro) =>
    updateLibrary((current) => ({ ...current, macros: current.macros.map((m) => (m.id === macro.id ? change(m) : m)) }));
  const setSteps = (next: MacroStep[]) => patchJob((job) => ({ ...job, steps: next }));
  const patchStep = (id: string, change: Partial<MacroStep>) => setSteps(steps.map((s) => (s.id === id ? { ...s, ...change } : s)));

  const addStep = () => {
    const step = newStep(addKind);
    const at = selectedIndex >= 0 ? selectedIndex + 1 : steps.length;
    setSteps([...steps.slice(0, at), step, ...steps.slice(at)]);
    setSelectedStepId(step.id);
    setPlacing(touchGeometry(step) ? "start" : null);
  };
  const move = (index: number, delta: -1 | 1) => {
    const to = index + delta;
    if (to < 0 || to >= steps.length) return;
    const next = [...steps];
    [next[index], next[to]] = [next[to], next[index]];
    setSteps(next);
  };

  const start = (opts: { onlyStepId?: string; devices: Device[] }) => {
    const controller = new AbortController();
    controllerRef.current = controller;
    setRunning(true);
    setProgress({});
    if (!opts.onlyStepId) setLogs([]);
    const final = new Map<string, MacroProgress>();
    void runMacro({
      macro,
      devices: opts.devices,
      parallel,
      variables: library.variables,
      deviceVariables: library.deviceVariables,
      profiles: library.profiles,
      signal: controller.signal,
      onlyStepId: opts.onlyStepId,
      isOnline: (id) => devicesRef.current.find((d) => d.id === id)?.status === "online",
      onProgress: (item) => {
        final.set(item.deviceId, item);
        setProgress((prev) => ({ ...prev, [item.deviceId]: item }));
      },
      onLog: (entry) => setLogs((prev) => [...prev, entry].slice(-LOG_LIMIT)),
    }).finally(() => {
      setRunning(false);
      controllerRef.current = null;
      if (opts.onlyStepId) return;
      updateLibrary((current) => ({
        ...current,
        history: [
          {
            id: newId("run"),
            macroId: macro.id,
            macroName: macro.name,
            at: Date.now(),
            parallel,
            results: [...final.values()].map((item) => ({
              deviceId: item.deviceId,
              deviceName: item.deviceName,
              status: item.status,
              detail: item.detail ?? (item.status === "failed" ? `step ${item.step}` : undefined),
            })),
          },
          ...current.history,
        ].slice(0, 30),
      }));
    });
  };

  /** Ask first when the run restarts or powers off phones. */
  const guarded = (runSteps: MacroStep[], names: string, run: () => void) => {
    const dangerous = runSteps.filter((s) => s.enabled !== false && actionOf(s.kind)?.dangerous);
    if (dangerous.length === 0) return run();
    setConfirm({
      title: "Restart or power off phones?",
      body: `${dangerous.map((s) => actionOf(s.kind)?.label).join(", ")} will run on ${names}.`,
      run,
    });
  };

  const runAll = () => {
    setNotice(null);
    if (invalid > 0) return setNotice(`Fix ${invalid} step${invalid === 1 ? "" : "s"} marked in red first.`);
    if (targets.length === 0) return setNotice("Tick at least one phone.");
    guarded(steps, targets.map((d) => d.name).join(", "), () => start({ devices: targets }));
  };
  const testStep = (step: MacroStep) => {
    setNotice(null);
    if (!previewDevice) return setNotice("No phone to test on.");
    if (Object.keys(validateStep(step)).length > 0) return setNotice("Fix this step's fields first.");
    if (previewDevice.status !== "online") return setNotice(`${previewDevice.name} is offline.`);
    guarded([step], previewDevice.name, () => start({ onlyStepId: step.id, devices: [previewDevice] }));
  };

  const previewProgress = previewDevice ? progress[previewDevice.id] : undefined;
  const runningStepId = previewProgress?.status === "running" ? steps[previewProgress.step - 1]?.id ?? null : null;
  const tagNames = [...new Set(Object.values(library.tags).flat())];

  return (
    <div className="@container flex min-w-0 flex-col gap-3" data-macro-builder data-job={macro.name}>
      <JobHeader macro={macro} onPatch={patchJob} />
      <div className="grid min-w-0 gap-3 @3xl:grid-cols-[minmax(240px,5fr)_minmax(0,7fr)]">
        {/* Live preview */}
        <div className="flex min-w-0 flex-col gap-3 @3xl:sticky @3xl:top-0 @3xl:self-start">
          <Card
            title="Live preview"
            action={
              previewDevice && (
                <label className="pc-choice-row shrink-0 gap-2 border border-[var(--pc-line)] px-3 text-xs">
                  Live
                  <Switch checked={live} onChange={() => setLive(!live)} aria-label="Live video" data-shell-live-toggle />
                </label>
              )
            }
          >
            <div role="group" aria-label="Preview phone" className="flex gap-1.5 overflow-x-auto pb-1" data-shell-preview-chips>
              {devices.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  aria-pressed={previewDevice?.id === d.id}
                  disabled={d.resolution.width <= 0}
                  onClick={() => setPreviewId(d.id)}
                  className={cn(
                    "inline-flex h-9 min-h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs disabled:opacity-40",
                    previewDevice?.id === d.id ? "border-[var(--pc-accent)] bg-[var(--pc-accent-soft)]" : "border-[var(--pc-line)]",
                  )}
                  data-shell-preview-chip={d.id}
                >
                  <span aria-hidden className={cn("size-1.5 rounded-full", d.status === "online" ? "bg-[var(--pc-signal)]" : "bg-[var(--pc-muted)]")} />
                  {d.name}
                </button>
              ))}
            </div>
            {previewDevice ? (
              <>
                {previewDevice.status !== "online" && (
                  <p className="rounded-lg bg-[var(--pc-warn-soft)] px-2 py-1.5 text-xs text-[var(--pc-warn)]">{previewDevice.name} is offline: no live picture, and steps can&apos;t run on it.</p>
                )}
                <ShellPreview
                  key={previewDevice.id}
                  device={previewDevice}
                  live={live && previewDevice.status === "online"}
                  steps={steps}
                  selectedStepId={selectedStepId}
                  placing={placing}
                  runningStepId={runningStepId}
                  onSelectStep={setSelectedStepId}
                  onMovePoint={(stepId, end, point) =>
                    patchStep(stepId, end === "start" ? { x: point.x, y: point.y } : { x2: point.x, y2: point.y })
                  }
                />
                {selected && touchGeometry(selected) && (
                  <div className="flex flex-wrap gap-2">
                    <GhostButton aria-pressed={placing === "start"} onClick={() => setPlacing(placing === "start" ? null : "start")} data-shell-place="start">
                      <Crosshair className="size-3.5" aria-hidden />
                      {placing === "start" ? "Click the screen…" : `Set step ${selectedIndex + 1} ${selected.kind === "pinch" ? "centre" : "position"}`}
                    </GhostButton>
                    {(selected.kind === "swipe" || selected.kind === "drag") && (
                      <GhostButton aria-pressed={placing === "end"} onClick={() => setPlacing(placing === "end" ? null : "end")} data-shell-place="end">
                        <Crosshair className="size-3.5" aria-hidden />
                        {placing === "end" ? "Click the screen…" : "Set end"}
                      </GhostButton>
                    )}
                  </div>
                )}
                <p className="text-[11px] text-[var(--pc-muted)]">
                  Numbers match the step order. Drag a marker, or select a touch step and click the screen. Positions are percent of the phone&apos;s screen, so they land in the same place on every phone.
                </p>
              </>
            ) : (
              <p className="text-xs text-[var(--pc-muted)]">No phones connected.</p>
            )}
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          {/* Steps */}
          <Card title={`Steps (${steps.length})`} data-shell-steps>
            {steps.length === 0 && <p className="text-xs text-[var(--pc-muted)]">No steps yet. Pick an action below, or add one from the Library.</p>}
            <ol className="flex flex-col gap-1.5">
              {steps.map((step, index) => (
                <StepRow
                  key={step.id}
                  step={step}
                  index={index}
                  count={steps.length}
                  selected={step.id === selectedStepId}
                  running={running}
                  status={logStatus(logs, index + 1, previewDevice?.id)}
                  testOn={previewDevice?.name ?? null}
                  onSelect={() => {
                    setSelectedStepId(step.id === selectedStepId ? null : step.id);
                    setPlacing(null);
                  }}
                  onPatch={(change) => patchStep(step.id, change)}
                  onMove={(delta) => move(index, delta)}
                  onDuplicate={() => {
                    const copy = copyStep(step);
                    setSteps([...steps.slice(0, index + 1), copy, ...steps.slice(index + 1)]);
                    setSelectedStepId(copy.id);
                  }}
                  onDelete={() => {
                    setSteps(steps.filter((s) => s.id !== step.id));
                    if (selectedStepId === step.id) setSelectedStepId(null);
                  }}
                  onTest={() => testStep(step)}
                />
              ))}
            </ol>
            <div className="flex flex-wrap items-center gap-2 border-t border-[var(--pc-line)] pt-3">
              <label htmlFor="shell-add-kind" className="text-xs text-[var(--pc-muted)]">
                Add
              </label>
              <ActionPicker id="shell-add-kind" value={addKind} onChange={setAddKind} />
              <PrimaryButton onClick={addStep}>{selected ? `Add after ${selectedIndex + 1}` : "Add step"}</PrimaryButton>
              <p className="w-full text-[11px] text-[var(--pc-muted)]">{actionOf(addKind)?.description}</p>
            </div>
          </Card>

          {/* Run */}
          <Card title="Run" data-macro-run>
            <TargetChecks devices={devices} checked={checked} onChange={setChecked} />
            {tagNames.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-[var(--pc-muted)]">Add by tag</span>
                {tagNames.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    className="h-9 rounded-full border border-[var(--pc-line)] px-2 text-xs"
                    onClick={() => {
                      const next = new Set(checked);
                      for (const [deviceId, tags] of Object.entries(library.tags)) if (tags.includes(tag)) next.add(deviceId);
                      setChecked(next);
                    }}
                  >
                    #{tag}
                  </button>
                ))}
              </div>
            )}
            <fieldset className="flex flex-col gap-1">
              <legend className="mb-1 text-xs text-[var(--pc-muted)]">Several phones</legend>
              <div className="pc-segmented max-w-sm" role="radiogroup" aria-label="Execution">
                <label className="pc-segment">
                  <input type="radio" name={`mode-${macro.id}`} className="sr-only" checked={parallel} onChange={() => setParallel(true)} />
                  At the same time
                </label>
                <label className="pc-segment">
                  <input type="radio" name={`mode-${macro.id}`} className="sr-only" checked={!parallel} onChange={() => setParallel(false)} />
                  One after another
                </label>
              </div>
            </fieldset>
            <div className="flex flex-wrap items-center gap-2">
              {running ? (
                <button
                  type="button"
                  onClick={() => controllerRef.current?.abort()}
                  className="inline-flex h-11 min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-[var(--pc-warn)] px-4 text-sm font-semibold text-[#1a0f08]"
                  data-shell-stop
                >
                  <Square className="size-4" aria-hidden />
                  Stop
                </button>
              ) : (
                <button
                  type="button"
                  onClick={runAll}
                  disabled={steps.length === 0}
                  className="inline-flex h-11 min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-[var(--pc-accent-fill)] px-4 text-sm font-semibold text-white disabled:opacity-50"
                  data-shell-run
                >
                  <Play className="size-4" aria-hidden />
                  Run on {targets.length} phone{targets.length === 1 ? "" : "s"}
                  {(macro.repeat ?? 1) > 1 ? ` ×${macro.repeat}` : ""}
                </button>
              )}
            </div>
            {notice && (
              <p role="status" className="text-xs text-[var(--pc-warn)]" data-shell-notice>
                {notice}
              </p>
            )}
            <p className="text-[11px] text-[var(--pc-muted)]">Runs from this page: keep it open until the job ends.</p>
            <ul data-macro-progress className="flex flex-col gap-2">
              {devices
                .filter((d) => progress[d.id] || checked.has(d.id))
                .map((device) => {
                  const item = progress[device.id];
                  const ratio = item && item.total > 0 ? Math.min(1, item.step / item.total) : 0;
                  const label = !item
                    ? device.status === "online"
                      ? "Ready"
                      : "Offline"
                    : item.status === "done"
                      ? "Completed ✓"
                      : item.status === "failed"
                        ? `Step ${item.step} failed${item.detail ? `: ${item.detail}` : ""}`
                        : item.status === "skipped"
                          ? `Skipped${item.detail ? ` (${item.detail})` : ""}`
                          : item.status === "stopped"
                            ? `Stopped at step ${item.step}`
                            : `Step ${item.step}/${item.total}`;
                  return (
                    <li key={device.id} data-shell-progress={device.id} data-status={item?.status ?? "idle"}>
                      <div className="flex justify-between gap-2 font-mono text-xs">
                        <span>{device.name}</span>
                        <span className={cn("truncate", item?.status === "failed" && "text-[var(--pc-warn)]", item?.status === "done" && "text-[var(--pc-signal)]")}>{label}</span>
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded bg-[var(--pc-line)]">
                        <div className="h-full bg-[var(--pc-accent)] transition-[width]" style={{ width: `${ratio * 100}%` }} />
                      </div>
                    </li>
                  );
                })}
            </ul>
            <RunLog logs={logs} steps={steps} onClear={() => setLogs([])} />
          </Card>
        </div>
      </div>
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          body={confirm.body}
          confirmLabel="Run"
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const run = confirm.run;
            setConfirm(null);
            run();
          }}
        />
      )}
    </div>
  );
}

/** The latest log status of a step on the preview phone, for the row's status dot. */
function logStatus(logs: StepLog[], step: number, deviceId: string | undefined) {
  for (let i = logs.length - 1; i >= 0; i -= 1) {
    if (logs[i].step === step && (!deviceId || logs[i].deviceId === deviceId)) return logs[i];
  }
  return null;
}

function JobHeader({ macro, onPatch }: { macro: SavedMacro; onPatch: (change: (job: SavedMacro) => SavedMacro) => void }) {
  return (
    <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-[var(--pc-line)] bg-[var(--pc-panel)] p-3" data-shell-job-header>
      <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-[var(--pc-muted)]">
        Job
        <input
          value={macro.name}
          onChange={(event) => onPatch((job) => ({ ...job, name: event.target.value }))}
          onBlur={(event) => {
            // No blank names, and no two scripts with the same name (their files would clash).
            const others = getLibrary().macros.filter((m) => m.id !== macro.id).map((m) => m.name);
            const unique = uniqueName(event.target.value, others, UNTITLED_SCRIPT);
            if (unique !== event.target.value) onPatch((job) => ({ ...job, name: unique }));
          }}
          className="h-11 min-h-11 rounded-xl border border-[var(--pc-line)] bg-[var(--pc-paper)] px-2 font-display text-base font-semibold text-[var(--pc-ink)]"
          data-shell-job-name
        />
      </label>
      <label className="flex w-28 flex-col gap-1 text-xs text-[var(--pc-muted)]">
        Repeat job
        <input
          type="number"
          min={1}
          max={10000}
          value={macro.repeat ?? 1}
          onChange={(event) => onPatch((job) => ({ ...job, repeat: Math.max(1, Math.min(10000, Math.round(Number(event.target.value) || 1))) }))}
          className="h-11 min-h-11 rounded-xl border border-[var(--pc-line)] bg-[var(--pc-paper)] px-2 font-mono text-sm text-[var(--pc-ink)]"
          data-shell-repeat
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-[var(--pc-muted)]">
        If a step fails
        <select
          value={macro.onError ?? "stop"}
          onChange={(event) => onPatch((job) => ({ ...job, onError: event.target.value as SavedMacro["onError"] }))}
          className="h-11 min-h-11 rounded-xl border border-[var(--pc-line)] bg-[var(--pc-paper)] px-2 text-sm text-[var(--pc-ink)]"
          data-shell-on-error
        >
          <option value="stop">Stop that phone</option>
          <option value="continue">Note it and go on</option>
        </select>
      </label>
    </div>
  );
}

function StepRow({
  step,
  index,
  count,
  selected,
  running,
  status,
  testOn,
  onSelect,
  onPatch,
  onMove,
  onDuplicate,
  onDelete,
  onTest,
}: {
  step: MacroStep;
  index: number;
  count: number;
  selected: boolean;
  running: boolean;
  status: StepLog | null;
  testOn: string | null;
  onSelect: () => void;
  onPatch: (change: Partial<MacroStep>) => void;
  onMove: (delta: -1 | 1) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onTest: () => void;
}) {
  const action = actionOf(step.kind);
  const errors = validateStep(step);
  const broken = Object.keys(errors).length > 0;
  const off = step.enabled === false;
  return (
    <li
      className={cn(
        "flex flex-col rounded-xl border bg-[var(--pc-paper)]",
        selected ? "border-[var(--pc-accent)]" : broken && !off ? "border-[var(--pc-warn)]" : "border-[var(--pc-line)]",
        off && "opacity-60",
      )}
      data-shell-step={index + 1}
      data-kind={step.kind}
      data-invalid={broken || undefined}
      data-last-status={status?.status ?? ""}
    >
      <div className="flex min-w-0 items-center gap-1 pl-2">
        <Checkbox checked={!off} onChange={() => onPatch({ enabled: off })} aria-label={`Step ${index + 1} on`} data-shell-step-enabled />
        <button type="button" aria-expanded={selected} onClick={onSelect} className="flex min-h-12 min-w-0 flex-1 items-center gap-2 py-1 text-left">
          <span
            className={cn(
              "flex size-6 shrink-0 items-center justify-center rounded-full font-mono text-[11px] font-bold",
              touchGeometry(step) ? "text-[#071016]" : "border border-[var(--pc-line)] text-[var(--pc-ink)]",
            )}
            style={touchGeometry(step) ? { backgroundColor: stepColor(index) } : undefined}
            title={touchGeometry(step) ? "Shown on the live preview with this number" : undefined}
          >
            {index + 1}
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="flex min-w-0 items-center gap-1.5 text-sm text-[var(--pc-ink)]">
              <span className="truncate">{action?.label ?? `Unsupported: ${step.kind}`}</span>
              {action && <MechanismBadge mechanism={action.mechanism} />}
              {status && (
                <span
                  className={cn(
 "font-mono text-[11px] ",
                    status.status === "ok" && "text-[var(--pc-signal)]",
                    status.status === "failed" && "text-[var(--pc-warn)]",
                    (status.status === "skipped" || status.status === "stopped") && "text-[var(--pc-muted)]",
                  )}
                  title={status.detail}
                >
                  {status.status === "ok" ? "✓" : status.status}
                </span>
              )}
            </span>
            <span className="truncate font-mono text-[11px] text-[var(--pc-muted)]">
              {summarizeStep(step)}
              {step.delayAfterMs ? ` · then ${step.delayAfterMs} ms` : ""}
              {broken && !off ? " · needs fixing" : ""}
            </span>
          </span>
        </button>
        <IconButton label={testOn ? `Test step ${index + 1} on ${testOn}` : "No phone to test on"} disabled={running || !testOn || off} onClick={onTest} tone="accent" data-shell-test={index + 1}>
          <Play className="size-4" aria-hidden />
        </IconButton>
        <IconButton label={`Move step ${index + 1} up`} disabled={index === 0} onClick={() => onMove(-1)}>
          <ArrowUp className="size-4" aria-hidden />
        </IconButton>
        <IconButton label={`Move step ${index + 1} down`} disabled={index === count - 1} onClick={() => onMove(1)}>
          <ArrowDown className="size-4" aria-hidden />
        </IconButton>
        <IconButton label={`Duplicate step ${index + 1}`} onClick={onDuplicate}>
          <Copy className="size-4" aria-hidden />
        </IconButton>
        <IconButton label={`Delete step ${index + 1}`} onClick={onDelete} tone="danger" data-shell-delete={index + 1}>
          <Trash2 className="size-4" aria-hidden />
        </IconButton>
      </div>
      {selected && <StepEditor step={step} errors={errors} onPatch={onPatch} />}
    </li>
  );
}

function StepEditor({
  step,
  errors,
  onPatch,
}: {
  step: MacroStep;
  errors: ReturnType<typeof validateStep>;
  onPatch: (change: Partial<MacroStep>) => void;
}) {
  const action = actionOf(step.kind);
  return (
    <div className="flex flex-col gap-2 border-t border-[var(--pc-line)] p-3" data-shell-editor>
      {action ? (
        <p className="text-xs text-[var(--pc-muted)]">
          {action.description} <span className="italic">{MECHANISM_LABEL[action.mechanism].hint}.</span>
        </p>
      ) : (
        <p className="text-xs text-[var(--pc-warn)]">This step type is not supported and fails when run. Delete it or replace it.</p>
      )}
      {errors.step && <p className="text-xs text-[var(--pc-warn)]">{errors.step}</p>}
      <div className="grid gap-2 sm:grid-cols-2">
        {action?.fields.map((field) => (
          <StepField key={field.key} field={field} step={step} error={errors[field.key]} onPatch={onPatch} />
        ))}
        <label className="flex flex-col gap-1 text-xs text-[var(--pc-muted)]">
          Pause after (ms)
          <input
            type="number"
            min={0}
            max={3600000}
            value={step.delayAfterMs ?? ""}
            placeholder="0"
            onChange={(event) => onPatch({ delayAfterMs: event.target.value === "" ? undefined : Math.max(0, Number(event.target.value)) })}
            className="h-11 min-h-11 rounded-xl border border-[var(--pc-line)] bg-[var(--pc-panel)] px-2 font-mono text-xs text-[var(--pc-ink)]"
            data-shell-field="delayAfterMs"
          />
        </label>
      </div>
      {action?.dangerous && <p className="text-xs text-[var(--pc-warn)]">Runs ask for confirmation before this step.</p>}
    </div>
  );
}

function StepField({
  field,
  step,
  error,
  onPatch,
}: {
  field: FieldDef;
  step: MacroStep;
  error?: string;
  onPatch: (change: Partial<MacroStep>) => void;
}) {
  const raw = step[field.key as keyof MacroStep] as string | number | undefined;
  const numeric = field.type === "percent" || field.type === "ms";
  const id = `field-${step.id}-${field.key}`;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs text-[var(--pc-muted)]">
        {field.label}
        {field.optional ? " (optional)" : ""}
      </label>
      {field.type === "select" ? (
        <select
          id={id}
          value={String(raw ?? field.options?.[0]?.value ?? "")}
          onChange={(event) => onPatch({ [field.key]: event.target.value } as Partial<MacroStep>)}
          className="h-11 min-h-11 rounded-xl border border-[var(--pc-line)] bg-[var(--pc-panel)] px-2 text-sm text-[var(--pc-ink)]"
          data-shell-field={field.key}
        >
          {field.options?.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={id}
          type={numeric ? "number" : "text"}
          step={field.type === "percent" ? 0.1 : undefined}
          min={numeric ? 0 : undefined}
          max={field.type === "percent" ? 100 : undefined}
          inputMode={field.type === "number" ? "numeric" : undefined}
          value={raw ?? ""}
          placeholder={field.placeholder}
          aria-invalid={Boolean(error)}
          onChange={(event) => {
            const value = event.target.value;
            onPatch({ [field.key]: numeric ? (value === "" ? undefined : Number(value)) : value } as Partial<MacroStep>);
          }}
          className={cn(
            "h-11 min-h-11 rounded-xl border bg-[var(--pc-panel)] px-2 font-mono text-xs text-[var(--pc-ink)]",
            error ? "border-[var(--pc-warn)]" : "border-[var(--pc-line)]",
          )}
          data-shell-field={field.key}
        />
      )}
      {error ? <span className="text-[11px] text-[var(--pc-warn)]">{error}</span> : field.help ? <span className="text-[11px] text-[var(--pc-muted)]">{field.help}</span> : null}
    </div>
  );
}

function RunLog({ logs, steps, onClear }: { logs: StepLog[]; steps: MacroStep[]; onClear: () => void }) {
  const [failedOnly, setFailedOnly] = useState(false);
  const shown = useMemo(() => (failedOnly ? logs.filter((l) => l.status === "failed") : logs), [logs, failedOnly]);
  const failed = logs.filter((l) => l.status === "failed").length;
  return (
    <section className="flex flex-col gap-2 border-t border-[var(--pc-line)] pt-3" data-shell-log>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-[var(--pc-ink)]">
          Log <span className="font-mono text-[11px] text-[var(--pc-muted)]">{logs.length} entries{failed ? ` · ${failed} failed` : ""}</span>
        </h4>
        <div className="flex items-center gap-2">
          <label className="pc-choice-row gap-2 text-xs">
            <Checkbox checked={failedOnly} onChange={() => setFailedOnly(!failedOnly)} />
            Failures only
          </label>
          <GhostButton onClick={onClear} disabled={logs.length === 0}>
            Clear
          </GhostButton>
        </div>
      </div>
      {shown.length === 0 ? (
        <p className="text-xs text-[var(--pc-muted)]">{logs.length === 0 ? "Each step's result appears here when you run or test." : "No failures."}</p>
      ) : (
        <ol className="flex max-h-72 flex-col gap-1 overflow-y-auto font-mono text-[11px]">
          {shown.map((entry, n) => (
            <li
              key={`${entry.at}-${entry.deviceId}-${entry.step}-${n}`}
              className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 rounded-lg px-2 py-1 odd:bg-[var(--pc-panel)]"
              data-shell-log-entry={entry.step}
              data-status={entry.status}
            >
              <span className="text-[var(--pc-muted)]">{new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
              <span className="min-w-0">
                <span className={cn(entry.status === "ok" && "text-[var(--pc-signal)]", entry.status === "failed" && "text-[var(--pc-warn)]", (entry.status === "skipped" || entry.status === "stopped") && "text-[var(--pc-muted)]")}>
                  {entry.status.toUpperCase()}
                </span>{" "}
                {entry.deviceName} · step {entry.step}
                {entry.cycle > 1 ? ` (run ${entry.cycle})` : ""} · {actionOf(entry.kind)?.label ?? entry.kind}
                {steps[entry.step - 1]?.kind !== entry.kind ? " (edited since)" : ""}
                {entry.detail && <span className="block whitespace-pre-wrap break-words text-[var(--pc-muted)]">{entry.detail}</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
