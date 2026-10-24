export { cn } from "cn"

/** Sentence case for a value from the agent: first letter capitalised, the rest lower case. */
export function sentenceCase(value: string | null | undefined): string {
  if (!value) return "";
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}
