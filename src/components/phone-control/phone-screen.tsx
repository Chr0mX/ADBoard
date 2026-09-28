"use client";

import { useRef, useState } from "react";
import { Keyboard, Maximize2, Minimize2, MousePointer2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import { cn } from "@/lib/utils";
import { normalizePoint } from "@/lib/devices/coords";
import type { Device, PointerPhase, SessionStatus, TapBroadcast } from "@/lib/devices/types";
import { useDeviceVideo } from "@/hooks/use-device-video";
import { useStoredFlag } from "@/hooks/use-stored-flag";

interface PhoneScreenProps {
  device: Device | null;
  session?: SessionStatus | null;
  keyboardOn: boolean;
  mouseOn: boolean;
  fillWindow: boolean;
  onFillWindowChange: (on: boolean) => void;
  showDevicesButton?: boolean;
  onOpenDevices?: () => void;
  onKeyboardChange: (on: boolean) => void;
  onMouseChange: (on: boolean) => void;
  onPointer: (event: {
    phase: PointerPhase;
    point: { x: number; y: number };
    frameWidth: number;
    frameHeight: number;
  }) => void;
  onNav: (action: "back" | "home" | "recent") => void;
  lastTap: TapBroadcast | null;
  broadcastLabel: string;
}

export function PhoneScreen({
  device,
  session,
  keyboardOn,
  mouseOn,
  fillWindow,
  onFillWindowChange,
  showDevicesButton,
  onOpenDevices,
  onKeyboardChange,
  onMouseChange,
  onPointer,
  onNav,
  lastTap,
  broadcastLabel,
}: PhoneScreenProps) {
  const screenRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ id: number; lastX: number; lastY: number; lastSent: number } | null>(
    null,
  );
  const [ripple, setRipple] = useState<{ x: number; y: number; key: number } | null>(
    null,
  );
  const [showFrame, setShowFrame] = useStoredFlag("phonecontrol-show-frame", true);

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
  const framed = showFrame && !fillWindow;
  const pointerFailed = lastTap?.targets.some((t) => t.inject === "error") ?? false;

  const emitPointer = (phase: PointerPhase, clientX: number, clientY: number) => {
    if (!screenRef.current) return;
    const rect = screenRef.current.getBoundingClientRect();
    const point = normalizePoint(clientX, clientY, rect);
    setRipple((prev) => ({
      x: point.x * 100,
      y: point.y * 100,
      key: phase === "down" ? Date.now() : (prev?.key ?? Date.now()),
    }));
    onPointer({
      phase,
      point,
      frameWidth: frameSize?.width ?? 0,
      frameHeight: frameSize?.height ?? 0,
    });
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (offline || !mouseOn || e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      id: e.pointerId,
      lastX: e.clientX,
      lastY: e.clientY,
      lastSent: performance.now(),
    };
    emitPointer("down", e.clientX, e.clientY);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== e.pointerId) return;
    const now = performance.now();
    const dx = e.clientX - drag.lastX;
    const dy = e.clientY - drag.lastY;
    if (now - drag.lastSent < 16 && dx * dx + dy * dy < 4) return;
    drag.lastX = e.clientX;
    drag.lastY = e.clientY;
    drag.lastSent = now;
    emitPointer("move", e.clientX, e.clientY);
  };

  const finishPointer = (e: React.PointerEvent<HTMLDivElement>, phase: "up" | "cancel") => {
    const drag = dragRef.current;
    if (!drag || drag.id !== e.pointerId) return;
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    emitPointer(phase, e.clientX, e.clientY);
  };

  return (
    <section data-fill={fillWindow ? "1" : "0"} className="flex min-h-0 flex-1 flex-col gap-2">
      {!fillWindow && (decodeState === "unsupported" || decodeState === "error" || awaitingPicture) && (
        <p className="truncate text-center font-mono text-[10px] uppercase tracking-wider text-[var(--pc-muted)]">
          {videoError || streamLabel}
        </p>
      )}

      <div className="flex min-h-0 w-full flex-1 flex-col items-center">
        <div
          className={cn(
            "flex min-h-0 w-full max-w-full flex-1 flex-col items-center",
            framed &&
              "max-w-[380px] rounded-[2rem] border-[3px] border-[var(--pc-frame)] bg-[var(--pc-frame)] shadow-[0_24px_60px_-24px_rgba(15,30,40,0.55)]",
          )}
        >
          {framed && (
            <div className="pointer-events-none mt-2 h-5 w-24 shrink-0 rounded-full bg-black/80" />
          )}

          <div className="flex min-h-0 w-full flex-1 items-center justify-center px-1.5 [container-type:size]">
          <div
            ref={screenRef}
            role="application"
            aria-label="Phone screen"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={(e) => finishPointer(e, "up")}
            onPointerCancel={(e) => finishPointer(e, "cancel")}
            className={cn(
              "relative touch-none overflow-hidden select-none",
              framed && "rounded-[1.55rem]",
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

          <div className={cn("flex shrink-0 items-center justify-center gap-2", framed ? "px-3 py-2" : "py-1.5")}>
            {(
              [
                ["back", "Back"],
                ["home", "Home"],
                ["recent", "Recent"],
              ] as const
            ).map(([action, name]) => (
              <Button
                key={action}
                type="button"
                variant="ghost"
                disabled={offline}
                onClick={() => onNav(action)}
                aria-label={name}
                className={cn(
                  "h-11 min-w-16 rounded-full px-3 font-mono text-xs tracking-wide",
                  framed
                    ? "bg-white/5 text-white/80 hover:bg-white/10 hover:text-white"
                    : "border border-[var(--pc-line)] bg-[var(--pc-panel)] text-[var(--pc-ink)] hover:bg-[var(--pc-accent-soft)]",
                )}
              >
                {name}
              </Button>
            ))}
            {fillWindow && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => onFillWindowChange(false)}
                aria-label="Exit fill"
                className="h-11 min-w-11 rounded-full border border-[var(--pc-line)] bg-[var(--pc-panel)] px-3 text-[var(--pc-ink)]"
              >
                <Minimize2 className="size-4" />
              </Button>
            )}
          </div>
        </div>
      </div>

      {!fillWindow && (
        <div className="flex flex-wrap items-center justify-center gap-1.5">
          <Toggle
            pressed={keyboardOn}
            onPressedChange={onKeyboardChange}
            aria-label="Toggle keyboard injection"
            className="h-11 gap-1.5 rounded-lg border border-[var(--pc-line)] bg-[var(--pc-panel)]/70 px-3 aria-pressed:border-[var(--pc-accent)] aria-pressed:bg-[var(--pc-accent-soft)] aria-pressed:text-[var(--pc-accent)]"
          >
            <Keyboard className="size-4" />
            <span className="hidden sm:inline">Keyboard</span>
          </Toggle>
          <Toggle
            pressed={mouseOn}
            onPressedChange={onMouseChange}
            aria-label="Toggle touch"
            className="h-11 gap-1.5 rounded-lg border border-[var(--pc-line)] bg-[var(--pc-panel)]/70 px-3 aria-pressed:border-[var(--pc-accent)] aria-pressed:bg-[var(--pc-accent-soft)] aria-pressed:text-[var(--pc-accent)]"
          >
            <MousePointer2 className="size-4" />
            <span className="hidden sm:inline">Touch</span>
          </Toggle>
          <Toggle
            pressed={showFrame}
            onPressedChange={setShowFrame}
            aria-label="Toggle phone frame"
            className="h-11 gap-1.5 rounded-lg border border-[var(--pc-line)] bg-[var(--pc-panel)]/70 px-3 aria-pressed:border-[var(--pc-accent)] aria-pressed:bg-[var(--pc-accent-soft)] aria-pressed:text-[var(--pc-accent)]"
          >
            Frame
          </Toggle>
          <Toggle
            pressed={fillWindow}
            onPressedChange={onFillWindowChange}
            aria-label="Fill window"
            className="h-11 gap-1.5 rounded-lg border border-[var(--pc-line)] bg-[var(--pc-panel)]/70 px-3 aria-pressed:border-[var(--pc-accent)] aria-pressed:bg-[var(--pc-accent-soft)] aria-pressed:text-[var(--pc-accent)]"
          >
            <Maximize2 className="size-4" />
            Fill
          </Toggle>
          {showDevicesButton && (
            <Button
              type="button"
              variant="outline"
              className="h-11"
              onClick={onOpenDevices}
            >
              Devices
            </Button>
          )}
        </div>
      )}
      {pointerFailed && lastTap && (
        <p className="truncate text-center font-mono text-[10px] text-[var(--pc-warn)]">
          {lastTap.targets
            .filter((t) => t.inject === "error")
            .map((t) => t.injectDetail || `${t.deviceName} failed`)
            .join(" · ") || `${broadcastLabel} failed`}
        </p>
      )}
    </section>
  );
}
