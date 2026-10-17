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
