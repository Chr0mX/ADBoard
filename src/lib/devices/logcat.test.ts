import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendLines, filterLines, parseFrame, parseLogLine } from "./logcat.ts";
import { parseAppDetail, parseTweaks, permissionLabel, shortActivity, sortedOps } from "./app-controls.ts";

describe("logcat lines", () => {
  it("parses threadtime lines", () => {
    const line = parseLogLine("10-30 12:00:00.123  4242  4250 E AndroidRuntime: FATAL EXCEPTION: main", 1);
    assert.equal(line.level, "E");
    assert.equal(line.tag, "AndroidRuntime");
    assert.equal(line.message, "FATAL EXCEPTION: main");
    assert.equal(line.pid, "4242");
    assert.equal(parseLogLine("10-30 12:00:00.123  1  1 A libc  : abort", 2).level, "F");
  });

  it("keeps other lines as plain text", () => {
    const line = parseLogLine("--------- beginning of main", 3);
    assert.equal(line.level, null);
    assert.equal(line.message, "--------- beginning of main");
  });

  it("caps the buffer and searches", () => {
    const lines = Array.from({ length: 10 }, (_, i) => parseLogLine(`10-30 12:00:00.000  1  1 I Tag${i}: message ${i}`, i));
    const kept = appendLines(lines.slice(0, 6), lines.slice(6), 8);
    assert.equal(kept.length, 8);
    assert.equal(kept[0].id, 2);
    assert.deepEqual(filterLines(kept, "TAG9").map((l) => l.id), [9]);
    assert.equal(filterLines(kept, "  ").length, 8);
  });

  it("reads agent frames", () => {
    assert.deepEqual(parseFrame('{"lines":["a",1,"b"]}'), { lines: ["a", "b"] });
    assert.deepEqual(parseFrame('{"note":"mock"}'), { note: "mock" });
    assert.deepEqual(parseFrame('{"skipped":12}'), { skipped: 12 });
    assert.equal(parseFrame("nope"), null);
  });
});

describe("app controls", () => {
  it("reads the agent's app detail", () => {
    const detail = parseAppDetail(
      JSON.stringify({ package: "com.game", uid: 10234, ops: { CAMERA: "allow" }, permissions: [{ name: "android.permission.CAMERA", granted: true }], networkAllowed: false }),
    );
    assert.equal(detail?.uid, 10234);
    assert.equal(detail?.networkAllowed, false);
    assert.equal(detail?.bucket, null);
    assert.equal(parseAppDetail("not json"), null);
    assert.equal(parseAppDetail("{}"), null);
  });

  it("sorts the ops that keep apps running first", () => {
    const ops = { CAMERA: "allow", WAKE_LOCK: "allow", RUN_ANY_IN_BACKGROUND: "ignore", ALARM: "allow" };
    assert.deepEqual(sortedOps(ops).map(([n]) => n), ["RUN_ANY_IN_BACKGROUND", "WAKE_LOCK", "ALARM", "CAMERA"]);
    assert.deepEqual(sortedOps(ops, "cam").map(([n]) => n), ["CAMERA"]);
  });

  it("labels and tweaks", () => {
    assert.equal(permissionLabel("android.permission.POST_NOTIFICATIONS"), "Post notifications");
    assert.equal(shortActivity("com.game.ui.Main", "com.game"), ".ui.Main");
    assert.equal(shortActivity("org.other.Main", "com.game"), "org.other.Main");
    assert.deepEqual(parseTweaks('{"forceDark":true}'), { devOptionsHidden: false, phantomKillerOff: false, forceDark: true });
    assert.equal(parseTweaks(""), null);
  });
});
