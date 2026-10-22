"use client";

import { useState } from "react";
import { agentBaseUrl, agentFetch } from "@/lib/api/auth";
import { ConfirmDialog, PanelFrame } from "@/components/adboard/desk/bits";
import { DataStorageCard, openFolder, refreshStorageInfo, useStorageInfo } from "@/components/adboard/desk/data-storage";

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

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Windows paths are case-insensitive; a trailing separator is not part of the folder. */
function samePath(a: string | null | undefined, b: string | null | undefined) {
  if (!a || !b) return false;
  const norm = (value: string) => value.replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();
  return norm(a) === norm(b);
}

async function postLocation(path: string, mode: "use" | "move" | "switch") {
  const base = agentBaseUrl();
  if (base === null) throw new Error("No ADBoard agent: data is kept in this browser only.");
  const res = await agentFetch(`${base}/api/system/location`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, mode }),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string; copied?: boolean; files?: number; bytes?: number; to?: string };
  if (!res.ok) throw new Error(body.error ?? `Couldn't change the location (${res.status})`);
  return body as { copied?: boolean; files?: number; bytes?: number; to?: string };
}

export function StoragePanel() {
  const { info, error } = useStorageInfo();
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [confirmMove, setConfirmMove] = useState(false);
  const [confirmSwitch, setConfirmSwitch] = useState(false);
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

  const location = info?.location;
  const targets = info?.targets;
  const inApp = samePath(info?.dataDir, targets?.app);
  const inUser = samePath(info?.dataDir, targets?.user);
  // Switch to the place the data is not in (app folder first, if it is unclear).
  const switchTo = inApp ? "user" : "app";
  const switchPath = switchTo === "app" ? targets?.app : targets?.user;
  const switchHasData = switchTo === "app" ? targets?.appHasData : targets?.userHasData;
  const switchLabel = switchTo === "app" ? "Switch to app folder" : "Switch to user folder";

  const switchData = () => {
    setConfirmSwitch(false);
    if (!switchPath) return;
    void run(async () => {
      const result = await postLocation(switchPath, "switch");
      if (result.copied) {
        return `Copied ${result.files ?? 0} files (${formatBytes(result.bytes ?? 0)}) to ${result.to}. Restart ADBoard to use it. The other copy was kept.`;
      }
      return `Switched to ${switchPath}. Nothing was copied, because that folder already has data. Restart ADBoard to use it.`;
    });
  };

  const moveData = () => {
    setConfirmMove(false);
    void run(async () => {
      const result = await postLocation(target.trim(), "move");
      return `Copied ${result.files ?? 0} files (${formatBytes(result.bytes ?? 0)}) to ${result.to}. Restart ADBoard to use the new folder. The old folder was kept; delete it yourself once you're sure.`;
    });
  };

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

          {(targets?.app || targets?.user) && (
            <section className="flex flex-col gap-2 rounded-2xl border border-[var(--pc-line)] bg-[var(--pc-panel)] p-3" data-storage-switch>
              <h3 className="font-display text-sm font-semibold text-[var(--pc-ink)]">Switch between the two folders</h3>
              <p className="text-xs text-[var(--pc-muted)]">
                App folder: <span className="font-mono">{targets?.app ?? "not available"}</span>
                <br />
                User folder: <span className="font-mono">{targets?.user ?? "not available"}</span>
              </p>
              <p className="text-xs text-[var(--pc-muted)]">
                Your data is in the {inApp ? "app folder" : inUser ? "user folder" : "another folder"}.
              </p>
              <button
                type="button"
                className="pc-toggle pc-toggle-md self-start"
                disabled={!viaAgent || busy || !switchPath}
                onClick={() => setConfirmSwitch(true)}
                data-storage-switch-button
              >
                {switchLabel}
              </button>
            </section>
          )}
          <section className="flex flex-col gap-2 rounded-2xl border border-[var(--pc-line)] bg-[var(--pc-panel)] p-3" data-storage-change>
            <h3 className="font-display text-sm font-semibold text-[var(--pc-ink)]">Keep data somewhere else</h3>
            <p className="text-xs text-[var(--pc-muted)]">
              Type a full folder path, for example <span className="font-mono">D:\adboard-data</span>. Use it to point ADBoard at a folder that already has data. Move copies everything into a new, empty folder first. Nothing is deleted.
            </p>
            <input
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              placeholder="D:\adboard-data"
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
      {/* Export, import, backup and the folder rows: the same card that used to be in Settings. */}
      <DataStorageCard />
      {confirmSwitch && switchPath && (
        <ConfirmDialog
          title={switchLabel + "?"}
          body={
            switchHasData
              ? `${switchPath} already has data, so ADBoard will use it after a restart. Nothing is copied, and the other copy stays as it is.`
              : `Your data is copied to ${switchPath}. ADBoard uses it after a restart. The old copy is kept.`
          }
          confirmLabel={switchLabel}
          busy={busy}
          onCancel={() => setConfirmSwitch(false)}
          onConfirm={switchData}
        />
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
