"use client";

import { useSyncExternalStore } from "react";
import { agentBaseUrl, agentFetch } from "@/lib/api/auth";
import { toNormalized, type MacroTab, type RefArea, type Size, type TextStep } from "@/lib/macro/core";

/**
 * Text on a phone's screen, read by the agent (`/api/ocr/*`). The editor uses
 * it to try a text step on the live screen; runs read on the agent itself.
 */

/** 0–1 of the screen (its current rotation). */
export interface TextBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenLine {
  text: string;
  box: TextBox;
  confidence?: number;
}

export interface ScreenMatch {
  text: string;
  /** What a Read step would store. */
  value: string;
  box: TextBox;
  line: number;
}

export interface ScreenText {
  width: number;
  height: number;
  lines: ScreenLine[];
  engine: string;
  ms: number;
  cached: boolean;
  matches?: ScreenMatch[];
}

export interface OcrStatus {
  available: boolean;
  engine: string;
  models?: string;
  detail?: string;
}

/** A step's area (reference pixels) → 0–1 of a screen, scaled the way the run scales it. */
export function areaOnScreen(area: RefArea, tab: Pick<MacroTab, "reference" | "scale">, device: Size | null | undefined): TextBox {
  const a = toNormalized({ x: area.x, y: area.y }, tab.reference, device, tab.scale);
  const b = toNormalized({ x: area.x + area.width, y: area.y + area.height }, tab.reference, device, tab.scale);
  return { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };
}

async function errorOf(res: Response) {
  try {
    return ((await res.json()) as { error?: string }).error ?? `ADBoard said ${res.status}`;
  } catch {
    return `ADBoard said ${res.status}`;
  }
}

/** Read a phone's screen now, and where `step`'s texts are on it. */
export async function readScreen(deviceId: string, area?: TextBox, step?: Pick<TextStep, "texts" | "match" | "caseSensitive">): Promise<ScreenText> {
  const base = agentBaseUrl();
  if (base === null) throw new Error("Reading text needs the ADBoard agent");
  const query = step && step.texts.some((t) => t.trim()) ? { texts: step.texts, match: step.match, caseSensitive: step.caseSensitive } : undefined;
  const res = await agentFetch(`${base}/api/ocr/read`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId, area, query }),
  });
  if (!res.ok) throw new Error(await errorOf(res));
  return (await res.json()) as ScreenText;
}

let statusRequest: Promise<OcrStatus | null> | null = null;

/** Whether this ADBoard can read text (null without an agent). Asked once per page. */
export function ocrStatus(): Promise<OcrStatus | null> {
  const base = agentBaseUrl();
  if (base === null) return Promise.resolve(null);
  statusRequest ??= agentFetch(`${base}/api/ocr/status`, { cache: "no-store" })
    .then((res) => (res.ok ? (res.json() as Promise<OcrStatus>) : null))
    .catch(() => {
      statusRequest = null;
      return null;
    });
  return statusRequest;
}

/* The last "Read screen" result, drawn over that phone's preview. */

export interface TextPreview {
  deviceId: string;
  stepId: string;
  screen: ScreenText;
}

let preview: TextPreview | null = null;
const listeners = new Set<() => void>();

export function setTextPreview(next: TextPreview | null) {
  preview = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The read shown on `deviceId`'s preview, if any. */
export function useTextPreview(deviceId: string | null): TextPreview | null {
  const current = useSyncExternalStore(subscribe, () => preview, () => null);
  return current && current.deviceId === deviceId ? current : null;
}
