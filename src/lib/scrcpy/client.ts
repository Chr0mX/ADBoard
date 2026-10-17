import { agentBaseUrl, agentFetch, agentWsUrl } from "@/lib/api/auth";
import { httpErrorMessage } from "@/lib/api/http-error";

export interface ScrcpyOptionsPayload {
  quality: string;
  audio: boolean;
  screenOff: boolean;
  /** Custom quality (kept while a preset is chosen, sent only with `custom`). */
  maxSize?: number;
  videoBitRate?: number;
  maxFps?: number;
}

export interface ScrcpyOptionsResult extends ScrcpyOptionsPayload {
  restarted?: string[];
  results?: { ok: boolean; error?: string | null; output?: string | null; deviceId?: string; deviceName?: string }[];
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
      ...(options.quality === "custom"
        ? { maxSize: options.maxSize, videoBitRate: options.videoBitRate, maxFps: options.maxFps }
        : {}),
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

export async function scrcpyWsUrlAsync(
  serial: string,
  channel: "audio" | "" = "audio",
): Promise<string> {
  return agentWsUrl(`/ws/devices/${encodeURIComponent(serial)}/${channel}`);
}

export async function eventsWsUrlAsync(): Promise<string> {
  return agentWsUrl("/ws");
}
