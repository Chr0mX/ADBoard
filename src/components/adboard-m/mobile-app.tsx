"use client";

import { useEffect, useRef, useState } from "react";
import { ControlModes } from "@/components/adboard/control-modes";
import { DeviceGrid } from "@/components/adboard/device-grid";
import { PhoneScreen } from "@/components/adboard/phone-screen";
import { MultiDeviceToolbar } from "@/components/adboard/multi-device-toolbar";
import { TouchDiagnostics } from "@/components/adboard/touch-diagnostics";
import { useAgentSessionInfo } from "@/components/adboard/sign-in-gate";
import { AppsPanel } from "@/components/adboard/desk/apps-panel";
import { AutomatePanel } from "@/components/adboard/desk/automate-panel";
import { DeveloperPanel } from "@/components/adboard/desk/developer-panel";
import { EventsPanel } from "@/components/adboard/desk/events-panel";
import { FilesPanel } from "@/components/adboard/desk/files-panel";
import { HostsPanel } from "@/components/adboard/desk/hosts-panel";
import { ManagePanel } from "@/components/adboard/desk/manage-panel";
import { SettingsPanel } from "@/components/adboard/desk/settings-panel";
import { StoragePanel } from "@/components/adboard/desk/storage-panel";
import { MacrosPanel } from "@/components/adboard/macros/macros-panel";
import { MacroDock } from "@/components/adboard/macros/macro-dock";
import { DESK_SECTIONS, DeskProvider, asSection, type DeskSection } from "@/components/adboard/desk/desk-context";
import { BottomSheet } from "@/components/adboard-m/bottom-sheet";
import { MobileNav, tabOf, type MobileTab } from "@/components/adboard-m/mobile-nav";
import { useADBoard } from "@/hooks/use-adboard";
import { useClipboardSync } from "@/hooks/use-clipboard-sync";
import { useStoredFlag, useStoredString } from "@/hooks/use-stored-flag";
import { useVisualViewportLock } from "@/hooks/use-visual-viewport-lock";
import { useEventAlerts } from "@/lib/events/client";
import { useMacroAutomation } from "@/lib/macro/automation-store";
import { documentTitle } from "@/lib/ui/document-title";
import { parseMobileStatsMode, type MobileStatsMode } from "@/lib/ui/mobile-stats-mode";

/** Layout state of the mobile app. Own keys: the desktop app never sees them. */
export const MOBILE_KEYS = {
  section: "adboard-m-section",
  macroDock: "adboard-m-macro-dock",
  gridView: "adboard-m-grid-view",
} as const;

/** The sections reached from "More" (Control, Macros and Phones have tabs). */
const MORE_SECTIONS = DESK_SECTIONS.filter((item) => item.id !== "control" && item.id !== "macros");

/**
 * ADBoard Mobile: one phone-first UI for the browser and the installed app
 * (it never checks whether it is installed). Control is the full-screen phone; every
 * other section sits between a slim header and the bottom navigation. All
 * device state, video and macro logic is the same code the desktop uses.
 */
export function MobileApp() {
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
  } = useADBoard();
  useClipboardSync({ targets: broadcastTargets, mode: controlMode });
  useMacroAutomation(devices);
  useVisualViewportLock(true);

  const session = useAgentSessionInfo();
  const alerts = useEventAlerts();
  const [storedSection, setStoredSection] = useStoredString(MOBILE_KEYS.section);
  const section = asSection(storedSection);
  const [storedMacroDock, setStoredMacroDock] = useStoredString(MOBILE_KEYS.macroDock);
  const macroDockOpen = storedMacroDock === "open";
  const [gridView, setGridView] = useStoredFlag(MOBILE_KEYS.gridView, false);
  const [storedStatsMode, setStoredStatsMode] = useStoredString("adboard-mobile-stats-mode");
  const statsMode = parseMobileStatsMode(storedStatsMode);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
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

  const sectionLabel = DESK_SECTIONS.find((item) => item.id === section)?.label;
  const activeName = activeDevice?.name ?? null;
  useEffect(() => {
    document.title = documentTitle({ section, sectionLabel, gridView, deviceName: activeName });
  }, [section, sectionLabel, gridView, activeName]);

  const open = (next: DeskSection, tool?: string, deviceId?: string) => {
    if (deviceId) selectDevice({ deviceId, ctrlKey: false, shiftKey: false, metaKey: false });
    setFocusTool(tool ?? null);
    setDevicesOpen(false);
    setMoreOpen(false);
    setStoredSection(next);
  };

  const onTab = (tab: MobileTab) => {
    if (tab === "devices") {
      setMoreOpen(false);
      setDevicesOpen(true);
    } else if (tab === "more") {
      setDevicesOpen(false);
      setMoreOpen(true);
    } else {
      open(tab);
    }
  };

  const badge = alerts.unseen;
  const control = section === "control";

  return (
    <DeskProvider
      value={{ section, focusTool, devices, activeDevice, targets: broadcastTargets, sessions, lastSeen, open, selectDevice }}
    >
      <div className="pc-shell fixed flex flex-col overflow-hidden" data-m-app data-ui-build="adboard-m-v1">
        <div className="pc-atmosphere" aria-hidden />
        {!control && (
          <header className="relative z-10 flex shrink-0 items-center gap-2 border-b border-[var(--pc-line)] px-3">
            <h1 className="min-w-0 flex-1 truncate py-2.5 font-display text-base font-bold tracking-tight text-[var(--pc-ink)]" data-m-title>
              {sectionLabel}
            </h1>
            <span
              className={`inline-block size-2 rounded-full ${onlineCount > 0 ? "bg-[var(--pc-signal)]" : "bg-[var(--pc-warn)]"}`}
              aria-hidden
            />
            <span className="font-mono text-xs text-[var(--pc-ink)]">
              {onlineCount}/{devices.length}
            </span>
          </header>
        )}

        <main className="relative z-10 flex min-h-0 flex-1 flex-col overflow-hidden" data-m-section={section}>
          {loading && (
            <div className="flex flex-1 items-center justify-center font-mono text-sm text-[var(--pc-muted)]">Loading devices…</div>
          )}
          {!loading && !control && (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-3 py-2">
              {section === "manage" && <ManagePanel />}
              {section === "apps" && <AppsPanel />}
              {section === "files" && <FilesPanel />}
              {section === "macros" && <MacrosPanel />}
              {section === "automate" && <AutomatePanel />}
              {section === "developer" && <DeveloperPanel />}
              {section === "hosts" && <HostsPanel />}
              {section === "events" && <EventsPanel />}
              {section === "storage" && <StoragePanel />}
              {section === "settings" && <SettingsPanel />}
            </div>
          )}
          <TouchDiagnostics />
          {!loading && control && (
            <>
              {error && <p className="shrink-0 truncate px-3 pt-1 font-mono text-[11px] text-[var(--pc-warn)]">{error}</p>}
              <PhoneScreen
                device={activeDevice}
                devices={devices}
                session={activeSession}
                keyboardOn={keyboardOn}
                mouseOn={mouseOn}
                fillWindow
                floatingChrome
                gridView={gridView}
                statsMode={statsMode}
                onStatsModeChange={(mode: MobileStatsMode) => setStoredStatsMode(mode)}
                onFillWindowChange={() => {}}
                onToggleGrid={() => setGridView(!gridView)}
                onFocusDevice={(deviceId) => {
                  selectDevice({ deviceId, ctrlKey: false, shiftKey: false, metaKey: false });
                  setGridView(false);
                }}
                showDevicesButton
                onOpenDevices={() => setDevicesOpen(true)}
                onKeyboardChange={setKeyboardOn}
                onMouseChange={setMouseOn}
                cursorMode={cursorMode}
                onCursorModeChange={setCursorMode}
                onPointer={async (event) => {
                  await handlePointer(event.phase, event.point, event.frameWidth, event.frameHeight, event.tool, event.replay);
                }}
                controlsDock="bottom"
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
                onMacroDockChange={(next) => {
                  if (next) setDevicesOpen(false);
                  setStoredMacroDock(next ? "open" : "closed");
                }}
              />
            </>
          )}
        </main>

        {!control && <MobileNav active={tabOf(section)} badge={section === "events" ? 0 : badge} onPick={onTab} />}

        {control && macroDockOpen && (
          <BottomSheet title="Macros" full onClose={() => setStoredMacroDock("closed")} dataSheet="macros">
            <MacroDock key={activeDevice?.id ?? "none"} devices={devices} controlTargets={broadcastTargets} activeDevice={activeDevice} />
          </BottomSheet>
        )}

        {devicesOpen && (
          <BottomSheet title="Phones" onClose={() => setDevicesOpen(false)} dataSheet="devices">
            <DeviceGrid
              devices={devices}
              activeId={activeId}
              selectedIds={selectedIds}
              onSelect={(event) => {
                selectDevice(event);
                if (!event.ctrlKey && !event.shiftKey && !event.metaKey) setDevicesOpen(false);
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
          </BottomSheet>
        )}

        {moreOpen && (
          <BottomSheet title="More" onClose={() => setMoreOpen(false)} dataSheet="more">
            <div className="grid grid-cols-2 gap-2">
              {MORE_SECTIONS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  data-m-more={item.id}
                  onClick={() => open(item.id)}
                  className={`relative flex h-12 items-center rounded-xl border px-3 text-left text-sm ${
                    section === item.id
                      ? "border-[var(--pc-accent)] bg-[var(--pc-accent-soft)] text-[var(--pc-ink)]"
                      : "border-[var(--pc-line)] bg-[var(--pc-panel)] text-[var(--pc-ink)]"
                  }`}
                >
                  {item.label}
                  {item.id === "events" && badge > 0 && (
                    <span className="ml-auto inline-flex min-w-5 items-center justify-center rounded-full bg-[var(--pc-warn)] px-1 font-mono text-[11px] font-bold text-[#1a0f08]">
                      {badge}
                    </span>
                  )}
                </button>
              ))}
            </div>
            <div className="flex flex-col gap-2 border-t border-[var(--pc-line)] pt-3">
              {(session.authRequired || session.canSetPassword) && (
                <div className="flex gap-2">
                  <button type="button" className="pc-toggle pc-toggle-md flex-1" onClick={session.openAccount}>
                    {session.authRequired ? session.username ?? "Account" : "Set password"}
                  </button>
                  {session.authRequired && (
                    <button type="button" className="pc-toggle pc-toggle-md flex-1" onClick={session.signOut}>
                      Sign out
                    </button>
                  )}
                </div>
              )}
              {/* A full page load on purpose: the desktop app has its own service worker. */}
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
              <a href="/?desktop=1" data-m-desktop-link className="pc-toggle pc-toggle-md justify-center">
                Open desktop version
              </a>
            </div>
          </BottomSheet>
        )}
      </div>
    </DeskProvider>
  );
}
