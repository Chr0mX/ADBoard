"use client";

import type { Device, SessionStatus, StreamStats } from "@/lib/devices/types";
import { streamStatFields } from "@/lib/ui/stream-stats-format";
import { cn } from "@/lib/utils";

interface StatusBarProps {
  device: Device | null;
  session?: SessionStatus | null;
  stats?: StreamStats | null;
  /** Pad for the home indicator when this bar is the bottommost chrome. */
  safeBottom?: boolean;
  /** Tighter padding under the mobile stream dock. */
  compact?: boolean;
  className?: string;
}

/** Compact one-line stats used under grid tiles and the desktop footer. */
export function StatsLine({
  device,
  session,
  stats,
  className,
}: {
  device: Device;
  session?: SessionStatus | null;
  stats?: StreamStats | null;
  className?: string;
}) {
  const fields = streamStatFields(device, session, stats);

  return (
    <p
      className={cn(
        "flex items-center gap-x-2 overflow-x-auto whitespace-nowrap font-mono text-[11px] leading-4 text-[var(--pc-ink)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className,
      )}
    >
      <span>{fields.size}</span>
      <span data-battery>{fields.battery}</span>
      <span data-temperature>{fields.temperature}</span>
      {fields.cpu ? <span data-cpu>{fields.cpu}</span> : null}
      {fields.memory ? <span data-memory>{fields.memory}</span> : null}
      <span>{fields.fps}</span>
      <span>{fields.rate}</span>
      <span>{fields.codec}</span>
      {fields.problem ? <span>{fields.problem}</span> : null}
    </p>
  );
}

export function StatusBar({
  device,
  session,
  stats,
  safeBottom = false,
  compact = false,
  className,
}: StatusBarProps) {
  if (!device) {
    return (
      <footer
        data-desktop-stats
        className={cn(
          "flex shrink-0 justify-start border-t border-[var(--pc-line)] bg-[var(--pc-panel)] px-2 font-mono text-[11px] leading-4 text-[var(--pc-muted)]",
          compact ? "py-0.5" : "pt-1",
          safeBottom
            ? "pb-[env(safe-area-inset-bottom,0px)]"
            : compact
              ? "pb-0.5"
              : "pb-1",
          className,
        )}
      >
        No active device
      </footer>
    );
  }

  return (
    <footer
      data-stream-stats
      data-desktop-stats
      className={cn(
        "flex shrink-0 justify-start border-t border-[var(--pc-line)] bg-[var(--pc-panel)] px-2",
        compact ? "py-0.5" : "pt-1",
        safeBottom
          ? "pb-[env(safe-area-inset-bottom,0px)]"
          : compact
            ? "pb-0.5"
            : "pb-1",
        className,
      )}
    >
      <StatsLine device={device} session={session} stats={stats} />
    </footer>
  );
}
