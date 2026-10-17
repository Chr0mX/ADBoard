import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dueSchedules, nextRunAt, normalizeSchedules, runQueueItems, type MacroSchedule } from "./automation.ts";
import type { RunSnapshot } from "./core.ts";

const snap = (status: RunSnapshot["status"], message?: string): RunSnapshot => ({
  status,
  cycle: 1,
  stepIndex: 0,
  stepCount: 1,
  touches: 1,
  startedAt: 0,
  devices: {},
  message,
});

describe("runQueueItems", () => {
  it("plays tabs in order, skips missing ones and continues after a failure", async () => {
    const order: string[] = [];
    const result = await runQueueItems({
      items: [
        { id: "1", tabId: "a" },
        { id: "2", tabId: "gone" },
        { id: "3", tabId: "b" },
        { id: "4", tabId: "c" },
      ],
      hasTab: (id) => id !== "gone",
      start: async (id) => {
        order.push(id);
        return id === "b" ? snap("failed", "Every phone failed") : snap("done");
      },
      signal: new AbortController().signal,
      onProgress: () => {},
    });
    assert.deepEqual(order, ["a", "b", "c"]);
    assert.equal(result.states["1"].state, "done");
    assert.equal(result.states["2"].state, "skipped");
    assert.equal(result.states["3"].state, "failed");
    assert.equal(result.states["4"].state, "done");
    assert.equal(result.running, false);
  });

  it("stops the rest when aborted", async () => {
    const controller = new AbortController();
    const order: string[] = [];
    const result = await runQueueItems({
      items: [
        { id: "1", tabId: "a" },
        { id: "2", tabId: "b" },
      ],
      hasTab: () => true,
      start: async (id) => {
        order.push(id);
        controller.abort();
        return snap("stopped", "Stopped");
      },
      signal: controller.signal,
      onProgress: () => {},
    });
    assert.deepEqual(order, ["a"]);
    assert.equal(result.states["2"].state, "stopped");
  });
});

describe("schedules", () => {
  const base: MacroSchedule = {
    id: "s",
    target: { kind: "tab", tabId: "a" },
    kind: "once",
    at: 1_000_000,
    everyMinutes: 10,
    enabled: true,
  };

  it("fires a one-off once", () => {
    assert.equal(nextRunAt(base, 0), 1_000_000);
    assert.equal(dueSchedules([base], 999_999).length, 0);
    assert.equal(dueSchedules([base], 1_000_000).length, 1);
    assert.equal(nextRunAt({ ...base, lastRunAt: 1_000_100 }, 2_000_000), null);
    assert.equal(nextRunAt({ ...base, enabled: false }, 0), null);
  });

  it("repeats every N minutes and collapses missed slots", () => {
    const every: MacroSchedule = { ...base, kind: "every" };
    const tenMin = 600_000;
    assert.equal(nextRunAt(every, 0), 1_000_000);
    assert.equal(nextRunAt({ ...every, lastRunAt: 1_000_500 }, 1_000_600), 1_000_000 + tenMin);
    // Page closed for an hour: one run at the latest slot, not six.
    const later = 1_000_000 + 6 * tenMin + 1000;
    const next = nextRunAt({ ...every, lastRunAt: 1_000_500 }, later);
    assert.equal(next, 1_000_000 + 6 * tenMin);
    assert.equal(dueSchedules([{ ...every, lastRunAt: 1_000_500 }], later).length, 1);
  });

  it("normalizes stored schedules", () => {
    const list = normalizeSchedules([
      { id: "x", target: { kind: "queue" }, kind: "every", at: 5, everyMinutes: 0 },
      { id: "y", target: { kind: "nope" }, at: 5 },
      "junk",
    ]);
    assert.equal(list.length, 1);
    assert.equal(list[0].everyMinutes, 1);
    assert.equal(list[0].enabled, true);
  });
});
