"use client";

import {
  type ReactNode,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  Camera,
  Circle,
  Grid2x2,
  Info,
  Mouse,
  RotateCcw,
  EllipsisVertical,
  Keyboard,
  LayoutGrid,
  MonitorOff,
  MousePointer2,
  PanelsTopLeft,
  Pin,
  Play,
  RefreshCw,
  Smartphone,
  Video,
  Volume2,
  VolumeX,
  Zap,
  Coffee,
  Expand,
  MonitorSmartphone,
  PictureInPicture2,
  RotateCwSquare,
  Shrink,
  Moon,
} from "lucide-react";
import { useStayAwake } from "@/hooks/use-stay-awake";
import { useQuietMode } from "@/hooks/use-quiet-mode";
import { useDeskOptional } from "@/components/adboard/desk/desk-context";
import { StatsBarsIcon } from "@/components/adboard/stats-bars-icon";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import { FloatingPanel } from "@/components/adboard/floating/floating-panel";
import { DESK_SECTIONS } from "@/components/adboard/desk/desk-context";
import type { DeskSection } from "@/components/adboard/desk/desk-context";
import { useScrcpyOptions } from "@/hooks/use-scrcpy-options";
import { useTaskbarPins } from "@/hooks/use-taskbar-pins";
import { PC_HIT_LG } from "@/lib/ui/control-chrome";
import type { MobileStatsMode } from "@/lib/ui/mobile-stats-mode";
import {
  TASKBAR_TOOL_LABELS,
  type TaskbarToolId,
} from "@/lib/ui/taskbar-pins";
import { cn } from "@/lib/utils";

const HIT = PC_HIT_LG;

interface ControlPanelFloatProps {
  offline: boolean;
  serial: string | null;
  targetIds: string[];
  statsMode: MobileStatsMode;
  onStatsModeChange?: (mode: MobileStatsMode) => void;
  gridView?: boolean;
  keyboardOn: boolean;
  mouseOn: boolean;
  recording: boolean;
  replaying: boolean;
  refreshing: boolean;
  installing: boolean;
  capturing?: boolean;
  screenRecording?: boolean;
  onKeyboardChange: (on: boolean) => void;
  onMouseChange: (on: boolean) => void;
  onRecordToggle: () => void;
  onReplay: () => void;
  onRefresh: () => void;
  onInstallFile: (file: File) => void;
  onScreenshot?: () => void;
  onScreenRecordToggle?: () => void;
  onOpenDevices: () => void;
  onOpenMacros?: () => void;
  cursorMode?: boolean;
  onCursorModeChange?: (on: boolean) => void;
  onRestart?: () => void;
  onOpenInfo?: () => void;
  onOpenArrangement?: () => void;
  onQuickActions?: (anchor: HTMLElement) => void;
  onRotate?: () => void;
  fullscreen?: boolean;
  onFullscreen?: () => void;
  pip?: boolean;
  onPip?: () => void;
  onToggleGrid: () => void;
  onOpenDesk: (section: DeskSection) => void;
}

/** Pin badge + accent when Taskbar customize mode is on. */
function PinableTool({
  id,
  editing,
  pinned,
  blocked,
  onTogglePin,
  className,
  children,
}: {
  id: TaskbarToolId;
  editing: boolean;
  pinned: boolean;
  blocked: boolean;
  onTogglePin: (id: TaskbarToolId) => void;
  className?: string;
  children: ReactNode;
}) {
  const intercept = (event: ReactMouseEvent) => {
    if (!editing) return;
    event.preventDefault();
    event.stopPropagation();
    if (!blocked) onTogglePin(id);
  };

  return (
    <div
      data-taskbar-pin-target={id}
      data-pinned={pinned ? "1" : "0"}
      data-pin-editing={editing ? "1" : "0"}
      className={cn("relative inline-flex", className)}
      onClickCapture={intercept}
    >
      {children}
      {editing && (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute -right-0.5 -top-0.5 inline-flex size-4 items-center justify-center rounded-full border border-[var(--pc-line)] bg-[var(--pc-panel)] text-[var(--pc-muted)]",
            pinned && "border-[var(--pc-accent)] text-[var(--pc-accent)]",
            blocked && !pinned && "opacity-40",
          )}
        >
          <Pin className={cn("size-2.5", pinned && "fill-current")} />
        </span>
      )}
    </div>
  );
}

export function ControlPanelFloat({
  offline,
  serial,
  targetIds,
  statsMode,
  onStatsModeChange,
  gridView = false,
  keyboardOn,
  mouseOn,
  recording,
  replaying,
  refreshing,
  installing,
  capturing = false,
  screenRecording = false,
  onKeyboardChange,
  onMouseChange,
  onRecordToggle,
  onReplay,
  onRefresh,
  onInstallFile,
  onScreenshot,
  onScreenRecordToggle,
  onOpenDevices,
  onOpenMacros,
  cursorMode = false,
  onCursorModeChange,
  onRestart,
  onOpenInfo,
  onOpenArrangement,
  onQuickActions,
  onRotate,
  fullscreen = false,
  onFullscreen,
  pip = false,
  onPip,
  onToggleGrid,
  onOpenDesk,
}: ControlPanelFloatProps) {
  const [deskOpen, setDeskOpen] = useState(false);
  // Screen sub-menu (Rotate / Fullscreen / Pop out): folded by default so the
  // panel keeps its height; always open while customizing the taskbar.
  const [screenOpen, setScreenOpen] = useState(false);
  const desk = useDeskOptional();
  const quiet = useQuietMode();
  const stayAwake = useStayAwake((desk?.devices ?? []).filter((d) => targetIds.includes(d.id)));
  const [taskbarEdit, setTaskbarEdit] = useState(false);
  const { pins, togglePin, resetPins, atLimit, maxPins } = useTaskbarPins();
  const { options, apply, note, audioNote, audioError } = useScrcpyOptions({
    targetIds,
    serial,
    disabled: offline,
  });
  const streamHint =
    note ||
    audioError ||
    audioNote ||
    stayAwake.note ||
    quiet.note ||
    (options.quality === "custom"
      ? `Custom: ${options.maxSize ? `${options.maxSize} px` : "native"} · ${(options.videoBitRate ?? 0) / 1_000_000} Mbps · ${options.maxFps} fps (edit in Settings)`
      : null);

  const pinProps = (id: TaskbarToolId) => ({
    id,
    editing: taskbarEdit,
    pinned: pins.includes(id),
    blocked: !pins.includes(id) && atLimit,
    onTogglePin: togglePin,
  });

  return (
    <FloatingPanel
      storageKey="pc-float-controls"
      kind="controls"
      defaultSize={{ width: 240, height: 280 }}
      className="w-[min(260px,calc(100vw-24px))]"
    >
      <div data-control-panel-float className="flex flex-col gap-2.5">
        <div
          data-scrcpy-options-float
          className="flex flex-col gap-1.5 border-b border-[var(--pc-line)] pb-2.5"
        >
          <label className="flex h-12 min-h-12 items-center gap-2 rounded-xl border border-[var(--pc-line)] bg-[var(--pc-panel)]/80 px-3">
            <span className="font-mono text-[10px] uppercase tracking-wide text-[var(--pc-muted)]">
              Quality
            </span>
            <select
              aria-label="Stream quality"
              data-scrcpy-quality
              disabled={offline}
              value={options.quality}
              onChange={(event) => {
                void apply({ ...options, quality: event.target.value });
              }}
              className="min-w-0 flex-1 bg-transparent font-mono text-xs text-[var(--pc-ink)] outline-none disabled:opacity-40"
            >
              <option value="low">Low</option>
              <option value="balanced">Balanced</option>
              <option value="high">High</option>
              <option value="original">Original</option>
              <option value="custom">Custom</option>
            </select>
          </label>
          <div className="flex flex-wrap gap-1.5">
            <Toggle
              size="none"
              pressed={options.audio}
              onPressedChange={(on) => {
                void apply({ ...options, audio: on });
              }}
              disabled={offline}
              aria-label="Audio forwarding"
              data-scrcpy-audio
              className={HIT}
            >
              {options.audio ? <Volume2 className="size-5" /> : <VolumeX className="size-5" />}
            </Toggle>
            <Toggle
              size="none"
              pressed={options.screenOff}
              onPressedChange={(on) => {
                void apply({ ...options, screenOff: on });
              }}
              disabled={offline}
              aria-label="Screen off"
              data-scrcpy-screen
              className={HIT}
            >
              <MonitorOff className="size-5" />
            </Toggle>
            <Toggle
              size="none"
              pressed={stayAwake.on}
              onPressedChange={(on) => stayAwake.setOn(on)}
              disabled={offline || stayAwake.busy || !stayAwake.available}
              aria-label="Stay awake"
              title="Keep the phone awake while connected (does not turn the screen off)"
              data-scrcpy-stay-awake
              className={HIT}
            >
              <Coffee className="size-5" />
            </Toggle>
            <PinableTool {...pinProps("quiet")}>
              <Toggle
                size="none"
                pressed={taskbarEdit ? pins.includes("quiet") : quiet.on}
                onPressedChange={(on) => {
                  if (!taskbarEdit) quiet.toggle(on);
                }}
                disabled={!taskbarEdit && (quiet.busy || !quiet.available)}
                aria-label={
                  taskbarEdit
                    ? `${pins.includes("quiet") ? "Unpin" : "Pin"} ${TASKBAR_TOOL_LABELS.quiet}`
                    : "Quiet mode: all screens off and muted"
                }
                title="Quiet mode: every online phone's screen off and sound muted"
                data-taskbar-pin="quiet"
                data-quiet-mode={quiet.on ? "1" : "0"}
                className={HIT}
              >
                <Moon className="size-5" />
              </Toggle>
            </PinableTool>
          </div>
          {streamHint && (
            <p
              data-scrcpy-note
              className="truncate font-mono text-[10px] text-[var(--pc-muted)]"
            >
              {streamHint}
            </p>
          )}
        </div>
        <div
          data-tools-grid
          data-taskbar-edit={taskbarEdit ? "1" : "0"}
          className="flex flex-wrap gap-1.5"
        >
          {taskbarEdit && (
            <p className="w-full px-0.5 font-mono text-[10px] text-[var(--pc-muted)]">
              Tap icons to pin up to {maxPins} on the bottom bar
              {atLimit ? " · full" : pins.length > 0 ? ` · ${pins.length} pinned` : ""}
            </p>
          )}
          <PinableTool {...pinProps("keyboard")}>
            <Toggle
              size="none"
              pressed={keyboardOn}
              onPressedChange={onKeyboardChange}
              aria-label={
                taskbarEdit
                  ? `${pins.includes("keyboard") ? "Unpin" : "Pin"} ${TASKBAR_TOOL_LABELS.keyboard}`
                  : "Toggle keyboard injection"
              }
              aria-pressed={taskbarEdit ? pins.includes("keyboard") : keyboardOn}
              data-taskbar-pin="keyboard"
              className={HIT}
            >
              <Keyboard className="size-5" />
            </Toggle>
          </PinableTool>
          <PinableTool {...pinProps("mouse")}>
            <Toggle
              size="none"
              pressed={mouseOn}
              onPressedChange={onMouseChange}
              aria-label={
                taskbarEdit
                  ? `${pins.includes("mouse") ? "Unpin" : "Pin"} ${TASKBAR_TOOL_LABELS.mouse}`
                  : "Toggle touch"
              }
              aria-pressed={taskbarEdit ? pins.includes("mouse") : mouseOn}
              data-taskbar-pin="mouse"
              className={HIT}
            >
              <MousePointer2 className="size-5" />
            </Toggle>
          </PinableTool>
          <PinableTool {...pinProps("record")}>
            <Button
              type="button"
              variant="ghost"
              aria-label={
                taskbarEdit
                  ? `${pins.includes("record") ? "Unpin" : "Pin"} ${TASKBAR_TOOL_LABELS.record}`
                  : recording
                    ? "Stop recording"
                    : "Record gesture"
              }
              aria-pressed={taskbarEdit ? pins.includes("record") : undefined}
              data-gesture-record
              data-taskbar-pin="record"
              data-pressed={!taskbarEdit && recording ? "true" : undefined}
              className={cn(
                HIT,
                !taskbarEdit && "pc-toggle-warn",
              )}
              onClick={onRecordToggle}
            >
              <Circle className={cn("size-5", !taskbarEdit && recording && "fill-current")} />
            </Button>
          </PinableTool>
          <PinableTool {...pinProps("replay")}>
            <Button
              type="button"
              variant="ghost"
              aria-label={
                taskbarEdit
                  ? `${pins.includes("replay") ? "Unpin" : "Pin"} ${TASKBAR_TOOL_LABELS.replay}`
                  : replaying
                    ? "Playing gesture"
                    : "Replay gesture"
              }
              aria-pressed={taskbarEdit ? pins.includes("replay") : undefined}
              data-gesture-replay
              data-taskbar-pin="replay"
              disabled={!taskbarEdit && replaying}
              className={HIT}
              onClick={onReplay}
            >
              <Play className="size-5" />
            </Button>
          </PinableTool>
          <PinableTool {...pinProps("refresh")}>
            <Button
              type="button"
              variant="ghost"
              aria-label={
                taskbarEdit
                  ? `${pins.includes("refresh") ? "Unpin" : "Pin"} ${TASKBAR_TOOL_LABELS.refresh}`
                  : "Refresh video"
              }
              aria-pressed={taskbarEdit ? pins.includes("refresh") : undefined}
              data-video-refresh
              data-taskbar-pin="refresh"
              disabled={!taskbarEdit && (offline || refreshing)}
              className={HIT}
              onClick={onRefresh}
            >
              <RefreshCw className={cn("size-5", !taskbarEdit && refreshing && "animate-spin")} />
            </Button>
          </PinableTool>
          {!taskbarEdit && (
            <>
              <Button
                type="button"
                variant="ghost"
                aria-label="Screenshot and download"
                data-control-screenshot
                disabled={offline || capturing || targetIds.length === 0}
                className={HIT}
                onClick={() => onScreenshot?.()}
              >
                <Camera className="size-5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                aria-label={screenRecording ? "Stop screen record" : "Start screen record"}
                data-control-screenrecord
                data-pressed={screenRecording ? "true" : undefined}
                disabled={offline || capturing || targetIds.length === 0}
                className={cn(HIT, "pc-toggle-warn")}
                onClick={() => onScreenRecordToggle?.()}
              >
                <Video className="size-5" />
              </Button>
            </>
          )}
          <PinableTool {...pinProps("apk")}>
            <label
              data-taskbar-pin="apk"
              data-pressed={taskbarEdit && pins.includes("apk") ? "true" : undefined}
              aria-label={
                taskbarEdit
                  ? `${pins.includes("apk") ? "Unpin" : "Pin"} ${TASKBAR_TOOL_LABELS.apk}`
                  : "Install APK"
              }
              className={cn(
                HIT,
                "cursor-pointer",
                !taskbarEdit && (offline || installing) && "pointer-events-none opacity-40",
              )}
            >
              <span className="font-mono text-[10px] font-semibold">APK</span>
              {!taskbarEdit && (
                <input
                  type="file"
                  accept=".apk,application/vnd.android.package-archive"
                  aria-label="Install APK"
                  className="sr-only"
                  disabled={offline || installing}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) onInstallFile(file);
                  }}
                />
              )}
            </label>
          </PinableTool>
          <PinableTool {...pinProps("grid")}>
            <Toggle
              size="none"
              pressed={gridView}
              onPressedChange={() => onToggleGrid()}
              aria-label={
                taskbarEdit
                  ? `${pins.includes("grid") ? "Unpin" : "Pin"} ${TASKBAR_TOOL_LABELS.grid}`
                  : gridView
                    ? "Exit grid view"
                    : "Grid view"
              }
              aria-pressed={taskbarEdit ? pins.includes("grid") : gridView}
              data-grid-view={gridView ? "1" : "0"}
              data-taskbar-pin="grid"
              className={HIT}
            >
              <LayoutGrid className="size-5" />
            </Toggle>
          </PinableTool>
          <PinableTool {...pinProps("stats")}>
            <Button
              type="button"
              variant="ghost"
              aria-label={
                taskbarEdit
                  ? `${pins.includes("stats") ? "Unpin" : "Pin"} ${TASKBAR_TOOL_LABELS.stats}`
                  : statsMode === "bar"
                    ? "Stats: bottom bar (tap for floating widget)"
                    : "Stats: floating widget (tap for bottom bar)"
              }
              aria-pressed={taskbarEdit ? pins.includes("stats") : statsMode === "bar"}
              data-stats-mode={statsMode}
              data-taskbar-pin="stats"
              className={cn(
                HIT,
              )}
              onClick={() =>
                onStatsModeChange?.(statsMode === "bar" ? "float" : "bar")
              }
            >
              <StatsBarsIcon className="size-5" />
            </Button>
          </PinableTool>
          <PinableTool {...pinProps("devices")}>
            <Button
              type="button"
              variant="ghost"
              aria-label={
                taskbarEdit
                  ? `${pins.includes("devices") ? "Unpin" : "Pin"} ${TASKBAR_TOOL_LABELS.devices}`
                  : "Devices"
              }
              aria-pressed={taskbarEdit ? pins.includes("devices") : undefined}
              data-taskbar-pin="devices"
              className={HIT}
              onClick={onOpenDevices}
            >
              <Smartphone className="size-5" />
            </Button>
          </PinableTool>
          {onCursorModeChange && (
            <PinableTool {...pinProps("cursor")}>
              <Toggle
                size="none"
                pressed={taskbarEdit ? pins.includes("cursor") : cursorMode}
                onPressedChange={(on) => {
                  if (!taskbarEdit) onCursorModeChange(on);
                }}
                aria-label={taskbarEdit ? `${pins.includes("cursor") ? "Unpin" : "Pin"} ${TASKBAR_TOOL_LABELS.cursor}` : "Cursor mode"}
                data-taskbar-pin="cursor"
                data-cursor-mode={cursorMode ? "1" : "0"}
                className={HIT}
              >
                <Mouse className="size-5" />
              </Toggle>
            </PinableTool>
          )}
          {onRestart && (
            <PinableTool {...pinProps("restart")}>
              <Button
                type="button"
                variant="ghost"
                aria-label={taskbarEdit ? `${pins.includes("restart") ? "Unpin" : "Pin"} ${TASKBAR_TOOL_LABELS.restart}` : "Restart device"}
                aria-pressed={taskbarEdit ? pins.includes("restart") : undefined}
                data-taskbar-pin="restart"
                data-device-restart
                disabled={!taskbarEdit && offline}
                className={HIT}
                onClick={onRestart}
              >
                <RotateCcw className="size-5" />
              </Button>
            </PinableTool>
          )}
          {onOpenInfo && (
            <PinableTool {...pinProps("info")}>
              <Button
                type="button"
                variant="ghost"
                aria-label={taskbarEdit ? `${pins.includes("info") ? "Unpin" : "Pin"} ${TASKBAR_TOOL_LABELS.info}` : "Device information"}
                aria-pressed={taskbarEdit ? pins.includes("info") : undefined}
                data-taskbar-pin="info"
                data-device-info-open
                className={HIT}
                onClick={onOpenInfo}
              >
                <Info className="size-5" />
              </Button>
            </PinableTool>
          )}
          {onOpenArrangement && (
            <PinableTool {...pinProps("arrangement")}>
              <Button
                type="button"
                variant="ghost"
                aria-label={taskbarEdit ? `${pins.includes("arrangement") ? "Unpin" : "Pin"} ${TASKBAR_TOOL_LABELS.arrangement}` : "Arrangement"}
                aria-pressed={taskbarEdit ? pins.includes("arrangement") : undefined}
                data-taskbar-pin="arrangement"
                data-open-arrangement
                className={HIT}
                onClick={onOpenArrangement}
              >
                <Grid2x2 className="size-5" />
              </Button>
            </PinableTool>
          )}
          {onQuickActions && (
            <PinableTool {...pinProps("quick")}>
              <Button
                type="button"
                variant="ghost"
                aria-label={taskbarEdit ? `${pins.includes("quick") ? "Unpin" : "Pin"} ${TASKBAR_TOOL_LABELS.quick}` : "Device actions"}
                aria-pressed={taskbarEdit ? pins.includes("quick") : undefined}
                data-taskbar-pin="quick"
                aria-haspopup="menu"
                data-open-quick-actions
                disabled={!taskbarEdit && offline}
                className={HIT}
                onClick={(event) => onQuickActions?.(event.currentTarget)}
              >
                <EllipsisVertical className="size-5" />
              </Button>
            </PinableTool>
          )}
          {(onRotate || onFullscreen || onPip) && (
            <>
              <Button
                type="button"
                variant="ghost"
                aria-label="Screen tools"
                aria-expanded={screenOpen || taskbarEdit}
                title="Rotate, fullscreen, pop out"
                data-screen-menu-toggle
                disabled={taskbarEdit}
                className={HIT}
                onClick={() => setScreenOpen((open) => !open)}
              >
                <MonitorSmartphone className="size-5" />
              </Button>
              {(screenOpen || taskbarEdit) && (
                <div data-screen-menu className="flex w-full flex-wrap gap-1.5 rounded-xl border border-[var(--pc-line)] p-1">
                  {onRotate && (
                    <PinableTool {...pinProps("rotate")}>
                      <Button
                        type="button"
                        variant="ghost"
                        aria-label={taskbarEdit ? `${pins.includes("rotate") ? "Unpin" : "Pin"} ${TASKBAR_TOOL_LABELS.rotate}` : "Rotate phone"}
                        aria-pressed={taskbarEdit ? pins.includes("rotate") : undefined}
                        data-taskbar-pin="rotate"
                        data-device-rotate
                        disabled={!taskbarEdit && offline}
                        className={HIT}
                        onClick={onRotate}
                      >
                        <RotateCwSquare className="size-5" />
                      </Button>
                    </PinableTool>
                  )}
                  {onFullscreen && (
                    <PinableTool {...pinProps("fullscreen")}>
                      <Toggle
                        size="none"
                        pressed={taskbarEdit ? pins.includes("fullscreen") : fullscreen}
                        onPressedChange={() => {
                          if (!taskbarEdit) onFullscreen();
                        }}
                        aria-label={taskbarEdit ? `${pins.includes("fullscreen") ? "Unpin" : "Pin"} ${TASKBAR_TOOL_LABELS.fullscreen}` : fullscreen ? "Exit fullscreen" : "Fullscreen"}
                        data-taskbar-pin="fullscreen"
                        data-fullscreen-toggle
                        className={HIT}
                      >
                        {fullscreen ? <Shrink className="size-5" /> : <Expand className="size-5" />}
                      </Toggle>
                    </PinableTool>
                  )}
                  {onPip && (
                    <PinableTool {...pinProps("pip")}>
                      <Toggle
                        size="none"
                        pressed={taskbarEdit ? pins.includes("pip") : pip}
                        onPressedChange={() => {
                          if (!taskbarEdit) onPip();
                        }}
                        disabled={!taskbarEdit && offline}
                        aria-label={taskbarEdit ? `${pins.includes("pip") ? "Unpin" : "Pin"} ${TASKBAR_TOOL_LABELS.pip}` : "Pop out (always on top, view only)"}
                        data-taskbar-pin="pip"
                        data-pip-toggle
                        className={HIT}
                      >
                        <PictureInPicture2 className="size-5" />
                      </Toggle>
                    </PinableTool>
                  )}
                </div>
              )}
            </>
          )}
          {onOpenMacros && !taskbarEdit && (
            <Button
              type="button"
              variant="ghost"
              aria-label="Macro"
              data-open-macros
              className="pc-toggle pc-toggle-lg gap-1.5 px-3"
              onClick={onOpenMacros}
            >
              <Zap className="size-5" />
              <span data-macro-label>Macro</span>
            </Button>
          )}
          <PinableTool {...pinProps("desk")}>
            <Button
              type="button"
              variant="ghost"
              aria-label={
                taskbarEdit
                  ? `${pins.includes("desk") ? "Unpin" : "Pin"} ${TASKBAR_TOOL_LABELS.desk}`
                  : "Desk"
              }
              aria-expanded={!taskbarEdit && deskOpen}
              aria-pressed={taskbarEdit ? pins.includes("desk") : deskOpen}
              data-taskbar-pin="desk"
              data-pressed={!taskbarEdit && deskOpen ? "true" : "false"}
              className={cn(
                HIT,
              )}
              onClick={() => setDeskOpen((open) => !open)}
            >
              <PanelsTopLeft className="size-5" />
            </Button>
          </PinableTool>
        </div>
        {deskOpen && !taskbarEdit && (
          <div
            data-desk-menu
            className="grid grid-cols-2 gap-1 border-t border-[var(--pc-line)] pt-2"
          >
            {DESK_SECTIONS.filter((item) => item.id !== "control").map((item) => (
              <button
                key={item.id}
                type="button"
                className="inline-flex h-12 min-h-12 items-center justify-center rounded-xl px-2 text-sm text-[var(--pc-ink)] active:bg-[var(--pc-accent-soft)]"
                onClick={() => {
                  setDeskOpen(false);
                  onOpenDesk(item.id);
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
        )}
        <div className="border-t border-[var(--pc-line)] pt-2">
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              variant="ghost"
              aria-label="Customize taskbar"
              aria-expanded={taskbarEdit}
              data-taskbar-customize
              data-pressed={taskbarEdit ? "true" : "false"}
              className={cn(
                "pc-toggle pc-toggle-lg",
                "min-w-0 flex-1 gap-1.5 px-2",
              )}
              onClick={() => {
                setTaskbarEdit((open) => !open);
                setDeskOpen(false);
              }}
            >
              <Pin className={cn("size-4", pins.length > 0 && "fill-current")} />
              <span className="font-mono text-[10px]">
                Taskbar{pins.length > 0 ? ` (${pins.length})` : ""}
              </span>
            </Button>
            {taskbarEdit && (
              <Button
                type="button"
                variant="ghost"
                aria-label="Reset taskbar pins"
                data-taskbar-reset
                className="pc-toggle pc-toggle-lg px-2"
                onClick={resetPins}
              >
                <span className="font-mono text-[10px]">Reset</span>
              </Button>
            )}
          </div>
        </div>
      </div>
    </FloatingPanel>
  );
}
