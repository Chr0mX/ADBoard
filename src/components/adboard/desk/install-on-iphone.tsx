"use client";

import { useSyncExternalStore } from "react";

type Platform = { ios: boolean; safari: boolean; standalone: boolean };

const SERVER: Platform = { ios: false, safari: false, standalone: false };
let cached: Platform | null = null;

function detect(): Platform {
  if (cached) return cached;
  const ua = navigator.userAgent;
  // iPadOS reports a Mac user agent; touch points tell it apart.
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  // Other iOS browsers add their own token (CriOS, FxiOS, EdgiOS, …).
  const safari = ios && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo|GSA\//.test(ua);
  const standalone =
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    window.matchMedia?.("(display-mode: standalone)").matches === true;
  cached = { ios, safari, standalone };
  return cached;
}

/**
 * How to put ADBoard on an iPhone Home Screen. iOS has no install prompt:
 * the only route is the browser's Share menu, and that menu does not exist
 * inside an already-installed Home Screen app.
 */
export function InstallOnIphone() {
  const platform = useSyncExternalStore(() => () => {}, detect, () => SERVER);
  if (!platform.ios) return null;
  return (
    <section
      data-settings-install
      data-standalone={platform.standalone ? "1" : "0"}
      className="flex min-w-0 flex-col gap-2 rounded-2xl border border-[var(--pc-line)] bg-[var(--pc-panel)] p-3 lg:col-span-2"
    >
      <h3 className="font-display text-sm font-semibold text-[var(--pc-ink)]">Install on iPhone</h3>
      {platform.standalone ? (
        <p className="text-xs text-[var(--pc-muted)]">
          Running as a Home Screen app ✓. After an ADBoard update, remove the icon and add it again from Safari so iOS picks up the new version.
        </p>
      ) : (
        <ol className="list-decimal space-y-1 pl-5 text-xs text-[var(--pc-ink)]">
          {platform.safari ? (
            <>
              <li>Tap the Share button (square with an arrow) in Safari&apos;s toolbar.</li>
              <li>Scroll down and tap <strong>Add to Home Screen</strong>.</li>
              <li>Keep <strong>Open as Web App</strong> on (iOS 26), then tap <strong>Add</strong>.</li>
            </>
          ) : (
            <>
              <li>Open this browser&apos;s Share menu (iOS 16.4 or newer), or open the page in Safari.</li>
              <li>Tap <strong>Add to Home Screen</strong>, then <strong>Add</strong>.</li>
            </>
          )}
          <li>Open ADBoard from the new icon: it runs full screen without the browser bars. iOS shows no install prompt by itself.</li>
        </ol>
      )}
    </section>
  );
}
