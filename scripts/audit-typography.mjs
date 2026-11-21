#!/usr/bin/env node
/*
 * Typography audit (docs/typography.md). Opens every desktop tab and phone route
 * on the mock fleet and reports:
 *   - mono: buttons, nav items, summaries, labels, headings and fields set in JetBrains
 *     Mono (only technical values may be);
 *   - heading: h1 to h4 that are not Geist;
 *   - family: any family other than the three;
 *   - small: text under 12 px;
 *   - overflow: horizontal page overflow, or text clipped on the right of the viewport.
 *
 *   node scripts/audit-typography.mjs [--base http://127.0.0.1:3847] [--agent http://127.0.0.1:3848] [--json]
 * Needs the dev server (or a static UI served by the agent) and the mock agent running, and Playwright.
 * Exit code 1 when a hard rule fails (heading family, unknown family, overflow, mono on a button/nav/summary
 * that is not a technical value).
 */
import { createRequire } from "node:module";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "1"] : [null, null])).filter(([k]) => k));
const base = args.base ?? "http://127.0.0.1:3847";
const require = createRequire(import.meta.url);
const { chromium } = (() => {
  for (const id of ["playwright", "/opt/node22/lib/node_modules/playwright"]) {
    try {
      return require(id);
    } catch {
      /* next */
    }
  }
  throw new Error("Playwright not found");
})();

const DESKTOP_TABS = ["control", "manage", "apps", "files", "macros", "automate", "developer", "hosts", "events", "storage", "settings"];
const MOBILE_ROUTES = ["/m/control/", "/m/devices/", "/m/macros/", "/m/more/", ...["manage", "apps", "files", "automate", "developer", "hosts", "events", "storage", "settings"].map((s) => `/m/more/${s}/`)];

/** Runs in the page: collect one record per visible text-bearing element. */
function collect() {
  const family = (f) => (/jetbrains|monospace/i.test(f) ? "mono" : /geist/i.test(f) ? "geist" : /figtree/i.test(f) ? "figtree" : f.split(",")[0].replace(/["']/g, ""));
  // Technical values: digits with units, versions, ids, addresses, paths, packages, times, sizes.
  const scrollable = (el) => {
    for (let e = el.parentElement; e; e = e.parentElement) {
      const o = getComputedStyle(e).overflowX;
      if (o === "auto" || o === "scroll") return true;
    }
    return false;
  };
  const looksTechnical = (text) => /(\d+\s*(ms|s|fps|kbps|mbps|dpi|px|%|mb|kb|gb|°c)\b)|(\d+\s*[×x]\s*\d+)|(\b\d{1,3}(\.\d{1,3}){3}\b)|(\b[a-z0-9]+(\.[a-z0-9_]+){2,}\b)|(^[\w-]{6,}$)|([A-Za-z]:\\)|(\/[\w.-]+\/)|(\d{1,2}:\d{2})|(^v?\d+(\.\d+)+)/i.test(text);
  const out = [];
  const seen = new Set();
  for (const el of document.querySelectorAll("body *")) {
    const tag = el.tagName;
    if (["SCRIPT", "STYLE", "SVG", "PATH", "CANVAS", "VIDEO", "OPTION", "OPTGROUP", "HTML", "HEAD"].includes(tag)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    if (el.closest("[hidden], .sr-only, [aria-hidden='true']") && !/^H[1-4]$/.test(tag)) continue;
    if (el.closest(".pc-stats-track")) continue; // the scrolling stats marquee is meant to run past the edge
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(" ").trim();
    const isField = ["INPUT", "SELECT", "TEXTAREA"].includes(tag);
    if (!own && !isField) continue;
    if (isField && el.type && ["checkbox", "radio", "range", "file", "hidden"].includes(el.type)) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.opacity === "0") continue;
    const role = /^H[1-4]$/.test(tag) ? "heading" : ["BUTTON", "SUMMARY"].includes(tag) || el.closest("button, summary, [role=tab], [role=option], nav a") ? "control" : isField ? "field" : tag === "LABEL" || tag === "LEGEND" ? "label" : "text";
    const key = `${role}|${family(cs.fontFamily)}|${cs.fontSize}|${own || el.getAttribute("placeholder") || el.value || ""}`.slice(0, 160);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      role,
      tag,
      family: family(cs.fontFamily),
      size: parseFloat(cs.fontSize),
      weight: cs.fontWeight,
      text: (own || el.getAttribute("placeholder") || el.getAttribute("aria-label") || el.value || "").slice(0, 40),
      // An explicit mono opt-in (font-mono, t-tech, data-mono-field) was reviewed when it was added.
      technical: looksTechnical(own || el.value || el.getAttribute("placeholder") || "") || el.matches(".font-mono, .t-tech, [data-mono-field], [data-mono]") || !!el.closest("code, pre, kbd, .font-mono, .t-tech, [data-mono]"),
      inTabBar: !!el.closest("[data-m-nav]"),
      right: scrollable(el) ? 0 : Math.round(rect.right),
      cut: el.scrollWidth > el.clientWidth + 1 && ["hidden", "clip"].includes(cs.overflowX) && cs.textOverflow !== "ellipsis",
    });
  }
  return { rows: out, hScroll: document.documentElement.scrollWidth > innerWidth, width: innerWidth };
}

const results = [];
function judge(label, { rows, hScroll, width }) {
  const issues = { mono: [], heading: [], family: [], small: [], overflow: [] };
  for (const r of rows) {
    if (!["geist", "figtree", "mono"].includes(r.family)) issues.family.push(r);
    if (r.role === "heading" && r.family !== "geist") issues.heading.push(r);
    if (r.family === "mono" && ["control", "field", "label", "heading"].includes(r.role) && !r.technical) issues.mono.push(r);
    // The phone's bottom tab labels are the one deliberate 11 px exception (icon above the label, fixed 44 px bar).
    if (r.size < 11.99 && !r.inTabBar) issues.small.push(r);
    if (r.right > width + 1 || r.cut) issues.overflow.push(r);
  }
  if (hScroll) issues.overflow.push({ text: "(page scrolls sideways)", role: "page", size: 0, family: "", right: 0 });
  results.push({ label, issues, count: rows.length });
}

const browser = await chromium.launch({ executablePath: process.env.ADBOARD_BENCH_CHROME || "/opt/pw-browsers/chromium" });
for (const width of [1280, 1024]) {
  const ctx = await browser.newContext({ viewport: { width, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(`${base}/`);
  await page.waitForSelector("[data-section-tab=control]", { timeout: 90000 });
  for (const id of DESKTOP_TABS) {
    await page.click(`[data-section-tab=${id}]`);
    await page.waitForTimeout(700);
    judge(`desktop ${width} ${id}`, await page.evaluate(collect));
  }
  await ctx.close();
}
for (const [width, size] of [[390, "compact"], [430, "compact"], [390, "standard"]]) {
  const ctx = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
  await ctx.addInitScript((s) => localStorage.setItem("adboard-m-text-size", s), size);
  const page = await ctx.newPage();
  for (const route of MOBILE_ROUTES) {
    await page.goto(`${base}${route}`);
    await page.waitForSelector("[data-m-app]", { timeout: 90000 });
    await page.waitForTimeout(900);
    judge(`phone ${width} ${size} ${route}`, await page.evaluate(collect));
  }
  await ctx.close();
}
await browser.close();

let hard = 0;
const tally = { mono: 0, heading: 0, family: 0, small: 0, overflow: 0 };
for (const r of results) {
  const bad = Object.entries(r.issues).filter(([, v]) => v.length);
  for (const [k, v] of bad) tally[k] += v.length;
  if (!bad.length) continue;
  if (!args.json) {
    console.log(`\n${r.label} (${r.count} text styles)`);
    for (const [k, v] of bad) console.log(`  ${k}: ${v.slice(0, 6).map((x) => `${x.role}/${x.family}/${x.size}px "${x.text}"`).join(" | ")}${v.length > 6 ? ` … +${v.length - 6}` : ""}`);
  }
  if (r.issues.heading.length || r.issues.family.length || r.issues.overflow.length || r.issues.mono.length) hard += 1;
}
if (args.json) console.log(JSON.stringify({ tally, results }, null, 1));
console.log(`\nChecked ${results.length} screens. Totals: ${JSON.stringify(tally)}. Screens with a hard failure: ${hard}.`);
process.exit(hard ? 1 : 0);
