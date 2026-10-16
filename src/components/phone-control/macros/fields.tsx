"use client";

import { useId, useState } from "react";
import { cn } from "@/lib/utils";

export function Card({
  title,
  action,
  children,
  className,
  ...rest
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
} & Omit<React.HTMLAttributes<HTMLElement>, "title">) {
  return (
    <section
      {...rest}
      className={cn("flex min-w-0 flex-col gap-3 rounded-2xl border border-[var(--pc-line)] bg-[var(--pc-panel)] p-3", className)}
    >
      <div className="flex min-h-8 items-center justify-between gap-2">
        <h3 className="font-display text-sm font-semibold tracking-tight text-[var(--pc-ink)]">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * Number input that lets you type freely and commits a clamped integer.
 * Bad input snaps back on blur instead of storing junk.
 */
export function NumField({
  label,
  value,
  onChange,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
  suffix,
  className,
  compact,
  ...rest
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  suffix?: string;
  className?: string;
  compact?: boolean;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "min" | "max">) {
  const id = useId();
  // While typing, show the draft; otherwise show the stored value.
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? String(value);
  const commit = (raw: string) => {
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(n)) return;
    const next = Math.min(max, Math.max(min, Math.round(n)));
    if (next !== value) onChange(next);
  };
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <label htmlFor={id} className={cn("text-[var(--pc-muted)]", compact ? "text-[10px] uppercase tracking-wider" : "text-xs")}>
        {label}
      </label>
      <div className="relative flex items-center">
        <input
          {...rest}
          id={id}
          inputMode="numeric"
          value={text}
          onFocus={() => setDraft(String(value))}
          onBlur={() => {
            commit(text);
            setDraft(null);
          }}
          onChange={(event) => {
            setDraft(event.target.value);
            commit(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              event.preventDefault();
              const step = event.shiftKey ? 10 : 1;
              const next = Math.min(max, Math.max(min, value + (event.key === "ArrowUp" ? step : -step)));
              onChange(next);
              setDraft(String(next));
            }
          }}
          className={cn(
            "h-11 min-h-11 w-full min-w-0 rounded-xl border border-[var(--pc-line)] bg-[var(--pc-paper)] px-2 font-mono text-xs text-[var(--pc-ink)] outline-none focus-visible:border-[var(--pc-accent)]",
            suffix && "pr-9",
          )}
        />
        {suffix && (
          <span className="pointer-events-none absolute right-2 font-mono text-[10px] text-[var(--pc-muted)]">{suffix}</span>
        )}
      </div>
    </div>
  );
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  name,
}: {
  label: string;
  value: T;
  options: Array<{ id: T; label: string; hint?: string }>;
  onChange: (value: T) => void;
  name: string;
}) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-1">
      <legend className="mb-1 text-xs text-[var(--pc-muted)]">{label}</legend>
      <div className="flex flex-wrap gap-1 rounded-xl border border-[var(--pc-line)] bg-[var(--pc-paper)] p-1">
        {options.map((option) => (
          <label
            key={option.id}
            title={option.hint}
            className={cn(
              "flex min-h-9 flex-1 cursor-pointer items-center justify-center rounded-lg px-2 text-center text-xs",
              value === option.id
                ? "bg-[var(--pc-accent-fill)] font-semibold text-white"
                : "text-[var(--pc-ink)] hover:bg-[var(--pc-accent-soft)]",
            )}
          >
            <input
              type="radio"
              name={name}
              className="sr-only"
              checked={value === option.id}
              onChange={() => onChange(option.id)}
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function IconButton({
  label,
  onClick,
  children,
  disabled,
  tone = "default",
  className,
  ...rest
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  tone?: "default" | "danger" | "accent";
  className?: string;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onClick">) {
  return (
    <button
      {...rest}
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex size-9 min-h-9 shrink-0 items-center justify-center rounded-lg border border-transparent text-[var(--pc-muted)] hover:border-[var(--pc-line)] hover:text-[var(--pc-ink)] disabled:opacity-40",
        tone === "danger" && "hover:text-[var(--pc-warn)]",
        tone === "accent" && "text-[var(--pc-accent)]",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function GhostButton({
  children,
  onClick,
  disabled,
  className,
  ...rest
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onClick">) {
  return (
    <button
      {...rest}
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex h-9 min-h-9 items-center gap-1.5 rounded-lg border border-[var(--pc-line)] px-2.5 text-xs text-[var(--pc-ink)] hover:bg-[var(--pc-accent-soft)] disabled:opacity-50",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function formatMs(ms: number) {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s ? `${m} min ${s} s` : `${m} min`;
}

/** Colors per step in the preview, readable on the dark frame. */
export const STEP_COLORS = ["#8eeadf", "#ffb86b", "#c3a6ff", "#7cc4ff", "#ff8fab", "#b5e48c", "#ffd166", "#f4a3ff"];
export const stepColor = (index: number) => STEP_COLORS[index % STEP_COLORS.length];
