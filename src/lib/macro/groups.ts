/**
 * The desktop Macros library: filter, sort and group the macros.
 *
 * Pure module (no browser APIs, no path aliases): runs under `node --test`.
 * A macro's group is its optional `group` field; macros without one sit under
 * "Ungrouped", which is listed last.
 */
export const UNGROUPED = "Ungrouped";

export type LibrarySort = "manual" | "name" | "recent";

export interface LibraryTab {
  id: string;
  name: string;
  group?: string;
  updatedAt: number;
}

export interface LibraryGroup<T extends LibraryTab> {
  /** Display name; "Ungrouped" for macros with no group. */
  name: string;
  /** Group name as stored on the macros ("" for ungrouped). */
  key: string;
  tabs: T[];
}

export function parseSort(value: string | null | undefined): LibrarySort {
  return value === "name" || value === "recent" ? value : "manual";
}

const byName = (a: LibraryTab, b: LibraryTab) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });

/** Case-insensitive match on name or group; an empty query keeps everything. */
export function matchesQuery(tab: LibraryTab, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return tab.name.toLowerCase().includes(q) || (tab.group ?? "").toLowerCase().includes(q);
}

/**
 * Groups in the order they first appear (manual order) or alphabetically
 * (name sort); "Ungrouped" last. Macros keep workspace order inside a group
 * unless sorted by name or by last edit.
 */
export function buildLibrary<T extends LibraryTab>(tabs: readonly T[], query: string, sort: LibrarySort): LibraryGroup<T>[] {
  const shown = tabs.filter((tab) => matchesQuery(tab, query));
  const ordered = [...shown];
  if (sort === "name") ordered.sort(byName);
  else if (sort === "recent") ordered.sort((a, b) => b.updatedAt - a.updatedAt);
  const groups = new Map<string, T[]>();
  for (const tab of ordered) {
    const key = (tab.group ?? "").trim();
    // Group names are one name whatever the capitalisation.
    const existing = [...groups.keys()].find((k) => k.toLowerCase() === key.toLowerCase());
    const use = existing ?? key;
    groups.set(use, [...(groups.get(use) ?? []), tab]);
  }
  const named = [...groups.entries()].filter(([key]) => key !== "");
  if (sort === "name") named.sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: "base", numeric: true }));
  const out: LibraryGroup<T>[] = named.map(([key, list]) => ({ name: key, key, tabs: list }));
  const rest = groups.get("");
  if (rest) out.push({ name: UNGROUPED, key: "", tabs: rest });
  return out;
}

/** Every group name in use, once each, for the Group box's suggestions. */
export function groupNames(tabs: readonly LibraryTab[]): string[] {
  const seen = new Map<string, string>();
  for (const tab of tabs) {
    const name = (tab.group ?? "").trim();
    if (name && !seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

/** The macros in the order the library shows them (for arrow-key movement). */
export function flatOrder<T extends LibraryTab>(groups: readonly LibraryGroup<T>[], collapsed: ReadonlySet<string>): T[] {
  return groups.flatMap((group) => (collapsed.has(group.key) ? [] : group.tabs));
}

/** The next macro id when the arrow keys move `delta` rows from `currentId`; stays put at the ends. */
export function stepSelection(order: readonly { id: string }[], currentId: string | null, delta: -1 | 1): string | null {
  if (order.length === 0) return null;
  const index = order.findIndex((tab) => tab.id === currentId);
  if (index < 0) return order[delta === 1 ? 0 : order.length - 1].id;
  return order[Math.min(order.length - 1, Math.max(0, index + delta))].id;
}
