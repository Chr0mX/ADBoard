import { createCn } from "cn/config";

/**
 * Class merging that knows the app's own size class `text-meta` (see docs/typography.md);
 * without it `text-meta` would be taken for a colour and dropped next to a `text-[var(--...)]` colour.
 */
export const cn = createCn({ extend: { classGroups: { "font-size": [{ text: ["meta"] }] } } });

/** Sentence case for a value from the agent: first letter capitalised, the rest lower case. */
export function sentenceCase(value: string | null | undefined): string {
  if (!value) return "";
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}
