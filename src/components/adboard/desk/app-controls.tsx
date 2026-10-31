"use client";

import { useState } from "react";
import { devicesClient } from "@/lib/api/client";
import type { Device } from "@/lib/devices/types";
import { useLibrary } from "@/lib/desk/store";
import { Switch, SwitchRow } from "@/components/ui/switch";
import {
  BUCKETS,
  BUCKET_LABELS,
  OP_MODES,
  parseActivities,
  parseAppDetail,
  permissionLabel,
  shortActivity,
  sortedOps,
  type AppActivity,
  type AppDetail,
} from "@/lib/devices/app-controls";
import {
  ConfirmDialog,
  PrimaryButton,
  ResultList,
  TargetChecks,
  picked,
  rowsFromCommand,
  type ResultRow,
} from "@/components/adboard/desk/bits";
import { cn } from "@/lib/utils";

const fieldClass =
  "h-11 min-h-11 min-w-0 rounded-xl border border-[var(--pc-line)] bg-[var(--pc-paper)] px-2 text-xs text-[var(--pc-ink)] outline-none focus-visible:border-[var(--pc-accent)]";
const cardClass = "flex min-w-0 flex-col gap-2 rounded-xl border border-[var(--pc-line)] bg-[var(--pc-panel)] p-4";
const smallButton = "h-11 rounded-lg border border-[var(--pc-line)] px-3 text-sm disabled:opacity-50";

type StateAction = "suspend" | "unsuspend" | "disable" | "enable" | "uninstallUser" | "restore";

const STATE_CONFIRM: Partial<Record<StateAction, string>> = {
  suspend: "The app can't be opened until it is unsuspended.",
  disable: "The app disappears from the launcher until it is enabled again.",
  uninstallUser: "Removes the app for user 0 but keeps its data. System apps can be restored.",
};

/**
 * Apps → Controls: permissions, app ops, battery and network for one app,
 * read from the first checked phone and applied to every checked phone.
 */
export function AppControls({
  devices,
  checked,
  onChecked,
}: {
  devices: Device[];
  checked: Set<string>;
  onChecked: (next: Set<string>) => void;
}) {
  const library = useLibrary();
  const [pkg, setPkg] = useState("");
  const [detail, setDetail] = useState<AppDetail | null>(null);
  const [activities, setActivities] = useState<AppActivity[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<ResultRow[]>([]);
  const [opQuery, setOpQuery] = useState("");
  const [confirm, setConfirm] = useState<StateAction | null>(null);
  const [intentVerb, setIntentVerb] = useState<"broadcast" | "start">("broadcast");
  const [intentArgs, setIntentArgs] = useState("");
  const targets = picked(devices, checked);
  const source = targets.find((d) => d.status === "online") ?? null;
  const packageName = pkg.trim();

  async function load(name = packageName) {
    if (!source || !name) return;
    setBusy(true);
    setError(null);
    try {
      const response = await devicesClient.runCommand([source], "appDetail", name);
      const result = response.results[0];
      const parsed = result?.ok ? parseAppDetail(result.output) : null;
      setDetail(parsed);
      if (!parsed) setError(result?.error || "Could not read this app");
    } catch (e) {
      setDetail(null);
      setError(e instanceof Error ? e.message : "Could not read this app");
    } finally {
      setBusy(false);
    }
  }

  /** Run one op on every checked phone, then re-read the app. */
  async function apply(op: string, arg2?: string, arg = packageName) {
    if (targets.length === 0) return;
    setBusy(true);
    try {
      const response = await devicesClient.runCommand(targets, op, arg, arg2);
      setRows(rowsFromCommand(devices, checked, response.results));
    } catch (e) {
      setRows([{ deviceId: op, deviceName: op, state: "error", detail: e instanceof Error ? e.message : "Failed" }]);
    } finally {
      setBusy(false);
    }
    if (op !== "intent" && op !== "assistLaunch") await load();
  }

  async function listActivities() {
    if (!source || !packageName) return;
    setBusy(true);
    try {
      const response = await devicesClient.runCommand([source], "activities", packageName);
      const result = response.results[0];
      setActivities(result?.ok ? parseActivities(result.output) : []);
      if (!result?.ok) setError(result?.error || "Could not list the app's screens");
    } finally {
      setBusy(false);
    }
  }

  const savedApps = library.apps.filter((a) => a.packageName);

  return (
    <div className="flex flex-col gap-3" data-app-controls>
      <p className="text-sm text-[var(--pc-muted)]">
        Permissions, background running, battery and network for one app. Read from the first checked phone; changes go to every checked phone.
      </p>
      <div className="grid gap-2 md:grid-cols-[1fr_auto]">
        <label className="flex min-w-0 flex-col gap-1 text-xs text-[var(--pc-muted)]">
          Package
          <input
            value={pkg}
            list="app-controls-saved"
            spellCheck={false}
            placeholder="com.example.game"
            onChange={(event) => setPkg(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void load();
            }}
            className={cn(fieldClass, "font-mono")}
            data-app-controls-package
          />
          <datalist id="app-controls-saved">
            {savedApps.map((app) => (
              <option key={app.id} value={app.packageName}>
                {app.name}
              </option>
            ))}
          </datalist>
        </label>
        <PrimaryButton disabled={busy || !source || !packageName} onClick={() => void load()}>
          {detail?.package === packageName ? "Reload" : "Read app"}
        </PrimaryButton>
      </div>
      <TargetChecks devices={devices} checked={checked} onChange={onChecked} />
      {!source && <p className="text-xs text-[var(--pc-warn)]">Check at least one online phone.</p>}
      {error && <p className="text-xs text-[var(--pc-warn)]" data-app-controls-error>{error}</p>}
      <ResultList rows={rows} />

      {detail && (
        <div className="grid gap-3 xl:grid-cols-2" data-app-controls-detail>
          <section className={cardClass}>
            <h3 className="font-display text-sm font-semibold">
              {detail.package}
              {detail.system && <span className="ml-2 text-xs font-normal text-[var(--pc-muted)]">system app</span>}
            </h3>
            <p className="font-mono text-[11px] text-[var(--pc-muted)]">
              {[detail.versionName && `v${detail.versionName}`, detail.uid != null && `uid ${detail.uid}`, detail.targetSdk && `target SDK ${detail.targetSdk}`]
                .filter(Boolean)
                .join(" · ")}
            </p>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  detail.suspended ? ["unsuspend", "Unsuspend"] : ["suspend", "Suspend"],
                  detail.disabled ? ["enable", "Enable"] : ["disable", "Disable"],
                  ["uninstallUser", "Uninstall for user"],
                  ["restore", "Restore"],
                ] as [StateAction, string][]
              ).map(([action, label]) => (
                <button
                  key={action}
                  type="button"
                  className={smallButton}
                  disabled={busy}
                  data-app-state={action}
                  onClick={() => (STATE_CONFIRM[action] ? setConfirm(action) : void apply("appState", action))}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-[var(--pc-muted)]">
              {detail.suspended ? "Suspended. " : ""}
              {detail.disabled ? "Disabled. " : ""}
              Restore re-installs a removed system app.
            </p>
          </section>

          <section className={cardClass}>
            <h3 className="font-display text-sm font-semibold">Battery and network</h3>
            <label className="flex min-w-0 flex-col gap-1 text-xs text-[var(--pc-muted)]">
              Standby bucket
              <select
                value={detail.bucket ?? ""}
                className={fieldClass}
                disabled={busy}
                data-app-bucket
                onChange={(event) => void apply("standby", event.target.value)}
              >
                {detail.bucket && !(BUCKETS as readonly string[]).includes(detail.bucket) && (
                  <option value={detail.bucket}>{BUCKET_LABELS[detail.bucket] ?? detail.bucket}</option>
                )}
                {!detail.bucket && <option value="">Unknown</option>}
                {BUCKETS.map((bucket) => (
                  <option key={bucket} value={bucket}>
                    {BUCKET_LABELS[bucket]}
                  </option>
                ))}
              </select>
            </label>
            <SwitchRow
              label="Not battery optimised"
              description={detail.batteryExempt === "system" ? "The phone keeps this app exempt" : "Doze and App Standby leave it running"}
              checked={detail.batteryExempt != null}
              disabled={busy || detail.batteryExempt === "system"}
              onChange={() => void apply("batteryExempt", detail.batteryExempt ? "off" : "on")}
              className="-mx-2"
              data-app-battery
            />
            <SwitchRow
              label="Network access"
              description={detail.networkAllowed == null ? "This phone can't block one app (needs Android 13+)" : "Off blocks Wi-Fi and mobile data for this app"}
              checked={detail.networkAllowed !== false}
              disabled={busy || detail.networkAllowed == null}
              onChange={() => void apply("netBlock", detail.networkAllowed ? "on" : "off")}
              className="-mx-2"
              data-app-network
            />
          </section>

          <section className={cardClass}>
            <h3 className="font-display text-sm font-semibold">Permissions</h3>
            {detail.permissions.length === 0 && <p className="text-xs text-[var(--pc-muted)]">No runtime permissions.</p>}
            <ul className="flex flex-col">
              {detail.permissions.map((perm) => (
                <li key={perm.name}>
                  <label className="pc-choice-row -mx-2 justify-between" data-app-permission={perm.name}>
                    <span className="flex min-w-0 flex-col">
                      <span className="text-sm">{permissionLabel(perm.name)}</span>
                      <span className="truncate font-mono text-[10px] text-[var(--pc-muted)]">{perm.name}</span>
                    </span>
                    <Switch
                      checked={perm.granted}
                      disabled={busy}
                      onChange={() => void apply("permission", `${perm.granted ? "revoke" : "grant"}:${perm.name}`)}
                    />
                  </label>
                </li>
              ))}
            </ul>
          </section>

          <section className={cardClass}>
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-display text-sm font-semibold">App ops</h3>
              <input
                value={opQuery}
                onChange={(event) => setOpQuery(event.target.value)}
                placeholder="Search"
                className={cn(fieldClass, "w-32")}
                aria-label="Search app ops"
              />
            </div>
            <p className="text-[11px] text-[var(--pc-muted)]">RUN_ANY_IN_BACKGROUND = ignore is how Android stops an app in the background.</p>
            <ul className="flex max-h-80 flex-col gap-1 overflow-y-auto">
              {sortedOps(detail.ops, opQuery).map(([name, mode]) => (
                <li key={name} className="flex items-center justify-between gap-2" data-app-op={name}>
                  <span className="min-w-0 truncate font-mono text-[11px]">{name}</span>
                  <select
                    value={mode}
                    disabled={busy}
                    className={cn(fieldClass, "h-9 min-h-9 w-28")}
                    onChange={(event) => void apply("appop", `${name}=${event.target.value}`)}
                  >
                    {OP_MODES.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </li>
              ))}
            </ul>
            <AddOp disabled={busy} onAdd={(name, mode) => void apply("appop", `${name}=${mode}`)} />
          </section>

          <section className={cardClass}>
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-display text-sm font-semibold">Screens</h3>
              <button type="button" className={smallButton} disabled={busy} onClick={() => void listActivities()} data-app-activities-list>
                List screens
              </button>
            </div>
            <p className="text-[11px] text-[var(--pc-muted)]">
              &ldquo;Open hidden&rdquo; reaches a screen the app doesn&apos;t export by briefly making it the phone&apos;s assistant.
            </p>
            {activities && activities.length === 0 && <p className="text-xs text-[var(--pc-muted)]">No screens found.</p>}
            <ul className="flex max-h-80 flex-col gap-1 overflow-y-auto">
              {(activities ?? []).map((activity) => {
                const short = shortActivity(activity.name, detail.package);
                return (
                  <li key={activity.name} className="flex items-center justify-between gap-2" data-app-activity={activity.name}>
                    <span className="min-w-0 truncate font-mono text-[11px]">
                      {short}
                      {activity.launcher && <span className="ml-1 text-[var(--pc-signal)]">launcher</span>}
                    </span>
                    <span className="flex shrink-0 gap-1">
                      {activity.exported ? (
                        <button type="button" className={smallButton} disabled={busy} onClick={() => void apply("launch", short)}>
                          Open
                        </button>
                      ) : (
                        <button type="button" className={smallButton} disabled={busy} onClick={() => void apply("assistLaunch", short)} data-open-hidden>
                          Open hidden
                        </button>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        </div>
      )}

      <section className={cardClass} data-intent-sender>
        <h3 className="font-display text-sm font-semibold">Send intent</h3>
        <div className="grid gap-2 md:grid-cols-[auto_1fr_auto]">
          <select value={intentVerb} className={fieldClass} onChange={(event) => setIntentVerb(event.target.value as "broadcast" | "start")} aria-label="Intent type">
            <option value="broadcast">Broadcast</option>
            <option value="start">Start activity</option>
          </select>
          <input
            value={intentArgs}
            spellCheck={false}
            placeholder="-a com.app.ACTION -n com.app/.Receiver --es key value"
            onChange={(event) => setIntentArgs(event.target.value)}
            className={cn(fieldClass, "font-mono")}
            data-intent-args
          />
          <button type="button" className={smallButton} disabled={busy || targets.length === 0 || !intentArgs.trim()} onClick={() => void apply("intent", intentArgs, intentVerb)}>
            Send
          </button>
        </div>
        <p className="text-[11px] text-[var(--pc-muted)]">Allowed: -a -c -d -t -n -p -f, extras --es --ez --ei --el --ef --ed. Quote values with spaces.</p>
      </section>

      {confirm && (
        <ConfirmDialog
          title={`${confirm === "uninstallUser" ? "Uninstall" : confirm.charAt(0).toUpperCase() + confirm.slice(1)} ${packageName}?`}
          body={<p>{STATE_CONFIRM[confirm]} Runs on {targets.length} phone{targets.length === 1 ? "" : "s"}.</p>}
          confirmLabel="Continue"
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const action = confirm;
            setConfirm(null);
            void apply("appState", action);
          }}
        />
      )}
    </div>
  );
}

function AddOp({ disabled, onAdd }: { disabled: boolean; onAdd: (name: string, mode: string) => void }) {
  const [name, setName] = useState("");
  const [mode, setMode] = useState("ignore");
  const valid = /^[A-Z0-9_]{2,64}$/.test(name);
  return (
    <div className="flex items-center gap-1">
      <input
        value={name}
        onChange={(event) => setName(event.target.value.toUpperCase())}
        placeholder="Other op, e.g. RUN_ANY_IN_BACKGROUND"
        className={cn(fieldClass, "min-w-0 flex-1 font-mono")}
        aria-label="App op name"
      />
      <select value={mode} onChange={(event) => setMode(event.target.value)} className={cn(fieldClass, "w-28")} aria-label="Mode">
        {OP_MODES.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
      <button type="button" className={smallButton} disabled={disabled || !valid} onClick={() => onAdd(name, mode)}>
        Set
      </button>
    </div>
  );
}
