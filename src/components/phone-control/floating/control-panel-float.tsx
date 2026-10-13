"use client";

import {
  type ReactNode,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  Circle,
  Keyboard,
  LayoutGrid,
  MonitorOff,
  MousePointer2,
  PanelBottom,
  PanelsTopLeft,
  PictureInPicture2,
  Pin,
  Play,
  RefreshCw,
  Smartphone,
  Volume2,
  VolumeX,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import { FloatingPanel } from "@/components/phone-control/floating/floating-panel";
import { DESK_SECTIONS } from "@/components/phone-control/desk/desk-context";
import type { DeskSection } from "@/components/phone-control/desk/desk-context";
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
  onKeyboardChange: (on: boolean) => void;
  onMouseChange: (on: boolean) => void;
  onRecordToggle: () => void;
  onReplay: () => void;
  onRefresh: () => void;
  onInstallFile: (file: File) => void;
  onOpenDevices: () => void;
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
  onKeyboardChange,
  onMouseChange,
  onRecordToggle,
  onReplay,
  onRefresh,
  onInstallFile,
  onOpenDevices,
  onToggleGrid,
  onOpenDesk,
}: ControlPanelFloatProps) {
  const [deskOpen, setDeskOpen] = useState(false);
  const [taskbarEdit, setTaskbarEdit] = useState(false);
  const { pins, togglePin, resetPins, atLimit, maxPins } = useTaskbarPins();
  const { options, apply, note, audioNote, audioError } = useScrcpyOptions({
    targetIds,
    serial,
    disabled: offline,
  });
  const streamHint = note || audioError || audioNote;

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
      <div data-control-panel-float className="flex flex-col gap-2">
        <div
          data-scrcpy-options-float
          className="flex flex-col gap-1.5 border-b border-[var(--pc-line)] pb-2"
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
            </select>
          </label>
          <div className="flex flex-wrap gap-1.5">
            <Toggle
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
              pressed={keyboardOn}
              onPressedChange={onKeyboardChange}
              aria-label={
                taskbarEdit
                  ? `${pins.includes("keyboard") ? "Unpin" : "Pin"} ${TASKBAR_TOOL_LABELS.keyboard}`
                  : "Toggle keyboard injection"
              }
              aria-pressed={taskbarEdit ? pins.includes("keyboard") : keyboardOn}
              data-taskbar-pin="keyboard"
              className={cn(HIT, taskbarEdit && pins.includes("keyboard") && "border-[var(--pc-accent)] text-[var(--pc-accent)]")}
            >
              <Keyboard className="size-5" />
            </Toggle>
          </PinableTool>
          <PinableTool {...pinProps("mouse")}>
            <Toggle
              pressed={mouseOn}
              onPressedChange={onMouseChange}
              aria-label={
                taskbarEdit
                  ? `${pins.includes("mouse") ? "Unpin" : "Pin"} ${TASKBAR_TOOL_LABELS.mouse}`
                  : "Toggle touch"
              }
              aria-pressed={taskbarEdit ? pins.includes("mouse") : mouseOn}
              data-taskbar-pin="mouse"
              className={cn(HIT, taskbarEdit && pins.includes("mouse") && "border-[var(--pc-accent)] text-[var(--pc-accent)]")}
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
                !taskbarEdit && recording && "border-[var(--pc-warn)] text-[var(--pc-warn)]",
                taskbarEdit && pins.includes("record") && "border-[var(--pc-accent)] text-[var(--pc-accent)]",
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
              className={cn(HIT, taskbarEdit && pins.includes("replay") && "border-[var(--pc-accent)] text-[var(--pc-accent)]")}
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
              className={cn(HIT, taskbarEdit && pins.includes("refresh") && "border-[var(--pc-accent)] text-[var(--pc-accent)]")}
              onClick={onRefresh}
            >
              <RefreshCw className={cn("size-5", !taskbarEdit && refreshing && "animate-spin")} />
            </Button>
          </PinableTool>
          <PinableTool {...pinProps("apk")}>
            <label
              data-taskbar-pin="apk"
              aria-label={
                taskbarEdit
                  ? `${pins.includes("apk") ? "Unpin" : "Pin"} ${TASKBAR_TOOL_LABELS.apk}`
                  : "Install APK"
              }
              className={cn(
                HIT,
                "cursor-pointer",
                !taskbarEdit && (offline || installing) && "pointer-events-none opacity-40",
                taskbarEdit && pins.includes("apk") && "border-[var(--pc-accent)] text-[var(--pc-accent)]",
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
              className={cn(HIT, taskbarEdit && pins.includes("grid") && "border-[var(--pc-accent)] text-[var(--pc-accent)]")}
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
                !taskbarEdit && statsMode === "bar" && "border-[var(--pc-accent)] text-[var(--pc-accent)]",
                taskbarEdit && pins.includes("stats") && "border-[var(--pc-accent)] text-[var(--pc-accent)]",
              )}
              onClick={() =>
                onStatsModeChange?.(statsMode === "bar" ? "float" : "bar")
              }
            >
              {statsMode === "bar" ? (
                <PanelBottom className="size-5" />
              ) : (
                <PictureInPicture2 className="size-5" />
              )}
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
              className={cn(HIT, taskbarEdit && pins.includes("devices") && "border-[var(--pc-accent)] text-[var(--pc-accent)]")}
              onClick={onOpenDevices}
            >
              <Smartphone className="size-5" />
            </Button>
          </PinableTool>
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
                !taskbarEdit && deskOpen && "border-[var(--pc-accent)] text-[var(--pc-accent)]",
                taskbarEdit && pins.includes("desk") && "border-[var(--pc-accent)] text-[var(--pc-accent)]",
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
                HIT,
                "min-w-0 flex-1 gap-1.5 px-2",
                taskbarEdit && "border-[var(--pc-accent)] text-[var(--pc-accent)]",
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
                className={cn(HIT, "px-2")}
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
