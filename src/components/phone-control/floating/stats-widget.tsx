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
        defaultSize={{ width: 148, height: 52 }}
        className={cn(PANEL_WIDTH, "min-w-[9rem]")}
      >
        <p className="px-1.5 py-0.5 font-mono text-[11px] leading-4 text-[var(--pc-muted)]">
          No device
        </p>
      </FloatingPanel>
    );
  }

  const fields = streamStatFields(device, session, stats);

  return (
    <FloatingPanel
      storageKey="pc-float-stats"
      kind="stats"
      defaultSize={{ width: expanded ? 220 : 188, height: expanded ? 168 : 52 }}
      className={cn(PANEL_WIDTH, expanded ? "min-w-[12.5rem]" : "min-w-[10.5rem]")}
    >
      <button
        type="button"
        data-stream-stats
        data-stats-expanded={expanded ? "1" : "0"}
        aria-expanded={expanded}
        aria-label={expanded ? "Collapse stream stats" : "Expand stream stats"}
        className="w-full rounded-[calc(var(--pc-radius-control)-0.125rem)] px-1.5 py-1 text-left transition-colors duration-150 active:bg-[var(--pc-accent-soft)]/50"
        onClick={() => setExpanded((value) => !value)}
      >
        {!expanded ? (
          <p className="font-mono text-[11px] leading-4 tracking-wide text-[var(--pc-ink)]">
            {fields.fps}
            <span className="mx-1 text-[var(--pc-muted)]">·</span>
            {fields.rate}
            <span className="mx-1 text-[var(--pc-muted)]">·</span>
            {fields.battery}
          </p>
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 font-mono text-[11px] leading-4 text-[var(--pc-ink)]">
            <dt className="text-[var(--pc-muted)]">Size</dt>
            <dd className="text-right">{fields.size}</dd>
            <dt className="text-[var(--pc-muted)]">Battery</dt>
            <dd data-battery className="text-right">
              {fields.battery}
            </dd>
            <dt className="text-[var(--pc-muted)]">Temp</dt>
            <dd data-temperature className="text-right">
              {fields.temperature}
            </dd>
            <dt className="text-[var(--pc-muted)]">FPS</dt>
            <dd className="text-right">{fields.fps}</dd>
            <dt className="text-[var(--pc-muted)]">Rate</dt>
            <dd className="text-right">{fields.rate}</dd>
            <dt className="text-[var(--pc-muted)]">Codec</dt>
            <dd className="text-right">{fields.codec}</dd>
            {fields.problem ? (
              <>
                <dt className="text-[var(--pc-muted)]">Note</dt>
                <dd className="text-right text-[var(--pc-warn)]">{fields.problem}</dd>
              </>
            ) : null}
          </dl>
        )}
      </button>
    </FloatingPanel>
  );
}
