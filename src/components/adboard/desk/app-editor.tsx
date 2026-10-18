"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { devicesClient } from "@/lib/api/client";
import { loadAppIcon, loadAppMeta, typedIcon, badgeColor, type AppMeta } from "@/lib/api/app-icon";
import type { Device } from "@/lib/devices/types";
import { newId, updateLibrary, useLibrary, type AppShortcut } from "@/lib/desk/store";
import {
  DEFAULT_CATEGORY,
  categoriesOf,
  duplicateMessage,
  findDuplicate,
  matchesSearch,
  nameFromPackage,
  normalizeCategory,
  parsePackages,
} from "@/lib/desk/apps";
import { PrimaryButton, TextField } from "@/components/adboard/desk/bits";

const NEW_CATEGORY = "__new__";

/**
 * Add or edit a saved app in one place: pick the phone, scan its apps (name,
 * package and icon where the phone lets us read them), choose a category, and
 * save. Typing a package by hand still works. Apps already saved are marked and
 * can't be added twice, so scanning again never makes duplicates.
 */
export function AppEditor({
  devices,
  initial,
  defaultGroup,
  onClose,
}: {
  devices: Device[];
  initial: AppShortcut | null;
  defaultGroup?: string;
  onClose: () => void;
}) {
  const library = useLibrary();
  const categories = useMemo(() => categoriesOf(library.apps), [library.apps]);
  const online = devices.filter((d) => d.status === "online");

  const [deviceId, setDeviceId] = useState(online[0]?.id ?? devices[0]?.id ?? "");
  const device = devices.find((d) => d.id === deviceId) ?? null;
  const deviceOnline = device?.status === "online";

  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [found, setFound] = useState<string[] | null>(null);
  const [includeSystem, setIncludeSystem] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [labels, setLabels] = useState<Record<string, string | null>>({});

  const startGroup = initial?.group || defaultGroup || DEFAULT_CATEGORY;
  const [category, setCategory] = useState(categories.find((c) => c.toLowerCase() === startGroup.toLowerCase()) ?? startGroup);
  const [newCategory, setNewCategory] = useState("");

  const [name, setName] = useState(initial?.name ?? "");
  const [icon, setIcon] = useState(typedIcon(initial?.icon) ?? "");
  const [packageName, setPackageName] = useState(initial?.packageName ?? "");
  const [activity, setActivity] = useState(initial?.activity ?? "");
  const [args, setArgs] = useState(initial?.arguments ?? "");
  const [error, setError] = useState<string | null>(null);

  const saved = useMemo(() => new Map(library.apps.map((app) => [app.packageName.trim(), app])), [library.apps]);

  async function scan(system = includeSystem) {
    if (!device || !deviceOnline) {
      setScanNote({ tone: "error", text: device ? `${device.name} is ${device.status}. Connect it, then scan again.` : "No phone is connected." });
      return;
    }
    setScanning(true);
    setScanNote(null);
    setSelected([]);
    try {
      const response = await devicesClient.runCommand([device], "packages", system ? "all" : "user");
      const result = response.results[0];
      if (!result || !result.ok) {
        setFound(null);
        setScanNote({ tone: "error", text: result?.error || "The phone didn't answer. Check the cable and try again." });
        return;
      }
      const list = parsePackages(result.output);
      setFound(list);
      setScanNote({
        tone: "ok",
        text: list.length === 0 ? "No apps found." : `Found ${list.length} ${system ? "apps" : "apps you installed"} on ${device.name}.`,
      });
    } catch (e) {
      setFound(null);
      setScanNote({ tone: "error", text: e instanceof Error ? e.message : "Scan failed" });
    } finally {
      setScanning(false);
    }
  }

  /** Fill the form from one chosen app: its name and the screen that opens it. */
  async function fillFrom(pkg: string) {
    setPackageName(pkg);
    setError(null);
    setName(labels[pkg] || nameFromPackage(pkg));
    setActivity("");
    if (!device || !deviceOnline) return;
    try {
      const response = await devicesClient.runCommand([device], "shell", `cmd package resolve-activity --brief ${pkg}`);
      const line = response.results[0]?.output
        ?.split("\n")
        .map((item) => item.trim())
        .find((item) => item.includes("/"));
      if (line) {
        const component = line.split(/\s+/).pop() ?? "";
        const activityName = component.includes("/") ? component.split("/")[1] : component;
        setActivity(activityName.replace(/^\./, `${pkg}.`));
      }
    } catch {
      // Without an activity the app still opens from its launcher entry.
    }
  }

  function toggle(pkg: string) {
    const next = selected.includes(pkg) ? selected.filter((p) => p !== pkg) : [...selected, pkg];
    setSelected(next);
    setError(null);
    if (next.length === 1) void fillFrom(next[0]);
    if (next.length === 0 && !initial) {
      setPackageName("");
      setName("");
      setActivity("");
    }
  }

  const visible = (found ?? []).filter((pkg) => matchesSearch(pkg, labels[pkg], search));
  const several = selected.length > 1;

  function chosenCategory() {
    return normalizeCategory(category === NEW_CATEGORY ? newCategory : category, categories);
  }

  function save() {
    setError(null);
    if (category === NEW_CATEGORY && !newCategory.trim()) {
      setError("Type a name for the new category, or pick an existing one.");
      return;
    }
    const group = chosenCategory();
    if (several) {
      const fresh = selected.filter((pkg) => !saved.has(pkg));
      if (fresh.length === 0) {
        setError("Those apps are already saved.");
        return;
      }
      updateLibrary((lib) => ({
        ...lib,
        apps: [
          ...lib.apps,
          ...fresh
            .filter((pkg) => !findDuplicate(lib.apps, pkg))
            .map((pkg): AppShortcut => ({ id: newId("app"), name: labels[pkg] || nameFromPackage(pkg), packageName: pkg, activity: "", icon: "", group })),
        ],
      }));
      onClose();
      return;
    }
    const pkg = packageName.trim();
    if (!/^[A-Za-z0-9_.]+$/.test(pkg) || !pkg.includes(".")) {
      setError("Enter the app's package id, for example com.example.app (or scan the phone and pick it).");
      return;
    }
    const duplicate = findDuplicate(library.apps, pkg, initial?.id);
    if (duplicate) {
      setError(duplicateMessage(duplicate));
      return;
    }
    const next: AppShortcut = {
      id: initial?.id ?? newId("app"),
      name: name.trim() || labels[pkg] || nameFromPackage(pkg),
      icon,
      packageName: pkg,
      activity,
      arguments: args,
      group,
    };
    updateLibrary((lib) => ({
      ...lib,
      apps: initial ? lib.apps.map((app) => (app.id === initial.id ? next : app)) : [...lib.apps, next],
    }));
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" data-app-editor>
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-app-title"
        className="flex max-h-[90dvh] w-full max-w-lg flex-col gap-3 overflow-y-auto rounded-xl bg-[var(--pc-paper)] p-4"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <h3 id="add-app-title" className="font-display text-base font-semibold">
          {initial ? "Edit app" : "Add app"}
        </h3>

        <section className="flex flex-col gap-2" data-app-scan>
          <label className="text-sm">
            Phone to scan
            <select
              value={deviceId}
              onChange={(event) => {
                setDeviceId(event.target.value);
                setFound(null);
                setSelected([]);
                setScanNote(null);
              }}
              className="mt-1 h-11 w-full rounded-lg border border-[var(--pc-line)] bg-[var(--pc-panel)] px-2"
              data-app-device
            >
              {devices.map((d) => (
                <option key={d.id} value={d.id} disabled={d.status !== "online"}>
                  {d.name}
                  {d.status !== "online" ? ` (${d.status})` : ""}
                </option>
              ))}
            </select>
          </label>
          {devices.length === 0 && <p className="text-xs text-[var(--pc-muted)]">No phone is connected. You can still enter a package by hand below.</p>}
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="pc-toggle pc-toggle-md"
              disabled={scanning || !deviceOnline}
              onClick={() => void scan()}
              data-app-scan-button
            >
              {scanning ? "Scanning…" : found ? "Scan again" : "Scan installed apps"}
            </button>
            <label className="flex items-center gap-2 text-xs text-[var(--pc-muted)]">
              <input
                type="checkbox"
                checked={includeSystem}
                disabled={scanning}
                onChange={(event) => {
                  setIncludeSystem(event.target.checked);
                  if (found) void scan(event.target.checked);
                }}
                data-app-include-system
              />
              Include system apps
            </label>
          </div>
          {scanNote && (
            <p role="status" className={scanNote.tone === "error" ? "text-xs text-[var(--pc-warn)]" : "text-xs text-[var(--pc-signal)]"} data-app-scan-note>
              {scanNote.text}
            </p>
          )}
          {found && found.length > 0 && (
            <div className="flex flex-col gap-2" data-app-found>
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search apps (name or package)"
                aria-label="Search scanned apps"
                className="h-11 rounded-xl border border-[var(--pc-line)] bg-[var(--pc-panel)] px-3 text-sm"
                data-app-search
              />
              <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto rounded-xl border border-[var(--pc-line)] p-1" data-app-list>
                {visible.length === 0 && <li className="px-2 py-2 text-xs text-[var(--pc-muted)]">No app matches “{search}”.</li>}
                {visible.map((pkg) => (
                  <ScanRow
                    key={pkg}
                    pkg={pkg}
                    serial={device?.serial ?? null}
                    existing={saved.get(pkg)}
                    checked={selected.includes(pkg)}
                    onToggle={() => toggle(pkg)}
                    onMeta={(meta) => setLabels((prev) => (prev[pkg] === meta?.label ? prev : { ...prev, [pkg]: meta?.label ?? null }))}
                  />
                ))}
              </ul>
              {selected.length > 0 && <p className="text-xs text-[var(--pc-muted)]">{selected.length} selected</p>}
            </div>
          )}
        </section>

        <label className="text-sm">
          Category
          <select
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            className="mt-1 h-11 w-full rounded-lg border border-[var(--pc-line)] bg-[var(--pc-panel)] px-2"
            data-app-category
          >
            {categories.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
            <option value={NEW_CATEGORY}>New category…</option>
          </select>
        </label>
        {category === NEW_CATEGORY && <TextField label="New category name" value={newCategory} onChange={setNewCategory} placeholder="Farm bots" />}

        {several ? (
          <p className="rounded-xl bg-[var(--pc-accent-soft)] px-3 py-2 text-xs text-[var(--pc-ink)]" data-app-several>
            {selected.length} apps selected. They are saved in {chosenCategory()} with the names shown. Pick just one to edit its name, icon or details first.
          </p>
        ) : (
          <details open={selected.length === 0 || !!initial} className="flex flex-col gap-2" data-app-details>
            <summary className="cursor-pointer text-sm">Details{selected.length === 0 ? " (enter a package by hand)" : ""}</summary>
            <div className="mt-2 flex flex-col gap-2">
              <TextField label="Package" value={packageName} onChange={(v) => { setPackageName(v); setError(null); }} placeholder="com.example.app" />
              <TextField label="Name" value={name} onChange={setName} />
              <TextField label="Icon (optional: empty uses the app's own icon)" value={icon} onChange={setIcon} />
              <TextField label="Activity (optional)" value={activity} onChange={setActivity} />
              <TextField label="Arguments (optional)" value={args} onChange={setArgs} />
            </div>
          </details>
        )}

        {error && (
          <p role="alert" className="text-xs text-[var(--pc-warn)]" data-app-error>
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="h-11 px-3 text-sm" onClick={onClose}>
            Cancel
          </button>
          <PrimaryButton type="submit">{several ? `Add ${selected.length} apps` : initial ? "Save" : "Add app"}</PrimaryButton>
        </div>
      </form>
    </div>
  );
}

/** One scanned app: icon, name (when readable), package id, and a checkbox. Name and icon load when the row is on screen. */
function ScanRow({
  pkg,
  serial,
  existing,
  checked,
  onToggle,
  onMeta,
}: {
  pkg: string;
  serial: string | null;
  existing: AppShortcut | undefined;
  checked: boolean;
  onToggle: () => void;
  onMeta: (meta: AppMeta | null) => void;
}) {
  const ref = useRef<HTMLLIElement>(null);
  // Browsers without IntersectionObserver just load every row.
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === "undefined");
  const [meta, setMeta] = useState<AppMeta | null>(null);
  const [iconUrl, setIconUrl] = useState<string | null>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node || seen || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setSeen(true), { rootMargin: "40px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [seen]);

  useEffect(() => {
    if (!seen || !serial) return;
    let live = true;
    void loadAppMeta(serial, pkg).then((m) => {
      if (!live) return;
      setMeta(m);
      onMeta(m);
      if (m?.hasIcon) void loadAppIcon(serial, pkg).then((url) => live && setIconUrl(url));
    });
    return () => {
      live = false;
    };
    // onMeta changes every render; the lookup is keyed by package.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seen, serial, pkg]);

  const title = meta?.label || nameFromPackage(pkg);
  return (
    <li ref={ref} data-app-row={pkg}>
      <label className={`flex min-h-11 items-center gap-2 rounded-lg px-2 py-1 ${existing ? "opacity-60" : "cursor-pointer hover:bg-[var(--pc-accent-soft)]"}`}>
        <input type="checkbox" checked={checked} disabled={!!existing} onChange={onToggle} aria-label={`Select ${title}`} />
        {iconUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- a blob URL from the agent
          <img src={iconUrl} alt="" aria-hidden className="size-7 shrink-0 rounded-md object-contain" data-app-row-icon />
        ) : (
          <span
            aria-hidden
            style={{ background: badgeColor(pkg) }}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-xs font-semibold uppercase text-white"
            data-app-row-badge
          >
            {title[0] ?? "?"}
          </span>
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm text-[var(--pc-ink)]" data-app-row-name>
            {title}
          </span>
          <span className="truncate font-mono text-[10px] text-[var(--pc-muted)]">{pkg}</span>
        </span>
        {existing && (
          <span className="shrink-0 text-[10px] text-[var(--pc-muted)]" data-app-row-added>
            Already added ({existing.group || DEFAULT_CATEGORY})
          </span>
        )}
      </label>
    </li>
  );
}
