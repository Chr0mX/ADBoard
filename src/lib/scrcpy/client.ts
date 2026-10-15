import { agentBaseUrl, agentFetch, agentWsUrl, withAgentToken } from "@/lib/api/auth";
import { httpErrorMessage } from "@/lib/api/http-error";

export interface ScrcpyOptionsPayload {
  quality: string;
  audio: boolean;
  screenOff: boolean;
}

export interface ScrcpyOptionsResult extends ScrcpyOptionsPayload {
  restarted?: string[];
  results?: { ok: boolean; error?: string | null; output?: string | null }[];
}

export interface ClipboardResult {
  results: { ok: boolean; error?: string | null; output?: string | null; deviceId?: string }[];
}

function agentBase(): string {
  return agentBaseUrl() ?? "";
}

async function readError(res: Response, fallback: string): Promise<string> {
  const text = await res.text();
  return httpErrorMessage(res.status, text, `${fallback}: ${res.status}`);
}

export async function postScrcpyOptions(
  targetIds: string[],
  options: ScrcpyOptionsPayload,
): Promise<ScrcpyOptionsResult> {
  const res = await agentFetch(`${agentBase()}/api/scrcpy/options`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode: "selected",
      targetIds,
      quality: options.quality,
      audio: options.audio,
      screenOff: options.screenOff,
    }),
  });
  if (!res.ok) throw new Error(await readError(res, "scrcpy options failed"));
  return (await res.json()) as ScrcpyOptionsResult;
}

export async function postClipboard(
  targetIds: string[],
  text: string,
  paste: boolean,
): Promise<ClipboardResult> {
  const res = await agentFetch(`${agentBase()}/api/input/clipboard`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "selected", targetIds, text, paste }),
  });
  if (!res.ok) throw new Error(await readError(res, "clipboard failed"));
  return (await res.json()) as ClipboardResult;
}

export async function postVideoRefresh(targetIds: string[]): Promise<ClipboardResult> {
  const res = await agentFetch(`${agentBase()}/api/input/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "selected", targetIds }),
  });
  if (!res.ok) throw new Error(await readError(res, "video refresh failed"));
  return (await res.json()) as ClipboardResult;
}

export async function pullClipboard(targetIds: string[]): Promise<ClipboardResult> {
  const res = await agentFetch(`${agentBase()}/api/input/clipboard/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "selected", targetIds }),
  });
  if (!res.ok) throw new Error(await readError(res, "clipboard pull failed"));
  return (await res.json()) as ClipboardResult;
}

export function scrcpyWsUrl(serial: string, channel: "audio" | "" = "audio"): string {
  const path = `/ws/devices/${encodeURIComponent(serial)}/${channel}`;
  // Sync helper for hooks that already awaited ensureAgentToken / agentWsUrl.
  // Prefer agentWsUrl() when opening a socket.
  if (typeof window === "undefined") return path;
  try {
    // Fire-and-forget path used only after token bootstrap elsewhere.
    return withAgentToken(
      // Absolute URL built like before for sync callers.
      (() => {
        const base = agentBase();
        const proto = window.location.protocol === "https:" ? "wss://" : "ws://";
        if (!base) return `${proto}${window.location.host}${path}`;
        const ws = base.startsWith("https://")
          ? `wss://${base.slice("https://".length)}`
          : base.startsWith("http://")
            ? `ws://${base.slice("http://".length)}`
            : base;
        return `${ws}${path}`;
      })(),
    );
  } catch {
    return path;
  }
}

export async function scrcpyWsUrlAsync(
  serial: string,
  channel: "audio" | "" = "audio",
): Promise<string> {
  return agentWsUrl(`/ws/devices/${encodeURIComponent(serial)}/${channel}`);
}

export function eventsWsUrl(): string {
  if (typeof window === "undefined") return "/ws";
  const base = agentBase();
  const proto = window.location.protocol === "https:" ? "wss://" : "ws://";
  const url = !base
    ? `${proto}${window.location.host}/ws`
    : base.startsWith("https://")
      ? `wss://${base.slice("https://".length)}/ws`
      : base.startsWith("http://")
        ? `ws://${base.slice("http://".length)}/ws`
        : `${base}/ws`;
  return withAgentToken(url);
}

export async function eventsWsUrlAsync(): Promise<string> {
  return agentWsUrl("/ws");
}
