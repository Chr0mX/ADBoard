/** Which interface a visit to "/" should suggest. Pure, so it is unit tested. */
export interface HintInput {
  /** Installed app window (display-mode standalone or iOS standalone). */
  standalone: boolean;
  coarsePointer: boolean;
  width: number;
  /** The visitor chose the desktop version on purpose (?desktop=1). */
  forcedDesktop: boolean;
  dismissed: boolean;
}

export type Hint = "redirect" | "banner" | "none";

export const PHONE_MAX_WIDTH = 768;

export function deviceHint(input: HintInput): Hint {
  if (input.forcedDesktop) return "none";
  const phone = input.coarsePointer && input.width < PHONE_MAX_WIDTH;
  if (!phone) return "none";
  // An installed phone-width app is a phone install: move it to the mobile app.
  if (input.standalone) return "redirect";
  return input.dismissed ? "none" : "banner";
}
