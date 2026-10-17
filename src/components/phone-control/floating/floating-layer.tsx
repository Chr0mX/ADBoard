"use client";

import { createPortal } from "react-dom";
import { useEffect, useState } from "react";
import { ControlPanelFloat } from "@/components/phone-control/floating/control-panel-float";
import { StatsWidget } from "@/components/phone-control/floating/stats-widget";
import type { MobileStatsMode } from "@/lib/ui/mobile-stats-mode";
import { repairEdgeDockedFloatPrefs } from "@/lib/ui/floating-prefs-repair";
import type { DeskSection } from "@/components/phone-control/desk/desk-context";
import type { Device, SessionStatus, StreamStats } from "@/lib/devices/types";

export interface FloatingLayerProps {
  device: Device | null;
  session?: SessionStatus | null;
  stats?: StreamStats | null;
  statsMode?: MobileStatsMode;
  onStatsModeChange?: (mode: MobileStatsMode) => void;
  targetIds: string[];
  offline: boolean;
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

/** Shared props bag for the mobile floating chrome. */

export function FloatingLayer(props: FloatingLayerProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    repairEdgeDockedFloatPrefs();
    setMounted(true);
  }, []);
  if (!mounted) return null;

  return createPortal(
    <div
      data-floating-layer
      className="pointer-events-none fixed inset-0 z-20"
      aria-live="polite"
    >
      {props.statsMode !== "bar" && (
        <StatsWidget device={props.device} session={props.session} stats={props.stats} />
      )}
      <ControlPanelFloat
        offline={props.offline}
        serial={props.device?.serial ?? null}
        targetIds={props.targetIds}
        statsMode={props.statsMode ?? "float"}
        onStatsModeChange={props.onStatsModeChange}
        gridView={props.gridView}
        keyboardOn={props.keyboardOn}
        mouseOn={props.mouseOn}
        recording={props.recording}
        replaying={props.replaying}
        refreshing={props.refreshing}
        installing={props.installing}
        capturing={props.capturing}
        screenRecording={props.screenRecording}
        onKeyboardChange={props.onKeyboardChange}
        onMouseChange={props.onMouseChange}
        onRecordToggle={props.onRecordToggle}
        onReplay={props.onReplay}
        onRefresh={props.onRefresh}
        onInstallFile={props.onInstallFile}
        onScreenshot={props.onScreenshot}
        onScreenRecordToggle={props.onScreenRecordToggle}
        onOpenDevices={props.onOpenDevices}
        onOpenMacros={props.onOpenMacros}
        cursorMode={props.cursorMode}
        onCursorModeChange={props.onCursorModeChange}
        onRestart={props.onRestart}
        onOpenInfo={props.onOpenInfo}
        onOpenArrangement={props.onOpenArrangement}
        onQuickActions={props.onQuickActions}
        onRotate={props.onRotate}
        fullscreen={props.fullscreen}
        onFullscreen={props.onFullscreen}
        pip={props.pip}
        onPip={props.onPip}
        onToggleGrid={props.onToggleGrid}
        onOpenDesk={props.onOpenDesk}
      />
    </div>,
    document.body,
  );
}
