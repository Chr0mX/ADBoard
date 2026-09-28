"use client";

import { useCallback, useEffect, useState } from "react";
import { devicesClient } from "@/lib/api/client";
import type { Device, HostFileEntry } from "@/lib/devices/types";
import { useDesk } from "@/components/phone-control/desk/desk-context";
import { PanelFrame, PrimaryButton, ResultList, TargetChecks, picked, rowsFromCommand, useChecked, type ResultRow } from "@/components/phone-control/desk/bits";

interface PhoneEntry {
  name: string;
  path: string;
  dir: boolean;
}

const PC_LINKS = ["Downloads", "APKs", "Recordings", "Screenshots"];
const PHONE_LINKS = ["/sdcard", "/sdcard/Download", "/sdcard/DCIM", "/sdcard/Pictures", "/sdcard/Movies", "/sdcard/Android"];

export function FilesPanel() {
  const desk = useDesk();
  const [checked, setChecked] = useChecked(desk.devices, desk.targets);
  const [pcPath, setPcPath] = useState("");
  const [phonePath, setPhonePath] = useState("/sdcard");
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
    const response = await fetch(devicesClient.hostFileUrl(selectedPc.path));
    if (!response.ok) throw new Error(await response.text());
    const blob = await response.blob();
    const file = new File([blob], selectedPc.name);
    const dest = phonePath.endsWith("/") ? phonePath : `${phonePath}/`;
    const result = await devicesClient.pushToDevices(targets, file, dest);
    setRows(rowsFromCommand(desk.devices, checked, result.results));
    loadPhone(phone, phonePath);
  }

  return (
    <PanelFrame title="Files" panel="files">
      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-2">
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
            className="flex flex-col"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const raw = event.dataTransfer.getData("application/x-phonecontrol");
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
              <li>
                <button type="button" className="h-11 text-sm" onClick={() => setPcPath(parentPath(pcPath))}>
                  ..
                </button>
              </li>
            )}
            {pcEntries.map((entry) => (
              <li key={entry.path} className="flex items-center gap-2">
                <button
                  type="button"
                  draggable={!entry.dir}
                  onDragStart={(event) => {
                    event.dataTransfer.setData(
                      "application/x-phonecontrol",
                      JSON.stringify({ side: "pc", path: entry.path, name: entry.name }),
                    );
                  }}
                  className="h-11 flex-1 truncate text-left text-sm"
                  onClick={() => {
                    if (entry.dir) setPcPath(entry.path);
                    else setSelectedPc(entry);
                  }}
                >
                  {entry.dir ? `${entry.name}/` : entry.name}
                </button>
                {!entry.dir && (
                  <a className="text-xs text-[var(--pc-accent)]" href={devicesClient.hostFileUrl(entry.path)}>
                    Download
                  </a>
                )}
                <button
                  type="button"
                  className="h-11 px-2 text-xs"
                  onClick={() => void devicesClient.deleteHostFile(entry.path).then(() => loadPc(pcPath))}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
          <label className="mt-2 block text-xs">
            Upload
            <input
              type="file"
              className="mt-1 block w-full text-xs"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                void devicesClient.uploadHostFile(file, pcPath || "Downloads").then(() => loadPc(pcPath));
              }}
            />
          </label>
          <form
            className="mt-2 flex gap-2"
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
              className="h-11 flex-1 rounded-lg border px-2 text-sm"
            />
            <button type="submit" className="h-11 rounded-lg border px-3 text-sm">
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
          <p className="mb-1 font-mono text-[10px] text-[var(--pc-muted)]">{phone ? phone.name : "No phone selected"}</p>
          {phoneError && <p className="text-xs text-[var(--pc-warn)]">{phoneError}</p>}
          <ul
            className="flex flex-col"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const raw = event.dataTransfer.getData("application/x-phonecontrol");
              if (!raw) return;
              const item = JSON.parse(raw) as { side: string; path: string; name: string };
              if (item.side !== "pc") return;
              setSelectedPc({ name: item.name, path: item.path, dir: false, size: 0 });
              void sendFile(item.path, item.name);
            }}
          >
            {phonePath !== "/sdcard" && phonePath !== "/" && (
              <li>
                <button type="button" className="h-11 text-sm" onClick={() => setPhonePath(parentPath(phonePath) || "/sdcard")}>
                  ..
                </button>
              </li>
            )}
            {phoneEntries.map((entry) => (
              <li key={entry.path} className="flex items-center gap-2">
                <button
                  type="button"
                  draggable={!entry.dir}
                  onDragStart={(event) => {
                    event.dataTransfer.setData(
                      "application/x-phonecontrol",
                      JSON.stringify({ side: "phone", path: entry.path, name: entry.name }),
                    );
                  }}
                  className="h-11 flex-1 truncate text-left text-sm"
                  onClick={() => {
                    if (entry.dir) setPhonePath(entry.path);
                  }}
                >
                  {entry.dir ? `${entry.name}/` : entry.name}
                </button>
                {!entry.dir && phone && (
                  <button
                    type="button"
                    className="h-11 px-2 text-xs"
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
                  className="h-11 px-2 text-xs"
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
                  className="h-11 px-2 text-xs"
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
            className="mt-2 flex gap-2"
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
              className="h-11 flex-1 rounded-lg border px-2 text-sm"
              onChange={(event) => setPhoneFolder(event.target.value)}
            />
            <button type="submit" className="h-11 rounded-lg border px-3 text-sm">
              Create folder
            </button>
          </form>
        </Pane>
      </div>
      <div className="rounded-xl border border-[var(--pc-line)] p-3">
        <p className="text-sm">
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
    const response = await fetch(devicesClient.hostFileUrl(path));
    if (!response.ok) return;
    const blob = await response.blob();
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
    <section data-file-pane={pane} className="flex min-h-64 flex-col rounded-xl border border-[var(--pc-line)] p-3">
      <header className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="font-display text-sm font-semibold">{title}</h3>
        <span className="truncate font-mono text-[10px] text-[var(--pc-muted)]">{path}</span>
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
