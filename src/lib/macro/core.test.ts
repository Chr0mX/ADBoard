import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  MacroImportError,
  buildStrokes,
  cloneTab,
  exportAutoClickerFile,
  exportMacroFile,
  fromNormalized,
  guessReference,
  newFinger,
  newStep,
  newTab,
  orientationMismatch,
  parseMacroFile,
  placement,
  rescaleTab,
  runMacroTab,
  createPauseGate,
  stepKind,
  toDevicePixels,
  toNormalized,
} from "./core.ts";

const sample = readFileSync(new URL("./autoclicker-sample.json", import.meta.url), "utf8");

/** Ids are regenerated on import; compare everything else. */
function strip(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value), (key, v) => (key === "id" || key === "importedAt" ? undefined : v));
}

describe("Auto Clicker import", () => {
  const result = parseMacroFile(sample, { fileName: "config.txt" });

  it("reads every config as a tab", () => {
    assert.equal(result.format, "autoclicker");
    assert.equal(result.tabs.length, 10);
    assert.deepEqual(
      result.tabs.map((t) => t.name),
      ["AutoLB", "Auto Multi", "AutoSell", "Multi", "Config 2", "Config 3", "Config 4", "Config 5", "Arena", "Auto Retry Crest"],
    );
    assert.deepEqual(result.warnings, []);
  });

  it("guesses the screen it was made on", () => {
    // Largest point is 793,1543 → the 900×1600 emulator preset.
    assert.equal(result.guessedReference, true);
    assert.deepEqual(result.tabs[0].reference, { width: 900, height: 1600 });
  });

  it("keeps positions, delays, stop condition", () => {
    const lb = result.tabs[0];
    assert.equal(lb.steps.length, 7);
    assert.deepEqual([lb.steps[0].fingers[0].x, lb.steps[0].fingers[0].y], [114, 461]);
    assert.equal(lb.steps[0].delayMs, 100);
    assert.equal(lb.steps[6].delayMs, 15);
    assert.equal(lb.steps[0].fingers[0].durationMs, 10);
    assert.equal(stepKind(lb.steps[0]), "tap");
    assert.deepEqual(lb.stop, { mode: "infinite", seconds: 300, cycles: 10 });
    assert.equal(lb.jitterPx, 0);
    assert.equal(lb.source?.kind, "autoclicker");
    assert.equal(lb.source?.originalId, 0);
    assert.equal(result.tabs[9].steps[0].delayMs, 1000);
  });

  it("uses a given reference instead of guessing", () => {
    const r = parseMacroFile(sample, { reference: { width: 1080, height: 1920 } });
    assert.equal(r.guessedReference, false);
    assert.deepEqual(r.tabs[3].reference, { width: 1080, height: 1920 });
  });

  it("maps delay units, swipes, stop modes and anti-detection", () => {
    const config = [
      {
        targets: [
          { delayUnit: 1, delayValue: 2, duration: 0, type: 1, xPos: 10, xPos1: 100, yPos: 20, yPos1: 200 },
          { delayUnit: 2, delayValue: 1, duration: 800, type: 1, xPos: 5, xPos1: 6, yPos: 7, yPos1: 8 },
          { delayUnit: 0, delayValue: 1, duration: 0, type: 7, xPos: 5, xPos1: -1, yPos: 7, yPos1: -1 },
        ],
        antiDetection: true,
        id: 4,
        name: "Swipes",
        numberOfCycles: 3,
        stopConditionChecked: 2,
        timeValue: 60,
      },
    ];
    const r = parseMacroFile(JSON.stringify(config), { reference: { width: 720, height: 1280 } });
    const tab = r.tabs[0];
    assert.equal(tab.steps.length, 2);
    assert.equal(tab.steps[0].delayMs, 2000);
    assert.equal(tab.steps[0].fingers[0].durationMs, 500, "0 means Auto Clicker's 500 ms default");
    assert.deepEqual([tab.steps[0].fingers[0].toX, tab.steps[0].fingers[0].toY], [100, 200]);
    assert.equal(stepKind(tab.steps[0]), "swipe");
    assert.equal(tab.steps[1].delayMs, 60_000);
    assert.equal(tab.steps[1].fingers[0].durationMs, 800);
    assert.deepEqual(tab.stop, { mode: "cycles", seconds: 60, cycles: 3 });
    assert.ok(tab.jitterPx > 0);
    assert.match(r.warnings[0], /unknown target type 7/);
  });

  it("round-trips back to Auto Clicker format", () => {
    const original = JSON.parse(sample);
    const back = JSON.parse(exportAutoClickerFile(result.tabs));
    assert.deepEqual(back, original);
  });
});

describe("ADBoard format", () => {
  it("round-trips tabs, steps, timing and metadata", () => {
    const tab = newTab("Two fingers", {
      reference: { width: 1080, height: 2400 },
      scale: "fit",
      orientation: "match",
      stop: { mode: "time", seconds: 90, cycles: 4 },
      jitterPx: 6,
      targetIds: ["s24", "pixel"],
      notes: "pinch the map",
      steps: [
        newStep([newFinger(100, 200, { durationMs: 40 })], { label: "Open", delayMs: 250 }),
        newStep(
          [
            newFinger(300, 1200, { toX: 100, toY: 1200, durationMs: 400 }),
            newFinger(700, 1200, { toX: 900, toY: 1200, durationMs: 400, startMs: 30 }),
          ],
          { label: "Pinch", delayMs: 0, enabled: false },
        ),
      ],
    });
    const text = exportMacroFile([tab, newTab("Empty")], new Date("2026-10-16T00:00:00Z"));
    const parsed = parseMacroFile(text);
    assert.equal(parsed.format, "adboard");
    assert.deepEqual(parsed.warnings, []);
    assert.deepEqual(strip(parsed.tabs[0]), strip(tab));
    assert.equal(parsed.tabs[1].steps.length, 0);
  });

  it("rejects corrupt and incompatible files with a reason", () => {
    assert.throws(() => parseMacroFile(""), /empty/);
    assert.throws(() => parseMacroFile("{\"format\":\"adboard-macros\",\"version\":1,\"tabs\":[{"), MacroImportError);
    assert.throws(() => parseMacroFile("{\"format\":\"adboard-macros\",\"version\":9,\"tabs\":[]}"), /newer ADBoard/);
    assert.throws(() => parseMacroFile("{\"format\":\"adboard-macros\",\"version\":1}"), /no tabs/);
    assert.throws(() => parseMacroFile("{\"hello\":1}"), /Not a macro file/);
    assert.throws(() => parseMacroFile("[]"), /no configurations/);
  });

  it("repairs bad values instead of failing", () => {
    const text = JSON.stringify({
      format: "adboard-macros",
      version: 1,
      tabs: [
        {
          name: "",
          reference: { width: 5, height: "1920" },
          stop: { mode: "forever", cycles: -3 },
          steps: [
            { fingers: [{ x: 50, y: 99999, durationMs: 0 }, { y: 3 }], delayMs: -5 },
            { fingers: [] },
            "junk",
          ],
        },
      ],
    });
    const r = parseMacroFile(text);
    const tab = r.tabs[0];
    assert.equal(tab.name, "Tab 1");
    assert.deepEqual(tab.reference, { width: 100, height: 1920 });
    assert.equal(tab.stop.mode, "cycles");
    assert.equal(tab.stop.cycles, 1);
    assert.equal(tab.steps.length, 1);
    assert.equal(tab.steps[0].fingers.length, 1);
    assert.equal(tab.steps[0].fingers[0].y, 1920);
    assert.equal(tab.steps[0].fingers[0].durationMs, 10);
    assert.equal(tab.steps[0].delayMs, 0);
    assert.ok(r.warnings.length >= 3);
  });
});

describe("older ADBoard Automate macros", () => {
  it("imports touch steps in percent and folds waits into delays", () => {
    const legacy = {
      id: "macro-1",
      name: "Login",
      folder: "Testing",
      steps: [
        { id: "a", kind: "launch", packageName: "com.example" },
        { id: "b", kind: "tap", x: 50, y: 25 },
        { id: "c", kind: "wait", ms: 1500 },
        { id: "d", kind: "swipe", x: 50, y: 70, x2: 50, y2: 30 },
      ],
    };
    const r = parseMacroFile(JSON.stringify(legacy), { reference: { width: 1000, height: 2000 } });
    assert.equal(r.format, "desk-macro");
    const tab = r.tabs[0];
    assert.equal(tab.steps.length, 2);
    assert.deepEqual([tab.steps[0].fingers[0].x, tab.steps[0].fingers[0].y], [500, 500]);
    assert.equal(tab.steps[0].delayMs, 300 + 1500);
    assert.deepEqual([tab.steps[1].fingers[0].toX, tab.steps[1].fingers[0].toY], [500, 600]);
    assert.match(r.warnings[0], /1 non-touch step/);
  });

  it("imports a whole desk export", () => {
    const desk = { apps: [], macros: [{ name: "Only app", steps: [{ kind: "launch" }] }, { name: "Tap", steps: [{ kind: "tap", x: 10, y: 10 }] }] };
    const r = parseMacroFile(JSON.stringify(desk));
    assert.equal(r.format, "desk-library");
    assert.equal(r.tabs.length, 1);
    assert.equal(r.tabs[0].name, "Tap");
  });
});

describe("resolution scaling", () => {
  const ref = { width: 900, height: 1600 };

  it("stretch keeps relative position on any screen", () => {
    assert.deepEqual(toNormalized({ x: 450, y: 400 }, ref, { width: 1080, height: 2400 }, "stretch"), { x: 0.5, y: 0.25 });
    assert.deepEqual(toDevicePixels({ x: 900, y: 1600 }, ref, { width: 1080, height: 2400 }, "stretch"), { x: 1079, y: 2399 });
  });

  it("fit keeps the aspect ratio and centers on a taller screen", () => {
    const device = { width: 1080, height: 2400 };
    const box = placement(ref, device, "fit");
    assert.equal(box.width, 1);
    assert.ok(Math.abs(box.height - 0.8) < 1e-9);
    assert.ok(Math.abs(box.top - 0.1) < 1e-9);
    const top = toNormalized({ x: 0, y: 0 }, ref, device, "fit");
    assert.ok(Math.abs(top.y - 0.1) < 1e-9);
    // Round trip through a device preview drag.
    for (const p of [{ x: 0, y: 0 }, { x: 450, y: 800 }, { x: 123, y: 1544 }, { x: 900, y: 1600 }]) {
      assert.deepEqual(fromNormalized(toNormalized(p, ref, device, "fit"), ref, device, "fit"), p);
      assert.deepEqual(fromNormalized(toNormalized(p, ref, device, "stretch"), ref, device, "stretch"), p);
    }
  });

  it("fit pillarboxes on a wider screen", () => {
    const box = placement(ref, { width: 1200, height: 1600 }, "fit");
    assert.equal(box.height, 1);
    assert.ok(Math.abs(box.left - 0.125) < 1e-9);
  });

  it("detects orientation changes", () => {
    assert.equal(orientationMismatch(ref, { width: 2400, height: 1080 }), true);
    assert.equal(orientationMismatch(ref, { width: 1080, height: 2400 }), false);
    assert.equal(orientationMismatch(ref, null), false);
  });

  it("rescales a tab to a new reference without moving touches on screen", () => {
    const tab = newTab("t", { reference: ref, steps: [newStep([newFinger(450, 800, { toX: 900, toY: 0 })])] });
    const big = rescaleTab(tab, { width: 1800, height: 3200 });
    const f = big.steps[0].fingers[0];
    assert.deepEqual([f.x, f.y, f.toX, f.toY], [900, 1600, 1800, 0]);
    const device = { width: 1080, height: 2400 };
    assert.deepEqual(
      toNormalized({ x: f.x, y: f.y }, big.reference, device, "stretch"),
      toNormalized({ x: 450, y: 800 }, ref, device, "stretch"),
    );
  });

  it("guesses landscape and oversized references", () => {
    assert.deepEqual(guessReference([{ x: 1500, y: 800 }]), { width: 1600, height: 900 });
    assert.deepEqual(guessReference([{ x: 4000, y: 5000 }]), { width: 4001, height: 5001 });
  });
});

describe("gestures", () => {
  const tab = newTab("g", { reference: { width: 1000, height: 2000 } });

  it("a tap is one finger on one slot", () => {
    const strokes = buildStrokes(newStep([newFinger(500, 1000, { durationMs: 0 })]), tab, null);
    assert.deepEqual(strokes, [{ pointer: 0, startMs: 0, durationMs: 10, points: [{ x: 0.5, y: 0.5 }] }]);
  });

  it("multi-touch gives each finger its own slot and timing", () => {
    const step = newStep([
      newFinger(100, 100, { durationMs: 300 }),
      newFinger(900, 100, { toX: 900, toY: 1900, durationMs: 200, startMs: 50 }),
      newFinger(500, 500, { durationMs: 100, startMs: 120 }),
    ]);
    const strokes = buildStrokes(step, tab, { width: 1080, height: 2400 });
    assert.deepEqual(strokes.map((s) => s.pointer), [0, 1, 2]);
    assert.deepEqual(strokes.map((s) => s.startMs), [0, 50, 120]);
    assert.equal(strokes[1].points.length, 2);
    assert.deepEqual(strokes[1].points[1], { x: 0.9, y: 0.95 });
  });

  it("jitter stays within the configured radius", () => {
    const jittery = { ...tab, jitterPx: 10 };
    const step = newStep([newFinger(500, 1000)]);
    let seed = 0;
    const rand = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
    for (let i = 0; i < 50; i += 1) {
      const p = buildStrokes(step, jittery, null, rand)[0].points[0];
      assert.ok(Math.abs(p.x * 1000 - 500) <= 10.0001);
      assert.ok(Math.abs(p.y * 2000 - 1000) <= 10.0001);
    }
    assert.deepEqual(buildStrokes(step, tab, null, () => 0.99)[0].points[0], { x: 0.5, y: 0.5 });
  });
});

describe("virtual tabs", () => {
  it("a duplicated tab shares nothing with the original", () => {
    const a = newTab("A", { targetIds: ["s24"], steps: [newStep([newFinger(1, 2)])] });
    const b = cloneTab(a, "B");
    assert.notEqual(b.id, a.id);
    assert.notEqual(b.steps[0].id, a.steps[0].id);
    assert.notEqual(b.steps[0].fingers[0].id, a.steps[0].fingers[0].id);
    b.steps[0].fingers[0].x = 999;
    b.targetIds.push("pixel");
    b.reference.width = 1;
    assert.equal(a.steps[0].fingers[0].x, 1);
    assert.deepEqual(a.targetIds, ["s24"]);
    assert.equal(a.reference.width, 1080);
  });
});

describe("runner", () => {
  const phones = [
    { id: "s24", name: "S24", status: "online", resolution: { width: 1080, height: 2340 } },
    { id: "pixel", name: "Pixel", status: "online", resolution: { width: 1080, height: 2400 } },
    { id: "a52", name: "A52", status: "offline", resolution: { width: 1080, height: 2400 } },
    { id: "tab", name: "Tablet", status: "online", resolution: { width: 2560, height: 1600 } },
  ];
  const instantSleep = async () => {};

  function tabWith(patch: Partial<ReturnType<typeof newTab>> = {}) {
    return newTab("Run", {
      reference: { width: 1080, height: 2400 },
      orientation: "match",
      stop: { mode: "cycles", seconds: 10, cycles: 2 },
      steps: [
        newStep([newFinger(100, 100)], { delayMs: 5 }),
        newStep([newFinger(200, 200), newFinger(800, 200)], { delayMs: 5 }),
        newStep([newFinger(1, 1)], { enabled: false }),
      ],
      ...patch,
    });
  }

  it("plays enabled steps for each cycle on every eligible phone at once", async () => {
    const calls: Array<{ ids: string[]; fingers: number }> = [];
    const snaps: string[] = [];
    const result = await runMacroTab({
      tab: tabWith(),
      devices: phones,
      busy: { pixel: "Other tab" },
      signal: new AbortController().signal,
      sleep: instantSleep,
      onUpdate: (s) => snaps.push(s.status),
      send: async (targets, strokes) => {
        calls.push({ ids: targets.map((t) => t.id), fingers: strokes.length });
        return targets.map((t) => ({ deviceId: t.id, inject: "ok" as const }));
      },
    });
    assert.equal(result.status, "done");
    assert.deepEqual(calls, [
      { ids: ["s24"], fingers: 1 },
      { ids: ["s24"], fingers: 2 },
      { ids: ["s24"], fingers: 1 },
      { ids: ["s24"], fingers: 2 },
    ]);
    assert.equal(result.devices.pixel.state, "busy");
    assert.equal(result.devices.a52.state, "skipped");
    assert.match(result.devices.tab.detail ?? "", /landscape/);
    assert.equal(result.touches, 4);
    assert.equal(snaps[0], "running");
  });

  it("fit mode sends per screen size; orientation any keeps the tablet", async () => {
    const sizes: number[] = [];
    await runMacroTab({
      tab: tabWith({ scale: "fit", orientation: "any", stop: { mode: "cycles", seconds: 1, cycles: 1 } }),
      devices: phones,
      signal: new AbortController().signal,
      sleep: instantSleep,
      onUpdate: () => {},
      send: async (targets) => {
        sizes.push(targets.length);
        return targets.map((t) => ({ deviceId: t.id, inject: "stub" as const }));
      },
    });
    // 3 screen sizes × 2 steps.
    assert.equal(sizes.length, 6);
  });

  it("a failing phone drops out and the rest continue; all failing stops", async () => {
    const result = await runMacroTab({
      tab: tabWith({ orientation: "any" }),
      devices: phones,
      signal: new AbortController().signal,
      sleep: instantSleep,
      onUpdate: () => {},
      send: async (targets) =>
        targets.map((t) => ({ deviceId: t.id, inject: t.id === "tab" ? ("error" as const) : ("ok" as const), detail: t.id === "tab" ? "no control" : undefined })),
    });
    assert.equal(result.status, "done");
    assert.equal(result.devices.tab.state, "error");
    assert.equal(result.devices.s24.state, "ok");

    const dead = await runMacroTab({
      tab: tabWith(),
      devices: phones.slice(0, 1),
      signal: new AbortController().signal,
      sleep: instantSleep,
      onUpdate: () => {},
      send: async () => {
        throw new Error("agent offline");
      },
    });
    assert.equal(dead.status, "failed");
    assert.match(dead.message ?? "", /agent offline/);
  });

  it("stops on abort and on the time limit", async () => {
    const controller = new AbortController();
    let sent = 0;
    const stopped = await runMacroTab({
      tab: tabWith({ stop: { mode: "infinite", seconds: 1, cycles: 1 } }),
      devices: phones.slice(0, 1),
      signal: controller.signal,
      sleep: instantSleep,
      onUpdate: () => {},
      send: async (targets) => {
        sent += 1;
        if (sent === 5) controller.abort();
        return targets.map((t) => ({ deviceId: t.id, inject: "ok" as const }));
      },
    });
    assert.equal(stopped.status, "stopped");
    assert.equal(sent, 5);

    let clock = 0;
    const timed = await runMacroTab({
      tab: tabWith({ stop: { mode: "time", seconds: 1, cycles: 1 } }),
      devices: phones.slice(0, 1),
      signal: new AbortController().signal,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms + 100;
      },
      onUpdate: () => {},
      send: async (targets) => targets.map((t) => ({ deviceId: t.id, inject: "ok" as const })),
    });
    assert.equal(timed.status, "done");
    assert.match(timed.message ?? "", /Time is up/);
    assert.ok(timed.touches >= 5 && timed.touches <= 12);
  });

  it("pauses before the next step, resumes, and stops while paused", async () => {
    const gate = createPauseGate();
    const statuses: string[] = [];
    let sent = 0;
    const done = runMacroTab({
      tab: tabWith({ stop: { mode: "cycles", seconds: 1, cycles: 3 } }),
      devices: phones.slice(0, 1),
      signal: new AbortController().signal,
      sleep: instantSleep,
      pauseGate: gate,
      onUpdate: (snap) => statuses.push(snap.status),
      send: async (targets) => {
        sent += 1;
        if (sent === 2) gate.pause();
        return targets.map((t) => ({ deviceId: t.id, inject: "ok" as const }));
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sent, 2, "no step is sent while paused");
    assert.ok(statuses.includes("paused"));
    gate.resume();
    const result = await done;
    assert.equal(result.status, "done");
    assert.ok(sent > 2);

    const gate2 = createPauseGate();
    const controller = new AbortController();
    let sent2 = 0;
    const stopping = runMacroTab({
      tab: tabWith({ stop: { mode: "infinite", seconds: 1, cycles: 1 } }),
      devices: phones.slice(0, 1),
      signal: controller.signal,
      sleep: instantSleep,
      pauseGate: gate2,
      onUpdate: () => {},
      send: async (targets) => {
        sent2 += 1;
        gate2.pause();
        return targets.map((t) => ({ deviceId: t.id, inject: "ok" as const }));
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const stopped = await stopping;
    assert.equal(stopped.status, "stopped");
    assert.equal(sent2, 1);
  });

  it("does not count paused time toward a time limit", async () => {
    let clock = 0;
    let sent = 0;
    const result = await runMacroTab({
      tab: tabWith({ stop: { mode: "time", seconds: 1, cycles: 1 } }),
      devices: phones.slice(0, 1),
      signal: new AbortController().signal,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      pauseGate: {
        paused: () => sent === 1 && clock < 50_000,
        waitResume: async () => {
          clock += 60_000; // a minute paused
        },
      },
      onUpdate: () => {},
      send: async (targets) => {
        sent += 1;
        clock += 100;
        return targets.map((t) => ({ deviceId: t.id, inject: "ok" as const }));
      },
    });
    assert.equal(result.status, "done");
    assert.ok(sent > 2, `kept playing after the pause (sent ${sent})`);
  });

  it("tests one step once, even if disabled", async () => {
    const tab = tabWith();
    let calls = 0;
    const r = await runMacroTab({
      tab,
      devices: phones.slice(0, 1),
      onlyStepId: tab.steps[2].id,
      signal: new AbortController().signal,
      sleep: instantSleep,
      onUpdate: () => {},
      send: async (targets) => {
        calls += 1;
        return targets.map((t) => ({ deviceId: t.id, inject: "ok" as const }));
      },
    });
    assert.equal(r.status, "done");
    assert.equal(calls, 1);
  });

  it("refuses to start with nothing to play", async () => {
    const r = await runMacroTab({
      tab: newTab("Empty"),
      devices: phones,
      signal: new AbortController().signal,
      onUpdate: () => {},
      send: async () => [],
    });
    assert.equal(r.status, "failed");
    assert.match(r.message ?? "", /No enabled steps/);
  });
});
