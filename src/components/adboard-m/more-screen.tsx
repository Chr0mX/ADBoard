"use client";

import type { ReactNode } from "react";
import {
  Bell,
  ChevronRight,
  Code,
  Folder,
  GalleryHorizontal,
  HardDrive,
  KeyRound,
  LayoutGrid,
  LogOut,
  Monitor,
  PanelBottom,
  Server,
  Settings,
  SquareTerminal,
  Type,
  UserRound,
  Vibrate,
  Volume2,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { DisplayInfo } from "@/components/adboard-m/display-info";
import type { DeskSection } from "@/components/adboard/desk/desk-context";
import type { TextSize } from "@/components/adboard-m/text-size-core";
import type { Severity } from "@/lib/events/client";

/*
 * The More tab: an iOS-style grouped list. Navigation comes first (the work
 * areas, then the system pages), then this phone's preferences, then
 * diagnostics and the account. One plain inset group per section, hairline
 * separators, muted line icons; only Events can call for attention.
 */

const SECTION_ICONS: Record<string, LucideIcon> = {
  manage: Wrench,
  apps: LayoutGrid,
  files: Folder,
  automate: SquareTerminal,
  developer: Code,
  hosts: Server,
  events: Bell,
  storage: HardDrive,
  settings: Settings,
};

/** Work areas first; the system pages below them. */
const WORK = ["manage", "apps", "files", "automate", "developer"];

export interface MoreScreenProps {
  sections: ReadonlyArray<{ id: DeskSection; label: string }>;
  onOpen: (section: DeskSection) => void;
  /** Unseen warnings and errors since the last visit to Events. */
  eventsUnseen: number;
  eventsWorst: Severity | null;
  onCustomizeTaskbar: () => void;
  textSize: TextSize;
  onTextSize: (size: TextSize) => void;
  stripOn: boolean;
  onStrip: (on: boolean) => void;
  haptics: boolean;
  onHaptics: (on: boolean) => void;
  sounds: boolean;
  onSounds: (on: boolean) => void;
  account: {
    show: boolean;
    authRequired: boolean;
    username: string | null | undefined;
    openAccount: () => void;
    signOut: () => void;
  };
}

function Group({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <section className="m-group" aria-label={title}>
      <h2 className="m-group-title">{title}</h2>
      <div className="m-group-body">{children}</div>
      {footer && <p className="m-group-footer">{footer}</p>}
    </section>
  );
}

function RowIcon({ icon: Icon }: { icon: LucideIcon }) {
  return <Icon className="m-row-icon" aria-hidden />;
}

export function MoreScreen(props: MoreScreenProps) {
  const { sections, onOpen, eventsUnseen, eventsWorst } = props;
  const work = sections.filter((item) => WORK.includes(item.id));
  const system = sections.filter((item) => !WORK.includes(item.id));
  const eventsAlert = eventsWorst === "error" || eventsWorst === "critical" ? "error" : "warning";

  const navRow = (item: { id: DeskSection; label: string }) => {
    const unseen = item.id === "events" ? eventsUnseen : 0;
    return (
      <button
        key={item.id}
        type="button"
        data-m-more={item.id}
        className="m-row"
        onClick={() => onOpen(item.id)}
        aria-label={unseen > 0 ? `${item.label}, ${unseen} new ${unseen === 1 ? "problem" : "problems"}` : undefined}
      >
        <RowIcon icon={SECTION_ICONS[item.id] ?? Settings} />
        <span className="m-row-label">{item.label}</span>
        {unseen > 0 && (
          <span className="m-row-value" data-m-events-note>
            {eventsAlert === "error" ? "New errors" : "New warnings"}
          </span>
        )}
        {unseen > 0 && (
          <span className="m-badge" data-m-events-badge={unseen} data-alert={eventsAlert} aria-hidden>
            {unseen > 99 ? "99+" : unseen}
          </span>
        )}
        <ChevronRight className="m-row-chevron" aria-hidden />
      </button>
    );
  };

  const switchRow = (icon: LucideIcon, label: string, hint: string, checked: boolean, onChange: (on: boolean) => void, data: string) => (
    <label className="m-row" data-m-pref={data}>
      <RowIcon icon={icon} />
      <span className="m-row-text">
        <span className="m-row-label">{label}</span>
        <span className="m-row-hint">{hint}</span>
      </span>
      <Switch checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );

  return (
    <div className="m-more" data-m-more-list>
      <Group title="Tools">{work.map(navRow)}</Group>
      <Group title="System">{system.map(navRow)}</Group>

      <Group title="This device" footer="Standard text is larger and keeps pinch zoom on.">
        <button type="button" className="m-row" data-m-taskbar-open onClick={props.onCustomizeTaskbar}>
          <RowIcon icon={PanelBottom} />
          <span className="m-row-label">Customize taskbar</span>
          <ChevronRight className="m-row-chevron" aria-hidden />
        </button>
        {switchRow(GalleryHorizontal, "Phone strip", "Phone chips above the screen on Control", props.stripOn, props.onStrip, "strip")}
        {switchRow(Vibrate, "Haptic feedback", "A short buzz on taps. Android only; iPhone Safari cannot vibrate", props.haptics, props.onHaptics, "haptics")}
        {switchRow(Volume2, "Tap sound", "A quiet click on taps", props.sounds, props.onSounds, "sounds")}
        <div className="m-row m-row-static" data-m-text-size>
          <RowIcon icon={Type} />
          <span className="m-row-label">Text size</span>
          <div className="pc-segmented m-segmented" role="radiogroup" aria-label="Text size">
            {(["compact", "standard"] as const).map((size) => (
              <button
                key={size}
                type="button"
                role="radio"
                aria-checked={props.textSize === size}
                className="pc-segment"
                onClick={() => props.onTextSize(size)}
              >
                {size === "compact" ? "Compact" : "Standard"}
              </button>
            ))}
          </div>
        </div>
      </Group>

      <Group title="Diagnostics">
        <DisplayInfo />
      </Group>

      <Group title={props.account.show ? "Account" : "Desktop"}>
        {props.account.show && (
          <button type="button" className="m-row" onClick={props.account.openAccount} data-m-account>
            <RowIcon icon={props.account.authRequired ? UserRound : KeyRound} />
            <span className="m-row-label">{props.account.authRequired ? props.account.username ?? "Account" : "Set password"}</span>
            <ChevronRight className="m-row-chevron" aria-hidden />
          </button>
        )}
        {/* A full page load on purpose: the desktop app has its own service worker. */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a href="/?desktop=1" data-m-desktop-link className="m-row">
          <RowIcon icon={Monitor} />
          <span className="m-row-label">Open desktop version</span>
          <ChevronRight className="m-row-chevron" aria-hidden />
        </a>
        {props.account.show && props.account.authRequired && (
          <button type="button" className="m-row m-row-danger" onClick={props.account.signOut} data-m-sign-out>
            <LogOut className="m-row-icon" aria-hidden />
            <span className="m-row-label">Sign out</span>
          </button>
        )}
      </Group>
    </div>
  );
}
