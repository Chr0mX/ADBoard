"use client";

import { agentWsProtocols } from "@/lib/api/auth";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Toggle } from "@/components/ui/toggle";
import { useDesk } from "@/components/adboard/desk/desk-context";
import { devicesClient } from "@/lib/api/client";
import {
  eventsWsUrlAsync,
  postClipboard,
  pullClipboard,
} from "@/lib/scrcpy/client";
import {
  CUSTOM_DEFAULTS,
  CUSTOM_LIMITS,
  QUALITY_HINTS,
  firstError,
  useScrcpyOptions,
} from "@/hooks/use-scrcpy-options";
import { useStayAwake } from "@/hooks/use-stay-awake";
import { useQuietMode } from "@/hooks/use-quiet-mode";
import { Moon } from "lucide-react";
import { useStoredFlag } from "@/hooks/use-stored-flag";
import { CLIPBOARD_SYNC_KEY, useClipboardSyncStatus } from "@/hooks/use-clipboard-sync";
import { SwitchRow } from "@/components/ui/switch";

const SIZE_KEY = "adboard-display-size";
const DISPLAY_SIZES = [
  { id: "native", label: "Each phone", arg: "reset" },
  { id: "900x1600", label: "900×1600", arg: "900x1600" },
  { id: "1080x1920", label: "16:9", arg: "1080x1920" },
  { id: "1080x2400", label: "20:9", arg: "1080x2400" },
  // Size and density, for macros made on a 900×1600, 320 dpi emulator.
  { id: "900x1600@320", label: "900×1600 · 320 dpi", arg: "900x1600@320" },
] as const;

export function ScrcpyOptions({
  targetIds,
  serial,
  disabled,
  align = "center",
  wide = false,
}: {
  targetIds: string[];
  serial: string | null;
  disabled?: boolean;
  /** `start`: rows fill the column edge to edge (side control dock). */
  align?: "center" | "start";
  /** `wide`: the Settings card. Rows fill the card and sit left; otherwise centred and width-limited. */
  wide?: boolean;
}) {
  const start = align === "start";
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
  const targetDevices = desk.devices.filter((device) => targetIds.includes(device.id));
  const stayAwake = useStayAwake(targetDevices);
  const quiet = useQuietMode();
  const [clipboardSync, setClipboardSync] = useStoredFlag(CLIPBOARD_SYNC_KEY, false);
  const clipboardStatus = useClipboardSyncStatus();
  const custom = options.quality === "custom";

  useEffect(() => {
    if (!serial) return;
    let closed = false;
    let socket: WebSocket | null = null;
    const connect = () => {
      if (closed) return;
      void eventsWsUrlAsync()
        .then((url) => {
          if (closed) return;
          socket = new WebSocket(url, agentWsProtocols());
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
    <div className={cn("flex w-full shrink-0 flex-col gap-1", start ? "items-stretch" : "items-center")} data-scrcpy-options data-align={align}>
      <div
        className={cn(
          "flex w-full items-center gap-1.5",
          start
            ? "flex-wrap justify-start [&>*]:flex-1 [&>*]:basis-auto"
            : cn("flex-wrap", wide ? "justify-start" : "justify-center"),
        )}
      >
        <label className="flex h-11 shrink-0 items-center gap-1.5 rounded-xl border border-[var(--pc-line)] bg-[var(--pc-panel)]/70 px-2">
 <span className="hidden font-mono text-[11px] tracking-wide text-[var(--pc-muted)] lg:inline">
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
            <option value="custom">Custom</option>
          </select>
        </label>
        <label className="flex h-11 shrink-0 items-center gap-1.5 rounded-xl border border-[var(--pc-line)] bg-[var(--pc-panel)]/70 px-2">
 <span className="hidden font-mono text-[11px] tracking-wide text-[var(--pc-muted)] lg:inline">
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
          size="md"
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
          size="md"
        >
          Screen off
        </Toggle>
        <Toggle
          pressed={stayAwake.on}
          onPressedChange={(on) => stayAwake.setOn(on)}
          disabled={disabled || stayAwake.busy || !stayAwake.available}
          aria-label="Stay awake"
          title="Keep the phone awake while connected (does not turn the screen off)"
          data-scrcpy-stay-awake
          size="md"
        >
          Stay awake
        </Toggle>
        <Toggle
          pressed={quiet.on}
          onPressedChange={(on) => quiet.toggle(on)}
          disabled={quiet.busy || !quiet.available}
          aria-label="Quiet mode: all screens off and muted"
          title="Every online phone (not just the targets): screen off and sound muted"
          data-scrcpy-quiet
          size="md"
        >
          <Moon className="size-4" />
          Quiet mode
        </Toggle>
        <div
          className={
            start
              ? "grid w-full grid-cols-2 gap-1.5 [&>input]:col-span-2 [&>input]:min-w-0"
              : cn("max-lg:hidden lg:flex lg:w-full lg:items-center lg:gap-1.5", !wide && "lg:mx-auto lg:max-w-xl")
          }
        >
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
      {custom ? (
        <CustomQualityFields
          disabled={disabled}
          maxSize={options.maxSize ?? CUSTOM_DEFAULTS.maxSize}
          videoBitRate={options.videoBitRate ?? CUSTOM_DEFAULTS.videoBitRate}
          maxFps={options.maxFps ?? CUSTOM_DEFAULTS.maxFps}
          onApply={(values) => void apply({ ...options, ...values })}
        />
      ) : (
        <p data-scrcpy-quality-hint className={cn("font-mono text-[11px] text-[var(--pc-muted)]", start && "px-0.5")}>
          {QUALITY_HINTS[options.quality] ?? ""}
        </p>
      )}
      <div className={cn("w-full", !wide && !start && "mx-auto max-w-md")} data-scrcpy-clipboard-sync-row>
        <SwitchRow
          label="Sync clipboard"
          description="Phone copies land on this PC; Ctrl/Cmd+V pastes this PC's clipboard on the target phones"
          checked={clipboardSync}
          onChange={(event) => setClipboardSync(event.target.checked)}
          data-scrcpy-clipboard-sync
        />
      </div>
      {(note || audioError || audioNote || stayAwake.note || quiet.note || (clipboardSync && clipboardStatus)) && (
        <p data-scrcpy-note className="max-w-lg truncate text-center font-mono text-[11px] text-[var(--pc-muted)]">
          {note || audioError || audioNote || stayAwake.note || quiet.note || clipboardStatus}
        </p>
      )}
    </div>
  );
}

/** Custom quality: max size / bitrate / FPS, applied together. */
function CustomQualityFields({
  disabled,
  maxSize,
  videoBitRate,
  maxFps,
  onApply,
}: {
  disabled?: boolean;
  maxSize: number;
  videoBitRate: number;
  maxFps: number;
  onApply: (values: { maxSize: number; videoBitRate: number; maxFps: number }) => void;
}) {
  const [size, setSize] = useState(String(maxSize));
  const [mbps, setMbps] = useState(String(videoBitRate / 1_000_000));
  const [fps, setFps] = useState(String(maxFps));
  const clamp = (value: string, min: number, max: number, fallback: number) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  const submit = () => {
    const next = {
      maxSize: Math.round(clamp(size, CUSTOM_LIMITS.maxSize.min, CUSTOM_LIMITS.maxSize.max, maxSize)),
      videoBitRate: Math.round(
        clamp(mbps, CUSTOM_LIMITS.bitRateMbps.min, CUSTOM_LIMITS.bitRateMbps.max, videoBitRate / 1_000_000) * 1_000_000,
      ),
      maxFps: Math.round(clamp(fps, CUSTOM_LIMITS.maxFps.min, CUSTOM_LIMITS.maxFps.max, maxFps)),
    };
    setSize(String(next.maxSize));
    setMbps(String(next.videoBitRate / 1_000_000));
    setFps(String(next.maxFps));
    onApply(next);
  };
  const field = "h-9 w-20 rounded-lg border border-[var(--pc-line)] bg-[var(--pc-panel)]/70 px-2 font-mono text-xs text-[var(--pc-ink)] outline-none";
  return (
    <form
      // Out-of-range values are clamped on Apply rather than blocked.
      noValidate
      data-scrcpy-custom
      className="flex flex-wrap items-end justify-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
 <label className="flex flex-col gap-0.5 font-mono text-[11px] text-[var(--pc-muted)]">
        Max size px
        <input
          type="number"
          inputMode="numeric"
          min={CUSTOM_LIMITS.maxSize.min}
          max={CUSTOM_LIMITS.maxSize.max}
          step={1}
          value={size}
          disabled={disabled}
          onChange={(event) => setSize(event.target.value)}
          aria-label="Max size in pixels (0 = native)"
          title="Longest side in pixels; 0 keeps the phone's native size"
          data-scrcpy-custom-size
          className={field}
        />
      </label>
 <label className="flex flex-col gap-0.5 font-mono text-[11px] text-[var(--pc-muted)]">
        Bitrate Mbps
        <input
          type="number"
          inputMode="decimal"
          min={CUSTOM_LIMITS.bitRateMbps.min}
          max={CUSTOM_LIMITS.bitRateMbps.max}
          step={0.25}
          value={mbps}
          disabled={disabled}
          onChange={(event) => setMbps(event.target.value)}
          aria-label="Bitrate in megabits per second"
          data-scrcpy-custom-bitrate
          className={field}
        />
      </label>
 <label className="flex flex-col gap-0.5 font-mono text-[11px] text-[var(--pc-muted)]">
        FPS
        <input
          type="number"
          inputMode="numeric"
          min={CUSTOM_LIMITS.maxFps.min}
          max={CUSTOM_LIMITS.maxFps.max}
          step={1}
          value={fps}
          disabled={disabled}
          onChange={(event) => setFps(event.target.value)}
          aria-label="Frames per second"
          data-scrcpy-custom-fps
          className={field}
        />
      </label>
      <button type="submit" disabled={disabled} className="pc-toggle pc-toggle-sm" data-scrcpy-custom-apply>
        Apply
      </button>
    </form>
  );
}
