"use client";

import { useStoredFlag, useStoredString } from "@/hooks/use-stored-flag";
import { useTaskbarPins } from "@/hooks/use-taskbar-pins";
import { useTaskbarHidden } from "@/hooks/use-taskbar-hidden";
import { useEdgeTabStyle } from "@/hooks/use-edge-tab-style";
import {
  MODE_CHOICES,
  parseModeChoice,
  THEME_DARK_KEY,
  THEME_LIGHT_KEY,
  THEME_MODE_KEY,
  type ThemeModeChoice,
} from "@/lib/ui/themes";
import { DARK_THEMES, LIGHT_THEMES, themeFor, type ThemeMeta, type ThemeMode } from "@/lib/ui/themes";
import { DEFAULT_MONO_FONT, MONO_FONTS, MONO_FONT_KEY, MONO_FONT_SAMPLE, parseMonoFont } from "@/lib/ui/mono-fonts";
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
const CARD_TITLE = "t-heading text-[var(--pc-ink)]";

/** Stream options for the target phones. */
export function StreamBody() {
  const desk = useDesk();
  const target = desk.activeDevice ?? desk.targets[0] ?? null;
  return (
    <>
      <p className="text-xs text-[var(--pc-muted)]">
        Quality, screen size, audio and screen-off for {desk.targets.length > 1 ? `${desk.targets.length} target phones` : target?.name ?? "the selected phone"}.
      </p>
      <ScrcpyOptions targetIds={desk.targets.map((d) => d.id)} serial={target?.serial ?? null} disabled={!target} repeat />
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

/** One theme as a swatch: its own page colour, text colour and the accent / status dots. */
function ThemeSwatch({ theme, selected, onSelect }: { theme: ThemeMeta; selected: boolean; onSelect: () => void }) {
  const p = theme.palette;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      data-theme-swatch={theme.id}
      className="flex min-w-0 flex-col gap-1.5 rounded-lg border-2 px-2.5 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--pc-accent)]"
      // The swatch shows the theme's own colours, not the current theme's.
      style={{ background: p.paper, color: p.ink, borderColor: selected ? p.accent : `color-mix(in srgb, ${p.ink} 18%, ${p.paper})` }}
    >
      <span className="flex items-center gap-1" aria-hidden>
        {[p.accent, p.signal, p.warn, p.danger].map((color, i) => (
          <span key={i} className="size-3 rounded-full" style={{ background: color }} />
        ))}
        <span className="ml-auto h-3 w-6 rounded-sm" style={{ background: p.panel, border: `1px solid color-mix(in srgb, ${p.ink} 20%, ${p.paper})` }} />
      </span>
      <span className="truncate text-sm font-medium">{theme.name}</span>
    </button>
  );
}

/** Mode (Dark / Light / System) and the colour theme for each mode. Applies at once. */
export function ThemeBody() {
  const [modeRaw, setModeRaw] = useStoredString(THEME_MODE_KEY);
  const [darkRaw, setDarkRaw] = useStoredString(THEME_DARK_KEY);
  const [lightRaw, setLightRaw] = useStoredString(THEME_LIGHT_KEY);
  const mode = parseModeChoice(modeRaw);
  const pick = (list: ThemeMode, id: string) => {
    if (list === "dark") setDarkRaw(id);
    else setLightRaw(id);
    // Choosing a theme of the other mode shows it, unless the mode follows the system.
    if (mode !== "system" && mode !== list) setModeRaw(list);
  };
  const group = (list: ThemeMode, themes: ReadonlyArray<ThemeMeta>, saved: string | null, label: string) => {
    const current = themeFor(list, saved).id;
    return (
      <div className="flex flex-col gap-1.5" data-settings-theme-list={list}>
        <p className="text-sm text-[var(--pc-ink)]">{label}</p>
        <div role="radiogroup" aria-label={label} className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {themes.map((theme) => (
            <ThemeSwatch key={theme.id} theme={theme} selected={theme.id === current} onSelect={() => pick(list, theme.id)} />
          ))}
        </div>
      </div>
    );
  };
  return (
    <div className="flex flex-col gap-3 py-1" data-settings-theme>
      <div className="flex flex-col gap-1.5" data-settings-theme-mode>
        <div>
          <p className="text-sm text-[var(--pc-ink)]">Theme</p>
          <p className="text-xs text-[var(--pc-muted)]">Dark or light, or follow this device. The same on the desktop page and the phone app.</p>
        </div>
        <div className="pc-segmented" role="radiogroup" aria-label="Theme mode">
          {MODE_CHOICES.map((choice) => (
            <button
              key={choice.id}
              type="button"
              role="radio"
              aria-checked={mode === choice.id}
              className="pc-segment"
              data-theme-mode={choice.id}
              onClick={() => setModeRaw((choice.id satisfies ThemeModeChoice) === "dark" ? null : choice.id)}
            >
              {choice.label}
            </button>
          ))}
        </div>
      </div>
      {group("dark", DARK_THEMES, darkRaw, "Dark theme")}
      {group("light", LIGHT_THEMES, lightRaw, "Light theme")}
    </div>
  );
}

/** The font for technical values (serials, addresses, logs, sizes, fps). */
export function AppearanceBody() {
  const [raw, setRaw] = useStoredString(MONO_FONT_KEY);
  const id = parseMonoFont(raw);
  const current = MONO_FONTS.find((font) => font.id === id);
  return (
    <>
      <ThemeBody />
      <div className="flex flex-col gap-1.5 py-1" data-settings-mono-font>
        <div>
          <p className="text-sm text-[var(--pc-ink)]">Font for technical values</p>
          <p className="text-xs text-[var(--pc-muted)]">
            Serials, addresses, logs, sizes and fps. Headings and the rest of the interface keep their fonts.
          </p>
        </div>
        <select
          value={id}
          onChange={(event) => setRaw(event.target.value === DEFAULT_MONO_FONT ? null : event.target.value)}
          aria-label="Font for technical values"
          data-settings-mono-font-select
          className="h-10 w-full max-w-xs rounded-lg border border-[var(--pc-line)] bg-[var(--pc-paper)] px-2 text-sm text-[var(--pc-ink)]"
        >
          {MONO_FONTS.map((font) => (
            <option key={font.id} value={font.id}>
              {font.label}
              {font.id === DEFAULT_MONO_FONT ? " (default)" : ""}
            </option>
          ))}
        </select>
        <p className="t-tech truncate rounded-lg border border-[var(--pc-line)] bg-[var(--pc-paper)] px-3 py-2 text-[var(--pc-ink)]" data-settings-mono-font-sample>
          {MONO_FONT_SAMPLE}
        </p>
        {current?.kind === "system" && (
          <p className="text-xs text-[var(--pc-muted)]">
            This font comes from the device. If it is not installed here, the device&apos;s own monospace font is used.
          </p>
        )}
      </div>
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
        <h4 className="t-label text-[var(--pc-ink)]">Show on the bar</h4>
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
          <h4 className="t-label text-[var(--pc-ink)]">Order (left to right)</h4>
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

        <section className={CARD} data-settings-appearance>
          <h3 className={CARD_TITLE}>Appearance</h3>
          <AppearanceBody />
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
