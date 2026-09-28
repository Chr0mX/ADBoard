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
  const raw = process.env.NEXT_PUBLIC_AGENT_URL?.trim();
  if (!raw || raw === "same" || raw === "same-origin") return "";
  return raw.replace(/\/$/, "");
}

async function readError(res: Response, fallback: string): Promise<string> {
  const text = await res.text();
  return text || `${fallback}: ${res.status}`;
}

export async function postScrcpyOptions(
  targetIds: string[],
  options: ScrcpyOptionsPayload,
): Promise<ScrcpyOptionsResult> {
  const res = await fetch(`${agentBase()}/api/scrcpy/options`, {
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
  const res = await fetch(`${agentBase()}/api/input/clipboard`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "selected", targetIds, text, paste }),
  });
  if (!res.ok) throw new Error(await readError(res, "clipboard failed"));
  return (await res.json()) as ClipboardResult;
}

export async function pullClipboard(targetIds: string[]): Promise<ClipboardResult> {
  const res = await fetch(`${agentBase()}/api/input/clipboard/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "selected", targetIds }),
  });
  if (!res.ok) throw new Error(await readError(res, "clipboard pull failed"));
  return (await res.json()) as ClipboardResult;
}

export function scrcpyWsUrl(serial: string, channel: "audio" | "" = "audio"): string {
  const base = agentBase();
  const proto =
    typeof window !== "undefined" && window.location.protocol === "https:" ? "wss://" : "ws://";
  if (!base && typeof window !== "undefined") {
    return `${proto}${window.location.host}/ws/devices/${encodeURIComponent(serial)}/${channel}`;
  }
  const ws = base.startsWith("https://")
    ? `wss://${base.slice("https://".length)}`
    : base.startsWith("http://")
      ? `ws://${base.slice("http://".length)}`
      : base;
  return `${ws}/ws/devices/${encodeURIComponent(serial)}/${channel}`;
}

export function eventsWsUrl(): string {
  const base = agentBase();
  const proto =
    typeof window !== "undefined" && window.location.protocol === "https:" ? "wss://" : "ws://";
  if (!base && typeof window !== "undefined") return `${proto}${window.location.host}/ws`;
  if (base.startsWith("https://")) return `wss://${base.slice("https://".length)}/ws`;
  if (base.startsWith("http://")) return `ws://${base.slice("http://".length)}/ws`;
  return `${base}/ws`;
}
