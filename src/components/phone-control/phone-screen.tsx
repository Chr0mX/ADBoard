"use client";

import { useRef, useState } from "react";
import { Keyboard, MousePointer2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import { cn } from "@/lib/utils";
import { normalizePoint } from "@/lib/devices/coords";
import type { Device, SessionStatus, TapBroadcast } from "@/lib/devices/types";
import { useDeviceVideo } from "@/hooks/use-device-video";

interface PhoneScreenProps {
  device: Device | null;
  session?: SessionStatus | null;
  keyboardOn: boolean;
  mouseOn: boolean;
  onKeyboardChange: (on: boolean) => void;
  onMouseChange: (on: boolean) => void;
  onTap: (point: { x: number; y: number }) => void;
  onNav: (action: "back" | "home" | "recent") => void;
  lastTap: TapBroadcast | null;
  broadcastLabel: string;
}

export function PhoneScreen({
  device,
  session,
  keyboardOn,
  mouseOn,
  onKeyboardChange,
  onMouseChange,
  onTap,
  onNav,
  lastTap,
  broadcastLabel,
}: PhoneScreenProps) {
  const screenRef = useRef<HTMLDivElement>(null);
  const [ripple, setRipple] = useState<{ x: number; y: number; key: number } | null>(
    null,
  );

  const { canvasRef, status, decodeState, error: videoError, configured } =
    useDeviceVideo(device?.serial);

  const offline = !device || device.status !== "online";
  const showingVideo =
    !offline &&
    configured &&
    decodeState === "decoding" &&
    (status?.stream === "streaming" || session?.stream === "streaming");

  const streamLabel = (() => {
    if (!device) return "No device";
    if (!configured) return `${device.name} · local mock`;
    if (decodeState === "unsupported") return `${device.name} · decode unsupported`;
    if (status?.backend) {
      return `${device.name} · ${status.backend}${status.stream ? `/${status.stream}` : ""}`;
    }
    if (session) return `${device.name} · ${session.backend}/${session.stream}`;
    return `${device.name} · video`;
  })();

  const handlePointer = (e: React.PointerEvent<HTMLDivElement>) => {
    if (offline || !mouseOn || !screenRef.current) return;
    const rect = screenRef.current.getBoundingClientRect();
    const point = normalizePoint(e.clientX, e.clientY, rect);
    setRipple({ x: point.x * 100, y: point.y * 100, key: Date.now() });
    onTap(point);
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="font-display text-sm font-semibold tracking-wide text-[var(--pc-ink)]">
          PHONE SCREEN
        </h2>
        <p className="font-mono text-[10px] uppercase tracking-wider text-[var(--pc-muted)]">
          {streamLabel}
        </p>
      </div>

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center">
        <div
          className={cn(
            "relative flex w-full max-w-[min(100%,360px)] flex-col",
            "rounded-[2rem] border-[3px] border-[var(--pc-frame)] bg-[var(--pc-frame)]",
            "shadow-[0_24px_60px_-24px_rgba(15,30,40,0.55)]",
            "transition-[transform,box-shadow] duration-500 ease-out",
            !offline && "hover:-translate-y-0.5",
          )}
        >
          {/* Notch */}
          <div className="absolute left-1/2 top-2 z-20 h-5 w-24 -translate-x-1/2 rounded-full bg-black/80" />

          <div
            ref={screenRef}
            role="application"
            aria-label="Phone screen"
            onPointerDown={handlePointer}
            className={cn(
              "relative mx-1.5 mt-1.5 aspect-[9/19.5] overflow-hidden rounded-[1.55rem]",
              mouseOn && !offline ? "cursor-crosshair" : "cursor-default",
            )}
            style={{
              background: offline
                ? "linear-gradient(160deg, #1a1f24 0%, #0c0e10 100%)"
                : `linear-gradient(165deg,
                    hsl(${device.wallpaperHue} 42% 22%) 0%,
                    hsl(${(device.wallpaperHue + 40) % 360} 35% 14%) 55%,
                    hsl(${(device.wallpaperHue + 80) % 360} 28% 10%) 100%)`,
            }}
          >
            {/* H264 canvas — always mounted when agent configured so decoder can paint */}
            {configured && !offline && (
              <canvas
                ref={canvasRef}
                className={cn(
                  "absolute inset-0 z-[5] h-full w-full object-cover",
                  showingVideo ? "opacity-100" : "opacity-0",
                )}
              />
            )}

            {/* Placeholder / mock chrome when not decoding live video */}
            {!offline && device && !showingVideo && (
              <>
                <div className="pointer-events-none absolute inset-0 opacity-40">
                  <div
                    className="absolute -right-10 top-16 h-40 w-40 rounded-full blur-3xl"
                    style={{
                      background: `hsl(${device.wallpaperHue} 70% 55% / 0.5)`,
                    }}
                  />
                  <div
                    className="absolute -left-8 bottom-24 h-36 w-36 rounded-full blur-3xl"
                    style={{
                      background: `hsl(${(device.wallpaperHue + 90) % 360} 60% 50% / 0.35)`,
                    }}
                  />
                </div>

                <div className="relative z-10 flex h-full flex-col px-4 pb-6 pt-9 text-white">
                  <div className="flex items-center justify-between font-mono text-[10px] opacity-80">
                    <span>09:41</span>
                    <span>
                      {device.battery}% · {device.fps ?? "—"}fps
                    </span>
                  </div>

                  <div className="mt-10 space-y-1">
                    <p className="font-display text-3xl font-bold tracking-tight">
                      {device.name}
                    </p>
                    <p className="text-sm text-white/70">{device.model}</p>
                    <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-white/50">
                      {!configured && "Mock preview (no agent)"}
                      {configured && decodeState === "connecting" && "Connecting video…"}
                      {configured && decodeState === "waiting" && "Waiting for H264…"}
                      {configured && decodeState === "unsupported" && "WebCodecs unavailable"}
                      {configured && decodeState === "error" && "Video error"}
                      {configured &&
                        decodeState === "idle" &&
                        (session?.note || status?.note || "Stream idle")}
                      {configured &&
                        decodeState === "decoding" &&
                        "Decoder ready"}
                    </p>
                    {(videoError || status?.note) && configured && (
                      <p className="mt-2 max-w-[90%] font-mono text-[9px] leading-relaxed text-white/40">
                        {videoError || status?.note}
                      </p>
                    )}
                  </div>

                  <div className="mt-auto grid grid-cols-2 gap-2">
                    {["Messages", "Camera", "Play", "Settings"].map((app) => (
                      <div
                        key={app}
                        className="rounded-2xl border border-white/10 bg-white/10 px-3 py-3 backdrop-blur-sm"
                      >
                        <div className="mb-2 h-7 w-7 rounded-xl bg-white/20" />
                        <span className="text-xs text-white/85">{app}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}

            {offline && (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                <p className="font-display text-lg text-white/90">
                  {device?.status === "unauthorized"
                    ? "Unauthorized"
                    : "No signal"}
                </p>
                <p className="text-xs text-white/50">
                  {device
                    ? "Stream unavailable for this device."
                    : "Select an online device to preview."}
                </p>
              </div>
            )}

            {ripple && (
              <span
                key={ripple.key}
                className="pointer-events-none absolute z-30 h-10 w-10 -translate-x-1/2 -translate-y-1/2 animate-pc-ripple rounded-full border-2 border-white/90 bg-white/25"
                style={{ left: `${ripple.x}%`, top: `${ripple.y}%` }}
              />
            )}

            {lastTap && (
              <div className="pointer-events-none absolute inset-x-3 bottom-3 z-30 rounded-lg border border-white/15 bg-black/55 px-2.5 py-2 backdrop-blur-md">
                <p className="font-mono text-[9px] uppercase tracking-wider text-[var(--pc-signal)]">
                  Broadcast · {lastTap.mode} · {broadcastLabel}
                </p>
                <ul className="mt-1 max-h-16 space-y-0.5 overflow-hidden font-mono text-[10px] text-white/85">
                  {lastTap.targets.map((t) => (
                    <li key={t.deviceId}>
                      {t.deviceName}: ({t.x}, {t.y}) / {t.width}×{t.height}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* Android nav bar area */}
          <div className="flex items-center justify-center gap-6 px-4 py-3">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={offline}
              onClick={() => onNav("back")}
              className="h-8 min-w-10 rounded-full bg-white/5 font-mono text-xs text-white/80 hover:bg-white/10 hover:text-white"
              aria-label="Back"
            >
              ◀
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={offline}
              onClick={() => onNav("home")}
              className="h-8 min-w-14 rounded-full bg-white/5 font-mono text-[10px] tracking-wider text-white/80 hover:bg-white/10 hover:text-white"
            >
              HOME
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={offline}
              onClick={() => onNav("recent")}
              className="h-8 min-w-14 rounded-full bg-white/5 font-mono text-[10px] tracking-wider text-white/80 hover:bg-white/10 hover:text-white"
            >
              RECENT
            </Button>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-2">
        <Toggle
          pressed={keyboardOn}
          onPressedChange={onKeyboardChange}
          aria-label="Toggle keyboard injection"
          className="gap-1.5 rounded-lg border border-[var(--pc-line)] bg-[var(--pc-panel)]/70 px-3 data-[state=on]:border-[var(--pc-accent)] data-[state=on]:bg-[var(--pc-accent-soft)] data-[state=on]:text-[var(--pc-accent)]"
        >
          <Keyboard className="size-3.5" />
          Keyboard
        </Toggle>
        <Toggle
          pressed={mouseOn}
          onPressedChange={onMouseChange}
          aria-label="Toggle mouse injection"
          className="gap-1.5 rounded-lg border border-[var(--pc-line)] bg-[var(--pc-panel)]/70 px-3 data-[state=on]:border-[var(--pc-accent)] data-[state=on]:bg-[var(--pc-accent-soft)] data-[state=on]:text-[var(--pc-accent)]"
        >
          <MousePointer2 className="size-3.5" />
          Mouse
        </Toggle>
      </div>
    </section>
  );
}
