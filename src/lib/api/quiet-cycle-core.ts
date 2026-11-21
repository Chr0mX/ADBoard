/*
 * Pure helpers for the "Repeat indefinitely" Quiet mode cycle. The agent owns
 * the timing; the browser only shows how long is left.
 */

export type QuietPhase = "quiet" | "normal";

export const DEFAULT_QUIET_MINUTES = 180;
export const DEFAULT_NORMAL_MINUTES = 15;
export const MIN_MINUTES = 1;
export const MAX_MINUTES = 7 * 24 * 60;

/** A duration field's text to whole minutes in range; the fallback when it is not a usable number. */
export function parseMinutes(text: string, fallback: number): number {
  const value = Number(text.trim());
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round(value)));
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
export function cycleLine(enabled: boolean, phase: QuietPhase, left: number): string {
  if (!enabled) return "Off";
  return `${phase === "quiet" ? "Quiet" : "Normal"} · ${formatLeft(left)} left`;
}
