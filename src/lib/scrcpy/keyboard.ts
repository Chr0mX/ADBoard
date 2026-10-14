/** Android key metastate bits used by scrcpy INJECT_KEYCODE. */
const META_SHIFT = 0x1;
const META_ALT = 0x02;
const META_CTRL = 0x1000;
const META_META = 0x10000;

export type KeyInject =
  | { kind: "text"; text: string }
  | { kind: "key"; keycode: number; metastate: number; repeat: number };

type KeyLike = {
  key: string;
  /** Physical key (KeyboardEvent.code); used for desktop shortcuts. */
  code?: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
};

const SPECIAL: Record<string, number> = {
  Backspace: 67,
  Enter: 66,
  Escape: 111,
  Tab: 61,
  ArrowUp: 19,
  ArrowDown: 20,
  ArrowLeft: 21,
  ArrowRight: 22,
  Delete: 112,
  Home: 122,
  End: 123,
  PageUp: 92,
  PageDown: 93,
};

function metastate(event: KeyLike, includeShift: boolean): number {
  let bits = 0;
  if (includeShift && event.shiftKey) bits |= META_SHIFT;
  if (event.altKey) bits |= META_ALT;
  if (event.ctrlKey) bits |= META_CTRL;
  if (event.metaKey) bits |= META_META;
  return bits;
}

function letterCode(key: string): number | null {
  if (key.length !== 1) return null;
  const upper = key.toUpperCase();
  if (upper >= "A" && upper <= "Z") return 29 + upper.charCodeAt(0) - 65;
  if (key >= "0" && key <= "9") {
    return key === "0" ? 7 : 8 + key.charCodeAt(0) - 49;
  }
  return null;
}

function shortcut(event: KeyLike): boolean {
  return event.ctrlKey || event.altKey || event.metaKey;
}

export type DesktopShortcut =
  | "back"
  | "home"
  | "recent"
  | "grid"
  | "fill"
  | "more"
  | "screens"
  | "devices";

// Alt+Shift+key so shortcuts work while keyboard injection (on by default)
// forwards plain keys to the phone. Matched by physical key: on macOS
// Option+Shift turns the letter into a symbol.
const DESKTOP_SHORTCUT_CODES: Record<string, DesktopShortcut> = {
  KeyB: "back",
  KeyH: "home",
  KeyR: "recent",
  KeyG: "grid",
  KeyF: "fill",
  KeyM: "more",
  BracketLeft: "screens",
  BracketRight: "devices",
};

export const DESKTOP_SHORTCUT_KEY: Record<DesktopShortcut, string> = {
  back: "B",
  home: "H",
  recent: "R",
  grid: "G",
  fill: "F",
  more: "M",
  screens: "[",
  devices: "]",
};

export function matchDesktopShortcut(event: KeyLike): DesktopShortcut | null {
  if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return null;
  return (event.code && DESKTOP_SHORTCUT_CODES[event.code]) || null;
}

/** Human label, e.g. "Alt+Shift+H" or "⌥⇧H" on a Mac. */
export function desktopShortcutLabel(action: DesktopShortcut, mac: boolean): string {
  const key = DESKTOP_SHORTCUT_KEY[action];
  return mac ? `⌥⇧${key}` : `Alt+Shift+${key}`;
}

/** Value for aria-keyshortcuts. */
export function desktopShortcutAria(action: DesktopShortcut): string {
  return `Alt+Shift+${DESKTOP_SHORTCUT_KEY[action]}`;
}

/** Browser commands stay in the browser. Everything else can go to the phone. */
export function leaveToBrowser(event: KeyLike): boolean {
  if (event.key === "F5" || event.key === "F11" || event.key === "F12") return true;
  if (!(event.ctrlKey || event.metaKey)) return false;
  return ["r", "w", "l", "t", "n", "q", "Tab"].includes(event.key);
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return false;
}

/** Keydown. Printable characters are text so Shift is not applied twice. */
export function keyDownInject(event: KeyLike): KeyInject | null {
  if (event.key === "Shift" || event.key === "Control" || event.key === "Alt" || event.key === "Meta") {
    return null;
  }
  if (leaveToBrowser(event) || matchDesktopShortcut(event)) return null;
  if (!shortcut(event) && event.key.length === 1) {
    return { kind: "text", text: event.key };
  }
  const keycode = SPECIAL[event.key] ?? letterCode(event.key);
  if (keycode == null) return null;
  return {
    kind: "key",
    keycode,
    metastate: metastate(event, true),
    repeat: event.repeat ? 1 : 0,
  };
}

/** Keyup for keys that were sent as keycodes. Text has no up event. */
export function keyUpInject(event: KeyLike): KeyInject | null {
  if (event.key === "Shift" || event.key === "Control" || event.key === "Alt" || event.key === "Meta") {
    return null;
  }
  if (leaveToBrowser(event) || matchDesktopShortcut(event)) return null;
  if (!shortcut(event) && event.key.length === 1) return null;
  const keycode = SPECIAL[event.key] ?? letterCode(event.key);
  if (keycode == null) return null;
  return {
    kind: "key",
    keycode,
    metastate: metastate(event, true),
    repeat: 0,
  };
}
