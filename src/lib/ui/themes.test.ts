import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import {
  DARK_THEMES,
  DEFAULT_DARK_THEME,
  DEFAULT_LIGHT_THEME,
  LIGHT_THEMES,
  THEME_DARK_KEY,
  THEME_LIGHT_KEY,
  THEME_MODE_KEY,
  THEMES,
  getTheme,
  parseModeChoice,
  resolveTheme,
  themeBootScript,
  themeCss,
  themeDeclarations,
  themeFor,
} from "./themes.ts";

const css = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");

// ---- WCAG contrast, for the palettes ----
function lum(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const ratio = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const isHex = (v: string) => /^#[0-9a-f]{6}$/i.test(v);

test("ids are unique and the defaults exist, one per mode", () => {
  assert.equal(new Set(THEMES.map((t) => t.id)).size, THEMES.length);
  assert.equal(getTheme(DEFAULT_DARK_THEME)?.mode, "dark");
  assert.equal(getTheme(DEFAULT_LIGHT_THEME)?.mode, "light");
  assert.ok(DARK_THEMES.length >= 5 && LIGHT_THEMES.length >= 5);
});

test("every palette is complete and readable", () => {
  for (const t of THEMES) {
    const p = t.palette;
    for (const [name, value] of Object.entries(p)) {
      assert.ok(typeof value === "string" && value.length > 0, `${t.id}.${name}`);
      if (!(t.id === DEFAULT_DARK_THEME && name === "danger")) assert.ok(isHex(value), `${t.id}.${name} is #rrggbb`);
    }
    // Body text, secondary text, accent text and button text must stay readable.
    assert.ok(ratio(p.ink, p.paper) >= 6.5, `${t.id} ink on paper ${ratio(p.ink, p.paper).toFixed(2)}`);
    assert.ok(ratio(p.ink, p.panel) >= 6.5, `${t.id} ink on panel`);
    assert.ok(ratio(p.muted, p.paper) >= 4.5, `${t.id} muted on paper ${ratio(p.muted, p.paper).toFixed(2)}`);
    assert.ok(ratio(p.muted, p.panel) >= 4.5, `${t.id} muted on panel ${ratio(p.muted, p.panel).toFixed(2)}`);
    assert.ok(ratio(p.muted, p.secondary) >= 3.5, `${t.id} muted on secondary ${ratio(p.muted, p.secondary).toFixed(2)}`);
    assert.ok(ratio(p.accent, p.panel) >= 4.5, `${t.id} accent on panel ${ratio(p.accent, p.panel).toFixed(2)}`);
    assert.ok(ratio(p.onAccent, p.accentFill) >= 4.5, `${t.id} text on button ${ratio(p.onAccent, p.accentFill).toFixed(2)}`);
    for (const status of ["signal", "warn"] as const) {
      assert.ok(ratio(p[status], p.panel) >= 3, `${t.id} ${status} on panel ${ratio(p[status], p.panel).toFixed(2)}`);
    }
  }
});

test("dark themes are dark and light themes are light", () => {
  for (const t of THEMES) {
    const dark = lum(t.palette.paper) < 0.2;
    assert.equal(dark, t.mode === "dark", t.id);
  }
});

test(":root in globals.css is the default theme, so the existing look is unchanged", () => {
  const p = getTheme(DEFAULT_DARK_THEME)!.palette;
  const root = [...css.matchAll(/:root\s*\{([\s\S]*?)\n\}/g)].map((m) => m[1]).find((b) => b.includes("--th-paper:"))!;
  const read = (name: string) => root.match(new RegExp(`--th-${name}:\\s*([^;]+);`))?.[1].trim();
  assert.equal(read("paper"), p.paper);
  assert.equal(read("panel"), p.panel);
  assert.equal(read("popover"), p.popover);
  assert.equal(read("secondary"), p.secondary);
  assert.equal(read("ink"), p.ink);
  assert.equal(read("muted"), p.muted);
  assert.equal(read("accent"), p.accent);
  assert.equal(read("accent-fill"), p.accentFill);
  assert.equal(read("on-accent"), p.onAccent);
  assert.equal(read("signal"), p.signal);
  assert.equal(read("warn"), p.warn);
  assert.equal(read("danger"), p.danger);
  assert.equal(read("frame"), p.frame);
});

test("every other theme gets one rule, and only --th-* values", () => {
  const sheet = themeCss();
  for (const t of THEMES) {
    const has = sheet.includes(`html[data-theme="${t.id}"]{`);
    assert.equal(has, t.id !== DEFAULT_DARK_THEME, t.id);
  }
  for (const decl of themeDeclarations(getTheme("nord")!).split(";")) assert.match(decl, /^--th-[a-z0-9-]+:/);
  assert.ok(!/[<>]/.test(sheet), "safe to put in a <style>");
});

test("tokens derive from the theme colours, not from literals", () => {
  for (const token of ["--pc-paper", "--pc-ink", "--pc-panel", "--pc-accent", "--background", "--popover", "--primary-foreground", "--destructive", "--chart-1"]) {
    assert.match(css, new RegExp(`${token}:\\s*var\\(--(th|pc)-`), token);
  }
});

// ---- mode and resolution ----
test("mode defaults to dark and only light or system change it", () => {
  assert.equal(parseModeChoice(null), "dark");
  assert.equal(parseModeChoice("nonsense"), "dark");
  assert.equal(parseModeChoice("light"), "light");
  assert.equal(parseModeChoice("system"), "system");
});

test("a saved theme must belong to the mode it is used in", () => {
  assert.equal(themeFor("dark", "nord").id, "nord");
  assert.equal(themeFor("dark", "nord-light").id, DEFAULT_DARK_THEME);
  assert.equal(themeFor("light", "nord").id, DEFAULT_LIGHT_THEME);
  assert.equal(themeFor("light", null).id, DEFAULT_LIGHT_THEME);
  assert.equal(themeFor("dark", "<script>").id, DEFAULT_DARK_THEME);
});

test("resolveTheme follows the mode, and System follows the device", () => {
  const base = { dark: "dracula", light: "github-light" };
  assert.deepEqual(
    [resolveTheme({ ...base, mode: null, systemDark: false }).id, resolveTheme({ ...base, mode: "dark", systemDark: false }).isDark],
    ["dracula", true],
  );
  assert.equal(resolveTheme({ ...base, mode: "light", systemDark: true }).id, "github-light");
  assert.equal(resolveTheme({ ...base, mode: "system", systemDark: true }).id, "dracula");
  assert.equal(resolveTheme({ ...base, mode: "system", systemDark: false }).id, "github-light");
  // Light themes put a dark cap under the iPhone status bar (white text); dark ones match the page.
  assert.equal(resolveTheme({ ...base, mode: "light", systemDark: false }).cap, getTheme("github-light")!.palette.frame);
  assert.equal(resolveTheme({ ...base, mode: "dark", systemDark: false }).cap, getTheme("dracula")!.palette.paper);
});

// ---- the first-paint script must agree with resolveTheme ----
function runBoot(store: Record<string, string>, systemDark: boolean) {
  const attrs = new Map<string, string>();
  const classes = new Set<string>(["dark"]);
  const meta = { content: "#0e141b", setAttribute(_: string, v: string) { this.content = v; } };
  const documentElement = {
    classList: { toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)) },
    removeAttribute: (k: string) => attrs.delete(k),
    setAttribute: (k: string, v: string) => attrs.set(k, v),
  };
  vm.runInNewContext(themeBootScript(), {
    document: { documentElement, querySelector: () => meta },
    localStorage: { getItem: (k: string) => store[k] ?? null },
    matchMedia: () => ({ matches: systemDark }),
  });
  return { dark: classes.has("dark"), theme: attrs.get("data-theme") ?? DEFAULT_DARK_THEME, color: meta.content };
}

test("the head script gives the same theme as resolveTheme for every combination", () => {
  const modes = [undefined, "dark", "light", "system", "junk"];
  const ids = [undefined, "nord", "github-light", "rose-pine", "adboard-light", "<x>"];
  for (const mode of modes) for (const dark of ids) for (const light of ids) for (const systemDark of [true, false]) {
    const store: Record<string, string> = {};
    if (mode) store[THEME_MODE_KEY] = mode;
    if (dark) store[THEME_DARK_KEY] = dark;
    if (light) store[THEME_LIGHT_KEY] = light;
    const want = resolveTheme({ mode, dark, light, systemDark });
    const got = runBoot(store, systemDark);
    assert.deepEqual(got, { dark: want.isDark, theme: want.id, color: want.paper }, JSON.stringify({ mode, dark, light, systemDark }));
  }
});

test("a broken storage leaves the page as it is (default dark)", () => {
  assert.doesNotThrow(() =>
    vm.runInNewContext(themeBootScript(), { document: {}, localStorage: { getItem() { throw new Error("denied"); } }, matchMedia: () => ({ matches: false }) }),
  );
});
