"use client";

import { useSyncExternalStore } from "react";

const subscribe = (onChange: () => void) => {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
};

/** One line under the header when the phone is offline or ADBoard can't be reached. */
export function ConnectionBanner({ error }: { error: string | null }) {
  const online = useSyncExternalStore(subscribe, () => navigator.onLine, () => true);
  if (online && !error) return null;
  return (
    <div
      role="status"
      data-m-connection
      className="relative z-10 flex shrink-0 items-center gap-2 border-b border-[var(--pc-line)] bg-[var(--pc-panel)] px-3 py-1.5 text-xs text-[var(--pc-warn)]"
    >
      <span className="min-w-0 flex-1 truncate">{online ? `ADBoard is not reachable. Retrying… (${error})` : "You are offline. The app will reconnect when the network is back."}</span>
      <button type="button" onClick={() => window.location.reload()} className="pc-toggle pc-toggle-sm min-h-11 shrink-0 px-3">
        Reload
      </button>
    </div>
  );
}
