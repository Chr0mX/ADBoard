import assert from "node:assert/strict";
import test from "node:test";
import { TimeoutError, withTimeout } from "./timeout.ts";

test("an answer in time passes through", async () => {
  assert.equal(await withTimeout(Promise.resolve(7), 100), 7);
});

test("a failure in time passes through unchanged", async () => {
  await assert.rejects(withTimeout(Promise.reject(new Error("boom")), 100), /boom/);
});

test("a request that never answers is given up on, and the abort hook runs", async () => {
  let aborted = false;
  const never = new Promise<number>(() => {});
  const started = Date.now();
  await assert.rejects(withTimeout(never, 50, () => (aborted = true)), (error: unknown) => error instanceof TimeoutError && error.ms === 50);
  assert.equal(aborted, true);
  assert.ok(Date.now() - started < 1000);
});

test("a late answer after the timeout changes nothing", async () => {
  let resolveLate: (value: number) => void = () => {};
  const late = new Promise<number>((resolve) => (resolveLate = resolve));
  const guarded = withTimeout(late, 20);
  await assert.rejects(guarded, TimeoutError);
  resolveLate(1); // must not throw or resolve anything
});
