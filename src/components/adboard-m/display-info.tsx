"use client";

import { useEffect, useRef, useState } from "react";
import { readStandalone } from "@/lib/pwa/standalone";

interface Info {
  inner: string;
  vv: string;
  client: string;
  screenH: string;
  safe: string;
  units: string;
  shell: string;
  nav: string;
  mode: string;
}

/** A px-length probe: resolves CSS units (lvh, dvh, svh, env()) to pixels. */
function probe(css: string): number {
  const el = document.createElement("div");
  el.style.cssText = `position:fixed;left:0;top:0;width:0;visibility:hidden;pointer-events:none;height:${css}`;
  document.body.appendChild(el);
  const h = el.getBoundingClientRect().height;
  el.remove();
  return Math.round(h);
}

function read(): Info {
  const vv = window.visualViewport;
  const shell = document.querySelector("[data-m-app]")?.getBoundingClientRect();
  const nav = document.querySelector("[data-m-nav]")?.getBoundingClientRect();
  const r = (n?: number) => (n == null ? "-" : String(Math.round(n)));
  return {
    inner: `${window.innerWidth}×${window.innerHeight}`,
    vv: `${r(vv?.width)}×${r(vv?.height)} @${r(vv?.offsetTop)}`,
    client: `${document.documentElement.clientWidth}×${document.documentElement.clientHeight}`,
    screenH: `${window.screen.width}×${window.screen.height}`,
    safe: `top ${probe("env(safe-area-inset-top,0px)")} · bottom ${probe("env(safe-area-inset-bottom,0px)")}`,
    units: `100svh ${probe("100svh")} · 100dvh ${probe("100dvh")} · 100lvh ${probe("100lvh")} · 100vh ${probe("100vh")}`,
    shell: `top ${r(shell?.top)} · bottom ${r(shell?.bottom)}`,
    nav: `top ${r(nav?.top)} · bottom ${r(nav?.bottom)}`,
    mode: readStandalone() ? "Home Screen app" : "browser tab",
  };
}

/** Live display numbers, for checking how the screen is measured on a phone. */
export function DisplayInfo() {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<Info | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!open) return;
    const tick = () => setInfo(read());
    tick();
    timer.current = window.setInterval(tick, 700);
    return () => window.clearInterval(timer.current);
  }, [open]);
  return (
    <details data-m-display-info onToggle={(event) => setOpen(event.currentTarget.open)} className="rounded-xl border border-[var(--pc-line)] bg-[var(--pc-panel)]">
      <summary className="flex min-h-11 cursor-pointer items-center px-3 text-sm text-[var(--pc-ink)]">Display info</summary>
      {info && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 p-3 pt-0 font-mono text-[11px] text-[var(--pc-muted)]">
          {Object.entries({
            Mode: info.mode,
            "Inner (w×h)": info.inner,
            "Visual viewport": info.vv,
            "Document client": info.client,
            "Screen": info.screenH,
            "Safe area": info.safe,
            "CSS heights": info.units,
            "Shell (y)": info.shell,
            "Tab bar (y)": info.nav,
          }).map(([k, v]) => (
            <div key={k} className="contents">
              <dt>{k}</dt>
              <dd className="text-[var(--pc-ink)]">{v}</dd>
            </div>
          ))}
        </dl>
      )}
    </details>
  );
}
