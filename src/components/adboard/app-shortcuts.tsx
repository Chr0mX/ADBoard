"use client";

import { useState } from "react";
import { devicesClient } from "@/lib/api/client";
import { useDesk } from "@/components/adboard/desk/desk-context";
import { useLibrary, type AppShortcut } from "@/lib/desk/store";

/** Launches apps saved on the Apps tab, on the current control targets. */
export function AppShortcuts() {
  const desk = useDesk();
  const library = useLibrary();
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  if (library.apps.length === 0) return null;

  async function open(app: AppShortcut) {
    const targets = desk.targets.filter((device) => device.status === "online");
    if (targets.length === 0) {
      setNote("No online target");
      return;
    }
    setBusy(app.id);
    try {
      const activity = [app.activity, app.arguments].filter(Boolean).join(" ");
      const response = await devicesClient.runCommand(
        targets,
        "launch",
        app.packageName,
        activity || undefined,
      );
      const failed = response.results.filter((result) => !result.ok);
      setNote(
        failed.length === 0
          ? `Opened ${app.name}`
          : failed[0]?.error || `Could not open ${app.name}`,
      );
    } catch (error) {
      setNote(error instanceof Error ? error.message : "Could not open app");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex w-full min-w-0 shrink-0 flex-col gap-1" data-app-shortcuts>
      <div className="flex gap-1.5 overflow-x-auto px-1">
        {library.apps.map((app) => (
          <button
            key={app.id}
            type="button"
            data-app-shortcut={app.name}
            disabled={busy === app.id}
            title={app.packageName}
            onClick={() => void open(app)}
            className="inline-flex h-11 max-w-40 shrink-0 items-center gap-1.5 rounded-lg border border-[var(--pc-line)] bg-[var(--pc-panel)] px-3 text-sm text-[var(--pc-ink)] hover:border-[var(--pc-accent)] disabled:opacity-60"
          >
            <span aria-hidden>{app.icon || "▶"}</span>
            <span className="truncate">{app.name}</span>
          </button>
        ))}
      </div>
      {note && (
        <p data-app-shortcut-note className="truncate px-1 text-center font-mono text-[10px] text-[var(--pc-muted)]">
          {note}
        </p>
      )}
    </div>
  );
}
