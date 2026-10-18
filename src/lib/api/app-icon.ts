import { agentBaseUrl, agentFetch } from "@/lib/api/auth";

/*
 * An app's own icon, read from the phone by the agent (GET /api/apps/icon).
 * Fetched with the API token, so it comes back as a blob URL. Each package is
 * asked once per page; null means "no readable icon" (show a letter badge).
 */
const icons = new Map<string, Promise<string | null>>();

export function loadAppIcon(serial: string, packageName: string): Promise<string | null> {
  const base = agentBaseUrl();
  if (base === null || !serial || !packageName) return Promise.resolve(null);
  let pending = icons.get(packageName);
  if (!pending) {
    pending = agentFetch(`${base}/api/apps/icon?serial=${encodeURIComponent(serial)}&package=${encodeURIComponent(packageName)}`)
      .then(async (res) => (res.ok ? URL.createObjectURL(await res.blob()) : null))
      .catch(() => null);
    icons.set(packageName, pending);
    // A phone that was off or still starting gets another try next time.
    void pending.then((url) => {
      if (url === null) window.setTimeout(() => icons.delete(packageName), 60_000);
    });
  }
  return pending;
}

/** The icon the user typed counts; empty, or the old "📱" default, means "use the app's own". */
export function typedIcon(icon: string | undefined): string | null {
  const value = (icon ?? "").trim();
  return value && value !== "📱" ? value : null;
}

/** A steady colour for a package, for the letter badge. */
export function badgeColor(packageName: string): string {
  let hash = 0;
  for (const ch of packageName) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360} 45% 38%)`;
}
