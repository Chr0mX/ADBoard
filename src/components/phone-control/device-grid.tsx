"use client";

import { ScrollArea } from "@/components/ui/scroll-area";
import { DeviceCard } from "@/components/phone-control/device-card";
import { WirelessAdb } from "@/components/phone-control/wireless-adb";
import type { Device } from "@/lib/devices/types";
import type { SelectionEvent } from "@/hooks/use-phone-control";
import { useMemo } from "react";

interface DeviceGridProps {
  devices: Device[];
  activeId: string | null;
  selectedIds: Set<string>;
  onSelect: (event: SelectionEvent) => void;
  onToggleSelected: (deviceId: string, selected: boolean) => void;
  /** When true, group cards under HOSTS headings (Windows / LXC / …). */
  groupByHost?: boolean;
}

function hostKey(device: Device): string {
  return device.hostId || device.host || "local";
}

function hostLabel(device: Device): string {
  return device.host || device.hostId || "local";
}

export function DeviceGrid({
  devices,
  activeId,
  selectedIds,
  onSelect,
  onToggleSelected,
  groupByHost = true,
}: DeviceGridProps) {
  const groups = useMemo(() => {
    if (!groupByHost) {
      return [{ key: "all", label: "DEVICES", devices }];
    }
    const map = new Map<string, { label: string; devices: Device[] }>();
    for (const device of devices) {
      const key = hostKey(device);
      const existing = map.get(key);
      if (existing) {
        existing.devices.push(device);
      } else {
        map.set(key, { label: hostLabel(device), devices: [device] });
      }
    }
    return [...map.entries()]
      .sort((a, b) => a[1].label.localeCompare(b[1].label))
      .map(([key, value]) => ({ key, ...value }));
  }, [devices, groupByHost]);

  const multiHost = groups.length > 1;

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3">
      <h2 className="font-display text-sm font-semibold tracking-wide text-[var(--pc-ink)]">
        {multiHost ? "Hosts" : "Devices"}
      </h2>
      <WirelessAdb />
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 pr-2">
          {groups.map((group) => (
            <div key={group.key} className="flex flex-col gap-2">
              {multiHost && (
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--pc-muted)]">
                    {group.label}
                  </h3>
                  <span className="font-mono text-[10px] text-[var(--pc-muted)]">
                    {group.devices.filter((d) => d.status === "online").length}/
                    {group.devices.length}
                  </span>
                </div>
              )}
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                {group.devices.map((device) => (
                  <DeviceCard
                    key={device.id}
                    device={device}
                    isActive={device.id === activeId}
                    isSelected={selectedIds.has(device.id)}
                    onSelect={onSelect}
                    onToggleSelected={onToggleSelected}
                    showHost={!multiHost}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>
    </section>
  );
}
