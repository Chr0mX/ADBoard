"use client";

import { useLibrary, type AppShortcut } from "@/lib/desk/store";
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

export function AppStepEditor({ step, onChange }: { step: MacroStep & { app: AppStep }; onChange: (step: MacroStep) => void }) {
  const { apps } = useLibrary();
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
