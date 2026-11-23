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
  keepsSocketInBackground,
  needsKeyframeAfter,
  readBackgroundPolicy,
  recoveryStep,
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
  for (const p of [policy(true, 5), policy(false, 5), policy(false, 1)]) assert.equal(mode(false, false, p), "hold-then-suspend");
});

test("a hidden window pauses by default and keeps the socket when Pause is off", () => {
  assert.equal(mode(true, true), "hold-then-suspend");
  assert.equal(mode(true, false), "hold-then-suspend");
  assert.equal(mode(true, true, policy(false, 1)), "sample-keyframes");
  assert.equal(mode(true, true, policy(false, 2)), "throttle-paint");
  assert.equal(mode(true, false, policy(false, 60)), "throttle-paint", "hidden window dominates a stream whose views are also off screen");
});

test("a decoder path that cannot be thinned falls back to pausing", () => {
  assert.equal(mode(true, true, policy(false, 10), false), "hold-then-suspend");
});

test("only the thinned modes keep a socket while hidden", () => {
  assert.deepEqual(["full", "hold-then-suspend", "sample-keyframes", "throttle-paint"].map((m) => keepsSocketInBackground(m as never)), [false, false, true, true]);
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
  assert.equal(needsKeyframeAfter("hold-then-suspend", "full"), true);
  assert.equal(needsKeyframeAfter("throttle-paint", "full"), false, "every frame was decoded: the chain is intact");
  assert.equal(needsKeyframeAfter("hold-then-suspend", "sample-keyframes"), false);
  assert.equal(needsKeyframeAfter("full", "throttle-paint"), false);
});

test("recovery waits for a picture, then asks once, then starts the connection over", () => {
  assert.equal(recoveryStep({ elapsedMs: 300, framesSince: 0, asked: false }), "wait");
  assert.equal(recoveryStep({ elapsedMs: 1300, framesSince: 0, asked: false }), "ask-keyframe");
  assert.equal(recoveryStep({ elapsedMs: 1300, framesSince: 0, asked: true }), "wait");
  assert.equal(recoveryStep({ elapsedMs: 4100, framesSince: 0, asked: true }), "reconnect");
  assert.equal(recoveryStep({ elapsedMs: 4100, framesSince: 3, asked: true }), "done", "a picture arrived: nothing more to do");
});
