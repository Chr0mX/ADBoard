import test, { describe, it } from "node:test";
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

test("a fast drag sends only the newest queued move, and never loses the last move before a release", async () => {
  const queue = createSerialQueue();
  const sent: string[] = [];
  let release: () => void = () => {};
  const slow = new Promise<void>((resolve) => (release = resolve));
  const send = (what: string, wait?: Promise<void>) => async () => {
    if (wait) await wait;
    sent.push(what);
    return what;
  };
  // The first request is slow; meanwhile the drag goes on.
  const down = queue.run(send("down", slow));
  const m1 = queue.run(send("move1"), { coalesce: true });
  const m2 = queue.run(send("move2"), { coalesce: true });
  const m3 = queue.run(send("move3"), { coalesce: true });
  const up = queue.run(send("up"));
  const hover = queue.run(send("hover"), { coalesce: true });
  release();
  assert.deepEqual(await Promise.all([down, m1, m2, m3, up, hover]), ["down", undefined, undefined, "move3", "up", "hover"]);
  assert.deepEqual(sent, ["down", "move3", "up", "hover"], "old moves are skipped, order is kept");
});

test("moves that are not overtaken are all sent", async () => {
  const queue = createSerialQueue();
  const sent: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    await queue.run(async () => sent.push(i), { coalesce: true });
  }
  assert.deepEqual(sent, [0, 1, 2, 3, 4]);
});
