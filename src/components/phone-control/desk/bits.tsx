"use client";

import { useEffect, useRef, useState } from "react";
import type { Device, DeviceOpResult } from "@/lib/devices/types";
import { cn } from "@/lib/utils";

export function PanelFrame({
  title,
  children,
  panel,
}: {
  title: string;
  panel: string;
  children: React.ReactNode;
}) {
  return (
    <section
      data-desk-panel={panel}
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto"
    >
      <h2 className="font-display text-lg font-semibold text-[var(--pc-ink)]">{title}</h2>
      {children}
    </section>
  );
}

export function TargetChecks({
  devices,
  checked,
  onChange,
}: {
  devices: Device[];
  checked: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1 font-mono text-[10px] uppercase tracking-wider text-[var(--pc-muted)]">
        Target devices
      </legend>
      {devices.map((device) => (
        <label
          key={device.id}
          className="flex min-h-11 items-center gap-2 rounded-lg px-2 text-sm text-[var(--pc-ink)]"
        >
          <input
            type="checkbox"
            checked={checked.has(device.id)}
            onChange={() => {
              const next = new Set(checked);
              if (next.has(device.id)) next.delete(device.id);
              else next.add(device.id);
              onChange(next);
            }}
          />
          <span className="font-medium">{device.name}</span>
          <span className="font-mono text-[10px] uppercase text-[var(--pc-muted)]">
            {device.status}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

export function useChecked(devices: Device[], preferred: Device[]) {
  const [checked, setChecked] = useState<Set<string>>(() => {
    const ids = preferred.length > 0 ? preferred.map((device) => device.id) : devices.slice(0, 1).map((d) => d.id);
    return new Set(ids);
  });
  return [checked, setChecked] as const;
}

export function picked(devices: Device[], checked: Set<string>) {
  return devices.filter((device) => checked.has(device.id));
}

export interface ResultRow {
  deviceId: string;
  deviceName: string;
  state: "ok" | "error" | "skipped";
  detail?: string;
}

export function rowsFromCommand(
  devices: Device[],
  checked: Set<string>,
  results: DeviceOpResult[],
): ResultRow[] {
  return devices.map((device) => {
    if (!checked.has(device.id)) {
      return { deviceId: device.id, deviceName: device.name, state: "skipped", detail: "Skipped" };
    }
    const result = results.find((row) => row.deviceId === device.id);
    if (!result) {
      return { deviceId: device.id, deviceName: device.name, state: "error", detail: "No result" };
    }
    return {
      deviceId: device.id,
      deviceName: device.name,
      state: result.ok ? "ok" : "error",
      detail: result.ok ? result.output || "Done" : result.error || "Failed",
    };
  });
}

export function ResultList({ rows }: { rows: ResultRow[] }) {
  if (rows.length === 0) return null;
  return (
    <ul data-op-results className="flex flex-col gap-1 font-mono text-xs">
      {rows.map((row) => (
        <li key={row.deviceId} className="flex items-baseline gap-3">
          <span className="w-24 shrink-0 text-[var(--pc-ink)]">{row.deviceName}</span>
          <span
            className={cn(
              row.state === "ok" && "text-[var(--pc-signal)]",
              row.state === "error" && "text-[var(--pc-warn)]",
              row.state === "skipped" && "text-[var(--pc-muted)]",
            )}
          >
            {row.state === "ok" ? "✓" : row.state === "error" ? "✕" : "—"} {row.detail}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="desk-confirm-title"
        className="w-full max-w-sm rounded-xl border border-[var(--pc-line)] bg-[var(--pc-paper)] p-4 shadow-lg"
      >
        <h3 id="desk-confirm-title" className="font-display text-base font-semibold text-[var(--pc-ink)]">
          {title}
        </h3>
        <div className="mt-2 text-sm text-[var(--pc-muted)]">{body}</div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            className="h-11 rounded-lg border border-[var(--pc-line)] px-3 text-sm"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            className="h-11 rounded-lg bg-[var(--pc-accent)] px-3 text-sm font-medium text-white disabled:opacity-60"
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function TextField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm text-[var(--pc-ink)]">
      {label}
      <input
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="h-11 rounded-lg border border-[var(--pc-line)] bg-white px-2 font-mono text-xs"
      />
    </label>
  );
}

export function PrimaryButton({
  children,
  onClick,
  disabled,
  type = "button",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className="h-11 rounded-lg bg-[var(--pc-accent)] px-4 text-sm font-semibold tracking-wide text-white disabled:opacity-60"
    >
      {children}
    </button>
  );
}

export function formatSeen(ms?: number) {
  if (!ms) return "—";
  return new Date(ms).toLocaleTimeString();
}
