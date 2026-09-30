"use client";

import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { DeviceNavBar } from "@/components/phone-control/device-nav-bar";
import { StatusBar } from "@/components/phone-control/status-bar";
import type { Device, NavAction, SessionStatus, StreamStats } from "@/lib/devices/types";
import type { MobileStatsMode } from "@/lib/ui/mobile-stats-mode";

interface MobileBottomChromeProps {
  offline: boolean;
  device: Device | null;
  session?: SessionStatus | null;
  stats?: StreamStats | null;
  statsMode: MobileStatsMode;
  onNav: (action: NavAction["type"]) => void;
  /** Called with the chrome height so the stream can reserve space above it. */
  onHeightChange?: (height: number) => void;
}

/**
 * iOS-safe bottom chrome: portaled + position:fixed to the visual viewport so
 * the stats bar cannot float above a dead home-indicator gap.
 */
export function MobileBottomChrome({
  offline,
  device,
  session,
  stats,
  statsMode,
  onNav,
  onHeightChange,
}: MobileBottomChromeProps) {
  const [mounted, setMounted] = useState(false);
  const chromeRef = useRef<HTMLDivElement>(null);

  useEffect(() => setMounted(true), []);

  useLayoutEffect(() => {
    const node = chromeRef.current;
    if (!node) return;
    const measure = () => {
      onHeightChange?.(Math.ceil(node.getBoundingClientRect().height));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [onHeightChange, statsMode]);

  if (!mounted) return null;

  return createPortal(
    <div
      ref={chromeRef}
      data-mobile-bottom-chrome
      className="pointer-events-auto fixed inset-x-0 bottom-0 z-30 flex w-full flex-col border-t border-[var(--pc-line)] bg-[var(--pc-panel)]"
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
    >
      <DeviceNavBar
        offline={offline}
        onNav={onNav}
        className="w-full max-w-full border-t-0"
        safeBottom={false}
      />
      {statsMode === "bar" && (
        <StatusBar
          device={device}
          session={session}
          stats={stats}
          safeBottom={false}
        />
      )}
    </div>,
    document.body,
  );
}
