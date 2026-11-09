/** Whether the page runs as an installed app (Home Screen / installed PWA). */
export function isStandalone(
  nav: { standalone?: boolean } | undefined,
  matchMedia: ((query: string) => { matches: boolean }) | undefined,
): boolean {
  return nav?.standalone === true || matchMedia?.("(display-mode: standalone)").matches === true;
}

/** Browser-side shortcut. False during prerender. */
export function readStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return isStandalone(navigator as Navigator & { standalone?: boolean }, window.matchMedia?.bind(window));
}

/** Height of the on-screen keyboard (or any overlay) taken from the layout viewport; 0 when closed. */
export const KEYBOARD_MIN_PX = 120;
export function keyboardInset(layoutHeight: number, visualHeight: number, visualTop: number): number {
  const inset = Math.round(layoutHeight - (visualHeight + visualTop));
  // Safari's collapsing address bar changes the height by under ~100 px; that is not a keyboard.
  return inset >= KEYBOARD_MIN_PX ? inset : 0;
}
