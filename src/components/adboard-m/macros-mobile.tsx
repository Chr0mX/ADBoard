"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, Copy, Crosshair, Download, MoreHorizontal, Pencil, Play, Plus, Search, Square, Trash2, Undo2 } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { saveTextFile } from "@/lib/api/download";
import { UNTITLED_MACRO, macroFileName, uniqueName } from "@/lib/adboard-files";
import { MAX_STEPS, MAX_TABS, MAX_GROUP_LENGTH, cleanGroup, cycleMs, exportMacroFile, stepKind, type ImportResult, type MacroStep, type MacroTab } from "@/lib/macro/core";
import { UNGROUPED, buildLibrary, groupNames, parseSort } from "@/lib/macro/groups";
import { createPlaceHistory } from "@/lib/macro/place-history";
import { addTab, deleteTab, duplicateTab, importTabs, moveTab, patchTab, setActiveTab, useMacroWorkspace } from "@/lib/macro/store";
import { forgetRun, isPaused, isRunning, runFor, runningTabIds, startRun, stopAllRuns, stopRun, useRunVersion } from "@/lib/macro/runs";
import { cn } from "@/lib/utils";
import type { Device } from "@/lib/devices/types";
import { useStoredString } from "@/hooks/use-stored-flag";
import { useDesk } from "@/components/adboard/desk/desk-context";
import { ConfirmDialog } from "@/components/adboard/desk/bits";
import { FolderHint } from "@/components/adboard/desk/data-storage";
import { BottomSheet } from "@/components/adboard-m/bottom-sheet";
import { formatMs } from "@/components/adboard/macros/fields";
import { ImportDialog } from "@/components/adboard/macros/import-dialog";
import { QueueCard, ScheduleCard } from "@/components/adboard/macros/automation-cards";
import { PhoneRunsCard } from "@/components/adboard/macros/phone-runs-card";
import { LivePreview, MacroPreview, type FingerEnd } from "@/components/adboard/macros/preview";
import { AddStepBar, StepList, makeStep } from "@/components/adboard/macros/step-list";
import {
  ExportMenu,
  ImportButton,
  MacroSyncNote,
  PauseButton,
  RunCard,
  SettingsCard,
  VersionsMenu,
  defaultPreviewId,
  forgetMacroView,
  getMacroView,
  hasScreen,
  runLabel,
  setMacroView,
} from "@/components/adboard/macros/macros-panel";

/*
 * Phone Macros: a searchable list first, one macro at a time after that.
 * A macro opens with its Run controls on top and its sections (Steps, Run,
 * Settings, Queue, Phones) as tabs. "Edit on the phone screen" opens the
 * whole phone as a canvas to place steps. Everything reuses the cards of the
 * desktop and old phone layouts, so runs, queue, schedules, import, export and
 * versions behave as before.
 */

const SORT_KEY = "adboard-macro-sort";
const COLLAPSED_KEY = "adboard-macro-collapsed";
const SECTIONS = [
  ["steps", "Steps"],
  ["run", "Run"],
  ["settings", "Settings"],
  ["automation", "Queue"],
  ["phones", "Phones"],
] as const;
type Section = (typeof SECTIONS)[number][0];

function parseCollapsed(raw: string | null): Set<string> {
  try {
    const value = JSON.parse(raw ?? "[]") as unknown;
    return new Set(Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

const btn = "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-[var(--pc-line)] bg-[var(--pc-panel)] px-3 text-sm text-[var(--pc-ink)] disabled:opacity-50";

export function MacrosMobile() {
  const workspace = useMacroWorkspace();
  useRunVersion();
  const desk = useDesk();
  const tabs = workspace.tabs;
  const active = tabs.find((t) => t.id === workspace.activeId) ?? tabs[0] ?? null;
  const [view, setView] = useState<"list" | "editor">("list");
  const [query, setQuery] = useState("");
  const [storedSort, setStoredSort] = useStoredString(SORT_KEY);
  const sort = parseSort(storedSort);
  const [storedCollapsed, setStoredCollapsed] = useStoredString(COLLAPSED_KEY);
  const collapsed = useMemo(() => parseCollapsed(storedCollapsed), [storedCollapsed]);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingImport, setPendingImport] = useState<{ name: string; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<MacroTab | null>(null);
  const library = useMemo(() => buildLibrary(tabs, query, sort), [tabs, query, sort]);
  const effectiveCollapsed = query.trim() ? new Set<string>() : collapsed;
  const running = runningTabIds();

  const toggleGroup = (key: string) => {
    const next = new Set(collapsed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setStoredCollapsed(JSON.stringify([...next]));
  };
  const create = () => {
    const created = addTab({ name: UNTITLED_MACRO, ...(active?.group ? { group: active.group } : {}) });
    if (created) {
      setQuery("");
      setView("editor");
    }
  };

  return (
    <section data-desk-panel="macros" data-m-macros className="pc-clean flex min-h-0 min-w-0 flex-1 flex-col gap-3">
      {view === "editor" && active ? (
        <Editor
          key={active.id}
          tab={active}
          tabs={tabs}
          devices={desk.devices}
          activeDevice={desk.activeDevice}
          canReorder={sort === "manual"}
          onBack={() => setView("list")}
          onNotice={setNotice}
          onDelete={() => setConfirmDelete(active)}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pb-2" data-m-macros-list>
          <label className="relative block">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-[var(--pc-muted)]" aria-hidden />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search macros"
              aria-label="Search macros"
              className="h-11 w-full rounded-xl border border-[var(--pc-line)] bg-[var(--pc-panel)] pr-3 pl-9 text-[var(--pc-ink)] outline-none focus:border-[var(--pc-accent)]"
              data-macro-search
            />
          </label>
          <div className="flex items-center justify-between gap-2 text-xs text-[var(--pc-muted)]">
            <label className="flex items-center gap-1.5">
              {tabs.length} macro{tabs.length === 1 ? "" : "s"} · Sort
              <select
                value={sort}
                onChange={(event) => setStoredSort(parseSort(event.target.value))}
                className="h-9 rounded-lg border border-[var(--pc-line)] bg-[var(--pc-paper)] px-1.5 text-[var(--pc-ink)]"
                data-macro-sort
              >
                <option value="manual">Manual</option>
                <option value="name">Name</option>
                <option value="recent">Recently edited</option>
              </select>
            </label>
            <button type="button" onClick={create} disabled={tabs.length >= MAX_TABS} className="inline-flex min-h-11 items-center gap-1 px-2 text-sm text-[var(--pc-accent)] disabled:opacity-50" data-macro-new-tab>
              <Plus className="size-4" aria-hidden /> New
            </button>
          </div>
          {notice && (
            <p role="status" className="flex items-center justify-between gap-2 rounded-xl bg-[var(--pc-accent-soft)] px-3 py-2 text-xs text-[var(--pc-ink)]">
              {notice}
              <button type="button" className="h-9 px-2 text-[var(--pc-accent)]" onClick={() => setNotice(null)}>
                Dismiss
              </button>
            </p>
          )}

          {library.length === 0 && (
            <p className="px-1 text-sm text-[var(--pc-muted)]">{query.trim() ? `No macro matches “${query.trim()}”.` : "No macros yet. Tap New to make one."}</p>
          )}
          {library.map((group) => {
            const isCollapsed = effectiveCollapsed.has(group.key);
            const showHeader = library.length > 1 || group.key !== "";
            return (
              <div key={group.key || UNGROUPED} role="group" aria-label={group.name} className="flex flex-col gap-1.5">
                {showHeader && (
                  <button
                    type="button"
                    aria-expanded={!isCollapsed}
                    onClick={() => toggleGroup(group.key)}
                    className="flex min-h-9 items-center gap-1 px-1 text-left text-xs font-semibold text-[var(--pc-muted)]"
                    data-macro-group={group.name}
                  >
                    {isCollapsed ? <ChevronRight className="size-3.5" aria-hidden /> : <ChevronDown className="size-3.5" aria-hidden />}
                    <span className="min-w-0 flex-1 truncate">{group.name}</span>
                    <span>{group.tabs.length}</span>
                  </button>
                )}
                {!isCollapsed && (
                  <div className="overflow-hidden rounded-xl bg-[var(--pc-panel)]">
                    {group.tabs.map((tab, index) => {
                      const live = isRunning(tab.id);
                      const paused = live && isPaused(tab.id);
                      return (
                        <button
                          key={tab.id}
                          type="button"
                          data-m-macro-row={tab.id}
                          data-macro-tab={tab.name}
                          onClick={() => {
                            setActiveTab(tab.id);
                            setView("editor");
                          }}
                          className={cn("flex min-h-14 w-full items-center gap-3 px-3 text-left", index > 0 && "border-t border-[var(--pc-line)]")}
                        >
                          <span
                            aria-label={live ? (paused ? "paused" : "running") : undefined}
                            className={cn(
                              "size-2.5 shrink-0 rounded-full",
                              live ? (paused ? "bg-[var(--pc-warn)]" : "animate-pulse bg-[var(--pc-signal)]") : "border border-[var(--pc-muted)]/60",
                            )}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[var(--pc-ink)]">{tab.name}</span>
                            <span className="block truncate text-xs text-[var(--pc-muted)]">
                              {tab.steps.length} step{tab.steps.length === 1 ? "" : "s"}
                              {live ? (paused ? " · paused" : " · running") : tab.stop.mode === "infinite" ? " · loop ∞" : ""}
                            </span>
                          </span>
                          <ChevronRight className="size-4 shrink-0 text-[var(--pc-muted)]" aria-hidden />
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}

          <div className="flex flex-col gap-1.5">
            <h3 className="px-1 text-xs font-semibold text-[var(--pc-muted)]">Library</h3>
            <div className="flex flex-wrap items-center gap-2">
              <ImportButton onImportFile={(name, text) => setPendingImport({ name, text })} onNotice={setNotice} />
              <VersionsMenu onNotice={setNotice} />
              <ExportMenu tabs={tabs} active={active} onNotice={setNotice} />
            </div>
            <MacroSyncNote />
          </div>
        </div>
      )}

      {view === "list" && running.length > 0 && (
        <div className="flex shrink-0 items-center gap-3 rounded-xl border border-[var(--pc-accent)]/40 bg-[var(--pc-accent-soft)] px-3 py-2 text-sm" data-m-macros-running>
          <span aria-hidden className="size-2.5 shrink-0 animate-pulse rounded-full bg-[var(--pc-signal)]" />
          <span className="min-w-0 flex-1">
            {running.map((id) => {
              const tab = tabs.find((t) => t.id === id);
              const snapshot = runFor(id);
              if (!tab) return null;
              return (
                <button key={id} type="button" className="block max-w-full truncate text-left text-[var(--pc-ink)]" onClick={() => { setActiveTab(id); setView("editor"); }}>
                  {tab.name}
                  {snapshot && snapshot.stepCount > 0 ? ` · step ${Math.min(snapshot.stepIndex + 1, snapshot.stepCount)}/${snapshot.stepCount}` : ""}
                </button>
              );
            })}
          </span>
          <button type="button" onClick={() => stopAllRuns()} className="inline-flex min-h-11 items-center rounded-lg bg-[var(--pc-warn)] px-3 text-sm font-semibold text-[#1a0f08]" data-macro-stop-all>
            Stop all
          </button>
        </div>
      )}

      {confirmDelete && (
        <ConfirmDialog
          title={`Delete “${confirmDelete.name}”?`}
          body={
            <>
              Its {confirmDelete.steps.length} step{confirmDelete.steps.length === 1 ? "" : "s"} and settings are removed from this browser.
              {isRunning(confirmDelete.id) ? " It is running and will be stopped." : ""} Export it first to keep a copy.
            </>
          }
          confirmLabel="Delete macro"
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            forgetRun(confirmDelete.id);
            forgetMacroView(confirmDelete.id);
            deleteTab(confirmDelete.id);
            setConfirmDelete(null);
            setView("list");
          }}
        />
      )}
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
                ? `No room: a browser keeps up to ${MAX_TABS} macros.`
                : `Imported ${count} macro${count === 1 ? "" : "s"} from ${pendingImport.name}${count < result.tabs.length ? ` (${result.tabs.length - count} did not fit)` : ""}.`,
            );
          }}
        />
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */

function Editor({
  tab,
  tabs,
  devices,
  activeDevice,
  canReorder,
  onBack,
  onNotice,
  onDelete,
}: {
  tab: MacroTab;
  tabs: MacroTab[];
  devices: Device[];
  activeDevice: Device | null;
  canReorder: boolean;
  onBack: () => void;
  onNotice: (message: string) => void;
  onDelete: () => void;
}) {
  useRunVersion();
  const [section, setSection] = useState<Section>("steps");
  const [menuOpen, setMenuOpen] = useState(false);
  const running = isRunning(tab.id);
  const snapshot = runFor(tab.id);
  const index = tabs.indexOf(tab);
  const targets = devices.filter((d) => tab.targetIds.includes(d.id));
  const onlineTargets = targets.filter((d) => d.status === "online");
  const enabled = tab.steps.filter((s) => s.enabled).length;
  const names = groupNames(tabs);

  const [draft, setDraft] = useState(tab.name);
  const [seenName, setSeenName] = useState(tab.name);
  if (seenName !== tab.name) {
    setSeenName(tab.name);
    setDraft(tab.name);
  }
  const commitName = () => {
    const name = draft.trim();
    if (name && name !== tab.name) {
      const unique = uniqueName(name, tabs.filter((t) => t.id !== tab.id).map((t) => t.name));
      patchTab(tab.id, (t) => ({ ...t, name: unique }));
      if (unique !== name) onNotice(`“${name}” is taken; renamed to “${unique}”.`);
    } else {
      setDraft(tab.name);
    }
  };

  const focusName = () => {
    window.setTimeout(() => {
      const field = document.querySelector<HTMLInputElement>("[data-macro-name]");
      field?.focus();
      field?.select();
    }, 50);
  };
  const menuItems: Array<{ label: string; icon: typeof Copy; disabled?: boolean; run: () => void; attr: string }> = [
    { label: "Rename", icon: Pencil, run: focusName, attr: "data-macro-rename" },
    { label: "Duplicate", icon: Copy, disabled: tabs.length >= MAX_TABS, run: () => duplicateTab(tab.id), attr: "data-macro-duplicate" },
    { label: "Move up in the list", icon: ChevronLeft, disabled: !canReorder || index <= 0, run: () => moveTab(tab.id, -1), attr: "data-macro-move-up" },
    { label: "Move down in the list", icon: ChevronRight, disabled: !canReorder || index >= tabs.length - 1, run: () => moveTab(tab.id, 1), attr: "data-macro-move-down" },
    { label: "Export this macro", icon: Download, run: () => void saveTextFile(exportMacroFile([tab]), macroFileName(tab.name), "application/json"), attr: "data-macro-export-this" },
    { label: "Delete…", icon: Trash2, run: onDelete, attr: "data-macro-delete" },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pb-2" data-m-macro-editor={tab.name}>
      <header className="flex items-start gap-1">
        <button type="button" onClick={onBack} aria-label="Back to the macro list" className="-ml-2 inline-flex size-11 shrink-0 items-center justify-center rounded-xl text-[var(--pc-ink)]" data-m-macro-back>
          <ChevronLeft className="size-5" aria-hidden />
        </button>
        <div className="min-w-0 flex-1">
          <input
            aria-label="Macro name"
            value={draft}
            maxLength={60}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitName}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                setDraft(tab.name);
                event.currentTarget.blur();
              }
            }}
            className="h-11 w-full rounded-lg border border-transparent bg-transparent px-1 font-display text-lg font-semibold text-[var(--pc-ink)] outline-none focus:border-[var(--pc-accent)]"
            data-macro-name
          />
          <p className="px-1 text-xs text-[var(--pc-muted)]">
            {tab.group ? `${tab.group} · ` : ""}
            {tab.reference.width}×{tab.reference.height} · {tab.steps.length} step{tab.steps.length === 1 ? "" : "s"} · ≈ {formatMs(cycleMs(tab))}
          </p>
        </div>
        <button type="button" onClick={() => setMenuOpen(true)} aria-label="More actions" className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl border border-[var(--pc-line)] text-[var(--pc-ink)]" data-m-macro-more>
          <MoreHorizontal className="size-5" aria-hidden />
        </button>
      </header>

      <div className="flex items-center gap-2" data-m-macro-run>
        {running ? (
          <button
            type="button"
            onClick={() => stopRun(tab.id)}
            disabled={snapshot?.status === "stopping"}
            className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-[var(--pc-warn)] px-4 text-sm font-semibold text-[#1a0f08] disabled:opacity-70"
            data-macro-quick-stop
          >
            <Square className="size-4" aria-hidden /> {snapshot?.status === "stopping" ? "Stopping…" : "Stop"}
          </button>
        ) : (
          <button
            type="button"
            disabled={onlineTargets.length === 0 || enabled === 0}
            onClick={() => void startRun(tab, targets)}
            className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-[var(--pc-accent-fill)] px-4 text-sm font-semibold text-white disabled:opacity-50"
            data-macro-quick-start
          >
            <Play className="size-4" aria-hidden /> {runLabel(tab, onlineTargets.length)}
          </button>
        )}
        {running && <PauseButton tabId={tab.id} />}
      </div>
      {!running && (onlineTargets.length === 0 || enabled === 0) && (
        <p className="-mt-1 px-1 text-xs text-[var(--pc-muted)]">
          {enabled === 0 ? "Add or enable a step to run." : "Pick the phones to run on in the Run tab."}
        </p>
      )}

      <div role="tablist" aria-label="Macro sections" className="-mx-3 flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--pc-line)] px-3" data-m-macro-sections>
        {SECTIONS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={section === id}
            data-macro-section={id}
            onClick={() => setSection(id)}
            className={cn(
              "-mb-px min-h-11 shrink-0 border-b-2 px-3 text-sm",
              section === id ? "border-[var(--pc-accent)] font-semibold text-[var(--pc-ink)]" : "border-transparent text-[var(--pc-muted)]",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {section === "steps" && <Steps tab={tab} devices={devices} activeDevice={activeDevice} />}
      {section === "run" && <RunCard tab={tab} devices={devices} targets={targets} />}
      {section === "settings" && (
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs text-[var(--pc-muted)]" data-macro-group-field>
            Group
            <input
              list="m-macro-groups"
              value={tab.group ?? ""}
              maxLength={MAX_GROUP_LENGTH}
              placeholder="Ungrouped"
              onChange={(event) => {
                const group = cleanGroup(event.target.value);
                patchTab(tab.id, (t) => {
                  const { group: _old, ...rest } = t;
                  void _old;
                  return group ? { ...rest, group } : rest;
                });
              }}
              className="h-11 w-full rounded-xl border border-[var(--pc-line)] bg-[var(--pc-paper)] px-3 text-[var(--pc-ink)] outline-none focus:border-[var(--pc-accent)]"
            />
            <datalist id="m-macro-groups">
              {names.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
            <span>Groups collect macros in the list. Leave it empty for none.</span>
          </label>
          <SettingsCard tab={tab} devices={devices} onChange={(change) => patchTab(tab.id, change)} />
          <FolderHint folder="macros" store="macros" itemId={tab.id} />
        </div>
      )}
      {section === "automation" && (
        <div className="flex flex-col gap-3" data-macro-automation>
          <QueueCard tabs={tabs} activeTab={tab} />
          <ScheduleCard tabs={tabs} activeTab={tab} />
        </div>
      )}
      {section === "phones" && <PhoneRunsCard tabs={tabs} devices={devices} />}

      {menuOpen && (
        <BottomSheet title={tab.name} dataSheet="macro-actions" onClose={() => setMenuOpen(false)}>
          <div className="flex flex-col">
            {menuItems.map((item) => (
              <button
                key={item.label}
                type="button"
                disabled={item.disabled}
                {...{ [item.attr]: "" }}
                className="flex min-h-12 items-center gap-3 border-b border-[var(--pc-line)] px-1 text-left text-[var(--pc-ink)] last:border-b-0 disabled:opacity-50"
                onClick={() => {
                  setMenuOpen(false);
                  item.run();
                }}
              >
                <item.icon className="size-4 text-[var(--pc-muted)]" aria-hidden />
                {item.label}
              </button>
            ))}
          </div>
        </BottomSheet>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

/** New position of one finger end, as a new steps list. */
function movedFinger(steps: MacroStep[], stepId: string, fingerId: string, end: FingerEnd, point: { x: number; y: number }): MacroStep[] {
  return steps.map((s) =>
    s.id !== stepId
      ? s
      : {
          ...s,
          fingers: s.fingers.map((f) => (f.id !== fingerId ? f : end === "start" ? { ...f, x: point.x, y: point.y } : { ...f, toX: point.x, toY: point.y })),
        },
  );
}

function PreviewChips({ devices, previewDevice, activeDevice, tab, onPick }: { devices: Device[]; previewDevice: Device | null; activeDevice: Device | null; tab: MacroTab; onPick: (id: string) => void }) {
  return (
    <div role="group" aria-label="Show on" className="-mx-3 flex gap-1.5 overflow-x-auto px-3 pb-1" data-macro-preview-chips>
      {devices.map((d) => {
        const selected = previewDevice?.id === d.id;
        return (
          <button
            key={d.id}
            type="button"
            aria-pressed={selected}
            disabled={!hasScreen(d)}
            onClick={() => onPick(d.id)}
            data-macro-preview-chip={d.id}
            className={cn(
              "inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs disabled:opacity-40",
              selected ? "border-[var(--pc-accent)] bg-[var(--pc-accent-soft)] text-[var(--pc-ink)]" : "border-[var(--pc-line)] text-[var(--pc-ink)]",
            )}
          >
            <span aria-hidden className={cn("size-1.5 rounded-full", d.status === "online" ? "bg-[var(--pc-signal)]" : "bg-[var(--pc-muted)]")} />
            {d.name}
            {d.id === activeDevice?.id && <span className="text-[var(--pc-muted)]">in Control</span>}
          </button>
        );
      })}
      <button
        type="button"
        aria-pressed={!previewDevice}
        onClick={() => onPick("reference")}
        data-macro-preview-chip="reference"
        className={cn(
          "inline-flex min-h-10 shrink-0 items-center rounded-full border px-3 text-xs",
          !previewDevice ? "border-[var(--pc-accent)] bg-[var(--pc-accent-soft)] text-[var(--pc-ink)]" : "border-[var(--pc-line)] text-[var(--pc-muted)]",
        )}
      >
        Reference {tab.reference.width}×{tab.reference.height}
      </button>
    </div>
  );
}

function Steps({ tab, devices, activeDevice }: { tab: MacroTab; devices: Device[]; activeDevice: Device | null }) {
  const saved = getMacroView(tab.id);
  const [selectedStepId, setSelectedState] = useState<string | null>(saved?.stepId ?? tab.steps[0]?.id ?? null);
  const [previewId, setPreviewState] = useState<string>(() => saved?.previewId ?? defaultPreviewId(tab, devices, activeDevice));
  const [placeOpen, setPlaceOpen] = useState(false);
  const [live, setLive] = useState(true);
  const running = isRunning(tab.id);
  const targets = devices.filter((d) => tab.targetIds.includes(d.id));

  const setSelected = (id: string | null) => {
    setSelectedState(id);
    setMacroView(tab.id, { stepId: id, previewId });
  };
  const setPreview = (id: string) => {
    setPreviewState(id);
    setMacroView(tab.id, { stepId: selectedStepId, previewId: id });
  };
  const setSteps = (steps: MacroStep[]) => patchTab(tab.id, (t) => ({ ...t, steps }));
  const previewDevice = devices.find((d) => d.id === previewId && hasScreen(d)) ?? null;
  const previewProps = {
    tab,
    selectedStepId,
    onSelectStep: setSelected,
    onMoveFinger: (stepId: string, fingerId: string, end: FingerEnd, point: { x: number; y: number }) => setSteps(movedFinger(tab.steps, stepId, fingerId, end, point)),
    onPlace: () => {},
  };

  return (
    <div className="flex flex-col gap-3" data-macro-workspace={tab.name}>
      <PreviewChips devices={devices} previewDevice={previewDevice} activeDevice={activeDevice} tab={tab} onPick={setPreview} />
      <div className="flex flex-col gap-2">
        {previewDevice ? (
          <LivePreview key={previewDevice.id} device={previewDevice} live={live && !placeOpen && previewDevice.status === "online"} placing={false} maxHeight="44dvh" {...previewProps} />
        ) : (
          <MacroPreview frame={null} frameLabel="Reference screen" placing={false} maxHeight="44dvh" {...previewProps} />
        )}
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setPlaceOpen(true)} className={cn(btn, "flex-1 border-[var(--pc-accent)] font-semibold text-[var(--pc-accent)]")} data-m-macro-place-open>
            <Crosshair className="size-4" aria-hidden /> Edit on the phone screen
          </button>
          {previewDevice && (
            <label className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-[var(--pc-line)] px-3 text-xs text-[var(--pc-ink)]">
              Live
              <Switch checked={live} onChange={() => setLive(!live)} data-macro-live-toggle aria-label="Live video" />
            </label>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 px-1">
        <h3 className="t-heading text-[var(--pc-ink)]">Steps ({tab.steps.length})</h3>
        <span className="text-xs text-[var(--pc-muted)]">cycle ≈ {formatMs(cycleMs(tab))}</span>
      </div>
      <AddStepBar
        disabled={tab.steps.length >= MAX_STEPS}
        onAdd={(kind) => {
          const step = makeStep(kind, tab);
          setSteps([...tab.steps, step]);
          setSelected(step.id);
        }}
      />
      <StepList
        tab={tab}
        selectedStepId={selectedStepId}
        canTest={!running && targets.some((d) => d.status === "online")}
        readDevice={previewDevice ?? targets.find((d) => d.status === "online") ?? null}
        onSelect={setSelected}
        onChange={setSteps}
        onTest={(stepId) => void startRun(tab, targets, stepId)}
      />

      {placeOpen && (
        <PlaceEditor
          tab={tab}
          devices={devices}
          activeDevice={activeDevice}
          previewDevice={previewDevice}
          selectedStepId={selectedStepId}
          onSelect={setSelected}
          onPreview={setPreview}
          onSteps={setSteps}
          onClose={() => setPlaceOpen(false)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

const MODES = [
  ["tap", "Tap"],
  ["swipe", "Swipe"],
  ["hold", "Hold"],
  ["multi", "2-finger"],
] as const;
type Mode = (typeof MODES)[number][0];

const kindLabel = (step: MacroStep) => {
  const kind = stepKind(step);
  return kind === "multi" ? "2-finger" : kind === "text" ? "Text" : kind === "app" ? "App" : kind[0].toUpperCase() + kind.slice(1);
};

/** The whole phone as a canvas: tap it to add a step, drag a number to move it. */
function PlaceEditor({
  tab,
  devices,
  activeDevice,
  previewDevice,
  selectedStepId,
  onSelect,
  onPreview,
  onSteps,
  onClose,
}: {
  tab: MacroTab;
  devices: Device[];
  activeDevice: Device | null;
  previewDevice: Device | null;
  selectedStepId: string | null;
  onSelect: (id: string | null) => void;
  onPreview: (id: string) => void;
  onSteps: (steps: MacroStep[]) => void;
  onClose: () => void;
}) {
  useRunVersion();
  const [mode, setMode] = useState<Mode>("tap");
  const [history] = useState(() => createPlaceHistory<MacroStep[]>());
  const [, bump] = useState(0);
  const running = isRunning(tab.id);
  const targets = devices.filter((d) => tab.targetIds.includes(d.id));
  const canTest = !running && targets.some((d) => d.status === "online");
  const selected = tab.steps.find((s) => s.id === selectedStepId) ?? null;

  // Every change keeps the steps from before it, for Undo (a drag counts as one).
  const commit = (next: MacroStep[], joinable = true) => {
    history.push(tab.steps, Date.now(), joinable);
    onSteps(next);
    bump((n) => n + 1);
  };
  const common = {
    tab,
    selectedStepId,
    onSelectStep: (id: string) => onSelect(id),
    onMoveFinger: (stepId: string, fingerId: string, end: FingerEnd, point: { x: number; y: number }) => commit(movedFinger(tab.steps, stepId, fingerId, end, point)),
    onPlace: (point: { x: number; y: number }) => {
      if (tab.steps.length >= MAX_STEPS) return;
      const step = makeStep(mode, tab, point);
      commit([...tab.steps, step], false);
      onSelect(step.id);
    },
    placing: true,
    maxHeight: "calc(100dvh - 22rem)",
  };

  return (
    <BottomSheet title={tab.name} full dataSheet="macro-place" onClose={onClose}>
      <div className="flex min-h-0 flex-1 flex-col gap-2" data-m-macro-place>
        <div role="radiogroup" aria-label="What a tap on the screen adds" className="grid shrink-0 grid-cols-4 gap-1.5">
          {MODES.map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={mode === id}
              data-place-mode={id}
              onClick={() => setMode(id)}
              className={cn(
                "min-h-11 rounded-xl border text-sm",
                mode === id ? "border-[var(--pc-accent)] bg-[var(--pc-accent-soft)] text-[var(--pc-ink)]" : "border-[var(--pc-line)] bg-[var(--pc-panel)] text-[var(--pc-muted)]",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-2 text-xs text-[var(--pc-muted)]">
          <label className="flex min-w-0 flex-1 items-center gap-1.5">
            Show on
            <select
              value={previewDevice?.id ?? "reference"}
              onChange={(event) => onPreview(event.target.value)}
              className="h-10 min-w-0 flex-1 rounded-lg border border-[var(--pc-line)] bg-[var(--pc-paper)] px-2 text-[var(--pc-ink)]"
              data-place-device
            >
              {devices.filter(hasScreen).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                  {d.id === activeDevice?.id ? " (in Control)" : ""}
                </option>
              ))}
              <option value="reference">Reference {tab.reference.width}×{tab.reference.height}</option>
            </select>
          </label>
        </div>

        <div className="flex min-h-0 flex-1 items-start justify-center overflow-hidden">
          <div className="w-full">
            {previewDevice ? (
              <LivePreview key={previewDevice.id} device={previewDevice} live={previewDevice.status === "online"} {...common} />
            ) : (
              <MacroPreview frame={null} frameLabel="Reference screen" {...common} />
            )}
          </div>
        </div>
        <p className="shrink-0 text-center text-xs text-[var(--pc-muted)]">Tap the screen to add a {mode === "multi" ? "2-finger tap" : mode} · drag a number to move it</p>

        <div className="flex shrink-0 flex-col gap-2 rounded-t-2xl border-t border-[var(--pc-line)] bg-[var(--pc-panel)] px-3 py-2" data-m-macro-place-drawer>
          <div className="flex items-center justify-between text-sm">
            <span className="font-semibold text-[var(--pc-ink)]">Steps ({tab.steps.length})</span>
            <span className="truncate text-xs text-[var(--pc-muted)]">{selected ? `Selected: ${tab.steps.indexOf(selected) + 1} ${kindLabel(selected)}` : "No step selected"}</span>
          </div>
          <div className="-mx-3 flex gap-1.5 overflow-x-auto px-3" role="listbox" aria-label="Steps">
            {tab.steps.length === 0 && <span className="py-2 text-xs text-[var(--pc-muted)]">No steps yet: tap the screen above.</span>}
            {tab.steps.map((step, i) => (
              <button
                key={step.id}
                type="button"
                role="option"
                aria-selected={step.id === selectedStepId}
                data-place-step={step.id}
                onClick={() => onSelect(step.id)}
                className={cn(
                  "min-h-10 shrink-0 rounded-lg border px-3 text-xs whitespace-nowrap",
                  step.id === selectedStepId ? "border-[var(--pc-accent)] bg-[var(--pc-accent-soft)] text-[var(--pc-ink)]" : "border-[var(--pc-line)] text-[var(--pc-ink)]",
                )}
              >
                {i + 1} {kindLabel(step)}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            <button
              type="button"
              className={btn}
              disabled={history.size === 0}
              data-place-undo
              onClick={() => {
                const before = history.undo();
                if (before) {
                  onSteps(before);
                  if (selectedStepId && !before.some((s) => s.id === selectedStepId)) onSelect(before[before.length - 1]?.id ?? null);
                  bump((n) => n + 1);
                }
              }}
            >
              <Undo2 className="size-4" aria-hidden /> Undo
            </button>
            <button
              type="button"
              className={btn}
              disabled={!selected}
              data-place-delete
              onClick={() => {
                if (!selected) return;
                const at = tab.steps.indexOf(selected);
                const next = tab.steps.filter((s) => s.id !== selected.id);
                commit(next, false);
                onSelect(next[Math.min(at, next.length - 1)]?.id ?? null);
              }}
            >
              <Trash2 className="size-4" aria-hidden /> Delete
            </button>
            <button
              type="button"
              className={cn(btn, "bg-[var(--pc-accent-fill)] font-semibold text-white")}
              disabled={!selected || !canTest}
              title={canTest ? undefined : "Pick an online phone in the Run tab to test a step."}
              data-place-test
              aria-label="Test step"
              onClick={() => selected && void startRun(tab, targets, selected.id)}
            >
              <Play className="size-4" aria-hidden /> Test
            </button>
          </div>
        </div>
      </div>
    </BottomSheet>
  );
}
