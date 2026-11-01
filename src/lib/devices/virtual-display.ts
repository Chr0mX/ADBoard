/*
 * Virtual displays: an independent Android display on a phone, made by the
 * scrcpy server on the agent. It shows up as one more device whose serial is
 * `<phone serial>#vd<N>`. These rules mirror the agent's
 * `virtual_display.rs`, which is what actually enforces them.
 */

export const MIN_SIDE = 120;
export const MAX_SIDE = 4096;
export const MIN_DPI = 72;
export const MAX_DPI = 640;

export interface VirtualDisplaySpec {
  width: number;
  height: number;
  dpi: number;
  /** `pkg`, `+pkg` (force-stop first) or `?name`. */
  startApp?: string;
  /** Keep the apps when the display closes (they move to the main display). */
  keepContent?: boolean;
}

export const SIZE_PRESETS: Array<{ id: string; label: string; width: number; height: number; dpi: number }> = [
  { id: "phone", label: "Phone, 1080 × 1920", width: 1080, height: 1920, dpi: 320 },
  { id: "landscape", label: "Landscape, 1920 × 1080", width: 1920, height: 1080, dpi: 320 },
  { id: "small", label: "Small, 720 × 1280", width: 720, height: 1280, dpi: 240 },
  { id: "tablet", label: "Tablet, 1600 × 2560", width: 1600, height: 2560, dpi: 320 },
];

export const DEFAULT_SPEC: VirtualDisplaySpec = { width: 1080, height: 1920, dpi: 320 };

const KEY = /^(.+)#vd([1-9]\d*)$/;

/** True for a virtual display's serial or id (`<serial>#vd<N>`). */
export function isVirtualKey(serial: string): boolean {
  return KEY.test(serial);
}

export function parseDisplayKey(key: string): { serial: string; index: number } | null {
  const match = KEY.exec(key);
  return match ? { serial: match[1], index: Number(match[2]) } : null;
}

export function displayKey(serial: string, index: number): string {
  return `${serial}#vd${index}`;
}

/** `pkg`, `+pkg` or `?name`: package characters only (the agent puts it in a shell string). */
export function validStartApp(value: string): boolean {
  const body = /^[+?]/.test(value) ? value.slice(1) : value;
  return body.length > 0 && body.length <= 200 && /^[A-Za-z0-9._-]+$/.test(body);
}

/** `pkg/.Activity` or `pkg/com.x.Activity$Inner`. */
export function validComponent(value: string): boolean {
  return /^[A-Za-z0-9._]{1,200}\/[A-Za-z0-9._$]{1,200}$/.test(value);
}

/** The first problem with `spec`, in words, or null when the agent will accept it. */
export function specError(spec: VirtualDisplaySpec): string | null {
  const side = (n: number) => Number.isInteger(n) && n >= MIN_SIDE && n <= MAX_SIDE;
  if (!side(spec.width) || !side(spec.height)) {
    return `Width and height must be whole numbers from ${MIN_SIDE} to ${MAX_SIDE}.`;
  }
  if (!Number.isInteger(spec.dpi) || spec.dpi < MIN_DPI || spec.dpi > MAX_DPI) {
    return `Density must be a whole number from ${MIN_DPI} to ${MAX_DPI}.`;
  }
  const app = spec.startApp?.trim();
  if (app && !validStartApp(app)) return "The app must be a package name such as org.mozilla.firefox.";
  return null;
}
