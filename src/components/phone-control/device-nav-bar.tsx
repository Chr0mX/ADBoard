"use client";

import {
  ChevronLeft,
  House,
  Minus,
  Plus,
  Power,
  Square,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { NavAction } from "@/lib/devices/types";
import { cn } from "@/lib/utils";

const MOBILE_HIT =
  "inline-flex h-12 min-h-12 w-12 min-w-12 items-center justify-center rounded-xl border border-[var(--pc-line)] bg-[var(--pc-panel)]/80 p-0 text-[var(--pc-ink)] active:bg-[var(--pc-accent-soft)] disabled:opacity-40";

const NAV_ACTIONS = [
  ["back", "Back", ChevronLeft],
  ["home", "Home", House],
  ["recent", "Recent", Square],
  ["volume_down", "Volume down", Minus],
  ["volume_up", "Volume up", Plus],
  ["power", "Power", Power],
] as const;

interface DeviceNavBarProps {
  offline: boolean;
  onNav: (action: NavAction["type"]) => void;
  className?: string;
  /** Compact icon row for mobile dock under the stream. */
  variant?: "mobile" | "inline";
}

export function DeviceNavBar({
  offline,
  onNav,
  className,
  variant = "mobile",
}: DeviceNavBarProps) {
  return (
    <div
      data-device-nav-bar
      data-device-nav-variant={variant}
      className={cn(
        "flex shrink-0 flex-wrap items-center justify-center gap-1.5 border-t border-[var(--pc-line)] bg-[var(--pc-panel)]/70 px-2 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]",
        className,
      )}
    >
      {NAV_ACTIONS.map(([action, label, Icon]) => (
        <Button
          key={action}
          type="button"
          variant="ghost"
          disabled={offline}
          aria-label={label}
          className={MOBILE_HIT}
          onClick={() => onNav(action)}
        >
          <Icon className="size-5" />
        </Button>
      ))}
    </div>
  );
}
