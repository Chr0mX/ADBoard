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
