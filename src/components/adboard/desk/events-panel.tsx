"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, RefreshCw, Search, Trash2 } from "lucide-react";
import { useDesk } from "@/components/adboard/desk/desk-context";
import { ConfirmDialog, PanelFrame } from "@/components/adboard/desk/bits";
import { Card, GhostButton, NumField } from "@/components/adboard/macros/fields";
import { setActiveTab } from "@/lib/macro/store";
import {
  CATEGORY_LABEL,
  NO_AGENT,
  clearEvents,
  fetchEvents,
  fetchNotifications,
  fetchSummary,
  hasAgent,
  markEventsSeen,
  saveNotifications,
  type AppEvent,
  type EventCategory,
  type EventPage,
  type EventQuery,
  type EventSummary,
  type NotificationSettings,
  type Severity,
} from "@/lib/events/client";
import { cn } from "@/lib/utils";

const PAGE = 50;
const POLL_MS = 5000;

const SEVERITY_TONE: Record<Severity, string> = {
  debug: "bg-[var(--pc-line)] text-[var(--pc-muted)]",
  info: "bg-[var(--pc-accent-soft)] text-[var(--pc-accent)]",
  warning: "bg-[#f1c40f]/20 text-[#d4a20a]",
  error: "bg-[var(--pc-warn-soft)] text-[var(--pc-warn)]",
  critical: "bg-[var(--pc-warn)] text-[#1a0f08]",
};

const RANGES = [
  { id: "1h", label: "Last hour", ms: 3_600_000 },
  { id: "24h", label: "Last 24 hours", ms: 86_400_000 },
  { id: "7d", label: "Last 7 days", ms: 7 * 86_400_000 },
  { id: "30d", label: "Last 30 days", ms: 30 * 86_400_000 },
  { id: "all", label: "Any time", ms: 0 },
  { id: "custom", label: "Dates…", ms: 0 },
] as const;
type RangeId = (typeof RANGES)[number]["id"];

const when = (ms: number) => new Date(ms).toLocaleString([], { dateStyle: "short", timeStyle: "medium" });
const fieldClass =
  "h-11 min-h-11 min-w-0 rounded-xl border border-[var(--pc-line)] bg-[var(--pc-paper)] px-2 text-xs text-[var(--pc-ink)] outline-none focus-visible:border-[var(--pc-accent)]";

/** Today-style date input value ↔ ms. */
const dayStart = (value: string) => (value ? new Date(`${value}T00:00:00`).getTime() : undefined);
const dayEnd = (value: string) => (value ? new Date(`${value}T23:59:59.999`).getTime() : undefined);

export function EventsPanel() {
  const desk = useDesk();
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [severity, setSeverity] = useState<Severity | "">("");
  const [category, setCategory] = useState<EventCategory | "">("");
  const [device, setDevice] = useState("");
  const [run, setRun] = useState("");
  const [range, setRange] = useState<RangeId>("7d");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [now, setNow] = useState(() => Date.now());

  // Typing settles for a moment before searching.
  useEffect(() => {
    const timer = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const query: EventQuery = useMemo(() => {
    const preset = RANGES.find((r) => r.id === range);
    return {
      q: q || undefined,
      severity: severity || undefined,
      category: category || undefined,
      device: device || undefined,
      run: run || undefined,
      since: range === "custom" ? dayStart(from) : preset && preset.ms > 0 ? now - preset.ms : undefined,
      until: range === "custom" ? dayEnd(to) : undefined,
      limit: PAGE,
    };
  }, [q, severity, category, device, run, range, from, to, now]);
  const key = JSON.stringify({ ...query, since: range === "custom" ? query.since : range });

  const [result, setResult] = useState<{ key: string; page?: EventPage; error?: string } | null>(null);
  const [extra, setExtra] = useState<{ key: string; events: AppEvent[]; hasMore: boolean; nextBefore?: number } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const agent = hasAgent();

  useEffect(() => {
    if (!agent) return;
    let live = true;
    fetchEvents(query).then(
      (page) => {
        if (!live) return;
        setResult({ key, page });
        // A refresh keeps older pages already loaded; new filters start over.
        setExtra((prev) => (prev?.key === key ? prev : null));
        if (page.events[0]) markEventsSeen(page.events[0].id);
      },
      (error: unknown) => live && setResult({ key, error: error instanceof Error ? error.message : "Could not load events" }),
    );
    return () => {
      live = false;
    };
    // `query` changes with `key`; `refresh` reloads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, refresh, agent]);

  // New events show up on their own while the page is open.
  useEffect(() => {
    if (!agent) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") {
        setNow(Date.now());
        setRefresh((n) => n + 1);
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [agent]);

  const page = result?.page;
  const loading = agent && result?.key !== key;
  const events = useMemo(() => {
    if (!page) return [];
    const seen = new Set<number>();
    return [...page.events, ...(extra?.key === key ? extra.events : [])].filter((e) => !seen.has(e.id) && seen.add(e.id));
  }, [page, extra, key]);
  const hasMore = extra?.key === key ? extra.hasMore : (page?.hasMore ?? false);
  const nextBefore = extra?.key === key ? extra.nextBefore : page?.nextBefore;

  const loadMore = async () => {
    if (!nextBefore) return;
    setLoadingMore(true);
    try {
      const more = await fetchEvents({ ...query, before: nextBefore });
      setExtra((prev) => ({
        key,
        events: [...(prev?.key === key ? prev.events : []), ...more.events],
        hasMore: more.hasMore,
        nextBefore: more.nextBefore,
      }));
    } catch {
      // keep what is shown; the button stays to try again
    } finally {
      setLoadingMore(false);
    }
  };

  const devices = useMemo(() => {
    const map = new Map(desk.devices.map((d) => [d.id, d.name]));
    for (const e of events) if (e.deviceId && !map.has(e.deviceId)) map.set(e.deviceId, e.deviceName ?? e.deviceId);
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [desk.devices, events]);

  const filtered = Boolean(q || severity || category || device || run || range !== "7d");
  const reset = () => {
    setSearch("");
    setQ("");
    setSeverity("");
    setCategory("");
    setDevice("");
    setRun("");
    setRange("7d");
  };

  if (!agent) {
    return (
      <PanelFrame title="Events" panel="events" clean description="What happened to your phones, macros and ADBoard.">
        <p className="rounded-xl border border-dashed border-[var(--pc-line)] p-4 text-sm text-[var(--pc-muted)]">{NO_AGENT}.</p>
      </PanelFrame>
    );
  }

  return (
    <PanelFrame title="Events" panel="events" clean description="What happened to your phones, macros and ADBoard, kept across restarts.">
      <SummaryCard
        refresh={refresh}
        onDevice={(name) => {
          const match = devices.find(([, n]) => n === name);
          if (match) setDevice(match[0]);
        }}
        onProblems={() => {
          reset();
          setSeverity("warning");
        }}
        onMacroFailures={() => {
          reset();
          setCategory("macro");
          setSeverity("error");
        }}
      />

      <Card title="History" data-events-history>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-[minmax(0,2fr)_repeat(4,minmax(0,1fr))]" data-events-filters>
          <label className="relative flex min-w-0 items-center sm:col-span-2 xl:col-span-1">
            <span className="sr-only">Search events</span>
            <Search className="pointer-events-none absolute left-2.5 size-3.5 text-[var(--pc-muted)]" aria-hidden />
            <input
              type="search"
              value={search}
              placeholder="Search: phone, macro, error, run id…"
              onChange={(event) => setSearch(event.target.value)}
              className={cn(fieldClass, "w-full pl-8")}
              data-events-search
            />
          </label>
          <select aria-label="Severity" value={severity} onChange={(e) => setSeverity(e.target.value as Severity | "")} className={fieldClass} data-events-severity>
            <option value="">All severities</option>
            <option value="info">Info and up</option>
            <option value="warning">Warnings and errors</option>
            <option value="error">Errors only</option>
            <option value="critical">Critical</option>
          </select>
          <select aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value as EventCategory | "")} className={fieldClass} data-events-category>
            <option value="">All categories</option>
            {(Object.keys(CATEGORY_LABEL) as EventCategory[]).map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
          <select aria-label="Phone" value={device} onChange={(e) => setDevice(e.target.value)} className={fieldClass} data-events-device>
            <option value="">All phones</option>
            {devices.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
          <select aria-label="Time" value={range} onChange={(e) => setRange(e.target.value as RangeId)} className={fieldClass} data-events-range>
            {RANGES.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
        {range === "custom" && (
          <div className="flex flex-wrap items-end gap-2" data-events-dates>
            <label className="flex flex-col gap-1 text-xs text-[var(--pc-muted)]">
              From
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={fieldClass} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-[var(--pc-muted)]">
              To
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={fieldClass} />
            </label>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--pc-muted)]">
          <span data-events-total={page?.total ?? 0}>
            {loading ? "Loading…" : page ? `${page.total} event${page.total === 1 ? "" : "s"}` : ""}
          </span>
          {run && (
            <button type="button" className="pc-toggle pc-toggle-sm" onClick={() => setRun("")}>
              Run {run} ×
            </button>
          )}
          {filtered && (
            <button type="button" className="text-[var(--pc-accent)]" onClick={reset} data-events-reset>
              Clear filters
            </button>
          )}
          <GhostButton className="ml-auto" onClick={() => setRefresh((n) => n + 1)}>
            <RefreshCw className="size-3.5" aria-hidden /> Refresh
          </GhostButton>
        </div>

        {result?.error && (
          <p className="rounded-xl bg-[var(--pc-warn-soft)] px-3 py-2 text-xs text-[var(--pc-warn)]" role="alert">
            {result.error}
          </p>
        )}
        {!loading && page && events.length === 0 && (
          <p className="rounded-xl border border-dashed border-[var(--pc-line)] p-6 text-center text-xs text-[var(--pc-muted)]" data-events-empty>
            {filtered ? "No events match these filters." : "Nothing has happened yet. Phone connections, macro runs and errors will show up here."}
          </p>
        )}
        <ol className="flex flex-col gap-1" data-events-list>
          {events.map((event) => (
            <EventRow
              key={event.id}
              event={event}
              onRun={(id) => setRun(id)}
              onDevice={(id) => setDevice(id)}
              onOpenPhone={(id) => desk.open("control", undefined, id)}
              onOpenMacro={(tabId) => {
                setActiveTab(tabId);
                desk.open("macros");
              }}
            />
          ))}
        </ol>
        {hasMore && (
          <GhostButton disabled={loadingMore} onClick={() => void loadMore()} className="self-center" data-events-more>
            {loadingMore ? "Loading…" : "Older events"}
          </GhostButton>
        )}
      </Card>

      <RetentionCard onCleared={() => setRefresh((n) => n + 1)} />
    </PanelFrame>
  );
}

function EventRow({
  event,
  onRun,
  onDevice,
  onOpenPhone,
  onOpenMacro,
}: {
  event: AppEvent;
  onRun: (runId: string) => void;
  onDevice: (deviceId: string) => void;
  onOpenPhone: (deviceId: string) => void;
  onOpenMacro: (tabId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const meta = Object.entries(event.meta ?? {});
  const tabId = typeof event.meta?.tabId === "string" ? event.meta.tabId : null;
  return (
    <li className="rounded-xl border border-[var(--pc-line)] bg-[var(--pc-paper)]" data-event={event.kind} data-severity={event.severity}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex min-h-11 w-full items-center gap-2 px-2 py-1.5 text-left">
        {open ? <ChevronDown className="size-3.5 shrink-0 text-[var(--pc-muted)]" aria-hidden /> : <ChevronRight className="size-3.5 shrink-0 text-[var(--pc-muted)]" aria-hidden />}
        <span className={cn("w-16 shrink-0 rounded px-1.5 py-0.5 text-center font-mono text-[11px] font-semibold", SEVERITY_TONE[event.severity])}>{event.severity}</span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-xs text-[var(--pc-ink)]">
            {event.summary}
            {event.repeats ? <span className="ml-1.5 font-mono text-[11px] text-[var(--pc-muted)]">×{event.repeats + 1}</span> : null}
          </span>
          <span className="truncate font-mono text-[11px] text-[var(--pc-muted)]">
            {when(event.at)} · {CATEGORY_LABEL[event.category] ?? event.category}
            {event.deviceName ? ` · ${event.deviceName}` : ""}
          </span>
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-2 border-t border-[var(--pc-line)] p-2 text-xs" data-event-detail>
          {event.detail && <p className="whitespace-pre-wrap break-words text-[var(--pc-ink)]">{event.detail}</p>}
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 font-mono text-[11px]">
            <dt className="text-[var(--pc-muted)]">kind</dt>
            <dd className="break-all text-[var(--pc-ink)]">{event.kind}</dd>
            <dt className="text-[var(--pc-muted)]">source</dt>
            <dd className="text-[var(--pc-ink)]">{event.source}</dd>
            {event.repeats ? (
              <>
                <dt className="text-[var(--pc-muted)]">repeated</dt>
                <dd className="text-[var(--pc-ink)]">
                  {event.repeats} more time{event.repeats === 1 ? "" : "s"}
                  {event.lastAt ? `, last ${when(event.lastAt)}` : ""}
                </dd>
              </>
            ) : null}
            {event.runId && (
              <>
                <dt className="text-[var(--pc-muted)]">run</dt>
                <dd className="text-[var(--pc-ink)]">{event.runId}</dd>
              </>
            )}
            {meta
              .filter(([k]) => k !== "tabId")
              .map(([k, v]) => (
                <span key={k} className="contents">
                  <dt className="text-[var(--pc-muted)]">{k}</dt>
                  <dd className="break-all text-[var(--pc-ink)]">{typeof v === "string" ? v : JSON.stringify(v)}</dd>
                </span>
              ))}
          </dl>
          <div className="flex flex-wrap gap-1.5">
            {event.deviceId && (
              <>
                <GhostButton onClick={() => onDevice(event.deviceId!)}>Only {event.deviceName ?? "this phone"}</GhostButton>
                <GhostButton onClick={() => onOpenPhone(event.deviceId!)}>Open phone</GhostButton>
              </>
            )}
            {event.runId && <GhostButton onClick={() => onRun(event.runId!)}>Whole run</GhostButton>}
            {tabId && <GhostButton onClick={() => onOpenMacro(tabId)}>Open macro</GhostButton>}
          </div>
        </div>
      )}
    </li>
  );
}

/** Counts for the last 24 hours, recent problems and Discord delivery. */
function SummaryCard({
  refresh,
  onDevice,
  onProblems,
  onMacroFailures,
}: {
  refresh: number;
  onDevice: (name: string) => void;
  onProblems: () => void;
  onMacroFailures: () => void;
}) {
  const [summary, setSummary] = useState<EventSummary | null>(null);
  const [notify, setNotify] = useState<NotificationSettings | null>(null);
  useEffect(() => {
    let live = true;
    fetchSummary(Date.now() - 86_400_000).then((s) => live && setSummary(s), () => {});
    fetchNotifications().then((n) => live && setNotify(n), () => {});
    return () => {
      live = false;
    };
  }, [refresh]);
  if (!summary) return null;
  const problems = (summary.bySeverity.warning ?? 0) + (summary.bySeverity.error ?? 0) + (summary.bySeverity.critical ?? 0);
  const runs = summary.macroRuns;
  const finished = runs.done + runs.failed + runs.stopped;
  const phones = Object.entries(summary.problemDevices).sort((a, b) => b[1] - a[1]).slice(0, 6);
  return (
    <Card title="Last 24 hours" data-events-summary>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <button type="button" onClick={onProblems} className="flex flex-col rounded-xl border border-[var(--pc-line)] p-2 text-left hover:bg-[var(--pc-accent-soft)]" data-events-stat="problems">
          <span className={cn("font-display text-xl font-semibold", problems ? "text-[var(--pc-warn)]" : "text-[var(--pc-ink)]")}>{problems}</span>
          <span className="text-[11px] text-[var(--pc-muted)]">
            warnings & errors{summary.bySeverity.critical ? ` · ${summary.bySeverity.critical} critical` : ""}
          </span>
        </button>
        <button type="button" onClick={onMacroFailures} className="flex flex-col rounded-xl border border-[var(--pc-line)] p-2 text-left hover:bg-[var(--pc-accent-soft)]" data-events-stat="macros">
          <span className="font-display text-xl font-semibold text-[var(--pc-ink)]">
            {finished ? `${Math.round((runs.done / finished) * 100)}%` : "—"}
          </span>
          <span className="text-[11px] text-[var(--pc-muted)]">
            macro runs OK · {runs.done} done, {runs.failed} failed, {runs.stopped} stopped
          </span>
        </button>
        <div className="flex flex-col rounded-xl border border-[var(--pc-line)] p-2" data-events-stat="phones">
          <span className="font-display text-xl font-semibold text-[var(--pc-ink)]">{summary.byCategory.device ?? 0}</span>
          <span className="text-[11px] text-[var(--pc-muted)]">phone connection changes</span>
        </div>
        <div className="flex flex-col rounded-xl border border-[var(--pc-line)] p-2" data-events-stat="discord">
          <span className="font-display text-xl font-semibold text-[var(--pc-ink)]">
            {!notify?.webhookSet ? "Off" : !notify.enabled ? "Paused" : notify.status.lastError && (notify.status.lastErrorAt ?? 0) > (notify.status.lastOkAt ?? 0) ? "Failing" : "On"}
          </span>
          <span className="text-[11px] text-[var(--pc-muted)]">
            Discord{notify?.webhookSet ? ` · ${notify.status.sent} sent${notify.status.failed ? `, ${notify.status.failed} failed` : ""}` : " · set up in Settings"}
          </span>
        </div>
      </div>
      {phones.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-[var(--pc-muted)]">Phones with problems:</span>
          {phones.map(([name, count]) => (
            <button key={name} type="button" className="pc-toggle pc-toggle-sm" onClick={() => onDevice(name)}>
              {name} <span className="font-mono text-[var(--pc-warn)]">{count}</span>
            </button>
          ))}
        </div>
      )}
    </Card>
  );
}

/** How much history is kept, and clearing it. */
function RetentionCard({ onCleared }: { onCleared: () => void }) {
  const [settings, setSettings] = useState<NotificationSettings | null>(null);
  const [draft, setDraft] = useState<{ maxEvents: number; maxDays: number } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | "all" | "old">(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    fetchNotifications().then((s) => live && setSettings(s), () => {});
    return () => {
      live = false;
    };
  }, []);
  if (!settings) return null;
  const value = draft ?? settings.history;
  const changed = draft !== null && (draft.maxEvents !== settings.history.maxEvents || draft.maxDays !== settings.history.maxDays);
  const save = async () => {
    setBusy(true);
    try {
      const next = await saveNotifications({ history: value });
      setSettings(next);
      setDraft(null);
      setNote("Saved. Older events beyond the limits were removed.");
      onCleared();
    } catch (error) {
      setNote(error instanceof Error ? error.message : "Could not save");
    } finally {
      setBusy(false);
    }
  };
  const clear = async (kind: "all" | "old") => {
    setBusy(true);
    try {
      const { removed } = await clearEvents(kind === "old" ? Date.now() - 7 * 86_400_000 : undefined);
      setNote(`${removed} event${removed === 1 ? "" : "s"} removed.`);
      onCleared();
    } catch (error) {
      setNote(error instanceof Error ? error.message : "Could not clear the history");
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };
  return (
    <Card title="Keep history" data-events-retention>
      <p className="text-xs text-[var(--pc-muted)]">
        Saved in <span className="font-mono">logs/events.jsonl</span> in the data folder. The oldest events are removed when either limit is reached.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <NumField label="Up to" suffix="events" value={value.maxEvents} min={100} max={200_000} onChange={(maxEvents) => setDraft({ ...value, maxEvents })} className="w-40" data-events-max />
        <NumField label="For" suffix="days" value={value.maxDays} min={0} max={3650} onChange={(maxDays) => setDraft({ ...value, maxDays })} className="w-32" title="0 = no age limit" data-events-days />
        <button type="button" className="pc-toggle pc-toggle-md" disabled={!changed || busy} onClick={() => void save()} data-events-retention-save>
          Save
        </button>
        <span className="ml-auto flex flex-wrap gap-1.5">
          <GhostButton disabled={busy} onClick={() => setConfirm("old")}>
            Clear older than 7 days
          </GhostButton>
          <GhostButton disabled={busy} onClick={() => setConfirm("all")} data-events-clear>
            <Trash2 className="size-3.5" aria-hidden /> Clear all
          </GhostButton>
        </span>
      </div>
      {note && (
        <p className="text-xs text-[var(--pc-muted)]" role="status">
          {note}
        </p>
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm === "all" ? "Clear the whole event history?" : "Clear events older than 7 days?"}
          body="This cannot be undone. Notifications and settings are not affected."
          confirmLabel={confirm === "all" ? "Clear all" : "Clear old events"}
          busy={busy}
          requirePhrase={confirm === "all" ? "clear" : undefined}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void clear(confirm)}
        />
      )}
    </Card>
  );
}
