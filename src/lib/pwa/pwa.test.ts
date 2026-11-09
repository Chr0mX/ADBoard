import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { deviceHint } from "./device-hint.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

type Handler = (event: unknown) => void;
function load(file: string, store: Map<string, Map<string, string>>) {
  const handlers: Record<string, Handler> = {};
  const caches = {
    open: async (name: string) => {
      if (!store.has(name)) store.set(name, new Map());
      const c = store.get(name)!;
      return {
        add: async (u: string) => void c.set(u, "x"),
        put: async (r: { url: string }) => void c.set(r.url, "x"),
        match: async (r: string | { url: string }) => (c.has(typeof r === "string" ? r : r.url) ? "hit" : undefined),
      };
    },
    keys: async () => [...store.keys()],
    delete: async (k: string) => store.delete(k),
    match: async (r: string | { url: string }) => {
      for (const c of store.values()) if (c.has(typeof r === "string" ? r : r.url)) return "hit";
      return undefined;
    },
  };
  const self = {
    location: { origin: "http://h" },
    addEventListener: (n: string, h: Handler) => (handlers[n] = h),
    skipWaiting: async () => {},
    clients: { claim: async () => {}, matchAll: async () => [] },
  };
  vm.runInNewContext(read(file), { self, caches, URL, fetch: async () => ({ ok: true, clone: () => ({}) }), Promise });
  return handlers;
}
const fetchEvent = (u: string) => {
  let responded = false;
  const event = { request: { method: "GET", url: "http://h" + u, headers: { get: () => "" } }, respondWith: () => (responded = true) };
  return { event, responded: () => responded };
};
const activate = async (h: Record<string, Handler>) => {
  let p: Promise<unknown> = Promise.resolve();
  h.activate({ waitUntil: (x: Promise<unknown>) => (p = x) });
  await p;
};

test("desktop worker ignores /m and only deletes its own caches", async () => {
  const store = new Map([["pc-shell-v1", new Map()], ["adboard-m-v1", new Map()], ["other", new Map()]]);
  const h = load("public/sw.js", store);
  for (const u of ["/m", "/m/", "/m/index.html", "/m/manifest.webmanifest", "/m/sw.js"]) {
    const f = fetchEvent(u);
    h.fetch(f.event);
    assert.equal(f.responded(), false, u);
  }
  const f = fetchEvent("/");
  h.fetch(f.event);
  assert.equal(f.responded(), true);
  await activate(h);
  assert.ok(store.has("adboard-m-v1"));
  assert.ok(store.has("other"));
  assert.ok(!store.has("pc-shell-v1") || /pc-shell-v\d+/.test([...store.keys()].join()));
});

test("mobile worker never handles the desktop shell and keeps other caches", async () => {
  const store = new Map([["adboard-m-v0", new Map()], ["pc-shell-v71", new Map()]]);
  const h = load("public/m/sw.js", store);
  for (const u of ["/", "/index.html", "/manifest.webmanifest", "/sw.js"]) {
    const f = fetchEvent(u);
    h.fetch(f.event);
    assert.equal(f.responded(), false, u);
  }
  const f = fetchEvent("/m/");
  h.fetch(f.event);
  assert.equal(f.responded(), true);
  await activate(h);
  assert.ok(store.has("pc-shell-v71"));
  assert.ok(!store.has("adboard-m-v0"));
  assert.ok(!read("public/m/sw.js").includes('caches.match("/")'));
});

test("manifests have separate identities", () => {
  const d = JSON.parse(read("public/manifest.webmanifest"));
  const m = JSON.parse(read("public/m/manifest.webmanifest"));
  assert.deepEqual([d.id, d.scope, d.start_url], ["/", "/", "/"]);
  assert.deepEqual([m.id, m.scope, m.start_url], ["/m/", "/m/", "/m/"]);
});

test("device hint: redirect only for installed phone-width apps, never when forced", () => {
  const base = { standalone: false, coarsePointer: true, width: 390, forcedDesktop: false, dismissed: false };
  assert.equal(deviceHint({ ...base, standalone: true }), "redirect");
  assert.equal(deviceHint(base), "banner");
  assert.equal(deviceHint({ ...base, dismissed: true }), "none");
  assert.equal(deviceHint({ ...base, standalone: true, forcedDesktop: true }), "none");
  assert.equal(deviceHint({ ...base, coarsePointer: false }), "none");
  assert.equal(deviceHint({ ...base, width: 1200, standalone: true }), "none");
});

test("the mobile UI does not branch on display mode", () => {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(path.join(root, d))) {
      const p = path.join(d, n);
      if (statSync(path.join(root, p)).isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk("src/components/adboard-m");
  walk("src/app/m");
  for (const f of files) assert.ok(!/display-mode|navigator\.standalone/.test(read(f)), f);
});

import { isStandalone, keyboardInset } from "./standalone.ts";

test("standalone detection: iOS flag or display-mode", () => {
  const mm = (on: boolean) => () => ({ matches: on });
  assert.equal(isStandalone({ standalone: true }, mm(false)), true);
  assert.equal(isStandalone({}, mm(true)), true);
  assert.equal(isStandalone({}, mm(false)), false);
  assert.equal(isStandalone(undefined, undefined), false);
});

test("keyboard inset ignores the Safari address bar, counts the keyboard", () => {
  assert.equal(keyboardInset(800, 740, 0), 0);
  assert.equal(keyboardInset(800, 500, 0), 300);
  assert.equal(keyboardInset(800, 450, 40), 310);
});

test("mobile manifest and metadata settings", () => {
  const m = JSON.parse(read("public/m/manifest.webmanifest"));
  assert.equal(m.display, "standalone");
  const layout = read("src/app/m/layout.tsx");
  assert.match(layout, /viewportFit: "cover"/);
  assert.match(layout, /capable: true/);
  assert.match(layout, /black-translucent/);
  assert.match(layout, /title: "ADBoard"/);
  assert.doesNotMatch(layout, /maximumScale: 1[,\s]/);
});

test("mobile header does not add a second top safe-area pad (the shell owns it)", () => {
  assert.doesNotMatch(read("src/components/adboard-m/mobile-app.tsx"), /pt-\[env\(safe-area-inset-top\)\]/);
  assert.match(read("src/app/globals.css"), /\.pc-shell \{[^}]*padding-top: env\(safe-area-inset-top/s);
});

test("one viewport hook; no other code writes the app-height variable", () => {
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(path.join(root, d))) {
      const p = path.join(d, n);
      if (statSync(path.join(root, p)).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(n) && !n.endsWith(".test.ts") && /setProperty\("--pc-app-height"/.test(read(p))) hits.push(p);
    }
  };
  walk("src");
  assert.deepEqual(hits, ["src/hooks/use-visual-viewport-lock.ts"]);
});
