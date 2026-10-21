"use client";

import {
  Camera,
  ChevronLeft,
  Circle,
  EllipsisVertical,
  Expand,
  House,
  Info,
  Keyboard,
  LayoutGrid,
  Minimize2,
  Minus,
  Moon,
  Mouse,
  MousePointer2,
  PanelsTopLeft,
  PictureInPicture2,
  Play,
  Plus,
  Power,
  RefreshCw,
  RotateCcw,
  RotateCwSquare,
  Shrink,
  Smartphone,
  Square,
  Video,
  Zap,
} from "lucide-react";
import { StatsBarsIcon } from "@/components/adboard/stats-bars-icon";
import { Fragment, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import type { NavAction } from "@/lib/devices/types";
import type { MobileStatsMode } from "@/lib/ui/mobile-stats-mode";
import {
  TASKBAR_GROUP_LABELS,
  TASKBAR_TOOL_GROUP,
  type HideableNavId,
  type TaskbarToolId,
} from "@/lib/ui/taskbar-pins";
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
  /** Opens the Device actions menu (reconnect, restart ADB, power off) at the clicked button. */
  onQuickActions?: (anchor: HTMLElement) => void;
  /** Rotate the target phones (scrcpy ROTATE_DEVICE). */
  onRotate?: () => void;
  /** Browser fullscreen; omitted where the browser has none. */
  fullscreen?: boolean;
  onFullscreen?: () => void;
  /** Picture-in-picture pop-out; omitted where unsupported. */
  pip?: boolean;
  onPip?: () => void;
  /** Quiet mode: every online phone's screen off and muted. */
  quiet?: boolean;
  onQuietChange?: (on: boolean) => void;
  /** Opens the Macro dock (the same one as the Tools panel). Omitted where there is none. */
  onOpenMacros?: () => void;
  /** A macro is running on some phone: the Macros button shows a dot. */
  macroRunning?: boolean;
  /** Saves a screenshot of each target phone. */
  onScreenshot?: () => void;
  screenRecording?: boolean;
  /** Starts or stops the screen recording on each target phone. */
  onScreenRecordToggle?: () => void;
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
  /** Fixed controls the user hid (volume, power). */
  hiddenNav?: HideableNavId[];
  /** Long-press on the bar opens the taskbar settings. */
  onEditTaskbar?: () => void;
}

/** Pointer travel (px) that cancels a long-press. */
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP = 10;
/** How long the tapped control's name stays above the bar. */
const LABEL_MS = 1200;

/**
 * Content-sized, horizontally centered taskbar.
 * Width follows nav + pinned tools; parent centers the capsule.
 *
 * Long-press (500 ms) any button to open the taskbar settings. A tap shows the
 * control's name above the bar. Dividers separate the fixed controls and each
 * group of pins.
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
  hiddenNav = [],
  onEditTaskbar,
}: DeviceNavBarProps) {
  const hasPins = Boolean(toolHandlers && pinnedTools.length > 0);
  const iconClass = compact ? "size-3.5" : "size-4";
  // Unified toggle look (.pc-toggle) at taskbar size: 36px, compact 32px.
  // Touch screens get 44px from globals.css (coarse pointer).
  const itemClass = cn(
    "pc-toggle pc-taskbar-item p-0",
    compact ? "h-8 w-8 min-h-8 min-w-8" : "h-9 w-9 min-h-9 min-w-9",
  );
  const barRef = useRef<HTMLDivElement>(null);
  const pressTimer = useRef<number | null>(null);
  const pressStart = useRef<{ x: number; y: number } | null>(null);
  const suppressClick = useRef(false);
  const [tapLabel, setTapLabel] = useState<string | null>(null);

  // Fade the edges while the bar has more to scroll to.
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const update = () => {
      const max = bar.scrollWidth - bar.clientWidth;
      bar.dataset.scrollStart = bar.scrollLeft > 2 ? "1" : "";
      bar.dataset.scrollEnd = max - bar.scrollLeft > 2 ? "1" : "";
    };
    update();
    bar.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(bar);
    return () => {
      bar.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [pinnedTools.length, hiddenNav.length]);

  useEffect(() => {
    if (!tapLabel) return;
    const id = window.setTimeout(() => setTapLabel(null), LABEL_MS);
    return () => window.clearTimeout(id);
  }, [tapLabel]);

  useEffect(() => () => {
    if (pressTimer.current != null) window.clearTimeout(pressTimer.current);
  }, []);

  function cancelPress() {
    if (pressTimer.current != null) window.clearTimeout(pressTimer.current);
    pressTimer.current = null;
    pressStart.current = null;
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (!onEditTaskbar || !(event.target as HTMLElement).closest("button")) return;
    pressStart.current = { x: event.clientX, y: event.clientY };
    pressTimer.current = window.setTimeout(() => {
      pressTimer.current = null;
      suppressClick.current = true;
      onEditTaskbar();
    }, LONG_PRESS_MS);
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const start = pressStart.current;
    if (!start) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > LONG_PRESS_SLOP) cancelPress();
  }

  function onClickCapture(event: React.MouseEvent<HTMLDivElement>) {
    if (suppressClick.current) {
      // The press became a long-press: do not also run the button.
      suppressClick.current = false;
      event.stopPropagation();
      event.preventDefault();
      return;
    }
    const button = (event.target as HTMLElement).closest("button");
    const name = button?.getAttribute("aria-label");
    if (name) setTapLabel(name);
  }

  const hiddenSet = new Set<string>(hiddenNav);
  const navVisible = NAV_ACTIONS.filter(([action]) => !hiddenSet.has(action));
  const navFixed = navVisible.filter(([action]) => !HIDEABLE_ACTIONS.has(action));
  const navSide = navVisible.filter(([action]) => HIDEABLE_ACTIONS.has(action));

  // Pins keep the user's order; a divider goes where the group changes.
  const pinGroups = pinnedTools.map((id, index) => ({
    id,
    divider: index > 0 && TASKBAR_TOOL_GROUP[id] !== TASKBAR_TOOL_GROUP[pinnedTools[index - 1]!],
  }));

  return (
    <div
      className={cn("relative flex max-w-full flex-col items-center", safeBottom && "mb-[max(0.25rem,env(safe-area-inset-bottom))]", className)}
    >
      {tapLabel && (
        <p
          role="status"
          data-taskbar-label
          className="pointer-events-none absolute bottom-full z-30 mb-1.5 max-w-[80vw] truncate rounded-md border border-[var(--pc-line)] bg-[var(--pc-panel)] px-2 py-0.5 text-xs text-[var(--pc-ink)] shadow-md"
        >
          {tapLabel}
        </p>
      )}
      <div
        ref={barRef}
        data-device-nav-bar
        data-device-nav-variant={variant}
        data-device-nav-compact={compact ? "1" : "0"}
        data-pin-count={pinnedTools.length}
        data-taskbar-group-label={TASKBAR_GROUP_LABELS.view}
        className="pc-taskbar"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={cancelPress}
        onPointerCancel={cancelPress}
        onPointerLeave={cancelPress}
        onClickCapture={onClickCapture}
      >
        {navFixed.map(([action, label, Icon]) => (
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
        {navSide.length > 0 && (
          <>
            <span className="pc-taskbar-sep" aria-hidden />
            {navSide.map(([action, label, Icon]) => (
              <Button
                key={action}
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
            ))}
          </>
        )}
        {hasPins && toolHandlers && (
          <>
            <span className="pc-taskbar-sep" aria-hidden />
            {pinGroups.map(({ id, divider }) => (
              <Fragment key={id}>
                {divider && <span className="pc-taskbar-sep" aria-hidden />}
                <PinnedToolButton
                  id={id}
                  offline={offline}
                  hit={itemClass}
                  iconClass={iconClass}
                  handlers={toolHandlers}
                />
              </Fragment>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

const HIDEABLE_ACTIONS = new Set<string>(["volume_down", "volume_up", "power"]);

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
            handlers.statsMode === "show"
              ? "Stats: shown (tap to hide)"
              : "Stats: hidden (tap to show)"
          }
          aria-pressed={handlers.statsMode === "show"}
          data-taskbar-tool="stats"
          className={hit}
          onClick={() =>
            handlers.onStatsModeChange(handlers.statsMode === "show" ? "hide" : "show")
          }
        >
          <StatsBarsIcon className={iconClass} />
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
    case "rotate":
      return handlers.onRotate ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={offline}
          aria-label="Rotate phone"
          data-taskbar-tool="rotate"
          className={hit}
          onClick={handlers.onRotate}
        >
          <RotateCwSquare className={iconClass} />
        </Button>
      ) : null;
    case "fullscreen":
      return handlers.onFullscreen ? (
        <Toggle
          pressed={Boolean(handlers.fullscreen)}
          onPressedChange={() => handlers.onFullscreen?.()}
          aria-label={handlers.fullscreen ? "Exit fullscreen" : "Fullscreen"}
          data-taskbar-tool="fullscreen"
          size="none"
          className={hit}
        >
          {handlers.fullscreen ? <Shrink className={iconClass} /> : <Expand className={iconClass} />}
        </Toggle>
      ) : null;
    case "pip":
      return handlers.onPip ? (
        <Toggle
          pressed={Boolean(handlers.pip)}
          onPressedChange={() => handlers.onPip?.()}
          disabled={offline}
          aria-label="Pop out (always on top, view only)"
          data-taskbar-tool="pip"
          size="none"
          className={hit}
        >
          <PictureInPicture2 className={iconClass} />
        </Toggle>
      ) : null;
    case "quiet":
      return handlers.onQuietChange ? (
        <Toggle
          pressed={Boolean(handlers.quiet)}
          onPressedChange={(on) => handlers.onQuietChange?.(on)}
          aria-label="Quiet mode: all screens off and muted"
          data-taskbar-tool="quiet"
          size="none"
          className={hit}
        >
          <Moon className={iconClass} />
        </Toggle>
      ) : null;
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
    case "quick":
      return (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={offline}
          aria-label="Device actions"
          aria-haspopup="menu"
          data-taskbar-tool="quick"
          className={hit}
          onClick={(event) => handlers.onQuickActions?.(event.currentTarget)}
        >
          <EllipsisVertical className={iconClass} />
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
    case "macro":
      // Unsupported where there is no Macro dock: the pin is kept but shows nothing.
      if (!handlers.onOpenMacros) return null;
      return (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Macros"
          data-taskbar-tool="macro"
          className={cn(hit, "relative")}
          onClick={handlers.onOpenMacros}
        >
          <Zap className={iconClass} />
          {handlers.macroRunning && (
            <span data-macro-running className="absolute right-1 top-1 size-1.5 rounded-full bg-[var(--pc-accent)]" aria-hidden />
          )}
        </Button>
      );
    case "screenshot":
      if (!handlers.onScreenshot) return null;
      return (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={offline}
          aria-label="Screenshot"
          data-taskbar-tool="screenshot"
          className={hit}
          onClick={handlers.onScreenshot}
        >
          <Camera className={iconClass} />
        </Button>
      );
    case "screenrec":
      if (!handlers.onScreenRecordToggle) return null;
      return (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={offline}
          aria-label={handlers.screenRecording ? "Stop screen record" : "Start screen record"}
          aria-pressed={Boolean(handlers.screenRecording)}
          data-taskbar-tool="screenrec"
          className={hit}
          onClick={handlers.onScreenRecordToggle}
        >
          <Video className={iconClass} />
        </Button>
      );
    default:
      return null;
  }
}
