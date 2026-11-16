#!/usr/bin/env node
/*
 * ADBoard benchmark: N mock phones, one browser page, sampled over time.
 *
 *   node scripts/bench/run.mjs --phones 12 --minutes 2 --label before
 *   node scripts/bench/run.mjs --phones 12 --route /m/ --recover
 *
 * Needs: a release agent (cargo build --release -p adboard-agent), a static UI
 * build (--ui DIR with index.html, default dist/windows/ui), ffmpeg and
 * Playwright's Chromium. Writes JSON and a Markdown row to temp/bench/.
 * See docs/performance.md for what the numbers mean and how to run it on Windows.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((out, arg, i, all) => {
    if (arg.startsWith("--")) out.push([arg.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "1"]);
    return out;
  }, []),
);
const ROOT = resolve(new URL("../..", import.meta.url).pathname);
const phones = Number(args.phones ?? 4);
const minutes = Number(args.minutes ?? 1);
const fps = Number(args.fps ?? 30);
const route = args.route ?? "/";
const label = args.label ?? "run";
const port = Number(args.port ?? 3848);
const uiDir = resolve(args.ui ?? join(ROOT, "dist/windows/ui"));
const agentBin = resolve(args.agent ?? join(ROOT, "target/release/adboard-agent"));
const sampleMs = Number(args.sample ?? 5000);
const recover = args.recover === "1";
const mobile = route.startsWith("/m");

const require = createRequire(import.meta.url);
function loadPlaywright() {
  for (const id of ["playwright", "/opt/node22/lib/node_modules/playwright"]) {
    try {
      return require(id);
    } catch {
      // try the next place
    }
  }
  throw new Error("Playwright not found (npm i -g playwright, or run where it is installed)");
}

/** CPU ticks and resident memory of a process and all of its children (Linux /proc). */
function procTree(rootPid) {
  if (!existsSync("/proc")) return null;
  const stats = new Map();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const raw = readFileSync(`/proc/${entry}/stat`, "utf8");
      const rest = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
      stats.set(Number(entry), { ppid: Number(rest[1]), ticks: Number(rest[11]) + Number(rest[12]), rssPages: Number(rest[21]) });
    } catch {
      // the process ended
    }
  }
  let ticks = 0;
  let rssPages = 0;
  const walk = (pid) => {
    const stat = stats.get(pid);
    if (!stat) return;
    ticks += stat.ticks;
    rssPages += stat.rssPages;
    for (const [child, s] of stats) if (s.ppid === pid) walk(child);
  };
  walk(rootPid);
  return { cpuSeconds: ticks / 100, rssMb: (rssPages * 4096) / 1048576 };
}

const children = new Set();
process.on("exit", () => {
  for (const child of children) child.kill("SIGKILL");
});

function startAgent(dataDir, cwd) {
  const child = spawn(agentBin, [], {
    cwd,
    stdio: ["ignore", "ignore", "ignore"],
    env: {
      ...process.env,
      no_proxy: "localhost,127.0.0.1",
      NO_PROXY: "localhost,127.0.0.1",
      ADBOARD_FORCE_MOCK: "1",
      ADBOARD_VIDEO_SOURCE: "testpattern",
      ADBOARD_MOCK_COUNT: String(phones),
      ADBOARD_MOCK_VITALS: "1",
      ADBOARD_TESTPATTERN_FPS: String(fps),
      ADBOARD_DATA_DIR: dataDir,
      ADBOARD_BIND: "127.0.0.1",
      ADBOARD_PORT: String(port),
    },
  });
  children.add(child);
  return child;
}

async function waitForAgent() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("agent did not start");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sum = (list) => list.reduce((a, b) => a + b, 0);
const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

async function main() {
  if (!existsSync(join(uiDir, "index.html"))) throw new Error(`no UI build at ${uiDir}`);
  if (!existsSync(agentBin)) throw new Error(`no agent at ${agentBin} (cargo build --release -p adboard-agent)`);
  const work = mkdtempSync(join(tmpdir(), "adboard-bench-"));
  symlinkSync(uiDir, join(work, "ui"));
  const dataDir = join(work, "data");
  mkdirSync(dataDir);
  if (await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok, () => false)) {
    throw new Error(`something already answers on port ${port}; stop it first`);
  }
  let agent = startAgent(dataDir, work);
  await waitForAgent();

  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({
    executablePath: process.env.ADBOARD_BENCH_CHROME || (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined),
    headless: args.headed !== "1",
    args: ["--enable-precise-memory-info"],
  });
  const context = await browser.newContext(
    mobile ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : { viewport: { width: 1600, height: 1000 } },
  );
  await context.addInitScript((isMobile) => {
    localStorage.setItem("adboard-perf", "1");
    localStorage.setItem(isMobile ? "adboard-m-grid-view" : "adboard-grid-view", "1");
  }, mobile);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  const base = `http://127.0.0.1:${port}`;
  await page.goto(`${base}${route}${route.includes("?") ? "&" : "?"}perf=1`, { waitUntil: "load" });

  // A navigation in progress (the first redirect) destroys the context: read as "nothing yet".
  const snapshot = () => page.evaluate(() => globalThis.__adboardPerf?.snapshot() ?? null).catch(() => null);
  const decodingCount = async () => {
    const snap = await snapshot();
    return snap ? Object.values(snap.streams).filter((s) => s.painted > 0).length : 0;
  };

  // Time until every phone has painted a frame.
  const startedAt = Date.now();
  let allPaintedMs = null;
  while (Date.now() - startedAt < 60000) {
    if ((await decodingCount()) >= phones) {
      allPaintedMs = Date.now() - startedAt;
      break;
    }
    await sleep(100);
  }
  await sleep(3000); // settle

  // Every Chromium process (browser, GPU, renderers): CPU time from CDP, memory from /proc.
  const browserCdp = await browser.newBrowserCDPSession();
  const browserUsage = async () => {
    try {
      const { processInfo } = await browserCdp.send("SystemInfo.getProcessInfo");
      let rssMb = 0;
      for (const info of processInfo) {
        try {
          const pages = Number(readFileSync(`/proc/${info.id}/statm`, "utf8").split(" ")[1]);
          rssMb += (pages * 4096) / 1048576;
        } catch {
          // not Linux, or the process ended
        }
      }
      return { cpuSeconds: sum(processInfo.map((info) => info.cpuTime)), rssMb, processes: processInfo.length };
    } catch {
      return null;
    }
  };
  const read = async () => {
    const snap = await snapshot();
    const metrics = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
    return {
      t: Date.now(),
      snap,
      heapMb: metrics.JSHeapUsedSize / 1048576,
      taskSeconds: metrics.TaskDuration,
      scriptSeconds: metrics.ScriptDuration,
      layoutSeconds: metrics.LayoutDuration + metrics.RecalcStyleDuration,
      nodes: metrics.Nodes,
      listeners: metrics.JSEventListeners,
      browser: await browserUsage(),
      agent: procTree(agent.pid),
      renders: await page.evaluate(() => globalThis.__adboardPerf?.renders?.() ?? null),
    };
  };

  const samples = [await read()];
  const serials = Object.keys(samples[0].snap?.streams ?? {});
  const end = Date.now() + minutes * 60000;
  let inputTick = 0;
  let focusTick = 1;
  let focusClicks = 0;
  while (Date.now() < end) {
    // Mark an input on one phone per second: the probe times it to that phone's next painted frame.
    for (let waited = 0; waited < sampleMs; waited += 1000) {
      const serial = serials[inputTick % Math.max(1, serials.length)];
      inputTick += 1;
      if (serial) await page.evaluate((s) => globalThis.__adboardPerf?.markInput(s), serial);
      await sleep(1000);
    }
    // Tap one phone: only that tile needs to re-render (its ripple).
    const canvases = page.locator("canvas");
    const count = await canvases.count();
    if (count > 0) {
      const box = await canvases.nth(focusTick % count).boundingBox();
      if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        focusClicks += 1;
      }
      focusTick += 1;
    }
    samples.push(await read());
  }

  // Recovery: restart the agent, time until every phone paints again without a reload.
  let recovery = null;
  if (recover) {
    const before = await snapshot();
    const paintedBefore = Object.fromEntries(Object.entries(before.streams).map(([k, v]) => [k, v.painted]));
    agent.kill("SIGKILL");
    await sleep(1500);
    agent = startAgent(dataDir, work);
    const t0 = Date.now();
    await waitForAgent();
    const agentUpMs = Date.now() - t0;
    let backMs = null;
    while (Date.now() - t0 < 60000) {
      const now = await snapshot();
      const back = now ? Object.entries(now.streams).filter(([k, v]) => v.painted > (paintedBefore[k] ?? 0) + 2 || !(k in paintedBefore)).length : 0;
      if (now && back >= phones && Object.keys(now.streams).length >= phones) {
        backMs = Date.now() - t0;
        break;
      }
      await sleep(100);
    }
    recovery = { agentUpMs, allPhonesBackMs: backMs };
  }

  // Leak check: leave the screens, wait for the linger, count what the hub still holds.
  let afterLeave = null;
  if (!recover) {
    // Client-side move to a section with no phone screens (same page, same hub).
    await page
      .locator(mobile ? '[data-m-tab="more"]' : '[data-section-tab="storage"]')
      .first()
      .click({ timeout: 5000 })
      .catch(() => {});
    await sleep(4000);
    const snap = await snapshot();
    afterLeave = snap ? { liveStreams: snap.liveStreams, statsListeners: snap.statsListeners } : null;
  }

  await browser.close();
  agent.kill("SIGKILL");

  const first = samples[0];
  const last = samples[samples.length - 1];
  const seconds = (last.t - first.t) / 1000;
  const per = (key) => serials.map((s) => ((last.snap.streams[s]?.[key] ?? 0) - (first.snap.streams[s]?.[key] ?? 0)) / seconds);
  const lastStreams = Object.values(last.snap.streams);
  const half = samples[Math.floor(samples.length / 2)];
  const result = {
    label,
    route,
    phones,
    sourceFps: fps,
    minutes: round(seconds / 60, 2),
    allPaintedMs,
    paintedFpsPerPhone: round(sum(per("painted")) / Math.max(1, serials.length)),
    receivedFpsPerPhone: round(sum(per("received")) / Math.max(1, serials.length)),
    decodedFpsPerPhone: round(sum(per("decoded")) / Math.max(1, serials.length)),
    droppedPerSecond: round(sum(per("dropped")), 2),
    supersededPerSecond: round(sum(per("superseded")), 2),
    maxDecodeQueue: Math.max(0, ...lastStreams.map((s) => s.maxQueue)),
    keyframeAsks: sum(lastStreams.map((s) => s.keyframeAsks)),
    reconnects: sum(lastStreams.map((s) => s.reconnects)),
    decoderErrors: sum(lastStreams.map((s) => s.decoderErrors)),
    decoder: [...new Set(lastStreams.map((s) => s.decoder))].join(","),
    wsMessageMsP50: round(Math.max(0, ...lastStreams.map((s) => s.messageMsP50)), 3),
    wsMessageMsP95: round(Math.max(0, ...lastStreams.map((s) => s.messageMsP95)), 3),
    inputToPaintMsP50: round(sum(lastStreams.map((s) => s.inputMsP50)) / Math.max(1, lastStreams.length)),
    inputToPaintMsP95: round(Math.max(0, ...lastStreams.map((s) => s.inputMsP95))),
    pageMainThreadPct: round(((last.taskSeconds - first.taskSeconds) / seconds) * 100),
    pageScriptPct: round(((last.scriptSeconds - first.scriptSeconds) / seconds) * 100),
    browserCpuPct: last.browser && first.browser ? round(((last.browser.cpuSeconds - first.browser.cpuSeconds) / seconds) * 100) : null,
    agentCpuPct: last.agent && first.agent ? round(((last.agent.cpuSeconds - first.agent.cpuSeconds) / seconds) * 100) : null,
    browserRssMb: last.browser ? round(last.browser.rssMb) : null,
    browserRssGrowthMb: last.browser && half.browser ? round(last.browser.rssMb - half.browser.rssMb) : null,
    jsHeapMb: round(last.heapMb),
    jsHeapGrowthMb: round(last.heapMb - half.heapMb),
    domNodes: last.nodes,
    taps: focusClicks,
    renders: last.renders && first.renders ? Object.fromEntries(Object.entries(last.renders).map(([k, v]) => [k, v - (first.renders[k] ?? 0)])) : null,
    recovery,
    afterLeave,
    samples: samples.map((s) => ({ t: s.t - first.t, heapMb: round(s.heapMb), browserRssMb: s.browser ? round(s.browser.rssMb) : null })),
  };

  const outDir = join(ROOT, "temp/bench");
  mkdirSync(outDir, { recursive: true });
  const name = `${label}-${mobile ? "m" : "desktop"}-${phones}${recover ? "-recover" : ""}`;
  writeFileSync(join(outDir, `${name}.json`), JSON.stringify(result, null, 2));
  const { samples: _samples, renders, ...flat } = result;
  void _samples;
  console.log(JSON.stringify({ ...flat, renderTotal: renders ? sum(Object.values(renders)) : null }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
