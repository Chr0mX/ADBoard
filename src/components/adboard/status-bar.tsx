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
  /** Scroll the line across on a phone-width screen (the long bar under the phone). */
  marquee?: boolean;
  className?: string;
}

function StatFields({ fields, tagged }: { fields: ReturnType<typeof streamStatFields>; tagged: boolean }) {
  // The scrolling copy has no data-* hooks, so tests and tools see each stat once.
  const tag = (name: string) => (tagged ? { [name]: true } : {});
  return (
    <>
      <span>{fields.size}</span>
      <span {...tag("data-battery")}>{fields.battery}</span>
      <span {...tag("data-temperature")}>{fields.temperature}</span>
      {fields.cpu ? <span {...tag("data-cpu")}>{fields.cpu}</span> : null}
      {fields.memory ? <span {...tag("data-memory")}>{fields.memory}</span> : null}
      <span>{fields.fps}</span>
      <span>{fields.rate}</span>
      <span>{fields.codec}</span>
      {fields.problem ? <span>{fields.problem}</span> : null}
    </>
  );
}

/**
 * Compact one-line stats used under grid tiles and the desktop footer. With
 * `marquee`, a phone-width screen (under 640px) scrolls the line across; at
 * wider widths it is the same static line as without (see `.pc-stats-*` in
 * globals.css).
 */
export function StatsLine({
  device,
  session,
  stats,
  className,
  marquee = false,
}: {
  device: Device;
  session?: SessionStatus | null;
  stats?: StreamStats | null;
  className?: string;
  marquee?: boolean;
}) {
  const fields = streamStatFields(device, session, stats);

  return (
    <p
      className={cn(
        "flex items-center gap-x-2 overflow-x-auto whitespace-nowrap font-mono text-[11px] leading-4 text-[var(--pc-ink)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        marquee && "pc-stats-host",
        className,
      )}
    >
      {marquee ? (
        <span className="pc-stats-track">
          <span className="pc-stats-set">
            <StatFields fields={fields} tagged />
          </span>
          <span className="pc-stats-set pc-stats-dup" aria-hidden>
            <StatFields fields={fields} tagged={false} />
          </span>
        </span>
      ) : (
        <StatFields fields={fields} tagged />
      )}
    </p>
  );
}

export function StatusBar({
  device,
  session,
  stats,
  safeBottom = false,
  compact = false,
  marquee = false,
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
      <StatsLine device={device} session={session} stats={stats} marquee={marquee} />
    </footer>
  );
}
