"use client";

import { useState } from "react";
import {
  Circle,
  Keyboard,
  LayoutGrid,
  Maximize2,
  MousePointer2,
  Play,
  RefreshCw,
  Smartphone,
  PanelsTopLeft,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import { FloatingPanel } from "@/components/phone-control/floating/floating-panel";
import { DESK_SECTIONS } from "@/components/phone-control/desk/desk-context";
import type { DeskSection } from "@/components/phone-control/desk/desk-context";
import { cn } from "@/lib/utils";

const HIT =
  "inline-flex h-12 min-h-12 w-12 min-w-12 shrink-0 items-center justify-center rounded-xl border border-[var(--pc-line)] bg-[var(--pc-panel)]/80 p-0 text-[var(--pc-ink)] active:bg-[var(--pc-accent-soft)] aria-pressed:border-[var(--pc-accent)] aria-pressed:bg-[var(--pc-accent-soft)] aria-pressed:text-[var(--pc-accent)] disabled:opacity-40";

interface ControlPanelFloatProps {
  offline: boolean;
  fillWindow: boolean;
  keyboardOn: boolean;
  mouseOn: boolean;
  recording: boolean;
  replaying: boolean;
  refreshing: boolean;
  installing: boolean;
  onFillWindowChange: (on: boolean) => void;
  onKeyboardChange: (on: boolean) => void;
  onMouseChange: (on: boolean) => void;
  onRecordToggle: () => void;
  onReplay: () => void;
  onRefresh: () => void;
  onInstallFile: (file: File) => void;
  onOpenDevices: () => void;
  onOpenScreens: () => void;
  onOpenDesk: (section: DeskSection) => void;
}

export function ControlPanelFloat({
  offline,
  fillWindow,
  keyboardOn,
  mouseOn,
  recording,
  replaying,
  refreshing,
  installing,
  onFillWindowChange,
  onKeyboardChange,
  onMouseChange,
  onRecordToggle,
  onReplay,
  onRefresh,
  onInstallFile,
  onOpenDevices,
  onOpenScreens,
  onOpenDesk,
}: ControlPanelFloatProps) {
  const [deskOpen, setDeskOpen] = useState(false);

  return (
    <FloatingPanel
      storageKey="pc-float-controls"
      kind="controls"
      defaultSize={{ width: 220, height: 200 }}
      className="w-[min(240px,calc(100vw-24px))]"
    >
      <div data-control-panel-float className="flex flex-col gap-2">
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
            pressed={fillWindow}
            onPressedChange={onFillWindowChange}
            aria-label="Fill window"
            className={HIT}
          >
            <Maximize2 className="size-5" />
          </Toggle>
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
            aria-label="Screens"
            className={HIT}
            onClick={onOpenScreens}
          >
            <LayoutGrid className="size-5" />
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
      </div>
    </FloatingPanel>
  );
}
