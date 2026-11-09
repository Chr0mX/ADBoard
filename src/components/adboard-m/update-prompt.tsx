"use client";

import { useEffect, useState } from "react";

/**
 * The mobile worker takes over by itself (skipWaiting + claim). When that
 * happens in a page that already had a worker, offer a reload to use the new
 * version.
 */
export function UpdatePrompt() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const had = Boolean(navigator.serviceWorker.controller);
    const onChange = () => {
      if (had) setReady(true);
    };
    navigator.serviceWorker.addEventListener("controllerchange", onChange);
    return () => navigator.serviceWorker.removeEventListener("controllerchange", onChange);
  }, []);
  if (!ready) return null;
  return (
    <div role="status" data-m-update className="relative z-10 flex shrink-0 items-center gap-2 border-b border-[var(--pc-line)] bg-[var(--pc-panel)] px-3 py-1.5 text-xs text-[var(--pc-ink)]">
      <span className="min-w-0 flex-1">A new version is ready.</span>
      <button type="button" onClick={() => window.location.reload()} className="pc-toggle pc-toggle-sm min-h-11 shrink-0 px-3">
        Reload
      </button>
    </div>
  );
}
