"use client";

import {
  ChevronLeft,
  Circle,
  Columns3,
  House,
  Info,
  Minimize2,
  Mouse,
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
  RotateCcw,
  Smartphone,
  Sparkles,
  Square,
} from "lucide-react";
import { Fragment } from "react";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import type { NavAction } from "@/lib/devices/types";
import type { MobileStatsMode } from "@/lib/ui/mobile-stats-mode";
import type { TaskbarToolId } from "@/lib/ui/taskbar-pins";
import { cn } from "@/lib/utils";

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
  cursorMode?: boolean;
  onCursorModeChange?: (on: boolean) => void;
  onRestart?: () => void;
  onOpenInfo?: () => void;
  onOpenArrangement?: () => void;
  /** Opens the Quick actions menu anchored to the clicked button. */
  onQuickActions?: (anchor: HTMLElement) => void;
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
  /** Fold the floating Tools / Stats panels to chips (taskbar "Minimize"). */
  onMinimize?: () => void;
}

/**
 * Content-sized, horizontally centered taskbar.
 * Width follows nav + pinned tools; parent centers the capsule.
 */
export function DeviceNavBar({
  offline,
  onNav,
  className,
  variant = "mobile",
  safeBottom = true,
  compact = false,
  pinnedTools = [],
  toolHandlers,
  onMinimize,
}: DeviceNavBarProps) {
  const hasPins = Boolean(toolHandlers && pinnedTools.length > 0);
  const iconClass = compact ? "size-3.5" : "size-4";
  // Unified toggle look (.pc-toggle) at taskbar size: 36px, compact 32px.
  const itemClass = cn(
    "pc-toggle pc-taskbar-item p-0",
    compact ? "h-8 w-8 min-h-8 min-w-8" : "h-9 w-9 min-h-9 min-w-9",
  );

  return (
    <div
      data-device-nav-bar
      data-device-nav-variant={variant}
      data-device-nav-compact={compact ? "1" : "0"}
      data-pin-count={pinnedTools.length}
      className={cn(
        "pc-taskbar",
        safeBottom && "mb-[max(0.25rem,env(safe-area-inset-bottom))]",
        className,
      )}
    >
      {NAV_ACTIONS.map(([action, label, Icon]) => (
        <Fragment key={action}>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={offline}
            aria-label={label}
            className={itemClass}
            onClick={() => onNav(action)}
          >
            <Icon className={iconClass} />
          </Button>
          {action === "recent" && onMinimize && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Minimize floating panels"
              title="Minimize: fold Tools and Stats to small chips"
              data-taskbar-minimize
              className={itemClass}
              onClick={onMinimize}
            >
              <Minimize2 className={iconClass} />
            </Button>
          )}
        </Fragment>
      ))}
      {hasPins && toolHandlers && (
        <>
          <span className="pc-taskbar-sep" aria-hidden />
          {pinnedTools.map((id) => (
            <PinnedToolButton
              key={id}
              id={id}
              offline={offline}
              hit={itemClass}
              iconClass={iconClass}
              handlers={toolHandlers}
            />
          ))}
        </>
      )}
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
          size="none"
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
          size="none"
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
          size="icon"
          aria-label={handlers.recording ? "Stop recording" : "Record gesture"}
          data-taskbar-tool="record"
          data-pressed={handlers.recording ? "true" : undefined}
          className={cn(hit, "pc-toggle-warn")}
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
          size="icon"
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
          size="icon"
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
          <span className="font-mono text-[9px] font-semibold leading-none">APK</span>
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
          size="none"
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
          size="icon"
          aria-label={
            handlers.statsMode === "bar"
              ? "Stats: bottom bar (tap for floating widget)"
              : "Stats: floating widget (tap for bottom bar)"
          }
          aria-pressed={handlers.statsMode === "bar"}
          data-taskbar-tool="stats"
          className={hit}
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
          size="icon"
          aria-label="Devices"
          data-taskbar-tool="devices"
          className={hit}
          onClick={handlers.onOpenDevices}
        >
          <Smartphone className={iconClass} />
        </Button>
      );
    case "cursor":
      return (
        <Toggle
          pressed={Boolean(handlers.cursorMode)}
          onPressedChange={(on) => handlers.onCursorModeChange?.(on)}
          aria-label="Cursor mode"
          data-taskbar-tool="cursor"
          size="none"
          className={hit}
        >
          <Mouse className={iconClass} />
        </Toggle>
      );
    case "restart":
      return (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={offline}
          aria-label="Restart device"
          data-taskbar-tool="restart"
          className={hit}
          onClick={handlers.onRestart}
        >
          <RotateCcw className={iconClass} />
        </Button>
      );
    case "info":
      return (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Device information"
          data-taskbar-tool="info"
          className={hit}
          onClick={handlers.onOpenInfo}
        >
          <Info className={iconClass} />
        </Button>
      );
    case "arrangement":
      return (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Arrangement"
          data-taskbar-tool="arrangement"
          className={hit}
          onClick={handlers.onOpenArrangement}
        >
          <Columns3 className={iconClass} />
        </Button>
      );
    case "quick":
      return (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={offline}
          aria-label="Quick actions"
          aria-haspopup="menu"
          data-taskbar-tool="quick"
          className={hit}
          onClick={(event) => handlers.onQuickActions?.(event.currentTarget)}
        >
          <Sparkles className={iconClass} />
        </Button>
      );
    case "desk":
      return (
        <Button
          type="button"
          variant="ghost"
          size="icon"
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
