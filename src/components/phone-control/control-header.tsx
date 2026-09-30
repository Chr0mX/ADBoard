"use client";

import { DESK_SECTIONS, type DeskSection } from "@/components/phone-control/desk/desk-context";

interface ControlHeaderProps {
  onlineCount: number;
  totalCount: number;
  section: DeskSection;
  onSection: (section: DeskSection) => void;
}

export function ControlHeader({ onlineCount, totalCount, section, onSection }: ControlHeaderProps) {
  return (
    <header className="relative z-10 flex shrink-0 flex-nowrap items-center gap-2 border-b border-[var(--pc-line)] px-3 py-1.5 sm:px-4">
      <h1 className="shrink-0 font-display text-base font-bold tracking-tight text-[var(--pc-ink)]">
        <span className="sm:hidden">PC</span>
        <span className="hidden sm:inline">Phone Control</span>
      </h1>

      {/* ~390px: native select — no horizontal scroll for seven sections */}
      <label className="min-w-0 flex-1 sm:hidden">
        <span className="sr-only">Section</span>
        <select
          data-section-select
          aria-label="Sections"
          value={section}
          onChange={(event) => onSection(event.target.value as DeskSection)}
          className="h-11 w-full min-w-0 rounded-xl border border-[var(--pc-line)] bg-[var(--pc-panel)] px-2.5 text-sm text-[var(--pc-ink)]"
        >
          {DESK_SECTIONS.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </label>

      <nav
        aria-label="Sections"
        className="hidden min-w-0 flex-1 gap-1 overflow-x-auto sm:flex"
      >
        {DESK_SECTIONS.map((item) => (
          <button
            key={item.id}
            type="button"
            data-section-tab={item.id}
            aria-current={section === item.id ? "page" : undefined}
            className={`inline-flex h-11 shrink-0 items-center justify-center rounded-xl px-2.5 text-sm leading-5 ${
              section === item.id
                ? "bg-[var(--pc-accent-fill)] text-white"
                : "text-[var(--pc-ink)] hover:bg-[var(--pc-accent-soft)]"
            }`}
            onClick={() => onSection(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className="flex shrink-0 items-center gap-2">
        <span
          className={`inline-block h-2 w-2 rounded-full ${
            onlineCount > 0 ? "bg-[var(--pc-signal)]" : "bg-[var(--pc-warn)]"
          }`}
          aria-hidden
        />
        <span className="font-mono text-xs text-[var(--pc-ink)]">
          <span className="sm:hidden">
            {onlineCount}/{totalCount}
          </span>
          <span className="hidden sm:inline">
            {onlineCount}/{totalCount} online
          </span>
        </span>
      </div>
    </header>
  );
}
