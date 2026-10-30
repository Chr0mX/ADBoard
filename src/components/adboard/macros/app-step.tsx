"use client";

import { useState } from "react";
import { useLibrary, type AppShortcut } from "@/lib/desk/store";
import { devicesClient } from "@/lib/api/client";
import { parseActivities, shortActivity, type AppActivity } from "@/lib/devices/app-controls";
import type { Device } from "@/lib/devices/types";
import { formatMs } from "@/components/adboard/macros/fields";
import { SwitchRow } from "@/components/ui/switch";
import type { AppStep, MacroStep } from "@/lib/macro/core";
import { cn } from "@/lib/utils";

const fieldClass =
  "h-11 min-h-11 min-w-0 rounded-xl border border-[var(--pc-line)] bg-[var(--pc-paper)] px-2 text-xs text-[var(--pc-ink)] outline-none focus-visible:border-[var(--pc-accent)]";

/** `pkg` + activity + arguments of a saved app, as an app step keeps them. */
function fromShortcut(app: AppShortcut): Pick<AppStep, "packageName" | "activity"> {
  return { packageName: app.packageName, activity: [app.activity, app.arguments].filter((v) => v && v.trim()).join(" ") };
}

/** The saved app an app step opens, if it is one of the saved apps. */
export function savedAppFor(step: AppStep, apps: AppShortcut[]) {
  return apps.find((a) => a.packageName === step.packageName) ?? null;
}

/** One line for the step list: `Open Game (com.game) · restart · wait 3 s`. */
export function appStepSummary(step: AppStep, delayMs: number, apps: AppShortcut[] = []) {
  const saved = savedAppFor(step, apps);
  const what = step.packageName ? (saved ? `${saved.name} (${step.packageName})` : step.packageName) : "(no app chosen)";
  return `Open ${what}${step.activity ? ` · ${step.activity}` : ""}${step.restart ? " · restart" : ""} · wait ${formatMs(delayMs)}`;
}

export function AppStepEditor({
  step,
  readDevice,
  onChange,
}: {
  step: MacroStep & { app: AppStep };
  /** The phone "List screens" reads the app from: the previewed one, else a ticked online one. */
  readDevice?: Device | null;
  onChange: (step: MacroStep) => void;
}) {
  const { apps } = useLibrary();
  const [screens, setScreens] = useState<{ pkg: string; list: AppActivity[]; error?: string } | null>(null);
  const [listing, setListing] = useState(false);
  const app = step.app;
  const patch = (change: Partial<AppStep>) => onChange({ ...step, app: { ...app, ...change } });
  const saved = savedAppFor(app, apps);
  const groups = [...new Set(apps.map((a) => a.group || "Custom"))];
  const validPackage = !app.packageName || /^[A-Za-z0-9_.]+$/.test(app.packageName);

  return (
    <div className="flex flex-col gap-3" data-app-step>
      {apps.length > 0 && (
        <label className="flex min-w-0 flex-col gap-1 text-xs text-[var(--pc-muted)]">
          Saved app
          <select
            value={saved?.id ?? ""}
            onChange={(event) => {
              const chosen = apps.find((a) => a.id === event.target.value);
              if (chosen) onChange({ ...step, label: step.label || `Open ${chosen.name}`, app: { ...app, ...fromShortcut(chosen) } });
            }}
            className={fieldClass}
            data-app-step-saved
          >
            <option value="">{app.packageName && !saved ? "Not a saved app" : "Choose…"}</option>
            {groups.map((group) => (
              <optgroup key={group} label={group}>
                {apps
                  .filter((a) => (a.group || "Custom") === group)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.icon ? `${a.icon} ` : ""}
                      {a.name}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </label>
      )}
      <div className="grid gap-2 @md:grid-cols-2">
        <label className="flex min-w-0 flex-col gap-1 text-xs text-[var(--pc-muted)]">
          Package
          <input
            value={app.packageName}
            maxLength={200}
            spellCheck={false}
            placeholder="com.example.game"
            onChange={(event) => patch({ packageName: event.target.value.trim() })}
            className={cn(fieldClass, "font-mono", !validPackage && "border-[var(--pc-warn)]")}
            data-app-step-package
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs text-[var(--pc-muted)]">
          Activity (optional)
          <input
            value={app.activity}
            maxLength={300}
            spellCheck={false}
            placeholder=".MainActivity"
            onChange={(event) => patch({ activity: event.target.value })}
            className={cn(fieldClass, "font-mono")}
            data-app-step-activity
          />
        </label>
      </div>
      {!validPackage && <p className="text-xs text-[var(--pc-warn)]">A package name has only letters, digits, dots and _.</p>}
      {readDevice && app.packageName && validPackage && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="h-11 rounded-lg border border-[var(--pc-line)] px-3 text-xs disabled:opacity-50"
            disabled={listing}
            data-app-step-screens
            onClick={async () => {
              setListing(true);
              try {
                const response = await devicesClient.runCommand([readDevice], "activities", app.packageName);
                const result = response.results[0];
                setScreens({ pkg: app.packageName, list: result?.ok ? parseActivities(result.output) : [], error: result?.ok ? undefined : result?.error || "Failed" });
              } finally {
                setListing(false);
              }
            }}
          >
            {listing ? "Reading…" : `List screens on ${readDevice.name}`}
          </button>
          {screens?.pkg === app.packageName && screens.list.length > 0 && (
            <select
              className={cn(fieldClass, "min-w-0 flex-1 font-mono")}
              value=""
              aria-label="Pick a screen"
              data-app-step-screen-pick
              onChange={(event) => {
                if (event.target.value) patch({ activity: event.target.value });
              }}
            >
              <option value="">Pick a screen…</option>
              {screens.list.map((screen) => (
                <option key={screen.name} value={shortActivity(screen.name, app.packageName)} disabled={!screen.exported}>
                  {shortActivity(screen.name, app.packageName)}
                  {screen.launcher ? " (launcher)" : ""}
                  {screen.exported ? "" : " (not exported)"}
                </option>
              ))}
            </select>
          )}
          {screens?.pkg === app.packageName && screens.error && <span className="text-xs text-[var(--pc-warn)]">{screens.error}</span>}
        </div>
      )}
      <p className="text-[11px] leading-snug text-[var(--pc-muted)]">
        Empty activity opens the app&apos;s launcher screen. Saved apps come from Apps; their activity and arguments are filled in.
        &ldquo;Then wait&rdquo; gives the app time to open before the next step.
      </p>
      <SwitchRow
        label="Restart the app"
        description="Force-stop it first, so it opens from its start screen"
        checked={app.restart}
        onChange={() => patch({ restart: !app.restart })}
        className="-mx-2"
        data-app-step-restart
      />
    </div>
  );
}
