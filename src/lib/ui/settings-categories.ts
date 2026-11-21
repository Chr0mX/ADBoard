/** Which Settings category to show. Pure module: runs under `node --test`. */
export interface SettingsCategory {
  id: string;
  label: string;
  group: string;
}

/** The remembered category if it still exists (Account can disappear), else the first one. */
export function pickCategory(categories: readonly SettingsCategory[], stored: string | null | undefined): string {
  const found = categories.find((category) => category.id === stored);
  return (found ?? categories[0])?.id ?? "";
}
