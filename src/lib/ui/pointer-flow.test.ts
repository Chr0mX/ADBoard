import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSerialQueue, shouldSendMove } from "./pointer-flow.ts";

describe("createSerialQueue", () => {
  it("runs tasks in the order queued even when an earlier one is slower", async () => {
    const queue = createSerialQueue();
    const order: string[] = [];
    const slow = queue.run(async () => {
      await new Promise((r) => setTimeout(r, 40));
      order.push("move");
    });
    const fast = queue.run(async () => {
      order.push("up");
    });
    await Promise.all([slow, fast]);
    assert.deepEqual(order, ["move", "up"]);
  });

  it("keeps going after a task fails, and still reports that failure to its caller", async () => {
    const queue = createSerialQueue();
    const failed = queue.run(async () => {
      throw new Error("agent unreachable");
    });
    const after = queue.run(async () => "sent");
    await assert.rejects(failed, /agent unreachable/);
    assert.equal(await after, "sent");
  });

  it("never has two tasks running at once", async () => {
    const queue = createSerialQueue();
    let live = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        queue.run(async () => {
          live += 1;
          peak = Math.max(peak, live);
          await new Promise((r) => setTimeout(r, 5));
          live -= 1;
        }),
      ),
    );
    assert.equal(peak, 1);
  });
});

describe("shouldSendMove", () => {
  const last = { lastX: 100, lastY: 100, lastSent: 1000 };
  it("drops a tiny, immediate move and keeps anything bigger or later", () => {
    assert.equal(shouldSendMove(last, 101, 100, 1005), false);
    assert.equal(shouldSendMove(last, 103, 100, 1005), true); // 3 px
    assert.equal(shouldSendMove(last, 101, 100, 1016), true); // 16 ms later
    assert.equal(shouldSendMove(last, 100, 100, 1015), false);
  });
});
