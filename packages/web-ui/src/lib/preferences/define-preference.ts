/**
 * definePreference — the persisted preference utility.
 *
 * Each preference is declared once with a namespace, key, schema version,
 * default, and a validation rule (a Zod-like schema or a predicate). The
 * returned accessor exposes a storage-agnostic get/set/subscribe interface
 * usable from Svelte runes contexts. Values are JSON-serialized into a
 * versioned envelope so reads can detect and migrate stale shapes.
 *
 * Read pipeline: parse → version check → migrate (declared rule) or fall back
 * to default → validate → return. Invalid, foreign, or newer-versioned values
 * never propagate to the consumer — the default is returned instead.
 *
 * AC: @ui-preference-store ac-1 — written value survives reload
 * AC: @ui-preference-store ac-2 — namespaces isolate same-named keys
 * AC: @ui-preference-store ac-3 — older version migrated or defaulted, never raw
 * AC: @ui-preference-store ac-4 — invalid stored value falls back to default
 * AC: @ui-preference-store ac-5 — backend-agnostic, consumers never touch store
 * AC: @client-preference-persistence ac-1 — shared namespaced/versioned key format
 */

import { type PreferenceBackend, getDefaultBackend } from "./backend.js";

/**
 * Reserved top-level prefix for every value this application persists. The
 * shared key format is `${APP_PREFIX}:${namespace}:${key}`, which keeps
 * preference storage from colliding with any other localStorage usage and
 * guarantees namespace isolation.
 */
export const APP_PREFIX = "kspec";

/**
 * Zod-compatible schema shape. A `zod` schema satisfies this structurally, so
 * preferences can declare `schema: z.object({...})` without the utility taking
 * a hard dependency on zod.
 */
export interface PreferenceSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

/**
 * Migration rule for a stored value whose version is older than the current
 * declared version. Receives the raw (already JSON-parsed) stored value and
 * the version it was written under. Return the upgraded value, or `undefined`
 * to signal "no migration applies" (the default is then used).
 */
export type PreferenceMigrate<T> = (storedValue: unknown, fromVersion: number) => T | undefined;

export interface PreferenceDefinition<T> {
  /** Logical grouping for the preference; part of the storage key. */
  namespace: string;
  /** Preference name within the namespace; part of the storage key. */
  key: string;
  /** Current schema version of the stored value. Bump when the shape changes. */
  version: number;
  /** Value returned when nothing valid is stored. */
  default: T;
  /** Zod-like schema validating the stored value. Mutually optional with `validate`. */
  schema?: PreferenceSchema<T>;
  /** Predicate validating the stored value. Mutually optional with `schema`. */
  validate?: (value: unknown) => boolean;
  /** Upgrade rule applied to older-versioned stored values. */
  migrate?: PreferenceMigrate<T>;
  /** Backend override. Defaults to the shared local-storage backend. */
  backend?: PreferenceBackend;
}

/** Listener notified whenever a preference's value changes via {@link Preference.set}. */
export type PreferenceListener<T> = (value: T) => void;

/**
 * Typed accessor for a single persisted preference. The only surface consumers
 * use — they never reach the backing store directly.
 */
export interface Preference<T> {
  /** Read the current value, running the full validate/migrate pipeline. */
  get(): T;
  /** Persist a new value and notify subscribers. */
  set(value: T): void;
  /** Remove the stored value; subsequent reads return the default. */
  remove(): void;
  /** Subscribe to value changes. Returns an unsubscribe function. */
  subscribe(listener: PreferenceListener<T>): () => void;
  /** The fully-qualified storage key, exposed for migration/diagnostics. */
  readonly storageKey: string;
}

/** Internal versioned envelope persisted as JSON under the storage key. */
interface Envelope {
  v: number;
  value: unknown;
}

function buildStorageKey(namespace: string, key: string): string {
  return `${APP_PREFIX}:${namespace}:${key}`;
}

function isEnvelope(parsed: unknown): parsed is Envelope {
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    typeof (parsed as { v?: unknown }).v === "number" &&
    "value" in parsed
  );
}

export function definePreference<T>(definition: PreferenceDefinition<T>): Preference<T> {
  const {
    namespace,
    key,
    version,
    default: defaultValue,
    schema,
    validate,
    migrate,
    backend = getDefaultBackend(),
  } = definition;

  const storageKey = buildStorageKey(namespace, key);
  const listeners = new Set<PreferenceListener<T>>();

  /**
   * Run the declared validation rule. A value is accepted only if every
   * declared rule passes; with no rule declared, any value is accepted (the
   * caller is trusted to have parsed a compatible JSON shape).
   */
  function isValid(candidate: unknown): candidate is T {
    if (schema && !schema.safeParse(candidate).success) return false;
    if (validate && !validate(candidate)) return false;
    return true;
  }

  function read(): T {
    let raw: string | null;
    try {
      raw = backend.get(storageKey);
    } catch {
      return defaultValue;
    }
    if (raw === null) return defaultValue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return defaultValue;
    }

    // Foreign or pre-envelope shapes never propagate.
    if (!isEnvelope(parsed)) return defaultValue;

    let candidate: unknown;
    if (parsed.v === version) {
      candidate = parsed.value;
    } else if (parsed.v < version && migrate) {
      // Older version with a declared upgrade rule.
      candidate = migrate(parsed.value, parsed.v);
      if (candidate === undefined) return defaultValue;
    } else {
      // Older version without a rule, or a newer/foreign version: no shape we
      // can trust — fall back to the default rather than the raw stored value.
      return defaultValue;
    }

    return isValid(candidate) ? candidate : defaultValue;
  }

  function write(value: T): void {
    const envelope: Envelope = { v: version, value };
    try {
      backend.set(storageKey, JSON.stringify(envelope));
    } catch {
      // Backends absorb their own failures; guard defensively regardless.
    }
  }

  function notify(value: T): void {
    for (const listener of listeners) {
      listener(value);
    }
  }

  return {
    storageKey,
    get(): T {
      return read();
    },
    set(value: T): void {
      write(value);
      notify(value);
    },
    remove(): void {
      try {
        backend.remove(storageKey);
      } catch {
        // ignore
      }
      notify(defaultValue);
    },
    subscribe(listener: PreferenceListener<T>): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
