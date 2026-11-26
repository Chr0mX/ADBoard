/**
 * Says when a touch, key or navigation press on the phone stage reaches more than the phone shown.
 * "All" and "Multi" modes send to a group, and the mode is a synced preference, so a second browser can
 * start in a mode the person never chose there; the stage must show it.
 *
 * Pure module: runs under `node --test`.
 */
export type ControlModeName = "selected" | "multi" | "all";

export function controlGroupLabel(mode: ControlModeName | undefined, phoneCount: number): string | null {
  if (!mode || mode === "selected" || phoneCount < 2) return null;
  const which = mode === "all" ? "all online phones" : "the ticked phones";
  return `Controlling ${phoneCount} phones (${which})`;
}
