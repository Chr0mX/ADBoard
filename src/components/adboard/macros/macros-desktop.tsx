"use client";

import { useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Copy, MoreHorizontal, Play, Plus, Search, Square, Trash2 } from "lucide-react";
import { UNTITLED_MACRO, uniqueName } from "@/lib/adboard-files";
import { MAX_GROUP_LENGTH, MAX_TABS, MAX_TABS as TAB_LIMIT, cleanGroup, cycleMs, type ImportResult, type MacroTab } from "@/lib/macro/core";
import { UNGROUPED, buildLibrary, flatOrder, groupNames, parseSort, stepSelection, type LibrarySort } from "@/lib/macro/groups";
import {
  addTab,
  deleteTab,
  duplicateTab,
  importTabs,
  moveTab,
  patchTab,
  setActiveTab,
  useMacroWorkspace,
} from "@/lib/macro/store";
import { forgetRun, isPaused, isRunning, runFor, runningTabIds, startRun, stopAllRuns, stopRun, useRunVersion } from "@/lib/macro/runs";
import { cn } from "@/lib/utils";
import { useStoredString } from "@/hooks/use-stored-flag";
import { useDesk } from "@/components/adboard/desk/desk-context";
import { ConfirmDialog, PanelFrame } from "@/components/adboard/desk/bits";
import { FolderHint } from "@/components/adboard/desk/data-storage";
import { formatMs } from "@/components/adboard/macros/fields";
import { ImportDialog } from "@/components/adboard/macros/import-dialog";
import { QueueCard, ScheduleCard } from "@/components/adboard/macros/automation-cards";
import { PhoneRunsCard } from "@/components/adboard/macros/phone-runs-card";
import {
  ExportMenu,
  ImportButton,
  MacroSyncNote,
  PauseButton,
  RunCard,
  SettingsCard,
  TabWorkspace,
  VersionsMenu,
  forgetMacroView,
  runLabel,
} from "@/components/adboard/macros/macros-panel";

/*
 * Desktop Macros: a library of macros on the left (search, groups, state dots)
 * and one editor on the right. The editor reuses the same cards the phone
 * layout shows (steps and preview, run, settings, queue, schedules, phones),
 * split into sections so only one is on screen at a time. The phone layout
 * keeps MacrosPanel as it was.
 */

const SORT_KEY = "adboard-macro-sort";
const COLLAPSED_KEY = "adboard-macro-collapsed";
const SECTIONS = [
  ["steps", "Steps"],
  ["run", "Run"],
  ["settings", "Settings"],
  ["automation", "Queue and schedule"],
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

export function MacrosDesktop() {
  const workspace = useMacroWorkspace();
  useRunVersion();
  const desk = useDesk();
  const tabs = workspace.tabs;
  const active = tabs.find((t) => t.id === workspace.activeId) ?? tabs[0] ?? null;
  const [pendingImport, setPendingImport] = useState<{ name: string; text: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [storedSort, setStoredSort] = useStoredString(SORT_KEY);
  const sort = parseSort(storedSort);
  const [storedCollapsed, setStoredCollapsed] = useStoredString(COLLAPSED_KEY);
  const collapsed = useMemo(() => parseCollapsed(storedCollapsed), [storedCollapsed]);
  const [confirmDelete, setConfirmDelete] = useState<MacroTab | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const library = useMemo(() => buildLibrary(tabs, query, sort), [tabs, query, sort]);
  // Searching opens every group so a match is never hidden in a collapsed one.
  const effectiveCollapsed = query.trim() ? new Set<string>() : collapsed;
  const order = flatOrder(library, effectiveCollapsed);

  const toggleGroup = (key: string) => {
    const next = new Set(collapsed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setStoredCollapsed(JSON.stringify([...next]));
  };

  const create = () => {
    // New macros start as "Untitled macro" with the name field focused.
    const created = addTab({ name: UNTITLED_MACRO, ...(active?.group ? { group: active.group } : {}) });
    if (created) setQuery("");
    window.setTimeout(() => {
      nameRef.current?.focus();
      nameRef.current?.select();
    }, 50);
  };

  const running = runningTabIds();
  const focusName = () => nameRef.current?.focus();

  return (
    <PanelFrame title="Macros" panel="macros" clean>
      <div className="flex flex-wrap items-center gap-2" data-macro-tabs data-macro-toolbar>
        <label className="relative min-w-48 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-[var(--pc-muted)]" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search macros"
            aria-label="Search macros"
            className="h-9 w-full rounded-lg border border-[var(--pc-line)] bg-[var(--pc-paper)] pr-2 pl-8 text-sm text-[var(--pc-ink)] outline-none focus:border-[var(--pc-accent)]"
            data-macro-search
          />
        </label>
        <button
          type="button"
          onClick={create}
          disabled={tabs.length >= TAB_LIMIT}
          className="pc-toggle pc-toggle-sm"
          data-macro-new-tab
        >
          <Plus className="size-3.5" aria-hidden /> New macro
        </button>
        <span className="ml-auto flex flex-wrap items-center gap-1.5">
          <MacroSyncNote />
          <ImportButton onImportFile={(name, text) => setPendingImport({ name, text })} onNotice={setNotice} />
          <VersionsMenu onNotice={setNotice} />
          <ExportMenu tabs={tabs} active={active} onNotice={setNotice} />
        </span>
      </div>
      <FolderHint folder="macros" store="macros" itemId={active?.id ?? null} />
      {notice && (
        <p role="status" className="flex items-center justify-between gap-2 rounded-lg bg-[var(--pc-accent-soft)] px-3 py-2 text-xs text-[var(--pc-ink)]">
          {notice}
          <button type="button" className="h-8 px-2 text-[var(--pc-accent)]" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </p>
      )}

      <div className="grid min-h-0 gap-x-5 gap-y-3 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <Library
          library={library}
          tabs={tabs}
          activeId={active?.id ?? null}
          collapsed={effectiveCollapsed}
          sort={sort}
          onSort={(next) => setStoredSort(next)}
          onToggleGroup={toggleGroup}
          onPick={(id) => setActiveTab(id)}
          onRename={focusName}
          order={order}
          query={query}
        />
        <div className="min-w-0">
          {active ? (
            <Editor
              key={active.id}
              tab={active}
              tabs={tabs}
              nameRef={nameRef}
              devices={desk.devices}
              activeDevice={desk.activeDevice}
              onNotice={setNotice}
              onDelete={() => setConfirmDelete(active)}
              onFocusName={focusName}
              canReorder={sort === "manual" && !query.trim()}
            />
          ) : (
            <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-[var(--pc-line)] p-6 text-sm text-[var(--pc-muted)]">
              <p>No macros yet.</p>
              <button type="button" className="pc-toggle pc-toggle-sm" onClick={create}>
                <Plus className="size-3.5" aria-hidden /> New macro
              </button>
            </div>
          )}
        </div>
      </div>

      {running.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[var(--pc-line)] pt-2 text-xs" data-macro-running-strip>
          <span className="font-medium text-[var(--pc-ink)]">Running now</span>
          {running.map((id) => {
            const tab = tabs.find((t) => t.id === id);
            const snapshot = runFor(id);
            if (!tab) return null;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setActiveTab(id)}
                className="inline-flex items-center gap-1.5 text-[var(--pc-muted)] hover:text-[var(--pc-ink)]"
              >
                <span aria-hidden className="size-2 animate-pulse rounded-full bg-[var(--pc-signal)]" />
                <span className="text-[var(--pc-ink)]">{tab.name}</span>
                {snapshot && snapshot.stepCount > 0 && (
                  <span>
                    step {Math.min(snapshot.stepIndex + 1, snapshot.stepCount)}/{snapshot.stepCount}
                  </span>
                )}
              </button>
            );
          })}
          <button type="button" className="ml-auto text-[var(--pc-accent)] hover:underline" onClick={() => stopAllRuns()} data-macro-stop-all>
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
    </PanelFrame>
  );
}

/* ------------------------------------------------------------------ */

function StateDot({ tab }: { tab: MacroTab }) {
  const live = isRunning(tab.id);
  if (!live) return <span aria-hidden className="size-2 shrink-0 rounded-full border border-[var(--pc-muted)]/60" />;
  return isPaused(tab.id) ? (
    <span aria-label="paused" className="size-2 shrink-0 rounded-full bg-[var(--pc-warn)]" />
  ) : (
    <span aria-label="running" className="size-2 shrink-0 animate-pulse rounded-full bg-[var(--pc-signal)]" />
  );
}

function Library({
  library,
  tabs,
  activeId,
  collapsed,
  sort,
  onSort,
  onToggleGroup,
  onPick,
  onRename,
  order,
  query,
}: {
  library: ReturnType<typeof buildLibrary<MacroTab>>;
  tabs: MacroTab[];
  activeId: string | null;
  collapsed: ReadonlySet<string>;
  sort: LibrarySort;
  onSort: (sort: LibrarySort) => void;
  onToggleGroup: (key: string) => void;
  onPick: (id: string) => void;
  onRename: () => void;
  order: MacroTab[];
  query: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const move = (delta: -1 | 1) => {
    const next = stepSelection(order, activeId, delta);
    if (!next || next === activeId) return;
    onPick(next);
    window.requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-macro-row="${next}"]`)?.focus());
  };

  return (
    <nav aria-label="Macro library" className="flex min-w-0 flex-col gap-2 lg:border-r lg:border-[var(--pc-line)] lg:pr-4" data-macro-library>
      {/* Narrow windows: one select instead of the list. */}
      <select
        className="h-10 rounded-lg border border-[var(--pc-line)] bg-[var(--pc-paper)] px-2 text-sm text-[var(--pc-ink)] lg:hidden"
        aria-label="Macro"
        value={activeId ?? ""}
        onChange={(event) => onPick(event.target.value)}
        data-macro-select
      >
        {tabs.map((tab) => (
          <option key={tab.id} value={tab.id}>
            {tab.group ? `${tab.group} / ${tab.name}` : tab.name}
          </option>
        ))}
      </select>

      <div className="hidden min-h-0 flex-col gap-2 lg:flex">
        <div className="flex items-center justify-between gap-2 text-xs text-[var(--pc-muted)]">
          <span>
            {tabs.length} macro{tabs.length === 1 ? "" : "s"}
          </span>
          <label className="flex items-center gap-1.5">
            Sort
            <select
              value={sort}
              onChange={(event) => onSort(parseSort(event.target.value))}
              className="h-8 rounded-md border border-[var(--pc-line)] bg-[var(--pc-paper)] px-1.5 text-xs text-[var(--pc-ink)]"
              data-macro-sort
            >
              <option value="manual">Manual</option>
              <option value="name">Name</option>
              <option value="recent">Recently edited</option>
            </select>
          </label>
        </div>

        <div
          ref={listRef}
          role="listbox"
          aria-label="Macros"
          className="flex max-h-[calc(100dvh-16rem)] min-h-40 flex-col gap-3 overflow-y-auto pr-1"
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              move(1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              move(-1);
            }
          }}
        >
          {library.length === 0 && (
            <p className="px-1 text-xs text-[var(--pc-muted)]">{query.trim() ? `No macro matches “${query.trim()}”.` : "No macros yet."}</p>
          )}
          {library.map((group) => {
            const isCollapsed = collapsed.has(group.key);
            const showHeader = library.length > 1 || group.key !== "";
            return (
              <div key={group.key || UNGROUPED} role="group" aria-label={group.name} className="flex flex-col">
                {showHeader && (
                  <button
                    type="button"
                    aria-expanded={!isCollapsed}
                    onClick={() => onToggleGroup(group.key)}
                    className="flex h-8 items-center gap-1 rounded-md px-1 text-left text-xs font-medium text-[var(--pc-muted)] hover:text-[var(--pc-ink)]"
                    data-macro-group={group.name}
                  >
                    {isCollapsed ? <ChevronRight className="size-3.5" aria-hidden /> : <ChevronDown className="size-3.5" aria-hidden />}
                    <span className="min-w-0 flex-1 truncate">{group.name}</span>
                    <span>{group.tabs.length}</span>
                  </button>
                )}
                {!isCollapsed &&
                  group.tabs.map((tab) => {
                    const selected = tab.id === activeId;
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        tabIndex={selected || (!activeId && tab === order[0]) ? 0 : -1}
                        data-macro-row={tab.id}
                        data-macro-tab={tab.name}
                        onClick={() => onPick(tab.id)}
                        onDoubleClick={onRename}
                        className={cn(
                          "flex h-9 min-h-9 items-center gap-2 rounded-md px-2 text-left text-sm",
                          showHeader && "ml-3",
                          selected
                            ? "bg-[var(--pc-accent-soft)] font-medium text-[var(--pc-ink)]"
                            : "text-[var(--pc-ink)]/85 hover:bg-[var(--pc-accent-soft)]/60",
                        )}
                      >
                        <StateDot tab={tab} />
                        <span className="min-w-0 flex-1 truncate">{tab.name}</span>
                        <span className="text-xs text-[var(--pc-muted)]">{tab.steps.length}</span>
                      </button>
                    );
                  })}
              </div>
            );
          })}
        </div>
      </div>
    </nav>
  );
}

/* ------------------------------------------------------------------ */

function Editor({
  tab,
  tabs,
  nameRef,
  devices,
  activeDevice,
  onNotice,
  onDelete,
  onFocusName,
  canReorder,
}: {
  tab: MacroTab;
  tabs: MacroTab[];
  nameRef: React.RefObject<HTMLInputElement | null>;
  onFocusName: () => void;
  devices: import("@/lib/devices/types").Device[];
  activeDevice: import("@/lib/devices/types").Device | null;
  onNotice: (message: string) => void;
  onDelete: () => void;
  canReorder: boolean;
}) {
  useRunVersion();
  const [section, setSection] = useState<Section>("steps");
  const running = isRunning(tab.id);
  const index = tabs.indexOf(tab);
  const targets = devices.filter((d) => tab.targetIds.includes(d.id));
  const onlineTargets = targets.filter((d) => d.status === "online");
  const enabled = tab.steps.filter((s) => s.enabled).length;
  const snapshot = runFor(tab.id);
  const names = groupNames(tabs);

  // The name field edits a draft; it commits on blur or Enter (a blank name keeps the old one).
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

  return (
    <div className="flex min-w-0 flex-col gap-3" data-macro-editor={tab.name}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <input
            ref={nameRef}
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
            className="w-full rounded-md border border-transparent bg-transparent px-1 font-display text-lg font-semibold text-[var(--pc-ink)] outline-none hover:border-[var(--pc-line)] focus:border-[var(--pc-accent)]"
            data-macro-name
          />
          <p className="px-1 text-xs text-[var(--pc-muted)]">
            {tab.group ? `${tab.group} · ` : ""}
            {tab.reference.width}×{tab.reference.height} · {tab.steps.length} step{tab.steps.length === 1 ? "" : "s"} · cycle ≈ {formatMs(cycleMs(tab))}
            {running && snapshot ? ` · ${snapshot.status}` : ""}
          </p>
        </div>

        <div className="flex items-center gap-1.5">
          {running && <PauseButton tabId={tab.id} />}
          {running ? (
            <button
              type="button"
              onClick={() => stopRun(tab.id)}
              disabled={snapshot?.status === "stopping"}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-[var(--pc-warn)] px-3 text-sm font-semibold text-[#1a0f08] disabled:opacity-70"
              data-macro-quick-stop
            >
              <Square className="size-3.5" aria-hidden /> {snapshot?.status === "stopping" ? "Stopping…" : "Stop"}
            </button>
          ) : (
            <button
              type="button"
              disabled={onlineTargets.length === 0 || enabled === 0}
              onClick={() => void startRun(tab, targets)}
              title={enabled === 0 ? "Add or enable a step to run." : onlineTargets.length === 0 ? "Tick at least one online phone (Run section)." : undefined}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-[var(--pc-accent-fill)] px-3 text-sm font-semibold text-white disabled:opacity-50"
              data-macro-quick-start
            >
              <Play className="size-3.5" aria-hidden /> {runLabel(tab, onlineTargets.length)}
            </button>
          )}
          <details className="relative" data-macro-more>
            <summary
              aria-label="More actions"
              className="inline-flex size-9 cursor-pointer list-none items-center justify-center rounded-lg border border-[var(--pc-line)] text-[var(--pc-ink)] hover:bg-[var(--pc-accent-soft)]"
            >
              <MoreHorizontal className="size-4" aria-hidden />
            </summary>
            <div className="absolute right-0 z-30 mt-1 flex w-48 flex-col rounded-xl border border-[var(--pc-line)] bg-[var(--pc-paper)] p-1 shadow-lg">
              {[
                { label: "Rename", icon: null, disabled: false, run: onFocusName, attr: "data-macro-rename" },
                { label: "Duplicate", icon: Copy, disabled: tabs.length >= TAB_LIMIT, run: () => duplicateTab(tab.id), attr: "data-macro-duplicate" },
                { label: "Move up", icon: null, disabled: !canReorder || index <= 0, run: () => moveTab(tab.id, -1), attr: "data-macro-move-up" },
                { label: "Move down", icon: null, disabled: !canReorder || index >= tabs.length - 1, run: () => moveTab(tab.id, 1), attr: "data-macro-move-down" },
                { label: "Delete…", icon: Trash2, disabled: false, run: onDelete, attr: "data-macro-delete" },
              ].map((item) => (
                <button
                  key={item.label}
                  type="button"
                  disabled={item.disabled}
                  {...{ [item.attr]: "" }}
                  className="flex h-9 items-center gap-2 rounded-lg px-2 text-left text-sm text-[var(--pc-ink)] hover:bg-[var(--pc-accent-soft)] disabled:opacity-50"
                  onClick={(event) => {
                    item.run();
                    (event.currentTarget.closest("details") as HTMLDetailsElement | null)?.removeAttribute("open");
                  }}
                >
                  {item.icon ? <item.icon className="size-3.5" aria-hidden /> : <span className="w-3.5" aria-hidden />}
                  {item.label}
                </button>
              ))}
            </div>
          </details>
        </div>
      </header>

      <div role="tablist" aria-label="Macro sections" className="flex gap-1 border-b border-[var(--pc-line)]" data-macro-sections>
        {SECTIONS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={section === id}
            data-macro-section={id}
            onClick={() => setSection(id)}
            className={cn(
              "-mb-px h-9 border-b-2 px-3 text-sm",
              section === id
                ? "border-[var(--pc-accent)] font-medium text-[var(--pc-ink)]"
                : "border-transparent text-[var(--pc-muted)] hover:text-[var(--pc-ink)]",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {section === "steps" && <TabWorkspace tab={tab} devices={devices} activeDevice={activeDevice} part="steps" />}
      {section === "run" && (
        <div className="max-w-2xl">
          <RunCard tab={tab} devices={devices} targets={targets} />
        </div>
      )}
      {section === "settings" && (
        <div className="flex max-w-3xl flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs text-[var(--pc-muted)]" data-macro-group-field>
            Group
            <input
              list="macro-groups"
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
              className="h-10 w-64 max-w-full rounded-lg border border-[var(--pc-line)] bg-[var(--pc-paper)] px-2 text-sm text-[var(--pc-ink)] outline-none focus:border-[var(--pc-accent)]"
            />
            <datalist id="macro-groups">
              {names.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
            <span>Groups collect macros in the library. Leave it empty for none.</span>
          </label>
          <SettingsCard tab={tab} devices={devices} onChange={(change) => patchTab(tab.id, change)} />
        </div>
      )}
      {section === "automation" && (
        <div className="grid gap-3 xl:grid-cols-2" data-macro-automation>
          <QueueCard tabs={tabs} activeTab={tab} />
          <ScheduleCard tabs={tabs} activeTab={tab} />
        </div>
      )}
      {section === "phones" && <PhoneRunsCard tabs={tabs} devices={devices} />}
    </div>
  );
}
