"use client";

interface ControlHeaderProps {
  onlineCount: number;
  totalCount: number;
}

export function ControlHeader({ onlineCount, totalCount }: ControlHeaderProps) {
  return (
    <header className="relative z-10 flex flex-wrap items-end justify-between gap-4 border-b border-[var(--pc-line)] px-4 py-4 sm:px-6">
      <div className="flex flex-col gap-1">
        <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-[var(--pc-muted)]">
          PhoneFarm · Control Plane
        </p>
        <h1 className="font-display text-3xl font-bold tracking-tight text-[var(--pc-ink)] sm:text-4xl">
          Phone Control
        </h1>
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
