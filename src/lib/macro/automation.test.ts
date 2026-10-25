// Cron tests use wall-clock times in a zone with daylight saving.
process.env.TZ = "Europe/Berlin";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cronError, dueSchedules, nextCronAfter, nextCronRuns, nextRunAt, normalizeSchedules, parseCron, runQueueItems, type MacroSchedule } from "./automation.ts";
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

describe("cron schedules", () => {
  const local = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).getTime();
  const next = (expr: string, from: number) => nextCronAfter(parseCron(expr), from);

  it("finds the next run for common expressions", () => {
    // Saturday 24 October 2026, 10:07.
    const now = local(2026, 10, 24, 10, 7);
    assert.equal(next("*/15 * * * *", now), local(2026, 10, 24, 10, 15));
    assert.equal(next("0 8 * * 1-5", now), local(2026, 10, 26, 8, 0));
    assert.equal(next("30 9 * * MON,thu", now), local(2026, 10, 26, 9, 30));
    assert.equal(next("@weekly", now), local(2026, 10, 25, 0, 0));
    assert.equal(next("0 12 * * 7", now), local(2026, 10, 25, 12, 0));
    assert.equal(next("0 8-18/2 * * *", now), local(2026, 10, 24, 12, 0));
    assert.equal(next("5/20 * * * *", now), local(2026, 10, 24, 10, 25));
    assert.equal(next("0 0 29 feb *", now), local(2028, 2, 29, 0, 0));
    assert.equal(next("7 10 * * *", now), local(2026, 10, 25, 10, 7), "strictly after now");
    // Day of month OR day of week when both are set.
    assert.equal(next("0 9 1 * mon", now), local(2026, 10, 26, 9, 0));
    assert.equal(next("0 0 31 2 *", now), null);
    assert.deepEqual(nextCronRuns("0 * * * *", now, 2), [local(2026, 10, 24, 11, 0), local(2026, 10, 24, 12, 0)]);
  });

  it("follows daylight saving: skipped times don't run, repeated times run once", () => {
    // 29 March 2026: 02:00 → 03:00, so 02:30 does not exist.
    assert.equal(next("30 2 * * *", local(2026, 3, 28, 12, 0)), local(2026, 3, 30, 2, 30));
    assert.equal(next("0 8 * * *", local(2026, 3, 28, 12, 0)), local(2026, 3, 29, 8, 0), "08:00 local both sides");
    // 25 October 2026: 03:00 → 02:00, so 02:30 happens twice.
    const first = next("30 2 * * *", local(2026, 10, 24, 12, 0));
    assert.ok(first !== null);
    assert.equal(next("30 2 * * *", first), local(2026, 10, 26, 2, 30), "not again an hour later");
  });

  it("explains bad expressions", () => {
    for (const [expr, says] of [
      ["* * * *", "5 fields"],
      ["60 * * * *", "Minute: 60 is out of range"],
      ["* * * 13 *", "Month"],
      ["*/0 * * * *", "step of 0"],
      ["5-1 * * * *", "backwards"],
      ["@often", "Unknown shortcut"],
    ] as const) {
      assert.match(cronError(expr) ?? "", new RegExp(says));
    }
    assert.equal(cronError("0 8 * * 1-5"), null);
  });

  it("schedules skip times missed while ADBoard was off", () => {
    const created = local(2026, 10, 24, 7, 0);
    const schedule = { id: "c", target: { kind: "queue" as const }, kind: "cron" as const, cron: "0 8 * * *", at: created, everyMinutes: 60, enabled: true };
    assert.equal(nextRunAt(schedule, local(2026, 10, 24, 7, 30)), local(2026, 10, 24, 8, 0));
    const ran = { ...schedule, lastRunAt: local(2026, 10, 24, 8, 0) };
    assert.equal(nextRunAt(ran, local(2026, 10, 25, 8, 3)), local(2026, 10, 25, 8, 0), "within 5 min: still runs");
    assert.equal(nextRunAt(ran, local(2026, 10, 25, 15, 0)), local(2026, 10, 26, 8, 0), "hours late: skipped");
    assert.equal(nextRunAt({ ...schedule, cron: "nope" }, created), null);
    const [restored] = normalizeSchedules([{ ...schedule }]);
    assert.equal(restored.kind, "cron");
    assert.equal(restored.cron, "0 8 * * *");
  });
});
