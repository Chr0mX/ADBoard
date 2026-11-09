import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { MORE_SECTION_IDS, parseMobilePath, pathForSection, sectionOfRoute } from "./routes.ts";

const root = path.resolve(import.meta.dirname, "../../..");

test("paths parse with and without a trailing slash", () => {
  assert.deepEqual(parseMobilePath("/m"), { view: "root" });
  assert.deepEqual(parseMobilePath("/m/"), { view: "root" });
  assert.deepEqual(parseMobilePath("/m/control/"), { view: "control" });
  assert.deepEqual(parseMobilePath("/m/control"), { view: "control" });
  assert.deepEqual(parseMobilePath("/m/devices/"), { view: "devices" });
  assert.deepEqual(parseMobilePath("/m/macros"), { view: "macros" });
  assert.deepEqual(parseMobilePath("/m/more/"), { view: "more" });
  assert.deepEqual(parseMobilePath("/m/more/files/"), { view: "section", section: "files" });
  assert.deepEqual(parseMobilePath("/m/more/nope/"), { view: "more" });
  assert.deepEqual(parseMobilePath("/"), { view: "root" });
  assert.deepEqual(parseMobilePath(null), { view: "root" });
});

test("every desk section has a mobile path that parses back to it", () => {
  for (const id of ["control", "macros", ...MORE_SECTION_IDS]) {
    assert.equal(sectionOfRoute(parseMobilePath(pathForSection(id))), id);
  }
  assert.equal(sectionOfRoute(parseMobilePath("/m/devices/")), "control");
  assert.equal(sectionOfRoute(parseMobilePath("/m/more/")), null);
});

test("route ids match the desk sections (routes.ts cannot import the client module)", () => {
  const src = readFileSync(path.join(root, "src/components/adboard/desk/desk-context.tsx"), "utf8");
  const ids = [...src.matchAll(/\{ id: "([a-z]+)", label:/g)].map((m) => m[1]);
  assert.deepEqual([...ids].sort(), ["control", "macros", ...MORE_SECTION_IDS].sort());
});

test("each mobile route has a page file; /m redirects", () => {
  for (const d of ["control", "devices", "macros", "more", "more/[section]"]) {
    assert.ok(existsSync(path.join(root, "src/app/m", d, "page.tsx")), d);
  }
  assert.match(readFileSync(path.join(root, "src/app/m/page.tsx"), "utf8"), /MobileRootRedirect/);
  assert.match(readFileSync(path.join(root, "src/components/adboard-m/root-redirect.tsx"), "utf8"), /router\.replace\(MOBILE_HOME\)/);
});

test("mobile service worker: v3, shell covers screens, only its own caches", () => {
  const sw = readFileSync(path.join(root, "public/m/sw.js"), "utf8");
  assert.match(sw, /const CACHE_VERSION = "adboard-m-v3";/);
  assert.match(sw, /key\.startsWith\(CACHE_PREFIX\)/);
});

test("the mobile worker precaches every screen", () => {
  const sw = readFileSync(path.join(root, "public/m/sw.js"), "utf8");
  for (const id of MORE_SECTION_IDS) assert.ok(sw.includes(`"${id}"`), id);
  for (const id of ["control", "devices", "macros", "more"]) assert.ok(sw.includes(`"${id}"`), id);
});

test("the build marker on the mobile shell matches the service worker cache version", () => {
  const sw = readFileSync(path.join(root, "public/m/sw.js"), "utf8");
  const version = sw.match(/const CACHE_VERSION = "([^"]+)";/)?.[1];
  const app = readFileSync(path.join(root, "src/components/adboard-m/mobile-app.tsx"), "utf8");
  assert.ok(version);
  assert.ok(app.includes(`data-ui-build="${version}"`), `data-ui-build should be ${version}`);
});

test("data-m attributes the tests and selectors rely on are kept", () => {
  const all = ["mobile-app.tsx", "mobile-nav.tsx"].map((f) => readFileSync(path.join(root, "src/components/adboard-m", f), "utf8")).join("\n");
  for (const a of ["data-m-nav", "data-m-tab", "data-m-badge", "data-m-more", "data-m-desktop-link"]) assert.ok(all.includes(a), a);
  assert.ok(all.includes("/?desktop=1"));
});
