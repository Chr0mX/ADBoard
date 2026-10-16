"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  MAX_REFERENCE,
  MIN_REFERENCE,
  REFERENCE_PRESETS,
  parseMacroFile,
  type ImportResult,
  type Size,
} from "@/lib/macro/core";
import type { Device } from "@/lib/devices/types";
import { NumField, Segmented } from "@/components/phone-control/macros/fields";

const FORMAT_LABEL: Record<ImportResult["format"], string> = {
  adboard: "ADBoard macros",
  autoclicker: "Auto Clicker configs",
  "desk-macro": "ADBoard Automate macro (older)",
  "desk-library": "ADBoard desk export (older)",
};

/**
 * Review a file before it touches the saved tabs: what it is, the screen it
 * was made on (Auto Clicker files do not say), warnings, add or replace.
 */
export function ImportDialog({
  fileName,
  text,
  devices,
  onCancel,
  onImport,
}: {
  fileName: string;
  text: string;
  devices: Device[];
  onCancel: () => void;
  onImport: (result: ImportResult, mode: "add" | "replace") => void;
}) {
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [reference, setReference] = useState<Size | null>(null);
  const [mode, setMode] = useState<"add" | "replace">("add");

  const { result, error } = useMemo(() => {
    try {
      return { result: parseMacroFile(text, { fileName, reference: reference ?? undefined }), error: null };
    } catch (err) {
      return { result: null, error: err instanceof Error ? err.message : "Could not read the file" };
    }
  }, [text, fileName, reference]);
  const needsReference = Boolean(result && (result.guessedReference || reference));
  const shown = reference ?? result?.tabs[0]?.reference ?? { width: 1080, height: 2400 };

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const steps = result?.tabs.reduce((sum, t) => sum + t.steps.length, 0) ?? 0;
  const multi = result?.tabs.reduce((sum, t) => sum + t.steps.filter((s) => s.fingers.length > 1).length, 0) ?? 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" data-macro-import>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[90dvh] w-full max-w-lg flex-col gap-3 overflow-y-auto rounded-2xl border border-[var(--pc-line)] bg-[var(--pc-paper)] p-4 shadow-lg"
      >
        <h3 id={titleId} className="font-display text-base font-semibold text-[var(--pc-ink)]">
          Import macros
        </h3>
        <p className="truncate font-mono text-[11px] text-[var(--pc-muted)]">{fileName}</p>

        {error && (
          <p role="alert" className="rounded-xl bg-[var(--pc-warn-soft)] p-3 text-sm text-[var(--pc-warn)]">
            {error}
          </p>
        )}

        {result && (
          <>
            <div className="rounded-xl border border-[var(--pc-line)] p-3 text-sm text-[var(--pc-ink)]" data-import-summary>
              <p className="font-medium">{FORMAT_LABEL[result.format]}</p>
              <p className="mt-1 text-xs text-[var(--pc-muted)]">
                {result.tabs.length} tab{result.tabs.length === 1 ? "" : "s"} · {steps} step{steps === 1 ? "" : "s"}
                {multi ? ` · ${multi} multi-touch` : ""}
              </p>
              <ul className="mt-2 flex flex-wrap gap-1">
                {result.tabs.slice(0, 20).map((tab) => (
                  <li key={tab.id} className="rounded-md bg-[var(--pc-accent-soft)] px-1.5 py-0.5 text-[11px]">
                    {tab.name}
                  </li>
                ))}
                {result.tabs.length > 20 && <li className="text-[11px] text-[var(--pc-muted)]">+{result.tabs.length - 20} more</li>}
              </ul>
            </div>

            {needsReference && (
              <div className="flex flex-col gap-2 rounded-xl border border-[var(--pc-line)] p-3" data-import-reference>
                <p className="text-sm text-[var(--pc-ink)]">Screen it was made on</p>
                <p className="text-xs text-[var(--pc-muted)]">
                  This file stores pixel positions but not the screen size. {reference ? "" : `Guessed ${shown.width}×${shown.height} from the furthest point.`}{" "}
                  Pick the resolution of the phone or emulator it came from; touches are then scaled to each phone.
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <NumField
                    label="Width"
                    suffix="px"
                    value={shown.width}
                    min={MIN_REFERENCE}
                    max={MAX_REFERENCE}
                    onChange={(width) => setReference({ ...shown, width })}
                  />
                  <NumField
                    label="Height"
                    suffix="px"
                    value={shown.height}
                    min={MIN_REFERENCE}
                    max={MAX_REFERENCE}
                    onChange={(height) => setReference({ ...shown, height })}
                  />
                </div>
                <div className="flex flex-wrap gap-1">
                  {REFERENCE_PRESETS.map((p) => (
                    <button
                      key={`${p.width}x${p.height}`}
                      type="button"
                      onClick={() => setReference({ ...p })}
                      aria-pressed={shown.width === p.width && shown.height === p.height}
                      className="h-8 rounded-lg border border-[var(--pc-line)] px-2 font-mono text-[10px] text-[var(--pc-ink)] aria-pressed:border-[var(--pc-accent)] aria-pressed:text-[var(--pc-accent)]"
                    >
                      {p.width}×{p.height}
                    </button>
                  ))}
                  {devices
                    .filter((d) => d.resolution.width > 0)
                    .map((d) => (
                      <button
                        key={d.id}
                        type="button"
                        onClick={() => setReference({ ...d.resolution })}
                        className="h-8 rounded-lg border border-[var(--pc-line)] px-2 text-[10px] text-[var(--pc-ink)]"
                      >
                        {d.name} {d.resolution.width}×{d.resolution.height}
                      </button>
                    ))}
                </div>
              </div>
            )}

            {result.warnings.length > 0 && (
              <details className="rounded-xl border border-[var(--pc-line)] p-3 text-xs text-[var(--pc-warn)]" open={result.warnings.length <= 4}>
                <summary className="cursor-pointer">
                  {result.warnings.length} note{result.warnings.length === 1 ? "" : "s"}
                </summary>
                <ul className="mt-2 flex list-disc flex-col gap-1 pl-4 text-[var(--pc-muted)]">
                  {result.warnings.slice(0, 50).map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </details>
            )}

            <Segmented
              label="Into this browser's tabs"
              name="macro-import-mode"
              value={mode}
              onChange={setMode}
              options={[
                { id: "add", label: "Add as new tabs" },
                { id: "replace", label: "Replace all tabs" },
              ]}
            />
          </>
        )}

        <div className="flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="h-11 min-h-11 rounded-xl border border-[var(--pc-line)] px-3 text-sm text-[var(--pc-ink)]"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!result}
            onClick={() => result && onImport(result, mode)}
            className="h-11 min-h-11 rounded-xl bg-[var(--pc-accent-fill)] px-4 text-sm font-semibold text-white disabled:opacity-50"
            data-import-confirm
          >
            Import
          </button>
        </div>
      </div>
    </div>
  );
}
