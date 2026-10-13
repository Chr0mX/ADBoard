"use client";

import { useState } from "react";
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
  TASKBAR_TOOL_IDS,
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
        <div className="flex flex-wrap gap-1.5">
          <Toggle
            pressed={keyboardOn}
            onPressedChange={onKeyboardChange}
            aria-label="Toggle keyboard injection"
            className={HIT}
          >
            <Keyboard className="size-5" />
          </Toggle>
          <Toggle
            pressed={mouseOn}
            onPressedChange={onMouseChange}
            aria-label="Toggle touch"
            className={HIT}
          >
            <MousePointer2 className="size-5" />
          </Toggle>
          <Button
            type="button"
            variant="ghost"
            aria-label={recording ? "Stop recording" : "Record gesture"}
            data-gesture-record
            data-pressed={recording ? "true" : undefined}
            className={cn(HIT, recording && "border-[var(--pc-warn)] text-[var(--pc-warn)]")}
            onClick={onRecordToggle}
          >
            <Circle className={cn("size-5", recording && "fill-current")} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            aria-label={replaying ? "Playing gesture" : "Replay gesture"}
            data-gesture-replay
            disabled={replaying}
            className={HIT}
            onClick={onReplay}
          >
            <Play className="size-5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            aria-label="Refresh video"
            data-video-refresh
            disabled={offline || refreshing}
            className={HIT}
            onClick={onRefresh}
          >
            <RefreshCw className={cn("size-5", refreshing && "animate-spin")} />
          </Button>
          <label
            className={cn(HIT, "cursor-pointer", (offline || installing) && "pointer-events-none opacity-40")}
          >
            <span className="font-mono text-[10px] font-semibold">APK</span>
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
          </label>
          <Toggle
            pressed={gridView}
            onPressedChange={() => onToggleGrid()}
            aria-label={gridView ? "Exit grid view" : "Grid view"}
            data-grid-view={gridView ? "1" : "0"}
            className={HIT}
          >
            <LayoutGrid className="size-5" />
          </Toggle>
          <Button
            type="button"
            variant="ghost"
            aria-label={
              statsMode === "bar"
                ? "Stats: bottom bar (tap for floating widget)"
                : "Stats: floating widget (tap for bottom bar)"
            }
            aria-pressed={statsMode === "bar"}
            data-stats-mode={statsMode}
            className={cn(
              HIT,
              statsMode === "bar" && "border-[var(--pc-accent)] text-[var(--pc-accent)]",
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
          <Button
            type="button"
            variant="ghost"
            aria-label="Devices"
            className={HIT}
            onClick={onOpenDevices}
          >
            <Smartphone className="size-5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            aria-label="Desk"
            aria-expanded={deskOpen}
            data-pressed={deskOpen ? "true" : "false"}
            className={cn(HIT, deskOpen && "border-[var(--pc-accent)] text-[var(--pc-accent)]")}
            onClick={() => setDeskOpen((open) => !open)}
          >
            <PanelsTopLeft className="size-5" />
          </Button>
        </div>
        {deskOpen && (
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
              onClick={() => setTaskbarEdit((open) => !open)}
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
          {taskbarEdit && (
            <div data-taskbar-pin-list className="mt-1.5 flex flex-col gap-1">
              <p className="px-1 font-mono text-[10px] text-[var(--pc-muted)]">
                Pin up to {maxPins} tools on the bottom bar
                {atLimit ? " · full" : ""}
              </p>
              {TASKBAR_TOOL_IDS.map((id) => {
                const pinned = pins.includes(id);
                const blocked = !pinned && atLimit;
                return (
                  <button
                    key={id}
                    type="button"
                    data-taskbar-pin={id}
                    data-pinned={pinned ? "1" : "0"}
                    disabled={blocked}
                    aria-pressed={pinned}
                    className={cn(
                      "flex h-11 min-h-11 items-center justify-between rounded-xl border border-[var(--pc-line)] px-3 text-left text-sm text-[var(--pc-ink)] active:bg-[var(--pc-accent-soft)] disabled:opacity-40",
                      pinned && "border-[var(--pc-accent)] text-[var(--pc-accent)]",
                    )}
                    onClick={() => togglePin(id as TaskbarToolId)}
                  >
                    <span>{TASKBAR_TOOL_LABELS[id]}</span>
                    <Pin className={cn("size-3.5", pinned && "fill-current")} />
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </FloatingPanel>
  );
}
