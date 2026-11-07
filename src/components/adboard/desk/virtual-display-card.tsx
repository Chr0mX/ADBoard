"use client";

import { useCallback, useEffect, useState } from "react";
import { useStoredString } from "@/hooks/use-stored-flag";
import { NO_AGENT, hasAgent } from "@/lib/events/client";
import {
  DEFAULTS_KEY,
  SIZE_PRESETS,
  parseDefaults,
  presetIdFor,
  serializeDefaults,
  specError,
  type VirtualDisplaySpec,
} from "@/lib/devices/virtual-display";
import {
  closeVirtualDisplay,
  getVirtualDisplayOverview,
  setVirtualDisplayLimit,
  type VirtualDisplayOverview,
} from "@/lib/devices/virtual-display-client";
import { cn } from "@/lib/utils";

const FIELD =
  "h-11 min-h-11 min-w-0 rounded-xl border border-[var(--pc-line)] bg-[var(--pc-paper)] px-2 text-xs text-[var(--pc-ink)] outline-none focus-visible:border-[var(--pc-accent)]";

/**
 * Settings for virtual displays (independent Android screens on a phone):
 * how many each phone may have, what the Add dialog starts from, and the
 * displays that exist now.
 */
export function VirtualDisplayCard() {
  const agent = hasAgent();
  const [overview, setOverview] = useState<VirtualDisplayOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rawDefaults, setRawDefaults] = useStoredString(DEFAULTS_KEY);
  const saved = parseDefaults(rawDefaults);
  const [edit, setEdit] = useState<VirtualDisplaySpec | null>(null);
  const spec = edit ?? saved;
  const problem = specError(spec);

  const load = useCallback(async () => {
    try {
      setOverview(await getVirtualDisplayOverview());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "ADBoard is not reachable");
    }
  }, []);

  useEffect(() => {
    if (!agent) return;
    const first = setTimeout(() => void load(), 0);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 10_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [agent, load]);

  async function act(work: () => Promise<unknown>) {
    setBusy(true);
    try {
      await work();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  const change = (patch: Partial<VirtualDisplaySpec>) => {
    const next = { ...spec, ...patch };
    setEdit(next);
    if (specError(next) === null) setRawDefaults(serializeDefaults(next));
  };

  const displays = overview?.displays ?? [];
  const limitValue = overview ? (overview.saved === null ? "default" : String(overview.saved)) : "default";

  return (
    <section className="@container flex min-w-0 flex-col gap-3 rounded-xl border border-[var(--pc-line)] bg-[var(--pc-panel)] p-4" data-settings-virtual-display>
      <h3 className="font-display text-sm font-semibold text-[var(--pc-ink)]">Virtual displays</h3>
      <p className="text-xs text-[var(--pc-muted)]">
        An independent Android screen on a phone that runs its own apps. Add one from a phone&apos;s ⋯ menu in Control. Needs Android 13 or newer; no audio yet.
      </p>
      {!agent && <p className="text-xs text-[var(--pc-muted)]">{NO_AGENT}.</p>}
      {agent && !overview && <p className="text-xs text-[var(--pc-muted)]">{error ?? "Loading…"}</p>}

      {overview && (
        <label className="flex flex-col gap-2 py-1 @md:flex-row @md:items-center @md:justify-between">
          <span className="flex min-w-0 flex-col">
            <span className="text-sm text-[var(--pc-ink)]">Displays per phone</span>
            <span className="text-[11px] text-[var(--pc-muted)]">Each one is another video stream and encode on the phone. Lowering this keeps the ones that exist.</span>
          </span>
          <select
            className={cn(FIELD, "w-full @md:w-48 @md:shrink-0")}
            value={limitValue}
            disabled={busy}
            onChange={(e) => void act(() => setVirtualDisplayLimit(e.target.value === "default" ? null : Number(e.target.value)))}
            data-virtual-limit
          >
            <option value="default">Default ({overview.envLimit})</option>
            {Array.from({ length: overview.ceiling }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="flex flex-col gap-2" data-virtual-defaults>
        <h4 className="font-display text-xs font-semibold text-[var(--pc-ink)]">New display starts as</h4>
        <label className="flex flex-col gap-1 text-xs text-[var(--pc-muted)]">
          Size
          <select
            className={FIELD}
            value={presetIdFor(spec)}
            onChange={(e) => {
              const p = SIZE_PRESETS.find((x) => x.id === e.target.value);
              if (p) change({ width: p.width, height: p.height, dpi: p.dpi });
            }}
          >
            {SIZE_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
            {presetIdFor(spec) === "custom" && <option value="custom">Custom</option>}
          </select>
        </label>
        <div className="grid grid-cols-3 gap-2">
          {(["width", "height", "dpi"] as const).map((key) => (
            <label key={key} className="flex flex-col gap-1 text-xs text-[var(--pc-muted)]">
              {key === "dpi" ? "Density" : key === "width" ? "Width" : "Height"}
              <input className={FIELD} type="number" inputMode="numeric" value={spec[key]} onChange={(e) => change({ [key]: Number(e.target.value) })} />
            </label>
          ))}
        </div>
        <label className="flex flex-col gap-1 text-xs text-[var(--pc-muted)]">
          App to start (optional)
          <input
            className={FIELD}
            value={spec.startApp ?? ""}
            placeholder="org.mozilla.firefox"
            data-mono
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(e) => change({ startApp: e.target.value })}
          />
        </label>
        <p className={cn("text-[11px]", problem ? "text-[var(--pc-warn)]" : "text-[var(--pc-muted)]")}>
          {problem ?? "Saved in this browser. The Add dialog also remembers what you used last."}
        </p>
      </div>

      {overview && (
        <div className="flex flex-col gap-1" data-virtual-list>
          <div className="flex items-center justify-between gap-2">
            <h4 className="font-display text-xs font-semibold text-[var(--pc-ink)]">Running now</h4>
            {displays.length > 1 && (
              <button
                type="button"
                className="pc-toggle pc-toggle-sm"
                disabled={busy}
                onClick={() => void act(() => Promise.all(displays.map((d) => closeVirtualDisplay(d.key))))}
                data-virtual-close-all
              >
                Close all
              </button>
            )}
          </div>
          {displays.length === 0 && <p className="text-[11px] text-[var(--pc-muted)]">None.</p>}
          {displays.map((d) => (
            <div key={d.key} className="flex items-center justify-between gap-2 py-1" data-virtual-row={d.key}>
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm text-[var(--pc-ink)]">
                  {d.phoneName} · display {d.index}
                </span>
                <span className="truncate text-[11px] text-[var(--pc-muted)]">
                  {d.width} × {d.height}, {d.dpi} dpi{d.startApp ? `, ${d.startApp}` : ""}
                  {d.displayId !== null ? `, id ${d.displayId}` : ""}
                </span>
              </span>
              <button type="button" className="pc-toggle pc-toggle-sm" disabled={busy} onClick={() => void act(() => closeVirtualDisplay(d.key))}>
                Close
              </button>
            </div>
          ))}
        </div>
      )}
      {error && overview && <p className="text-xs text-[var(--pc-warn)]">{error}</p>}
    </section>
  );
}
