// Nightscout settings in browser storage. Storage can be unavailable (private
// windows, blocked site data), so every access is guarded and the app keeps
// working for the current visit from memory.

export interface Settings {
  url: string;
  token: string;
}

const KEY = 'leveling-up.settings';
let memory: Settings | null = null;

export function normalizeUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, '');
  if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url;
}

export function loadSettings(): Settings | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Settings>;
      if (parsed.url && parsed.token) return { url: parsed.url, token: parsed.token };
    }
  } catch {
    // Fall through to the in-memory copy.
  }
  return memory;
}

/** Saves settings; returns false if they could only be kept for this visit. */
export function saveSettings(settings: Settings): boolean {
  memory = settings;
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

export function forgetSettings(): void {
  memory = null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing stored.
  }
}

/** Per-viewer UI preferences (graph hours, list window). */
export function loadPref(name: string, fallback: number): number {
  try {
    const v = Number(localStorage.getItem(`leveling-up.pref.${name}`));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  } catch {
    return fallback;
  }
}

export function savePref(name: string, value: number): void {
  try {
    localStorage.setItem(`leveling-up.pref.${name}`, String(value));
  } catch {
    // Preference just won't persist.
  }
}
