import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/*
 * Keyframe requests restart the phone's encoder for every viewer. Two of the page's requests did that for no
 * good reason and are gone; these checks keep them gone. (The `KeyframeReason` type no longer has "connect" or
 * "sharpen", so the type check refuses them too.)
 */
const hub = readFileSync(new URL("./hub.ts", import.meta.url), "utf8");
const policy = readFileSync(new URL("./stream-policy-core.ts", import.meta.url), "utf8");

test("resizing a canvas never asks for a keyframe", () => {
  const observer = hub.slice(hub.indexOf("new ResizeObserver("), hub.indexOf("function boxOf("));
  assert.ok(observer.length > 0, "the canvas size observer is still there");
  assert.doesNotMatch(observer, /askKeyframe|postVideoRefresh|sharpen/);
  assert.doesNotMatch(hub, /askKeyframe\("sharpen"/);
});

test("a new socket's page side never asks for the connect-time keyframe (the agent does)", () => {
  assert.doesNotMatch(hub, /postVideoRefresh\(\[this\.serial\], "connect"/);
  assert.doesNotMatch(hub, /askKeyframe\("connect"/);
  const reasons = policy.slice(policy.indexOf("export type KeyframeReason"), policy.indexOf(";", policy.indexOf("export type KeyframeReason")));
  assert.doesNotMatch(reasons, /"connect"|"sharpen"/);
  assert.match(reasons, /"manual"/, "a person's Refresh still asks");
  assert.match(reasons, /"stall"/, "decoder recovery still asks");
});
