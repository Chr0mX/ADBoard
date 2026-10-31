/**
 * Shapes of the per-app controls and phone tweaks the agent reads with adb
 * (`appDetail`, `activities`, `tweak` ops). See docs/phone-controls.md.
 *
 * Pure module: no imports at runtime, so it runs under `node --test`.
 */

export interface AppPermission {
  name: string;
  granted: boolean;
}

export interface AppDetail {
  package: string;
  uid: number | null;
  versionName: string | null;
  versionCode: string | null;
  targetSdk: number | null;
  installed: boolean;
  suspended: boolean;
  disabled: boolean;
  system: boolean;
  /** Runtime permissions: the ones `pm grant` can change. */
  permissions: AppPermission[];
  /** App op → mode (allow, ignore, deny, default, foreground). */
  ops: Record<string, string>;
  bucket: string | null;
  /** `user`, `system`, or null when the app is battery optimised. */
  batteryExempt: string | null;
  /** null: this phone cannot block one app's network. */
  networkAllowed: boolean | null;
}

export interface AppActivity {
  name: string;
  exported: boolean;
  launcher: boolean;
}

export interface PhoneTweaks {
  devOptionsHidden: boolean;
  phantomKillerOff: boolean;
  forceDark: boolean;
}

export type TweakName = keyof PhoneTweaks;

export const OP_MODES = ["allow", "ignore", "deny", "default", "foreground"] as const;
export const BUCKETS = ["active", "working_set", "frequent", "rare", "restricted"] as const;

export const BUCKET_LABELS: Record<string, string> = {
  exempted: "Exempted (system)",
  active: "Active",
  working_set: "Working set",
  frequent: "Frequent",
  rare: "Rare",
  restricted: "Restricted",
  never: "Never used",
};

/** Ops worth showing first: they decide whether an app keeps running. */
export const KEY_OPS = ["RUN_ANY_IN_BACKGROUND", "RUN_IN_BACKGROUND", "WAKE_LOCK", "SYSTEM_ALERT_WINDOW", "START_FOREGROUND"];

export const TWEAKS: { name: TweakName; label: string; description: string }[] = [
  {
    name: "devOptionsHidden",
    label: "Hide Developer options",
    description: "Apps see Developer options off; USB and wireless debugging stay on so ADBoard keeps the phone.",
  },
  {
    name: "phantomKillerOff",
    label: "Phantom process killer off",
    description: "Android 12+ stops killing long-running shell and child processes (Termux, Shizuku).",
  },
  {
    name: "forceDark",
    label: "Force dark",
    description: "Dark rendering for apps without a dark theme. Resets on reboot; little effect on Android 16.",
  },
];

function parseJson(text: string | undefined): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function parseAppDetail(text: string | undefined): AppDetail | null {
  const value = parseJson(text) as Partial<AppDetail> | null;
  if (!value || typeof value !== "object" || typeof value.package !== "string") return null;
  return {
    package: value.package,
    uid: value.uid ?? null,
    versionName: value.versionName ?? null,
    versionCode: value.versionCode ?? null,
    targetSdk: value.targetSdk ?? null,
    installed: value.installed !== false,
    suspended: Boolean(value.suspended),
    disabled: Boolean(value.disabled),
    system: Boolean(value.system),
    permissions: Array.isArray(value.permissions) ? value.permissions : [],
    ops: value.ops && typeof value.ops === "object" ? value.ops : {},
    bucket: value.bucket ?? null,
    batteryExempt: value.batteryExempt ?? null,
    networkAllowed: typeof value.networkAllowed === "boolean" ? value.networkAllowed : null,
  };
}

export function parseActivities(text: string | undefined): AppActivity[] {
  const value = parseJson(text);
  return Array.isArray(value) ? value.filter((a): a is AppActivity => typeof a?.name === "string") : [];
}

export function parseTweaks(text: string | undefined): PhoneTweaks | null {
  const value = parseJson(text) as Partial<PhoneTweaks> | null;
  if (!value || typeof value !== "object") return null;
  return {
    devOptionsHidden: Boolean(value.devOptionsHidden),
    phantomKillerOff: Boolean(value.phantomKillerOff),
    forceDark: Boolean(value.forceDark),
  };
}

/** `com.app.ui.Settings` in `com.app` → `.ui.Settings` (what `am start -n` takes). */
export function shortActivity(name: string, packageName: string) {
  return name.startsWith(`${packageName}.`) ? name.slice(packageName.length) : name;
}

/** App ops, the ones that decide background running first, then by name. */
export function sortedOps(ops: Record<string, string>, query = ""): [string, string][] {
  const q = query.trim().toUpperCase();
  return Object.entries(ops)
    .filter(([name]) => !q || name.includes(q))
    .sort(([a], [b]) => {
      const ia = KEY_OPS.indexOf(a);
      const ib = KEY_OPS.indexOf(b);
      if (ia !== ib) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      return a.localeCompare(b);
    });
}

/** `android.permission.POST_NOTIFICATIONS` → `Post notifications`. */
export function permissionLabel(name: string) {
  const last = name.split(".").pop() ?? name;
  const words = last.toLowerCase().replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
