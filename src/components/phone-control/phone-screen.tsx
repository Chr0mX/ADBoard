"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Keyboard, Maximize2, Minimize2, MousePointer2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import { cn } from "@/lib/utils";
import { normalizePoint } from "@/lib/devices/coords";
import type {
  Device,
  NavAction,
  PointerPhase,
  PointerTool,
  SessionStatus,
  StreamStats,
  TapBroadcast,
} from "@/lib/devices/types";
import { useDeviceVideo } from "@/hooks/use-device-video";
import { fitVideoBox } from "@/lib/video/fit-box";
import { postVideoRefresh } from "@/lib/scrcpy/client";
import { ScrcpyOptions } from "@/components/phone-control/scrcpy-options";
import { AppShortcuts } from "@/components/phone-control/app-shortcuts";

interface PhoneScreenProps {
  device: Device | null;
  session?: SessionStatus | null;
  keyboardOn: boolean;
  mouseOn: boolean;
  fillWindow: boolean;
  /** Narrow viewport with fill on: the picture uses the window and controls overlay it. */
  compactFill?: boolean;
  onFillWindowChange: (on: boolean) => void;
  showDevicesButton?: boolean;
  onOpenDevices?: () => void;
  showScreensButton?: boolean;
  onOpenScreens?: () => void;
  onKeyboardChange: (on: boolean) => void;
  onMouseChange: (on: boolean) => void;
  onPointer: (event: {
    phase: PointerPhase;
    point: { x: number; y: number };
    frameWidth: number;
    frameHeight: number;
    tool: PointerTool;
  }) => void;
  onStats?: (stats: StreamStats) => void;
  onNav: (action: NavAction["type"]) => void;
  onInstall: (file: File) => Promise<string>;
  lastTap: TapBroadcast | null;
  broadcastLabel: string;
  targetIds: string[];
}

export function PhoneScreen({
  device,
  session,
  keyboardOn,
  mouseOn,
  fillWindow,
  compactFill = false,
  onFillWindowChange,
  showDevicesButton,
  onOpenDevices,
  showScreensButton,
  onOpenScreens,
  onKeyboardChange,
  onMouseChange,
  onPointer,
  onStats,
  onNav,
  onInstall,
  lastTap,
  broadcastLabel,
  targetIds,
}: PhoneScreenProps) {
  const screenRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const dragRef = useRef<{
    id: number;
    lastX: number;
    lastY: number;
    lastSent: number;
    tool: PointerTool;
  } | null>(null);
  const hoverAt = useRef(0);
  const [refreshToken, setRefreshToken] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [ripple, setRipple] = useState<{ x: number; y: number; key: number } | null>(
    null,
  );
  const [installNote, setInstallNote] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);

  const { canvasRef, status, decodeState, error: videoError, configured, frameSize, frameSizeRef, stats } =
    useDeviceVideo(device?.serial, refreshToken);

  useEffect(() => {
    onStats?.(stats);
  }, [onStats, stats]);

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

  // Live picture size comes from the scrcpy frame. 9/16 is only the placeholder
  // before the first frame; device wm size is not the stream aspect.
  const videoWidth = frameSize?.width || (configured ? 9 : device?.resolution.width || 9);
  const videoHeight = frameSize?.height || (configured ? 16 : device?.resolution.height || 16);
  const fitted = fitVideoBox(stageSize.width, stageSize.height, videoWidth, videoHeight);
  const orientation = videoWidth >= videoHeight ? "landscape" : "portrait";
  // Non-fill keeps a rail on each side of the picture: volume on the left,
  // power on the right. Navigation stays in the row under the stream.
  const sideControls = !fillWindow;
  const railClass =
    "h-11 min-w-11 rounded-full border border-[var(--pc-line)] bg-[var(--pc-panel)] px-3 font-mono text-xs tracking-wide text-[var(--pc-ink)] hover:bg-[var(--pc-accent-soft)]";

  useLayoutEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    const measure = () => {
      const style = getComputedStyle(node);
      const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      // clientWidth includes padding. The picture has to fit the content box
      // or the flex item is shrunk on one axis and the aspect ratio breaks.
      const width = Math.max(0, Math.floor(node.clientWidth - padX));
      const height = Math.max(0, Math.floor(node.clientHeight - padY));
      setStageSize((prev) =>
        prev.width === width && prev.height === height ? prev : { width, height },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [fillWindow, device?.id]);

  const pointerFailed = lastTap?.targets.some((t) => t.inject === "error") ?? false;
  const installFailed = !!installNote && !installNote.startsWith("Installed");

  const emitPointer = (
    phase: PointerPhase,
    clientX: number,
    clientY: number,
    tool: PointerTool,
  ) => {
    if (!screenRef.current) return;
    const rect = screenRef.current.getBoundingClientRect();
    const point = normalizePoint(clientX, clientY, rect);
    if (phase === "down") {
      setRipple({ x: point.x * 100, y: point.y * 100, key: Date.now() });
    }
    const size = frameSizeRef.current;
    onPointer({
      phase,
      point,
      frameWidth: size?.width ?? 0,
      frameHeight: size?.height ?? 0,
      tool,
    });
  };

  const refreshVideo = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      if (targetIds.length > 0) await postVideoRefresh(targetIds);
    } catch {
      // The player still drops its decoder and waits for the next keyframe.
    } finally {
      setRefreshToken((token) => token + 1);
      setRefreshing(false);
    }
  };

  const pickApk = async (file: File) => {
    setInstalling(true);
    try {
      setInstallNote(await onInstall(file));
    } finally {
      setInstalling(false);
    }
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (offline || !mouseOn || e.button !== 0) return;
    e.preventDefault();
    const tool: PointerTool = e.pointerType === "touch" ? "finger" : "mouse";
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      id: e.pointerId,
      lastX: e.clientX,
      lastY: e.clientY,
      lastSent: performance.now(),
      tool,
    };
    emitPointer("down", e.clientX, e.clientY, tool);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag && drag.id === e.pointerId) {
      const now = performance.now();
      const dx = e.clientX - drag.lastX;
      const dy = e.clientY - drag.lastY;
      if (now - drag.lastSent < 16 && dx * dx + dy * dy < 4) return;
      drag.lastX = e.clientX;
      drag.lastY = e.clientY;
      drag.lastSent = now;
      emitPointer("move", e.clientX, e.clientY, drag.tool);
      return;
    }
    if (offline || !mouseOn || e.pointerType === "touch" || e.buttons !== 0) return;
    const now = performance.now();
    if (now - hoverAt.current < 16) return;
    hoverAt.current = now;
    emitPointer("hover", e.clientX, e.clientY, "mouse");
  };

  const handlePointerLeave = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current || offline || !mouseOn || e.pointerType === "touch") return;
    emitPointer("leave", e.clientX, e.clientY, "mouse");
  };

  const finishPointer = (e: React.PointerEvent<HTMLDivElement>, phase: "up" | "cancel") => {
    const drag = dragRef.current;
    if (!drag || drag.id !== e.pointerId) return;
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    emitPointer(phase, e.clientX, e.clientY, drag.tool);
  };

  return (
    <section
      data-fill={fillWindow ? "1" : "0"}
      data-side-controls={sideControls ? "1" : "0"}
      data-device-id={device?.id ?? ""}
      data-device-name={device?.name ?? ""}
      className={cn("relative flex min-h-0 flex-1 flex-col", compactFill ? "gap-0" : "gap-2")}
    >
      {!fillWindow && (decodeState === "unsupported" || decodeState === "error" || awaitingPicture) && (
        <p className="truncate text-center font-mono text-[10px] uppercase tracking-wider text-[var(--pc-muted)]">
          {videoError || streamLabel}
        </p>
      )}

      <div className="flex min-h-0 w-full flex-1 flex-col items-center">
        <div className="flex min-h-0 w-full max-w-full flex-1 flex-col items-center">
          <div className="flex min-h-0 w-full flex-1 items-stretch">
          {sideControls && (
            <div
              data-side-volume
              className="flex shrink-0 flex-col items-center justify-center gap-2 pr-2"
            >
              {(
                [
                  ["volume_up", "Vol+"],
                  ["volume_down", "Vol−"],
                ] as const
              ).map(([action, name]) => (
                <Button
                  key={action}
                  type="button"
                  variant="ghost"
                  disabled={offline}
                  onClick={() => onNav(action)}
                  aria-label={action === "volume_up" ? "Volume up" : "Volume down"}
                  className={railClass}
                >
                  {name}
                </Button>
              ))}
            </div>
          )}
          <div
            ref={stageRef}
            data-screen-stage
            className={cn(
              "relative flex min-h-0 min-w-0 flex-1 items-center justify-center [container-type:size]",
              compactFill || sideControls ? "px-0" : "px-1.5",
            )}
          >
          <div
            ref={screenRef}
            role="application"
            aria-label="Phone screen"
            data-video-orientation={orientation}
            data-video-frame={`${videoWidth}x${videoHeight}`}
            data-video-box={fitted.width > 0 ? `${fitted.width}x${fitted.height}` : ""}
            onPointerEnter={(e) => {
              if (offline || !mouseOn || e.pointerType === "touch" || e.buttons !== 0) return;
              emitPointer("hover", e.clientX, e.clientY, "mouse");
            }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerLeave={handlePointerLeave}
            onPointerUp={(e) => finishPointer(e, "up")}
            onPointerCancel={(e) => finishPointer(e, "cancel")}
            className={cn(
              "relative shrink-0 touch-none overflow-hidden select-none",
              mouseOn && !offline ? "cursor-crosshair" : "cursor-default",
            )}
            style={{
              width:
                fitted.width > 0
                  ? fitted.width
                  : `min(100cqw, calc(100cqh * ${videoWidth} / ${videoHeight}))`,
              height: fitted.height > 0 ? fitted.height : undefined,
              aspectRatio: fitted.width > 0 ? undefined : `${videoWidth} / ${videoHeight}`,
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
                  "absolute inset-0 z-[5] h-full w-full object-contain",
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
          {sideControls && (
            <div
              data-side-power
              className="flex shrink-0 items-center justify-center pl-2"
            >
              <Button
                type="button"
                variant="ghost"
                disabled={offline}
                onClick={() => onNav("power")}
                aria-label="Power"
                className={railClass}
              >
                Power
              </Button>
            </div>
          )}
          </div>

          {!compactFill && (
          <div data-nav-row className="flex shrink-0 flex-wrap items-center justify-center gap-2 py-1.5">
            {(sideControls
              ? ([
                  ["back", "Back"],
                  ["home", "Home"],
                  ["recent", "Recent"],
                ] as const)
              : ([
                  ["back", "Back"],
                  ["home", "Home"],
                  ["recent", "Recent"],
                  ["volume_down", "Vol−"],
                  ["volume_up", "Vol+"],
                  ["power", "Power"],
                ] as const)
            ).map(([action, name]) => (
              <Button
                key={action}
                type="button"
                variant="ghost"
                disabled={offline}
                onClick={() => onNav(action)}
                aria-label={
                  action === "volume_up"
                    ? "Volume up"
                    : action === "volume_down"
                      ? "Volume down"
                      : action === "power"
                        ? "Power"
                        : name
                }
                className={railClass}
              >
                {name}
              </Button>
            ))}
            {fillWindow && (
              <Button
                type="button"
                variant="ghost"
                disabled={offline || refreshing}
                onClick={() => void refreshVideo()}
                aria-label="Refresh video"
                data-video-refresh
                className="h-11 min-w-11 rounded-full border border-[var(--pc-line)] bg-[var(--pc-panel)] px-3 font-mono text-xs text-[var(--pc-ink)]"
              >
                <RefreshCw className="size-4" />
              </Button>
            )}
            {fillWindow && (
              <Toggle
                pressed={keyboardOn}
                onPressedChange={onKeyboardChange}
                aria-label="Toggle keyboard injection"
                className="h-11 min-w-11 rounded-full border border-[var(--pc-line)] bg-[var(--pc-panel)] px-3 text-[var(--pc-ink)] aria-pressed:border-[var(--pc-accent)] aria-pressed:bg-[var(--pc-accent-soft)] aria-pressed:text-[var(--pc-accent)]"
              >
                <Keyboard className="size-4" />
              </Toggle>
            )}
            {fillWindow && (
              <ApkFileButton disabled={offline || installing} onFile={pickApk} />
            )}
            {fillWindow && showScreensButton && (
              <Button
                type="button"
                variant="ghost"
                onClick={onOpenScreens}
                aria-label="Screens"
                className="h-11 min-w-11 rounded-full border border-[var(--pc-line)] bg-[var(--pc-panel)] px-3 text-[var(--pc-ink)]"
              >
                Screens
              </Button>
            )}
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
          )}
        </div>
      </div>

      {compactFill && (
        <div
          data-fill-chrome
          className="flex shrink-0 flex-wrap items-center justify-center gap-2 px-1.5 py-1.5"
        >
          {(
            [
              ["back", "Back"],
              ["home", "Home"],
              ["recent", "Recent"],
              ["volume_down", "Vol−"],
              ["volume_up", "Vol+"],
              ["power", "Power"],
            ] as const
          ).map(([action, name]) => (
            <Button
              key={action}
              type="button"
              variant="ghost"
              disabled={offline}
              onClick={() => onNav(action)}
              aria-label={
                action === "volume_up"
                  ? "Volume up"
                  : action === "volume_down"
                    ? "Volume down"
                    : action === "power"
                      ? "Power"
                      : name
              }
              className="h-11 min-w-11 rounded-full border border-[var(--pc-line)] bg-[var(--pc-panel)] px-3 font-mono text-xs tracking-wide text-[var(--pc-ink)] hover:bg-[var(--pc-accent-soft)]"
            >
              {name}
            </Button>
          ))}
          <Button
            type="button"
            variant="ghost"
            onClick={() => onFillWindowChange(false)}
            aria-label="Exit fill"
            className="h-11 min-w-11 rounded-full border border-[var(--pc-line)] bg-[var(--pc-panel)] px-3 text-[var(--pc-ink)]"
          >
            <Minimize2 className="size-4" />
          </Button>
        </div>
      )}

      {!compactFill && <AppShortcuts />}

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
          <Button
            type="button"
            variant="ghost"
            disabled={offline || refreshing}
            onClick={() => void refreshVideo()}
            aria-label="Refresh video"
            data-video-refresh
            className="h-11 gap-1.5 rounded-lg border border-[var(--pc-line)] bg-[var(--pc-panel)]/70 px-3"
          >
            <RefreshCw className="size-4" />
            <span className="hidden sm:inline">Refresh</span>
          </Button>
          <ApkFileButton disabled={offline || installing} onFile={pickApk} />
          <Toggle
            pressed={fillWindow}
            onPressedChange={onFillWindowChange}
            aria-label="Fill window"
            className="h-11 gap-1.5 rounded-lg border border-[var(--pc-line)] bg-[var(--pc-panel)]/70 px-3 aria-pressed:border-[var(--pc-accent)] aria-pressed:bg-[var(--pc-accent-soft)] aria-pressed:text-[var(--pc-accent)]"
          >
            <Maximize2 className="size-4" />
            Fill
          </Toggle>
          {showScreensButton && (
            <Button
              type="button"
              variant="outline"
              className="h-11"
              onClick={onOpenScreens}
            >
              Screens
            </Button>
          )}
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
      {!compactFill && (
        <ScrcpyOptions
          targetIds={targetIds}
          serial={device?.serial ?? null}
          disabled={offline}
        />
      )}
      {installNote && (
        <p
          data-install-note
          className={cn(
            "mx-auto max-w-lg text-center font-mono text-[10px] leading-snug",
            installFailed ? "text-[var(--pc-warn)]" : "text-[var(--pc-muted)]",
          )}
        >
          {installNote}
        </p>
      )}
      {pointerFailed && lastTap && (
        <p className="truncate text-center font-mono text-[10px] text-[var(--pc-warn)]">
          {[
            ...new Set(
              lastTap.targets
                .filter((t) => t.inject === "error")
                .map((t) => t.injectDetail || `${t.deviceName} failed`),
            ),
          ].join(" · ") || `${broadcastLabel} failed`}
        </p>
      )}
    </section>
  );
}

function ApkFileButton({
  disabled,
  onFile,
}: {
  disabled: boolean;
  onFile: (file: File) => void;
}) {
  return (
    <label
      className={cn(
        "inline-flex h-11 min-w-11 cursor-pointer items-center justify-center rounded-lg border border-[var(--pc-line)] bg-[var(--pc-panel)]/70 px-3 font-mono text-xs text-[var(--pc-ink)]",
        disabled && "pointer-events-none opacity-50",
      )}
    >
      APK
      <input
        type="file"
        accept=".apk,application/vnd.android.package-archive"
        aria-label="Install APK"
        className="sr-only"
        disabled={disabled}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) onFile(file);
        }}
      />
    </label>
  );
}
