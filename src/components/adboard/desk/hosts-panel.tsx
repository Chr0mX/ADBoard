"use client";
import { sentenceCase } from "@/lib/utils";

import { useEffect, useState } from "react";
import { devicesClient } from "@/lib/api/client";
import type { HostInfo } from "@/lib/devices/types";
import { useDesk } from "@/components/adboard/desk/desk-context";
import { PanelFrame } from "@/components/adboard/desk/bits";

export function HostsPanel() {
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
    <PanelFrame title="Hosts" panel="hosts" clean>
      <p className="text-sm text-[var(--pc-muted)]">
        The Web UI never talks to USB or ADB. Each host agent runs ADB, scrcpy, discovery, files, and macros.
      </p>
      {error && <p className="text-sm text-[var(--pc-warn)]">{error}</p>}
      <div className="flex flex-col gap-4">
        {sections.map(({ host, devices }) => {
          return (
            <section key={host.hostId} data-host-card={host.hostId} className="rounded-xl border border-[var(--pc-line)] bg-[var(--pc-panel)] p-4">
              <h3 className="font-display text-sm font-semibold">
                {host.os.toLowerCase().includes("win") ? "🖥" : "🐧"} {host.name}
              </h3>
 <p className="font-mono text-[11px] text-[var(--pc-muted)]">
                {sentenceCase(host.os)} · {sentenceCase(host.status)} · {host.local ? "this controller" : "remote agent"}
              </p>
              <ul className="mt-2 text-sm">
                {devices.map((device) => (
                  <li key={device.id}>
                    {device.name} · {sentenceCase(device.status)} · {sentenceCase(device.connection)}
                  </li>
                ))}
                {devices.length === 0 && <li className="text-[var(--pc-muted)]">No devices reported.</li>}
              </ul>
            </section>
          );
        })}
      </div>
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
