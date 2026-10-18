/**
 * Shared Control chrome class strings, built on the unified toggle classes
 * in globals.css (`.pc-toggle`, sizes sm 36 / md 44 / lg 48). Colours,
 * hover, focus and the pressed state come only from `.pc-toggle`, so a
 * button and a <Toggle> look the same wherever they appear.
 */

/** 48×48 icon hit used by the floating Tools panel. */
export const PC_HIT_LG = "pc-toggle pc-toggle-lg pc-toggle-icon";

/** Labeled desktop Control tool / rail button (44px). */
export const PC_HIT_LABELED = "pc-toggle pc-toggle-md";

/** Responsive docked tool: square on narrow, labeled 44px on lg+. */
export const PC_HIT_TOOL_RESPONSIVE =
  "pc-toggle aspect-square h-auto w-full min-w-0 max-w-11 justify-self-center gap-0 p-0 lg:aspect-auto lg:h-11 lg:min-h-11 lg:w-auto lg:max-w-none lg:gap-1.5 lg:px-3";

/** Min 44×44 hit for grid Focus / Exit chrome. */
export const PC_HIT_MIN = "pc-toggle pc-toggle-md";
