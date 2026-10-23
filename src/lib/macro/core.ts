/**
 * Touch macros: virtual tabs of single- and multi-touch steps.
 *
 * Coordinates are stored in the tab's reference resolution (pixels of the
 * screen the macro was made on) and scaled to each phone when it runs. The
 * format reads Auto Clicker (com.truedevelopersstudio.automatictap) config
 * exports and ADBoard's older Automate macros.
 *
 * Pure module: no React, no browser APIs, so it runs under `node --test`.
 */

export const MACRO_FORMAT = "adboard-macros";
export const MACRO_VERSION = 1;
export const MAX_FINGERS = 10;
export const MAX_STEPS = 500;
export const MAX_TABS = 50;
export const MIN_TOUCH_MS = 10;
export const MAX_TOUCH_MS = 60_000;
export const MAX_DELAY_MS = 3_600_000;
export const MIN_REFERENCE = 100;
export const MAX_REFERENCE = 8192;

export interface Size {
  width: number;
  height: number;
}

export interface MacroFinger {
  id: string;
  /** Reference pixels. */
  x: number;
  y: number;
  /** End point of a swipe. Missing means the finger stays put (tap / hold). */
  toX?: number;
  toY?: number;
  /** Milliseconds after the step starts. */
  startMs: number;
  durationMs: number;
}

export interface MacroStep {
  id: string;
  label: string;
  enabled: boolean;
  /** One finger is single-touch; more play at the same time. */
  fingers: MacroFinger[];
  /** Wait after the step, before the next one. */
  delayMs: number;
}

export type StopMode = "infinite" | "time" | "cycles";
export type ScaleMode = "stretch" | "fit";
export type OrientationPolicy = "match" | "any";

export interface MacroStop {
  mode: StopMode;
  seconds: number;
  cycles: number;
}

export interface MacroSource {
  kind: "adboard" | "autoclicker" | "desk-macro";
  file?: string;
  importedAt?: number;
  /** Auto Clicker config id. */
  originalId?: number;
}

export interface MacroTab {
  id: string;
  name: string;
  reference: Size;
  scale: ScaleMode;
  orientation: OrientationPolicy;
  stop: MacroStop;
  /** Random offset per touch, in reference pixels (Auto Clicker "anti-detection"). */
  jitterPx: number;
  steps: MacroStep[];
  /** Phones this tab runs on. */
  targetIds: string[];
  /**
   * Screen density the macro was made at (e.g. 320). Touches are scaled by
   * resolution only, but games lay out in dp, so phones should match this
   * density too for taps to land on the same buttons. Optional.
   */
  referenceDpi?: number;
  notes: string;
  source?: MacroSource;
  createdAt: number;
  updatedAt: number;
}

export interface MacroFile {
  format: typeof MACRO_FORMAT;
  version: number;
  app: "ADBoard";
  exportedAt: string;
  tabs: MacroTab[];
}

export interface StrokeOut {
  pointer: number;
  startMs: number;
  durationMs: number;
  points: Array<{ x: number; y: number }>;
}

export const REFERENCE_PRESETS: Size[] = [
  { width: 720, height: 1280 },
  { width: 720, height: 1600 },
  { width: 900, height: 1600 },
  { width: 1080, height: 1920 },
  { width: 1080, height: 2340 },
  { width: 1080, height: 2400 },
  { width: 1440, height: 2560 },
  { width: 1440, height: 3200 },
];

let counter = 0;
export function macroId(prefix: string) {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round = (n: number) => Math.round(n);

export function newFinger(x: number, y: number, patch: Partial<MacroFinger> = {}): MacroFinger {
  return { id: macroId("f"), x: round(x), y: round(y), startMs: 0, durationMs: 50, ...patch };
}

export function newStep(fingers: MacroFinger[], patch: Partial<MacroStep> = {}): MacroStep {
  return { id: macroId("s"), label: "", enabled: true, fingers, delayMs: 300, ...patch };
}

export function newTab(name: string, patch: Partial<MacroTab> = {}): MacroTab {
  const now = Date.now();
  return {
    id: macroId("tab"),
    name,
    reference: { width: 1080, height: 2400 },
    scale: "stretch",
    // Phones report their natural size, not the current rotation, so skipping
    // by orientation is opt-in.
    orientation: "any",
    stop: { mode: "cycles", seconds: 300, cycles: 10 },
    jitterPx: 0,
    steps: [],
    targetIds: [],
    notes: "",
    createdAt: now,
    updatedAt: now,
    ...patch,
  };
}

/** Copy with fresh ids so it never shares state with the original. */
export function cloneTab(tab: MacroTab, name = tab.name): MacroTab {
  const now = Date.now();
  return {
    ...tab,
    id: macroId("tab"),
    name,
    reference: { ...tab.reference },
    stop: { ...tab.stop },
    targetIds: [...tab.targetIds],
    source: tab.source ? { ...tab.source } : undefined,
    steps: tab.steps.map(cloneStep),
    createdAt: now,
    updatedAt: now,
  };
}

export function cloneStep(step: MacroStep): MacroStep {
  return { ...step, id: macroId("s"), fingers: step.fingers.map((f) => ({ ...f, id: macroId("f") })) };
}

export type StepKind = "tap" | "hold" | "swipe" | "multi";

export function stepKind(step: MacroStep): StepKind {
  if (step.fingers.length > 1) return "multi";
  const f = step.fingers[0];
  if (f && f.toX !== undefined && f.toY !== undefined && (f.toX !== f.x || f.toY !== f.y)) return "swipe";
  if (f && f.durationMs >= 400) return "hold";
  return "tap";
}

/** How long the fingers are on the screen. */
export function stepTouchMs(step: MacroStep): number {
  return Math.max(0, ...step.fingers.map((f) => f.startMs + Math.max(MIN_TOUCH_MS, f.durationMs)));
}

export function cycleMs(tab: MacroTab): number {
  return tab.steps.filter((s) => s.enabled).reduce((sum, s) => sum + stepTouchMs(s) + s.delayMs, 0);
}

/* ------------------------------------------------------------------ */
/* Scaling                                                             */
/* ------------------------------------------------------------------ */

export type Orientation = "portrait" | "landscape" | "square";

export function orientationOf(size: Size): Orientation {
  if (size.width === size.height) return "square";
  return size.width > size.height ? "landscape" : "portrait";
}

export function orientationMismatch(reference: Size, device: Size | null | undefined): boolean {
  if (!device || device.width <= 0 || device.height <= 0) return false;
  const a = orientationOf(reference);
  const b = orientationOf(device);
  return a !== "square" && b !== "square" && a !== b;
}

/**
 * Where the reference screen lands on a device screen, as 0–1 of the device.
 * Stretch fills the screen; fit keeps the aspect ratio and centers it.
 */
export function placement(reference: Size, device: Size | null | undefined, scale: ScaleMode) {
  if (scale === "stretch" || !device || device.width <= 0 || device.height <= 0) {
    return { left: 0, top: 0, width: 1, height: 1 };
  }
  const s = Math.min(device.width / reference.width, device.height / reference.height);
  const w = (reference.width * s) / device.width;
  const h = (reference.height * s) / device.height;
  return { left: (1 - w) / 2, top: (1 - h) / 2, width: w, height: h };
}

/** Reference pixels → 0–1 of the device screen. */
export function toNormalized(
  point: { x: number; y: number },
  reference: Size,
  device: Size | null | undefined,
  scale: ScaleMode,
) {
  const box = placement(reference, device, scale);
  const rx = clamp(point.x / reference.width, 0, 1);
  const ry = clamp(point.y / reference.height, 0, 1);
  return { x: box.left + rx * box.width, y: box.top + ry * box.height };
}

/** 0–1 of the device screen → reference pixels (for dragging in a device preview). */
export function fromNormalized(
  point: { x: number; y: number },
  reference: Size,
  device: Size | null | undefined,
  scale: ScaleMode,
) {
  const box = placement(reference, device, scale);
  const rx = clamp((point.x - box.left) / box.width, 0, 1);
  const ry = clamp((point.y - box.top) / box.height, 0, 1);
  return { x: round(rx * reference.width), y: round(ry * reference.height) };
}

/** Device pixels for a reference point. */
export function toDevicePixels(
  point: { x: number; y: number },
  reference: Size,
  device: Size,
  scale: ScaleMode,
) {
  const n = toNormalized(point, reference, device, scale);
  return { x: round(n.x * (device.width - 1)), y: round(n.y * (device.height - 1)) };
}

/** Rescale a whole tab to a new reference resolution, keeping relative positions. */
export function rescaleTab(tab: MacroTab, next: Size): MacroTab {
  const sx = next.width / tab.reference.width;
  const sy = next.height / tab.reference.height;
  const fx = (v: number) => clamp(round(v * sx), 0, next.width);
  const fy = (v: number) => clamp(round(v * sy), 0, next.height);
  return {
    ...tab,
    reference: { ...next },
    jitterPx: round(tab.jitterPx * Math.min(sx, sy)),
    steps: tab.steps.map((step) => ({
      ...step,
      fingers: step.fingers.map((f) => ({
        ...f,
        x: fx(f.x),
        y: fy(f.y),
        ...(f.toX !== undefined ? { toX: fx(f.toX) } : {}),
        ...(f.toY !== undefined ? { toY: fy(f.toY) } : {}),
      })),
    })),
  };
}

/** Smallest common portrait/landscape preset that holds every point. */
export function guessReference(points: Array<{ x: number; y: number }>): Size {
  if (points.length === 0) return { width: 1080, height: 2400 };
  const maxX = Math.max(...points.map((p) => p.x));
  const maxY = Math.max(...points.map((p) => p.y));
  const landscape = maxX > maxY;
  const presets = REFERENCE_PRESETS.map((p) => (landscape ? { width: p.height, height: p.width } : p));
  const fit = presets.find((p) => maxX < p.width && maxY < p.height);
  if (fit) return { ...fit };
  return { width: clamp(Math.ceil(maxX + 1), MIN_REFERENCE, MAX_REFERENCE), height: clamp(Math.ceil(maxY + 1), MIN_REFERENCE, MAX_REFERENCE) };
}

/* ------------------------------------------------------------------ */
/* Gestures                                                            */
/* ------------------------------------------------------------------ */

/**
 * The agent gesture for one step on one screen. Each finger gets its own
 * slot, so fingers never collide. `random` returns 0–1 (Math.random) and is
 * only used when the tab has jitter.
 */
export function buildStrokes(
  step: MacroStep,
  tab: Pick<MacroTab, "reference" | "scale" | "jitterPx">,
  device: Size | null | undefined,
  random: () => number = Math.random,
): StrokeOut[] {
  const { reference, scale, jitterPx } = tab;
  const wobble = () => (jitterPx > 0 ? round((random() * 2 - 1) * jitterPx) : 0);
  return step.fingers.slice(0, MAX_FINGERS).map((finger, index) => {
    const dx = wobble();
    const dy = wobble();
    const start = { x: finger.x + dx, y: finger.y + dy };
    const points = [toNormalized(start, reference, device, scale)];
    if (finger.toX !== undefined && finger.toY !== undefined) {
      const ex = finger.toX + (jitterPx > 0 ? wobble() : 0);
      const ey = finger.toY + (jitterPx > 0 ? wobble() : 0);
      points.push(toNormalized({ x: ex, y: ey }, reference, device, scale));
    }
    return {
      pointer: index,
      startMs: clamp(round(finger.startMs), 0, MAX_TOUCH_MS),
      durationMs: clamp(round(finger.durationMs), MIN_TOUCH_MS, MAX_TOUCH_MS),
      points,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export class MacroImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MacroImportError";
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function num(v: unknown, fallback: number): number {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

function str(v: unknown, fallback: string, max = 120): string {
  return typeof v === "string" ? v.slice(0, max) : fallback;
}

function sanitizeFinger(raw: unknown, ref: Size, where: string, warnings: string[]): MacroFinger | null {
  if (!isObject(raw)) {
    warnings.push(`${where}: finger is not an object, skipped`);
    return null;
  }
  const x = num(raw.x, NaN);
  const y = num(raw.y, NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    warnings.push(`${where}: finger has no x/y, skipped`);
    return null;
  }
  const fx = (v: number) => clamp(round(v), 0, ref.width);
  const fy = (v: number) => clamp(round(v), 0, ref.height);
  if (x < 0 || y < 0 || x > ref.width || y > ref.height) {
    warnings.push(`${where}: point ${round(x)},${round(y)} is outside ${ref.width}×${ref.height}, moved to the edge`);
  }
  const finger: MacroFinger = {
    id: str(raw.id, "", 64) || macroId("f"),
    x: fx(x),
    y: fy(y),
    startMs: clamp(round(num(raw.startMs, 0)), 0, MAX_TOUCH_MS),
    durationMs: clamp(round(num(raw.durationMs, 50)), MIN_TOUCH_MS, MAX_TOUCH_MS),
  };
  const toX = num(raw.toX, NaN);
  const toY = num(raw.toY, NaN);
  if (Number.isFinite(toX) && Number.isFinite(toY)) {
    finger.toX = fx(toX);
    finger.toY = fy(toY);
  }
  return finger;
}

function sanitizeStep(raw: unknown, ref: Size, where: string, warnings: string[]): MacroStep | null {
  if (!isObject(raw)) {
    warnings.push(`${where}: step is not an object, skipped`);
    return null;
  }
  const rawFingers = Array.isArray(raw.fingers) ? raw.fingers : [];
  if (rawFingers.length > MAX_FINGERS) {
    warnings.push(`${where}: more than ${MAX_FINGERS} fingers, extra fingers dropped`);
  }
  const fingers = rawFingers
    .slice(0, MAX_FINGERS)
    .map((f, i) => sanitizeFinger(f, ref, `${where} finger ${i + 1}`, warnings))
    .filter((f): f is MacroFinger => f !== null);
  if (fingers.length === 0) {
    warnings.push(`${where}: no usable fingers, skipped`);
    return null;
  }
  return {
    id: str(raw.id, "", 64) || macroId("s"),
    label: str(raw.label, "", 80),
    enabled: raw.enabled !== false,
    fingers,
    delayMs: clamp(round(num(raw.delayMs, 300)), 0, MAX_DELAY_MS),
  };
}

function sanitizeReference(raw: unknown, fallback: Size): Size {
  if (!isObject(raw)) return { ...fallback };
  const width = round(num(raw.width, fallback.width));
  const height = round(num(raw.height, fallback.height));
  return {
    width: clamp(width, MIN_REFERENCE, MAX_REFERENCE),
    height: clamp(height, MIN_REFERENCE, MAX_REFERENCE),
  };
}

/** Make any tab-shaped object safe to store and run. */
export function sanitizeTab(raw: unknown, index: number, warnings: string[]): MacroTab {
  if (!isObject(raw)) throw new MacroImportError(`Tab ${index + 1} is not an object`);
  const name = str(raw.name, "", 60).trim() || `Tab ${index + 1}`;
  const where = `"${name}"`;
  const reference = sanitizeReference(raw.reference, { width: 1080, height: 2400 });
  const rawSteps = Array.isArray(raw.steps) ? raw.steps : [];
  if (!Array.isArray(raw.steps)) warnings.push(`${where}: no steps list, imported empty`);
  if (rawSteps.length > MAX_STEPS) warnings.push(`${where}: more than ${MAX_STEPS} steps, the rest were dropped`);
  const steps = rawSteps
    .slice(0, MAX_STEPS)
    .map((s, i) => sanitizeStep(s, reference, `${where} step ${i + 1}`, warnings))
    .filter((s): s is MacroStep => s !== null);
  const stopRaw = isObject(raw.stop) ? raw.stop : {};
  const mode: StopMode = stopRaw.mode === "infinite" || stopRaw.mode === "time" ? stopRaw.mode : "cycles";
  const now = Date.now();
  const source = isObject(raw.source)
    ? {
        kind:
          raw.source.kind === "autoclicker" || raw.source.kind === "desk-macro"
            ? (raw.source.kind as MacroSource["kind"])
            : ("adboard" as const),
        ...(typeof raw.source.file === "string" ? { file: raw.source.file.slice(0, 200) } : {}),
        ...(Number.isFinite(raw.source.importedAt) ? { importedAt: Number(raw.source.importedAt) } : {}),
        ...(Number.isFinite(raw.source.originalId) ? { originalId: Number(raw.source.originalId) } : {}),
      }
    : undefined;
  return {
    id: str(raw.id, "", 64) || macroId("tab"),
    name,
    reference,
    scale: raw.scale === "fit" ? "fit" : "stretch",
    orientation: raw.orientation === "match" ? "match" : "any",
    stop: {
      mode,
      seconds: clamp(round(num(stopRaw.seconds, 300)), 1, 86_400 * 7),
      cycles: clamp(round(num(stopRaw.cycles, 10)), 1, 1_000_000),
    },
    jitterPx: clamp(round(num(raw.jitterPx, 0)), 0, 200),
    steps,
    targetIds: Array.isArray(raw.targetIds) ? raw.targetIds.filter((v): v is string => typeof v === "string").slice(0, 200) : [],
    ...(Number.isFinite(Number(raw.referenceDpi)) && Number(raw.referenceDpi) >= 120 && Number(raw.referenceDpi) <= 640
      ? { referenceDpi: Math.round(Number(raw.referenceDpi)) }
      : {}),
    notes: str(raw.notes, "", 2000),
    ...(source ? { source } : {}),
    createdAt: num(raw.createdAt, now),
    updatedAt: num(raw.updatedAt, now),
  };
}

/* ------------------------------------------------------------------ */
/* Auto Clicker                                                        */
/* ------------------------------------------------------------------ */

/** Auto Clicker delay units: 0 ms, 1 s, 2 min. */
export function autoClickerDelayMs(value: number, unit: number): number {
  if (unit === 1) return value * 1000;
  if (unit === 2) return value * 60_000;
  return value;
}

export interface AutoClickerTarget {
  type: number;
  xPos: number;
  yPos: number;
  xPos1: number;
  yPos1: number;
  delayValue: number;
  delayUnit: number;
  duration: number;
}

export interface AutoClickerConfig {
  id: number;
  name: string;
  stopConditionChecked: number;
  timeValue: number;
  numberOfCycles: number;
  antiDetection: boolean;
  targets: AutoClickerTarget[];
}

function looksLikeAutoClicker(value: unknown): value is unknown[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((c) => isObject(c) && Array.isArray(c.targets) && ("numberOfCycles" in c || "stopConditionChecked" in c || "antiDetection" in c))
  );
}

/** Auto Clicker's tap stroke is 10 ms; a swipe of 0 means its 500 ms default. */
const AC_TAP_MS = 10;
const AC_SWIPE_DEFAULT_MS = 500;
/** Auto Clicker targets are about 40 dp; its anti-detection moves up to a quarter of that. */
const AC_JITTER_PX = 12;

function fromAutoClicker(configs: unknown[], reference: Size | undefined, file: string | undefined, warnings: string[]): MacroTab[] {
  const allPoints: Array<{ x: number; y: number }> = [];
  for (const c of configs) {
    for (const t of (c as { targets: unknown[] }).targets) {
      if (!isObject(t)) continue;
      allPoints.push({ x: num(t.xPos, 0), y: num(t.yPos, 0) });
      if (num(t.type, 0) === 1) allPoints.push({ x: num(t.xPos1, 0), y: num(t.yPos1, 0) });
    }
  }
  const ref = reference ?? guessReference(allPoints);
  return configs.map((rawConfig, index) => {
    const config = rawConfig as Record<string, unknown>;
    const name = str(config.name, "", 60).trim() || `Config ${index + 1}`;
    const targets = config.targets as unknown[];
    const steps: MacroStep[] = [];
    targets.forEach((rawTarget, i) => {
      const where = `"${name}" target ${i + 1}`;
      if (!isObject(rawTarget)) {
        warnings.push(`${where}: not an object, skipped`);
        return;
      }
      const type = num(rawTarget.type, 0);
      const x = num(rawTarget.xPos, NaN);
      const y = num(rawTarget.yPos, NaN);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
        warnings.push(`${where}: no position, skipped`);
        return;
      }
      if (type !== 0 && type !== 1) {
        warnings.push(`${where}: unknown target type ${type}, skipped`);
        return;
      }
      const delayMs = clamp(
        autoClickerDelayMs(Math.max(1, num(rawTarget.delayValue, 100)), num(rawTarget.delayUnit, 0)),
        0,
        MAX_DELAY_MS,
      );
      const fx = (v: number) => clamp(round(v), 0, ref.width);
      const fy = (v: number) => clamp(round(v), 0, ref.height);
      if (type === 1) {
        const x1 = num(rawTarget.xPos1, -1);
        const y1 = num(rawTarget.yPos1, -1);
        if (x1 < 0 || y1 < 0) {
          warnings.push(`${where}: swipe has no end point, imported as a tap`);
        }
        const raw = num(rawTarget.duration, 0);
        const duration = raw <= 0 ? AC_SWIPE_DEFAULT_MS : Math.max(100, raw);
        steps.push(
          newStep(
            [
              newFinger(fx(x), fy(y), {
                durationMs: x1 < 0 || y1 < 0 ? AC_TAP_MS : clamp(duration, MIN_TOUCH_MS, MAX_TOUCH_MS),
                ...(x1 >= 0 && y1 >= 0 ? { toX: fx(x1), toY: fy(y1) } : {}),
              }),
            ],
            { delayMs },
          ),
        );
        return;
      }
      steps.push(newStep([newFinger(fx(x), fy(y), { durationMs: AC_TAP_MS })], { delayMs }));
    });
    const stopIndex = num(config.stopConditionChecked, 0);
    const mode: StopMode = stopIndex === 1 ? "time" : stopIndex === 2 ? "cycles" : "infinite";
    const originalId = num(config.id, NaN);
    return newTab(name, {
      reference: { ...ref },
      stop: {
        mode,
        seconds: clamp(round(num(config.timeValue, 300)), 1, 86_400 * 7),
        cycles: clamp(round(num(config.numberOfCycles, 1)), 1, 1_000_000),
      },
      jitterPx: config.antiDetection === true ? AC_JITTER_PX : 0,
      steps,
      source: {
        kind: "autoclicker",
        ...(file ? { file } : {}),
        importedAt: Date.now(),
        ...(Number.isFinite(originalId) ? { originalId } : {}),
      },
    });
  });
}

/**
 * Auto Clicker's config export (a JSON array). Multi-touch steps become one
 * target per finger, in finger order, because Auto Clicker plays one target
 * at a time.
 */
export function toAutoClicker(tabs: MacroTab[], warnings: string[] = []): AutoClickerConfig[] {
  return tabs.map((tab, index) => {
    const targets: AutoClickerTarget[] = [];
    for (const step of tab.steps) {
      if (!step.enabled) continue;
      if (step.fingers.length > 1) {
        warnings.push(`"${tab.name}": a ${step.fingers.length}-finger step was split into separate targets (Auto Clicker has no multi-touch)`);
      }
      step.fingers.forEach((f, i) => {
        const last = i === step.fingers.length - 1;
        const moves = f.toX !== undefined && f.toY !== undefined;
        const hold = !moves && f.durationMs > AC_TAP_MS * 5;
        const swipe = moves || hold;
        targets.push({
          delayUnit: 0,
          delayValue: last ? Math.max(1, round(step.delayMs)) : 1,
          duration: swipe ? clamp(round(f.durationMs), 100, MAX_TOUCH_MS) : 0,
          type: swipe ? 1 : 0,
          xPos: round(f.x),
          xPos1: swipe ? round(moves ? (f.toX as number) : f.x) : -1,
          yPos: round(f.y),
          yPos1: swipe ? round(moves ? (f.toY as number) : f.y) : -1,
        });
      });
    }
    return {
      targets,
      antiDetection: tab.jitterPx > 0,
      id: tab.source?.kind === "autoclicker" && tab.source.originalId !== undefined ? tab.source.originalId : index,
      name: tab.name,
      numberOfCycles: tab.stop.cycles,
      stopConditionChecked: tab.stop.mode === "time" ? 1 : tab.stop.mode === "cycles" ? 2 : 0,
      timeValue: tab.stop.seconds,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Older ADBoard Automate macros (percent coordinates)                 */
/* ------------------------------------------------------------------ */

const LEGACY_REFERENCE: Size = { width: 1080, height: 2400 };

function legacyMacroToTab(raw: Record<string, unknown>, index: number, reference: Size | undefined, warnings: string[]): MacroTab | null {
  const name = str(raw.name, "", 60).trim() || `Macro ${index + 1}`;
  const ref = reference ?? LEGACY_REFERENCE;
  const steps: MacroStep[] = [];
  const px = (v: unknown, size: number, fallback: number) => clamp(round((num(v, fallback) / 100) * size), 0, size);
  let skipped = 0;
  for (const rawStep of Array.isArray(raw.steps) ? raw.steps : []) {
    if (!isObject(rawStep)) continue;
    const kind = String(rawStep.kind);
    const x = px(rawStep.x, ref.width, 50);
    const y = px(rawStep.y, ref.height, 50);
    switch (kind) {
      case "tap":
        steps.push(newStep([newFinger(x, y, { durationMs: 50 })]));
        break;
      case "doubleTap":
        steps.push(newStep([newFinger(x, y, { durationMs: 50 })], { delayMs: 80 }));
        steps.push(newStep([newFinger(x, y, { durationMs: 50 })]));
        break;
      case "longPress":
        steps.push(newStep([newFinger(x, y, { durationMs: 600 })]));
        break;
      case "swipe":
      case "drag":
      case "scroll": {
        const toY = kind === "scroll" ? clamp(y - round(ref.height * 0.3), 0, ref.height) : px(rawStep.y2, ref.height, 30);
        const toX = kind === "scroll" ? x : px(rawStep.x2, ref.width, 50);
        steps.push(newStep([newFinger(x, y, { toX, toY, durationMs: kind === "drag" ? 800 : 300 })]));
        break;
      }
      case "pinch": {
        const spread = round(ref.width * 0.2);
        steps.push(
          newStep([
            newFinger(x, y, { toX: clamp(x - spread, 0, ref.width), toY: y, durationMs: 400 }),
            newFinger(x, y, { toX: clamp(x + spread, 0, ref.width), toY: y, durationMs: 400 }),
          ]),
        );
        break;
      }
      case "gesture": {
        const samples = Array.isArray(rawStep.samples) ? rawStep.samples.filter(isObject) : [];
        const down = samples.find((s) => s.phase === "down");
        const up = [...samples].reverse().find((s) => s.phase === "up" || s.phase === "cancel");
        if (!down || !up) {
          skipped += 1;
          break;
        }
        const sx = clamp(round(num(down.x, 0.5) * ref.width), 0, ref.width);
        const sy = clamp(round(num(down.y, 0.5) * ref.height), 0, ref.height);
        const ex = clamp(round(num(up.x, 0.5) * ref.width), 0, ref.width);
        const ey = clamp(round(num(up.y, 0.5) * ref.height), 0, ref.height);
        const ms = clamp(round(num(up.t, 50) - num(down.t, 0)), MIN_TOUCH_MS, MAX_TOUCH_MS);
        steps.push(newStep([newFinger(sx, sy, { durationMs: ms, ...(sx !== ex || sy !== ey ? { toX: ex, toY: ey } : {}) })]));
        break;
      }
      case "wait": {
        const last = steps[steps.length - 1];
        const ms = clamp(round(num(rawStep.ms, 500)), 0, MAX_DELAY_MS);
        if (last) last.delayMs += ms;
        break;
      }
      default:
        skipped += 1;
    }
  }
  if (skipped > 0) {
    warnings.push(`"${name}": ${skipped} non-touch step${skipped === 1 ? "" : "s"} (app, file, shell…) stay in Automate and were not imported`);
  }
  if (steps.length === 0) {
    warnings.push(`"${name}": no touch steps, skipped`);
    return null;
  }
  return newTab(name, {
    reference: { ...ref },
    stop: { mode: "cycles", seconds: 300, cycles: 1 },
    steps,
    source: { kind: "desk-macro", importedAt: Date.now() },
  });
}

/* ------------------------------------------------------------------ */
/* Files                                                               */
/* ------------------------------------------------------------------ */

export type ImportFormat = "adboard" | "autoclicker" | "desk-macro" | "desk-library";

export interface ImportResult {
  format: ImportFormat;
  tabs: MacroTab[];
  warnings: string[];
  /** True when the reference resolution was guessed (Auto Clicker files do not store one). */
  guessedReference: boolean;
}

export interface ImportOptions {
  /** Screen the file was made on. Auto Clicker and older macros do not record it. */
  reference?: Size;
  fileName?: string;
}

/** Read any supported macro file. Throws MacroImportError with a readable reason. */
export function parseMacroFile(text: string, options: ImportOptions = {}): ImportResult {
  if (text.length > 20 * 1024 * 1024) throw new MacroImportError("File is larger than 20 MB");
  const trimmed = text.replace(/^﻿/, "").trim();
  if (!trimmed) throw new MacroImportError("File is empty");
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new MacroImportError("File is not valid JSON — it may be cut off or not a macro file");
  }
  const warnings: string[] = [];

  if (isObject(parsed) && parsed.format === MACRO_FORMAT) {
    const version = num(parsed.version, NaN);
    if (!Number.isFinite(version)) throw new MacroImportError("Macro file has no version");
    if (version > MACRO_VERSION) {
      throw new MacroImportError(`Made by a newer ADBoard (format ${version}); this one reads up to ${MACRO_VERSION}`);
    }
    if (!Array.isArray(parsed.tabs)) throw new MacroImportError("Macro file has no tabs list");
    if (parsed.tabs.length === 0) throw new MacroImportError("Macro file has no tabs");
    if (parsed.tabs.length > MAX_TABS) warnings.push(`Only the first ${MAX_TABS} tabs were imported`);
    const tabs = parsed.tabs.slice(0, MAX_TABS).map((t, i) => sanitizeTab(t, i, warnings));
    return { format: "adboard", tabs, warnings, guessedReference: false };
  }

  if (looksLikeAutoClicker(parsed)) {
    if (parsed.length > MAX_TABS) warnings.push(`Only the first ${MAX_TABS} configs were imported`);
    const tabs = fromAutoClicker(parsed.slice(0, MAX_TABS), options.reference, options.fileName, warnings);
    return { format: "autoclicker", tabs, warnings, guessedReference: !options.reference };
  }

  if (isObject(parsed) && Array.isArray(parsed.macros)) {
    const tabs = parsed.macros
      .filter(isObject)
      .slice(0, MAX_TABS)
      .map((m, i) => legacyMacroToTab(m, i, options.reference, warnings))
      .filter((t): t is MacroTab => t !== null);
    if (tabs.length === 0) throw new MacroImportError("Export file has no macros with touch steps");
    return { format: "desk-library", tabs, warnings, guessedReference: !options.reference };
  }

  if (isObject(parsed) && Array.isArray(parsed.steps) && typeof parsed.name === "string") {
    const tab = legacyMacroToTab(parsed, 0, options.reference, warnings);
    if (!tab) throw new MacroImportError("Macro has no touch steps to import");
    return { format: "desk-macro", tabs: [tab], warnings, guessedReference: !options.reference };
  }

  if (Array.isArray(parsed) && parsed.length === 0) throw new MacroImportError("File has no configurations");
  throw new MacroImportError("Not a macro file — expected an ADBoard macro export or an Auto Clicker config");
}

export function exportMacroFile(tabs: MacroTab[], now = new Date()): string {
  const file: MacroFile = {
    format: MACRO_FORMAT,
    version: MACRO_VERSION,
    app: "ADBoard",
    exportedAt: now.toISOString(),
    tabs,
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

export function exportAutoClickerFile(tabs: MacroTab[], warnings: string[] = []): string {
  return JSON.stringify(toAutoClicker(tabs, warnings));
}

/* ------------------------------------------------------------------ */
/* Running                                                             */
/* ------------------------------------------------------------------ */

export interface RunDevice {
  id: string;
  name: string;
  status: string;
  resolution: Size;
}

export type DeviceRunState = "waiting" | "ok" | "stub" | "error" | "skipped" | "busy";

export interface DeviceRunStatus {
  name: string;
  state: DeviceRunState;
  detail?: string;
}

export type RunStatus = "running" | "paused" | "stopping" | "done" | "stopped" | "failed";

export interface RunSnapshot {
  status: RunStatus;
  /** 1-based cycle being played. */
  cycle: number;
  /** 0-based index into the enabled steps. */
  stepIndex: number;
  stepCount: number;
  touches: number;
  startedAt: number;
  finishedAt?: number;
  /** End time for a timed run. */
  deadline?: number;
  message?: string;
  devices: Record<string, DeviceRunStatus>;
}

export interface SendResult {
  deviceId: string;
  inject: "ok" | "stub" | "error";
  detail?: string;
}

export interface RunOptions {
  tab: MacroTab;
  devices: RunDevice[];
  /** Phones already driven by another tab, with that tab's name. */
  busy?: Record<string, string>;
  send: (targets: RunDevice[], strokes: StrokeOut[]) => Promise<SendResult[]>;
  signal: AbortSignal;
  onUpdate: (snapshot: RunSnapshot) => void;
  /** Play only this step, once (the step "Test" button). */
  onlyStepId?: string;
  /**
   * Pause: checked before each step. While `paused()` the run waits in
   * `waitResume` (which must also return when `signal` aborts). Paused time
   * does not count toward a time limit.
   */
  pauseGate?: PauseGate;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

export interface PauseGate {
  paused: () => boolean;
  waitResume: (signal: AbortSignal) => Promise<void>;
}

/** A pause switch for `RunOptions.pauseGate`. */
export function createPauseGate() {
  let paused = false;
  let wake: Array<() => void> = [];
  const release = () => {
    const waiting = wake;
    wake = [];
    waiting.forEach((resolve) => resolve());
  };
  const gate: PauseGate & { pause: () => void; resume: () => void } = {
    paused: () => paused,
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
      release();
    },
    waitResume: (signal) =>
      new Promise<void>((resolve) => {
        if (!paused || signal.aborted) return resolve();
        const done = () => {
          signal.removeEventListener("abort", done);
          resolve();
        };
        wake.push(done);
        signal.addEventListener("abort", done, { once: true });
      }),
  };
  return gate;
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Play a tab on its phones until its stop condition. Steps go to every phone
 * at once; a phone that fails drops out so the others keep going. Stopping
 * waits for the gesture in flight, which the agent always finishes with
 * every finger lifted.
 */
export async function runMacroTab(options: RunOptions): Promise<RunSnapshot> {
  const { tab, signal, send, onUpdate } = options;
  const sleep = options.sleep ?? abortableSleep;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const steps = options.onlyStepId
    ? tab.steps.filter((s) => s.id === options.onlyStepId)
    : tab.steps.filter((s) => s.enabled);
  const startedAt = now();
  const snap: RunSnapshot = {
    status: "running",
    cycle: 1,
    stepIndex: 0,
    stepCount: steps.length,
    touches: 0,
    startedAt,
    devices: {},
  };
  const emit = () => onUpdate({ ...snap, devices: { ...snap.devices } });
  const finish = (status: RunStatus, message?: string) => {
    snap.status = status;
    snap.finishedAt = now();
    if (message) snap.message = message;
    emit();
    return { ...snap, devices: { ...snap.devices } };
  };

  const active: RunDevice[] = [];
  for (const device of options.devices) {
    const busyTab = options.busy?.[device.id];
    if (device.status !== "online") {
      snap.devices[device.id] = { name: device.name, state: "skipped", detail: device.status };
    } else if (busyTab) {
      snap.devices[device.id] = { name: device.name, state: "busy", detail: `running "${busyTab}"` };
    } else if (tab.orientation === "match" && orientationMismatch(tab.reference, device.resolution)) {
      snap.devices[device.id] = {
        name: device.name,
        state: "skipped",
        detail: `screen is ${orientationOf(device.resolution)}, tab is ${orientationOf(tab.reference)}`,
      };
    } else {
      snap.devices[device.id] = { name: device.name, state: "waiting" };
      active.push(device);
    }
  }
  if (steps.length === 0) return finish("failed", "No enabled steps to play");
  if (active.length === 0) return finish("failed", "No phone to run on");

  const maxCycles = options.onlyStepId ? 1 : tab.stop.mode === "cycles" ? tab.stop.cycles : Infinity;
  if (!options.onlyStepId && tab.stop.mode === "time") snap.deadline = startedAt + tab.stop.seconds * 1000;
  const timeUp = () => snap.deadline !== undefined && now() >= snap.deadline;
  emit();

  for (let cycle = 1; cycle <= maxCycles; cycle += 1) {
    snap.cycle = cycle;
    for (let index = 0; index < steps.length; index += 1) {
      if (signal.aborted) return finish("stopped", "Stopped");
      if (options.pauseGate?.paused()) {
        const pausedAt = now();
        snap.status = "paused";
        emit();
        await options.pauseGate.waitResume(signal);
        if (snap.deadline !== undefined) snap.deadline += now() - pausedAt;
        snap.status = "running";
        if (signal.aborted) return finish("stopped", "Stopped");
        emit();
      }
      if (timeUp()) return finish("done", "Time is up");
      const step = steps[index];
      snap.stepIndex = index;
      emit();

      const groups = new Map<string, RunDevice[]>();
      for (const device of active) {
        const key = tab.scale === "fit" ? `${device.resolution.width}x${device.resolution.height}` : "all";
        groups.set(key, [...(groups.get(key) ?? []), device]);
      }
      const results = (
        await Promise.all(
          [...groups.values()].map((group) =>
            send(group, buildStrokes(step, tab, tab.scale === "fit" ? group[0].resolution : null, random)).catch(
              (error: unknown) =>
                group.map((d) => ({
                  deviceId: d.id,
                  inject: "error" as const,
                  detail: error instanceof Error ? error.message : "gesture failed",
                })),
            ),
          ),
        )
      ).flat();
      snap.touches += 1;
      for (const result of results) {
        const entry = snap.devices[result.deviceId];
        if (!entry) continue;
        entry.state = result.inject;
        entry.detail = result.detail;
        if (result.inject === "error") {
          const at = active.findIndex((d) => d.id === result.deviceId);
          if (at >= 0) active.splice(at, 1);
        }
      }
      if (active.length === 0) {
        const detail = results.find((r) => r.detail)?.detail;
        return finish("failed", detail ? `Every phone failed: ${detail}` : "Every phone failed");
      }
      emit();

      let wait = step.delayMs;
      if (snap.deadline !== undefined) wait = Math.min(wait, Math.max(0, snap.deadline - now()));
      await sleep(wait, signal);
    }
  }
  return finish("done", options.onlyStepId ? "Step played" : `Finished ${maxCycles} cycle${maxCycles === 1 ? "" : "s"}`);
}
