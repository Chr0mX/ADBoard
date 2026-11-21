import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { cn } from "../utils.ts";

/** Static checks that keep the typography system (docs/typography.md) from drifting. */
const root = path.resolve(import.meta.dirname, "../../..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");
const css = read("src/app/globals.css");

function sources(dir: string, out: string[] = []) {
  for (const name of readdirSync(path.join(root, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(path.join(root, rel)).isDirectory()) sources(rel, out);
    else if (/\.tsx$/.test(name) && !name.endsWith(".test.tsx")) out.push(rel);
  }
  return out;
}

test("no rule forces JetBrains Mono on buttons, summaries or form controls", () => {
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  for (const [, selector, body] of rules) {
    if (!/font-family:\s*var\(--font-mono\)/.test(body)) continue;
    // Only technical selectors may set the mono family.
    assert.ok(
      !/(^|[\s,>+~(])(button|summary|select|input|textarea|nav|label|h[1-6]|\.pc-toggle|\.pc-segment|\.pc-choice-row)\b/.test(selector.replace(/\[data-mono-field\]|input\[type="number"\]/g, "")),
      `mono family on: ${selector.trim().slice(0, 80)}`,
    );
  }
});

test("the three size tokens exist for desktop and the phone app, and Tailwind sizes follow them", () => {
  for (const name of ["title", "subtitle", "heading", "device", "body", "control", "field", "label", "secondary", "tech", "meta"]) {
    assert.match(css, new RegExp(`--t-${name}:`), `--t-${name}`);
  }
  assert.match(css, /\[data-m-app\]\s*\{[^}]*--t-body:/s);
  assert.match(css, /html\[data-m-text="standard"\] \[data-m-app\]\s*\{[^}]*--t-body:/s);
  for (const [utility, token] of [["--text-xs", "--t-secondary"], ["--text-sm", "--t-body"], ["--text-meta", "--t-meta"], ["--text-xl", "--t-title"]]) {
    assert.match(css, new RegExp(`${utility}:\\s*var\\(${token}\\)`), utility);
  }
});

test("headings are Geist and technical values are JetBrains Mono", () => {
  assert.match(css, /h1,\s*h2\s*\{[^}]*font-family:\s*var\(--font-display\)/s);
  assert.match(css, /h3,\s*h4\s*\{[^}]*font-family:\s*var\(--font-display\)/s);
  assert.match(css, /\.t-tech,\s*\[data-mono\]\s*\{[^}]*font-family:\s*var\(--font-mono\)/s);
});

test("only the font weights in use are loaded", () => {
  const layout = read("src/app/layout.tsx");
  assert.match(layout, /Geist\(\{[^}]*weight:\s*\["600",\s*"700"\]/s);
  assert.match(layout, /Figtree\(\{[^}]*weight:\s*\["400",\s*"500",\s*"600",\s*"700"\]/s);
  assert.match(layout, /JetBrains_Mono\(\{[^}]*weight:\s*\["400",\s*"500"\]/s);
});

test("components use the size tokens, not fixed 10/11 px text, and no shouting captions", () => {
  const bad: string[] = [];
  for (const file of sources("src")) {
    const text = read(file);
    if (/text-\[1[01]px\]/.test(text)) bad.push(`${file}: fixed 10/11 px text (use text-meta)`);
    if (/\b(uppercase|tracking-wider|tracking-widest|tracking-wide)\b/.test(text)) bad.push(`${file}: uppercase or wide letter spacing`);
  }
  assert.deepEqual(bad, []);
});

test("cn keeps text-meta next to a text colour (it is a size, not a colour)", () => {
  assert.equal(cn("px-2 text-meta text-[var(--pc-ink)]"), "px-2 text-meta text-[var(--pc-ink)]");
  // A later size still replaces an earlier one.
  assert.equal(cn("text-meta", "text-xs"), "text-xs");
});
