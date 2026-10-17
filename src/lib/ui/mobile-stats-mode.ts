/** The stats line under the phone on a phone screen: shown or hidden. */
export type MobileStatsMode = "show" | "hide";

/** Shown unless hidden. Older versions saved "float" (floating widget) or "bar": both mean shown. */
export function parseMobileStatsMode(raw: string | null | undefined): MobileStatsMode {
  return raw === "hide" ? "hide" : "show";
}
