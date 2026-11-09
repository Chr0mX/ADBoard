"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { ControlModes } from "@/components/adboard/control-modes";
import { DeviceGrid } from "@/components/adboard/device-grid";
import { PhoneScreen } from "@/components/adboard/phone-screen";
import { MultiDeviceToolbar } from "@/components/adboard/multi-device-toolbar";
import { TouchDiagnostics } from "@/components/adboard/touch-diagnostics";
import { useAgentSessionInfo } from "@/components/adboard/sign-in-gate";
import { AppsPanelMobile } from "@/components/adboard-m/apps-panel-mobile";
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
import { ConnectionBanner } from "@/components/adboard-m/connection-banner";
import { UpdatePrompt } from "@/components/adboard-m/update-prompt";
import { PhoneStrip } from "@/components/adboard-m/phone-strip";
import { PhoneLabels } from "@/components/adboard-m/phone-labels";
import { TaskbarSheet } from "@/components/adboard-m/taskbar-sheet";
import { usePhonePrefs } from "@/components/adboard-m/phone-prefs";
import { useFeedback } from "@/components/adboard-m/feedback";
import { DisplayInfo } from "@/components/adboard-m/display-info";
import { SwitchRow } from "@/components/ui/switch";
import { MobileNav, tabOf, type MobileTab } from "@/components/adboard-m/mobile-nav";
import { MORE_SECTION_IDS, parseMobilePath, pathForSection, sectionOfRoute } from "@/components/adboard-m/routes";
import { useADBoard } from "@/hooks/use-adboard";
import { useClipboardSync } from "@/hooks/use-clipboard-sync";
import { useStoredFlag, useStoredString } from "@/hooks/use-stored-flag";
import { useVisualViewportLock } from "@/hooks/use-visual-viewport-lock";
import { useEventAlerts } from "@/lib/events/client";
import { useMacroAutomation } from "@/lib/macro/automation-store";
import { useMobileTitle } from "@/components/adboard-m/use-mobile-title";
import { parseMobileStatsMode, type MobileStatsMode } from "@/lib/ui/mobile-stats-mode";

/** Layout state of the mobile app. Own keys: the desktop app never sees them. */
export const MOBILE_KEYS = {
  macroDock: "adboard-m-macro-dock",
  gridView: "adboard-m-grid-view",
} as const;

/** The sections reached from "More" (Control, Macros and Phones have tabs). */
const MORE_SECTIONS = DESK_SECTIONS.filter((item) => (MORE_SECTION_IDS as readonly string[]).includes(item.id));

/**
 * ADBoard Mobile: one phone-first UI for the browser and the installed app
 * (it never checks whether it is installed). Control is the full-screen phone; every
 * other section sits between a slim header and the bottom navigation. All
 * device state, video and macro logic is the same code the desktop uses.
 */
export function MobileApp({ children }: { children?: ReactNode }) {
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
  const phones = usePhonePrefs();
  const feedback = useFeedback();
  const [taskbarOpen, setTaskbarOpen] = useState(false);
  const [stripOn, setStripOn] = useStoredFlag("adboard-m-strip", true);
  const pickPhone = (deviceId: string) => {
    feedback.tap();
    selectDevice({ deviceId, ctrlKey: false, shiftKey: false, metaKey: false });
    clearSelected(); // the phone you pick is the one you control
  };
  const selectAllOnline = () => {
    feedback.tap();
    for (const device of devices) if (device.status === "online") toggleSelected(device.id, true);
  };
  const router = useRouter();
  const route = parseMobilePath(usePathname());
  // The desk section on screen. "more" (the list) and "root" show none.
  const section = asSection(sectionOfRoute(route));
  const listOpen = route.view === "more";
  const devicesOpen = route.view === "devices";
  const [storedMacroDock, setStoredMacroDock] = useStoredString(MOBILE_KEYS.macroDock);
  const macroDockOpen = storedMacroDock === "open";
  const [gridView, setGridView] = useStoredFlag(MOBILE_KEYS.gridView, false);
  const [storedStatsMode, setStoredStatsMode] = useStoredString("adboard-mobile-stats-mode");
  const statsMode = parseMobileStatsMode(storedStatsMode);
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
  useMobileTitle({ section, sectionLabel: listOpen ? "More" : sectionLabel, gridView, deviceName: activeName });

  const open = (next: DeskSection, tool?: string, deviceId?: string) => {
    if (deviceId) selectDevice({ deviceId, ctrlKey: false, shiftKey: false, metaKey: false });
    setFocusTool(tool ?? null);
    router.push(pathForSection(next));
  };

  const onTab = (tab: MobileTab) => {
    feedback.tap();
    router.push(tab === "devices" ? "/m/devices/" : tab === "more" ? "/m/more/" : pathForSection(tab));
  };
  const closeDevices = () => router.replace(pathForSection("control"));

  const badge = alerts.unseen;
  // Home Screen icon badge: unseen warnings and errors (where the browser supports it).
  useEffect(() => {
    const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    if (badge > 0) void nav.setAppBadge?.(badge)?.catch(() => {});
    else void nav.clearAppBadge?.()?.catch(() => {});
  }, [badge]);
  const control = route.view === "control" || route.view === "devices";
  const showHeader = !control && route.view !== "root";
  const title = listOpen ? "More" : sectionLabel;

  return (
    <DeskProvider
      value={{ section, focusTool, devices, activeDevice, targets: broadcastTargets, sessions, lastSeen, open, selectDevice }}
    >
      <div className="pc-shell fixed flex flex-col overflow-hidden" data-m-app data-ui-build="adboard-m-v3">
        <div className="pc-atmosphere" aria-hidden />
        {showHeader && (
          <header className="relative z-10 flex shrink-0 items-center gap-1 border-b border-[var(--pc-line)] px-3">
            {route.view === "section" && (
              <button
                type="button"
                data-m-back
                aria-label="Back to More"
                onClick={() => router.push("/m/more/")}
                className="-ml-2 inline-flex size-11 shrink-0 items-center justify-center rounded-xl text-[var(--pc-ink)]"
              >
                <ChevronLeft className="size-5" aria-hidden />
              </button>
            )}
            <h1 className="min-w-0 flex-1 truncate py-2.5 font-display text-base font-bold tracking-tight text-[var(--pc-ink)]" data-m-title>
              {title}
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

        <UpdatePrompt />
        {!loading && <ConnectionBanner error={error} />}

        <main className="relative z-10 flex min-h-0 flex-1 flex-col overflow-hidden" data-m-section={listOpen ? "more" : section}>
          {children}
          {loading && (
            <div className="flex flex-1 items-center justify-center font-mono text-sm text-[var(--pc-muted)]">Loading devices…</div>
          )}
          {!loading && listOpen && (
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3" data-m-more-list>
              <div className="grid grid-cols-2 gap-2">
                {MORE_SECTIONS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    data-m-more={item.id}
                    onClick={() => open(item.id)}
                    className="relative flex h-12 items-center rounded-xl border border-[var(--pc-line)] bg-[var(--pc-panel)] px-3 text-left text-sm text-[var(--pc-ink)]"
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
              <button type="button" data-m-taskbar-open className="pc-toggle pc-toggle-md min-h-11" onClick={() => setTaskbarOpen(true)}>
                Customize taskbar
              </button>
              <SwitchRow label="Phone strip on Control" description="Swipeable phone cards above the screen" checked={stripOn} onChange={(e) => setStripOn(e.target.checked)} />
              <SwitchRow label="Haptic feedback" description="A short buzz on taps (Android; iPhone Safari has no vibration)" checked={feedback.haptics} onChange={(e) => feedback.setHaptics(e.target.checked)} />
              <SwitchRow label="Tap sound" description="A quiet click on taps" checked={feedback.sounds} onChange={(e) => feedback.setSounds(e.target.checked)} />
              <DisplayInfo />
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
            </div>
          )}
          {!loading && !control && !listOpen && route.view !== "root" && (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-3 py-2">
              {section === "manage" && <ManagePanel />}
              {section === "apps" && <AppsPanelMobile />}
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
              {stripOn && (
              <PhoneStrip
                devices={devices}
                activeId={activeId}
                favs={phones.favs}
                notes={phones.notes}
                onPick={pickPhone}
                onSelectAllOnline={selectAllOnline}
              />
              )}
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
                onOpenDevices={() => router.push("/m/devices/")}
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
                  if (next && devicesOpen) closeDevices();
                  setStoredMacroDock(next ? "open" : "closed");
                }}
              />
            </>
          )}
        </main>

        {route.view !== "root" && (
          <MobileNav active={tabOf(route)} badge={route.view === "section" && route.section === "events" ? 0 : badge} onPick={onTab} />
        )}

        {control && macroDockOpen && (
          <BottomSheet title="Macros" full onClose={() => setStoredMacroDock("closed")} dataSheet="macros">
            <MacroDock key={activeDevice?.id ?? "none"} devices={devices} controlTargets={broadcastTargets} activeDevice={activeDevice} />
          </BottomSheet>
        )}

        {devicesOpen && (
          <BottomSheet title="Phones" onClose={closeDevices} dataSheet="devices">
            <PhoneStrip devices={devices} activeId={activeId} favs={phones.favs} notes={phones.notes} onPick={(id) => { pickPhone(id); closeDevices(); }} onlyFavs className="-mx-3" />
            <DeviceGrid
              devices={devices}
              activeId={activeId}
              selectedIds={selectedIds}
              onSelect={(event) => {
                selectDevice(event);
                // A plain tap picks this phone alone: the other ticks are cleared and
                // control goes to it. Ticking boxes still adds more phones.
                if (!event.ctrlKey && !event.shiftKey && !event.metaKey) {
                  clearSelected();
                  closeDevices();
                }
              }}
              onToggleSelected={toggleSelected}
            />
            <PhoneLabels devices={devices} favs={phones.favs} notes={phones.notes} onToggleFav={phones.toggleFav} onNote={phones.setNote} />
            {/* Stays in reach at the bottom of the sheet while the list scrolls. */}
            <div data-m-sheet-actions className="flex flex-col gap-3">
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
            </div>
          </BottomSheet>
        )}
        {taskbarOpen && <TaskbarSheet onClose={() => setTaskbarOpen(false)} />}
      </div>
    </DeskProvider>
  );
}
