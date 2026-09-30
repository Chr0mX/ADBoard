/**
 * Shared Control chrome class strings — PWA float HIT is the design reference.
 * Under-stream compact nav stays separate (intentional smaller hits).
 */

/** 48×48 icon hit used by the floating Tools panel. */
export const PC_HIT_LG =
  "inline-flex h-12 min-h-12 w-12 min-w-12 shrink-0 items-center justify-center rounded-xl border border-[var(--pc-line)] bg-[var(--pc-panel)]/80 p-0 text-[var(--pc-ink)] active:bg-[var(--pc-accent-soft)] aria-pressed:border-[var(--pc-accent)] aria-pressed:bg-[var(--pc-accent-soft)] aria-pressed:text-[var(--pc-accent)] disabled:opacity-40";

/** Labeled desktop Control tool / rail button (h-11, same radius/pressed language). */
export const PC_HIT_LABELED =
  "inline-flex h-11 min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-xl border border-[var(--pc-line)] bg-[var(--pc-panel)] px-3 font-mono text-xs tracking-wide text-[var(--pc-ink)] hover:bg-[var(--pc-accent-soft)] active:bg-[var(--pc-accent-soft)] aria-pressed:border-[var(--pc-accent)] aria-pressed:bg-[var(--pc-accent-soft)] aria-pressed:text-[var(--pc-accent)] disabled:opacity-40";

/** Responsive docked tool: square on narrow, labeled h-11 on lg+. */
export const PC_HIT_TOOL_RESPONSIVE =
  "aspect-square h-auto w-full min-w-0 max-w-11 justify-self-center gap-0 rounded-xl border border-[var(--pc-line)] bg-[var(--pc-panel)]/70 p-0 text-[var(--pc-ink)] hover:bg-[var(--pc-accent-soft)] active:bg-[var(--pc-accent-soft)] aria-pressed:border-[var(--pc-accent)] aria-pressed:bg-[var(--pc-accent-soft)] aria-pressed:text-[var(--pc-accent)] lg:aspect-auto lg:h-11 lg:min-h-11 lg:w-auto lg:max-w-none lg:shrink-0 lg:gap-1.5 lg:px-3";

/** Min 44×44 hit for grid Focus / Exit chrome. */
export const PC_HIT_MIN =
  "inline-flex h-11 min-h-11 min-w-11 items-center justify-center rounded-xl border border-[var(--pc-line)] bg-[var(--pc-panel)] p-0 text-[var(--pc-ink)] hover:bg-[var(--pc-accent-soft)] active:bg-[var(--pc-accent-soft)] disabled:opacity-40";
