"use client";

import { ScrollArea } from "@/components/ui/scroll-area";
import { DeviceCard } from "@/components/phone-control/device-card";
import type { Device } from "@/lib/devices/types";
import type { SelectionEvent } from "@/hooks/use-phone-control";

interface DeviceGridProps {
  devices: Device[];
  activeId: string | null;
  selectedIds: Set<string>;
  onSelect: (event: SelectionEvent) => void;
}

export function DeviceGrid({
  devices,
  activeId,
  selectedIds,
  onSelect,
}: DeviceGridProps) {
  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="font-display text-sm font-semibold tracking-wide text-[var(--pc-ink)]">
          DEVICES
        </h2>
        <p className="font-mono text-[10px] uppercase tracking-wider text-[var(--pc-muted)]">
          Click · Ctrl/Shift multi
        </p>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="grid grid-cols-1 gap-2.5 pr-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
          {devices.map((device) => (
            <DeviceCard
              key={device.id}
              device={device}
              isActive={device.id === activeId}
              isSelected={selectedIds.has(device.id)}
              onSelect={onSelect}
            />
          ))}
        </div>
      </ScrollArea>
    </section>
  );
}
