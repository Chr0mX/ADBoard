/*
 * Browser storage keys from before the ADBoard rename, and their new names.
 * Legacy compatibility only: `migrateLegacyKeys()` copies an old value to
 * its new key once (when the new key is still empty) and removes the old
 * key, so nobody loses settings or the Shell Automation library on update.
 */
export const LEGACY_KEYS: Record<string, string> = {
  "phonecontrol-desk": "adboard-desk",
  "phonecontrol-section": "adboard-section",
  "phonecontrol-active-device": "adboard-active-device",
  "phonecontrol-control-mode": "adboard-control-mode",
  "phonecontrol-keyboard": "adboard-keyboard",
  "phonecontrol-fill-window": "adboard-fill-window",
  "phonecontrol-screens-collapsed": "adboard-screens-collapsed",
  "phonecontrol-devices-collapsed": "adboard-devices-collapsed",
  "phonecontrol-grid-view": "adboard-grid-view",
  "phonecontrol-mobile-stats-mode": "adboard-mobile-stats-mode",
  "phonecontrol-scrcpy": "adboard-scrcpy",
  "phonecontrol-display-size": "adboard-display-size",
  "phonecontrol-shell-history": "adboard-shell-history",
  "rasiel-taskbar-pins": "adboard-taskbar-pins",
};

let migrated = false;

/** Move values stored under old key names to the new ones (runs once per page). */
export function migrateLegacyKeys(storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null = safeLocalStorage()) {
  if (!storage || (migrated && storage === safeLocalStorage())) return;
  migrated = true;
  for (const [oldKey, newKey] of Object.entries(LEGACY_KEYS)) {
    try {
      const value = storage.getItem(oldKey);
      if (value === null) continue;
      if (storage.getItem(newKey) === null) storage.setItem(newKey, value);
      storage.removeItem(oldKey);
    } catch {
      // Storage blocked or full: the old key stays and is tried next time.
    }
  }
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
