"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { agentBaseUrl, agentFetch } from "@/lib/api/auth";
import { useSyncWarnings } from "@/lib/sync/agent-store";
import { backupNow, describeImport, exportWholeLibrary, importWholeLibrary } from "@/lib/library";
import { LIBRARY_FILE } from "@/lib/adboard-files";
import { ConfirmDialog } from "@/components/adboard/desk/bits";

/*
 * Where ADBoard keeps its data (GET /api/system/storage) and the tools around
 * it: open a folder on the ADBoard computer, copy a path, back up now, export
 * or import the whole library.
 */

export interface StorageInfo {
  dataDir: string;
  source: "override" | "chosen" | "appFolder" | "platform" | "fallback";
  platform: string;
  folders: Record<string, string>;
  /** Files and bytes per folder (scratch space included). */
  sizes?: Record<string, { files: number; bytes: number }>;
  location?: { appFolder: string | null; file: string | null; saved: string | null; restartRequired: boolean };
  /** The app folder and the per-user folder, and whether each already holds data. */
  targets?: { app: string | null; user: string | null; appHasData: boolean; userHasData: boolean };
  /** Store item id → file name in macros\ or shell_scripts\. */
  itemFiles: { macros: Record<string, string>; shellScripts: Record<string, string> };
  migration: { ranAt: number; backup: string | null; items: { kind: string; source: string; action: string; detail: string }[] } | null;
  editable: string[];
  doNotEdit: string[];
}

type Folder = "root" | "macros" | "shell_scripts" | "config" | "logs" | "backups" | "files";

const FOLDERS: { id: Folder; label: string; what: string }[] = [
  { id: "macros", label: "macros", what: "Touch macros, one .json file each" },
  { id: "shell_scripts", label: "shell_scripts", what: "Shell Automation scripts, one .json file each, and _library.json (apps, variables, groups, profiles)" },
  { id: "config", label: "config", what: "Settings (user_config.json), layout per browser, editor state, queue, schedules, phone choices, sign-in account" },
  { id: "logs", label: "logs", what: "adboard.log and the Shell Automation run history" },
  { id: "backups", label: "backups", what: "Earlier versions, deleted items, unreadable files, Back up now copies, data moved from older versions" },
  { id: "files", label: "files", what: "Files area: screenshots, recordings, APKs, downloads" },
];

/* --------------------------- shared fetch --------------------------- */

let info: StorageInfo | null = null;
let error: string | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export function refreshStorageInfo(): Promise<void> {
  const base = agentBaseUrl();
  if (base === null) return Promise.resolve();
  loading = agentFetch(`${base}/api/system/storage`, { cache: "no-store" })
    .then(async (res) => {
      if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
      info = (await res.json()) as StorageInfo;
      error = null;
    })
    .catch((e: unknown) => {
      error = `Couldn't read the data folder location: ${e instanceof Error ? e.message : String(e)}`;
    })
    .finally(notify);
  return loading;
}

/** Storage info from the agent; null without an agent (in-browser demo). */
export function useStorageInfo() {
  const state = useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => (info ? info : error),
    () => null,
  );
  useEffect(() => {
    if (!info && !loading) void refreshStorageInfo();
  }, []);
  return { info: typeof state === "object" ? state : null, error: typeof state === "string" ? state : null };
}

export async function openFolder(which: Folder): Promise<string> {
  const base = agentBaseUrl();
  if (base === null) throw new Error("No ADBoard agent: data is kept in this browser only.");
  const res = await agentFetch(`${base}/api/system/open-folder`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ which }),
  });
  const body = (await res.json().catch(() => ({}))) as { path?: string; error?: string };
  if (!res.ok) throw new Error(body.error ?? `Couldn't open the folder (${res.status})`);
  return body.path ?? "";
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/* ---------------------------- folder hint ---------------------------- */

/**
 * "Saved in …\macros · Open folder", with the open item's file name and any
 * warning from the last load (an unreadable file moved to backups\corrupt).
 */
export function FolderHint({ folder, store, itemId }: { folder: "macros" | "shell_scripts"; store: "macros" | "desk"; itemId?: string | null }) {
  const { info } = useStorageInfo();
  const warnings = useSyncWarnings(store);
  const [note, setNote] = useState<string | null>(null);
  const files = folder === "macros" ? info?.itemFiles.macros : info?.itemFiles.shellScripts;
  const file = itemId ? files?.[itemId] : undefined;
  useEffect(() => {
    // The agent names new items when it saves them; ask again shortly after.
    if (itemId && files && !file) {
      const timer = window.setTimeout(() => void refreshStorageInfo(), 2500);
      return () => window.clearTimeout(timer);
    }
  }, [itemId, files, file]);
  if (!info) {
    return warnings.length > 0 ? <Warnings warnings={warnings} /> : null;
  }
  const path = info.folders[folder];
  return (
    <div className="flex flex-col gap-1 text-[11px] text-[var(--pc-muted)]" data-folder-hint={folder}>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span>
          Saved in <span className="break-all font-mono">{path}</span>
          {file && (
            <>
              {" "}
              as <span className="font-mono text-[var(--pc-ink)]" data-folder-hint-file>{file}</span>
            </>
          )}
        </span>
        <button
          type="button"
          className="underline underline-offset-2 hover:text-[var(--pc-ink)]"
          onClick={() => openFolder(folder).then(() => setNote(null), (e: Error) => setNote(e.message))}
        >
          Open folder
        </button>
      </p>
      {note && <p className="text-[var(--pc-warn)]">{note}</p>}
      {warnings.length > 0 && <Warnings warnings={warnings} />}
    </div>
  );
}

function Warnings({ warnings }: { warnings: string[] }) {
  return (
    <ul className="rounded-lg bg-[var(--pc-warn-soft)] px-2 py-1 text-[11px] text-[var(--pc-warn)]" data-sync-warnings>
      {warnings.map((w) => (
        <li key={w}>{w}</li>
      ))}
    </ul>
  );
}

/* --------------------------- settings card --------------------------- */

export function DataStorageCard() {
  const { info, error } = useStorageInfo();
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ name: string; text: string } | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const viaAgent = agentBaseUrl() !== null;

  const run = async (work: () => Promise<string>) => {
    setBusy(true);
    try {
      setNotice({ tone: "ok", text: await work() });
    } catch (e) {
      setNotice({ tone: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  const doImport = (mode: "merge" | "replace") => {
    if (!pending) return;
    const { text, name } = pending;
    setPending(null);
    setConfirmReplace(false);
    void run(async () => `Imported ${name}. ${describeImport(await importWholeLibrary(text, mode))}`).then(() => refreshStorageInfo());
  };

  const migration = info?.migration;
  const migrated = migration?.items.filter((i) => i.action === "migrated").length ?? 0;
  const failed = migration?.items.filter((i) => i.action === "failed") ?? [];
  const kept = migration?.items.filter((i) => i.action === "kept-existing") ?? [];

  return (
    <section className="flex min-w-0 flex-col gap-2 rounded-2xl border border-[var(--pc-line)] bg-[var(--pc-panel)] p-3 lg:col-span-2" data-settings-data>
      <h3 className="font-display text-sm font-semibold text-[var(--pc-ink)]">Data &amp; storage</h3>
      {!viaAgent && (
        <p className="text-xs text-[var(--pc-muted)]">In-browser demo: macros and scripts are kept in this browser only. Export the library to keep a copy.</p>
      )}
      {error && <p className="text-xs text-[var(--pc-warn)]">{error}</p>}
      {info && (
        <>
          <p className="text-xs text-[var(--pc-muted)]">
            ADBoard keeps macros, scripts and settings on the ADBoard computer in{" "}
            <span className="break-all font-mono text-[var(--pc-ink)]" data-settings-data-dir>
              {info.dataDir}
            </span>
            {info.source === "override" ? " (set by ADBOARD_DATA_DIR — portable mode)." : ". Updating, reinstalling or a Git pull never touches it."}
          </p>
          <PathRow label="Data folder" what="Everything below" path={info.dataDir} which="root" onNotice={setNotice} />
          <ul className="flex flex-col gap-1">
            {FOLDERS.map((f) => (
              <li key={f.id}>
                <PathRow label={f.label} what={f.what} path={info.folders[f.id] ?? ""} which={f.id} size={info.sizes?.[f.id]} onNotice={setNotice} />
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="flex flex-wrap gap-2">
        {viaAgent && (
          <button
            type="button"
            className="pc-toggle pc-toggle-md"
            disabled={busy}
            onClick={() => void run(async () => `Backed up to ${await backupNow()}`)}
            data-settings-backup
          >
            Back up now
          </button>
        )}
        <button type="button" className="pc-toggle pc-toggle-md" onClick={() => void exportWholeLibrary()} data-settings-export-library>
          Export library
        </button>
        <button type="button" className="pc-toggle pc-toggle-md" disabled={busy} onClick={() => fileRef.current?.click()} data-settings-import-library>
          Import library
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="sr-only"
          data-settings-import-input
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
            void file.text().then(
              (text) => setPending({ name: file.name, text }),
              () => setNotice({ tone: "error", text: `Could not read ${file.name}.` }),
            );
          }}
        />
      </div>
      <p className="text-xs text-[var(--pc-muted)]">
        <span className="font-mono">{LIBRARY_FILE}</span> holds everything: touch macros, Shell Automation scripts, apps, variables, groups, profiles, the queue, schedules
        and per-phone macro choices. One macro or script is exported from Macros or the Shell Library.
      </p>

      {pending && !confirmReplace && (
        <div className="flex flex-col gap-2 rounded-xl border border-[var(--pc-accent)] p-2 text-xs" data-settings-import-choice>
          <p className="text-[var(--pc-ink)]">
            Import <span className="font-mono">{pending.name}</span>: add it to the current library, or replace the library with it?
            {viaAgent ? " The current data is backed up first either way." : ""}
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="pc-toggle pc-toggle-sm" onClick={() => doImport("merge")} data-settings-import-merge>
              Add (keep current items)
            </button>
            <button type="button" className="pc-toggle pc-toggle-sm" onClick={() => setConfirmReplace(true)} data-settings-import-replace>
              Replace…
            </button>
            <button type="button" className="pc-toggle pc-toggle-sm" onClick={() => setPending(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {pending && confirmReplace && (
        <ConfirmDialog
          title="Replace the whole library?"
          body={`Every touch macro, Shell Automation script, queue item and schedule is replaced by the contents of ${pending.name}.${viaAgent ? " A backup of the current data is made first, in backups." : ""}`}
          confirmLabel="Replace library"
          onCancel={() => setConfirmReplace(false)}
          onConfirm={() => doImport("replace")}
        />
      )}
      {notice && (
        <p role="status" className={notice.tone === "error" ? "text-xs text-[var(--pc-warn)]" : "text-xs text-[var(--pc-signal)]"} data-settings-data-notice>
          {notice.text}
        </p>
      )}

      {migration && migration.items.length > 0 && (
        <details className="text-xs text-[var(--pc-muted)]" data-settings-migration>
          <summary className="cursor-pointer">
            Data from an older version: {migrated} moved here{kept.length ? `, ${kept.length} kept aside (data was already here)` : ""}
            {failed.length ? `, ${failed.length} failed` : ""}
            {migration.backup ? ` · originals in ${migration.backup}` : ""}
          </summary>
          <ul className="mt-1 flex flex-col gap-1">
            {migration.items.map((item, i) => (
              <li key={i} className={item.action === "failed" ? "text-[var(--pc-warn)]" : undefined}>
                <span className="font-mono">{item.kind}</span> — {item.action}: {item.detail} <span className="break-all font-mono">({item.source})</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {info && (
        <details className="text-xs text-[var(--pc-muted)]" data-settings-editing>
          <summary className="cursor-pointer">Which files can I edit by hand?</summary>
          <p className="mt-1">Safe to edit or copy in while ADBoard is closed (a file that can&apos;t be read is moved to backups\corrupt and reported):</p>
          <ul className="ml-4 list-disc font-mono">
            {info.editable.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
          <p className="mt-1">Don&apos;t edit (ADBoard manages them):</p>
          <ul className="ml-4 list-disc font-mono">
            {info.doNotEdit.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function PathRow({
  label,
  what,
  path,
  which,
  size,
  onNotice,
}: {
  label: string;
  what: string;
  path: string;
  which: Folder;
  size?: { files: number; bytes: number };
  onNotice: (n: { tone: "ok" | "error"; text: string }) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-[var(--pc-line)] px-2 py-1.5" data-settings-folder={which}>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-xs font-semibold text-[var(--pc-ink)]">{label}</span>
        <span className="text-[11px] text-[var(--pc-muted)]">
          {what}
          {size && ` · ${size.files} ${size.files === 1 ? "file" : "files"}, ${formatSize(size.bytes)}`}
        </span>
        <span className="break-all font-mono text-[11px] text-[var(--pc-muted)]">{path}</span>
      </div>
      <button
        type="button"
        className="pc-toggle pc-toggle-sm"
        title="Opens on the ADBoard computer"
        onClick={() => openFolder(which).then((p) => onNotice({ tone: "ok", text: `Opened ${p} on the ADBoard computer.` }), (e: Error) => onNotice({ tone: "error", text: e.message }))}
      >
        Open
      </button>
      <button
        type="button"
        className="pc-toggle pc-toggle-sm"
        onClick={() => void copyText(path).then((ok) => onNotice(ok ? { tone: "ok", text: `Copied ${path}` } : { tone: "error", text: `Couldn't copy; the path is ${path}` }))}
      >
        Copy path
      </button>
    </div>
  );
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
