"use client";

import { useEffect, useId, useState } from "react";
import type { Device } from "@/lib/devices/types";
import { useStoredString } from "@/hooks/use-stored-flag";
import {
  DEFAULTS_KEY,
  SIZE_PRESETS,
  isVirtualKey,
  parseDefaults,
  presetIdFor,
  serializeDefaults,
  specError,
  validComponent,
  type VirtualDisplaySpec,
} from "@/lib/devices/virtual-display";
import { closeVirtualDisplay, createVirtualDisplay, launchOnVirtualDisplay } from "@/lib/devices/virtual-display-client";

const FIELD =
  "h-11 min-w-0 rounded-xl border border-[var(--pc-line)] bg-[var(--pc-paper)] px-3 text-sm text-[var(--pc-ink)] outline-none focus-visible:border-[var(--pc-accent)]";

/**
 * Add a virtual display to a phone, or launch an app on / close one.
 * A virtual display is an independent Android screen made by the agent; it
 * appears as one more device once created.
 */
export function VirtualDisplayDialog({ device, onClose }: { device: Device; onClose: () => void }) {
  const virtual = isVirtualKey(device.serial);
  const titleId = useId();
  const [storedDefaults, setStoredDefaults] = useStoredString(DEFAULTS_KEY);
  const [spec, setSpec] = useState<VirtualDisplaySpec>(() => parseDefaults(storedDefaults));
  const [preset, setPreset] = useState(() => presetIdFor(parseDefaults(storedDefaults)));
  const [component, setComponent] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function act(work: () => Promise<string | void>) {
    setBusy(true);
    setNote(null);
    try {
      const done = await work();
      if (done) setNote({ ok: true, text: done });
      return true;
    } catch (error) {
      setNote({ ok: false, text: error instanceof Error ? error.message : "Failed" });
      return false;
    } finally {
      setBusy(false);
    }
  }

  const setNumber = (key: "width" | "height" | "dpi") => (event: React.ChangeEvent<HTMLInputElement>) => {
    setPreset("custom");
    setSpec((prev) => ({ ...prev, [key]: Number(event.target.value) }));
  };
  const problem = virtual ? null : specError(spec);
  const componentProblem = component.trim() && !validComponent(component.trim()) ? "Use package/.Activity, for example com.android.settings/.Settings." : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" data-virtual-display-dialog>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[calc(100dvh-2rem)] w-full max-w-sm flex-col gap-3 overflow-y-auto rounded-xl border border-[var(--pc-line)] bg-[var(--pc-paper)] p-4 shadow-lg"
      >
        <h3 id={titleId} className="font-display text-base font-semibold text-[var(--pc-ink)]">
          {virtual ? "Virtual display" : "Add a virtual display"}
        </h3>
        <p className="text-sm text-[var(--pc-muted)]">
          {virtual
            ? `${device.name} is a separate Android screen on the phone. Apps you start here do not appear on the phone's own screen.`
            : `A second, independent screen on ${device.name}. It runs its own apps and shows up as another phone. Needs Android 13 or newer.`}
        </p>

        {virtual ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (busy || !component.trim() || componentProblem) return;
              void act(async () => {
                await launchOnVirtualDisplay(device.serial, component.trim());
                return "Started.";
              });
            }}
          >
            <label className="flex flex-col gap-1 text-sm text-[var(--pc-ink)]">
              Start an app on this display
              <input
                className={FIELD}
                value={component}
                placeholder="com.android.settings/.Settings"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                onChange={(event) => setComponent(event.target.value)}
                data-virtual-component
              />
            </label>
            {componentProblem && <p className="text-xs text-[var(--pc-warn)]">{componentProblem}</p>}
            <div className="flex flex-wrap gap-2">
              <button
                className="pc-toggle pc-toggle-md"
                disabled={busy || !component.trim() || !!componentProblem}
                type="submit"
                data-virtual-launch
              >
                Start app
              </button>
              <button
                type="button"
                className="pc-toggle pc-toggle-md"
                disabled={busy}
                onClick={() => void act(async () => { await closeVirtualDisplay(device.serial); onClose(); })}
                data-virtual-close
              >
                Close display
              </button>
            </div>
          </form>
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (busy || problem) return;
              void act(async () => {
                await createVirtualDisplay(device.id, spec);
                // The next dialog starts from what was just used.
                setStoredDefaults(serializeDefaults(spec));
                onClose();
              });
            }}
          >
            <label className="flex flex-col gap-1 text-sm text-[var(--pc-ink)]">
              Size
              <select
                className={FIELD}
                value={preset}
                onChange={(event) => {
                  const next = SIZE_PRESETS.find((p) => p.id === event.target.value);
                  setPreset(event.target.value);
                  if (next) setSpec((prev) => ({ ...prev, width: next.width, height: next.height, dpi: next.dpi }));
                }}
                data-virtual-preset
              >
                {SIZE_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
                {preset === "custom" && <option value="custom">Custom</option>}
              </select>
            </label>
            <div className="grid grid-cols-3 gap-2">
              {(["width", "height", "dpi"] as const).map((key) => (
                <label key={key} className="flex flex-col gap-1 text-xs text-[var(--pc-muted)]">
                  {key === "dpi" ? "Density (dpi)" : key === "width" ? "Width" : "Height"}
                  <input className={FIELD} type="number" inputMode="numeric" value={spec[key]} onChange={setNumber(key)} data-virtual-field={key} />
                </label>
              ))}
            </div>
            <label className="flex flex-col gap-1 text-sm text-[var(--pc-ink)]">
              App to start (optional)
              <input
                className={FIELD}
                value={spec.startApp ?? ""}
                placeholder="org.mozilla.firefox"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                onChange={(event) => setSpec((prev) => ({ ...prev, startApp: event.target.value }))}
                data-virtual-start-app
              />
            </label>
            {problem && <p className="text-xs text-[var(--pc-warn)]">{problem}</p>}
            <div className="flex flex-wrap gap-2">
              <button
                className="pc-toggle pc-toggle-md"
                disabled={busy || !!problem}
                type="submit"
                data-virtual-create
              >
                {busy ? "Creating…" : "Create display"}
              </button>
            </div>
          </form>
        )}
        {note && (
          <p className={note.ok ? "text-xs text-[var(--pc-signal)]" : "text-xs text-[var(--pc-warn)]"} role="status" data-virtual-note>
            {note.text}
          </p>
        )}
        <div className="flex justify-end">
          <button type="button" className="pc-toggle pc-toggle-md" onClick={onClose}>
            {note || virtual ? "Done" : "Cancel"}
          </button>
        </div>
      </div>
    </div>
  );
}
