/**
 * Project Store
 *
 * Global project state managed via Svelte runes.
 * Tracks registered projects, current selection, and provides reactive reload triggers.
 *
 * AC Coverage:
 * - ac-25 (@multi-directory-daemon): Project selector shown when multiple projects registered
 * - ac-26 (@multi-directory-daemon): Selection sets X-Kspec-Dir header for API requests
 * - ac-27 (@multi-directory-daemon): UI reloads data on project change
 * - ac-35 (@multi-directory-daemon): Projects listed in registration order
 * - ac-36 (@multi-directory-daemon): Invalid project recovery
 */

import { browser } from "$app/environment";
import { DAEMON_API_BASE } from "$lib/constants";
import { clearQueryCache } from "$lib/query/context.js";
import { definePreference } from "$lib/preferences/index.js";

/** Legacy localStorage key that stored the raw selected-project path. */
const LEGACY_STORAGE_KEY = "kspec-selected-project";

/**
 * Selected project, persisted through the shared preference utility. First
 * consumer of definePreference — see @ui-preference-store. The stored value is
 * a project path, or null when no project is selected.
 */
const selectedProjectPref = definePreference<string | null>({
  namespace: "project",
  key: "selected",
  version: 1,
  default: null,
  validate: (value) => value === null || typeof value === "string",
});

let legacyMigrated = false;

/**
 * One-time migration of the pre-utility `kspec-selected-project` localStorage
 * value onto the preference utility. Reads the legacy key once; if it holds a
 * value and the utility has none yet, seeds it through the utility. The legacy
 * key is then removed so the migration runs at most once per browser.
 */
function migrateLegacySelection(): void {
  if (legacyMigrated || !browser) return;
  legacyMigrated = true;
  try {
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy === null) return;
    if (selectedProjectPref.get() === null) {
      selectedProjectPref.set(legacy);
    }
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // localStorage may be unavailable (e.g., private browsing) — nothing to migrate.
  }
}

export interface Project {
  path: string;
  registered_at: string;
  watcher_active: boolean;
}

// Reactive state using Svelte 5 runes
let projects = $state<Project[]>([]);
let selectedPath = $state<string | null>(null);
let projectVersion = $state(0); // Increments on change to trigger reloads
let loading = $state(false);
let error = $state<string | null>(null);
let initialized = $state(false);

/**
 * Load selected project via the shared preference utility.
 */
function loadPersistedSelection(): string | null {
  if (!browser) return null;
  migrateLegacySelection();
  return selectedProjectPref.get();
}

/**
 * Persist selected project via the shared preference utility.
 */
function persistSelection(path: string | null): void {
  if (!browser) return;
  selectedProjectPref.set(path);
}

/**
 * Load projects list from daemon API
 * AC: @multi-directory-daemon ac-35 - Returns projects in registration order
 */
export async function loadProjects(): Promise<void> {
  if (!browser) return;

  loading = true;
  error = null;

  try {
    const response = await fetch(`${DAEMON_API_BASE}/api/projects`);
    if (!response.ok) {
      throw new Error("Failed to load projects");
    }

    const data = await response.json();
    projects = data.projects || [];

    // Restore selection from localStorage or use first project as default
    const persisted = loadPersistedSelection();
    if (persisted && projects.some((p) => p.path === persisted)) {
      selectedPath = persisted;
    } else if (projects.length > 0) {
      // Default to first registered project
      selectedPath = projects[0].path;
      persistSelection(selectedPath);
    }

    initialized = true;
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load projects";
    console.error("[ProjectStore] Failed to load projects:", err);
  } finally {
    loading = false;
  }
}

/**
 * Select a project
 * AC: @multi-directory-daemon ac-26, ac-27 - Sets header and triggers reload
 */
export function selectProject(path: string): void {
  if (path === selectedPath) return;

  const projectExists = projects.some((p) => p.path === path);
  if (!projectExists) {
    console.warn("[ProjectStore] Attempted to select unknown project:", path);
    return;
  }

  selectedPath = path;
  persistSelection(path);

  // AC: @ui-data-freshness ac-5 — Discard all cached data on project change
  clearQueryCache();

  // Increment version to trigger data reloads in components
  // AC: @multi-directory-daemon ac-27
  projectVersion++;
}

/**
 * Get the currently selected project path
 * AC: @multi-directory-daemon ac-26 - Used for X-Kspec-Dir header
 */
export function getSelectedProjectPath(): string | null {
  return selectedPath;
}

/**
 * Check if multiple projects are registered
 * AC: @multi-directory-daemon ac-25 - For conditional selector rendering
 */
export function hasMultipleProjects(): boolean {
  return projects.length > 1;
}

/**
 * Get the project version counter (for reactive dependencies)
 * AC: @multi-directory-daemon ac-27 - Components watch this to reload data
 */
export function getProjectVersion(): number {
  return projectVersion;
}

/**
 * Get all registered projects
 * AC: @multi-directory-daemon ac-25 - For project list display
 */
export function getProjects(): Project[] {
  return projects;
}

/**
 * Check if project store is loading
 */
export function isLoading(): boolean {
  return loading;
}

/**
 * Get error state
 */
export function getError(): string | null {
  return error;
}

/**
 * Check if project store has been initialized
 */
export function isInitialized(): boolean {
  return initialized;
}

/**
 * Initialize the project store for static mode.
 * In static mode there are no daemon projects to load, but pages gate
 * data loading on isInitialized(). This sets the flag so those gates pass.
 * AC: @gh-pages-export ac-25
 */
export function initializeForStaticMode(): void {
  initialized = true;
}

/**
 * Clear invalid selection and prompt user to select valid project
 * AC: @multi-directory-daemon ac-36 - Invalid project recovery
 */
export function clearInvalidSelection(): void {
  selectedPath = null;
  persistSelection(null);
  error = "Selected project is no longer valid. Please select a project.";
}

/**
 * Check if a path matches an API error indicating invalid project
 * Used by api.ts to detect when selected project becomes invalid
 */
export function isInvalidProjectError(response: Response, message?: string): boolean {
  if (response.status !== 400 && response.status !== 404) return false;
  if (!message) return false;
  return (
    message.includes("Invalid kspec project") ||
    message.includes("No default project configured") ||
    message.includes("Default project no longer valid")
  );
}
