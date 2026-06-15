/**
 * Persisted preference utility.
 *
 * Public entry point for the namespaced, versioned, typed preference utility.
 * Surfaces declare preferences with definePreference() and interact through the
 * returned accessor; the storage backend is swappable but defaults to browser
 * local storage with in-memory degradation.
 *
 * See @ui-preference-store and @client-preference-persistence.
 */

export {
  APP_PREFIX,
  definePreference,
  type Preference,
  type PreferenceDefinition,
  type PreferenceListener,
  type PreferenceMigrate,
  type PreferenceSchema,
} from "./define-preference.js";

export {
  InMemoryBackend,
  LocalStorageBackend,
  getDefaultBackend,
  resolveLocalStorage,
  type PreferenceBackend,
  type StorageLike,
} from "./backend.js";
