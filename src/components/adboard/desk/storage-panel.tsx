"use client";

import { useState } from "react";
import { agentBaseUrl, agentFetch } from "@/lib/api/auth";
import { ConfirmDialog, PanelFrame } from "@/components/adboard/desk/bits";
import { openFolder, refreshStorageInfo, useStorageInfo } from "@/components/adboard/desk/data-storage";

/*
 * Settings-free home for "where is my data": the current folder, what is in
 * each folder, and a choice of any other folder (use it, or move the data
 * there). A changed location takes effect on the next start of ADBoard.
 */

const SOURCE_TEXT: Record<string, string> = {
  override: "Set by the ADBOARD_DATA_DIR environment variable.",
  chosen: "Chosen below.",
  appFolder: "The default: a folder beside ADBoard.",
  platform: "Your user folder, from an earlier version. You can move it below.",
  fallback: "A temporary folder (no home folder was found).",
};

const FOLDER_TEXT: Record<string, string> = {
  macros: "Touch macros, one file each",
  shell_scripts: "Shell Automation scripts, one file each",
  config: "Settings, layout, queue, schedules, sign-in account",
  logs: "adboard.log and run history",
  backups: "Earlier versions, deleted items, copies made before changes",
  files: "Screenshots, recordings, APKs, downloads",
  temp: "Scratch space (not moved)",
};

function countFiles(n: number) {
  return `${n} ${n === 1 ? "file" : "files"}`;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

async function postLocation(path: string, mode: "use" | "move") {
  const base = agentBaseUrl();
  if (base === null) throw new Error("No ADBoard agent: data is kept in this browser only.");
  const res = await agentFetch(`${base}/api/system/location`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, mode }),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string; files?: number; bytes?: number; to?: string };
  if (!res.ok) throw new Error(body.error ?? `Couldn't change the location (${res.status})`);
  return body;
}

export function StoragePanel() {
  const { info, error } = useStorageInfo();
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [confirmMove, setConfirmMove] = useState(false);
  const viaAgent = agentBaseUrl() !== null;

  const run = async (work: () => Promise<string>) => {
    setBusy(true);
    try {
      setNotice({ tone: "ok", text: await work() });
    } catch (e) {
      setNotice({ tone: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
      void refreshStorageInfo();
    }
  };

  const saveFolder = () =>
    run(async () => {
      await postLocation(target.trim(), "use");
      return "Saved. Restart ADBoard to use this folder. Nothing was copied.";
    });

  const moveData = () => {
    setConfirmMove(false);
    void run(async () => {
      const result = await postLocation(target.trim(), "move");
      return `Copied ${result.files ?? 0} files (${formatBytes(result.bytes ?? 0)}) to ${result.to}. Restart ADBoard to use the new folder. The old folder was kept; delete it yourself once you're sure.`;
    });
  };

  const location = info?.location;

  return (
    <PanelFrame title="Storage" panel="storage">
      {!viaAgent && (
        <p className="text-xs text-[var(--pc-muted)]">In the browser demo, data is kept in this browser only.</p>
      )}
      {error && <p className="text-xs text-[var(--pc-warn)]">{error}</p>}
      {info && (
        <>
          <section className="flex flex-col gap-2 rounded-2xl border border-[var(--pc-line)] bg-[var(--pc-panel)] p-3" data-storage-current>
            <h3 className="font-display text-sm font-semibold text-[var(--pc-ink)]">Your data is kept in</h3>
            <p className="break-all font-mono text-xs text-[var(--pc-ink)]" data-storage-path>{info.dataDir}</p>
            <p className="text-xs text-[var(--pc-muted)]">{SOURCE_TEXT[info.source] ?? ""}</p>
            {location?.restartRequired && (
              <p className="rounded-lg border border-[var(--pc-line)] px-2 py-1 text-xs text-[var(--pc-warn)]" data-storage-restart>
                A new location is saved ({location.saved}). Restart ADBoard to use it.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <button type="button" className="pc-toggle pc-toggle-sm" onClick={() => void navigator.clipboard?.writeText(info.dataDir)}>
                Copy path
              </button>
              <button type="button" className="pc-toggle pc-toggle-sm" disabled={!viaAgent} onClick={() => void run(async () => `Opened ${await openFolder("root")}`)}>
                Open folder
              </button>
            </div>
          </section>

          <section className="flex flex-col gap-2 rounded-2xl border border-[var(--pc-line)] bg-[var(--pc-panel)] p-3" data-storage-folders>
            <h3 className="font-display text-sm font-semibold text-[var(--pc-ink)]">What is in it</h3>
            {Object.keys(FOLDER_TEXT).map((name) => {
              const size = info.sizes?.[name];
              return (
                <div key={name} className="flex flex-col gap-0.5 border-t border-[var(--pc-line)] pt-2 first:border-t-0 first:pt-0" data-storage-folder={name}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs text-[var(--pc-ink)]">{name}</span>
                    <span className="text-xs text-[var(--pc-muted)]">
                      {size ? `${countFiles(size.files)}, ${formatBytes(size.bytes)}` : ""}
                    </span>
                  </div>
                  <span className="text-xs text-[var(--pc-muted)]">{FOLDER_TEXT[name]}</span>
                  <span className="break-all font-mono text-[10px] text-[var(--pc-muted)]">{info.folders[name]}</span>
                </div>
              );
            })}
          </section>

          <section className="flex flex-col gap-2 rounded-2xl border border-[var(--pc-line)] bg-[var(--pc-panel)] p-3" data-storage-change>
            <h3 className="font-display text-sm font-semibold text-[var(--pc-ink)]">Keep data somewhere else</h3>
            <p className="text-xs text-[var(--pc-muted)]">
              Type a full folder path, for example <span className="font-mono">D:\ADBoard-data</span>. Use it to point ADBoard at a folder that already has data. Move copies everything into a new, empty folder first. Nothing is deleted.
            </p>
            <input
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              placeholder="D:\ADBoard-data"
              aria-label="New data folder"
              disabled={!viaAgent || busy}
              className="min-w-0 rounded-lg border border-[var(--pc-line)] bg-[var(--pc-panel)] px-2 py-1.5 font-mono text-sm text-[var(--pc-ink)]"
            />
            <div className="flex flex-wrap gap-2">
              <button type="button" className="pc-toggle pc-toggle-md" disabled={!viaAgent || busy || !target.trim()} onClick={() => void saveFolder()}>
                Use this folder
              </button>
              <button type="button" className="pc-toggle pc-toggle-md" disabled={!viaAgent || busy || !target.trim()} onClick={() => setConfirmMove(true)}>
                Move data here
              </button>
            </div>
            {notice && (
              <p className={notice.tone === "error" ? "text-xs text-[var(--pc-warn)]" : "text-xs text-[var(--pc-muted)]"} role="status" data-storage-notice>
                {notice.text}
              </p>
            )}
          </section>
        </>
      )}
      {confirmMove && (
        <ConfirmDialog
          title="Move your data?"
          body={`Everything except temp\\ is copied to ${target.trim()}. ADBoard uses the new folder after a restart. The old folder stays where it is.`}
          confirmLabel="Move data"
          busy={busy}
          onCancel={() => setConfirmMove(false)}
          onConfirm={moveData}
        />
      )}
    </PanelFrame>
  );
}
