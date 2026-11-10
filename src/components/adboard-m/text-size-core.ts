/** Pure parts of the text size setting (unit tested). */
export const TEXT_SIZE_KEY = "adboard-m-text-size";
export type TextSize = "compact" | "standard";

export function parseTextSize(value: string | null): TextSize {
  return value === "standard" ? "standard" : "compact";
}

/** Viewport meta for a size: Compact fields are small, so it stops iOS focus zoom; Standard keeps zoom on. */
export function viewportFor(size: TextSize, current: string): string {
  const max = size === "standard" ? "5" : "1";
  return /maximum-scale=[^,]*/.test(current)
    ? current.replace(/maximum-scale=[^,]*/, `maximum-scale=${max}`)
    : `${current}, maximum-scale=${max}`;
}
