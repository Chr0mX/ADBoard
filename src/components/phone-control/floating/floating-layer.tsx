"use client";

import { createPortal } from "react-dom";
import { useEffect, useState } from "react";
import { DeviceNavFloat } from "@/components/phone-control/floating/device-nav-float";
import { ControlPanelFloat } from "@/components/phone-control/floating/control-panel-float";
import { StatsWidget } from "@/components/phone-control/floating/stats-widget";
import { repairEdgeDockedFloatPrefs } from "@/lib/ui/floating-prefs-repair";
import type { DeskSection } from "@/components/phone-control/desk/desk-context";
import type { Device, NavAction, SessionStatus, StreamStats } from "@/lib/devices/types";

export interface FloatingLayerProps {
  device: Device | null;
  session?: SessionStatus | null;
  stats?: StreamStats | null;
  offline: boolean;
  fillWindow: boolean;
  keyboardOn: boolean;
  mouseOn: boolean;
  recording: boolean;
  replaying: boolean;
  refreshing: boolean;
  installing: boolean;
  onNav: (action: NavAction["type"]) => void;
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
      <StatsWidget device={props.device} session={props.session} stats={props.stats} />
      <ControlPanelFloat
        offline={props.offline}
        fillWindow={props.fillWindow}
        keyboardOn={props.keyboardOn}
        mouseOn={props.mouseOn}
        recording={props.recording}
        replaying={props.replaying}
        refreshing={props.refreshing}
        installing={props.installing}
        onFillWindowChange={props.onFillWindowChange}
        onKeyboardChange={props.onKeyboardChange}
        onMouseChange={props.onMouseChange}
        onRecordToggle={props.onRecordToggle}
        onReplay={props.onReplay}
        onRefresh={props.onRefresh}
        onInstallFile={props.onInstallFile}
        onOpenDevices={props.onOpenDevices}
        onOpenScreens={props.onOpenScreens}
        onOpenDesk={props.onOpenDesk}
      />
      <DeviceNavFloat offline={props.offline} onNav={props.onNav} />
    </div>,
    document.body,
  );
}
