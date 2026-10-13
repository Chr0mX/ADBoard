"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { StreamStats } from "@/lib/devices/types";
import { ControlHeader } from "@/components/phone-control/control-header";
import { ControlModes } from "@/components/phone-control/control-modes";
import { DeviceGrid } from "@/components/phone-control/device-grid";
import { PhoneScreen } from "@/components/phone-control/phone-screen";
import { ScreenGrid } from "@/components/phone-control/screen-grid";
import { StatusBar } from "@/components/phone-control/status-bar";
import { AppsPanel } from "@/components/phone-control/desk/apps-panel";
import { AutomatePanel } from "@/components/phone-control/desk/automate-panel";
import {
  DeskProvider,
  asSection,
  type DeskSection,
} from "@/components/phone-control/desk/desk-context";
import { DeveloperPanel } from "@/components/phone-control/desk/developer-panel";
import { FilesPanel } from "@/components/phone-control/desk/files-panel";
import { HostsPanel } from "@/components/phone-control/desk/hosts-panel";
import { ManagePanel } from "@/components/phone-control/desk/manage-panel";
import { Button } from "@/components/ui/button";
import { usePhoneControl } from "@/hooks/use-phone-control";
import { useStoredFlag, useStoredString } from "@/hooks/use-stored-flag";
import { useVisualViewportLock } from "@/hooks/use-visual-viewport-lock";
import { parseMobileStatsMode, type MobileStatsMode } from "@/lib/ui/mobile-stats-mode";
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
    toggleSelected,
    broadcastTargets,
    handlePointer,
    handleNav,
    handleInstall,
    lastTap,
    sessions,
  } = usePhoneControl();

  const [storedFillWindow, setFillWindow] = useStoredFlag("phonecontrol-fill-window", false);
  const wide = useSyncExternalStore(
    subscribeWide,
    () => window.matchMedia("(min-width: 1024px)").matches,
    () => false,
  );
  // Mobile always fills; Fill toggle stays desktop-only.
  const fillWindow = wide ? storedFillWindow : true;
  const [devicesOpen, setDevicesOpen] = useState(false);
  const [screensOpen, setScreensOpen] = useState(false);
  const [gridView, setGridView] = useState(false);

  const setFill = (on: boolean) => {
    if (!wide) return;
    setFillWindow(on);
    if (on) setDevicesOpen(false);
  };

  const [storedStatsMode, setStoredStatsMode] = useStoredString("phonecontrol-mobile-stats-mode");
  const mobileStatsMode = parseMobileStatsMode(storedStatsMode);
  const setMobileStatsMode = (mode: MobileStatsMode) => setStoredStatsMode(mode);

  const [streamStats, setStreamStats] = useState<StreamStats | null>(null);
  const [storedSection, setStoredSection] = useStoredString("phonecontrol-section");
  const section = asSection(storedSection);
  const [focusTool, setFocusTool] = useState<string | null>(null);
  const [lastSeen, setLastSeen] = useState<Record<string, number>>({});
  const seenRef = useRef<Record<string, number>>({});
  const statusRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    const now = Date.now();
    let changed = false;
    for (const device of devices) {
      const before = statusRef.current.get(device.id);
      if (device.status === "online") {
        seenRef.current[device.id] = now;
        if (before !== "online") changed = true;
      } else if (before === "online") {
        changed = true;
      }
      statusRef.current.set(device.id, device.status);
    }
    if (changed) setLastSeen({ ...seenRef.current });
  }, [devices]);

  useEffect(() => {
    // Keep grid mode when resizing; only clear the mobile sheet overlays.
    if (wide) {
      setDevicesOpen(false);
      setScreensOpen(false);
    }
  }, [wide]);

  useEffect(() => {
    if (!devicesOpen && !screensOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setDevicesOpen(false);
      setScreensOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [devicesOpen, screensOpen]);

  const open = (next: DeskSection, tool?: string, deviceId?: string) => {
    if (deviceId) {
      selectDevice({ deviceId, ctrlKey: false, shiftKey: false, metaKey: false });
    }
    setFocusTool(tool ?? null);
    setStoredSection(next);
  };

  const onPointer = async (event: {
    phase: "down" | "move" | "up" | "cancel" | "hover" | "leave";
    point: { x: number; y: number };
    frameWidth: number;
    frameHeight: number;
    tool: "finger" | "mouse";
    replay?: boolean;
  }) => {
    await handlePointer(
      event.phase,
      event.point,
      event.frameWidth,
      event.frameHeight,
      event.tool,
      event.replay,
    );
  };

  const showDevices = wide ? !fillWindow && !gridView : devicesOpen;
  const dockedScreens = wide && !fillWindow && !gridView;
  const screenSheet = screensOpen && !dockedScreens && wide && !gridView;
  const mobileControl = !wide && section === "control";
  // Mobile Control collapses the desk header into the floating Desk menu.
  const showHeader = section !== "control" || (wide && !fillWindow);
  useVisualViewportLock(true);

  return (
    <DeskProvider
      value={{
        section,
        focusTool,
        devices,
        activeDevice,
        targets: broadcastTargets,
        sessions,
        lastSeen,
        open,
        selectDevice,
      }}
    >
    <div
      className="pc-shell fixed flex flex-col overflow-hidden"
      data-ui-build="pc-shell-v27"
    >
      <div className="pc-atmosphere" aria-hidden />
      {showHeader && (
        <ControlHeader
          onlineCount={onlineCount}
          totalCount={devices.length}
          section={section}
          onSection={(next) => open(next)}
        />
      )}

      <main
        className={cn(
          "relative z-10 flex min-h-0 flex-1 flex-col overflow-hidden",
          section !== "control"
            ? "px-3 py-2 lg:px-4 lg:py-3"
            : !fillWindow && !mobileControl && "px-2 py-2 lg:px-4 lg:py-3",
        )}
      >
        {loading && (
          <div className="flex flex-1 items-center justify-center font-mono text-sm text-[var(--pc-muted)]">
            Loading devices…
          </div>
        )}

        {!loading && section !== "control" && (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {section === "manage" && <ManagePanel />}
            {section === "apps" && <AppsPanel />}
            {section === "files" && <FilesPanel />}
            {section === "automate" && <AutomatePanel />}
            {section === "developer" && <DeveloperPanel />}
            {section === "hosts" && <HostsPanel />}
          </div>
        )}

        {!loading && section === "control" && (
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
                devices={devices}
                session={activeSession}
                keyboardOn={keyboardOn}
                mouseOn={mouseOn}
                fillWindow={fillWindow}
                floatingChrome={mobileControl}
                gridView={gridView}
                statsMode={mobileStatsMode}
                onStatsModeChange={setMobileStatsMode}
                onFillWindowChange={setFill}
                onToggleGrid={() => setGridView((open) => !open)}
                onFocusDevice={(deviceId) => {
                  selectDevice({
                    deviceId,
                    ctrlKey: false,
                    shiftKey: false,
                    metaKey: false,
                  });
                  setGridView(false);
                }}
                showDevicesButton={!fillWindow && !wide}
                onOpenDevices={() => {
                  setScreensOpen(false);
                  setDevicesOpen(true);
                }}
                showScreensButton={!dockedScreens && wide && !gridView}
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
                role={!wide ? "dialog" : undefined}
                aria-modal={!wide ? true : undefined}
                aria-label={!wide ? "Devices" : undefined}
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
                  onToggleSelected={toggleSelected}
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
              <div
                role="dialog"
                aria-modal="true"
                aria-label="Screens"
                className="absolute inset-0 z-40 flex flex-col gap-3 overflow-hidden bg-[var(--pc-paper)] p-3"
              >
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

      {section === "control" && wide && (
        <StatusBar
          device={activeDevice}
          session={activeSession}
          stats={streamStats}
          safeBottom
          className="justify-start"
        />
      )}
    </div>
    </DeskProvider>
  );
}
