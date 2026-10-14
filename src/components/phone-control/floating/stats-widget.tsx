"use client";

import { useState } from "react";
import type { Device, SessionStatus, StreamStats } from "@/lib/devices/types";
import { FloatingPanel } from "@/components/phone-control/floating/floating-panel";
import { streamStatFields } from "@/lib/ui/stream-stats-format";
import { cn } from "@/lib/utils";

interface StatsWidgetProps {
  device: Device | null;
  session?: SessionStatus | null;
  stats?: StreamStats | null;
}

// max-content width: an absolutely positioned panel otherwise shrink-wraps to
// the space right of its left edge, so near the right edge the chip narrowed
// and clipped the "Stats" label while on the left it stayed full width.
const PANEL_WIDTH = "w-max max-w-[calc(100vw-16px)]";

export function StatsWidget({ device, session, stats }: StatsWidgetProps) {
  const [expanded, setExpanded] = useState(false);

  if (!device) {
    return (
      <FloatingPanel
        storageKey="pc-float-stats"
        kind="stats"
        defaultSize={{ width: 176, height: 56 }}
        className={cn(PANEL_WIDTH, "min-w-[11rem]")}
      >
        <p className="px-1 font-mono text-[11px] text-[var(--pc-muted)]">No device</p>
      </FloatingPanel>
    );
  }

  const fields = streamStatFields(device, session, stats);

  return (
    <FloatingPanel
      storageKey="pc-float-stats"
      kind="stats"
      defaultSize={{ width: expanded ? 208 : 176, height: expanded ? 160 : 56 }}
      className={cn(PANEL_WIDTH, expanded ? "min-w-[13rem]" : "min-w-[11rem]")}
    >
      <button
        type="button"
        data-stream-stats
        data-stats-expanded={expanded ? "1" : "0"}
        aria-expanded={expanded}
        aria-label={expanded ? "Collapse stream stats" : "Expand stream stats"}
        className="w-full rounded-lg px-1 text-left active:bg-[var(--pc-accent-soft)]/40"
        onClick={() => setExpanded((value) => !value)}
      >
        {!expanded ? (
          <p className="font-mono text-[11px] leading-4 text-[var(--pc-ink)]">
            {fields.fps} · {fields.rate} · {fields.battery}
          </p>
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 font-mono text-[11px] leading-4 text-[var(--pc-ink)]">
            <dt className="text-[var(--pc-muted)]">Size</dt>
            <dd>{fields.size}</dd>
            <dt className="text-[var(--pc-muted)]">Battery</dt>
            <dd data-battery>{fields.battery}</dd>
            <dt className="text-[var(--pc-muted)]">Temp</dt>
            <dd data-temperature>{fields.temperature}</dd>
            <dt className="text-[var(--pc-muted)]">FPS</dt>
            <dd>{fields.fps}</dd>
            <dt className="text-[var(--pc-muted)]">Rate</dt>
            <dd>{fields.rate}</dd>
            <dt className="text-[var(--pc-muted)]">Codec</dt>
            <dd>{fields.codec}</dd>
            {fields.problem ? (
              <>
                <dt className="text-[var(--pc-muted)]">Note</dt>
                <dd className="text-[var(--pc-warn)]">{fields.problem}</dd>
              </>
            ) : null}
          </dl>
        )}
      </button>
    </FloatingPanel>
  );
}
