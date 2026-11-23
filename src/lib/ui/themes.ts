/*
 * ADBoard colour themes: the one place their colours are written down.
 *
 * A theme is a small palette. `themeCss()` turns the palettes into one
 * `html[data-theme="…"]` rule each (rendered once by layout.tsx); the rule only
 * sets the raw `--th-*` colours, and everything else in globals.css (`--pc-*`, the
 * shadcn tokens) is derived from those. The default dark theme is also written
 * out as the `:root` values in globals.css (themes.test.ts keeps them equal).
 *
 * Palette fields:
 *   paper      page background            panel      cards, panels, inputs
 *   popover    menus and dialogs          secondary  muted fills, hover rows
 *   ink        body text                  muted      secondary text
 *   accent     accent text and outlines   accentFill primary button fill
 *   onAccent   text on accentFill         signal     success / online
 *   warn       warning                    danger     errors, destructive
 *   frame      the dark backdrop behind a phone's picture (and the status-bar cap on light themes)
 */

export type ThemeMode = "dark" | "light";

export interface Palette {
  paper: string;
  panel: string;
  popover: string;
  secondary: string;
  ink: string;
  muted: string;
  accent: string;
  accentFill: string;
  onAccent: string;
  signal: string;
  warn: string;
  danger: string;
  frame: string;
}

export interface ThemeMeta {
  id: string;
  name: string;
  mode: ThemeMode;
  palette: Palette;
}

export const DEFAULT_DARK_THEME = "adboard";
export const DEFAULT_LIGHT_THEME = "adboard-light";

export const THEMES: ReadonlyArray<ThemeMeta> = [
  // ---- Dark ----
  {
    id: "adboard", name: "ADBoard", mode: "dark",
    palette: { paper: "#0e141b", panel: "#1a242e", popover: "#182229", secondary: "#24303a", ink: "#e8eef2", muted: "#9aadb8", accent: "#8eeadf", accentFill: "#0e7a73", onAccent: "#f4fffe", signal: "#3dcc8a", warn: "#ff9b63", danger: "oklch(0.704 0.191 22.216)", frame: "#070b0f" },
  },
  {
    id: "catppuccin-mocha", name: "Catppuccin Mocha", mode: "dark",
    palette: { paper: "#181825", panel: "#1e1e2e", popover: "#252537", secondary: "#313244", ink: "#cdd6f4", muted: "#a6adc8", accent: "#cba6f7", accentFill: "#cba6f7", onAccent: "#11111b", signal: "#a6e3a1", warn: "#fab387", danger: "#f38ba8", frame: "#11111b" },
  },
  {
    id: "dracula", name: "Dracula", mode: "dark",
    palette: { paper: "#21222c", panel: "#282a36", popover: "#2d2f3d", secondary: "#44475a", ink: "#f8f8f2", muted: "#b4bad4", accent: "#bd93f9", accentFill: "#bd93f9", onAccent: "#282a36", signal: "#50fa7b", warn: "#ffb86c", danger: "#ff5555", frame: "#191a21" },
  },
  {
    id: "nord", name: "Nord", mode: "dark",
    palette: { paper: "#2e3440", panel: "#3b4252", popover: "#3b4252", secondary: "#434c5e", ink: "#eceff4", muted: "#b9c2d2", accent: "#88c0d0", accentFill: "#4d6c95", onAccent: "#eceff4", signal: "#a3be8c", warn: "#d08770", danger: "#bf616a", frame: "#242933" },
  },
  {
    id: "tokyo-night", name: "Tokyo Night", mode: "dark",
    palette: { paper: "#16161e", panel: "#1a1b26", popover: "#1f2335", secondary: "#292e42", ink: "#c0caf5", muted: "#9aa5ce", accent: "#7aa2f7", accentFill: "#3d59a1", onAccent: "#e6ebff", signal: "#9ece6a", warn: "#ff9e64", danger: "#f7768e", frame: "#0f0f14" },
  },
  {
    id: "gruvbox-dark", name: "Gruvbox Dark", mode: "dark",
    palette: { paper: "#1d2021", panel: "#282828", popover: "#32302f", secondary: "#3c3836", ink: "#ebdbb2", muted: "#b3a38d", accent: "#8ec07c", accentFill: "#689d6a", onAccent: "#1d2021", signal: "#b8bb26", warn: "#fe8019", danger: "#fb4934", frame: "#141617" },
  },
  {
    id: "solarized-dark", name: "Solarized Dark", mode: "dark",
    palette: { paper: "#002b36", panel: "#073642", popover: "#073642", secondary: "#0f4755", ink: "#eee8d5", muted: "#a4b1b1", accent: "#3ab5ab", accentFill: "#2aa198", onAccent: "#002b36", signal: "#9bb300", warn: "#e0612b", danger: "#ff5c58", frame: "#00212b" },
  },
  {
    id: "one-dark", name: "One Dark", mode: "dark",
    palette: { paper: "#21252b", panel: "#282c34", popover: "#2c313a", secondary: "#3e4451", ink: "#c8ccd4", muted: "#a3acbb", accent: "#61afef", accentFill: "#61afef", onAccent: "#21252b", signal: "#98c379", warn: "#d19a66", danger: "#e06c75", frame: "#1a1d23" },
  },
  {
    id: "github-dark", name: "GitHub Dark", mode: "dark",
    palette: { paper: "#0d1117", panel: "#161b22", popover: "#1c2128", secondary: "#21262d", ink: "#e6edf3", muted: "#9198a1", accent: "#58a6ff", accentFill: "#1f6feb", onAccent: "#ffffff", signal: "#3fb950", warn: "#f0883e", danger: "#f85149", frame: "#010409" },
  },
  {
    id: "rose-pine", name: "Rosé Pine", mode: "dark",
    palette: { paper: "#191724", panel: "#1f1d2e", popover: "#26233a", secondary: "#2a2740", ink: "#e0def4", muted: "#a09cbb", accent: "#c4a7e7", accentFill: "#c4a7e7", onAccent: "#191724", signal: "#9ccfd8", warn: "#f6c177", danger: "#eb6f92", frame: "#121019" },
  },
  // ---- Light ----
  {
    id: "adboard-light", name: "ADBoard Light", mode: "light",
    palette: { paper: "#f2f6f8", panel: "#ffffff", popover: "#ffffff", secondary: "#e4ebef", ink: "#16212a", muted: "#55697a", accent: "#0b756e", accentFill: "#0e7a73", onAccent: "#ffffff", signal: "#14864f", warn: "#b4500f", danger: "#c92a2a", frame: "#0f151b" },
  },
  {
    id: "catppuccin-latte", name: "Catppuccin Latte", mode: "light",
    palette: { paper: "#e6e9ef", panel: "#eff1f5", popover: "#f5f6f9", secondary: "#ccd0da", ink: "#40435c", muted: "#4f5269", accent: "#8839ef", accentFill: "#8839ef", onAccent: "#eff1f5", signal: "#2f7d1f", warn: "#b84608", danger: "#d20f39", frame: "#11111b" },
  },
  {
    id: "nord-light", name: "Nord Light", mode: "light",
    palette: { paper: "#e5e9f0", panel: "#f2f4f8", popover: "#f8f9fb", secondary: "#d8dee9", ink: "#2e3440", muted: "#4c566a", accent: "#44688f", accentFill: "#4c6f98", onAccent: "#ffffff", signal: "#4e7a38", warn: "#a85a35", danger: "#a8434d", frame: "#242933" },
  },
  {
    id: "solarized-light", name: "Solarized Light", mode: "light",
    palette: { paper: "#eee8d5", panel: "#fdf6e3", popover: "#fdf6e3", secondary: "#e3dcc6", ink: "#073642", muted: "#4d636a", accent: "#1c6f9e", accentFill: "#1b72a2", onAccent: "#fdf6e3", signal: "#667600", warn: "#b5470f", danger: "#c42b28", frame: "#002b36" },
  },
  {
    id: "gruvbox-light", name: "Gruvbox Light", mode: "light",
    palette: { paper: "#f2e5bc", panel: "#fbf1c7", popover: "#fbf1c7", secondary: "#ebdbb2", ink: "#3c3836", muted: "#665c54", accent: "#3b7352", accentFill: "#3a7250", onAccent: "#fbf1c7", signal: "#6d6a0c", warn: "#af3a03", danger: "#9d0006", frame: "#282828" },
  },
  {
    id: "github-light", name: "GitHub Light", mode: "light",
    palette: { paper: "#f6f8fa", panel: "#ffffff", popover: "#ffffff", secondary: "#eaeef2", ink: "#1f2328", muted: "#59636e", accent: "#0969da", accentFill: "#0969da", onAccent: "#ffffff", signal: "#1a7f37", warn: "#bc4c00", danger: "#cf222e", frame: "#0d1117" },
  },
  {
    id: "rose-pine-dawn", name: "Rosé Pine Dawn", mode: "light",
    palette: { paper: "#faf4ed", panel: "#fffaf3", popover: "#fffaf3", secondary: "#f2e9e1", ink: "#4a4569", muted: "#625e7c", accent: "#76598f", accentFill: "#7a5f94", onAccent: "#fffaf3", signal: "#2f6e78", warn: "#b6701a", danger: "#b4637a", frame: "#26233a" },
  },
];

export const DARK_THEMES = THEMES.filter((t) => t.mode === "dark");
export const LIGHT_THEMES = THEMES.filter((t) => t.mode === "light");

export function getTheme(id: string | null | undefined): ThemeMeta | undefined {
  return THEMES.find((t) => t.id === id);
}

/** A saved theme id for `mode`, or that mode's default when it is missing, unknown or of the other mode. */
export function themeFor(mode: ThemeMode, id: string | null | undefined): ThemeMeta {
  const found = getTheme(id);
  if (found && found.mode === mode) return found;
  return getTheme(mode === "dark" ? DEFAULT_DARK_THEME : DEFAULT_LIGHT_THEME)!;
}

/**
 * The `--th-*` declarations of one palette. Soft-fill, atmosphere and chart
 * colours are derived here, so the palette table stays short. The default dark
 * theme's own values live in globals.css `:root`.
 */
export function themeDeclarations(theme: ThemeMeta): string {
  const p = theme.palette;
  const light = theme.mode === "light";
  return [
    `--th-paper:${p.paper}`,
    `--th-panel:${p.panel}`,
    `--th-popover:${p.popover}`,
    `--th-secondary:${p.secondary}`,
    `--th-ink:${p.ink}`,
    `--th-muted:${p.muted}`,
    `--th-accent:${p.accent}`,
    `--th-accent-fill:${p.accentFill}`,
    `--th-on-accent:${p.onAccent}`,
    `--th-signal:${p.signal}`,
    `--th-warn:${p.warn}`,
    `--th-danger:${p.danger}`,
    `--th-danger-text:${p.danger}`,
    `--th-frame:${p.frame}`,
    `--th-soft-base:color-mix(in srgb, ${p.paper} 50%, ${p.panel})`,
    `--th-atmos-a:${p.paper}`,
    `--th-atmos-b:color-mix(in srgb, ${p.paper} 55%, ${p.panel})`,
    `--th-atmos-c:${p.paper}`,
    `--th-glow:${p.accentFill}`,
    `--th-shadow:${light ? "16%" : "45%"}`,
    `--th-cap:${light ? p.frame : p.paper}`,
    `--th-chart-1:${p.accent}`,
    `--th-chart-2:${p.signal}`,
    `--th-chart-3:${p.warn}`,
    `--th-chart-4:${p.danger}`,
    `--th-chart-5:${p.muted}`,
  ].join(";");
}

/** The stylesheet text layout.tsx renders: one rule per theme except the default (it is `:root`). */
export function themeCss(): string {
  return THEMES.filter((t) => t.id !== DEFAULT_DARK_THEME)
    .map((t) => `html[data-theme="${t.id}"]{${themeDeclarations(t)}}`)
    .join("\n");
}

// ---- Which theme is showing ----

/*
 * Which theme is showing. Three saved choices (all in the shared preferences,
 * so the desktop `/` and the phone app `/m/` always agree):
 *   mode  "dark" | "light" | "system"     (default dark: the existing look)
 *   dark  the theme used when the mode resolves to dark
 *   light the theme used when it resolves to light
 * `resolveTheme` is the one rule; the first-paint script below follows it.
 */

export const THEME_MODE_KEY = "adboard-theme-mode";
export const THEME_DARK_KEY = "adboard-theme-dark";
export const THEME_LIGHT_KEY = "adboard-theme-light";

export type ThemeModeChoice = ThemeMode | "system";
export const MODE_CHOICES: ReadonlyArray<{ id: ThemeModeChoice; label: string }> = [
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
  { id: "system", label: "System" },
];

export function parseModeChoice(raw: string | null | undefined): ThemeModeChoice {
  return raw === "light" || raw === "system" ? raw : "dark";
}

export interface ThemeChoice {
  mode: string | null | undefined;
  dark: string | null | undefined;
  light: string | null | undefined;
  /** `prefers-color-scheme: dark` right now. */
  systemDark: boolean;
}

export function resolveTheme(choice: ThemeChoice): { isDark: boolean; id: string; paper: string; cap: string } {
  const mode = parseModeChoice(choice.mode);
  const isDark = mode === "system" ? choice.systemDark : mode === "dark";
  const theme = themeFor(isDark ? "dark" : "light", isDark ? choice.dark : choice.light);
  const light = theme.mode === "light";
  return { isDark, id: theme.id, paper: theme.palette.paper, cap: light ? theme.palette.frame : theme.palette.paper };
}

/**
 * Runs in <head> before the first paint (no flash of the wrong theme). It is
 * written out by hand because it must be plain, dependency-free JavaScript;
 * theme-core.test.ts runs it against `resolveTheme` for every combination.
 * The map holds each theme's mode and page colour (for the browser's theme-color).
 */
export function themeBootScript(): string {
  const map: Record<string, [string, string]> = {};
  for (const t of THEMES) map[t.id] = [t.mode === "dark" ? "d" : "l", t.palette.paper];
  return `try{var D=document.documentElement,S=localStorage,M=${JSON.stringify(map)},` +
    `m=S.getItem(${JSON.stringify(THEME_MODE_KEY)}),` +
    `k=m==="light"||m==="system"?m:"dark",` +
    `d=k==="system"?matchMedia("(prefers-color-scheme: dark)").matches:k==="dark",` +
    `i=S.getItem(${JSON.stringify(THEME_DARK_KEY)}),` +
    `j=S.getItem(${JSON.stringify(THEME_LIGHT_KEY)}),` +
    `t=d?i:j;` +
    `if(!(M[t]&&M[t][0]===(d?"d":"l")))t=d?${JSON.stringify(DEFAULT_DARK_THEME)}:${JSON.stringify(DEFAULT_LIGHT_THEME)};` +
    `D.classList.toggle("dark",d);` +
    `if(t===${JSON.stringify(DEFAULT_DARK_THEME)})D.removeAttribute("data-theme");else D.setAttribute("data-theme",t);` +
    `var c=document.querySelector('meta[name="theme-color"]');if(c)c.setAttribute("content",M[t][1])}catch(e){}`;
}
