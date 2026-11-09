import test from "node:test";
import assert from "node:assert/strict";
import { favouritesFirst, parsePhonePrefs } from "./phone-prefs-core.ts";

test("phone prefs parse safely", () => {
  assert.deepEqual(parsePhonePrefs(null), { favs: [], notes: {} });
  assert.deepEqual(parsePhonePrefs("not json"), { favs: [], notes: {} });
  const p = parsePhonePrefs(JSON.stringify({ favs: ["a", 3], notes: { a: "  Farm ", b: "  ", c: 5 } }));
  assert.deepEqual(p.favs, ["a"]);
  assert.deepEqual(p.notes, { a: "  Farm " });
  assert.equal(parsePhonePrefs(JSON.stringify({ notes: { a: "x".repeat(99) } })).notes.a.length, 40);
});

test("favourites sort first and keep the rest in order", () => {
  const list = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  assert.deepEqual(favouritesFirst(list, new Set(["c", "d"])).map((d) => d.id), ["c", "d", "a", "b"]);
  assert.deepEqual(favouritesFirst(list, new Set()).map((d) => d.id), ["a", "b", "c", "d"]);
});
