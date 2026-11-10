"use client";

import { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { devicesClient } from "@/lib/api/client";
import { AppIcon } from "@/components/adboard/app-icon";
import type { Device } from "@/lib/devices/types";
import { updateLibrary, useLibrary, type AppShortcut } from "@/lib/desk/store";
import { categoriesOf } from "@/lib/desk/apps";
import { AppEditor } from "@/components/adboard/desk/app-editor";
import { AppControls } from "@/components/adboard/desk/app-controls";
import { useDesk } from "@/components/adboard/desk/desk-context";
import {
  ConfirmDialog,
  PrimaryButton,
  EmptyState,
  ResultList,
  TargetChecks,
  TextField,
  picked,
  rowsFromCommand,
  useChecked,
  type ResultRow,
} from "@/components/adboard/desk/bits";

const btn = "pc-toggle pc-toggle-md min-h-11 px-3 text-sm";
const TABS = [
  ["launcher", "Launcher"],
  ["install", "Install APK"],
  ["packages", "Packages"],
  ["controls", "Controls"],
] as const;
type Tab = (typeof TABS)[number][0];
const errorRow = (id: string, error: unknown): ResultRow[] => [
  { deviceId: id, deviceName: id, state: "error", detail: error instanceof Error ? error.message : "Failed" },
];

/**
 * Apps for the phone: the same data and the same calls as the desktop panel
 * (desk/apps-panel.tsx), one app per row with full-width, 44 px buttons.
 */
export function AppsPanelMobile() {
  const desk = useDesk();
  const library = useLibrary();
  const initial: Tab = ["install", "packages", "controls"].includes(desk.focusTool ?? "") ? (desk.focusTool as Tab) : "launcher";
  const [tab, setTab] = useState<Tab>(initial);
  const [checked, setChecked] = useChecked(desk.devices, desk.targets);
  const [rows, setRows] = useState<ResultRow[]>([]);
  const [adding, setAdding] = useState<{ group?: string } | null>(null);
  const [editing, setEditing] = useState<AppShortcut | null>(null);

  // A new focus request from the desk (for example Tools → Install) switches the tab.
  const [seenFocus, setSeenFocus] = useState(desk.focusTool);
  if (desk.focusTool !== seenFocus) {
    setSeenFocus(desk.focusTool);
    if (["install", "packages", "launcher", "controls"].includes(desk.focusTool ?? "")) setTab(desk.focusTool as Tab);
  }

  const groups = useMemo(() => categoriesOf(library.apps), [library.apps]);
  const targets = picked(desk.devices, checked);
  const online = desk.devices.filter((device) => device.status === "online");
  const iconSerial = (desk.activeDevice?.status === "online" ? desk.activeDevice : online[0])?.serial ?? null;

  async function launch(app: AppShortcut, devices = targets) {
    if (devices.length === 0) return;
    const activity = [app.activity, app.arguments].filter(Boolean).join(" ");
    const response = await devicesClient.runCommand(devices, "launch", app.packageName, activity || undefined);
    setRows(rowsFromCommand(desk.devices, new Set(devices.map((device) => device.id)), response.results));
  }

  async function launchGroup(group: string) {
    const merged: ResultRow[] = [];
    for (const app of library.apps.filter((item) => (item.group || "Custom") === group)) {
      const response = await devicesClient.runCommand(
        targets,
        "launch",
        app.packageName,
        [app.activity, app.arguments].filter(Boolean).join(" ") || undefined,
      );
      merged.push(
        ...rowsFromCommand(targets, checked, response.results).map((row) => ({
          ...row,
          deviceId: `${row.deviceId}-${app.id}`,
          detail: `${app.name} ${row.detail ?? ""}`.trim(),
        })),
      );
    }
    setRows(merged);
  }

  return (
    <section data-desk-panel="apps" data-m-apps className="pc-clean flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto pb-2">
      <div className="grid grid-cols-2 gap-2">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" aria-pressed={tab === id} className={btn} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>

      {tab === "launcher" && (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-[var(--pc-muted)]">Your saved apps, by category. Scan a phone to pick apps, or enter a package by hand.</p>
          <button type="button" className={btn} onClick={() => setAdding({})} data-add-app-header>
            Add app
          </button>
          {library.apps.length === 0 && (
            <EmptyState title="No apps saved yet." action={<button type="button" className={btn} onClick={() => setAdding({})}>Add app</button>}>
              Save an app here to launch it on one phone or on all of them with one tap.
            </EmptyState>
          )}
          {groups.map((group) => {
            const apps = library.apps.filter((app) => (app.group || "Custom") === group);
            return (
              <section key={group} className="flex flex-col gap-2 rounded-xl border border-[var(--pc-line)] bg-[var(--pc-panel)] p-3">
                <h3 className="font-display text-sm font-semibold">{group}</h3>
                <div className="grid grid-cols-2 gap-2">
                  <button type="button" className={btn} onClick={() => setAdding({ group })} data-add-app-in={group}>
                    Add app
                  </button>
                  {apps.length > 0 && (
                    <button type="button" className={btn} onClick={() => void launchGroup(group)}>
                      Launch group
                    </button>
                  )}
                </div>
                {apps.map((app) => (
                  <article key={app.id} data-app-shortcut={app.name} className="flex flex-col gap-2 rounded-xl border border-[var(--pc-line)] bg-[var(--pc-paper)] p-3">
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 font-display text-sm font-semibold">
                        <AppIcon icon={app.icon} name={app.name} packageName={app.packageName} serial={iconSerial} />
                        <span className="min-w-0 truncate">{app.name}</span>
                      </p>
                      <p className="truncate font-mono text-[11px] text-[var(--pc-muted)]">{app.packageName}</p>
                    </div>
                    <div className="grid grid-cols-4 gap-1.5">
                      <button type="button" className={btn} onClick={() => void launch(app)}>Launch</button>
                      <button type="button" className={btn} onClick={() => void launch(app, online)}>All</button>
                      <button type="button" className={btn} onClick={() => setEditing(app)}>Edit</button>
                      <button
                        type="button"
                        className={btn}
                        onClick={() => updateLibrary((lib) => ({ ...lib, apps: lib.apps.filter((item) => item.id !== app.id) }))}
                      >
                        Delete
                      </button>
                    </div>
                  </article>
                ))}
                {group === "Custom" && (
                  <button type="button" data-add-app className="flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-dashed border-[var(--pc-line)] text-sm" onClick={() => setAdding({ group: "Custom" })}>
                    <Plus className="size-4" aria-hidden /> Add App
                  </button>
                )}
              </section>
            );
          })}
          <TargetChecks devices={desk.devices} checked={checked} onChange={setChecked} />
          <ResultList rows={rows} />
        </div>
      )}

      {tab === "install" && <InstallBox devices={desk.devices} checked={checked} onChange={setChecked} onDone={setRows} rows={rows} />}
      {tab === "packages" && (
        <PackageOps devices={desk.devices} checked={checked} onChange={setChecked} scanDevice={desk.activeDevice} onDone={setRows} rows={rows} />
      )}
      {tab === "controls" && <AppControls devices={desk.devices} checked={checked} onChecked={setChecked} />}

      {(adding || editing) && (
        <AppEditor
          devices={desk.devices}
          initial={editing}
          defaultGroup={adding?.group}
          onClose={() => {
            setAdding(null);
            setEditing(null);
          }}
        />
      )}
    </section>
  );
}

interface BoxProps {
  devices: Device[];
  checked: Set<string>;
  onChange: (next: Set<string>) => void;
  onDone: (rows: ResultRow[]) => void;
  rows: ResultRow[];
}

function InstallBox({ devices, checked, onChange, onDone, rows }: BoxProps) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const targets = picked(devices, checked);

  function install() {
    if (!file) return;
    setBusy(true);
    void devicesClient
      .installApk(targets.length > 1 ? "multi" : "selected", targets, file)
      .then((result) => {
        onDone(
          devices.map((device): ResultRow => {
            if (!checked.has(device.id)) return { deviceId: device.id, deviceName: device.name, state: "skipped", detail: "Skipped" };
            const row = result.targets.find((target) => target.deviceId === device.id);
            const ok = row?.inject === "ok" || row?.inject === "stub";
            return { deviceId: device.id, deviceName: device.name, state: ok ? "ok" : "error", detail: ok ? "Installed" : row?.detail || "Failed" };
          }),
        );
      })
      .catch((error: unknown) => onDone(errorRow("install", error).map((row) => ({ ...row, deviceName: "Install" }))))
      .finally(() => setBusy(false));
  }

  return (
    <div className="flex flex-col gap-3">
      <label data-apk-drop className="flex min-h-28 cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-[var(--pc-line)] p-4 text-center text-sm">
        {file ? file.name : "Choose an APK"}
        <input type="file" accept=".apk" className="sr-only" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
      </label>
      <TargetChecks devices={devices} checked={checked} onChange={onChange} />
      <PrimaryButton disabled={!file || busy || targets.length === 0} onClick={install}>
        INSTALL
      </PrimaryButton>
      <ResultList rows={rows} />
    </div>
  );
}

function PackageOps({ devices, checked, onChange, scanDevice, onDone, rows }: BoxProps & { scanDevice: Device | null }) {
  const [pkg, setPkg] = useState("com.example.app");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const targets = picked(devices, checked);

  async function run(op: "uninstall" | "launch" | "forceStop" | "clearData") {
    setBusy(true);
    try {
      const response = await devicesClient.runCommand(targets, op, pkg);
      onDone(rowsFromCommand(devices, checked, response.results));
    } catch (error) {
      onDone(errorRow(op, error));
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <TextField label="Package" value={pkg} onChange={setPkg} />
      {scanDevice && (
        <button
          type="button"
          className="min-h-11 self-start text-sm text-[var(--pc-accent)]"
          onClick={() => {
            void devicesClient.runCommand([scanDevice], "packages").then((response) => {
              const line = response.results[0]?.output
                ?.split("\n")
                .map((item) => item.replace(/^package:/, "").trim())
                .find(Boolean);
              if (line) setPkg(line);
            });
          }}
        >
          Scan {scanDevice.name}
        </button>
      )}
      <TargetChecks devices={devices} checked={checked} onChange={onChange} />
      <div className="grid grid-cols-2 gap-2">
        <PrimaryButton disabled={busy} onClick={() => void run("launch")}>
          Launch
        </PrimaryButton>
        <button type="button" className="min-h-11 rounded-lg border px-3 text-sm" disabled={busy} onClick={() => void run("forceStop")}>
          Force Stop
        </button>
        <button type="button" className="min-h-11 rounded-lg border px-3 text-sm" disabled={busy} onClick={() => void run("uninstall")}>
          Uninstall
        </button>
        <button type="button" className="min-h-11 rounded-lg border px-3 text-sm" disabled={busy} onClick={() => setConfirm(true)}>
          Clear Data
        </button>
      </div>
      <ResultList rows={rows} />
      {confirm && (
        <ConfirmDialog
          title="Clear application data?"
          body={
            <>
              <p className="font-mono text-xs text-[var(--pc-ink)]">{pkg}</p>
              <p className="mt-2">This will remove the application&apos;s local data.</p>
            </>
          }
          confirmLabel="Clear Data"
          busy={busy}
          onCancel={() => setConfirm(false)}
          onConfirm={() => void run("clearData")}
        />
      )}
    </div>
  );
}
