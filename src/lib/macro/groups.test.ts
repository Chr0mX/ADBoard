import assert from "node:assert/strict";
import { test } from "node:test";
import { UNGROUPED, buildLibrary, flatOrder, groupNames, matchesQuery, parseSort, stepSelection } from "./groups.ts";

const tab = (id: string, name: string, group?: string, updatedAt = 0) => ({ id, name, group, updatedAt });
const tabs = [
  tab("1", "Daily quests", "Games", 5),
  tab("2", "Clear cache", "Utilities", 9),
  tab("3", "Farm loop", "games", 1),
  tab("4", "Scratch"),
  tab("5", "Event grind", "Games", 7),
];

test("groups appear in first-seen order, one group whatever the capitalisation, Ungrouped last", () => {
  const library = buildLibrary(tabs, "", "manual");
  assert.deepEqual(library.map((g) => g.name), ["Games", "Utilities", UNGROUPED]);
  assert.deepEqual(library[0].tabs.map((t) => t.id), ["1", "3", "5"]);
  assert.equal(library[2].key, "");
});

test("name sort orders groups and macros alphabetically; recent sort puts the latest edit first", () => {
  const byName = buildLibrary(tabs, "", "name");
  assert.deepEqual(byName.map((g) => g.name), ["Games", "Utilities", UNGROUPED]);
  assert.deepEqual(byName[0].tabs.map((t) => t.name), ["Daily quests", "Event grind", "Farm loop"]);
  const recent = buildLibrary(tabs, "", "recent");
  // Groups follow their most recently edited macro; inside a group the latest edit is first.
  assert.deepEqual(recent.map((g) => g.name), ["Utilities", "Games", UNGROUPED]);
  assert.deepEqual(recent[1].tabs.map((t) => t.id), ["5", "1", "3"]);
});

test("search matches the name or the group, ignoring case, and drops empty groups", () => {
  assert.equal(matchesQuery(tab("1", "Daily quests", "Games"), "QUEST"), true);
  assert.equal(matchesQuery(tab("1", "Daily quests", "Games"), "gam"), true);
  assert.equal(matchesQuery(tab("1", "Daily quests"), "util"), false);
  const found = buildLibrary(tabs, "cache", "manual");
  assert.deepEqual(found.map((g) => g.name), ["Utilities"]);
  assert.deepEqual(buildLibrary(tabs, "nothing here", "manual"), []);
});

test("group names are listed once each for suggestions", () => {
  assert.deepEqual(groupNames(tabs), ["Games", "Utilities"]);
});

test("collapsed groups leave the keyboard order; arrows stop at the ends", () => {
  const library = buildLibrary(tabs, "", "manual");
  const order = flatOrder(library, new Set(["Games"]));
  assert.deepEqual(order.map((t) => t.id), ["2", "4"]);
  assert.equal(stepSelection(order, "2", 1), "4");
  assert.equal(stepSelection(order, "4", 1), "4");
  assert.equal(stepSelection(order, "2", -1), "2");
  assert.equal(stepSelection(order, null, 1), "2");
  assert.equal(stepSelection(order, "gone", -1), "4");
  assert.equal(stepSelection([], "x", 1), null);
});

test("an unknown sort value means manual order", () => {
  assert.equal(parseSort("name"), "name");
  assert.equal(parseSort("recent"), "recent");
  assert.equal(parseSort("bogus"), "manual");
  assert.equal(parseSort(null), "manual");
});
