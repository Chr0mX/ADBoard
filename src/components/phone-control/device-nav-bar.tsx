"use client";

import {
  ChevronLeft,
  Circle,
  House,
  Keyboard,
  LayoutGrid,
  Minus,
  MousePointer2,
  PanelBottom,
  PanelsTopLeft,
  PictureInPicture2,
  Play,
  Plus,
  Power,
  RefreshCw,
  Smartphone,
  Square,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import type { NavAction } from "@/lib/devices/types";
import type { MobileStatsMode } from "@/lib/ui/mobile-stats-mode";
import type { TaskbarToolId } from "@/lib/ui/taskbar-pins";
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

export interface TaskbarToolHandlers {
  keyboardOn: boolean;
  mouseOn: boolean;
  recording: boolean;
  replaying: boolean;
  refreshing: boolean;
  installing: boolean;
  gridView: boolean;
  statsMode: MobileStatsMode;
  onKeyboardChange: (on: boolean) => void;
  onMouseChange: (on: boolean) => void;
  onRecordToggle: () => void;
  onReplay: () => void;
  onRefresh: () => void;
  onInstallFile: (file: File) => void;
  onToggleGrid: () => void;
  onStatsModeChange: (mode: MobileStatsMode) => void;
  onOpenDevices: () => void;
  onOpenDesk: () => void;
}

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
  /** Tools pinned from the floating Tools panel. */
  pinnedTools?: TaskbarToolId[];
  toolHandlers?: TaskbarToolHandlers;
}

export function DeviceNavBar({
  offline,
  onNav,
  className,
  variant = "mobile",
  safeBottom = true,
  compact = false,
  pinnedTools = [],
  toolHandlers,
}: DeviceNavBarProps) {
  const hit = compact ? MOBILE_HIT_COMPACT : MOBILE_HIT;
  const iconClass = compact ? "size-4" : "size-5";

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
          className={hit}
          onClick={() => onNav(action)}
        >
          <Icon className={iconClass} />
        </Button>
      ))}
      {toolHandlers &&
        pinnedTools.map((id) => (
          <PinnedToolButton
            key={id}
            id={id}
            offline={offline}
            hit={hit}
            iconClass={iconClass}
            handlers={toolHandlers}
          />
        ))}
    </div>
  );
}

function PinnedToolButton({
  id,
  offline,
  hit,
  iconClass,
  handlers,
}: {
  id: TaskbarToolId;
  offline: boolean;
  hit: string;
  iconClass: string;
  handlers: TaskbarToolHandlers;
}) {
  switch (id) {
    case "keyboard":
      return (
        <Toggle
          pressed={handlers.keyboardOn}
          onPressedChange={handlers.onKeyboardChange}
          aria-label="Toggle keyboard injection"
          data-taskbar-tool="keyboard"
          className={hit}
        >
          <Keyboard className={iconClass} />
        </Toggle>
      );
    case "mouse":
      return (
        <Toggle
          pressed={handlers.mouseOn}
          onPressedChange={handlers.onMouseChange}
          aria-label="Toggle touch"
          data-taskbar-tool="mouse"
          className={hit}
        >
          <MousePointer2 className={iconClass} />
        </Toggle>
      );
    case "record":
      return (
        <Button
          type="button"
          variant="ghost"
          aria-label={handlers.recording ? "Stop recording" : "Record gesture"}
          data-taskbar-tool="record"
          data-pressed={handlers.recording ? "true" : undefined}
          className={cn(hit, handlers.recording && "border-[var(--pc-warn)] text-[var(--pc-warn)]")}
          onClick={handlers.onRecordToggle}
        >
          <Circle className={cn(iconClass, handlers.recording && "fill-current")} />
        </Button>
      );
    case "replay":
      return (
        <Button
          type="button"
          variant="ghost"
          aria-label={handlers.replaying ? "Playing gesture" : "Replay gesture"}
          data-taskbar-tool="replay"
          disabled={handlers.replaying}
          className={hit}
          onClick={handlers.onReplay}
        >
          <Play className={iconClass} />
        </Button>
      );
    case "refresh":
      return (
        <Button
          type="button"
          variant="ghost"
          aria-label="Refresh video"
          data-taskbar-tool="refresh"
          disabled={offline || handlers.refreshing}
          className={hit}
          onClick={handlers.onRefresh}
        >
          <RefreshCw className={cn(iconClass, handlers.refreshing && "animate-spin")} />
        </Button>
      );
    case "apk":
      return (
        <label
          data-taskbar-tool="apk"
          className={cn(hit, "cursor-pointer", (offline || handlers.installing) && "pointer-events-none opacity-40")}
        >
          <span className="font-mono text-[9px] font-semibold">APK</span>
          <input
            type="file"
            accept=".apk,application/vnd.android.package-archive"
            aria-label="Install APK"
            className="sr-only"
            disabled={offline || handlers.installing}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) handlers.onInstallFile(file);
            }}
          />
        </label>
      );
    case "grid":
      return (
        <Toggle
          pressed={handlers.gridView}
          onPressedChange={() => handlers.onToggleGrid()}
          aria-label={handlers.gridView ? "Exit grid view" : "Grid view"}
          data-taskbar-tool="grid"
          className={hit}
        >
          <LayoutGrid className={iconClass} />
        </Toggle>
      );
    case "stats":
      return (
        <Button
          type="button"
          variant="ghost"
          aria-label={
            handlers.statsMode === "bar"
              ? "Stats: bottom bar (tap for floating widget)"
              : "Stats: floating widget (tap for bottom bar)"
          }
          aria-pressed={handlers.statsMode === "bar"}
          data-taskbar-tool="stats"
          className={cn(
            hit,
            handlers.statsMode === "bar" && "border-[var(--pc-accent)] text-[var(--pc-accent)]",
          )}
          onClick={() =>
            handlers.onStatsModeChange(handlers.statsMode === "bar" ? "float" : "bar")
          }
        >
          {handlers.statsMode === "bar" ? (
            <PanelBottom className={iconClass} />
          ) : (
            <PictureInPicture2 className={iconClass} />
          )}
        </Button>
      );
    case "devices":
      return (
        <Button
          type="button"
          variant="ghost"
          aria-label="Devices"
          data-taskbar-tool="devices"
          className={hit}
          onClick={handlers.onOpenDevices}
        >
          <Smartphone className={iconClass} />
        </Button>
      );
    case "desk":
      return (
        <Button
          type="button"
          variant="ghost"
          aria-label="Desk"
          data-taskbar-tool="desk"
          className={hit}
          onClick={handlers.onOpenDesk}
        >
          <PanelsTopLeft className={iconClass} />
        </Button>
      );
    default:
      return null;
  }
}
