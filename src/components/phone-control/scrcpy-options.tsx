"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import { useDesk } from "@/components/phone-control/desk/desk-context";
import { useDeviceAudio } from "@/hooks/use-device-audio";
import { devicesClient } from "@/lib/api/client";
import {
  eventsWsUrl,
  postClipboard,
  postScrcpyOptions,
  pullClipboard,
  type ScrcpyOptionsPayload,
} from "@/lib/scrcpy/client";

const STORAGE_KEY = "phonecontrol-scrcpy";
const SIZE_KEY = "phonecontrol-display-size";
const DISPLAY_SIZES = [
  { id: "native", label: "Each phone", arg: "reset" },
  { id: "1080x1920", label: "16:9", arg: "1080x1920" },
  { id: "1080x2400", label: "20:9", arg: "1080x2400" },
] as const;
const QUALITIES = ["low", "balanced", "high", "original"] as const;
const DEFAULTS: ScrcpyOptionsPayload = {
  quality: "balanced",
  audio: false,
  screenOff: false,
};

const listeners = new Set<() => void>();
let cachedRaw = "\0";
let cachedOpts = DEFAULTS;

function parseOpts(raw: string | null): ScrcpyOptionsPayload {
  if (!raw) return DEFAULTS;
  try {
    const value = JSON.parse(raw) as Partial<ScrcpyOptionsPayload>;
    const quality = QUALITIES.includes(value.quality as (typeof QUALITIES)[number])
      ? (value.quality as string)
      : "balanced";
    return {
      quality,
      audio: value.audio === true,
      screenOff: value.screenOff === true,
    };
  } catch {
    return DEFAULTS;
  }
}

function readOpts(): ScrcpyOptionsPayload {
  let raw = "";
  try {
    raw = localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    raw = "";
  }
  if (raw === cachedRaw) return cachedOpts;
  cachedRaw = raw;
  cachedOpts = parseOpts(raw || null);
  return cachedOpts;
}

function writeOpts(next: ScrcpyOptionsPayload) {
  const raw = JSON.stringify(next);
  try {
    localStorage.setItem(STORAGE_KEY, raw);
  } catch {
    // private mode
  }
  cachedRaw = raw;
  cachedOpts = next;
  listeners.forEach((listener) => listener());
}

function firstError(results: { ok: boolean; error?: string | null }[] | undefined) {
  return results?.find((result) => !result.ok)?.error || "";
}

export function ScrcpyOptions({
  targetIds,
  serial,
  disabled,
}: {
  targetIds: string[];
  serial: string | null;
  disabled?: boolean;
}) {
  const options = useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    readOpts,
    () => DEFAULTS,
  );
  const [note, setNote] = useState<string | null>(null);
  const [clip, setClip] = useState("");
  const [displaySize, setDisplaySize] = useState(() => {
    try {
      const stored = localStorage.getItem(SIZE_KEY);
      if (stored && DISPLAY_SIZES.some((item) => item.id === stored)) return stored;
    } catch {
      // private mode
    }
    return "native";
  });
  const [sizing, setSizing] = useState(false);
  const desk = useDesk();
  const audio = useDeviceAudio(serial, options.audio && !disabled);
  const ids = targetIds.join(",");
  const syncedIds = useRef("");

  useEffect(() => {
    if (!ids || syncedIds.current === ids) return;
    syncedIds.current = ids;
    void postScrcpyOptions(ids.split(","), options).catch(() => {});
  }, [ids, options]);

  useEffect(() => {
    if (!serial) return;
    let closed = false;
    let socket: WebSocket | null = null;
    const connect = () => {
      if (closed) return;
      socket = new WebSocket(eventsWsUrl());
      socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data)) as { type?: string; serial?: string; text?: string };
          if (msg.type === "clipboard" && msg.serial === serial && typeof msg.text === "string") {
            setClip(msg.text);
          }
        } catch {
          // ignore
        }
      };
      socket.onclose = () => {
        if (!closed) setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      closed = true;
      socket?.close();
    };
  }, [serial]);

  const apply = async (next: ScrcpyOptionsPayload) => {
    writeOpts(next);
    if (targetIds.length === 0) return;
    try {
      const result = await postScrcpyOptions(targetIds, next);
      const error = firstError(result.results);
      if (error) setNote(error);
      else if (result.restarted && result.restarted.length > 0) {
        setNote("Stream restarted for the new setting.");
      } else if (next.screenOff !== options.screenOff) {
        setNote(next.screenOff ? "Device screen off. The mirror stays on." : "Device screen on.");
      } else setNote(null);
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Could not update scrcpy");
    }
  };

  const matchSize = async (id: string) => {
    const choice = DISPLAY_SIZES.find((item) => item.id === id) ?? DISPLAY_SIZES[0];
    setDisplaySize(choice.id);
    try {
      localStorage.setItem(SIZE_KEY, choice.id);
    } catch {
      // private mode
    }
    const online = desk.devices.filter((device) => device.status === "online");
    if (online.length === 0) {
      setNote("No online phones to resize.");
      return;
    }
    setSizing(true);
    try {
      const result = await devicesClient.runCommand(online, "displaySize", choice.arg);
      const error = firstError(result.results);
      if (error) setNote(error);
      else if (choice.id === "native") setNote("Each phone is back to its own screen.");
      else setNote(`Every online phone is ${choice.label}. Streams restart on the new size.`);
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Could not set the screen size");
    } finally {
      setSizing(false);
    }
  };

  const sendToPhone = async (paste: boolean) => {
    let text = clip;
    if (!text && navigator.clipboard?.readText) {
      try {
        text = await navigator.clipboard.readText();
        setClip(text);
      } catch {
        text = "";
      }
    }
    if (!text) {
      setNote("Type the text to send, or allow clipboard read.");
      return;
    }
    try {
      const result = await postClipboard(targetIds, text, paste);
      const error = firstError(result.results);
      setNote(error || (paste ? "Pasted on the phone." : "Copied to the phone clipboard."));
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Clipboard send failed");
    }
  };

  const takeFromPhone = async () => {
    const id = targetIds[0];
    if (!id) return;
    try {
      const result = await pullClipboard([id]);
      const row = result.results[0];
      if (!row?.ok) {
        setNote(row?.error || "Could not read the phone clipboard.");
        return;
      }
      const text = row.output ?? "";
      setClip(text);
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          // The field still holds the text when the page is not a secure context.
        }
      }
      setNote(text ? "Copied from the phone." : "Phone clipboard is empty.");
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Clipboard read failed");
    }
  };

  const audioNote =
    options.audio && audio.note && audio.note !== "opus" ? audio.note : null;
  const audioError = options.audio && audio.stream === "error" ? audioNote : null;

  return (
    <div className="flex w-full shrink-0 flex-col items-center gap-1" data-scrcpy-options>
      <div className="flex w-full flex-wrap items-center justify-center gap-1.5">
        <label className="flex h-11 items-center gap-1.5 rounded-lg border border-[var(--pc-line)] bg-[var(--pc-panel)]/70 px-2">
          <span className="font-mono text-[10px] uppercase tracking-wide text-[var(--pc-muted)]">
            Quality
          </span>
          <select
            aria-label="Stream quality"
            data-scrcpy-quality
            disabled={disabled}
            value={options.quality}
            onChange={(event) => {
              void apply({ ...options, quality: event.target.value });
            }}
            className="h-8 bg-transparent font-mono text-xs text-[var(--pc-ink)] outline-none"
          >
            <option value="low">Low</option>
            <option value="balanced">Balanced</option>
            <option value="high">High</option>
            <option value="original">Original</option>
          </select>
        </label>
        <label className="flex h-11 items-center gap-1.5 rounded-lg border border-[var(--pc-line)] bg-[var(--pc-panel)]/70 px-2">
          <span className="font-mono text-[10px] uppercase tracking-wide text-[var(--pc-muted)]">
            Size
          </span>
          <select
            aria-label="Match screen size"
            data-display-size
            disabled={disabled || sizing || desk.devices.every((device) => device.status !== "online")}
            value={displaySize}
            onChange={(event) => {
              void matchSize(event.target.value);
            }}
            className="h-8 bg-transparent font-mono text-xs text-[var(--pc-ink)] outline-none"
          >
            {DISPLAY_SIZES.map((item) => (
              <option key={item.id} value={item.id}>
                {item.id === "native" ? item.label : `${item.label} ${item.arg.replace("x", "×")}`}
              </option>
            ))}
          </select>
        </label>
        <Toggle
          pressed={options.audio}
          onPressedChange={(on) => {
            void apply({ ...options, audio: on });
          }}
          disabled={disabled}
          aria-label="Audio forwarding"
          data-scrcpy-audio
          className="h-11 rounded-lg border border-[var(--pc-line)] bg-[var(--pc-panel)]/70 px-3 aria-pressed:border-[var(--pc-accent)] aria-pressed:bg-[var(--pc-accent-soft)] aria-pressed:text-[var(--pc-accent)]"
        >
          Audio
        </Toggle>
        <Toggle
          pressed={options.screenOff}
          onPressedChange={(on) => {
            void apply({ ...options, screenOff: on });
          }}
          disabled={disabled}
          aria-label="Screen off"
          data-scrcpy-screen
          className="h-11 rounded-lg border border-[var(--pc-line)] bg-[var(--pc-panel)]/70 px-3 aria-pressed:border-[var(--pc-accent)] aria-pressed:bg-[var(--pc-accent-soft)] aria-pressed:text-[var(--pc-accent)]"
        >
          Screen off
        </Toggle>
        <input
          aria-label="Clipboard"
          data-scrcpy-clipboard
          value={clip}
          disabled={disabled}
          placeholder="Clipboard"
          onChange={(event) => setClip(event.target.value)}
          className="h-11 min-w-[8rem] flex-1 rounded-lg border border-[var(--pc-line)] bg-[var(--pc-panel)]/70 px-3 font-mono text-xs text-[var(--pc-ink)] outline-none placeholder:text-[var(--pc-muted)]"
        />
        <Button
          type="button"
          variant="ghost"
          disabled={disabled}
          data-scrcpy-to-phone
          onClick={() => void sendToPhone(true)}
          className="h-11 rounded-full border border-[var(--pc-line)] bg-[var(--pc-panel)] px-3 font-mono text-xs"
        >
          To phone
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={disabled}
          data-scrcpy-from-phone
          onClick={() => void takeFromPhone()}
          className="h-11 rounded-full border border-[var(--pc-line)] bg-[var(--pc-panel)] px-3 font-mono text-xs"
        >
          From phone
        </Button>
      </div>
      {(note || audioError || audioNote) && (
        <p data-scrcpy-note className="max-w-lg truncate text-center font-mono text-[10px] text-[var(--pc-muted)]">
          {note || audioError || audioNote}
        </p>
      )}
    </div>
  );
}
