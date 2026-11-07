/*
 * A polling loop that cannot stack. Calling `poke()` (the window got focus,
 * the tab became visible) restarts the loop; any pass still waiting on the
 * network notices it was replaced and stops instead of rescheduling itself.
 * The old loop did not, so each focus event could leave one more poller
 * running for the rest of the session.
 */

export interface PollerOptions {
  /** One poll. */
  tick: () => Promise<void>;
  /** How long to wait before the next one. */
  delayMs: () => number;
  /** When false the poll is skipped (a hidden tab) but the loop keeps its slow beat. */
  shouldRun?: () => boolean;
}

export function createPoller(options: PollerOptions) {
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let started = false;

  const loop = async (mine: number) => {
    if (mine !== generation) return;
    if (options.shouldRun?.() ?? true) {
      try {
        await options.tick();
      } catch {
        // The next beat tries again.
      }
    }
    if (mine !== generation) return;
    timer = setTimeout(() => void loop(mine), options.delayMs());
  };

  const restart = () => {
    generation += 1;
    if (timer) clearTimeout(timer);
    timer = null;
    void loop(generation);
  };

  return {
    /** Begin polling once; later calls do nothing. */
    start() {
      if (started) return;
      started = true;
      restart();
    },
    /** Poll now and carry on from here. */
    poke() {
      if (started) restart();
    },
    stop() {
      started = false;
      generation += 1;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
