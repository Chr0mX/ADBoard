"use client";

interface ControlHeaderProps {
  onlineCount: number;
  totalCount: number;
}

export function ControlHeader({ onlineCount, totalCount }: ControlHeaderProps) {
  return (
    <header className="relative z-10 flex shrink-0 items-center justify-between gap-3 border-b border-[var(--pc-line)] px-3 py-1.5 sm:px-4">
      <h1 className="font-display text-base font-bold tracking-tight text-[var(--pc-ink)]">
        Phone Control
      </h1>
      <div className="flex items-center gap-2">
        <span
          className={`inline-block h-2 w-2 rounded-full ${
            onlineCount > 0 ? "bg-[var(--pc-signal)]" : "bg-[var(--pc-warn)]"
          }`}
          aria-hidden
        />
        <span className="font-mono text-xs text-[var(--pc-ink)]">
          {onlineCount}/{totalCount} online
        </span>
      </div>
    </header>
  );
}
