"use client";

import { useEffect, useRef, useState } from "react";
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
  const [showFrame, setShowFrame] = useState(true);

  useEffect(() => {
    try {
      if (localStorage.getItem("phonecontrol-show-frame") === "0") {
        setShowFrame(false);
      }
    } catch {
      // private mode
    }
  }, []);

  const toggleFrame = (on: boolean) => {
    setShowFrame(on);
    try {
      localStorage.setItem("phonecontrol-show-frame", on ? "1" : "0");
    } catch {
      // ignore
    }
  };

  const { canvasRef, status, decodeState, error: videoError, configured, frameSize } =
    useDeviceVideo(device?.serial);

  const offline = !device || device.status !== "online";
  const showingVideo =
    !offline &&
    configured &&
    decodeState === "decoding" &&
    (status?.stream === "streaming" || session?.stream === "streaming");

  const awaitingPicture =
    !showingVideo &&
    configured &&
    !offline &&
    (status?.stream === "streaming" ||
      status?.stream === "starting" ||
      session?.stream === "streaming" ||
      session?.stream === "starting");

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

  const videoWidth = frameSize?.width || device?.resolution.width || 9;
  const videoHeight = frameSize?.height || device?.resolution.height || 19.5;
  const aspectRatio = `${videoWidth} / ${videoHeight}`;

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

      <div className="flex min-h-0 w-full flex-1 flex-col items-center">
        <div
          className={cn(
            "flex min-h-0 w-full max-w-full flex-1 flex-col items-center",
            showFrame &&
              "max-w-[380px] rounded-[2rem] border-[3px] border-[var(--pc-frame)] bg-[var(--pc-frame)] shadow-[0_24px_60px_-24px_rgba(15,30,40,0.55)]",
          )}
        >
          {showFrame && (
            <div className="pointer-events-none mt-2 h-5 w-24 shrink-0 rounded-full bg-black/80" />
          )}

          <div className="flex min-h-0 w-full flex-1 items-center justify-center px-1.5 [container-type:size]">
          <div
            ref={screenRef}
            role="application"
            aria-label="Phone screen"
            onPointerDown={handlePointer}
            className={cn(
              "relative overflow-hidden",
              showFrame && "rounded-[1.55rem]",
              mouseOn && !offline ? "cursor-crosshair" : "cursor-default",
            )}
            style={{
              aspectRatio,
              width: `min(100cqw, calc(100cqh * ${videoWidth} / ${videoHeight}))`,
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
                  "absolute inset-0 z-[5] h-full w-full",
                  showingVideo ? "opacity-100" : "opacity-0",
                )}
              />
            )}

            {awaitingPicture && (
              <p className="pointer-events-none absolute bottom-3 left-3 right-3 z-20 font-mono text-[10px] uppercase tracking-wider text-white/70">
                {videoError || status?.note || "Waiting for keyframe…"}
              </p>
            )}

            {/* Placeholder / mock chrome when not decoding live video */}
            {!offline && device && !showingVideo && !awaitingPicture && (
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
                      {configured && decodeState === "waiting" && (videoError || "Waiting for H264…")}
                      {configured && decodeState === "unsupported" && "WebCodecs unavailable"}
                      {configured && decodeState === "error" && "Video error"}
                      {configured &&
                        decodeState === "idle" &&
                        (session?.note || status?.note || "Stream idle")}
                      {configured && decodeState === "decoding" && "Live H264"}
                    </p>
                    {videoError && configured && decodeState === "error" && (
                      <p className="mt-2 max-w-[90%] font-mono text-[9px] leading-relaxed text-white/40">
                        {videoError}
                      </p>
                    )}
                    {status?.note && configured && decodeState === "idle" && (
                      <p className="mt-2 max-w-[90%] font-mono text-[9px] leading-relaxed text-white/40">
                        {status.note}
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

          </div>
          </div>

          <div className={cn("flex shrink-0 items-center justify-center gap-3", showFrame ? "px-4 py-3" : "py-2")}>
            {(
              [
                ["back", "◀", "Back"],
                ["home", "HOME", "Home"],
                ["recent", "RECENT", "Recent"],
              ] as const
            ).map(([action, label, name]) => (
              <Button
                key={action}
                type="button"
                variant="ghost"
                size="sm"
                disabled={offline}
                onClick={() => onNav(action)}
                aria-label={name}
                className={cn(
                  "h-8 min-w-12 rounded-full font-mono text-[10px] tracking-wider",
                  showFrame
                    ? "bg-white/5 text-white/80 hover:bg-white/10 hover:text-white"
                    : "border border-[var(--pc-line)] bg-[var(--pc-panel)] text-[var(--pc-ink)] hover:bg-[var(--pc-accent-soft)]",
                )}
              >
                {label}
              </Button>
            ))}
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
        <Toggle
          pressed={showFrame}
          onPressedChange={toggleFrame}
          aria-label="Toggle phone frame"
          className="gap-1.5 rounded-lg border border-[var(--pc-line)] bg-[var(--pc-panel)]/70 px-3 data-[state=on]:border-[var(--pc-accent)] data-[state=on]:bg-[var(--pc-accent-soft)] data-[state=on]:text-[var(--pc-accent)]"
        >
          Frame
        </Toggle>
      </div>
      {lastTap && (
        <p className="truncate text-center font-mono text-[10px] text-[var(--pc-muted)]">
          {lastTap.mode} · {broadcastLabel}
          {lastTap.targets[0]
            ? ` · ${lastTap.targets[0].deviceName} (${lastTap.targets[0].x}, ${lastTap.targets[0].y})`
            : ""}
        </p>
      )}
    </section>
  );
}
