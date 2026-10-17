"use client";

import { useEffect, useMemo, useState } from "react";
import { devicesClient } from "@/lib/api/client";
import type { Device } from "@/lib/devices/types";
import {
  APP_GROUPS,
  newId,
  updateLibrary,
  useLibrary,
  type AppShortcut,
} from "@/lib/desk/store";
import { useDesk } from "@/components/adboard/desk/desk-context";
import {
  ConfirmDialog,
  PanelFrame,
  PrimaryButton,
  ResultList,
  TargetChecks,
  TextField,
  picked,
  rowsFromCommand,
  useChecked,
  type ResultRow,
} from "@/components/adboard/desk/bits";

export function AppsPanel() {
  const desk = useDesk();
  const library = useLibrary();
  const initial = desk.focusTool === "install" || desk.focusTool === "packages" ? desk.focusTool : "launcher";
  const [tab, setTab] = useState(initial);
  const [checked, setChecked] = useChecked(desk.devices, desk.targets);
  const [rows, setRows] = useState<ResultRow[]>([]);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<AppShortcut | null>(null);

  useEffect(() => {
    if (desk.focusTool === "install" || desk.focusTool === "packages" || desk.focusTool === "launcher") {
      setTab(desk.focusTool);
    }
  }, [desk.focusTool]);

  const groups = useMemo(() => {
    const names = new Set<string>(APP_GROUPS);
    for (const app of library.apps) names.add(app.group || "Custom");
    return [...names];
  }, [library.apps]);

  const targets = picked(desk.devices, checked);
  const online = desk.devices.filter((device) => device.status === "online");

  async function launch(app: AppShortcut, devices = targets) {
    if (devices.length === 0) return;
    const activity = [app.activity, app.arguments].filter(Boolean).join(" ");
    const response = await devicesClient.runCommand(devices, "launch", app.packageName, activity || undefined);
    setRows(rowsFromCommand(desk.devices, new Set(devices.map((device) => device.id)), response.results));
  }

  async function launchGroup(group: string) {
    const apps = library.apps.filter((app) => app.group === group);
    const merged: ResultRow[] = [];
    for (const app of apps) {
      const response = await devicesClient.runCommand(
        targets,
        "launch",
        app.packageName,
        [app.activity, app.arguments].filter(Boolean).join(" ") || undefined,
      );
      merged.push(...rowsFromCommand(targets, checked, response.results).map((row) => ({
        ...row,
        deviceId: `${row.deviceId}-${app.id}`,
        detail: `${app.name} ${row.detail ?? ""}`.trim(),
      })));
    }
    setRows(merged);
  }

  return (
    <PanelFrame title="Apps" panel="apps">
      <div className="flex flex-wrap gap-2">
        {(
          [
            ["launcher", "Launcher"],
            ["install", "Install APK"],
            ["packages", "Packages"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={tab === id}
            className={`h-11 rounded-lg px-3 text-sm ${tab === id ? "bg-[var(--pc-accent-fill)] text-white" : "border border-[var(--pc-line)]"}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "launcher" && (
        <div className="flex flex-col gap-4">
          {groups.map((group) => {
            const apps = library.apps.filter((app) => (app.group || "Custom") === group);
            return (
              <section key={group} className="rounded-xl border border-[var(--pc-line)] p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h3 className="font-display text-sm font-semibold">{group}</h3>
                  {apps.length > 0 && (
                    <button type="button" className="h-11 px-2 text-sm text-[var(--pc-accent)]" onClick={() => void launchGroup(group)}>
                      Launch group
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {apps.map((app) => (
                    <article key={app.id} data-app-shortcut={app.name} className="rounded-xl bg-[var(--pc-panel)] p-3">
                      <p className="font-display text-sm font-semibold">
                        {app.icon || "📱"} {app.name}
                      </p>
                      <p className="truncate font-mono text-[10px] text-[var(--pc-muted)]">{app.packageName}</p>
                      <div className="mt-2 flex flex-wrap gap-1">
                        <Mini label="Launch" onClick={() => void launch(app)} />
                        <Mini label="All" onClick={() => void launch(app, online)} />
                        <Mini label="Edit" onClick={() => setEditing(app)} />
                        <Mini
                          label="Delete"
                          onClick={() =>
                            updateLibrary((library) => ({
                              ...library,
                              apps: library.apps.filter((item) => item.id !== app.id),
                            }))
                          }
                        />
                      </div>
                    </article>
                  ))}
                  {group === "Custom" && (
                    <button
                      type="button"
                      data-add-app
                      className="flex min-h-24 items-center justify-center rounded-xl border border-dashed border-[var(--pc-line)] text-sm"
                      onClick={() => setAdding(true)}
                    >
                      ➕ Add App
                    </button>
                  )}
                </div>
              </section>
            );
          })}
          <TargetChecks devices={desk.devices} checked={checked} onChange={setChecked} />
          <ResultList rows={rows} />
        </div>
      )}

      {tab === "install" && (
        <InstallBox devices={desk.devices} checked={checked} onChange={setChecked} onDone={setRows} rows={rows} />
      )}

      {tab === "packages" && (
        <PackageOps
          devices={desk.devices}
          checked={checked}
          onChange={setChecked}
          scanDevice={desk.activeDevice}
          onDone={setRows}
          rows={rows}
        />
      )}

      {(adding || editing) && (
        <AppEditor
          devices={desk.devices}
          initial={editing}
          onClose={() => {
            setAdding(false);
            setEditing(null);
          }}
        />
      )}
    </PanelFrame>
  );
}

function Mini({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="h-9 rounded-md px-2 text-xs text-[var(--pc-accent)]" onClick={onClick}>
      {label}
    </button>
  );
}

function InstallBox({
  devices,
  checked,
  onChange,
  onDone,
  rows,
}: {
  devices: Device[];
  checked: Set<string>;
  onChange: (next: Set<string>) => void;
  onDone: (rows: ResultRow[]) => void;
  rows: ResultRow[];
}) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const targets = picked(devices, checked);

  return (
    <div className="flex flex-col gap-3">
      <label
        data-apk-drop
        className="flex min-h-28 cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-[var(--pc-line)] p-4 text-sm"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          const next = event.dataTransfer.files[0];
          if (next) setFile(next);
        }}
      >
        {file ? file.name : "Drag an APK into the UI"}
        <input
          type="file"
          accept=".apk"
          className="sr-only"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />
      </label>
      <TargetChecks devices={devices} checked={checked} onChange={onChange} />
      <PrimaryButton
        disabled={!file || busy || targets.length === 0}
        onClick={() => {
          if (!file) return;
          setBusy(true);
          void devicesClient
            .installApk(targets.length > 1 ? "multi" : "selected", targets, file)
            .then((result) => {
              const fromInstall: ResultRow[] = devices.map((device) => {
                if (!checked.has(device.id)) {
                  return { deviceId: device.id, deviceName: device.name, state: "skipped", detail: "Skipped" };
                }
                const row = result.targets.find((target) => target.deviceId === device.id);
                const ok = row?.inject === "ok" || row?.inject === "stub";
                return {
                  deviceId: device.id,
                  deviceName: device.name,
                  state: ok ? "ok" : "error",
                  detail: ok ? "Installed" : row?.detail || "Failed",
                };
              });
              onDone(fromInstall);
            })
            .catch((error: unknown) => {
              onDone([
                {
                  deviceId: "install",
                  deviceName: "Install",
                  state: "error",
                  detail: error instanceof Error ? error.message : "Failed",
                },
              ]);
            })
            .finally(() => setBusy(false));
        }}
      >
        INSTALL
      </PrimaryButton>
      <ResultList rows={rows} />
    </div>
  );
}

function PackageOps({
  devices,
  checked,
  onChange,
  scanDevice,
  onDone,
  rows,
}: {
  devices: Device[];
  checked: Set<string>;
  onChange: (next: Set<string>) => void;
  scanDevice: Device | null;
  onDone: (rows: ResultRow[]) => void;
  rows: ResultRow[];
}) {
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
      onDone([
        {
          deviceId: op,
          deviceName: op,
          state: "error",
          detail: error instanceof Error ? error.message : "Failed",
        },
      ]);
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
          className="h-11 self-start text-sm text-[var(--pc-accent)]"
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
      <div className="flex flex-wrap gap-2">
        <PrimaryButton disabled={busy} onClick={() => void run("launch")}>
          Launch
        </PrimaryButton>
        <button type="button" className="h-11 rounded-lg border px-3 text-sm" disabled={busy} onClick={() => void run("forceStop")}>
          Force Stop
        </button>
        <button type="button" className="h-11 rounded-lg border px-3 text-sm" disabled={busy} onClick={() => void run("uninstall")}>
          Uninstall
        </button>
        <button type="button" className="h-11 rounded-lg border px-3 text-sm" disabled={busy} onClick={() => setConfirm(true)}>
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

function AppEditor({
  devices,
  initial,
  onClose,
}: {
  devices: Device[];
  initial: AppShortcut | null;
  onClose: () => void;
}) {
  const [deviceId, setDeviceId] = useState(devices.find((device) => device.status === "online")?.id ?? "");
  const [packages, setPackages] = useState<string[]>([]);
  const [name, setName] = useState(initial?.name ?? "");
  const [icon, setIcon] = useState(initial?.icon ?? "📱");
  const [packageName, setPackageName] = useState(initial?.packageName ?? "");
  const [activity, setActivity] = useState(initial?.activity ?? "");
  const [args, setArgs] = useState(initial?.arguments ?? "");
  const [group, setGroup] = useState(initial?.group ?? "Custom");

  async function scan() {
    const device = devices.find((item) => item.id === deviceId);
    if (!device) return;
    const response = await devicesClient.runCommand([device], "packages");
    const found =
      response.results[0]?.output
        ?.split("\n")
        .map((line) => line.replace(/^package:/, "").trim())
        .filter(Boolean) ?? [];
    setPackages(found);
  }

  async function choose(pkg: string) {
    setPackageName(pkg);
    if (!name) setName(pkg.split(".").pop() || pkg);
    const device = devices.find((item) => item.id === deviceId);
    if (!device) return;
    const response = await devicesClient.runCommand(
      [device],
      "shell",
      `cmd package resolve-activity --brief ${pkg}`,
    );
    const line = response.results[0]?.output
      ?.split("\n")
      .map((item) => item.trim())
      .find((item) => item.includes("/"));
    if (line) {
      const component = line.split(/\s+/).pop() ?? "";
      const activityName = component.includes("/") ? component.split("/")[1] : component;
      setActivity(activityName.replace(/^\./, `${pkg}.`));
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <form
        role="dialog"
        aria-labelledby="add-app-title"
        className="flex max-h-[90dvh] w-full max-w-md flex-col gap-2 overflow-y-auto rounded-xl bg-[var(--pc-paper)] p-4"
        onSubmit={(event) => {
          event.preventDefault();
          updateLibrary((library) => {
            const next: AppShortcut = {
              id: initial?.id ?? newId("app"),
              name: name || packageName,
              icon,
              packageName,
              activity,
              arguments: args,
              group,
            };
            const apps = initial
              ? library.apps.map((app) => (app.id === initial.id ? next : app))
              : [...library.apps, next];
            return { ...library, apps };
          });
          onClose();
        }}
      >
        <h3 id="add-app-title" className="font-display text-base font-semibold">
          {initial ? "Edit app" : "Add App"}
        </h3>
        <label className="text-sm">
          Device
          <select
            value={deviceId}
            onChange={(event) => setDeviceId(event.target.value)}
            className="mt-1 h-11 w-full rounded-lg border px-2"
          >
            {devices.map((device) => (
              <option key={device.id} value={device.id}>
                {device.name}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="h-11 self-start text-sm text-[var(--pc-accent)]" onClick={() => void scan()}>
          Scan installed applications
        </button>
        {packages.length > 0 && (
          <label className="text-sm">
            Application
            <select className="mt-1 h-11 w-full rounded-lg border px-2" value={packageName} onChange={(event) => void choose(event.target.value)}>
              <option value="">Select</option>
              {packages.map((pkg) => (
                <option key={pkg} value={pkg}>
                  {pkg}
                </option>
              ))}
            </select>
          </label>
        )}
        <TextField label="Name" value={name} onChange={setName} />
        <TextField label="Icon" value={icon} onChange={setIcon} />
        <TextField label="Package" value={packageName} onChange={setPackageName} />
        <TextField label="Activity" value={activity} onChange={setActivity} />
        <TextField label="Arguments" value={args} onChange={setArgs} />
        <label className="text-sm">
          Group
          <select value={group} onChange={(event) => setGroup(event.target.value)} className="mt-1 h-11 w-full rounded-lg border px-2">
            {APP_GROUPS.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" className="h-11 px-3 text-sm" onClick={onClose}>
            Cancel
          </button>
          <PrimaryButton type="submit">Save</PrimaryButton>
        </div>
      </form>
    </div>
  );
}
