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
  assert.match(sw, /const CACHE_VERSION = "adboard-m-v11";/);
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
  const all = ["mobile-app.tsx", "mobile-nav.tsx", "more-screen.tsx"].map((f) => readFileSync(path.join(root, "src/components/adboard-m", f), "utf8")).join("\n");
  for (const a of ["data-m-nav", "data-m-tab", "data-m-badge", "data-m-more", "data-m-desktop-link"]) assert.ok(all.includes(a), a);
  assert.ok(all.includes("/?desktop=1"));
});

test("the More screen keeps every destination and setting", () => {
  const more = readFileSync(path.join(root, "src/components/adboard-m/more-screen.tsx"), "utf8");
  const app = readFileSync(path.join(root, "src/components/adboard-m/mobile-app.tsx"), "utf8");
  for (const a of ["data-m-taskbar-open", "data-m-text-size", "data-m-events-badge", "data-m-sign-out", "data-m-account", "<DisplayInfo"]) assert.ok(more.includes(a), a);
  for (const pref of ["strip", "haptics", "sounds"]) assert.ok(more.includes(`"${pref}")`), pref);
  // Every More section is reachable, grouped as Phones (work) and System.
  for (const id of ["manage", "apps", "files", "automate", "developer", "hosts", "events", "storage", "settings"]) assert.ok(more.includes(`${id}:`), id);
  assert.ok(app.includes("<MoreScreen") && app.includes("<TaskbarSheet"));
});

test("phone Macros: the list, the editor and the full-screen placer are wired in and keep every card", () => {
  const app = readFileSync(path.join(root, "src/components/adboard-m/mobile-app.tsx"), "utf8");
  const m = readFileSync(path.join(root, "src/components/adboard-m/macros-mobile.tsx"), "utf8");
  assert.ok(app.includes("<MacrosMobile />") && !app.includes("<MacrosPanel />"));
  for (const a of ["data-m-macros-list", "data-m-macro-row", "data-m-macro-editor", "data-m-macro-place-open", "data-m-macro-place", "data-place-undo", "data-place-test", "data-macro-search", "data-macro-sort", "data-macro-group-field", "data-macro-quick-start"]) assert.ok(m.includes(a), a);
  // Every existing card is still reachable.
  for (const c of ["<RunCard", "<SettingsCard", "<QueueCard", "<ScheduleCard", "<PhoneRunsCard", "<StepList", "<AddStepBar", "<ImportButton", "<VersionsMenu", "<ExportMenu", "<ImportDialog"]) assert.ok(m.includes(c), c);
  // The desktop layout keeps its own component.
  assert.ok(readFileSync(path.join(root, "src/components/adboard/adboard-app.tsx"), "utf8").includes("<MacrosDesktop />"));
});
