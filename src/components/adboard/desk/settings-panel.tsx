"use client";

import { useStoredFlag, useStoredString } from "@/hooks/use-stored-flag";
import { useTaskbarPins } from "@/hooks/use-taskbar-pins";
import { useTaskbarHidden } from "@/hooks/use-taskbar-hidden";
import { useEdgeTabStyle } from "@/hooks/use-edge-tab-style";
import { formatGridLayout, parseGridLayout } from "@/lib/ui/grid-layout";
import { parseMobileStatsMode } from "@/lib/ui/mobile-stats-mode";
import {
  HIDEABLE_NAV_IDS,
  HIDEABLE_NAV_LABELS,
  moveTaskbarPin,
  TASKBAR_TOOL_IDS,
  TASKBAR_TOOL_LABELS,
  type TaskbarToolId,
} from "@/lib/ui/taskbar-pins";
import { useSyncExternalStore } from "react";
import { Switch, SwitchRow } from "@/components/ui/switch";
import { useDesk } from "@/components/adboard/desk/desk-context";
import { PanelFrame } from "@/components/adboard/desk/bits";
import { ScrcpyOptions } from "@/components/adboard/scrcpy-options";
import { useAgentSessionInfo } from "@/components/adboard/sign-in-gate";
import { TOUCH_DIAGNOSTICS_KEY } from "@/components/adboard/touch-diagnostics";
import { InstallOnIphone } from "@/components/adboard/desk/install-on-iphone";
import { NotificationsCard } from "@/components/adboard/desk/notifications-card";
import { VirtualDisplayCard } from "@/components/adboard/desk/virtual-display-card";

/**
 * One place for the app's existing settings. Nothing here has its own
 * state: every control reads and writes the same stored value as the
 * control it mirrors (stream options, stats mode, grid arrangement, cursor
 * mode, keyboard, taskbar pins, account), so changes show up everywhere.
 */
const CARD = "flex min-w-0 flex-col gap-2 rounded-xl border border-[var(--pc-line)] bg-[var(--pc-panel)] p-4";
const CARD_TITLE = "font-display text-sm font-semibold text-[var(--pc-ink)]";

/** Stream options for the target phones. */
export function StreamBody() {
  const desk = useDesk();
  const target = desk.activeDevice ?? desk.targets[0] ?? null;
  return (
    <>
      <p className="text-xs text-[var(--pc-muted)]">
        Quality, screen size, audio and screen-off for {desk.targets.length > 1 ? `${desk.targets.length} target phones` : target?.name ?? "the selected phone"}.
      </p>
      <ScrcpyOptions targetIds={desk.targets.map((d) => d.id)} serial={target?.serial ?? null} disabled={!target} />
    </>
  );
}

/** Keyboard, touch diagnostics, edge tab, cursor mode, stats line. */
export function ControlBody() {
  const [statsRaw, setStatsRaw] = useStoredString("adboard-mobile-stats-mode");
  const [cursorMode, setCursorMode] = useStoredFlag("adboard-cursor-mode", false);
  const [keyboardOn, setKeyboardOn] = useStoredFlag("adboard-keyboard", true);
  const [edgeTabStyle, setEdgeTabStyle] = useEdgeTabStyle();
  const [touchDiagnostics, setTouchDiagnostics] = useStoredFlag(TOUCH_DIAGNOSTICS_KEY, false);
  return (
    <>
      <SwitchRow
        label="Keyboard injection"
        description="Typing on this computer goes to the target phones"
        checked={keyboardOn}
        onChange={(event) => setKeyboardOn(event.target.checked)}
        data-settings-keyboard
      />
      <SwitchRow
        label="Touch diagnostics"
        description="Marks each tap and shows which control received it (for checking taps on an iPhone)"
        checked={touchDiagnostics}
        onChange={(event) => setTouchDiagnostics(event.target.checked)}
        data-settings-touch-diagnostics
      />
      <div className="flex flex-col gap-1.5 py-1" data-settings-edge-tab>
        <div>
          <p className="text-sm text-[var(--pc-ink)]">Tools and Stats tab at the edge</p>
          <p className="text-xs text-[var(--pc-muted)]">Shown on the screen edge when the panel is hidden</p>
        </div>
        <div className="flex gap-2">
          {(["text", "icons", "both"] as const).map((style) => (
            <button
              key={style}
              type="button"
              className="pc-toggle pc-toggle-sm"
              aria-pressed={edgeTabStyle === style}
              onClick={() => setEdgeTabStyle(style)}
            >
              {style === "text" ? "Text" : style === "icons" ? "Icons" : "Both"}
            </button>
          ))}
        </div>
      </div>
      <SwitchRow
        label="Cursor mode"
        description="Send clicks and taps as a mouse, so the phone shows a pointer"
        checked={cursorMode}
        onChange={(event) => setCursorMode(event.target.checked)}
        data-settings-cursor
      />
      <SwitchRow
        label="Stats on phones"
        description="The stats line under the phone (size, battery, CPU, fps…) scrolls across on a phone screen"
        checked={parseMobileStatsMode(statsRaw) === "show"}
        onChange={(event) => setStatsRaw(event.target.checked ? "show" : "hide")}
        data-settings-stats
      />
    </>
  );
}

/** Grid arrangement and the grid bar. */
export function GridBody() {
  const [layoutRaw, setLayoutRaw] = useStoredString("adboard-grid-layout");
  const [barRaw, setBarRaw] = useStoredString("adboard-grid-bar");
  const layout = parseGridLayout(layoutRaw);
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-[var(--pc-ink)]">
        <span>
          Arrangement: <strong data-settings-arrangement>{layout.mode === "auto" ? "Fit all" : `${layout.cols} × ${layout.rows}`}</strong>
        </span>
        {layout.mode === "fixed" && (
          <button type="button" className="pc-toggle pc-toggle-sm" onClick={() => setLayoutRaw(formatGridLayout({ mode: "auto" }))}>
            Use Fit all
          </button>
        )}
      </div>
      <SwitchRow
        label="Show the grid bar"
        description="Modes, Arrangement and Macro above the tiles"
        checked={barRaw !== "hidden"}
        onChange={(event) => setBarRaw(event.target.checked ? "shown" : "hidden")}
      />
    </>
  );
}

/** The taskbar's Reset button (beside the section title). */
export function TaskbarReset() {
  const { pins, resetPins } = useTaskbarPins();
  return (
    <button type="button" className="pc-toggle pc-toggle-sm" disabled={pins.length === 0} onClick={resetPins}>
      Reset
    </button>
  );
}

/** Pinned tools, which bar buttons show, and their order. */
export function TaskbarBody() {
  const { pins, setPins, togglePin, atLimit } = useTaskbarPins();
  const { hidden: hiddenNav, toggleHidden } = useTaskbarHidden();
  const support = useBrowserSupport();
  const unavailable = (id: TaskbarToolId) =>
    (id === "fullscreen" && !support.fullscreen) || (id === "pip" && !support.pip);
  return (
    <>
      <p className="text-xs text-[var(--pc-muted)]">Tools pinned beside Back / Home / Recent on phones.</p>
      <div className="grid gap-x-3 sm:grid-cols-2">
        {TASKBAR_TOOL_IDS.map((id) => {
          const pinned = pins.includes(id);
          return (
            <label key={id} className="pc-choice-row justify-between" aria-disabled={(!pinned && atLimit) || undefined}>
              <span>
                {TASKBAR_TOOL_LABELS[id]}
                {unavailable(id) && <span className="block text-xs text-[var(--pc-muted)]">Not available in this browser</span>}
              </span>
              <Switch
                checked={pinned}
                disabled={!pinned && atLimit}
                onChange={() => togglePin(id)}
                data-settings-pin={id}
              />
            </label>
          );
        })}
      </div>
      <p className="text-xs text-[var(--pc-muted)]">
        Back, Home, Recent, Volume, Power and Minimize always stay. They are the phone&apos;s own controls and the Tools panel&apos;s fold button, so they can&apos;t be moved or removed.
      </p>
      <div className="flex flex-col gap-1" data-settings-hide-nav>
        <h4 className="font-display text-xs font-semibold text-[var(--pc-ink)]">Show on the bar</h4>
        {HIDEABLE_NAV_IDS.map((id) => (
          <label key={id} className="pc-choice-row justify-between">
            <span>{HIDEABLE_NAV_LABELS[id]}</span>
            <Switch
              checked={!hiddenNav.includes(id)}
              onChange={() => toggleHidden(id)}
              data-settings-nav={id}
            />
          </label>
        ))}
      </div>
      {pins.length > 1 && (
        <div className="flex flex-col gap-1" data-settings-pin-order>
          <h4 className="font-display text-xs font-semibold text-[var(--pc-ink)]">Order (left to right)</h4>
          {pins.map((id, index) => (
            <div key={id} className="flex items-center justify-between gap-2 text-sm text-[var(--pc-ink)]" data-pin-order-row={id}>
              <span>{index + 1}. {TASKBAR_TOOL_LABELS[id]}</span>
              <span className="flex gap-1">
                <button
                  type="button"
                  className="pc-toggle pc-toggle-sm"
                  disabled={index === 0}
                  aria-label={`Move ${TASKBAR_TOOL_LABELS[id]} earlier`}
                  onClick={() => setPins(moveTaskbarPin(pins, id, -1))}
                >
                  Up
                </button>
                <button
                  type="button"
                  className="pc-toggle pc-toggle-sm"
                  disabled={index === pins.length - 1}
                  aria-label={`Move ${TASKBAR_TOOL_LABELS[id]} later`}
                  onClick={() => setPins(moveTaskbarPin(pins, id, 1))}
                >
                  Down
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/** Password and sign-out. */
export function AccountBody() {
  const session = useAgentSessionInfo();
  return (
    <>
      <p className="text-xs text-[var(--pc-muted)]">
        {session.authRequired ? `Signed in as ${session.username ?? "admin"}.` : "No password yet: needed before using ADBoard through a reverse proxy."}
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="pc-toggle pc-toggle-md" onClick={session.openAccount}>
          {session.authRequired ? "Change password" : "Set password"}
        </button>
        {session.authRequired && (
          <button type="button" className="pc-toggle pc-toggle-md" onClick={session.signOut}>
            Sign out
          </button>
        )}
      </div>
    </>
  );
}

/**
 * One place for the app's existing settings. Nothing here has its own
 * state: every control reads and writes the same stored value as the
 * control it mirrors (stream options, stats mode, grid arrangement, cursor
 * mode, keyboard, taskbar pins, account), so changes show up everywhere.
 * This stacked list is the phone layout; the desktop uses SettingsDesktop.
 */
export function SettingsPanel() {
  const session = useAgentSessionInfo();
  return (
    <PanelFrame title="Settings" panel="settings" clean description="Stream quality, keyboard, grid, notifications, account and taskbar.">
      <div className="lg:columns-2 lg:gap-3 [&>*]:mb-3 [&>*]:break-inside-avoid" data-settings-cards>
        <InstallOnIphone />
        <section className={CARD} data-settings-stream>
          <h3 className={CARD_TITLE}>Stream</h3>
          <StreamBody />
        </section>

        <section className={CARD} data-settings-control>
          <h3 className={CARD_TITLE}>Control</h3>
          <ControlBody />
        </section>

        <section className={CARD} data-settings-grid>
          <h3 className={CARD_TITLE}>Grid view</h3>
          <GridBody />
        </section>

        <section className={CARD} data-settings-taskbar>
          <div className="flex items-center justify-between gap-2">
            <h3 className={CARD_TITLE}>Phone taskbar</h3>
            <TaskbarReset />
          </div>
          <TaskbarBody />
        </section>

        <VirtualDisplayCard />

        <NotificationsCard />

        {(session.authRequired || session.canSetPassword) && (
          <section className={CARD} data-settings-account>
            <h3 className={CARD_TITLE}>Account</h3>
            <AccountBody />
          </section>
        )}
      </div>
    </PanelFrame>
  );
}

/** What this browser can do. Read without a setState effect; safe during static prerender. */
const noSubscribe = () => () => {};
const readFullscreen = () => document.fullscreenEnabled === true;
const readPip = () => "pictureInPictureEnabled" in document && document.pictureInPictureEnabled === true;

function useBrowserSupport() {
  const fullscreen = useSyncExternalStore(noSubscribe, readFullscreen, () => true);
  const pip = useSyncExternalStore(noSubscribe, readPip, () => true);
  return { fullscreen, pip };
}
