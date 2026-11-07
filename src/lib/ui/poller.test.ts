import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPoller } from "./poller.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createPoller", () => {
  it("polls repeatedly after start, and start is idempotent", async () => {
    let ticks = 0;
    const poller = createPoller({ tick: async () => void (ticks += 1), delayMs: () => 10 });
    poller.start();
    poller.start();
    await wait(85);
    poller.stop();
    assert.ok(ticks >= 4 && ticks <= 10, `ticks ${ticks}`);
  });

  it("does not stack loops when poked while a poll is still waiting on the network", async () => {
    let live = 0;
    let started = 0;
    const poller = createPoller({
      tick: async () => {
        started += 1;
        live += 1;
        await wait(30);
        live -= 1;
      },
      delayMs: () => 20,
    });
    poller.start();
    await wait(5);
    for (let i = 0; i < 5; i++) poller.poke(); // five focus events in a row
    await wait(300);
    poller.stop();
    const after = started;
    await wait(120);
    assert.equal(started, after, "no loop keeps running after stop");
    // One loop at a time: ticks cannot overlap more than a poke's replacement.
    assert.ok(live <= 1, `live ${live}`);
    // Without the generation check, 6 loops would each tick about every 50 ms (about 36 ticks in 300 ms).
    assert.ok(started < 20, `started ${started}`);
  });

  it("skips the poll while shouldRun is false but keeps its beat, then resumes", async () => {
    let ticks = 0;
    let on = false;
    const poller = createPoller({
      tick: async () => void (ticks += 1),
      delayMs: () => 10,
      shouldRun: () => on,
    });
    poller.start();
    await wait(60);
    assert.equal(ticks, 0);
    on = true;
    await wait(60);
    poller.stop();
    assert.ok(ticks >= 3, `ticks ${ticks}`);
  });

  it("keeps polling after a tick throws", async () => {
    let ticks = 0;
    const poller = createPoller({
      tick: async () => {
        ticks += 1;
        throw new Error("boom");
      },
      delayMs: () => 10,
    });
    poller.start();
    await wait(60);
    poller.stop();
    assert.ok(ticks >= 3, `ticks ${ticks}`);
  });
});
