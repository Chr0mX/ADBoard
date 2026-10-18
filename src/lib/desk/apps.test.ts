import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  categoriesOf,
  duplicateMessage,
  findDuplicate,
  matchesSearch,
  nameFromPackage,
  normalizeCategory,
  parsePackages,
} from "./apps.ts";
import type { AppShortcut } from "./store.ts";

const app = (id: string, packageName: string, group: string, name = packageName): AppShortcut => ({ id, name, packageName, activity: "", group });

describe("parsePackages", () => {
  it("reads pm output, sorted, without repeats or junk", () => {
    const out = "package:org.telegram.messenger\r\npackage:com.a.b\n\npackage:com.a.b\nWarning: not a package\npackage:bad id\n";
    assert.deepEqual(parsePackages(out), ["com.a.b", "org.telegram.messenger"]);
  });
  it("handles empty or missing output", () => {
    assert.deepEqual(parsePackages(""), []);
    assert.deepEqual(parsePackages(undefined), []);
  });
});

describe("categories", () => {
  it("normalises names, reusing an existing spelling", () => {
    const existing = ["Games", "Media", "Tools", "Custom", "Farm Bots"];
    assert.equal(normalizeCategory("  farm   bots ", existing), "Farm Bots");
    assert.equal(normalizeCategory("games", existing), "Games");
    assert.equal(normalizeCategory("New Stuff", existing), "New Stuff");
    assert.equal(normalizeCategory("   ", existing), "Custom");
    assert.equal(normalizeCategory("x".repeat(100), existing).length, 40);
  });
  it("lists built-ins first, then custom ones in the order they appear", () => {
    const apps = [app("1", "a.b", "Zeta"), app("2", "c.d", "games"), app("3", "e.f", "Alpha"), app("4", "g.h", "zeta"), app("5", "i.j", "")];
    assert.deepEqual(categoriesOf(apps), ["Games", "Media", "Tools", "Custom", "Zeta", "Alpha"]);
  });
  it("an app without a category counts as Custom", () => {
    assert.deepEqual(categoriesOf([app("1", "a.b", "")]), ["Games", "Media", "Tools", "Custom"]);
  });
});

describe("duplicates", () => {
  const apps = [app("1", "com.example.game", "Games", "Example Game")];
  it("finds an app already saved by package id", () => {
    assert.equal(findDuplicate(apps, " com.example.game ")?.id, "1");
    assert.equal(findDuplicate(apps, "com.example.other"), undefined);
  });
  it("ignores the app being edited", () => {
    assert.equal(findDuplicate(apps, "com.example.game", "1"), undefined);
  });
  it("says where the existing app is", () => {
    assert.equal(duplicateMessage(apps[0]), "Already saved as “Example Game” in Games.");
  });
});

describe("names and search", () => {
  it("falls back to the last part of the package id", () => {
    assert.equal(nameFromPackage("org.telegram.messenger"), "messenger");
    assert.equal(nameFromPackage("single"), "single");
  });
  it("searches package ids and names, ignoring case", () => {
    assert.ok(matchesSearch("jp.goodsmile.grandsummonersglobal_android", null, "GRAND"));
    assert.ok(matchesSearch("com.x.y", "Grand Summoners", "summoners"));
    assert.ok(!matchesSearch("com.x.y", "Telegram", "grand"));
    assert.ok(matchesSearch("com.x.y", null, "  "));
  });
});
