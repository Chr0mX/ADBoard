"use client";
import { sentenceCase } from "@/lib/utils";

import { useEffect, useState } from "react";
import { devicesClient } from "@/lib/api/client";
import type { HostInfo } from "@/lib/devices/types";
import { useDesk } from "@/components/adboard/desk/desk-context";
import { PanelFrame } from "@/components/adboard/desk/bits";

/** `desktop`: flat host sections with a device table; without it the cards of the phone layout. */
export function HostsPanel({ desktop = false }: { desktop?: boolean } = {}) {
  const desk = useDesk();
  const [hosts, setHosts] = useState<HostInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    void devicesClient
      .listHosts()
      .then((next) => {
        if (!cancel) setHosts(next);
      })
      .catch((err: unknown) => {
        if (!cancel) setError(err instanceof Error ? err.message : "Could not list hosts");
      });
    return () => {
      cancel = true;
    };
  }, []);

  const listed = hosts.length ? hosts : groupFallback(desk.devices);
  const sections = hostSections(listed, desk.devices);

  return (
    <PanelFrame title="Hosts" panel="hosts" clean description="The computers that run ADB, and the phones on each.">
      {error && <p className="text-sm text-[var(--pc-warn)]">{error}</p>}
      {desktop && (
        <div className="flex max-w-4xl flex-col gap-8" data-hosts-desktop>
          {sections.map(({ host, devices }) => {
            const online = devices.filter((device) => device.status === "online").length;
            return (
              <section key={host.hostId} data-host-card={host.hostId} aria-label={host.name} className="flex flex-col gap-2">
                <header className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-[var(--pc-line)] pb-2">
                  <h3 className="min-w-0 truncate t-heading text-[var(--pc-ink)]">{host.name}</h3>
                  <span className="text-xs text-[var(--pc-muted)]">
                    {sentenceCase(host.os)} · {sentenceCase(host.status)} · {host.local ? "this controller" : "remote agent"}
                  </span>
                  <span className="ml-auto text-xs text-[var(--pc-muted)]" data-host-count>
                    {online}/{devices.length} online
                  </span>
                </header>
                {devices.length === 0 ? (
                  <p className="text-sm text-[var(--pc-muted)]">No devices reported.</p>
                ) : (
                  <table className="w-full table-fixed border-collapse text-left text-sm">
                    <thead>
                      <tr className="text-xs text-[var(--pc-muted)]">
                        <th scope="col" className="w-[38%] py-1.5 font-medium">Phone</th>
                        <th scope="col" className="w-[26%] py-1.5 font-medium">Model</th>
                        <th scope="col" className="w-[22%] py-1.5 font-medium">Screen</th>
                        <th scope="col" className="py-1.5 text-right font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {devices.map((device) => (
                        <tr key={device.id} className="border-t border-[var(--pc-line)]" data-host-device={device.id}>
                          <td className="truncate py-2 pr-3 text-[var(--pc-ink)]">{device.name}</td>
                          <td className="truncate py-2 pr-3 font-mono text-xs text-[var(--pc-muted)]" title={device.modelName ? `${device.modelName} (${device.model})` : device.model}>
                            {device.modelName ?? device.model}
                          </td>
                          <td className="py-2 pr-3 font-mono text-xs text-[var(--pc-muted)]">
                            {device.resolution.width > 0 ? `${device.resolution.width}×${device.resolution.height}` : "—"}
                          </td>
                          <td className="py-2 text-right">
                            <span
                              className={`inline-flex items-center gap-1.5 text-xs ${device.status === "online" ? "text-[var(--pc-signal)]" : "text-[var(--pc-muted)]"}`}
                            >
                              <span aria-hidden className={`size-1.5 rounded-full ${device.status === "online" ? "bg-[var(--pc-signal)]" : "bg-[var(--pc-muted)]"}`} />
                              {sentenceCase(device.status)}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>
            );
          })}
        </div>
      )}
      {!desktop && (
      <div className="grid gap-4 md:grid-cols-2">
        {sections.map(({ host, devices }) => {
          const online = devices.filter((device) => device.status === "online").length;
          return (
            <section key={host.hostId} data-host-card={host.hostId} className="flex flex-col gap-2 rounded-xl border border-[var(--pc-line)] bg-[var(--pc-panel)] p-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="min-w-0 truncate t-heading">{host.name}</h3>
                <span className="shrink-0 text-sm text-[var(--pc-muted)]">
                  {online}/{devices.length}
                </span>
              </div>
              <p className="text-xs text-[var(--pc-muted)]">
                {sentenceCase(host.os)} · {sentenceCase(host.status)} · {host.local ? "this controller" : "remote agent"}
              </p>
              {devices.length === 0 && <p className="text-sm text-[var(--pc-muted)]">No devices reported.</p>}
              {devices.map((device) => (
                <div key={device.id} className="flex items-center justify-between gap-3 border-b border-[var(--pc-line)] py-2 last:border-b-0">
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-sm">{device.modelName ?? device.model}</span>
                    {device.modelName && <span className="truncate font-mono text-meta text-[var(--pc-muted)]">{device.model}</span>}
                  </span>
                  <span
                    className={`shrink-0 text-meta ${device.status === "online" ? "text-[var(--pc-signal)]" : "text-[var(--pc-muted)]"}`}
                  >
                    {sentenceCase(device.status)}
                  </span>
                </div>
              ))}
            </section>
          );
        })}
      </div>
      )}
    </PanelFrame>
  );
}

function hostSections(hosts: HostInfo[], devices: import("@/lib/devices/types").Device[]) {
  const used = new Set<string>();
  const sections = hosts.map((host) => {
    const matched = devices.filter((device) => {
      const id = device.hostId || device.host;
      return id === host.hostId || device.host === host.name || device.host === host.hostId;
    });
    for (const device of matched) used.add(device.id);
    return { host, devices: matched };
  });
  const extras = new Map<string, import("@/lib/devices/types").Device[]>();
  for (const device of devices) {
    if (used.has(device.id)) continue;
    const key = device.hostId || device.host || "local";
    const list = extras.get(key) ?? [];
    list.push(device);
    extras.set(key, list);
  }
  for (const [key, group] of extras) {
    sections.push({
      host: {
        hostId: key,
        name: group[0]?.host || key,
        os: key.toLowerCase().includes("win") ? "windows" : "linux",
        status: "online",
        deviceCount: group.length,
        local: false,
      },
      devices: group,
    });
  }
  return sections;
}

function groupFallback(devices: import("@/lib/devices/types").Device[]): HostInfo[] {
  const map = new Map<string, HostInfo>();
  for (const device of devices) {
    const hostId = device.hostId || device.host || "local";
    if (!map.has(hostId)) {
      map.set(hostId, {
        hostId,
        name: device.host || hostId,
        os: hostId.toLowerCase().includes("win") ? "windows" : "linux",
        status: "online",
        deviceCount: 0,
        local: true,
      });
    }
    const host = map.get(hostId)!;
    host.deviceCount += 1;
  }
  return [...map.values()];
}
