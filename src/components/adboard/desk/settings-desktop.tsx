"use client";

import type { ReactNode } from "react";
import { useStoredString } from "@/hooks/use-stored-flag";
import { cn } from "@/lib/utils";
import { PanelFrame } from "@/components/adboard/desk/bits";
import { useAgentSessionInfo } from "@/components/adboard/sign-in-gate";
import { InstallOnIphone } from "@/components/adboard/desk/install-on-iphone";
import { NotificationsCard } from "@/components/adboard/desk/notifications-card";
import { VirtualDisplayCard } from "@/components/adboard/desk/virtual-display-card";
import { AccountBody, AppearanceBody, ControlBody, GridBody, StreamBody, TaskbarBody, TaskbarReset } from "@/components/adboard/desk/settings-panel";
import { pickCategory, type SettingsCategory } from "@/lib/ui/settings-categories";

/*
 * Desktop Settings: a category list on the left, one category on the right.
 * Every control is the same component the phone layout shows (see
 * settings-panel.tsx), so nothing here has its own state; only the grouping
 * and the frame differ.
 */

const SELECTED_KEY = "adboard-settings-category";

interface Entry {
  id: string;
  label: string;
  group: string;
  title: string;
  blurb: string;
  action?: ReactNode;
  body: ReactNode;
}

export function SettingsDesktop() {
  const session = useAgentSessionInfo();
  const [stored, setStored] = useStoredString(SELECTED_KEY);
  const hasAccount = session.authRequired || session.canSetPassword;

  const entries: Entry[] = [
    { id: "stream", label: "Stream", group: "Phones", title: "Stream", blurb: "Quality, screen size, audio and screen-off for the target phones.", body: <StreamBody /> },
    { id: "virtual", label: "Virtual displays", group: "Phones", title: "Virtual displays", blurb: "Extra Android screens that run their own apps.", body: <VirtualDisplayCard bare /> },
    { id: "control", label: "Control", group: "Controls", title: "Control", blurb: "Keyboard, touch, cursor and the edge tab.", body: <ControlBody /> },
    { id: "grid", label: "Grid view", group: "Controls", title: "Grid view", blurb: "How the phone tiles are arranged.", body: <GridBody /> },
    { id: "taskbar", label: "Phone taskbar", group: "Controls", title: "Phone taskbar", blurb: "Which tools sit beside Back, Home and Recent.", action: <TaskbarReset />, body: <TaskbarBody /> },
    { id: "appearance", label: "Appearance", group: "Look", title: "Appearance", blurb: "Dark or light, the colour theme, and the font used for technical values.", body: <AppearanceBody /> },
    { id: "notifications", label: "Notifications", group: "Alerts and account", title: "Discord notifications", blurb: "Send problems and finished macro runs to a Discord channel.", body: <NotificationsCard bare /> },
    ...(hasAccount
      ? [{ id: "account", label: "Account", group: "Alerts and account", title: "Account", blurb: "Password and sign-in.", body: <AccountBody /> } satisfies Entry]
      : []),
  ];
  const categories: SettingsCategory[] = entries.map(({ id, label, group }) => ({ id, label, group }));
  const current = entries.find((entry) => entry.id === pickCategory(categories, stored)) ?? entries[0];
  const groups = [...new Set(entries.map((entry) => entry.group))];

  return (
    <PanelFrame title="Settings" panel="settings" clean>
      <InstallOnIphone />
      <div className="grid min-h-0 gap-x-8 gap-y-3 lg:grid-cols-[13rem_minmax(0,1fr)]" data-settings-desktop>
        {/* Narrow windows: one select instead of the list. */}
        <select
          className="h-10 rounded-lg border border-[var(--pc-line)] bg-[var(--pc-paper)] px-2 text-sm text-[var(--pc-ink)] lg:hidden"
          aria-label="Settings category"
          value={current.id}
          onChange={(event) => setStored(event.target.value)}
          data-settings-select
        >
          {groups.map((group) => (
            <optgroup key={group} label={group}>
              {entries
                .filter((entry) => entry.group === group)
                .map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>

        <nav aria-label="Settings categories" className="hidden flex-col gap-4 lg:flex" data-settings-nav-list>
          {groups.map((group) => (
            <div key={group} className="flex flex-col gap-0.5">
              <h3 className="px-2 pb-1 text-xs font-medium text-[var(--pc-muted)]">{group}</h3>
              {entries
                .filter((entry) => entry.group === group)
                .map((entry) => {
                  const selected = entry.id === current.id;
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      aria-current={selected ? "page" : undefined}
                      data-settings-category={entry.id}
                      onClick={() => setStored(entry.id)}
                      className={cn(
                        "flex h-9 items-center rounded-md px-2 text-left text-sm",
                        selected
                          ? "bg-[var(--pc-accent-soft)] font-medium text-[var(--pc-ink)]"
                          : "text-[var(--pc-ink)]/85 hover:bg-[var(--pc-accent-soft)]/60",
                      )}
                    >
                      {entry.label}
                    </button>
                  );
                })}
            </div>
          ))}
        </nav>

        <section className="flex min-w-0 max-w-2xl flex-col gap-3" aria-labelledby="settings-title" data-settings-pane={current.id}>
          <header className="flex items-start justify-between gap-3 border-b border-[var(--pc-line)] pb-3">
            <div>
              <h2 id="settings-title" className="font-display text-lg font-semibold text-[var(--pc-ink)]">
                {current.title}
              </h2>
              <p className="text-xs text-[var(--pc-muted)]">{current.blurb}</p>
            </div>
            {current.action}
          </header>
          {current.body}
        </section>
      </div>
    </PanelFrame>
  );
}
