"use client";

import {
  ChevronLeft,
  House,
  Minimize2,
  Minus,
  Plus,
  Power,
  Square,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { FloatingPanel } from "@/components/phone-control/floating/floating-panel";
import type { NavAction } from "@/lib/devices/types";

const HIT =
  "inline-flex h-12 min-h-12 w-12 min-w-12 items-center justify-center rounded-xl border border-[var(--pc-line)] bg-[var(--pc-panel)]/80 p-0 text-[var(--pc-ink)] active:bg-[var(--pc-accent-soft)] data-[pressed=true]:border-[var(--pc-accent)] data-[pressed=true]:bg-[var(--pc-accent-soft)] data-[pressed=true]:text-[var(--pc-accent)] disabled:opacity-40";

interface DeviceNavFloatProps {
  offline: boolean;
  fillWindow: boolean;
  onNav: (action: NavAction["type"]) => void;
  onFillWindowChange: (on: boolean) => void;
}

export function DeviceNavFloat({
  offline,
  fillWindow,
  onNav,
  onFillWindowChange,
}: DeviceNavFloatProps) {
  return (
    <FloatingPanel
      storageKey="pc-float-nav"
      kind="nav"
      defaultSize={{ width: 340, height: 72 }}
      className="max-w-[calc(100vw-16px)]"
    >
      <div
        data-device-nav-float
        className="flex flex-wrap items-center justify-center gap-1.5"
      >
        {(
          [
            ["back", "Back", ChevronLeft],
            ["home", "Home", House],
            ["recent", "Recent", Square],
            ["volume_down", "Volume down", Minus],
            ["volume_up", "Volume up", Plus],
            ["power", "Power", Power],
          ] as const
        ).map(([action, label, Icon]) => (
          <Button
            key={action}
            type="button"
            variant="ghost"
            disabled={offline}
            aria-label={label}
            className={HIT}
            onClick={() => onNav(action)}
          >
            <Icon className="size-5" />
          </Button>
        ))}
        {fillWindow && (
          <Button
            type="button"
            variant="ghost"
            aria-label="Exit fill"
            className={HIT}
            onClick={() => onFillWindowChange(false)}
          >
            <Minimize2 className="size-5" />
          </Button>
        )}
      </div>
    </FloatingPanel>
  );
}
