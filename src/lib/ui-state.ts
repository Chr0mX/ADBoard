/*
 * Small JSON values in browser storage for editor and panel state (open job,
 * preview phone, folder paths…). `src/lib/prefs.ts` saves the keys it knows to
 * the ADBoard data folder, per browser.
 */
export function readUiState<T>(key: string, fallback: T): T {
  try {
    const raw = typeof window === "undefined" ? null : window.localStorage.getItem(key);
    return raw === null ? fallback : ({ ...fallback, ...(JSON.parse(raw) as object) } as T);
  } catch {
    return fallback;
  }
}

export function writeUiState(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage full or blocked: the state just isn't remembered
  }
}

/** Update part of a stored object. */
export function patchUiState<T extends object>(key: string, fallback: T, change: Partial<T>) {
  writeUiState(key, { ...readUiState(key, fallback), ...change });
}
