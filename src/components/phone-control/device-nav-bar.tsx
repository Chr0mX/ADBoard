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
  "inline-flex h-11 min-h-11 w-full max-w-14 flex-1 items-center justify-center rounded-lg border border-[var(--pc-line)] bg-[var(--pc-panel)] p-0 text-[var(--pc-ink)] active:bg-[var(--pc-accent-soft)] disabled:opacity-40";

const MOBILE_HIT_COMPACT =
  "inline-flex h-9 min-h-9 w-full max-w-12 flex-1 items-center justify-center rounded-md border border-[var(--pc-line)] bg-[var(--pc-panel)] p-0 text-[var(--pc-ink)] active:bg-[var(--pc-accent-soft)] disabled:opacity-40";

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
  /** When false, omit home-indicator padding (a status bar below owns it). */
  safeBottom?: boolean;
  /** Tighter hit targets for the under-stream dock. */
  compact?: boolean;
}

export function DeviceNavBar({
  offline,
  onNav,
  className,
  variant = "mobile",
  safeBottom = true,
  compact = false,
}: DeviceNavBarProps) {
  return (
    <div
      data-device-nav-bar
      data-device-nav-variant={variant}
      data-device-nav-compact={compact ? "1" : "0"}
      className={cn(
        "flex w-full shrink-0 items-center justify-between gap-0.5 border-t border-[var(--pc-line)] bg-[var(--pc-panel)] px-1",
        compact ? "py-0" : "py-0.5",
        safeBottom && "pb-[max(0.25rem,env(safe-area-inset-bottom))]",
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
          className={compact ? MOBILE_HIT_COMPACT : MOBILE_HIT}
          onClick={() => onNav(action)}
        >
          <Icon className={compact ? "size-4" : "size-5"} />
        </Button>
      ))}
    </div>
  );
}
