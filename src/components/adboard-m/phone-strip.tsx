"use client";

import { Star } from "lucide-react";
import type { Device } from "@/lib/devices/types";
import { favouritesFirst } from "@/components/adboard-m/phone-prefs";
import { cn } from "@/lib/utils";

/**
 * A swipeable row of phone cards: status, battery, your label, a star for
 * favourites. Tap one to make it the active phone.
 */
export function PhoneStrip({
  devices,
  activeId,
  favs,
  notes,
  onPick,
  onSelectAllOnline,
  onlyFavs = false,
  className,
}: {
  devices: Device[];
  activeId: string | null;
  favs: Set<string>;
  notes: Record<string, string>;
  onPick: (id: string) => void;
  onSelectAllOnline?: () => void;
  onlyFavs?: boolean;
  className?: string;
}) {
  const list = favouritesFirst(devices, favs).filter((device) => !onlyFavs || favs.has(device.id));
  if (list.length === 0 || (!onlyFavs && devices.length < 2)) return null;
  return (
    <div data-m-strip={onlyFavs ? "favourites" : "phones"} className={cn("flex shrink-0 snap-x gap-2 overflow-x-auto px-3 py-1", className)}>
      {list.map((device) => {
        const online = device.status === "online";
        return (
          <button
            key={device.id}
            type="button"
            data-m-strip-phone={device.id}
            aria-pressed={device.id === activeId}
            onClick={() => onPick(device.id)}
            className={cn(
              "flex min-h-9 shrink-0 snap-start items-center gap-1.5 rounded-lg border px-2.5 text-left text-xs",
              device.id === activeId ? "border-[var(--pc-accent)] bg-[var(--pc-accent-soft)]" : "border-[var(--pc-line)] bg-[var(--pc-panel)]",
              !online && "opacity-60",
            )}
          >
            <span className={cn("size-2 shrink-0 rounded-full", online ? "bg-[var(--pc-signal)]" : "bg-[var(--pc-muted)]")} aria-hidden />
            <span className="max-w-24 truncate text-[var(--pc-ink)]">{notes[device.id] || device.name}</span>
            {device.battery != null && <span className="font-mono text-[11px] text-[var(--pc-muted)]">{device.battery}%</span>}
            {favs.has(device.id) && <Star className="size-3 shrink-0 fill-current text-[var(--pc-accent)]" aria-label="Favourite" />}
          </button>
        );
      })}
      {onSelectAllOnline && (
        <button
          type="button"
          data-m-strip-all
          onClick={onSelectAllOnline}
          className="min-h-9 shrink-0 snap-start rounded-lg border border-dashed border-[var(--pc-line)] px-2.5 text-xs text-[var(--pc-ink)]"
        >
          All online
        </button>
      )}
    </div>
  );
}
