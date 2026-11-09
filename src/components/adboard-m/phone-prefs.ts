"use client";

import { useMemo } from "react";
import { useStoredString } from "@/hooks/use-stored-flag";
import { PHONE_PREFS_KEY, parsePhonePrefs, type PhonePrefs } from "@/components/adboard-m/phone-prefs-core";

export { PHONE_PREFS_KEY, favouritesFirst, parsePhonePrefs, type PhonePrefs } from "@/components/adboard-m/phone-prefs-core";

/** Favourites and short labels for phones. Kept in this browser (not synced). */
export function usePhonePrefs() {
  const [raw, setRaw] = useStoredString(PHONE_PREFS_KEY);
  const prefs = useMemo(() => parsePhonePrefs(raw), [raw]);
  const save = (next: PhonePrefs) => setRaw(JSON.stringify(next));
  return {
    favs: useMemo(() => new Set(prefs.favs), [prefs.favs]),
    notes: prefs.notes,
    toggleFav: (id: string) => save({ ...prefs, favs: prefs.favs.includes(id) ? prefs.favs.filter((x) => x !== id) : [...prefs.favs, id] }),
    setNote: (id: string, text: string) => {
      const notes = { ...prefs.notes };
      if (text.trim()) notes[id] = text.slice(0, 40);
      else delete notes[id];
      save({ ...prefs, notes });
    },
  };
}

