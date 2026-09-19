/**
 * Session persistence.
 *
 * Settings and the arrangement survive a reload, which matters on a Chromebook
 * where a tab closing is routine.
 *
 * Every access is guarded. `localStorage` throws outright in some private
 * browsing modes, can be disabled by policy, and can be full — and none of
 * those are reasons for the app to fail to start. A failed read gives the
 * caller its fallback; a failed write is dropped and reported.
 *
 * The backing store is injectable so this can be tested without a browser and
 * without leaking state between tests.
 */

export const STORAGE_KEY = 'polargraph.session.v1';

/** A stand-in used when no real storage is available. */
export function createMemoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));

  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

/** The browser's localStorage, or an in-memory stand-in if it is unusable. */
export function defaultStorage() {
  try {
    const probe = '__polargraph_probe__';
    globalThis.localStorage.setItem(probe, '1');
    globalThis.localStorage.removeItem(probe);
    return globalThis.localStorage;
  } catch {
    // Private mode, disabled storage, or no browser at all.
    return createMemoryStorage();
  }
}

export function load(storage = defaultStorage(), fallback = null) {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw == null) return fallback;

    const parsed = JSON.parse(raw);
    // Anything that is not an object is corrupt, not a value to hand back.
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/** Returns whether the write actually landed, so callers can tell the user. */
export function save(value, storage = defaultStorage()) {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function clear(storage = defaultStorage()) {
  try {
    storage.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * Merge stored settings over defaults.
 *
 * Only keys the defaults already define are taken, so a stored file from an
 * older version cannot introduce unknown settings, and a key dropped from the
 * app stops being honoured the moment it is removed from the defaults.
 */
export function mergeSettings(defaults, stored) {
  if (!stored || typeof stored !== 'object') return { ...defaults };

  const merged = { ...defaults };

  for (const key of Object.keys(defaults)) {
    const value = stored[key];
    if (value === undefined) continue;

    const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

    merged[key] = isPlainObject(defaults[key]) && isPlainObject(value)
      ? mergeSettings(defaults[key], value)
      : value;
  }

  return merged;
}
