"use client";

import { useState } from "react";
import { agentBaseUrl, agentFetch } from "@/lib/api/auth";
import { ConfirmDialog, PanelFrame } from "@/components/adboard/desk/bits";
import { DataStorageCard, openFolder, refreshStorageInfo, useStorageInfo } from "@/components/adboard/desk/data-storage";

/*
 * Settings-free home for "where is my data": the current folder, the two
 * standard folders (switch between them), and any other folder (use it, or
 * move the data there). A changed location takes effect on the next start of
 * ADBoard.
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

type StandardKey = "app" | "user";

export function StoragePanel() {
  const { info, error } = useStorageInfo();
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [confirmMove, setConfirmMove] = useState(false);
  const [confirmSwitch, setConfirmSwitch] = useState<StandardKey | null>(null);
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
  const dataDir = info?.dataDir;
  const inApp = samePath(dataDir, targets?.app);
  const inUser = samePath(dataDir, targets?.user);
  const customPath = target.trim();
  const customIsCurrent = !!customPath && samePath(customPath, dataDir);

  const standard: Record<StandardKey, { title: string; what: string; path: string | null | undefined; hasData: boolean | undefined; current: boolean }> = {
    app: {
      title: "App Folder (Default)",
      what: "Stores data beside the application.",
      path: targets?.app,
      hasData: targets?.appHasData,
      current: inApp,
    },
    user: {
      title: "User Folder",
      what: "Stores data separately from the application.",
      path: targets?.user,
      hasData: targets?.userHasData,
      current: inUser,
    },
  };
  const currentLabel = inApp ? "the app folder" : inUser ? "the user folder" : "a custom folder";

  const switchData = (key: StandardKey) => {
    setConfirmSwitch(null);
    const path = standard[key].path;
    if (!path) return;
    void run(async () => {
      const result = await postLocation(path, "switch");
      if (result.copied) {
        return `Copied ${result.files ?? 0} files (${formatBytes(result.bytes ?? 0)}) to ${result.to}. Restart ADBoard to use it. The other copy was kept.`;
      }
      return `Switched to ${path}. Nothing was copied, because that folder already has data. Restart ADBoard to use it.`;
    });
  };

  const moveData = () => {
    setConfirmMove(false);
    void run(async () => {
      const result = await postLocation(customPath, "move");
      return `Copied ${result.files ?? 0} files (${formatBytes(result.bytes ?? 0)}) to ${result.to}. Restart ADBoard to use the new folder. The old folder was kept; delete it yourself once you're sure.`;
    });
  };

  return (
    <PanelFrame title="Data Storage" panel="storage">
      <p className="text-xs text-[var(--pc-muted)]">Choose where ADBoard stores your data, including macros, scripts, and configuration.</p>
      {!viaAgent && <p className="text-xs text-[var(--pc-muted)]">In the browser demo, data is kept in this browser only.</p>}
      {error && <p className="text-xs text-[var(--pc-warn)]">{error}</p>}
      {info && (
        <>
          <section className="flex min-w-0 flex-col gap-2 rounded-2xl border border-[var(--pc-line)] bg-[var(--pc-panel)] p-3" data-storage-current>
            <h3 className="font-display text-sm font-semibold text-[var(--pc-ink)]">Current Storage Location</h3>
            <p className="text-xs text-[var(--pc-muted)]">
              Your data is currently stored in {currentLabel}.
            </p>
            <p className="text-xs font-semibold text-[var(--pc-ink)]">{inApp ? "App folder" : inUser ? "User folder" : "Custom folder"}</p>
            <p className="break-all font-mono text-xs text-[var(--pc-ink)]" data-storage-path>
              {dataDir}
            </p>
            <p className="text-xs text-[var(--pc-muted)]">{SOURCE_TEXT[info.source] ?? ""}</p>
            {location?.restartRequired && (
              <p className="rounded-lg border border-[var(--pc-line)] px-2 py-1 text-xs text-[var(--pc-warn)]" data-storage-restart>
                A new location is saved ({location.saved}). Restart ADBoard to use it.
              </p>
            )}
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              <button type="button" className="pc-toggle pc-toggle-md" onClick={() => void navigator.clipboard?.writeText(info.dataDir)}>
                Copy path
              </button>
              <button type="button" className="pc-toggle pc-toggle-md" disabled={!viaAgent} onClick={() => void run(async () => `Opened ${await openFolder("root")}`)}>
                Open folder
              </button>
            </div>
          </section>

          {(targets?.app || targets?.user) && (
            <section className="flex min-w-0 flex-col gap-3 rounded-2xl border border-[var(--pc-line)] bg-[var(--pc-panel)] p-3" data-storage-switch>
              <div className="flex flex-col gap-1">
                <h3 className="font-display text-sm font-semibold text-[var(--pc-ink)]">Switch Storage Location</h3>
                <p className="text-xs text-[var(--pc-muted)]">Choose between the app folder and your Windows user folder.</p>
              </div>
              {(["app", "user"] as StandardKey[]).map((key) => {
                const option = standard[key];
                return (
                  <div
                    key={key}
                    className="flex min-w-0 flex-col gap-2 rounded-xl border border-[var(--pc-line)] p-3"
                    data-storage-option={key}
                    data-storage-current-option={option.current ? "true" : "false"}
                  >
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-[var(--pc-ink)]">{option.title}</span>
                      {option.current && (
                        <span className="rounded-full border border-[var(--pc-accent)] px-2 py-0.5 text-[11px] font-semibold text-[var(--pc-accent)]" data-storage-current-tag>
                          Current
                        </span>
                      )}
                    </div>
                    <p className="break-all font-mono text-xs text-[var(--pc-ink)]">{option.path ?? "not available"}</p>
                    <p className="text-xs text-[var(--pc-muted)]">{option.what}</p>
                    {!option.current && (
                      <button
                        type="button"
                        className="pc-toggle pc-toggle-md self-start"
                        disabled={!viaAgent || busy || !option.path}
                        onClick={() => setConfirmSwitch(key)}
                        data-storage-switch-button={key}
                      >
                        Use {option.title.replace(" (Default)", "").toLowerCase()}
                      </button>
                    )}
                  </div>
                );
              })}
            </section>
          )}

          <section className="flex min-w-0 flex-col gap-2 rounded-2xl border border-[var(--pc-line)] bg-[var(--pc-panel)] p-3" data-storage-change>
            <h3 className="font-display text-sm font-semibold text-[var(--pc-ink)]">Custom Storage Location</h3>
            <p className="text-xs text-[var(--pc-muted)]">Enter a full folder path to use an existing data folder or choose a new location.</p>
            <p className="text-xs text-[var(--pc-muted)]">
              Example: <span className="break-all font-mono">D:\adboard-data</span>
            </p>
            <input
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              placeholder="D:\adboard-data"
              aria-label="New data folder"
              disabled={!viaAgent || busy}
              className="w-full min-w-0 rounded-lg border border-[var(--pc-line)] bg-[var(--pc-panel)] px-2 py-2 font-mono text-sm text-[var(--pc-ink)]"
            />
            {customPath && (
              <p className="break-all font-mono text-xs text-[var(--pc-muted)]" data-storage-custom-path>
                {customPath}
                {customIsCurrent && <span className="ml-2 font-sans font-semibold text-[var(--pc-accent)]">Current</span>}
              </p>
            )}
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              <button type="button" className="pc-toggle pc-toggle-md" disabled={!viaAgent || busy || !customPath} onClick={() => void saveFolder()}>
                Use this folder
              </button>
              <button type="button" className="pc-toggle pc-toggle-md" disabled={!viaAgent || busy || !customPath} onClick={() => setConfirmMove(true)}>
                Move data
              </button>
            </div>
            <p className="text-xs text-[var(--pc-muted)]">
              <span className="font-semibold text-[var(--pc-ink)]">Move data:</span> Copies everything into a new, empty folder. The original data is kept, and nothing is deleted.
            </p>
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
      {confirmSwitch && standard[confirmSwitch].path && (
        <ConfirmDialog
          title={`Use ${standard[confirmSwitch].title.replace(" (Default)", "").toLowerCase()}?`}
          body={
            standard[confirmSwitch].hasData
              ? `${standard[confirmSwitch].path} already has data, so ADBoard will use it after a restart. Nothing is copied, and the other copy stays as it is.`
              : `Your data is copied to ${standard[confirmSwitch].path}. ADBoard uses it after a restart. The old copy is kept.`
          }
          confirmLabel="Switch location"
          busy={busy}
          onCancel={() => setConfirmSwitch(null)}
          onConfirm={() => switchData(confirmSwitch)}
        />
      )}
      {confirmMove && (
        <ConfirmDialog
          title="Move your data?"
          body={`Everything except temp\\ is copied to ${customPath}. ADBoard uses the new folder after a restart. The old folder stays where it is.`}
          confirmLabel="Move data"
          busy={busy}
          onCancel={() => setConfirmMove(false)}
          onConfirm={moveData}
        />
      )}
    </PanelFrame>
  );
}
