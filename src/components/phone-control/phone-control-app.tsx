"use client";

import { useState, useSyncExternalStore } from "react";
import type { StreamStats } from "@/lib/devices/types";
import { ControlHeader } from "@/components/phone-control/control-header";
import { ControlModes } from "@/components/phone-control/control-modes";
import { DeviceGrid } from "@/components/phone-control/device-grid";
import { PhoneScreen } from "@/components/phone-control/phone-screen";
import { ScreenGrid } from "@/components/phone-control/screen-grid";
import { StatusBar } from "@/components/phone-control/status-bar";
import { Button } from "@/components/ui/button";
import { usePhoneControl } from "@/hooks/use-phone-control";
import { useStoredFlag } from "@/hooks/use-stored-flag";
import { cn } from "@/lib/utils";

function subscribeWide(onChange: () => void) {
  const media = window.matchMedia("(min-width: 1024px)");
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

export function PhoneControlApp() {
  const {
    devices,
    loading,
    error,
    onlineCount,
    activeDevice,
    activeSession,
    activeId,
    selectedIds,
    controlMode,
    setControlMode,
    keyboardOn,
    setKeyboardOn,
    mouseOn,
    setMouseOn,
    selectDevice,
    broadcastTargets,
    handlePointer,
    handleNav,
    handleInstall,
    lastTap,
  } = usePhoneControl();

  const [fillWindow, setFillWindow] = useStoredFlag("phonecontrol-fill-window", false);
  const wide = useSyncExternalStore(
    subscribeWide,
    () => window.matchMedia("(min-width: 1024px)").matches,
    () => false,
  );
  const [devicesOpen, setDevicesOpen] = useState(false);
  const [screensOpen, setScreensOpen] = useState(false);

  const setFill = (on: boolean) => {
    setFillWindow(on);
    if (on) setDevicesOpen(false);
  };

  const [streamStats, setStreamStats] = useState<StreamStats | null>(null);

  const onPointer = async (event: {
    phase: "down" | "move" | "up" | "cancel" | "hover" | "leave";
    point: { x: number; y: number };
    frameWidth: number;
    frameHeight: number;
    tool: "finger" | "mouse";
  }) => {
    await handlePointer(
      event.phase,
      event.point,
      event.frameWidth,
      event.frameHeight,
      event.tool,
    );
  };

  const showDevices = !fillWindow && (wide || devicesOpen);
  const dockedScreens = wide && !fillWindow;
  const screenSheet = screensOpen && !dockedScreens;

  return (
    <div className="pc-shell relative flex h-dvh max-h-dvh flex-col overflow-hidden">
      <div className="pc-atmosphere" aria-hidden />
      {!fillWindow && (
        <ControlHeader onlineCount={onlineCount} totalCount={devices.length} />
      )}

      <main
        className={cn(
          "relative z-10 flex min-h-0 flex-1 flex-col overflow-hidden",
          !fillWindow && "px-2 py-2 lg:px-4 lg:py-3",
        )}
      >
        {loading && (
          <div className="flex flex-1 items-center justify-center font-mono text-sm text-[var(--pc-muted)]">
            Loading devices…
          </div>
        )}

        {error && !loading && devices.length === 0 && (
          <div className="flex flex-1 items-center justify-center px-4 text-center text-sm text-[var(--pc-warn)]">
            {error}
          </div>
        )}

        {!loading && devices.length > 0 && (
          <>
            {error && !fillWindow && (
              <p className="mb-1 shrink-0 truncate px-1 font-mono text-[10px] text-[var(--pc-warn)]">
                {error}
              </p>
            )}
            <div
              className={cn(
                "flex min-h-0 min-w-0 flex-1 flex-col",
                !fillWindow && "lg:flex-row lg:gap-3",
              )}
            >
            {dockedScreens && (
              <aside className="flex min-h-0 w-[200px] shrink-0 flex-col xl:w-[240px]">
                <ScreenGrid
                  devices={devices}
                  activeId={activeId}
                  onSelect={selectDevice}
                />
              </aside>
            )}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <PhoneScreen
                device={activeDevice}
                session={activeSession}
                keyboardOn={keyboardOn}
                mouseOn={mouseOn}
                fillWindow={fillWindow}
                onFillWindowChange={setFill}
                showDevicesButton={!fillWindow && !wide}
                onOpenDevices={() => {
                  setScreensOpen(false);
                  setDevicesOpen(true);
                }}
                showScreensButton={!dockedScreens}
                onOpenScreens={() => {
                  setDevicesOpen(false);
                  setScreensOpen(true);
                }}
                onKeyboardChange={setKeyboardOn}
                onMouseChange={setMouseOn}
                onPointer={onPointer}
                onStats={setStreamStats}
                onNav={handleNav}
                onInstall={handleInstall}
                lastTap={lastTap}
                broadcastLabel={`${broadcastTargets.length} target${broadcastTargets.length === 1 ? "" : "s"}`}
                targetIds={broadcastTargets.map((device) => device.id)}
              />
            </div>

            {showDevices && (
              <aside
                className={cn(
                  "flex min-h-0 flex-col gap-3",
                  wide
                    ? "w-[320px] shrink-0 overflow-y-auto xl:w-[360px]"
                    : "absolute inset-0 z-30 gap-4 overflow-y-auto bg-[var(--pc-paper)] p-3",
                )}
              >
                {!wide && (
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="font-display text-base font-semibold text-[var(--pc-ink)]">
                      Devices
                    </h2>
                    <Button
                      type="button"
                      variant="outline"
                      className="h-11 min-w-11"
                      onClick={() => setDevicesOpen(false)}
                    >
                      Close
                    </Button>
                  </div>
                )}
                <DeviceGrid
                  devices={devices}
                  activeId={activeId}
                  selectedIds={selectedIds}
                  onSelect={(event) => {
                    selectDevice(event);
                    if (
                      !wide &&
                      !event.ctrlKey &&
                      !event.shiftKey &&
                      !event.metaKey
                    ) {
                      setDevicesOpen(false);
                    }
                  }}
                />
                <ControlModes
                  mode={controlMode}
                  onChange={setControlMode}
                  selectedCount={activeId ? 1 : 0}
                  multiCount={selectedIds.size}
                  onlineCount={onlineCount}
                />
              </aside>
            )}
            </div>
            {screenSheet && (
              <div className="absolute inset-0 z-40 flex flex-col gap-3 overflow-hidden bg-[var(--pc-paper)] p-3">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="font-display text-base font-semibold text-[var(--pc-ink)]">
                    Screens
                  </h2>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11 min-w-11"
                    onClick={() => setScreensOpen(false)}
                  >
                    Close
                  </Button>
                </div>
                <ScreenGrid
                  devices={devices}
                  activeId={activeId}
                  showHeading={false}
                  onSelect={(event) => {
                    selectDevice(event);
                    if (!event.ctrlKey && !event.shiftKey && !event.metaKey) {
                      setScreensOpen(false);
                    }
                  }}
                />
              </div>
            )}
          </>
        )}
      </main>

      <StatusBar device={activeDevice} session={activeSession} stats={streamStats} />
    </div>
  );
}
