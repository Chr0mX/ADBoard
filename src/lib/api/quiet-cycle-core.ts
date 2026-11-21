/*
 * Pure helpers for the Quiet mode Repeat. The agent owns
 * the timing; the browser only shows how long is left.
 */

export type QuietPhase = "quiet" | "normal";

export const DEFAULT_INTERVAL_MINUTES = 60;
export const MIN_MINUTES = 1;
export const MAX_MINUTES = 7 * 24 * 60;

/** Hours and minutes fields to whole minutes in range (the default when empty or not a number). */
export function intervalMinutes(hours: string, minutes: string): number {
  const h = Number(hours.trim() || 0);
  const m = Number(minutes.trim() || 0);
  if (!Number.isFinite(h) || !Number.isFinite(m) || h < 0 || m < 0) return DEFAULT_INTERVAL_MINUTES;
  const total = Math.round(h * 60 + m);
  if (total <= 0) return DEFAULT_INTERVAL_MINUTES;
  return Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, total));
}

/** "2 h 41 m", "15 m", "40 s" for a number of seconds. */
export function formatLeft(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total} s`;
  const minutes = Math.ceil(total / 60);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} m`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} m`;
}

/** Seconds left from the agent's phase end and clock, corrected for this browser's clock. */
export function secondsLeft(phaseEndsAt: number, agentNow: number, receivedAtMs: number, nowMs: number): number {
  const elapsed = Math.max(0, (nowMs - receivedAtMs) / 1000);
  return Math.max(0, phaseEndsAt - agentNow - elapsed);
}

/** The line under the toggle. */
export function cycleLine(phase: QuietPhase, left: number): string {
  return `${phase === "quiet" ? "Quiet" : "Normal"} now · switches in ${formatLeft(left)}`;
}
