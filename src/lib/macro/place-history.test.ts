import assert from "node:assert/strict";
import { test } from "node:test";
import { createPlaceHistory } from "./place-history.ts";

test("undo returns snapshots newest first, and nothing when empty", () => {
  const h = createPlaceHistory<string>();
  assert.equal(h.undo(), undefined);
  h.push("a", 0);
  h.push("b", 1000);
  h.push("c", 2000);
  assert.equal(h.size, 3);
  assert.deepEqual([h.undo(), h.undo(), h.undo(), h.undo()], ["c", "b", "a", undefined]);
});

test("a drag (many quick changes) is one undo step that returns to before the drag", () => {
  const h = createPlaceHistory<number>(30, 600);
  h.push(1, 0); // add a step
  h.push(2, 2000); // drag starts
  for (let t = 2010; t < 2300; t += 10) h.push(3, t); // dozens of moves
  assert.equal(h.size, 2);
  assert.equal(h.undo(), 2);
  assert.equal(h.undo(), 1);
});

test("the history is bounded and can be cleared", () => {
  const h = createPlaceHistory<number>(3, 0);
  for (let i = 0; i < 10; i += 1) h.push(i, i * 1000);
  assert.equal(h.size, 3);
  assert.equal(h.undo(), 9);
  h.clear();
  assert.equal(h.size, 0);
});

test("adds and deletes are never joined, even when they come quickly", () => {
  const h = createPlaceHistory<string>(30, 600);
  h.push("empty", 0, false);
  h.push("one", 100, false);
  h.push("two", 200, false);
  assert.equal(h.size, 3);
  // A drag right after an add is its own step.
  h.push("three", 300);
  assert.equal(h.size, 4);
  assert.deepEqual([h.undo(), h.undo()], ["three", "two"]);
});
