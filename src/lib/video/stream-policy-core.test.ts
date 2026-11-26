import assert from "node:assert/strict";
import { test } from "node:test";
import { onVisibilityChange, shouldSuspend } from "./stream-policy-core.ts";

test("hiding arms one timer; showing again before it fires disarms it", () => {
  assert.equal(onVisibilityChange({ suspended: false, armed: false }, false), "arm");
  assert.equal(onVisibilityChange({ suspended: false, armed: true }, false), "none");
  assert.equal(onVisibilityChange({ suspended: false, armed: true }, true), "disarm");
  assert.equal(onVisibilityChange({ suspended: false, armed: false }, true), "none");
});

test("a suspended stream resumes when shown and stays suspended while hidden", () => {
  assert.equal(onVisibilityChange({ suspended: true, armed: false }, true), "resume");
  assert.equal(onVisibilityChange({ suspended: true, armed: false }, false), "none");
});

test("the timer suspends only a stream that is still hidden", () => {
  assert.equal(shouldSuspend({ suspended: false, armed: true }, false), true);
  assert.equal(shouldSuspend({ suspended: false, armed: true }, true), false);
  assert.equal(shouldSuspend({ suspended: true, armed: true }, false), false);
});

import {
  DEFAULT_BACKGROUND_POLICY,
  backgroundFrameDue,
  clampBackgroundFps,
  decodeStallStep,
  type DecodeStallState,
  keepsSocketInBackground,
  needsKeyframeAfter,
  readBackgroundPolicy,
  recoveryStep,
  stallAction,
  viewerMessage,
  streamMode,
} from "./stream-policy-core.ts";

const policy = (pause: boolean, fps: number) => ({ pause, fps });
const mode = (pageHidden: boolean, anyViewVisible: boolean, p = DEFAULT_BACKGROUND_POLICY, canThrottle = true) =>
  streamMode({ pageHidden, anyViewVisible, policy: p, canThrottle });

test("the saved background settings default to the original suspension behaviour", () => {
  assert.deepEqual(readBackgroundPolicy(null, null), { pause: true, fps: 5 });
  assert.deepEqual(readBackgroundPolicy(undefined, "abc"), { pause: true, fps: 5 });
  assert.equal(readBackgroundPolicy("1", "10").pause, true);
  assert.equal(readBackgroundPolicy("0", "10").pause, false);
  assert.equal(readBackgroundPolicy("junk", "10").pause, true, "only an explicit 0 turns pausing off");
});

test("the background FPS is a whole number from 1 to 60", () => {
  assert.equal(clampBackgroundFps(1), 1);
  assert.equal(clampBackgroundFps(60), 60);
  assert.equal(clampBackgroundFps(0), 5);
  assert.equal(clampBackgroundFps(-3), 5);
  assert.equal(clampBackgroundFps(61), 60);
  assert.equal(clampBackgroundFps("12.4"), 12);
  assert.equal(clampBackgroundFps(""), 5);
  for (let fps = 1; fps <= 60; fps++) assert.equal(clampBackgroundFps(fps), fps);
});

test("a visible window shows at full speed whatever the background setting says", () => {
  for (const p of [policy(true, 1), policy(false, 1), policy(false, 60)]) assert.equal(mode(false, true, p), "full");
});

test("a phone scrolled off screen is suspended on its own; the background setting does not apply", () => {
  for (const p of [policy(true, 5), policy(false, 5), policy(false, 1)]) assert.equal(mode(false, false, p), "idle");
});

test("a hidden window pauses by default and keeps the socket when Pause is off", () => {
  assert.equal(mode(true, true), "idle");
  assert.equal(mode(true, false), "idle");
  assert.equal(mode(true, true, policy(false, 1)), "sample-keyframes");
  assert.equal(mode(true, true, policy(false, 2)), "throttle-paint");
  assert.equal(mode(true, false, policy(false, 60)), "throttle-paint", "hidden window dominates a stream whose views are also off screen");
});

test("a decoder path that cannot be thinned falls back to pausing", () => {
  assert.equal(mode(true, true, policy(false, 10), false), "idle");
});

test("only the thinned modes keep a socket while hidden", () => {
  assert.deepEqual(["full", "idle", "sample-keyframes", "throttle-paint"].map((m) => keepsSocketInBackground(m as never)), [false, false, true, true]);
});

test("one picture is due per 1/FPS across the whole range", () => {
  assert.equal(backgroundFrameDue(0, 1), false);
  assert.equal(backgroundFrameDue(998, 1), true);
  assert.equal(backgroundFrameDue(400, 2), false);
  assert.equal(backgroundFrameDue(499, 2), true);
  for (let fps = 1; fps <= 60; fps++) {
    const interval = 1000 / fps;
    assert.equal(backgroundFrameDue(interval, fps), true, `fps ${fps} at its interval`);
    assert.equal(backgroundFrameDue(interval / 2 - 3, fps), false, `fps ${fps} at half its interval`);
  }
  // Over a minute of 120 fps input, the pictures kept match the setting.
  for (const fps of [1, 5, 15, 30, 60]) {
    let last = -1000;
    let kept = 0;
    for (let t = 0; t < 60_000; t += 1000 / 120) {
      if (backgroundFrameDue(t - last, fps)) {
        kept += 1;
        last = t;
      }
    }
    assert.ok(Math.abs(kept - fps * 60) <= Math.max(2, fps * 60 * 0.06), `fps ${fps}: kept ${kept}`);
  }
});

test("returning from a thinned or suspended stream needs a fresh keyframe", () => {
  assert.equal(needsKeyframeAfter("sample-keyframes", "full"), true);
  assert.equal(needsKeyframeAfter("idle", "full"), true);
  assert.equal(needsKeyframeAfter("throttle-paint", "full"), false, "every frame was decoded: the chain is intact");
  assert.equal(needsKeyframeAfter("idle", "sample-keyframes"), false);
  assert.equal(needsKeyframeAfter("full", "throttle-paint"), false);
});

test("recovery waits for a picture, then asks once, then starts the connection over", () => {
  const step = (elapsedMs: number, framesSince: number, asked: boolean, rebuilt = false) => recoveryStep({ elapsedMs, framesSince, asked, rebuilt });
  assert.equal(step(300, 0, false), "wait");
  assert.equal(step(1300, 0, false), "ask-keyframe");
  assert.equal(step(1300, 0, true), "wait");
  assert.equal(step(3100, 0, true), "rebuild-decoder");
  assert.equal(step(3100, 0, true, true), "wait", "the decoder is rebuilt once");
  assert.equal(step(4100, 3, true), "done", "a picture arrived: nothing more to do");
});

test("a decoder that gets frames but shows nothing is asked for a keyframe after two seconds", () => {
  let state: DecodeStallState = { seen: 0, decoded: 0, since: 0 };
  const look = (seen: number, decoded: number, at: number) => {
    const step = decodeStallStep(state, { seen, decoded, at });
    state = step.state;
    return step.ask;
  };
  assert.equal(look(5, 0, 500), false, "just started");
  assert.equal(look(20, 0, 1500), false);
  assert.equal(look(40, 0, 2600), true, "frames arrive, none decodes, 2 s on");
  assert.equal(look(60, 0, 3100), false, "the clock starts again after asking");
  assert.equal(look(80, 0, 4700), true, "and asks again if it still does not decode");
});

test("a still screen and a working stream never trigger the stall ask", () => {
  let state: DecodeStallState = { seen: 10, decoded: 10, since: 0 };
  // Nothing arrives for ten seconds: a still screen.
  for (let at = 500; at <= 10_000; at += 500) {
    const step = decodeStallStep(state, { seen: 10, decoded: 10, at });
    assert.equal(step.ask, false);
    state = step.state;
  }
  // Frames arrive and are decoded.
  for (let i = 1; i <= 20; i++) {
    const step = decodeStallStep(state, { seen: 10 + i * 5, decoded: 10 + i * 5, at: 10_000 + i * 500 });
    assert.equal(step.ask, false);
    state = step.state;
  }
});

// ---- persistent connection: what may and may not close a viewer's socket ----

test("no step of the recovery ladder is a reconnect, however long nothing arrives", () => {
  const seen = new Set<string>();
  for (let elapsedMs = 0; elapsedMs <= 120_000; elapsedMs += 100) {
    for (const asked of [false, true]) {
      for (const rebuilt of [false, true]) seen.add(recoveryStep({ elapsedMs, framesSince: 0, asked, rebuilt }));
    }
  }
  assert.deepEqual([...seen].sort(), ["ask-keyframe", "rebuild-decoder", "wait"], "a still screen is never a reason to reconnect");
});

test("hiding the window, Alt-Tab and a tile out of sight make a viewer idle, never a closed socket", () => {
  // Every situation with nothing to show maps to "idle" or a thinned mode that keeps the socket.
  for (const p of [policy(true, 5), policy(false, 5), policy(false, 1), policy(false, 60)]) {
    for (const pageHidden of [false, true]) {
      for (const anyViewVisible of [false, true]) {
        for (const canThrottle of [false, true]) {
          const m = mode(pageHidden, anyViewVisible, p, canThrottle);
          assert.ok(["full", "idle", "sample-keyframes", "throttle-paint"].includes(m), m);
        }
      }
    }
  }
  assert.equal(mode(true, true, policy(true, 5)), "idle", "hidden window with Pause on");
  assert.equal(mode(false, false), "idle", "a tile out of sight");
});

test("the idle timer only goes idle after the grace period, and returning cancels it or resumes", () => {
  // Hidden: arm. Back within the grace: disarm. Went idle: showing again resumes (tells the agent), nothing reconnects.
  assert.equal(onVisibilityChange({ suspended: false, armed: false }, false), "arm");
  assert.equal(onVisibilityChange({ suspended: false, armed: true }, true), "disarm");
  assert.equal(onVisibilityChange({ suspended: true, armed: false }, true), "resume");
  // A second hide while already idle changes nothing: no timers pile up.
  assert.equal(onVisibilityChange({ suspended: true, armed: false }, false), "none");
  assert.equal(onVisibilityChange({ suspended: false, armed: true }, false), "none");
});

test("a stalled decoder is first asked for a keyframe and only then rebuilt", () => {
  assert.equal(stallAction(0), "ask-keyframe");
  assert.equal(stallAction(1), "rebuild-decoder");
  assert.equal(stallAction(5), "rebuild-decoder");
});

test("the viewer message is the plain control message the agent expects", () => {
  assert.deepEqual(JSON.parse(viewerMessage(false)), { type: "viewer", active: false });
  assert.deepEqual(JSON.parse(viewerMessage(true)), { type: "viewer", active: true });
});
