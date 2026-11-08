"use client";

import { Gamepad2, Layers, MoreHorizontal, Smartphone } from "lucide-react";
import type { DeskSection } from "@/components/adboard/desk/desk-context";

export type MobileTab = "control" | "devices" | "macros" | "more";

export function tabOf(section: DeskSection): MobileTab {
  return section === "control" ? "control" : section === "macros" ? "macros" : "more";
}

const TABS: Array<{ id: MobileTab; label: string; icon: typeof Gamepad2 }> = [
  { id: "control", label: "Control", icon: Gamepad2 },
  { id: "devices", label: "Phones", icon: Smartphone },
  { id: "macros", label: "Macros", icon: Layers },
  { id: "more", label: "More", icon: MoreHorizontal },
];

/** Bottom navigation of the mobile app (desk sections; Control is full screen). */
export function MobileNav({
  active,
  badge,
  onPick,
}: {
  active: MobileTab;
  badge: number;
  onPick: (tab: MobileTab) => void;
}) {
  return (
    <nav
      aria-label="Main"
      data-m-nav
      className="relative z-10 grid shrink-0 grid-cols-4 border-t border-[var(--pc-line)] bg-[var(--pc-paper)] pb-[env(safe-area-inset-bottom)]"
    >
      {TABS.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          data-m-tab={id}
          aria-current={active === id ? "page" : undefined}
          onClick={() => onPick(id)}
          className={`relative flex h-14 flex-col items-center justify-center gap-0.5 text-[11px] ${
            active === id ? "text-[var(--pc-accent)]" : "text-[var(--pc-muted)]"
          }`}
        >
          <Icon className="size-5" aria-hidden />
          {label}
          {id === "more" && badge > 0 && (
            <span
              data-m-badge={badge}
              className="absolute top-1.5 left-1/2 ml-2 inline-flex min-w-4 items-center justify-center rounded-full bg-[var(--pc-warn)] px-1 font-mono text-[10px] font-bold text-[#1a0f08]"
            >
              {badge}
            </span>
          )}
        </button>
      ))}
    </nav>
  );
}
