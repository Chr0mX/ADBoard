/** Pure parts of the phone favourites and labels (unit tested). */
export const PHONE_PREFS_KEY = "adboard-m-phones";

export interface PhonePrefs {
  favs: string[];
  notes: Record<string, string>;
}

export function parsePhonePrefs(raw: string | null): PhonePrefs {
  try {
    const value = JSON.parse(raw ?? "{}") as Partial<PhonePrefs>;
    const favs = Array.isArray(value.favs) ? value.favs.filter((id): id is string => typeof id === "string") : [];
    const notes: Record<string, string> = {};
    for (const [id, text] of Object.entries(value.notes ?? {})) if (typeof text === "string" && text.trim()) notes[id] = text.slice(0, 40);
    return { favs, notes };
  } catch {
    return { favs: [], notes: {} };
  }
}

/** Favourites first, then the list's own order. */
export function favouritesFirst<T extends { id: string }>(devices: T[], favs: Set<string>): T[] {
  return [...devices].sort((a, b) => Number(favs.has(b.id)) - Number(favs.has(a.id)));
}
