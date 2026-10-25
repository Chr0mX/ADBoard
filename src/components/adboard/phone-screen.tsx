"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Camera,
  ChevronDown,
  ChevronUp,
  Circle,
  Keyboard,
  LayoutGrid,
  Maximize2,
  Minimize2,
  MousePointer2,
  Play,
  RefreshCw,
  Smartphone,
  Square,
  Video,
  Zap,
  Mouse,
  RotateCcw,
  Info,
  Grid2x2,
  RotateCwSquare,
  Expand,
  Shrink,
  PictureInPicture2,
} from "lucide-react";
import {
  QUICK_ACTIONS,
  QuickActionsMenu,
  minimizeFloatingPanels,
  useDeviceActions,
} from "@/components/adboard/device-actions";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import { cn } from "@/lib/utils";
import { PC_HIT_LABELED, PC_HIT_TOOL_RESPONSIVE } from "@/lib/ui/control-chrome";
import { normalizePoint } from "@/lib/devices/coords";
import type {
  ControlMode,
  Device,
  NavAction,
  PointerPhase,
  PointerTool,
  SessionStatus,
  TapBroadcast,
} from "@/lib/devices/types";
import { devicesClient } from "@/lib/api/client";
import {
  downloadScreenshots,
  startScreenRecords,
  stopScreenRecords,
} from "@/lib/desk/capture";
import { offlineOverlayCopy } from "@/lib/ui/connection-copy";
import { useFullscreen } from "@/hooks/use-fullscreen";
import { useQuietMode } from "@/hooks/use-quiet-mode";
import { usePictureInPicture } from "@/hooks/use-picture-in-picture";
import { useDocumentPip, type PipPointer } from "@/hooks/use-document-pip";
import { useDeviceVideo } from "@/hooks/use-device-video";
import { useMacroTouches } from "@/lib/macro/runs";
import { TouchRipples } from "@/components/adboard/macros/preview";
import { fitVideoBox } from "@/lib/video/fit-box";
import { postVideoRefresh } from "@/lib/scrcpy/client";
import { ScrcpyOptions } from "@/components/adboard/scrcpy-options";
import { AppShortcuts } from "@/components/adboard/app-shortcuts";
import { DeviceNavBar } from "@/components/adboard/device-nav-bar";
import { FloatingLayer } from "@/components/adboard/floating/floating-layer";
import { TouchScreenGrid } from "@/components/adboard/touch-screen-grid";
import { StatusBar } from "@/components/adboard/status-bar";
import type { MobileStatsMode } from "@/lib/ui/mobile-stats-mode";
import { useDeskOptional } from "@/components/adboard/desk/desk-context";
import { useTaskbarPins } from "@/hooks/use-taskbar-pins";
import { useTaskbarHidden } from "@/hooks/use-taskbar-hidden";
import { runningTabIds, useRunVersion } from "@/lib/macro/runs";
import { useDesktopShortcuts, useShortcutHint } from "@/hooks/use-desktop-shortcuts";
import { gestureStep, makeRecordedMacro, recordedMacros, replayGesture } from "@/lib/desk/gesture";
import { updateLibrary, useLibrary } from "@/lib/desk/store";
import type { GestureSample } from "@/lib/desk/store";

interface PhoneScreenProps {
  device: Device | null;
  devices?: Device[];
  session?: SessionStatus | null;
  keyboardOn: boolean;
  mouseOn: boolean;
  fillWindow: boolean;
  /** Mobile Control: docked chrome is replaced by FloatingLayer. */
  floatingChrome?: boolean;
  /** Mobile multi-device touch grid (replaces single stage). */
  gridView?: boolean;
  statsMode?: MobileStatsMode;
  onStatsModeChange?: (mode: MobileStatsMode) => void;
  onFillWindowChange: (on: boolean) => void;
  onToggleGrid?: () => void;
  onFocusDevice?: (deviceId: string) => void;
  showDevicesButton?: boolean;
  onOpenDevices?: () => void;
  showScreensButton?: boolean;
  onOpenScreens?: () => void;
  onKeyboardChange: (on: boolean) => void;
  onMouseChange: (on: boolean) => void;
  /** Send every pointer as a mouse (Android cursor), even from touch. */
  cursorMode?: boolean;
  onCursorModeChange?: (on: boolean) => void;
  onPointer: (event: {
    phase: PointerPhase;
    point: { x: number; y: number };
    frameWidth: number;
    frameHeight: number;
    tool: PointerTool;
    replay?: boolean;
  }) => void | Promise<unknown>;
  /** Grid view: who receives touches (Selected / Multi / All) and per-tile toggles. */
  controlMode?: ControlMode;
  onControlModeChange?: (mode: ControlMode) => void;
  selectedIds?: Set<string>;
  onToggleSelected?: (deviceId: string, selected: boolean) => void;
  broadcastTargets?: Device[];
  /** Macros panel next to the phone (Control mode). */
  macroDockOpen?: boolean;
  onMacroDockChange?: (open: boolean) => void;
  /** Desktop: put nav + tool rows in a side column (a folded panel freed it). */
  controlsDock?: "bottom" | "left" | "right";
  onNav: (action: NavAction["type"]) => void;
  onInstall: (file: File) => Promise<string>;
  lastTap: TapBroadcast | null;
  broadcastLabel: string;
  targetIds: string[];
}

export function PhoneScreen({
  device,
  devices = [],
  session,
  keyboardOn,
  mouseOn,
  fillWindow,
  floatingChrome = false,
  gridView = false,
  statsMode = "show",
  onStatsModeChange,
  onFillWindowChange,
  onToggleGrid,
  onFocusDevice,
  showDevicesButton,
  onOpenDevices,
  showScreensButton,
  onOpenScreens,
  onKeyboardChange,
  onMouseChange,
  cursorMode = false,
  onCursorModeChange,
  onPointer,
  controlsDock = "bottom",
  controlMode,
  onControlModeChange,
  selectedIds,
  onToggleSelected,
  broadcastTargets,
  macroDockOpen = false,
  onMacroDockChange,
  onNav,
  onInstall,
  lastTap,
  broadcastLabel,
  targetIds,
}: PhoneScreenProps) {
  const desk = useDeskOptional();
  const { pins: taskbarPins } = useTaskbarPins();
  const { hidden: taskbarHiddenNav } = useTaskbarHidden();
  // Re-render when a macro run starts or stops, so the taskbar dot follows it.
  useRunVersion();
  const macroRunning = runningTabIds().length > 0;
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
  const [captureNote, setCaptureNote] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [screenRecording, setScreenRecording] = useState(false);

  // Grid view shows its own tiles; decoding the big screen too would run a
  // second decoder for the same phone.
  const { canvasRef, status, decodeState, error: videoError, configured, frameSize, frameSizeRef } =
    useDeviceVideo(gridView ? null : device?.serial, refreshToken);

  const offline = !device || device.status !== "online";
  const offlineCopy = offlineOverlayCopy(device);
  const captureTargets =
    desk?.targets?.length
      ? desk.targets
      : devices.filter((item) => targetIds.includes(item.id));
  // Restart / device info / quick actions / arrangement, shared with the
  // floating Tools panel and taskbar pins.
  const actions = useDeviceActions({
    targets: captureTargets,
    activeDevice: device,
    gridView: Boolean(gridView),
    onShowGrid: onToggleGrid,
  });
  const [quickAnchor, setQuickAnchor] = useState<HTMLElement | null>(null);
  // Side dock: pad the left edge by the scrollbar's width (0 with overlay
  // scrollbars or no overflow) so the buttons sit centred in the column and
  // the gap to the rail matches the gap to the phone on either side.
  const dockRef = useRef<HTMLElement>(null);
  const sideDockOn = !floatingChrome && !fillWindow && !gridView && controlsDock !== "bottom";
  useLayoutEffect(() => {
    const dock = dockRef.current;
    if (!dock || !sideDockOn) return;
    const fit = () => {
      const bar = dock.offsetWidth - dock.clientWidth;
      // A gap sits between the buttons and the bar on the right, as the left
      // padding (the bar's width) keeps the buttons clear of the rail.
      dock.style.paddingLeft = bar > 0 ? `${bar + 8}px` : "";
      dock.style.paddingRight = bar > 0 ? "8px" : "";
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(dock);
    for (const child of Array.from(dock.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [sideDockOn]);
  // Rotate / Fullscreen / Pop out, shared by More tools, floating Tools and pins.
  const fullscreen = useFullscreen();
  const quiet = useQuietMode();


  // Device name is already the heading inside the screen and in the device
  // list, so this status line only carries the stream state.
  const streamLabel = (() => {
    if (!device) return "No device";
    if (!configured) return "local mock";
    if (decodeState === "unsupported") return "decode unsupported";
    if (status?.backend) {
      return `${status.backend}${status.stream ? `/${status.stream}` : ""}`;
    }
    if (session) return `${session.backend}/${session.stream}`;
    return "video";
  })();

  // Live picture size comes from the scrcpy frame. 9/16 is only the placeholder
  // before the first frame; device wm size is not the stream aspect.
  const videoWidth = frameSize?.width || (configured ? 9 : device?.resolution.width || 9);
  const videoHeight = frameSize?.height || (configured ? 16 : device?.resolution.height || 16);
  // Mobile uses contain (not cover) so status bar / top chrome on the phone
  // stay visible; letterbox bars beat cropping the stream.
  const openFit = fitVideoBox(stageSize.width, stageSize.height, videoWidth, videoHeight);
  // Mobile fill keeps one short control bar. When the picture already leaves a
  // gap (letterbox, or side space in landscape), the bar sits in that gap.
  // When it would cover the picture, the fit gives up one bar of height.
  const fitted = openFit;
  const orientation = videoWidth >= videoHeight ? "landscape" : "portrait";
  // Non-fill keeps a rail on each side of the picture: volume on the left,
  // power on the right. Navigation stays in the row under the stream.
  // Mobile floating chrome owns device nav instead of the side rails.
  const sideControls = !fillWindow && !floatingChrome;
  const showDockedChrome = !floatingChrome;
  const railClass = PC_HIT_LABELED;
  // Responsive tool row: square on narrow residual layouts; labeled on lg+.
  const dockedTools = showDockedChrome && !fillWindow && !gridView;
  // A folded Screens/Devices panel frees a side column for the controls.
  const sideDock = dockedTools && controlsDock !== "bottom" ? controlsDock : null;
  const toolControlClass = sideDock
    ? cn(PC_HIT_LABELED, "w-full justify-start")
    : PC_HIT_TOOL_RESPONSIVE;
  // Tool labels show only when the row itself has room for all of them;
  // otherwise icons (with tooltips) keep the row on a single line. The side
  // column always has room for labels.
  const toolLabelClass = sideDock ? "inline" : "hidden @5xl:inline";
  // More popover only under the phone; the side column shows options inline.
  const optionsPopover = dockedTools && !sideDock;
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const hint = useShortcutHint();

  useEffect(() => {
    if (!moreOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Capture phase: close the menu instead of sending Escape to the phone.
      event.preventDefault();
      event.stopPropagation();
      setMoreOpen(false);
      document.querySelector<HTMLElement>("[data-more-tools]")?.focus();
    };
    const onOutside = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (moreRef.current?.contains(target) || target?.closest?.("[data-more-tools]")) return;
      setMoreOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onOutside, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onOutside, true);
    };
  }, [moreOpen]);

  const navShortcut = (action: "back" | "home" | "recent") => () => {
    if (!offline) onNav(action);
  };
  useDesktopShortcuts(showDockedChrome, {
    back: navShortcut("back"),
    home: navShortcut("home"),
    recent: navShortcut("recent"),
    grid: onToggleGrid,
    fill: gridView ? undefined : () => onFillWindowChange(!fillWindow),
    more: optionsPopover ? () => setMoreOpen((open) => !open) : undefined,
  });
  const navHint = (action: string, name: string) =>
    action === "back" || action === "home" || action === "recent" ? hint(name, action) : {};

  useLayoutEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    const measure = () => {
      const style = getComputedStyle(node);
      const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      // clientWidth includes padding. The picture has to fit the content box
      // or the flex item is shrunk on one axis and the aspect ratio breaks.
      // Non-fill reserves a rail on each side so volume and power sit beside
      // the picture without covering it.
      const rails = fillWindow || floatingChrome ? 0 : 76 * 2 + 16;
      const width = Math.max(0, Math.floor(node.clientWidth - padX - rails));
      const height = Math.max(0, Math.floor(node.clientHeight - padY));
      setStageSize((prev) =>
        prev.width === width && prev.height === height ? prev : { width, height },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [fillWindow, floatingChrome, device?.id]);

  // The observer can miss a stage resize (the stats strip appearing, iOS
  // viewport changes). Then the picture is sized from a stale height and
  // overflows the stage, where overflow-hidden cuts off its top. Re-measure after
  // every render; setState is skipped when the size is unchanged.
  useLayoutEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    const style = getComputedStyle(node);
    const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const rails = fillWindow || floatingChrome ? 0 : 76 * 2 + 16;
    const width = Math.max(0, Math.floor(node.clientWidth - padX - rails));
    const height = Math.max(0, Math.floor(node.clientHeight - padY));
    setStageSize((prev) =>
      prev.width === width && prev.height === height ? prev : { width, height },
    );
  }, [fillWindow, floatingChrome, device?.id, statsMode, gridView]);

  const pointerFailed = lastTap?.targets.some((t) => t.inject === "error") ?? false;
  const installFailed = !!installNote && !installNote.startsWith("Installed");
  const library = useLibrary();
  const gestures = recordedMacros(library.macros);
  const [gestureId, setGestureId] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const [recordedCount, setRecordedCount] = useState(0);
  const recordingRef = useRef(false);
  const samplesRef = useRef<GestureSample[]>([]);
  const recordStartRef = useRef(0);
  const replayStopRef = useRef(false);
  const activeGestureId = gestureId && gestures.some((macro) => macro.id === gestureId)
    ? gestureId
    : (gestures.at(-1)?.id ?? null);

  const emitPointer = (
    phase: PointerPhase,
    clientX: number,
    clientY: number,
    tool: PointerTool,
    target?: DOMRect,
  ) => {
    // `target` is the pop-out window's picture when the input came from there.
    const rect = target ?? screenRef.current?.getBoundingClientRect();
    if (!rect) return;
    const point = normalizePoint(clientX, clientY, rect);
    if (phase === "down") {
      setRipple({ x: point.x * 100, y: point.y * 100, key: Date.now() });
    }
    if (
      recordingRef.current &&
      (phase === "down" || phase === "move" || phase === "up" || phase === "cancel")
    ) {
      const t = Math.max(0, Math.round(performance.now() - recordStartRef.current));
      samplesRef.current.push({ t, phase, x: point.x, y: point.y, tool });
      setRecordedCount(samplesRef.current.length);
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

  // Touch and mouse in the Document PiP window use the same gating and drag
  // tracking as the main screen; only the picture they are measured against differs.
  const pipPointer: PipPointer = (phase, event, rect) => {
    if (phase === "down") {
      if (offline || !mouseOn || event.button !== 0 || replaying) return;
      const tool: PointerTool = cursorMode ? "mouse" : event.pointerType === "touch" ? "finger" : "mouse";
      dragRef.current = { id: event.pointerId, lastX: event.clientX, lastY: event.clientY, lastSent: performance.now(), tool };
      emitPointer("down", event.clientX, event.clientY, tool, rect);
      return;
    }
    const drag = dragRef.current;
    if (!drag || drag.id !== event.pointerId) return;
    if (phase === "move") {
      const now = performance.now();
      const dx = event.clientX - drag.lastX;
      const dy = event.clientY - drag.lastY;
      if (now - drag.lastSent < 16 && dx * dx + dy * dy < 4) return;
      drag.lastX = event.clientX;
      drag.lastY = event.clientY;
      drag.lastSent = now;
      emitPointer("move", event.clientX, event.clientY, drag.tool, rect);
      return;
    }
    dragRef.current = null;
    emitPointer(phase, event.clientX, event.clientY, drag.tool, rect);
  };
  const videoPip = usePictureInPicture(canvasRef);
  const docPip = useDocumentPip(canvasRef, pipPointer);
  const pip = docPip.supported ? docPip : videoPip;
  const toggleFullscreen = fullscreen.supported
    ? () => void fullscreen.toggle().then((error) => error && actions.setNote(error))
    : undefined;
  const togglePip = pip.supported
    ? () => {
        if (!pip.active && !showingVideo) {
          actions.setNote("No live picture to pop out yet");
          return;
        }
        void pip.toggle().then((error) => error && actions.setNote(error));
      }
    : undefined;
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

  const noteFromCapture = (
    rows: { state: string; deviceName: string; detail: string }[],
    fallback: string,
  ) => {
    const failed = rows.filter((row) => row.state !== "ok");
    if (failed.length === 0) {
      return rows[0]?.detail || fallback;
    }
    return failed.map((row) => `${row.deviceName}: ${row.detail}`).join(" · ");
  };

  const takeScreenshot = async () => {
    if (capturing || captureTargets.length === 0) return;
    setCapturing(true);
    try {
      const rows = await downloadScreenshots(captureTargets);
      setCaptureNote(noteFromCapture(rows, "Screenshot saved"));
    } catch (error) {
      setCaptureNote(error instanceof Error ? error.message : "Screenshot failed");
    } finally {
      setCapturing(false);
    }
  };

  const toggleScreenRecord = async () => {
    if (capturing || captureTargets.length === 0) return;
    setCapturing(true);
    try {
      if (screenRecording) {
        const rows = await stopScreenRecords(captureTargets);
        setScreenRecording(false);
        setCaptureNote(noteFromCapture(rows, "Recording stopped"));
      } else {
        const rows = await startScreenRecords(captureTargets);
        const ok = rows.some((row) => row.state === "ok");
        setScreenRecording(ok);
        setCaptureNote(noteFromCapture(rows, "Recording started on device"));
      }
    } catch (error) {
      setCaptureNote(error instanceof Error ? error.message : "Screen record failed");
    } finally {
      setCapturing(false);
    }
  };

  const reconnectDevice = async () => {
    if (!device) return;
    setCapturing(true);
    try {
      const response = await devicesClient.runCommand([device], "reconnect");
      const result = response.results[0];
      setCaptureNote(
        result?.ok ? result.output || "Reconnect sent" : result?.error || "Reconnect failed",
      );
    } catch (error) {
      setCaptureNote(error instanceof Error ? error.message : "Reconnect failed");
    } finally {
      setCapturing(false);
    }
  };

  const startRecording = () => {
    replayStopRef.current = true;
    samplesRef.current = [];
    recordStartRef.current = performance.now();
    recordingRef.current = true;
    setRecordedCount(0);
    setRecording(true);
    setReplaying(false);
    if (!mouseOn) onMouseChange(true);
  };

  const stopRecording = () => {
    recordingRef.current = false;
    setRecording(false);
    const samples = samplesRef.current;
    samplesRef.current = [];
    if (samples.length === 0) return;
    const size = frameSizeRef.current;
    const created = makeRecordedMacro(
      samples,
      `Touch ${gestures.length + 1}`,
      size?.width ?? 0,
      size?.height ?? 0,
    );
    updateLibrary((current) => ({ ...current, macros: [...current.macros, created] }));
    setGestureId(created.id);
  };

  const replayRecording = async () => {
    if (recordingRef.current || replaying) return;
    const macro = gestures.find((item) => item.id === activeGestureId) ?? gestures.at(-1);
    const step = gestureStep(macro);
    const samples = step?.samples;
    if (!samples || samples.length === 0) return;
    replayStopRef.current = false;
    setReplaying(true);
    try {
      await replayGesture(
        samples,
        (sample) =>
          onPointer({
            phase: sample.phase,
            point: { x: sample.x, y: sample.y },
            frameWidth: step.frameWidth || frameSizeRef.current?.width || 0,
            frameHeight: step.frameHeight || frameSizeRef.current?.height || 0,
            tool: sample.tool,
            replay: true,
          }),
        { shouldStop: () => replayStopRef.current },
      );
    } finally {
      if (!replayStopRef.current) setReplaying(false);
    }
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (offline || !mouseOn || e.button !== 0 || replaying) return;
    e.preventDefault();
    const tool: PointerTool = cursorMode ? "mouse" : e.pointerType === "touch" ? "finger" : "mouse";
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

  const gestureButtons = (variant: "side" | "nav" | "tool") => {
    const recordClass =
      variant === "side"
        ? cn(
            PC_HIT_LABELED,
            "w-11 min-w-11 px-0",
          )
        : variant === "nav"
          ? PC_HIT_LABELED
          : toolControlClass;
    const replayClass =
      variant === "side"
        ? cn(PC_HIT_LABELED, "w-11 min-w-11 px-0")
        : variant === "nav"
          ? PC_HIT_LABELED
          : toolControlClass;
    const iconClass = variant === "side" ? "size-5" : "size-4";
    const showLabel = variant === "nav" || variant === "tool";
    return (
      <>
        <Toggle
          size="none"
          tone="warn"
          pressed={recording}
          onPressedChange={(on) => {
            if (on) startRecording();
            else stopRecording();
          }}
          aria-label={recording ? "Stop recording" : "Record touches"}
          data-gesture-record
          className={recordClass}
        >
          {recording ? <Square className={iconClass} /> : <Circle className={iconClass} />}
          {showLabel && (
            <span className={variant === "tool" ? toolLabelClass : undefined}>
              {recording ? "Stop" : "Record"}
            </span>
          )}
        </Toggle>
        <Button
          type="button"
          variant="ghost"
          disabled={recording || replaying || !activeGestureId}
          onClick={() => void replayRecording()}
          aria-label="Replay touches"
          data-gesture-replay
          className={replayClass}
        >
          <Play className={iconClass} />
          {showLabel && (
            <span className={variant === "tool" ? toolLabelClass : undefined}>
              {replaying ? "Playing" : "Replay"}
            </span>
          )}
        </Button>
      </>
    );
  };

  const navRowEl = showDockedChrome ? (
          <div
            data-nav-row
            className={cn(
              "shrink-0 gap-2 py-1.5",
              // Side dock: same left/right edges as the tool buttons.
              sideDock ? "grid grid-cols-3" : "flex flex-wrap items-center justify-center",
            )}
          >
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
                {...navHint(action, name)}
                aria-label={
                  action === "volume_up"
                    ? "Volume up"
                    : action === "volume_down"
                      ? "Volume down"
                      : action === "power"
                        ? "Power"
                        : name
                }
                className={cn(railClass, sideDock && "w-full min-w-0 px-1")}
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
                className={cn(PC_HIT_LABELED, "min-w-11 px-3")}
              >
                <RefreshCw className="size-4" />
              </Button>
            )}
            {fillWindow && (
              <Toggle
          size="none"
                pressed={keyboardOn}
                onPressedChange={onKeyboardChange}
                aria-label="Toggle keyboard injection"
                className={cn(PC_HIT_LABELED, "min-w-11 px-3")}
              >
                <Keyboard className="size-4" />
              </Toggle>
            )}
            {fillWindow && (
              <ApkFileButton disabled={offline || installing} onFile={pickApk} />
            )}
            {fillWindow && (
              <Button
                type="button"
                variant="ghost"
                disabled={offline || capturing || captureTargets.length === 0}
                onClick={() => void takeScreenshot()}
                aria-label="Screenshot and download"
                data-control-screenshot
                className={cn(PC_HIT_LABELED, "min-w-11 px-3")}
              >
                <Camera className="size-4" />
              </Button>
            )}
            {fillWindow && (
              <Button
                type="button"
                variant="ghost"
                disabled={offline || capturing || captureTargets.length === 0}
                onClick={() => void toggleScreenRecord()}
                aria-label={screenRecording ? "Stop screen record" : "Start screen record"}
                data-control-screenrecord
                data-pressed={screenRecording ? "true" : undefined}
                className={cn(
                  PC_HIT_LABELED,
                  "min-w-11 px-3",
                  "pc-toggle-warn",
                )}
              >
                <Video className="size-4" />
              </Button>
            )}
            {fillWindow && showScreensButton && (
              <Button
                type="button"
                variant="ghost"
                onClick={onOpenScreens}
                aria-label="Screens"
                className={cn(PC_HIT_LABELED, "min-w-11 px-3")}
              >
                Screens
              </Button>
            )}
            {fillWindow && onToggleGrid && (
              <Toggle
          size="none"
                pressed={gridView}
                onPressedChange={() => onToggleGrid()}
                aria-label={gridView ? "Exit grid view" : "Grid view"}
                {...hint(gridView ? "Exit grid view" : "Grid view", "grid")}
                data-grid-view={gridView ? "1" : "0"}
                className={cn(PC_HIT_LABELED, "min-w-11 px-3")}
              >
                <LayoutGrid className="size-4" />
              </Toggle>
            )}
            {fillWindow && gestureButtons("nav")}
            {fillWindow && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => onFillWindowChange(false)}
                aria-label="Exit fill"
                {...hint("Exit fill", "fill")}
                className={cn(PC_HIT_LABELED, "min-w-11 px-3")}
              >
                <Minimize2 className="size-4" />
              </Button>
            )}
          </div>
  ) : null;

  const controlsEl = (
    <>
      {showDockedChrome && !gridView && <AppShortcuts />}

      {showDockedChrome && !fillWindow && !gridView && gestures.length > 1 && (
        <select
          aria-label="Recorded touch"
          data-gesture-pick
          value={activeGestureId ?? ""}
          onChange={(event) => setGestureId(event.target.value)}
          className="h-9 w-full rounded-lg border border-[var(--pc-line)] bg-[var(--pc-panel)]/70 px-2 font-mono text-xs text-[var(--pc-ink)] lg:mx-auto lg:h-11 lg:w-auto lg:max-w-[9rem]"
        >
          {gestures.map((macro) => (
            <option key={macro.id} value={macro.id}>
              {macro.name}
            </option>
          ))}
        </select>
      )}
      {showDockedChrome && !gridView && (
      <div className="relative flex w-full min-w-0 flex-col items-center gap-1">
      {dockedTools && (
        <div
          data-tool-row
          className={
            sideDock
              ? "flex w-full min-w-0 flex-col gap-1.5"
              : "@container grid w-full min-w-0 auto-cols-fr grid-flow-col items-center justify-items-center gap-1 lg:flex lg:flex-wrap lg:justify-center lg:gap-1.5"
          }
        >
          <Toggle
          size="none"
            pressed={keyboardOn}
            onPressedChange={onKeyboardChange}
            aria-label="Toggle keyboard injection"
            className={cn(
              toolControlClass,
            )}
          >
            <Keyboard className="size-4" />
            <span className={toolLabelClass}>Keyboard</span>
          </Toggle>
          <Toggle
          size="none"
            pressed={mouseOn}
            onPressedChange={onMouseChange}
            aria-label="Toggle touch"
            className={cn(
              toolControlClass,
            )}
          >
            <MousePointer2 className="size-4" />
            <span className={toolLabelClass}>Touch</span>
          </Toggle>
          {gestureButtons("tool")}
          {recording && (
            <span
              data-gesture-count
              className="hidden font-mono text-[11px] text-[var(--pc-warn)] lg:inline"
            >
              {recordedCount}
            </span>
          )}
          <Button
            type="button"
            variant="ghost"
            disabled={offline || refreshing}
            onClick={() => void refreshVideo()}
            aria-label="Refresh video"
            data-video-refresh
            className={toolControlClass}
          >
            <RefreshCw className="size-4" />
            <span className={toolLabelClass}>Refresh</span>
          </Button>
          <ApkFileButton
            disabled={offline || installing}
            onFile={pickApk}
            className={cn(toolControlClass, "font-mono text-[11px] leading-none lg:text-xs")}
          />
          <Button
            type="button"
            variant="ghost"
            disabled={offline || capturing || captureTargets.length === 0}
            onClick={() => void takeScreenshot()}
            aria-label="Screenshot and download"
            data-control-screenshot
            className={toolControlClass}
          >
            <Camera className="size-4" />
            <span className={toolLabelClass}>Shot</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={offline || capturing || captureTargets.length === 0}
            onClick={() => void toggleScreenRecord()}
            aria-label={screenRecording ? "Stop screen record" : "Start screen record"}
            data-control-screenrecord
            data-pressed={screenRecording ? "true" : undefined}
            className={cn(
              toolControlClass,
              "pc-toggle-warn",
            )}
          >
            <Video className="size-4" />
            <span className={toolLabelClass}>{screenRecording ? "Stop" : "Rec"}</span>
          </Button>
          <Toggle
          size="none"
            pressed={fillWindow}
            onPressedChange={onFillWindowChange}
            aria-label="Fill window"
            {...hint("Fill window", "fill")}
            className={cn(
              toolControlClass,
              "hidden lg:inline-flex",
            )}
          >
            <Maximize2 className="size-4" />
            <span className={toolLabelClass}>Fill</span>
          </Toggle>
          {onToggleGrid && (
            <Toggle
          size="none"
              pressed={gridView}
              onPressedChange={() => onToggleGrid()}
              aria-label={gridView ? "Exit grid view" : "Grid view"}
              {...hint("Grid view", "grid")}
              data-grid-view={gridView ? "1" : "0"}
              className={cn(
                toolControlClass,
                "hidden lg:inline-flex",
                )}
            >
              <LayoutGrid className="size-4" />
              <span className={toolLabelClass}>Grid</span>
            </Toggle>
          )}
          {onMacroDockChange && (
            <Toggle
          size="none"
              pressed={macroDockOpen}
              onPressedChange={(on) => onMacroDockChange(on)}
              aria-label={macroDockOpen ? "Hide macro" : "Macro"}
              data-macro-dock-toggle={macroDockOpen ? "1" : "0"}
              className={cn(
                toolControlClass,
                // Label always shows: under the icon in a square slot, beside it when there is room.
                !sideDock && "flex-col gap-0.5 @5xl:flex-row @5xl:gap-1.5",
              )}
            >
              <Zap className="size-4" />
              <span
                data-macro-label
                className={sideDock ? "inline" : "text-[11px] leading-none @5xl:text-xs @5xl:leading-4"}
              >
                Macro
              </span>
            </Toggle>
          )}
          {showScreensButton && (
            <Button
              type="button"
              variant="ghost"
              aria-label="Screens"
              className={toolControlClass}
              onClick={onOpenScreens}
            >
              <LayoutGrid className="size-4 @5xl:hidden" />
              <span className={toolLabelClass}>Screens</span>
            </Button>
          )}
          {showDevicesButton && (
            <Button
              type="button"
              variant="ghost"
              aria-label="Devices"
              className={toolControlClass}
              onClick={onOpenDevices}
            >
              <Smartphone className="size-4 @5xl:hidden" />
              <span className={toolLabelClass}>Devices</span>
            </Button>
          )}
          {optionsPopover && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => setMoreOpen((open) => !open)}
            aria-label="More tools"
            aria-expanded={moreOpen}
            aria-controls="pc-more-tools"
            {...hint("More tools", "more")}
            data-more-tools
            className={cn(
              toolControlClass,
            )}
          >
            {moreOpen ? <ChevronDown className="size-4" /> : <ChevronUp className="size-4" />}
            <span className={toolLabelClass}>More</span>
          </Button>
          )}
        </div>
      )}
      {/*
        One mounted ScrcpyOptions for both layouts (it holds the clipboard
        socket). Docked: a popover above the tool row, hidden until More.
        Fill: inline under the nav row, as before.
      */}
      <div
        ref={moreRef}
        id="pc-more-tools"
        role={optionsPopover ? "group" : undefined}
        aria-label={optionsPopover ? "More tools" : undefined}
        hidden={optionsPopover && !moreOpen}
        data-more-tools-panel={optionsPopover ? (moreOpen ? "open" : "closed") : sideDock ? "inline" : undefined}
        className={cn(
          "w-full",
          optionsPopover &&
            "absolute bottom-full left-1/2 z-30 mb-2 w-[min(40rem,100%)] -translate-x-1/2 rounded-2xl border border-[var(--pc-line)] bg-[var(--pc-panel)] p-2 shadow-lg",
        )}
      >
        <ScrcpyOptions
          targetIds={targetIds}
          serial={device?.serial ?? null}
          disabled={offline}
          align={sideDock ? "start" : "center"}
        />
        <div
          data-device-actions
          className={cn(
            "mt-2 flex gap-1.5 border-t border-[var(--pc-line)] pt-2",
            // Side dock: one full-width column, like the tool buttons.
            sideDock ? "flex-col items-stretch [&>button]:w-full [&>button]:justify-start" : "flex-wrap items-center",
          )}
        >
          {onCursorModeChange && (
            <Toggle
              size="md"
              pressed={cursorMode}
              onPressedChange={(on) => onCursorModeChange(on)}
              aria-label="Cursor mode"
              title="Cursor: send clicks as a mouse so the phone shows a pointer"
              data-cursor-mode={cursorMode ? "1" : "0"}
            >
              <Mouse className="size-4" />
              Cursor
            </Toggle>
          )}
          <button type="button" className="pc-toggle pc-toggle-md" disabled={offline || actions.busy} onClick={actions.restart} data-device-restart>
            <RotateCcw className="size-4" />
            Restart device
          </button>
          <button type="button" className="pc-toggle pc-toggle-md" onClick={actions.openInfo} data-device-info-open>
            <Info className="size-4" />
            Device info
          </button>
          {onToggleGrid && (
            <button type="button" className="pc-toggle pc-toggle-md" onClick={actions.openArrangement} data-open-arrangement>
              <Grid2x2 className="size-4" />
              Arrangement
            </button>
          )}
          <button
            type="button"
            className="pc-toggle pc-toggle-md"
            disabled={offline || actions.busy}
            onClick={actions.rotate}
            title="Rotate the phone a quarter turn (needs the live screen)"
            data-device-rotate
          >
            <RotateCwSquare className="size-4" />
            Rotate
          </button>
          {toggleFullscreen && (
            <Toggle
              size="md"
              pressed={fullscreen.active}
              onPressedChange={toggleFullscreen}
              aria-label={fullscreen.active ? "Exit fullscreen" : "Fullscreen"}
              title="Browser fullscreen (Esc leaves). Fill window only resizes inside the page."
              data-fullscreen-toggle
            >
              {fullscreen.active ? <Shrink className="size-4" /> : <Expand className="size-4" />}
              Fullscreen
            </Toggle>
          )}
          {togglePip && (
            <Toggle
              size="md"
              pressed={pip.active}
              onPressedChange={togglePip}
              disabled={offline}
              aria-label="Pop out (always on top)"
              title="Window that stays on top. In Chrome and Edge you can tap and drag the picture in it to control the phone."
              data-pip-toggle
            >
              <PictureInPicture2 className="size-4" />
              Pop out
            </Toggle>
          )}
 <span className={cn("font-mono text-[11px] tracking-wider text-[var(--pc-muted)]", sideDock ? "mt-1 px-0.5" : "mx-1")}>Device actions</span>
          {QUICK_ACTIONS.map((item) => (
            <button
              key={item.op}
              type="button"
              title={item.hint}
              className={cn("pc-toggle pc-toggle-md", item.op === "shutdown" && "pc-toggle-warn")}
              disabled={offline || actions.busy}
              data-quick-action={item.op}
              onClick={() => actions.quick(item.op)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      </div>
      )}
    </>
  );

  return (
    <section
      data-fill={fillWindow ? "1" : "0"}
      data-recording={recording ? "1" : "0"}
      data-side-controls={sideControls ? "1" : "0"}
      data-device-id={device?.id ?? ""}
      data-device-name={device?.name ?? ""}
      className={cn(
        "relative flex min-h-0 flex-1 flex-col",
        floatingChrome ? "gap-0" : "gap-2",
      )}
    >
      {!fillWindow && !gridView && (decodeState === "unsupported" || decodeState === "error" || awaitingPicture) && (
 <p className="truncate text-center font-mono text-[11px] tracking-wider text-[var(--pc-muted)]">
          {videoError || streamLabel}
        </p>
      )}

      <div
        data-controls-layout={sideDock ?? "bottom"}
        className={sideDock ? cn("flex min-h-0 w-full flex-1 gap-3", sideDock === "left" && "flex-row-reverse") : "contents"}
      >
      {/* Mirror the side dock's width so the phone stays centred in the window. */}
      {sideDock && <div aria-hidden className="w-[200px] shrink-0 xl:w-[240px]" />}
      <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col">
        {gridView ? (
          <TouchScreenGrid
            devices={devices}
            activeId={device?.id ?? null}
            mouseOn={mouseOn}
            layout={floatingChrome ? "mobile" : "desktop"}
            showTitle={floatingChrome || fillWindow}
            onFocusDevice={(deviceId) => onFocusDevice?.(deviceId)}
            onExit={onToggleGrid}
            controlMode={controlMode}
            onControlModeChange={onControlModeChange}
            selectedIds={selectedIds}
            onToggleSelected={onToggleSelected}
            broadcastTargets={broadcastTargets}
            onNav={floatingChrome ? undefined : onNav}
            macrosOpen={macroDockOpen}
            cursorMode={cursorMode}
            onToggleMacros={onMacroDockChange ? () => onMacroDockChange(!macroDockOpen) : undefined}
          />
        ) : (
        <div className="flex min-h-0 w-full max-w-full flex-1 flex-col">
          <div
            ref={stageRef}
            data-screen-stage
            className={cn(
              "relative flex min-h-0 w-full flex-1 items-center justify-center overflow-hidden",
              floatingChrome && "bg-black",
              sideControls && "gap-2",
            )}
          >
          {sideControls && (
            <div
              data-side-volume
              className="flex w-[4.75rem] shrink-0 flex-col items-center justify-center gap-2"
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
              recording && "ring-2 ring-[var(--pc-warn)]",
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
            {device && <MacroRipples deviceId={device.id} />}

            {awaitingPicture && (
 <p className="pointer-events-none absolute bottom-3 left-3 right-3 z-20 font-mono text-[11px] tracking-wider text-white/70">
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
                  <div className="flex items-center justify-between font-mono text-[11px] opacity-80">
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
 <p className="font-mono text-[11px] tracking-[0.2em] text-white/50">
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
                      <p className="mt-2 max-w-[90%] font-mono text-[11px] leading-relaxed text-white/40">
                        {videoError}
                      </p>
                    )}
                    {status?.note && configured && decodeState === "idle" && (
                      <p className="mt-2 max-w-[90%] font-mono text-[11px] leading-relaxed text-white/40">
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
              <div className="relative z-20 flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                <p className="font-display text-lg text-white/90">{offlineCopy.title}</p>
                <p className="max-w-xs text-xs text-white/55">{offlineCopy.body}</p>
                {offlineCopy.showReconnect && device && (
                  <Button
                    type="button"
                    variant="outline"
                    data-reconnect
                    disabled={capturing}
                    className="h-11 min-h-11 border-white/30 bg-white/10 text-white hover:bg-white/20"
                    onClick={() => void reconnectDevice()}
                  >
                    Reconnect
                  </Button>
                )}
              </div>
            )}
            {!offline &&
              (status?.stream === "error" || session?.stream === "error") &&
              !showingVideo && (
                <div className="pointer-events-none absolute inset-x-3 bottom-3 z-20 rounded-xl border border-[var(--pc-warn)]/40 bg-black/55 px-3 py-2 text-left">
                  <p className="font-display text-sm text-[var(--pc-warn)]">Stream error</p>
                  <p className="mt-0.5 font-mono text-[11px] text-white/70">
                    {status?.note ||
                      session?.note ||
                      "Video dropped. Tap Refresh, or Reconnect from the device menu."}
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
          {sideControls && (
            <div
              data-side-power
              className="flex w-[4.75rem] shrink-0 items-center justify-center"
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

          {!sideDock && navRowEl}
        </div>
        )}
        {floatingChrome && (
          <div
            data-mobile-bottom-chrome
            className="flex w-full max-w-full shrink-0 flex-col items-center gap-1 bg-gradient-to-t from-[color-mix(in_srgb,var(--pc-frame)_70%,transparent)] via-[color-mix(in_srgb,var(--pc-frame)_35%,transparent)] to-transparent px-2 pb-[max(0.35rem,env(safe-area-inset-bottom))] pt-1.5"
          >
            <DeviceNavBar
              onMinimize={minimizeFloatingPanels}
              offline={offline}
              onNav={onNav}
              className="mx-auto"
              safeBottom={false}
              compact
              pinnedTools={taskbarPins}
              hiddenNav={taskbarHiddenNav}
              onEditTaskbar={() => desk?.open("settings")}
              toolHandlers={{
                keyboardOn,
                mouseOn,
                recording,
                replaying,
                refreshing,
                installing,
                gridView: Boolean(gridView),
                statsMode,
                onKeyboardChange,
                onMouseChange,
                onRecordToggle: () => {
                  if (recording) stopRecording();
                  else startRecording();
                },
                onReplay: () => {
                  void replayRecording();
                },
                onRefresh: () => {
                  void refreshVideo();
                },
                onInstallFile: (file) => {
                  void pickApk(file);
                },
                onToggleGrid: () => onToggleGrid?.(),
                onStatsModeChange: (mode) => onStatsModeChange?.(mode),
                onOpenDevices: () => onOpenDevices?.(),
                onOpenDesk: () => desk?.open("manage"),
                cursorMode,
                onCursorModeChange,
                onRestart: actions.restart,
                onOpenInfo: actions.openInfo,
                onQuickActions: (anchor) => setQuickAnchor(anchor),
                onRotate: actions.rotate,
                fullscreen: fullscreen.active,
                onFullscreen: toggleFullscreen,
                pip: pip.active,
                onPip: togglePip,
                quiet: quiet.on,
                onQuietChange: quiet.toggle,
                onOpenMacros: onMacroDockChange ? () => onMacroDockChange(true) : undefined,
                macroRunning,
                onScreenshot: () => void takeScreenshot(),
                screenRecording,
                onScreenRecordToggle: () => void toggleScreenRecord(),
              }}
            />
            {statsMode === "show" && (
              <StatusBar
                device={device}
                session={session}
                safeBottom={false}
                compact
                marquee
              />
            )}
          </div>
        )}
      </div>

      {sideDock && (
        <aside
          ref={dockRef}
          data-controls-dock={sideDock}
          className="pc-side-dock flex min-h-0 w-[200px] shrink-0 flex-col gap-3 overflow-y-auto pb-2 xl:w-[240px]"
        >
          {navRowEl}
          {controlsEl}
        </aside>
      )}
      </div>
      {sideDock ? null : controlsEl}
      {floatingChrome && (
        <FloatingLayer
          device={device}
          session={session}
          statsMode={statsMode}
          onStatsModeChange={onStatsModeChange}
          targetIds={targetIds}
          offline={offline}
          gridView={gridView}
          keyboardOn={keyboardOn}
          mouseOn={mouseOn}
          recording={recording}
          replaying={replaying}
          refreshing={refreshing}
          installing={installing}
          capturing={capturing}
          screenRecording={screenRecording}
          onKeyboardChange={onKeyboardChange}
          onMouseChange={onMouseChange}
          onRecordToggle={() => {
            if (recording) stopRecording();
            else startRecording();
          }}
          onReplay={() => void replayRecording()}
          onRefresh={() => void refreshVideo()}
          onInstallFile={(file) => void pickApk(file)}
          onScreenshot={() => void takeScreenshot()}
          onScreenRecordToggle={() => void toggleScreenRecord()}
          onOpenDevices={() => onOpenDevices?.()}
          onOpenMacros={onMacroDockChange ? () => onMacroDockChange(true) : undefined}
          cursorMode={cursorMode}
          onCursorModeChange={onCursorModeChange}
          onRestart={actions.restart}
          onOpenInfo={actions.openInfo}
          onQuickActions={(anchor) => setQuickAnchor(anchor)}
          onRotate={actions.rotate}
          fullscreen={fullscreen.active}
          onFullscreen={toggleFullscreen}
          pip={pip.active}
          onPip={togglePip}
          onToggleGrid={() => onToggleGrid?.()}
          onOpenDesk={(section) => desk?.open(section)}
        />
      )}
      {actions.dialog}
      {quickAnchor && (
        <QuickActionsMenu
          anchor={quickAnchor}
          busy={actions.busy}
          onPick={actions.quick}
          onClose={() => setQuickAnchor(null)}
        />
      )}
      {actions.note && (
        <p
          data-device-action-note
          role="status"
          className={cn(
            "mx-auto flex max-w-lg items-center justify-center gap-2 text-center font-mono text-[11px] leading-snug",
            /fail|error|no online|no phone/i.test(actions.note) ? "text-[var(--pc-warn)]" : "text-[var(--pc-muted)]",
          )}
        >
          {actions.note}
          <button type="button" className="underline" onClick={actions.clearNote}>
            dismiss
          </button>
        </p>
      )}
      {(installNote || captureNote) && (
        <p
          data-install-note={installNote ? true : undefined}
          data-capture-note={captureNote ? true : undefined}
          className={cn(
            "mx-auto max-w-lg text-center font-mono text-[11px] leading-snug",
            (installFailed ||
              (captureNote &&
                /fail|error|unavailable|no devices/i.test(captureNote)))
              ? "text-[var(--pc-warn)]"
              : "text-[var(--pc-muted)]",
          )}
        >
          {captureNote || installNote}
        </p>
      )}
      {pointerFailed && lastTap && (
        <p className="truncate text-center font-mono text-[11px] text-[var(--pc-warn)]">
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
  className,
}: {
  disabled: boolean;
  onFile: (file: File) => void;
  className?: string;
}) {
  return (
    <label
      className={cn(
        "inline-flex h-11 min-w-11 cursor-pointer items-center justify-center rounded-xl border border-[var(--pc-line)] bg-[var(--pc-panel)]/70 px-3 font-mono text-xs text-[var(--pc-ink)]",
        className,
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

/** Where a running macro is touching this phone, over the live picture. */
function MacroRipples({ deviceId }: { deviceId: string }) {
  const touches = useMacroTouches(deviceId);
  return <TouchRipples touches={touches} />;
}
