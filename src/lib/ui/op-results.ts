/*
 * Reading the per-phone results the agent returns for a fleet operation, so a switch only
 * claims a state when the operation actually worked on at least one phone.
 */

export interface OpResult {
  ok: boolean;
  deviceId?: string;
  deviceName?: string;
  error?: string | null;
}

/** There were results, and none of them succeeded. */
export function allFailed(results: ReadonlyArray<OpResult> | null | undefined): boolean {
  return !!results && results.length > 0 && results.every((r) => !r.ok);
}

/**
 * Quiet Mode runs two operations on every online phone: screen power and mute. `screen` and
 * `mute` are the per-phone results, or null when the whole request failed. A phone counts as done
 * only when both worked; the switch changes only if at least one phone is done.
 */
export function quietOutcome(
  phoneIds: ReadonlyArray<string>,
  screen: ReadonlyArray<OpResult> | null,
  mute: ReadonlyArray<OpResult> | null,
): { done: number; failed: boolean; partial: boolean } {
  const ok = (results: ReadonlyArray<OpResult> | null, id: string) =>
    results !== null && results.some((r) => r.deviceId === id && r.ok);
  const done = phoneIds.filter((id) => ok(screen, id) && ok(mute, id)).length;
  return { done, failed: done === 0, partial: done > 0 && done < phoneIds.length };
}
