/**
 * Has the polled run list changed? Compares the response text with the last
 * one, so an identical poll (the usual case: a poll every 400 ms while a macro
 * runs) is not parsed, compared or announced again.
 *
 * Pure module: runs under `node --test`.
 */
export function createViewGate() {
  let last: string | null = null;
  return {
    /** True when `text` differs from the previous accepted text. */
    changed(text: string): boolean {
      if (text === last) return false;
      last = text;
      return true;
    },
    /** Forget the last text (the next poll counts as changed). */
    reset() {
      last = null;
    },
  };
}
