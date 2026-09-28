"use client";

interface ControlHeaderProps {
  onlineCount: number;
  totalCount: number;
}

export function ControlHeader({ onlineCount, totalCount }: ControlHeaderProps) {
  return (
    <header className="relative z-10 flex shrink-0 items-center justify-between gap-3 border-b border-[var(--pc-line)] px-4 py-2 sm:px-6">
      <div className="flex min-w-0 items-baseline gap-3">
        <h1 className="font-display text-lg font-bold tracking-tight text-[var(--pc-ink)]">
          Phone Control
        </h1>
        <p className="truncate font-mono text-[10px] uppercase tracking-[0.22em] text-[var(--pc-muted)]">
          PhoneFarm
        </p>
      </div>
      <div className="flex items-center gap-2 rounded-full border border-[var(--pc-line)] bg-[var(--pc-panel)]/80 px-3 py-1.5 backdrop-blur-sm">
        <span
          className={`inline-block h-2 w-2 rounded-full ${
            onlineCount > 0
              ? "bg-[var(--pc-signal)] shadow-[0_0_10px_var(--pc-signal)] animate-pulse"
              : "bg-[var(--pc-warn)]"
          }`}
          aria-hidden
        />
        <span className="font-mono text-xs font-medium tracking-wide text-[var(--pc-ink)]">
          {onlineCount} Devices Online
          <span className="text-[var(--pc-muted)]"> / {totalCount}</span>
        </span>
      </div>
    </header>
  );
}
