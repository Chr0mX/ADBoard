import assert from "node:assert/strict";
import { test } from "node:test";
import { pickCategory } from "./settings-categories.ts";

const categories = [
  { id: "stream", label: "Stream", group: "Phones" },
  { id: "control", label: "Control", group: "Controls" },
];

test("the remembered category is kept while it exists, otherwise the first one is shown", () => {
  assert.equal(pickCategory(categories, "control"), "control");
  assert.equal(pickCategory(categories, "account"), "stream"); // Account only exists with a password set
  assert.equal(pickCategory(categories, null), "stream");
  assert.equal(pickCategory([], "stream"), "");
});
