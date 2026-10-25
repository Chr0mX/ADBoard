"use client";

import { useEffect, useState } from "react";
import { ScanText } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import {
  MAX_TEXTS,
  MAX_TEXT_INTERVAL_MS,
  MAX_TEXT_LENGTH,
  MAX_TEXT_WAIT_MS,
  MIN_TEXT_INTERVAL_MS,
  textDefaults,
  type MacroStep,
  type MacroTab,
  type StepOutcome,
  type TextAction,
  type TextStep,
} from "@/lib/macro/core";
import { areaOnScreen, ocrStatus, readScreen, setTextPreview, type OcrStatus, type ScreenText } from "@/lib/macro/ocr";
import type { Device } from "@/lib/devices/types";
import { cn } from "@/lib/utils";
import { GhostButton, NumField, Segmented, formatMs } from "@/components/adboard/macros/fields";

export const TEXT_ACTION_LABEL: Record<TextAction, string> = {
  tap: "Tap text",
  wait: "Wait for text",
  gone: "Wait until gone",
  check: "If text is shown",
  read: "Read text",
};

/** What "success" and "failure" mean for each action. */
const OUTCOME_LABELS: Record<TextAction, [string, string]> = {
  tap: ["After tapping", "If not found"],
  wait: ["When found", "If not found in time"],
  gone: ["When gone", "If still shown"],
  check: ["If shown", "If not shown"],
  read: ["After reading", "If nothing to read"],
};

const quoted = (texts: string[]) => {
  const list = texts.map((t) => t.trim()).filter(Boolean);
  if (list.length === 0) return "…";
  return list.length === 1 ? `“${list[0]}”` : `“${list[0]}” +${list.length - 1}`;
};

function outcomeLabel(outcome: StepOutcome, steps: MacroStep[]) {
  if (outcome.go === "step") {
    const at = steps.findIndex((s) => s.id === outcome.stepId);
    return at >= 0 ? `go to ${at + 1}` : "go to a deleted step";
  }
  return outcome.go === "end" ? "end" : outcome.go === "fail" ? "fail" : "next";
}

/** One line for the step list: `Tap “Sign in” · 10 s · else fail`. */
export function textStepSummary(text: TextStep, steps: MacroStep[]) {
  const what = text.action === "read" && text.texts.every((t) => !t.trim()) ? "all text" : quoted(text.texts);
  const wait = text.timeoutMs > 0 ? ` · ${formatMs(text.timeoutMs)}` : "";
  const into = text.action === "read" && text.variable ? ` → {${text.variable}}` : "";
  const [, failure] = OUTCOME_LABELS[text.action];
  const success = text.onSuccess.go !== "next" ? ` · ${OUTCOME_LABELS[text.action][0].toLowerCase()} ${outcomeLabel(text.onSuccess, steps)}` : "";
  const otherwise = text.onFailure.go !== "next" || text.action === "check" ? ` · ${failure.toLowerCase()} ${outcomeLabel(text.onFailure, steps)}` : "";
  return `${TEXT_ACTION_LABEL[text.action].split(" ")[0]} ${what}${into}${wait}${success}${otherwise}`;
}

const fieldClass =
  "min-h-11 min-w-0 rounded-xl border border-[var(--pc-line)] bg-[var(--pc-panel)] px-2 text-xs text-[var(--pc-ink)] outline-none focus-visible:border-[var(--pc-accent)]";

function OutcomeField({
  label,
  value,
  steps,
  self,
  onChange,
  ...rest
}: {
  label: string;
  value: StepOutcome;
  steps: MacroStep[];
  self: string;
  onChange: (outcome: StepOutcome) => void;
} & { "data-text-outcome"?: string }) {
  const encoded = value.go === "step" ? `step:${value.stepId ?? ""}` : value.go;
  const missing = value.go === "step" && !steps.some((s) => s.id === value.stepId && s.enabled);
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs text-[var(--pc-muted)]">
      {label}
      <select
        {...rest}
        value={encoded}
        onChange={(event) => {
          const next = event.target.value;
          onChange(next.startsWith("step:") ? { go: "step", stepId: next.slice(5) } : { go: next as StepOutcome["go"] });
        }}
        className={cn(fieldClass, "h-11 bg-[var(--pc-paper)]")}
      >
        <option value="next">Next step</option>
        <optgroup label="Go to step">
          {steps.map((s, i) =>
            s.id === self ? null : (
              <option key={s.id} value={`step:${s.id}`} disabled={!s.enabled}>
                {i + 1}. {s.label || (s.text ? TEXT_ACTION_LABEL[s.text.action] : "Touch")}
                {s.enabled ? "" : " (off)"}
              </option>
            ),
          )}
          {value.go === "step" && !steps.some((s) => s.id === value.stepId) && <option value={encoded}>Deleted step</option>}
        </optgroup>
        <option value="end">End the run (done)</option>
        <option value="fail">Fail the run</option>
      </select>
      {missing && <span className="text-[11px] text-[var(--pc-warn)]">That step is off or deleted; the run fails here.</span>}
    </label>
  );
}

export function TextStepEditor({
  step,
  tab,
  readDevice,
  onChange,
}: {
  step: MacroStep & { text: TextStep };
  tab: MacroTab;
  /** The phone "Read screen" uses: the previewed one, else a ticked online one. */
  readDevice: Device | null;
  onChange: (step: MacroStep) => void;
}) {
  const text = step.text;
  const patch = (change: Partial<TextStep>) => onChange({ ...step, text: { ...text, ...change } });
  const { width: w, height: h } = tab.reference;
  const [success, failure] = OUTCOME_LABELS[text.action];
  const [status, setStatus] = useState<OcrStatus | null>(null);
  const [reading, setReading] = useState(false);
  const [result, setResult] = useState<{ screen: ScreenText } | { error: string } | null>(null);

  useEffect(() => {
    let live = true;
    void ocrStatus().then((s) => live && setStatus(s));
    return () => {
      live = false;
    };
  }, []);
  // The highlight belongs to this step's last read; drop it when the editor closes.
  useEffect(() => () => setTextPreview(null), []);

  const read = async () => {
    if (!readDevice) return;
    setReading(true);
    try {
      const area = text.area ? areaOnScreen(text.area, tab, readDevice.resolution) : undefined;
      // {name} values only exist while a run plays, so those texts are not matched here.
      const screen = await readScreen(readDevice.id, area, text.texts.some((t) => /\{[A-Za-z_]/.test(t)) ? undefined : text);
      setResult({ screen });
      setTextPreview({ deviceId: readDevice.id, stepId: step.id, screen });
    } catch (error) {
      setResult({ error: error instanceof Error ? error.message : "Could not read the screen" });
      setTextPreview(null);
    } finally {
      setReading(false);
    }
  };
  const matched = result && "screen" in result ? new Set((result.screen.matches ?? []).map((m) => m.line)) : new Set<number>();

  return (
    <div className="flex flex-col gap-3" data-text-step={text.action}>
      <label className="flex min-w-0 flex-col gap-1 text-xs text-[var(--pc-muted)]">
        Do
        <select
          value={text.action}
          onChange={(event) => {
            const action = event.target.value as TextAction;
            patch({ action, ...textDefaults(action), ...(action === "read" && !text.variable ? { variable: "text" } : {}) });
          }}
          className={cn(fieldClass, "h-11 bg-[var(--pc-paper)]")}
          data-text-action
        >
          {(Object.keys(TEXT_ACTION_LABEL) as TextAction[]).map((a) => (
            <option key={a} value={a}>
              {TEXT_ACTION_LABEL[a]}
            </option>
          ))}
        </select>
      </label>

      <label className="flex min-w-0 flex-col gap-1 text-xs text-[var(--pc-muted)]">
        {text.action === "read" ? "Text to read (empty reads everything in the area)" : "Text"}
        <textarea
          value={text.texts.join("\n")}
          rows={Math.min(4, Math.max(2, text.texts.length))}
          maxLength={MAX_TEXTS * (MAX_TEXT_LENGTH + 1)}
          placeholder={text.action === "read" ? "e.g. Coins: (\\d+)" : "e.g. Sign in"}
          onChange={(event) => patch({ texts: event.target.value.split("\n").slice(0, MAX_TEXTS).map((t) => t.slice(0, MAX_TEXT_LENGTH)) })}
          className={cn(fieldClass, "py-2 font-mono")}
          data-text-texts
        />
        <span className="text-[11px] leading-snug">One per line; any of them matches. {"{name}"} uses a value a Read step stored.</span>
      </label>

      <div className="grid gap-2 @md:grid-cols-[minmax(0,1fr)_auto]">
        <Segmented
          label="Match"
          name={`match-${step.id}`}
          value={text.match}
          onChange={(match) => patch({ match })}
          options={[
            { id: "contains", label: "Contains", hint: "Anywhere in a line of text" },
            { id: "exact", label: "Exact words", hint: "Whole words only: “OK” does not match “Bookmark”" },
            { id: "regex", label: "Regex", hint: "A regular expression; a Read step stores its first group" },
          ]}
        />
        <label className="pc-choice-row gap-2 self-end border border-[var(--pc-line)] px-3 text-xs">
          Match case
          <Switch checked={text.caseSensitive} onChange={() => patch({ caseSensitive: !text.caseSensitive })} aria-label="Match case" />
        </label>
      </div>

      <div className="grid grid-cols-2 gap-2 @md:grid-cols-4">
        <NumField
          compact
          label={text.action === "check" || text.action === "read" ? "Wait up to" : "Keep looking for"}
          suffix="ms"
          value={text.timeoutMs}
          min={0}
          max={MAX_TEXT_WAIT_MS}
          onChange={(timeoutMs) => patch({ timeoutMs })}
          title="0 looks once"
          data-text-timeout
        />
        <NumField
          compact
          label="Look every"
          suffix="ms"
          value={text.intervalMs}
          min={MIN_TEXT_INTERVAL_MS}
          max={MAX_TEXT_INTERVAL_MS}
          onChange={(intervalMs) => patch({ intervalMs })}
        />
        {text.action === "read" && (
          <label className="flex min-w-0 flex-col gap-1 text-[11px] tracking-wider text-[var(--pc-muted)]">
            Store in
            <input
              value={text.variable}
              maxLength={32}
              placeholder="name"
              onChange={(event) => patch({ variable: event.target.value.replace(/[^A-Za-z0-9_]/g, "").replace(/^\d+/, "") })}
              className={cn(fieldClass, "h-11 bg-[var(--pc-paper)] font-mono")}
              data-text-variable
            />
          </label>
        )}
        {text.action === "tap" && (
          <>
            <NumField compact label="Offset X" suffix="px" value={text.offsetX} min={-w} max={w} onChange={(offsetX) => patch({ offsetX })} title="From the text's center, in reference pixels" />
            <NumField compact label="Offset Y" suffix="px" value={text.offsetY} min={-h} max={h} onChange={(offsetY) => patch({ offsetY })} title="From the text's center, in reference pixels" />
          </>
        )}
      </div>

      <div className="flex flex-col gap-2 rounded-xl border border-[var(--pc-line)] p-2">
        <label className="flex min-h-9 cursor-pointer items-center justify-between gap-2 text-xs text-[var(--pc-ink)]">
          Look only in an area
          <Switch
            checked={Boolean(text.area)}
            aria-label="Look only in an area"
            onChange={() =>
              patch(text.area ? { area: undefined } : { area: { x: 0, y: Math.round(h / 2), width: w, height: Math.round(h / 2) } })
            }
            data-text-area-toggle
          />
        </label>
        {text.area && (
          <div className="grid grid-cols-2 gap-2 @md:grid-cols-4" data-text-area>
            {(["x", "y", "width", "height"] as const).map((key) => (
              <NumField
                key={key}
                compact
                label={key === "x" ? "X" : key === "y" ? "Y" : key === "width" ? "Width" : "Height"}
                value={text.area?.[key] ?? 0}
                min={key === "width" || key === "height" ? 1 : 0}
                max={key === "x" || key === "width" ? w : h}
                onChange={(value) => text.area && patch({ area: { ...text.area, [key]: value } })}
              />
            ))}
          </div>
        )}
        <p className="text-[11px] leading-snug text-[var(--pc-muted)]">Reference pixels, scaled to each phone like touches. A smaller area reads faster.</p>
      </div>

      <div className="grid gap-2 @md:grid-cols-2">
        <OutcomeField label={success} value={text.onSuccess} steps={tab.steps} self={step.id} onChange={(onSuccess) => patch({ onSuccess })} data-text-outcome="success" />
        <OutcomeField label={failure} value={text.onFailure} steps={tab.steps} self={step.id} onChange={(onFailure) => patch({ onFailure })} data-text-outcome="failure" />
      </div>

      <div className="flex flex-col gap-2" data-text-read>
        <div className="flex flex-wrap items-center gap-2">
          <GhostButton disabled={!readDevice || reading || readDevice.status !== "online"} onClick={() => void read()} data-text-read-button>
            <ScanText className="size-3.5" aria-hidden />
            {reading ? "Reading…" : readDevice ? `Read ${readDevice.name}'s screen` : "Read screen"}
          </GhostButton>
          {!readDevice && <span className="text-[11px] text-[var(--pc-muted)]">Pick a phone in Preview or tick one to read its screen.</span>}
        </div>
        {status && !status.available && (
          <p className="rounded-lg bg-[var(--pc-warn-soft)] px-2 py-1.5 text-xs text-[var(--pc-warn)]" data-text-unavailable>
            {status.detail ?? "Text reading is not set up on this ADBoard."}
          </p>
        )}
        {result && "error" in result && <p className="text-xs text-[var(--pc-warn)]">{result.error}</p>}
        {result && "screen" in result && (
          <div className="flex flex-col gap-1.5" data-text-result={result.screen.lines.length}>
            <p className="font-mono text-[11px] text-[var(--pc-muted)]">
              {result.screen.lines.length} line{result.screen.lines.length === 1 ? "" : "s"} · {result.screen.ms} ms
              {result.screen.cached ? " · unchanged" : ""}
              {result.screen.matches ? ` · ${result.screen.matches.length ? `found ${quoted(result.screen.matches.map((m) => m.text))}` : "no match"}` : ""}
              {" · tap a line to look for it"}
            </p>
            <div className="flex max-h-40 flex-wrap gap-1 overflow-y-auto">
              {result.screen.lines.map((line, i) => (
                <button
                  key={`${i}-${line.text}`}
                  type="button"
                  onClick={() => patch({ texts: [line.text] })}
                  className={cn(
                    "max-w-full truncate rounded-lg border px-2 py-1 text-left font-mono text-[11px]",
                    matched.has(i) ? "border-[var(--pc-signal)] text-[var(--pc-ink)]" : "border-[var(--pc-line)] text-[var(--pc-muted)] hover:text-[var(--pc-ink)]",
                  )}
                  data-text-line={line.text}
                >
                  {line.text}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
