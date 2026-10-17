"use client";

import { useStoredFlag, useStoredString } from "@/hooks/use-stored-flag";
import { useTaskbarPins } from "@/hooks/use-taskbar-pins";
import { formatGridLayout, parseGridLayout } from "@/lib/ui/grid-layout";
import { parseMobileStatsMode } from "@/lib/ui/mobile-stats-mode";
import { TASKBAR_TOOL_IDS, TASKBAR_TOOL_LABELS } from "@/lib/ui/taskbar-pins";
import { Switch, SwitchRow } from "@/components/ui/switch";
import { useDesk } from "@/components/phone-control/desk/desk-context";
import { PanelFrame } from "@/components/phone-control/desk/bits";
import { ScrcpyOptions } from "@/components/phone-control/scrcpy-options";
import { useAgentSessionInfo } from "@/components/phone-control/sign-in-gate";
import { Segmented } from "@/components/phone-control/macros/fields";
import { TOUCH_DIAGNOSTICS_KEY } from "@/components/phone-control/touch-diagnostics";
import { InstallOnIphone } from "@/components/phone-control/desk/install-on-iphone";

/**
 * One place for the app's existing settings. Nothing here has its own
 * state: every control reads and writes the same stored value as the
 * control it mirrors (stream options, stats mode, grid arrangement, cursor
 * mode, keyboard, taskbar pins, account), so changes show up everywhere.
 */
export function SettingsPanel() {
  const desk = useDesk();
  const session = useAgentSessionInfo();
  const [statsRaw, setStatsRaw] = useStoredString("phonecontrol-mobile-stats-mode");
  const [layoutRaw, setLayoutRaw] = useStoredString("adboard-grid-layout");
  const [barRaw, setBarRaw] = useStoredString("adboard-grid-bar");
  const [cursorMode, setCursorMode] = useStoredFlag("adboard-cursor-mode", false);
  const [keyboardOn, setKeyboardOn] = useStoredFlag("phonecontrol-keyboard", true);
  const [touchDiagnostics, setTouchDiagnostics] = useStoredFlag(TOUCH_DIAGNOSTICS_KEY, false);
  const { pins, togglePin, resetPins, atLimit } = useTaskbarPins();
  const layout = parseGridLayout(layoutRaw);
  const target = desk.activeDevice ?? desk.targets[0] ?? null;

  return (
    <PanelFrame title="Settings" panel="settings">
      <div className="grid gap-3 lg:grid-cols-2">
        <InstallOnIphone />
        <section className="flex min-w-0 flex-col gap-2 rounded-2xl border border-[var(--pc-line)] bg-[var(--pc-panel)] p-3" data-settings-stream>
          <h3 className="font-display text-sm font-semibold text-[var(--pc-ink)]">Stream</h3>
          <p className="text-xs text-[var(--pc-muted)]">
            Quality, screen size, audio and screen-off for {desk.targets.length > 1 ? `${desk.targets.length} target phones` : target?.name ?? "the selected phone"}.
          </p>
          <ScrcpyOptions targetIds={desk.targets.map((d) => d.id)} serial={target?.serial ?? null} disabled={!target} />
        </section>

        <section className="flex min-w-0 flex-col gap-2 rounded-2xl border border-[var(--pc-line)] bg-[var(--pc-panel)] p-3" data-settings-control>
          <h3 className="font-display text-sm font-semibold text-[var(--pc-ink)]">Control</h3>
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
          <SwitchRow
            label="Cursor mode"
            description="Send clicks and taps as a mouse, so the phone shows a pointer"
            checked={cursorMode}
            onChange={(event) => setCursorMode(event.target.checked)}
            data-settings-cursor
          />
          <Segmented
            label="Stats on phones"
            name="settings-stats-mode"
            value={parseMobileStatsMode(statsRaw)}
            onChange={(mode) => setStatsRaw(mode)}
            options={[
              { id: "float", label: "Floating widget" },
              { id: "bar", label: "Bottom bar" },
            ]}
          />
        </section>

        <section className="flex min-w-0 flex-col gap-2 rounded-2xl border border-[var(--pc-line)] bg-[var(--pc-panel)] p-3" data-settings-grid>
          <h3 className="font-display text-sm font-semibold text-[var(--pc-ink)]">Grid view</h3>
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
        </section>

        <section className="flex min-w-0 flex-col gap-2 rounded-2xl border border-[var(--pc-line)] bg-[var(--pc-panel)] p-3" data-settings-taskbar>
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-display text-sm font-semibold text-[var(--pc-ink)]">Phone taskbar</h3>
            <button type="button" className="pc-toggle pc-toggle-sm" disabled={pins.length === 0} onClick={resetPins}>
              Reset
            </button>
          </div>
          <p className="text-xs text-[var(--pc-muted)]">Tools pinned beside Back / Home / Recent on phones.</p>
          <div className="grid gap-x-3 sm:grid-cols-2">
            {TASKBAR_TOOL_IDS.map((id) => {
              const pinned = pins.includes(id);
              return (
                <label key={id} className="pc-choice-row justify-between" aria-disabled={(!pinned && atLimit) || undefined}>
                  <span>{TASKBAR_TOOL_LABELS[id]}</span>
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
        </section>

        {(session.authRequired || session.canSetPassword) && (
          <section className="flex min-w-0 flex-col gap-2 rounded-2xl border border-[var(--pc-line)] bg-[var(--pc-panel)] p-3" data-settings-account>
            <h3 className="font-display text-sm font-semibold text-[var(--pc-ink)]">Account</h3>
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
          </section>
        )}
      </div>
    </PanelFrame>
  );
}
