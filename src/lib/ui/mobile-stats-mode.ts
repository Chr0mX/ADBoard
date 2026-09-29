export type MobileStatsMode = "float" | "bar";

export function parseMobileStatsMode(raw: string | null | undefined): MobileStatsMode {
  return raw === "bar" ? "bar" : "float";
}
