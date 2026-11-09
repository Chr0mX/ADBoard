"use client";

import { Gamepad2, Layers, MoreHorizontal, Smartphone } from "lucide-react";
import type { MobileRoute } from "@/components/adboard-m/routes";

export type MobileTab = "control" | "devices" | "macros" | "more";

export function tabOf(route: MobileRoute): MobileTab {
  switch (route.view) {
    case "devices":
      return "devices";
    case "macros":
      return "macros";
    case "more":
    case "section":
      return "more";
    default:
      return "control";
  }
}

const TABS: Array<{ id: MobileTab; label: string; icon: typeof Gamepad2 }> = [
  { id: "control", label: "Control", icon: Gamepad2 },
  { id: "devices", label: "Phones", icon: Smartphone },
  { id: "macros", label: "Macros", icon: Layers },
  { id: "more", label: "More", icon: MoreHorizontal },
];

/** Bottom navigation of the mobile app, on every screen including Control. */
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
      className="relative z-10 grid shrink-0 grid-cols-4 border-t border-[var(--pc-line)] bg-[var(--pc-paper)] pb-0"
    >
      {TABS.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          data-m-tab={id}
          aria-current={active === id ? "page" : undefined}
          onClick={() => onPick(id)}
          className={`relative flex h-11 flex-col items-center justify-start gap-px pt-1 text-[10px] leading-3 ${
            active === id ? "text-[var(--pc-accent)]" : "text-[var(--pc-muted)]"
          }`}
        >
          <Icon className="size-[18px]" aria-hidden />
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
