"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useStoredFlag } from "@/hooks/use-stored-flag";

export const TOUCH_DIAGNOSTICS_KEY = "adboard-touch-diagnostics";

interface TapRecord {
  x: number;
  y: number;
  target: string;
  inTaskbar: boolean;
  events: string[];
  at: number;
}

function describe(el: Element | null): string {
  if (!el) return "nothing";
  const button = el.closest("button, [role=button], a, input, select, label");
  const node = button ?? el;
  const label = node.getAttribute("aria-label") || (node.textContent ?? "").trim().slice(0, 24);
  const data = [...node.attributes].find((a) => a.name.startsWith("data-") && a.name !== "data-slot")?.name;
  const panel = node.closest("[data-floating-panel]")?.getAttribute("data-floating-panel");
  return [node.tagName.toLowerCase(), label && `“${label}”`, data, panel && `in ${panel} panel`].filter(Boolean).join(" ");
}

function metrics() {
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:fixed;visibility:hidden;padding:env(safe-area-inset-top,0px) 0 env(safe-area-inset-bottom,0px) 0";
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const safe = `${Math.round(parseFloat(cs.paddingTop))}/${Math.round(parseFloat(cs.paddingBottom))}`;
  probe.remove();
  const vv = window.visualViewport;
  const standalone =
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    window.matchMedia?.("(display-mode: standalone)").matches === true;
  return `inner ${window.innerHeight} · vv ${Math.round(vv?.height ?? 0)}@${Math.round(vv?.offsetTop ?? 0)} · client ${document.documentElement.clientHeight} · safe ${safe} · ${standalone ? "Home Screen app" : "browser tab"}`;
}

const enabledByUrl = () => {
  try {
    return new URLSearchParams(window.location.search).has("touchdebug");
  } catch {
    return false;
  }
};

/**
 * Touch diagnostics (Settings → Control, or ?touchdebug=1): marks every tap
 * and shows which element received it and which events fired, plus the
 * viewport numbers iOS reports. For checking taps on a real iPhone. The layer
 * ignores pointer events, so it never blocks anything itself.
 */
export function TouchDiagnostics() {
  const [stored] = useStoredFlag(TOUCH_DIAGNOSTICS_KEY, false);
  const byUrl = useSyncExternalStore(
    () => () => {},
    enabledByUrl,
    () => false,
  );
  const on = stored || byUrl;
  const [taps, setTaps] = useState<TapRecord[]>([]);
  const [info, setInfo] = useState("");

  useEffect(() => {
    if (!on) return;
    const onDown = (event: PointerEvent) => {
      const target = document.elementFromPoint(event.clientX, event.clientY);
      const record: TapRecord = {
        x: event.clientX,
        y: event.clientY,
        target: describe(target),
        inTaskbar: Boolean(target?.closest("[data-device-nav-bar], [data-mobile-bottom-chrome]")),
        events: [`pointerdown(${event.pointerType})`],
        at: Date.now(),
      };
      setInfo(metrics());
      setTaps((prev) => [record, ...prev].slice(0, 4));
    };
    const onClick = (event: MouseEvent) => {
      setTaps((prev) => {
        if (prev.length === 0) return prev;
        const [first, ...rest] = prev;
        if (Date.now() - first.at > 1500) return prev;
        return [{ ...first, events: [...first.events, `click on ${describe(event.target as Element)}`] }, ...rest];
      });
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("click", onClick, true);
    };
  }, [on]);

  if (!on || typeof document === "undefined") return null;
  return createPortal(
    <div data-touch-diagnostics className="pointer-events-none fixed inset-0 z-[60]">
      {taps.map((tap) => (
        <span
          key={tap.at}
          className="absolute size-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[var(--pc-accent)] bg-[color-mix(in_srgb,var(--pc-accent)_30%,transparent)]"
          style={{ left: tap.x, top: tap.y }}
        />
      ))}
      <div className="absolute left-2 right-2 top-[max(0.5rem,env(safe-area-inset-top))] rounded-xl border border-[var(--pc-line)] bg-[color-mix(in_srgb,var(--pc-panel)_94%,transparent)] p-2 font-mono text-[10px] leading-snug text-[var(--pc-ink)]">
        <p className="text-[var(--pc-muted)]">Touch diagnostics · {info || "tap anywhere"}</p>
        {taps.map((tap) => (
          <p key={tap.at} data-touch-record className="[overflow-wrap:anywhere]">
            ({Math.round(tap.x)},{Math.round(tap.y)}) → {tap.target}
            {tap.inTaskbar ? " [taskbar]" : ""} · {tap.events.join(" → ")}
          </p>
        ))}
      </div>
    </div>,
    document.body,
  );
}
