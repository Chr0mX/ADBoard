import type { Device } from "@/lib/devices/types";

/** Two device records with the same content (the agent re-sends the whole list on every change). */
export function sameDevice(a: Device, b: Device): boolean {
  const left = a as unknown as Record<string, unknown>;
  const right = b as unknown as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  for (const key of keys) {
    const x = left[key];
    const y = right[key];
    if (x === y) continue;
    if (typeof x === "object" && x !== null && typeof y === "object" && y !== null) {
      if (JSON.stringify(x) === JSON.stringify(y)) continue;
    }
    return false;
  }
  return true;
}

/**
 * The new fleet, reusing the previous `Device` object for every phone whose
 * content did not change, and the previous array itself when nothing changed
 * at all. React then skips re-rendering everything that depends on `devices`
 * for updates that changed nothing visible.
 */
export function reuseUnchanged(prev: Device[], next: Device[]): Device[] {
  if (prev.length === 0) return next;
  const before = new Map(prev.map((d) => [d.id, d]));
  let allSame = prev.length === next.length;
  const merged = next.map((device, index) => {
    const old = before.get(device.id);
    if (old && sameDevice(old, device)) {
      if (prev[index] !== old) allSame = false;
      return old;
    }
    allSame = false;
    return device;
  });
  return allSame ? prev : merged;
}
