"use client";

import { createPortal } from "react-dom";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { StreamStats } from "@/lib/devices/types";
import { ControlHeader } from "@/components/phone-control/control-header";
import { ControlModes } from "@/components/phone-control/control-modes";
import { DeviceGrid } from "@/components/phone-control/device-grid";
import { PhoneScreen } from "@/components/phone-control/phone-screen";
import { ScreenGrid } from "@/components/phone-control/screen-grid";
import { StatusBar } from "@/components/phone-control/status-bar";
import { AppsPanel } from "@/components/phone-control/desk/apps-panel";
import { AutomatePanel } from "@/components/phone-control/desk/automate-panel";
import { MacrosPanel } from "@/components/phone-control/macros/macros-panel";
import { MacroDock } from "@/components/phone-control/macros/macro-dock";
import { MultiDeviceToolbar } from "@/components/phone-control/multi-device-toolbar";
import { SettingsPanel } from "@/components/phone-control/desk/settings-panel";
import {
  DESK_SECTIONS,
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
import { useDesktopShortcuts, useShortcutHint } from "@/hooks/use-desktop-shortcuts";
import { useStoredFlag, useStoredString } from "@/hooks/use-stored-flag";
import { useVisualViewportLock } from "@/hooks/use-visual-viewport-lock";
import { documentTitle } from "@/lib/ui/document-title";
import { parseMobileStatsMode, type MobileStatsMode } from "@/lib/ui/mobile-stats-mode";
import { cn } from "@/lib/utils";
import { useClipboardSync } from "@/hooks/use-clipboard-sync";
import { useMacroAutomation } from "@/lib/macro/automation-store";
import { TouchDiagnostics } from "@/components/phone-control/touch-diagnostics";

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
    cursorMode,
    setCursorMode,
    selectDevice,
    toggleSelected,
    selectAll,
    clearSelected,
    selectGroup,
    broadcastTargets,
    handlePointer,
    handleNav,
    handleInstall,
    lastTap,
    sessions,
  } = usePhoneControl();
  useClipboardSync({ targets: broadcastTargets, mode: controlMode });
  // Macro scheduler tick + device list for the task queue.
  useMacroAutomation(devices);

  const [storedFillWindow, setFillWindow] = useStoredFlag("phonecontrol-fill-window", false);
  const wide = useSyncExternalStore(
    subscribeWide,
    () => window.matchMedia("(min-width: 1024px)").matches,
    () => false,
  );
  // Mobile always fills; Fill toggle stays desktop-only.
  const fillWindow = wide ? storedFillWindow : true;
  const [devicesOpen, setDevicesOpen] = useState(false);
  // Macros panel in Control: right side on desktop, a sheet on phones.
  const [storedMacroDock, setStoredMacroDock] = useStoredString("adboard-macro-dock");
  const macroDockOpen = storedMacroDock === "open";
  const setMacroDockOpen = (open: boolean) => setStoredMacroDock(open ? "open" : "closed");
  // Desktop side panels fold to a thin rail so the phone gets the width.
  const [screensCollapsed, setScreensCollapsed] = useStoredFlag("phonecontrol-screens-collapsed", false);
  const [devicesCollapsed, setDevicesCollapsed] = useStoredFlag("phonecontrol-devices-collapsed", false);
  const [screensOpen, setScreensOpen] = useState(false);
  const [gridView, setGridView] = useStoredFlag("phonecontrol-grid-view", false);

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

  const macroDockSide = macroDockOpen && wide && !fillWindow;
  const macroSheet = macroDockOpen && !wide;
  const showDevices = wide ? !fillWindow && !gridView && !macroDockSide : devicesOpen && !macroSheet;
  const dockedScreens = wide && !fillWindow && !gridView;
  const screenSheet = screensOpen && !dockedScreens && wide && !gridView;
  const mobileControl = !wide && section === "control";
  // Mobile Control collapses the desk header into the floating Desk menu.
  const showHeader = section !== "control" || (wide && !fillWindow);
  useVisualViewportLock(true);

  const sidePanels = dockedScreens && section === "control";
  const hint = useShortcutHint();
  useDesktopShortcuts(sidePanels, {
    screens: () => setScreensCollapsed(!screensCollapsed),
    devices: () => setDevicesCollapsed(!devicesCollapsed),
  });

  const activeName = activeDevice?.name ?? null;
  const sectionLabel = DESK_SECTIONS.find((item) => item.id === section)?.label;
  useEffect(() => {
    document.title = documentTitle({ section, sectionLabel, gridView, deviceName: activeName });
  }, [section, sectionLabel, gridView, activeName]);

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
      data-ui-build="pc-shell-v45"
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
            {section === "macros" && <MacrosPanel />}
            {section === "automate" && <AutomatePanel />}
            {section === "developer" && <DeveloperPanel />}
            {section === "hosts" && <HostsPanel />}
            {section === "settings" && <SettingsPanel />}
          </div>
        )}

        <TouchDiagnostics />
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
            {dockedScreens && screensCollapsed && (
              <PanelRail
                side="left"
                label="Screens"
                count={onlineCount}
                onExpand={() => setScreensCollapsed(false)}
                hintProps={hint("Show screens", "screens")}
              />
            )}
            {dockedScreens && !screensCollapsed && (
              <aside
                data-side-panel="screens"
                className="flex min-h-0 w-[200px] shrink-0 flex-col gap-2 xl:w-[240px]"
              >
                <PanelHeader
                  title="Screens"
                  side="left"
                  onCollapse={() => setScreensCollapsed(true)}
                  hintProps={hint("Hide screens", "screens")}
                />
                <ScreenGrid
                  devices={devices}
                  activeId={activeId}
                  showHeading={false}
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
                onToggleGrid={() => setGridView(!gridView)}
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
                cursorMode={cursorMode}
                onCursorModeChange={setCursorMode}
                onPointer={onPointer}
                onStats={setStreamStats}
                controlsDock={
                  dockedScreens && devicesCollapsed && !macroDockSide
                    ? "right"
                    : dockedScreens && screensCollapsed
                      ? "left"
                      : "bottom"
                }
                onNav={handleNav}
                onInstall={handleInstall}
                lastTap={lastTap}
                broadcastLabel={`${broadcastTargets.length} target${broadcastTargets.length === 1 ? "" : "s"}`}
                targetIds={broadcastTargets.map((device) => device.id)}
                controlMode={controlMode}
                onControlModeChange={setControlMode}
                selectedIds={selectedIds}
                onToggleSelected={toggleSelected}
                broadcastTargets={broadcastTargets}
                macroDockOpen={macroDockOpen}
                onMacroDockChange={(open) => {
                  if (open) setDevicesOpen(false);
                  setMacroDockOpen(open);
                }}
              />
            </div>

            {macroDockSide && (
              <aside
                data-side-panel="macros"
                className="flex min-h-0 w-[320px] shrink-0 flex-col gap-3 overflow-y-auto pb-2 xl:w-[360px]"
              >
                <PanelHeader title="Macros" side="right" onCollapse={() => setMacroDockOpen(false)} />
                <MacroDock devices={devices} controlTargets={broadcastTargets} activeDevice={activeDevice} />
              </aside>
            )}
            {macroSheet &&
              // Portal: sits above the mobile floating controls (fixed, z-20 on body).
              createPortal(
              <aside
                role="dialog"
                aria-modal="true"
                aria-label="Macros"
                data-macro-sheet
                className="fixed inset-0 z-40 flex flex-col gap-3 overflow-y-auto bg-[var(--pc-paper)] p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-[max(0.75rem,env(safe-area-inset-top))]"
              >
                <div className="flex items-center justify-between gap-2">
                  <h2 className="font-display text-base font-semibold text-[var(--pc-ink)]">Macros</h2>
                  <Button type="button" variant="outline" className="h-11 min-w-11" onClick={() => setMacroDockOpen(false)}>
                    Close
                  </Button>
                </div>
                <MacroDock devices={devices} controlTargets={broadcastTargets} activeDevice={activeDevice} />
              </aside>,
              document.body,
            )}

            {showDevices && wide && devicesCollapsed && (
              <PanelRail
                side="right"
                label="Devices"
                count={devices.length}
                onExpand={() => setDevicesCollapsed(false)}
                hintProps={hint("Show devices", "devices")}
              />
            )}
            {showDevices && !(wide && devicesCollapsed) && (
              <aside
                data-side-panel={wide ? "devices" : undefined}
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
                {wide && (
                  <PanelHeader
                    title="Devices"
                    side="right"
                    onCollapse={() => setDevicesCollapsed(true)}
                    hintProps={hint("Hide devices", "devices")}
                  />
                )}
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
                  hostsHeadingOnly={wide}
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
                <MultiDeviceToolbar
                  devices={devices}
                  selectedIds={selectedIds}
                  controlMode={controlMode}
                  targets={broadcastTargets}
                  onSelectAll={selectAll}
                  onClear={clearSelected}
                  onSelectGroup={selectGroup}
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

type HintProps = { title: string; "aria-keyshortcuts": string };

function PanelHeader({
  title,
  side,
  onCollapse,
  hintProps,
}: {
  title: string;
  side: "left" | "right";
  onCollapse: () => void;
  hintProps?: HintProps;
}) {
  const icon: ReactNode =
    side === "left" ? <ChevronLeft className="size-4" /> : <ChevronRight className="size-4" />;
  return (
    <div className="flex shrink-0 items-center justify-between gap-2">
      <h2 className="font-display text-sm font-semibold tracking-wide text-[var(--pc-ink)]">
        {title}
      </h2>
      <Button
        type="button"
        variant="ghost"
        onClick={onCollapse}
        aria-label={`Hide ${title.toLowerCase()}`}
        aria-expanded
        {...hintProps}
        data-panel-collapse={title.toLowerCase()}
        className="h-11 w-11 min-w-11 rounded-xl text-[var(--pc-muted)] hover:bg-[var(--pc-accent-soft)] hover:text-[var(--pc-ink)]"
      >
        {icon}
      </Button>
    </div>
  );
}

/** Folded side panel: one tall button that reopens it. */
function PanelRail({
  side,
  label,
  count,
  onExpand,
  hintProps,
}: {
  side: "left" | "right";
  label: string;
  count: number;
  onExpand: () => void;
  hintProps: HintProps;
}) {
  return (
    <aside data-side-rail={label.toLowerCase()} className="flex min-h-0 w-12 shrink-0 flex-col">
      <button
        type="button"
        onClick={onExpand}
        aria-label={`Show ${label.toLowerCase()}`}
        aria-expanded={false}
        {...hintProps}
        className="flex min-h-0 flex-1 flex-col items-center gap-3 rounded-xl border border-[var(--pc-line)] bg-[var(--pc-panel)]/70 py-3 text-[var(--pc-muted)] hover:bg-[var(--pc-accent-soft)] hover:text-[var(--pc-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pc-accent)]"
      >
        {side === "left" ? <ChevronRight className="size-4" /> : <ChevronLeft className="size-4" />}
        <span className="font-mono text-[11px] tracking-wider [writing-mode:vertical-rl]">
          {label}
        </span>
        <span className="font-mono text-[10px] text-[var(--pc-ink)]">{count}</span>
      </button>
    </aside>
  );
}
