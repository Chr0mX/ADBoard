/**
 * First-sync decision for a shared store (pure, tested in Node).
 * - The agent already has a copy → adopt it (a fresh phone gets the PC's macros).
 * - The agent has nothing and this browser has real data → upload it.
 * - Neither → nothing to do: an untouched starter must never wipe shared data.
 */
export type FirstSyncAction = "adopt" | "upload" | "skip";

export function firstSyncAction(server: { value: unknown; rev: number }, localMeaningful: boolean): FirstSyncAction {
  const serverHasData = server.rev > 0 && server.value !== null && server.value !== undefined;
  if (serverHasData) return "adopt";
  return localMeaningful ? "upload" : "skip";
}

/**
 * Union of two lists by `id`: the agent's order first, then items only this
 * browser has. For the same id the newer `updatedAt` wins (agent on a tie).
 * Only items deleted since `base` (the last agreed copy) are dropped, so
 * meeting another browser's copy never loses data and never revives deletes.
 */
export function mergeById<T extends { id: string; updatedAt?: number }>(local: T[], remote: T[], base?: T[] | null): T[] {
  // With the last copy both sides agreed on, an item missing on one side was
  // deleted there (drop it); without it nothing is dropped.
  const baseIds = new Set((base ?? []).map((item) => item.id));
  const localById = new Map(local.map((item) => [item.id, item]));
  const out: T[] = [];
  for (const item of remote) {
    const mine = localById.get(item.id);
    if (!mine) {
      if (!baseIds.has(item.id)) out.push(item);
      continue;
    }
    out.push((mine.updatedAt ?? 0) > (item.updatedAt ?? 0) ? mine : item);
  }
  const remoteIds = new Set(remote.map((item) => item.id));
  for (const item of local) if (!remoteIds.has(item.id) && !baseIds.has(item.id)) out.push(item);
  return out;
}

/** Macro workspace merge: every tab from both copies, this browser's selection kept. */
export function mergeWorkspaces<W extends { version: number; tabs: Array<{ id: string; updatedAt?: number }>; activeId: string | null }>(
  local: W,
  remote: W,
  base?: W | null,
): W {
  const tabs = mergeById(local.tabs, remote.tabs, base?.tabs);
  const activeId = tabs.some((t) => t.id === local.activeId) ? local.activeId : (remote.activeId ?? tabs[0]?.id ?? null);
  return { ...remote, tabs, activeId };
}
