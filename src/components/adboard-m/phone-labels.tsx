"use client";

import { Star } from "lucide-react";
import type { Device } from "@/lib/devices/types";

/** Favourite star and a short label for each phone (kept in this browser). */
export function PhoneLabels({
  devices,
  favs,
  notes,
  onToggleFav,
  onNote,
}: {
  devices: Device[];
  favs: Set<string>;
  notes: Record<string, string>;
  onToggleFav: (id: string) => void;
  onNote: (id: string, text: string) => void;
}) {
  return (
    <details data-m-labels className="rounded-xl border border-[var(--pc-line)] bg-[var(--pc-panel)]">
      <summary className="flex min-h-11 cursor-pointer items-center px-3 text-sm text-[var(--pc-ink)]">Favourites and labels</summary>
      <ul className="flex flex-col gap-2 p-3 pt-0">
        {devices.map((device) => (
          <li key={device.id} className="flex items-center gap-2">
            <button
              type="button"
              aria-label={`${favs.has(device.id) ? "Remove" : "Add"} ${device.name} ${favs.has(device.id) ? "from" : "to"} favourites`}
              aria-pressed={favs.has(device.id)}
              onClick={() => onToggleFav(device.id)}
              className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl border border-[var(--pc-line)]"
            >
              <Star className={favs.has(device.id) ? "size-4 fill-current text-[var(--pc-accent)]" : "size-4 text-[var(--pc-muted)]"} aria-hidden />
            </button>
            <input
              type="text"
              defaultValue={notes[device.id] ?? ""}
              placeholder={device.name}
              maxLength={40}
              aria-label={`Label for ${device.name}`}
              onBlur={(event) => onNote(device.id, event.target.value)}
              className="h-11 min-w-0 flex-1 rounded-xl border border-[var(--pc-line)] bg-[var(--pc-paper)] px-3 text-[var(--pc-ink)]"
            />
          </li>
        ))}
      </ul>
    </details>
  );
}
