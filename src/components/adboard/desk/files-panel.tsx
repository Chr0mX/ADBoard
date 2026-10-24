"use client";

import { saveBlob } from "@/lib/api/download";
import { useCallback, useEffect, useState } from "react";
import { readUiState, writeUiState } from "@/lib/ui-state";
import { devicesClient } from "@/lib/api/client";
import type { Device, HostFileEntry } from "@/lib/devices/types";
import { useDesk } from "@/components/adboard/desk/desk-context";
import { PanelFrame, PrimaryButton, ResultList, TargetChecks, picked, rowsFromCommand, useChecked, type ResultRow } from "@/components/adboard/desk/bits";

interface PhoneEntry {
  name: string;
  path: string;
  dir: boolean;
}

const PC_LINKS = ["Downloads", "APKs", "Recordings", "Screenshots"];
const FILES_PATH_KEY = "adboard-files-path";
const PHONE_LINKS = ["/sdcard", "/sdcard/Download", "/sdcard/DCIM", "/sdcard/Pictures", "/sdcard/Movies", "/sdcard/Android"];

export function FilesPanel() {
  const desk = useDesk();
  const [checked, setChecked] = useChecked(desk.devices, desk.targets);
  // Last folders (per browser, saved in the ADBoard data folder by prefs.ts).
  const [pcPath, setPcPath] = useState(() => readUiState(FILES_PATH_KEY, { pc: "", phone: "/sdcard" }).pc);
  const [phonePath, setPhonePath] = useState(() => readUiState(FILES_PATH_KEY, { pc: "", phone: "/sdcard" }).phone);
  useEffect(() => {
    writeUiState(FILES_PATH_KEY, { pc: pcPath, phone: phonePath });
  }, [pcPath, phonePath]);
  const [pcEntries, setPcEntries] = useState<HostFileEntry[]>([]);
  const [phoneEntries, setPhoneEntries] = useState<PhoneEntry[]>([]);
  const [pcError, setPcError] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [selectedPc, setSelectedPc] = useState<HostFileEntry | null>(null);
  const [rows, setRows] = useState<ResultRow[]>([]);
  const [pcFolder, setPcFolder] = useState("");
  const [phoneFolder, setPhoneFolder] = useState("");
  const phone = picked(desk.devices, checked).find((device) => device.status === "online") ?? desk.activeDevice;

  const loadPc = useCallback((path: string) => {
    void devicesClient
      .listHostFiles(path)
      .then((entries) => {
        setPcEntries(entries);
        setPcError(null);
      })
      .catch((error: unknown) => setPcError(error instanceof Error ? error.message : "Could not list PC files"));
  }, []);

  const loadPhone = useCallback((device: Device | null, path: string) => {
    if (!device) {
      setPhoneEntries([]);
      return;
    }
    void devicesClient
      .runCommand([device], "files", path)
      .then((response) => {
        const result = response.results[0];
        if (!result?.ok) {
          setPhoneError(result?.error || "Could not list phone files");
          setPhoneEntries([]);
          return;
        }
        setPhoneError(null);
        setPhoneEntries(parseListing(result.output || "", path));
      })
      .catch((error: unknown) => setPhoneError(error instanceof Error ? error.message : "Could not list phone files"));
  }, []);

  useEffect(() => {
    loadPc(pcPath);
  }, [loadPc, pcPath]);

  useEffect(() => {
    loadPhone(phone, phonePath);
  }, [loadPhone, phone, phonePath]);

  async function sendSelected() {
    if (!selectedPc || selectedPc.dir) return;
    const targets = picked(desk.devices, checked).filter((device) => device.status === "online");
    const blob = await devicesClient.fetchHostFile(selectedPc.path);
    const file = new File([blob], selectedPc.name);
    const dest = phonePath.endsWith("/") ? phonePath : `${phonePath}/`;
    const result = await devicesClient.pushToDevices(targets, file, dest);
    setRows(rowsFromCommand(desk.devices, checked, result.results));
    loadPhone(phone, phonePath);
  }

  return (
    <PanelFrame title="Files" panel="files">
      <div className="grid min-w-0 gap-3 lg:min-h-0 lg:flex-1 lg:grid-cols-2">
        <Pane title="PC" path={pcPath || "/"} pane="pc">
          <div className="mb-2 flex flex-wrap gap-1">
            <button type="button" className="h-9 px-2 text-xs" onClick={() => setPcPath("")}>
              Root
            </button>
            {PC_LINKS.map((link) => (
              <button key={link} type="button" className="h-9 px-2 text-xs" onClick={() => setPcPath(link)}>
                {link}/
              </button>
            ))}
            <button type="button" className="h-9 px-2 text-xs" onClick={() => loadPc(pcPath)}>
              Refresh
            </button>
          </div>
          {pcError && <p className="text-xs text-[var(--pc-warn)]">{pcError}</p>}
          <ul
            className="flex min-w-0 flex-col overflow-x-hidden"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const raw = event.dataTransfer.getData("application/x-adboard-file");
              if (!raw || !phone) return;
              const item = JSON.parse(raw) as { side: string; path: string; name: string };
              if (item.side !== "phone") return;
              void devicesClient.pullFromDevice(phone.id, item.path).then(async (blob) => {
                await devicesClient.uploadHostFile(new File([blob], item.name), pcPath || "Downloads");
                loadPc(pcPath);
              });
            }}
          >
            {pcPath && (
              <li className="min-w-0">
                <button type="button" className="inline-flex h-11 items-center text-sm" onClick={() => setPcPath(parentPath(pcPath))}>
                  ..
                </button>
              </li>
            )}
            {pcEntries.map((entry) => (
              <li key={entry.path} className="flex min-w-0 items-center gap-2">
                <button
                  type="button"
                  draggable={!entry.dir}
                  onDragStart={(event) => {
                    event.dataTransfer.setData(
                      "application/x-adboard-file",
                      JSON.stringify({ side: "pc", path: entry.path, name: entry.name }),
                    );
                  }}
                  className="flex h-11 min-w-0 flex-1 items-center text-left text-sm"
                  onClick={() => {
                    if (entry.dir) setPcPath(entry.path);
                    else setSelectedPc(entry);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{entry.dir ? `${entry.name}/` : entry.name}</span>
                </button>
                {!entry.dir && (
                  <button
                    type="button"
                    className="inline-flex h-11 shrink-0 items-center text-xs text-[var(--pc-accent)]"
                    onClick={() => void devicesClient.fetchHostFile(entry.path).then((blob) => saveBlob(blob, entry.name))}
                  >
                    Download
                  </button>
                )}
                <button
                  type="button"
                  className="inline-flex h-11 shrink-0 items-center px-2 text-xs"
                  onClick={() => void devicesClient.deleteHostFile(entry.path).then(() => loadPc(pcPath))}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
          <label className="mt-2 block min-w-0 text-xs">
            Upload
            <input
              type="file"
              className="mt-1 block w-full min-w-0 max-w-full text-xs"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                void devicesClient.uploadHostFile(file, pcPath || "Downloads").then(() => loadPc(pcPath));
              }}
            />
          </label>
          <form
            className="mt-2 flex min-w-0 gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!pcFolder.trim()) return;
              const path = pcPath ? `${pcPath}/${pcFolder.trim()}` : pcFolder.trim();
              void devicesClient.hostFileOp("mkdir", path).then(() => {
                setPcFolder("");
                loadPc(pcPath);
              });
            }}
          >
            <input
              value={pcFolder}
              onChange={(event) => setPcFolder(event.target.value)}
              placeholder="New folder"
              aria-label="New PC folder"
              className="h-11 min-w-0 flex-1 rounded-lg border px-2 text-sm"
            />
            <button type="submit" className="inline-flex h-11 shrink-0 items-center rounded-lg border px-3 text-sm">
              Create folder
            </button>
          </form>
        </Pane>
        <Pane title="PHONE" path={phonePath} pane="phone">
          <div className="mb-2 flex flex-wrap gap-1">
            {PHONE_LINKS.map((link) => (
              <button key={link} type="button" className="h-9 px-2 text-xs" onClick={() => setPhonePath(link)}>
                {link.split("/").pop() || link}/
              </button>
            ))}
            <button type="button" className="h-9 px-2 text-xs" onClick={() => loadPhone(phone, phonePath)}>
              Refresh
            </button>
          </div>
          <p className="mb-1 min-w-0 truncate font-mono text-[11px] text-[var(--pc-muted)]">{phone ? phone.name : "No phone selected"}</p>
          {phoneError && <p className="text-xs text-[var(--pc-warn)]">{phoneError}</p>}
          <ul
            className="flex min-w-0 flex-col overflow-x-hidden"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const raw = event.dataTransfer.getData("application/x-adboard-file");
              if (!raw) return;
              const item = JSON.parse(raw) as { side: string; path: string; name: string };
              if (item.side !== "pc") return;
              setSelectedPc({ name: item.name, path: item.path, dir: false, size: 0 });
              void sendFile(item.path, item.name);
            }}
          >
            {phonePath !== "/sdcard" && phonePath !== "/" && (
              <li className="min-w-0">
                <button type="button" className="inline-flex h-11 items-center text-sm" onClick={() => setPhonePath(parentPath(phonePath) || "/sdcard")}>
                  ..
                </button>
              </li>
            )}
            {phoneEntries.map((entry) => (
              <li key={entry.path} className="flex min-w-0 items-center gap-2">
                <button
                  type="button"
                  draggable={!entry.dir}
                  onDragStart={(event) => {
                    event.dataTransfer.setData(
                      "application/x-adboard-file",
                      JSON.stringify({ side: "phone", path: entry.path, name: entry.name }),
                    );
                  }}
                  className="flex h-11 min-w-0 flex-1 items-center text-left text-sm"
                  onClick={() => {
                    if (entry.dir) setPhonePath(entry.path);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{entry.dir ? `${entry.name}/` : entry.name}</span>
                </button>
                {!entry.dir && phone && (
                  <button
                    type="button"
                    className="inline-flex h-11 shrink-0 items-center px-2 text-xs"
                    onClick={() => {
                      void devicesClient.pullFromDevice(phone.id, entry.path).then(async (blob) => {
                        await devicesClient.uploadHostFile(new File([blob], entry.name), "Downloads");
                        loadPc("");
                      });
                    }}
                  >
                    Download
                  </button>
                )}
                <button
                  type="button"
                  className="inline-flex h-11 shrink-0 items-center px-2 text-xs"
                  onClick={() => {
                    if (!phone) return;
                    const next = window.prompt("Rename to", entry.name);
                    if (!next) return;
                    const dest = `${parentPath(entry.path)}/${next}`.replace(/\/+/g, "/");
                    void devicesClient.runCommand([phone], "rename", entry.path, dest).then(() => loadPhone(phone, phonePath));
                  }}
                >
                  Rename
                </button>
                <button
                  type="button"
                  className="inline-flex h-11 shrink-0 items-center px-2 text-xs"
                  onClick={() => {
                    if (!phone) return;
                    void devicesClient.runCommand([phone], "delete", entry.path).then(() => loadPhone(phone, phonePath));
                  }}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
          <form
            className="mt-2 flex min-w-0 gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!phone || !phoneFolder.trim()) return;
              const path = `${phonePath.replace(/\/$/, "")}/${phoneFolder.trim()}`;
              void devicesClient.runCommand([phone], "mkdir", path).then(() => {
                setPhoneFolder("");
                loadPhone(phone, phonePath);
              });
            }}
          >
            <input
              aria-label="New phone folder"
              placeholder="New folder"
              value={phoneFolder}
              className="h-11 min-w-0 flex-1 rounded-lg border px-2 text-sm"
              onChange={(event) => setPhoneFolder(event.target.value)}
            />
            <button type="submit" className="inline-flex h-11 shrink-0 items-center rounded-lg border px-3 text-sm">
              Create folder
            </button>
          </form>
        </Pane>
      </div>
      <div className="rounded-xl border border-[var(--pc-line)] p-3">
        <p className="min-w-0 truncate text-sm">
          PC {selectedPc ? selectedPc.name : "—"} → phone {phonePath}
        </p>
        <TargetChecks devices={desk.devices} checked={checked} onChange={setChecked} />
        <PrimaryButton disabled={!selectedPc || selectedPc.dir} onClick={() => void sendSelected().catch((error: unknown) => {
          setRows([{ deviceId: "send", deviceName: "Send", state: "error", detail: error instanceof Error ? error.message : "Failed" }]);
        })}>
          SEND
        </PrimaryButton>
        <ResultList rows={rows} />
      </div>
    </PanelFrame>
  );

  async function sendFile(path: string, name: string) {
    const targets = picked(desk.devices, checked).filter((device) => device.status === "online");
    let blob: Blob;
    try {
      blob = await devicesClient.fetchHostFile(path);
    } catch {
      return;
    }
    const dest = phonePath.endsWith("/") ? phonePath : `${phonePath}/`;
    const result = await devicesClient.pushToDevices(targets, new File([blob], name), dest);
    setRows(rowsFromCommand(desk.devices, checked, result.results));
    loadPhone(phone, phonePath);
  }
}

function Pane({
  title,
  path,
  pane,
  children,
}: {
  title: string;
  path: string;
  pane: string;
  children: React.ReactNode;
}) {
  return (
    <section data-file-pane={pane} className="flex min-w-0 flex-col rounded-xl border border-[var(--pc-line)] p-3 lg:min-h-64 lg:overflow-hidden">
      <header className="mb-2 flex min-w-0 items-baseline justify-between gap-2">
        <h3 className="shrink-0 font-display text-sm font-semibold">{title}</h3>
        <span className="min-w-0 flex-1 truncate text-right font-mono text-[11px] text-[var(--pc-muted)]">{path}</span>
      </header>
      {children}
    </section>
  );
}

function parentPath(path: string) {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  if (path.startsWith("/")) return `/${parts.join("/")}`;
  return parts.join("/");
}

function parseListing(output: string, dir: string): PhoneEntry[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const isDir = line.endsWith("/");
      const name = line.replace(/\/$/, "");
      const path = `${dir.replace(/\/$/, "")}/${name}`;
      return { name, path, dir: isDir };
    });
}
