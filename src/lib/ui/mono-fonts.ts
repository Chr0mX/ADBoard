/*
 * The font for technical values (serials, addresses, logs, sizes, fps ...): the
 * "mono" role in docs/typography.md. Only that role changes; headings and the
 * interface stay Geist and Figtree. The choice is a saved setting
 * (Settings → Appearance), applied as `data-mono-font` on <html>, and every
 * option has a matching rule in globals.css that sets `--font-mono`.
 *
 * Bundled fonts come with ADBoard (next/font, loaded only when chosen).
 * System fonts are used when this device has them and fall back to the
 * device's own monospace font when it does not.
 */

export const MONO_FONT_KEY = "adboard-mono-font";
export const DEFAULT_MONO_FONT = "jetbrains";

export type MonoFontKind = "bundled" | "system";

export interface MonoFont {
  id: string;
  label: string;
  kind: MonoFontKind;
}

export const MONO_FONTS: ReadonlyArray<MonoFont> = [
  { id: "jetbrains", label: "JetBrains Mono", kind: "bundled" },
  { id: "system", label: "System Monospace", kind: "system" },
  { id: "fira", label: "Fira Code", kind: "bundled" },
  { id: "source-code", label: "Source Code Pro", kind: "bundled" },
  { id: "cascadia", label: "Cascadia Code", kind: "system" },
  { id: "plex", label: "IBM Plex Mono", kind: "bundled" },
  { id: "roboto", label: "Roboto Mono", kind: "bundled" },
  { id: "ubuntu", label: "Ubuntu Mono", kind: "bundled" },
  { id: "space", label: "Space Mono", kind: "bundled" },
  { id: "inconsolata", label: "Inconsolata", kind: "bundled" },
  { id: "anonymous", label: "Anonymous Pro", kind: "bundled" },
  { id: "dm", label: "DM Mono", kind: "bundled" },
  { id: "red-hat", label: "Red Hat Mono", kind: "bundled" },
  { id: "menlo", label: "Menlo", kind: "system" },
  { id: "consolas", label: "Consolas", kind: "system" },
  { id: "sf-mono", label: "SF Mono", kind: "system" },
];

/** A saved value to a known font id; anything else is the default. */
export function parseMonoFont(raw: string | null | undefined): string {
  return MONO_FONTS.some((font) => font.id === raw) ? (raw as string) : DEFAULT_MONO_FONT;
}

/** The line shown under the picker so the choice can be judged. */
export const MONO_FONT_SAMPLE = "R5CW90ABC1 · 192.168.1.20:5555 · 1080×2400 · 60 fps · 0O 1lI";
