"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import { useDesk } from "@/components/phone-control/desk/desk-context";
import { devicesClient } from "@/lib/api/client";
import {
  eventsWsUrlAsync,
  postClipboard,
  pullClipboard,
} from "@/lib/scrcpy/client";
import { firstError, useScrcpyOptions } from "@/hooks/use-scrcpy-options";

const SIZE_KEY = "phonecontrol-display-size";
const DISPLAY_SIZES = [
  { id: "native", label: "Each phone", arg: "reset" },
  { id: "900x1600", label: "900×1600", arg: "900x1600" },
  { id: "1080x1920", label: "16:9", arg: "1080x1920" },
  { id: "1080x2400", label: "20:9", arg: "1080x2400" },
] as const;

export function ScrcpyOptions({
  targetIds,
  serial,
  disabled,
}: {
  targetIds: string[];
  serial: string | null;
  disabled?: boolean;
}) {
  const { options, apply, note, setNote, audioNote, audioError } = useScrcpyOptions({
    targetIds,
    serial,
    disabled,
  });
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

  useEffect(() => {
    if (!serial) return;
    let closed = false;
    let socket: WebSocket | null = null;
    const connect = () => {
      if (closed) return;
      void eventsWsUrlAsync()
        .then((url) => {
          if (closed) return;
          socket = new WebSocket(url);
          socket.onmessage = (event) => {
            try {
              const msg = JSON.parse(String(event.data)) as {
                type?: string;
                serial?: string;
                text?: string;
              };
              if (
                msg.type === "clipboard" &&
                msg.serial === serial &&
                typeof msg.text === "string"
              ) {
                setClip(msg.text);
              }
            } catch {
              // ignore
            }
          };
          socket.onclose = () => {
            if (!closed) setTimeout(connect, 2000);
          };
        })
        .catch(() => {
          if (!closed) setTimeout(connect, 2000);
        });
    };
    connect();
    return () => {
      closed = true;
      socket?.close();
    };
  }, [serial]);

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

  return (
    <div className="flex w-full shrink-0 flex-col items-center gap-1" data-scrcpy-options>
      <div className="flex w-full flex-nowrap items-center justify-start gap-1.5 overflow-x-auto lg:flex-wrap lg:justify-center">
        <label className="flex h-11 shrink-0 items-center gap-1.5 rounded-xl border border-[var(--pc-line)] bg-[var(--pc-panel)]/70 px-2">
          <span className="hidden font-mono text-[10px] uppercase tracking-wide text-[var(--pc-muted)] lg:inline">
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
        <label className="flex h-11 shrink-0 items-center gap-1.5 rounded-xl border border-[var(--pc-line)] bg-[var(--pc-panel)]/70 px-2">
          <span className="hidden font-mono text-[10px] uppercase tracking-wide text-[var(--pc-muted)] lg:inline">
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
                {item.label}
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
          className="h-11 shrink-0 rounded-xl border border-[var(--pc-line)] bg-[var(--pc-panel)]/70 px-3 aria-pressed:border-[var(--pc-accent)] aria-pressed:bg-[var(--pc-accent-soft)] aria-pressed:text-[var(--pc-accent)]"
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
          className="h-11 shrink-0 rounded-xl border border-[var(--pc-line)] bg-[var(--pc-panel)]/70 px-3 aria-pressed:border-[var(--pc-accent)] aria-pressed:bg-[var(--pc-accent-soft)] aria-pressed:text-[var(--pc-accent)]"
        >
          Screen off
        </Toggle>
        <div className="max-lg:hidden lg:contents">
          <input
            aria-label="Clipboard"
            data-scrcpy-clipboard
            value={clip}
            disabled={disabled}
            placeholder="Clipboard"
            onChange={(event) => setClip(event.target.value)}
            className="h-11 min-w-[8rem] flex-1 rounded-xl border border-[var(--pc-line)] bg-[var(--pc-panel)]/70 px-3 font-mono text-xs text-[var(--pc-ink)] outline-none placeholder:text-[var(--pc-muted)]"
          />
          <Button
            type="button"
            variant="ghost"
            disabled={disabled}
            data-scrcpy-to-phone
            onClick={() => void sendToPhone(true)}
            className="h-11 rounded-xl border border-[var(--pc-line)] bg-[var(--pc-panel)] px-3 font-mono text-xs"
          >
            To phone
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={disabled}
            data-scrcpy-from-phone
            onClick={() => void takeFromPhone()}
            className="h-11 rounded-xl border border-[var(--pc-line)] bg-[var(--pc-panel)] px-3 font-mono text-xs"
          >
            From phone
          </Button>
        </div>
      </div>
      {(note || audioError || audioNote) && (
        <p data-scrcpy-note className="max-w-lg truncate text-center font-mono text-[10px] text-[var(--pc-muted)]">
          {note || audioError || audioNote}
        </p>
      )}
    </div>
  );
}
