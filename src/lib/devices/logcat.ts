/**
 * Logcat lines as the agent streams them (`-v threadtime`), parsed for the
 * Logcat tab: level colour, search, and a capped buffer.
 *
 * Pure module: no imports at runtime, so it runs under `node --test`.
 */

export type LogLevel = "V" | "D" | "I" | "W" | "E" | "F";

export const LOG_LEVELS: { id: LogLevel; label: string }[] = [
  { id: "V", label: "Verbose" },
  { id: "D", label: "Debug" },
  { id: "I", label: "Info" },
  { id: "W", label: "Warning" },
  { id: "E", label: "Error" },
  { id: "F", label: "Fatal" },
];

export interface LogLine {
  id: number;
  /** `10-30 12:00:00.123`, empty for lines that are not log entries. */
  time: string;
  pid: string;
  level: LogLevel | null;
  tag: string;
  message: string;
  raw: string;
}

/** Lines kept in the view; older ones drop off. */
export const MAX_LOG_LINES = 3000;

const THREADTIME = /^(\d\d-\d\d \d\d:\d\d:\d\d\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEFA])\s+(.*?)\s*:\s(.*)$/;

export function parseLogLine(raw: string, id: number): LogLine {
  const m = THREADTIME.exec(raw);
  if (!m) return { id, time: "", pid: "", level: null, tag: "", message: raw, raw };
  const level = (m[4] === "A" ? "F" : m[4]) as LogLevel;
  return { id, time: m[1], pid: m[2], level, tag: m[5], message: m[6], raw };
}

/** Append and drop the oldest past `max`. Returns a new array. */
export function appendLines(current: LogLine[], incoming: LogLine[], max = MAX_LOG_LINES): LogLine[] {
  if (incoming.length === 0) return current;
  const next = current.concat(incoming);
  return next.length > max ? next.slice(next.length - max) : next;
}

/** Case-insensitive search over tag and message. */
export function filterLines(lines: LogLine[], query: string): LogLine[] {
  const q = query.trim().toLowerCase();
  if (!q) return lines;
  return lines.filter((line) => line.raw.toLowerCase().includes(q));
}

/** A frame from `/ws/devices/{serial}/logcat`. */
export type LogcatFrame = { lines: string[] } | { note: string } | { skipped: number };

export function parseFrame(text: string): LogcatFrame | null {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (Array.isArray(value.lines)) return { lines: value.lines.filter((l): l is string => typeof l === "string") };
    if (typeof value.note === "string") return { note: value.note };
    if (typeof value.skipped === "number") return { skipped: value.skipped };
  } catch {
    // not JSON
  }
  return null;
}
