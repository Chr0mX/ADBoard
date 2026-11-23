import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DEFAULT_MONO_FONT, MONO_FONTS, parseMonoFont } from "./mono-fonts.ts";

const css = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
const layout = readFileSync(new URL("../../app/layout.tsx", import.meta.url), "utf8");

test("the picker offers JetBrains Mono (default) and the fifteen chosen fonts", () => {
  assert.equal(DEFAULT_MONO_FONT, "jetbrains");
  assert.deepEqual(
    MONO_FONTS.map((f) => f.label).sort(),
    [
      "System Monospace", "JetBrains Mono", "Fira Code", "Source Code Pro", "Cascadia Code", "IBM Plex Mono",
      "Roboto Mono", "Ubuntu Mono", "Space Mono", "Inconsolata", "Anonymous Pro", "DM Mono", "Red Hat Mono",
      "Menlo", "Consolas", "SF Mono",
    ].sort(),
  );
  assert.equal(new Set(MONO_FONTS.map((f) => f.id)).size, MONO_FONTS.length, "ids are unique");
});

test("a saved value is a known font id, otherwise the default", () => {
  assert.equal(parseMonoFont("fira"), "fira");
  assert.equal(parseMonoFont(null), DEFAULT_MONO_FONT);
  assert.equal(parseMonoFont(""), DEFAULT_MONO_FONT);
  assert.equal(parseMonoFont("comic-sans"), DEFAULT_MONO_FONT);
  assert.equal(parseMonoFont("</script>"), DEFAULT_MONO_FONT);
});

test("every font has a rule that sets --font-mono, and the default is the :root value", () => {
  assert.match(css, /:root\s*\{\s*--font-mono:\s*var\(--font-jetbrains\)/);
  for (const font of MONO_FONTS) {
    if (font.id === DEFAULT_MONO_FONT) continue;
    assert.match(css, new RegExp(`html\\[data-mono-font="${font.id}"\\]\\s*\\{\\s*--font-mono:`), font.id);
  }
});

test("bundled fonts are declared in the layout and only the default is preloaded", () => {
  const bundled = MONO_FONTS.filter((f) => f.kind === "bundled" && f.id !== DEFAULT_MONO_FONT);
  assert.equal(bundled.length, 10);
  for (const font of bundled) {
    const rule = css.match(new RegExp(`html\\[data-mono-font="${font.id}"\\]\\s*\\{\\s*--font-mono:\\s*var\\((--font-[a-z-]+)\\)`));
    assert.ok(rule, `${font.id} uses a bundled variable`);
    assert.ok(layout.includes(`variable: "${rule![1]}"`), `${font.id}: ${rule![1]} is declared in layout.tsx`);
  }
  assert.equal((layout.match(/preload:\s*false/g) ?? []).length, 10);
});

test("system fonts never name a bundled variable", () => {
  for (const font of MONO_FONTS.filter((f) => f.kind === "system")) {
    const rule = css.match(new RegExp(`html\\[data-mono-font="${font.id}"\\]\\s*\\{[^}]*\\}`));
    assert.ok(rule, font.id);
    assert.ok(!rule![0].includes("var(--font-"), font.id);
    assert.ok(/monospace/.test(rule![0]), `${font.id} falls back to monospace`);
  }
});
