import assert from "node:assert/strict";
import { test } from "node:test";
import { createCoalescedRefresh } from "./refresh-core.ts";

function deferredFetcher() {
  const pending: Array<(value: number) => void> = [];
  let calls = 0;
  return {
    fetcher: () => {
      calls += 1;
      return new Promise<number>((resolve) => pending.push(resolve));
    },
    resolveNext: (value: number) => pending.shift()?.(value),
    calls: () => calls,
  };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a burst of triggers makes one fetch and one follow-up, and the last answer wins", async () => {
  const source = deferredFetcher();
  const applied: number[] = [];
  const refresh = createCoalescedRefresh(source.fetcher, (v) => applied.push(v));
  for (let i = 0; i < 12; i += 1) refresh.trigger();
  assert.equal(source.calls(), 1);
  source.resolveNext(1); // overtaken by the triggers that came while it ran
  await tick();
  assert.equal(source.calls(), 2);
  assert.deepEqual(applied, []);
  source.resolveNext(2);
  await tick();
  assert.deepEqual(applied, [2]);
  assert.equal(source.calls(), 2);
});

test("an answer overtaken by a pushed list is dropped", async () => {
  const source = deferredFetcher();
  const applied: number[] = [];
  const refresh = createCoalescedRefresh(source.fetcher, (v) => applied.push(v));
  refresh.trigger();
  refresh.invalidate();
  source.resolveNext(1);
  await tick();
  assert.deepEqual(applied, []);
  refresh.trigger();
  source.resolveNext(2);
  await tick();
  assert.deepEqual(applied, [2]);
});

test("a failed fetch does not stop later refreshes, and dispose stops everything", async () => {
  let fail = true;
  const applied: number[] = [];
  const refresh = createCoalescedRefresh(
    () => (fail ? Promise.reject(new Error("down")) : Promise.resolve(7)),
    (v) => applied.push(v),
  );
  refresh.trigger();
  await tick();
  fail = false;
  refresh.trigger();
  await tick();
  assert.deepEqual(applied, [7]);
  refresh.dispose();
  refresh.trigger();
  await tick();
  assert.deepEqual(applied, [7]);
});
