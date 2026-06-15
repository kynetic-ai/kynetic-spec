/**
 * Preference Storage Backends
 *
 * Storage-agnostic interface for the persisted preference utility plus the
 * two shipped implementations: a browser-local-storage backend and an
 * in-memory backend. The in-memory backend doubles as the degradation mode
 * for the local-storage backend when persistent storage is unavailable
 * (private browsing, disabled storage) or a write fails (quota exceeded).
 *
 * Consumers never touch a backend directly — they go through the accessors
 * returned by definePreference(). Backends only move opaque strings; all
 * serialization and validation happens at the preference edge.
 *
 * AC: @ui-preference-store ac-5 — alternative backend behind one interface
 * AC: @ui-preference-store ac-6 — degrade to in-memory when storage unavailable
 */

/**
 * The storage-agnostic backend contract. Implementations persist and retrieve
 * opaque string values keyed by string. `get` returns `null` for a missing
 * key. None of the methods throw to the caller — backends absorb their own
 * environment failures (the local-storage backend degrades internally).
 */
export interface PreferenceBackend {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** Minimal shape of the Web Storage API used by {@link LocalStorageBackend}. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Session-scoped, process-local backend. Holds values in a Map for the life of
 * the module. Used directly for tests and as the degradation target for the
 * local-storage backend.
 */
export class InMemoryBackend implements PreferenceBackend {
  private readonly store = new Map<string, string>();

  get(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }

  set(key: string, value: string): void {
    this.store.set(key, value);
  }

  remove(key: string): void {
    this.store.delete(key);
  }
}

const PROBE_KEY = "__kspec_pref_probe__";

/**
 * Resolve the ambient Web Storage instance if — and only if — it is actually
 * usable. Private-browsing modes and storage-disabled environments expose a
 * `localStorage` object whose `setItem` throws, so a presence check is not
 * enough; we probe with a real write/remove round-trip.
 *
 * Returns `null` (rather than throwing) when storage is absent or unusable,
 * which includes the SSR/test (node) environment where no `localStorage`
 * global exists.
 */
export function resolveLocalStorage(): StorageLike | null {
  try {
    const candidate = (globalThis as { localStorage?: StorageLike }).localStorage;
    if (!candidate) return null;
    candidate.setItem(PROBE_KEY, PROBE_KEY);
    candidate.removeItem(PROBE_KEY);
    return candidate;
  } catch {
    return null;
  }
}

/**
 * Browser-local-storage backend with built-in degradation.
 *
 * Detection happens once, on first use (construction): if storage is missing
 * or its probe write throws, the backend starts in degraded mode and routes
 * everything to an in-memory store. If a later write throws — typically a
 * quota error — the backend degrades per-write from that point on, keeping the
 * interface functional for the rest of the session. Values written after
 * degradation live in memory and are still readable, so reads consult the
 * in-memory store before persistent storage.
 */
export class LocalStorageBackend implements PreferenceBackend {
  private readonly memory = new InMemoryBackend();
  private readonly storage: StorageLike | null;
  private degraded: boolean;

  constructor(storage: StorageLike | null = resolveLocalStorage()) {
    this.storage = storage;
    this.degraded = storage === null;
  }

  /** True once the backend has fallen back to session-scoped in-memory mode. */
  get isDegraded(): boolean {
    return this.degraded;
  }

  get(key: string): string | null {
    // Values written after degradation only exist in memory; check it first.
    // Values persisted before a write-time (quota) degradation still live in
    // real storage, so we consult it even once degraded — reads are not gated
    // on the write-failure flag.
    const fromMemory = this.memory.get(key);
    if (fromMemory !== null) return fromMemory;
    if (!this.storage) return null;
    try {
      return this.storage.getItem(key);
    } catch {
      this.degraded = true;
      return null;
    }
  }

  set(key: string, value: string): void {
    if (this.degraded || !this.storage) {
      this.memory.set(key, value);
      return;
    }
    try {
      this.storage.setItem(key, value);
    } catch {
      // Quota exceeded or storage revoked mid-session: degrade per-write and
      // keep the value in memory so the interface stays functional.
      this.degraded = true;
      this.memory.set(key, value);
    }
  }

  remove(key: string): void {
    this.memory.remove(key);
    // Stay symmetric with get(): it still reads persistent storage once
    // degraded, so remove() must still clear it — otherwise a value persisted
    // before a write-time (quota) degradation would survive removal and remain
    // readable. removeItem frees quota rather than consuming it, so it is safe
    // to attempt regardless of the degraded flag (which only gates writes).
    if (!this.storage) return;
    try {
      this.storage.removeItem(key);
    } catch {
      this.degraded = true;
    }
  }
}

let defaultBackend: PreferenceBackend | null = null;

/**
 * The process-wide default backend used when a preference does not specify its
 * own. Lazily constructed so storage detection runs at first preference use,
 * not at module import (important for SSR/test environments).
 */
export function getDefaultBackend(): PreferenceBackend {
  if (!defaultBackend) {
    defaultBackend = new LocalStorageBackend();
  }
  return defaultBackend;
}
