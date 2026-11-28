#!/usr/bin/env node
/*
 * Video lifecycle check: the desktop page and the phone app (/m) keep one stream per phone across Single and
 * Grid, and let a stream go only when its phone is really no longer shown.
 *
 *   node scripts/video-lifecycle-check.mjs [--agent target/release/adboard-agent] [--ui dist/windows/ui]
 *
 * Starts the agent on the mock fleet (scrcpy-labelled fixture video, a temporary data folder) serving the
 * static UI, drives both pages in headless Chromium, and reads `__adboardPerf.snapshot()`: per phone the
 * sockets opened (`sockets`) and decoders created (`decoderBuilds`), and the number of live streams. Exits 1
 * on the first difference. It checks the page's lifecycle only, not real phones.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((out, arg, i, all) => {
    if (arg.startsWith("--")) out.push([arg.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "1"]);
    return out;
  }, []),
);
const ROOT = resolve(new URL("..", import.meta.url).pathname);
const agentBin = resolve(args.agent ?? join(ROOT, "target/release/adboard-agent"));
const uiDir = resolve(args.ui ?? join(ROOT, "dist/windows/ui"));
const port = Number(args.port ?? 3848);
/** Longer than the hub's 1.5 s linger, so a stream that is going to stop has stopped. */
const SETTLE_MS = 2500;

const require = createRequire(import.meta.url);
const { chromium } = (() => {
  for (const id of ["playwright", "/opt/node22/lib/node_modules/playwright"]) {
    try {
      return require(id);
    } catch {
      // next
    }
  }
  throw new Error("Playwright not found");
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(ok, message, detail) {
  console.log(`${ok ? "ok  " : "FAIL"} ${message}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures += 1;
}

if (!existsSync(join(uiDir, "index.html"))) throw new Error(`no UI build at ${uiDir}`);
if (!existsSync(agentBin)) throw new Error(`no agent at ${agentBin}`);
const work = mkdtempSync(join(tmpdir(), "adboard-lifecycle-"));
symlinkSync(uiDir, join(work, "ui"));
mkdirSync(join(work, "data"));
const agent = spawn(agentBin, [], {
  cwd: work,
  stdio: "ignore",
  env: {
    ...process.env,
    NO_PROXY: "localhost,127.0.0.1",
    no_proxy: "localhost,127.0.0.1",
    ADBOARD_FORCE_MOCK: "1",
    ADBOARD_VIDEO_SOURCE: "scrcpy",
    ADBOARD_SCRCPY_FIXTURE: "1",
    ADBOARD_MOCK_COUNT: "3",
    ADBOARD_DATA_DIR: join(work, "data"),
    ADBOARD_BIND: "127.0.0.1",
    ADBOARD_PORT: String(port),
  },
});
process.on("exit", () => agent.kill("SIGKILL"));
for (let i = 0; ; i += 1) {
  if (await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok, () => false)) break;
  if (i > 100) throw new Error("agent did not start");
  await sleep(100);
}

const browser = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });

async function openPage(path, viewport, gridKey) {
  const context = await browser.newContext({ viewport });
  await context.addInitScript((key) => {
    localStorage.setItem("adboard-perf", "1");
    if (!sessionStorage.getItem("lifecycle-seeded")) {
      sessionStorage.setItem("lifecycle-seeded", "1");
      localStorage.setItem(key, "0");
      localStorage.setItem("adboard-section", "control");
    }
  }, gridKey);
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}${path}?perf=1`, { waitUntil: "load" });
  return page;
}

const snapshot = (page) => page.evaluate(() => globalThis.__adboardPerf?.snapshot() ?? null);
async function streams(page) {
  const snap = await snapshot(page);
  if (!snap) return { live: 0, by: {} };
  const by = Object.fromEntries(Object.entries(snap.streams).map(([serial, s]) => [serial, { sockets: s.sockets, builds: s.decoderBuilds, painted: s.painted }]));
  return { live: snap.liveStreams, by };
}
async function untilPainting(page, serial, ms = 8000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const s = (await streams(page)).by[serial];
    if (s && s.painted > 0) return true;
    await sleep(150);
  }
  return false;
}
/** The page's own buttons: "Grid view" in Single, "Exit grid view" in Grid (behind "Show grid controls" when folded). */
async function toggleGrid(page) {
  const enter = page.locator("[data-grid-view]:visible");
  const exit = page.locator("[data-grid-exit]:visible");
  if (await exit.count()) await exit.first().click();
  else if (await enter.count()) await enter.first().click();
  else {
    await page.locator('[aria-label="Show grid controls"]:visible').first().click();
    await sleep(300);
    await page.locator("[data-grid-exit]:visible").first().click();
  }
  await sleep(SETTLE_MS);
}

async function singleGridRounds(page, label, phones) {
  await sleep(SETTLE_MS);
  const first = await streams(page);
  const active = Object.keys(first.by)[0];
  check(first.live === 1 && active !== undefined, `${label}: Single shows one stream`, first);
  check(await untilPainting(page, active), `${label}: the selected phone paints`);
  const before = (await streams(page)).by[active];

  await toggleGrid(page);
  const grid = await streams(page);
  check(grid.live === phones, `${label}: Grid has one stream per phone (${phones})`, grid);
  check(grid.by[active]?.sockets === before.sockets, `${label}: Single → Grid keeps the selected phone's socket`, { before, after: grid.by[active] });

  await toggleGrid(page);
  const single = await streams(page);
  check(single.live === 1 && single.by[active] !== undefined, `${label}: Grid → Single keeps only the selected phone`, single);
  check(single.by[active]?.sockets === before.sockets, `${label}: Grid → Single reuses the selected phone's stream`, { before, after: single.by[active] });

  for (let i = 0; i < 4; i += 1) {
    await toggleGrid(page);
    await toggleGrid(page);
  }
  const after = (await streams(page)).by[active];
  check(after?.sockets === before.sockets, `${label}: 5 more Single/Grid rounds open no new socket`, { before, after });
  check(after?.builds === before.builds, `${label}: and build no new decoder`, { before, after });
  check((await snapshot(page)).liveStreams <= phones, `${label}: never more streams than phones`);
  return active;
}

// ---- desktop ----
{
  const page = await openPage("/", { width: 1600, height: 1000 }, "adboard-grid-view");
  const active = await singleGridRounds(page, "desktop", 3);

  // Control's own panels: Fill, Devices panel and Screens sheet change the layout around the screen, not the stream.
  const sockets = (await streams(page)).by[active]?.sockets;
  await page.locator('[aria-label="Fill window"]:visible').first().click();
  await sleep(800);
  check((await page.locator('[data-fill="1"]').count()) > 0, "desktop: Fill window is on");
  await page.locator('[aria-label="Exit fill"]:visible').first().click();
  await sleep(SETTLE_MS);
  check((await page.locator('[data-fill="1"]').count()) === 0, "desktop: Fill window is off again");
  check((await streams(page)).by[active]?.sockets === sockets, "desktop: Fill on and off keeps the socket", await streams(page));

  // Another phone: the old one's stream goes once the linger ends, the new one's comes.
  const devices = await page.evaluate(async () => {
    const { token } = await (await fetch("/api/bootstrap")).json();
    return (await fetch("/api/devices", { headers: { "x-adboard-token": token } })).json();
  });
  const next = devices.find((d) => d.serial !== active && d.status === "online");
  const card = next ? page.locator(`[data-device-card="${next.id}"]:visible`).first() : null;
  if (card && (await card.count())) {
    await card.click();
    await sleep(SETTLE_MS);
    const switched = await streams(page);
    check(switched.live === 1 && switched.by[active] === undefined && switched.by[next.serial] !== undefined, "desktop: another phone selected: the old phone's stream is released, the new one's opened", switched);
  } else {
    check(false, "desktop: a second phone card to select", devices);
  }

  // Leaving Control unmounts the screen (as on /m): every stream stops after the linger, and comes back.
  await page.locator('[data-section-tab="manage"]:visible').first().click();
  await sleep(SETTLE_MS);
  check((await snapshot(page)).liveStreams === 0, "desktop: leaving Control releases every stream");
  await page.locator('[data-section-tab="control"]:visible').first().click();
  await sleep(SETTLE_MS);
  const back = await streams(page);
  check(back.live === 1, "desktop: back in Control, one stream again", back);
  await page.context().close();
}

// ---- phone app ----
{
  const page = await openPage("/m/control/", { width: 390, height: 844 }, "adboard-m-grid-view");
  await singleGridRounds(page, "/m", 3);
  await page.context().close();
}

await browser.close();
agent.kill("SIGKILL");
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
