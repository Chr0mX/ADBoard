import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ACTIONS, CATEGORIES, actionOf, newStep, summarizeStep, touchGeometry, touchStrokes, validateStep } from "./actions.ts";
import type { MacroStep } from "./store.ts";

const step = (s: Partial<MacroStep> & Pick<MacroStep, "kind">): MacroStep => ({ id: "s1", ...s });

describe("action registry", () => {
  it("lists every step kind once, each in a known category", () => {
    const kinds = ACTIONS.map((a) => a.kind);
    assert.equal(new Set(kinds).size, kinds.length);
    for (const action of ACTIONS) assert.ok(CATEGORIES.includes(action.category), action.kind);
    // Every kind the store accepts has a definition (no placeholders, no gaps).
    for (const kind of ["launch", "forceStop", "clearData", "uninstall", "tap", "swipe", "pinch", "shell", "wait", "waitApp", "gesture"] as const) {
      assert.ok(actionOf(kind), kind);
    }
  });

  it("intent, Shizuku and tweak steps", () => {
    assert.deepEqual(validateStep(newStep("startShizuku")), {});
    assert.deepEqual(validateStep(newStep("tweak")), {});
    assert.ok(validateStep(newStep("intent")).command);
    assert.deepEqual(validateStep(step({ kind: "intent", intentVerb: "broadcast", command: "-a com.app.GO --ez on true" })), {});
    assert.ok(validateStep(step({ kind: "intent", command: "-a x.y; reboot" })).command);
    assert.equal(summarizeStep(step({ kind: "tweak", tweak: "forceDark", tweakState: "off" })), "Force dark off");
    assert.equal(summarizeStep(step({ kind: "intent", intentVerb: "start", command: "-n a.b/.C" })), "start -n a.b/.C");
  });

  it("new steps start valid except for fields the user must fill", () => {
    assert.deepEqual(validateStep(newStep("tap")), {});
    assert.deepEqual(validateStep(newStep("swipe")), {});
    assert.deepEqual(validateStep(newStep("wait")), {});
    assert.ok(validateStep(newStep("launch")).packageName);
    assert.ok(validateStep(newStep("shell")).command);
  });

  it("checks fields the way the agent does", () => {
    assert.equal(validateStep(step({ kind: "tap", x: 120, y: 50 })).x, "0 to 100");
    assert.ok(validateStep(step({ kind: "launch", packageName: "chrome" })).packageName);
    assert.deepEqual(validateStep(step({ kind: "launch", packageName: "com.android.chrome" })), {});
    assert.deepEqual(validateStep(step({ kind: "launch", packageName: "${GAME}" })), {}, "variables are filled at run time");
    assert.ok(validateStep(step({ kind: "text", text: "a;b" })).text);
    assert.deepEqual(validateStep(step({ kind: "text", text: "hello ${USERNAME}" })), {});
    assert.ok(validateStep(step({ kind: "shell", command: "a\nb" })).command);
    assert.ok(validateStep(step({ kind: "deleteFile", command: "sdcard/x" })).command);
    assert.ok(validateStep(step({ kind: "recordStart", bitrate: "8M" })).bitrate);
    assert.ok(validateStep(step({ kind: "bogus" as MacroStep["kind"] })).step);
  });
});

describe("touch geometry and strokes", () => {
  it("maps step percentages straight to 0–1 of the screen (what the preview draws)", () => {
    assert.deepEqual(touchGeometry(step({ kind: "tap", x: 25, y: 80 })), { start: { x: 0.25, y: 0.8 } });
    const swipe = touchGeometry(step({ kind: "swipe", x: 50, y: 70, x2: 50, y2: 30 }));
    assert.deepEqual(swipe, { start: { x: 0.5, y: 0.7 }, end: { x: 0.5, y: 0.3 } });
    assert.equal(touchGeometry(step({ kind: "shell", command: "id" })), null);
  });

  it("sends the same points it draws", () => {
    const s = step({ kind: "swipe", x: 10, y: 20, x2: 90, y2: 20, durationMs: 250 });
    const strokes = touchStrokes(s, touchGeometry(s)!);
    assert.equal(strokes.length, 1);
    assert.deepEqual(strokes[0][0], { pointer: 0, startMs: 0, durationMs: 250, points: [{ x: 0.1, y: 0.2 }, { x: 0.9, y: 0.2 }] });
  });

  it("scroll and pinch keep the legacy defaults; pinch uses two fingers", () => {
    const scroll = touchGeometry(step({ kind: "scroll", x: 50, y: 70 }))!;
    assert.ok(Math.abs(scroll.end!.y - 0.4) < 1e-9, "finger moves up 30% by default");
    const pinch = step({ kind: "pinch", x: 50, y: 50 });
    const strokes = touchStrokes(pinch, touchGeometry(pinch)!)[0];
    assert.equal(strokes.length, 2);
    assert.deepEqual(strokes.map((s) => s.pointer), [0, 1]);
    assert.ok(strokes[0].points[1].x < strokes[0].points[0].x, "finger 1 moves left");
    assert.ok(strokes[1].points[1].x > strokes[1].points[0].x, "finger 2 moves right (zoom in)");
  });

  it("double tap reuses one finger without overlap; drag holds first", () => {
    const dbl = touchStrokes(step({ kind: "doubleTap", x: 50, y: 50 }), { start: { x: 0.5, y: 0.5 } })[0];
    assert.ok(dbl[1].startMs >= dbl[0].startMs + dbl[0].durationMs);
    const drag = step({ kind: "drag", x: 10, y: 10, x2: 90, y2: 90 });
    const pts = touchStrokes(drag, touchGeometry(drag)!)[0][0].points;
    assert.deepEqual(pts[0], pts[1], "holds on the first segment");
  });

  it("summaries describe the settings", () => {
    assert.equal(summarizeStep(step({ kind: "tap", x: 12, y: 34 })), "at 12%, 34%");
    assert.equal(summarizeStep(step({ kind: "launch", packageName: "com.a.b" })), "com.a.b");
  });
});
