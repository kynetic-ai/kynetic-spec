import { AsyncLocalStorage } from "node:async_hooks";
import { execSync } from "node:child_process";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ulid } from "ulid";
import * as YAML from "yaml";
import type { Pair } from "yaml";
import type { ZodError } from "zod";
import { withFileLock } from "./file-lock.js";
import {
  accessBufferAware,
  getActiveBatchBuffer,
  readdirBufferAware,
} from "../cli/batch-write-buffer.js";
import {
  AcceptanceCriterionSchema,
  InboxFileSchema,
  type InboxItem,
  type InboxItemInput,
  InboxItemSchema,
  type Manifest,
  ManifestSchema,
  type Note,
  type SpecItem,
  type SpecItemInput,
  SpecItemInputSchema,
  SpecItemPatchSchema,
  SpecItemSchema,
  type Task,
  type TaskInput,
  TaskInputSchema,
  TaskSchema,
  TasksFileSchema,
  TriageFileSchema,
  type TriageRecord,
  TriageRecordSchema,
  type Todo,
} from "../schema/index.js";
import { errors } from "../strings/index.js";
import { ItemIndex } from "./items.js";
import type { LoadedPlan } from "./plans.js";
import { ReferenceIndex } from "./refs.js";
import { loadReviewRecords } from "./reviews.js";
import {
  createShadowError,
  detectRunningFromShadowWorktree,
  detectShadow,
  getShadowStatus,
  hasRemoteTracking,
  resolveProjectRoots,
  shadowNeedsSync,
  shadowPull,
  type ShadowConfig,
  type ShadowOptions,
  ShadowError,
} from "./shadow.js";
import { loadProjectConfig, type ResolvedKspecConfig } from "./config.js";
import { assertRawManifestFormatVersionSupported } from "./format-version.js";
import { consumeSyncMode, type ShadowSyncMode } from "../cli/sync-mode.js";
import { TraitIndex } from "./traits.js";

/**
 * Async-context flag that tells initContext() to ignore the KSPEC_SPEC_DIR
 * env var and resolve the project from cwd/startDir instead.
 *
 * Used by the daemon command executor to prevent ambient KSPEC_SPEC_DIR
 * (set by concurrent tests or batch-atomic mode) from redirecting project
 * resolution.  Unlike deleting the env var, this approach is confined to
 * the current async execution chain and cannot race with other threads.
 */
const specDirOverrideStorage = new AsyncLocalStorage<{ ignore: boolean }>();
const workingDirectoryStorage = new AsyncLocalStorage<{ cwd: string }>();
export type EntityCacheAccessor = (projectPath: string) => unknown;

export interface EntityCacheContext {
  cacheAccessor: EntityCacheAccessor;
  projectPath: string;
}

const entityCacheStorage = new AsyncLocalStorage<EntityCacheContext>();

/**
 * Run `fn` in an async context where initContext() will skip the
 * KSPEC_SPEC_DIR env-var override and resolve the project purely
 * from cwd or startDir.
 */
export function runWithoutSpecDirOverride<T>(fn: () => T): T {
  return specDirOverrideStorage.run({ ignore: true }, fn);
}

export function runWithWorkingDirectory<T>(fn: () => T, cwd: string): T {
  return workingDirectoryStorage.run({ cwd }, fn);
}

export function getWorkingDirectoryOverride(): string | undefined {
  return workingDirectoryStorage.getStore()?.cwd;
}

export function runWithEntityCache<T>(
  fn: () => T,
  cacheAccessor: EntityCacheAccessor,
  projectPath: string,
): T {
  return entityCacheStorage.run({ cacheAccessor, projectPath }, fn);
}

export function getEntityCacheContext(): EntityCacheContext | undefined {
  return entityCacheStorage.getStore();
}

interface InitContextEntityCache {
  getDomainState?(domain: string): string | null | undefined;
  getProjectConfig?(): {
    root_dir: string;
    manifest_path?: string | null;
    manifest?: Manifest | null;
    config?: ResolvedKspecConfig;
  } | null;
  getShadowInfo?(): {
    enabled: boolean;
    branch_name: string | null;
    worktree_dir: string | null;
  } | null;
  getMetaDetail?(): unknown;
  getInboxIndex?(): LoadedInboxItem[] | null;
  getTriageIndex?(): Array<{
    _ulid: string;
    inbox_ref: string;
    status: TriageRecord["status"];
    created_at: string;
    action?: TriageRecord["action"];
    reasoning?: string;
    decided_by?: string;
    override_by?: string;
    override_at?: string;
    acted_at?: string;
    updated_at?: string;
    result_ref?: string;
    evidence_refs: string[];
  }> | null;
  getTriageDetail?(ulid: string): LoadedTriageRecord | null;
}

function tryGetCachedTriageRecords(
  ctx: KspecContext,
  cache: InitContextEntityCache,
): LoadedTriageRecord[] | null {
  if (cache.getDomainState?.("triage") !== "ready") {
    return null;
  }

  const cachedIndex = cache.getTriageIndex?.();
  if (!cachedIndex) {
    return null;
  }

  const inboxItems =
    cache.getDomainState?.("inbox") === "ready" ? (cache.getInboxIndex?.() ?? null) : null;
  const inboxByUlid = new Map(inboxItems?.map((item) => [item._ulid, item.text]) ?? []);
  const triagePath = getTriageFilePath(ctx);
  const cachedRecords: LoadedTriageRecord[] = [];

  for (const summary of cachedIndex) {
    const detail = cache.getTriageDetail?.(summary._ulid);
    if (detail) {
      cachedRecords.push(detail);
      continue;
    }

    if (summary.override_by || summary.override_at) {
      return null;
    }

    const itemSnapshot = inboxByUlid.get(summary.inbox_ref);
    if (!itemSnapshot) {
      return null;
    }

    cachedRecords.push({
      _ulid: summary._ulid,
      inbox_ref: summary.inbox_ref,
      item_snapshot: itemSnapshot,
      status: summary.status,
      action: summary.action,
      reasoning: summary.reasoning,
      decided_by: summary.decided_by,
      override_by: summary.override_by,
      override_at: summary.override_at,
      acted_at: summary.acted_at,
      updated_at: summary.updated_at,
      result_ref: summary.result_ref,
      evidence_refs: summary.evidence_refs,
      created_at: summary.created_at,
      _sourceFile: triagePath,
    });
  }

  return cachedRecords;
}

function tryGetCachedInitContext(): KspecContext | null {
  const cacheContext = getEntityCacheContext();
  if (!cacheContext) {
    return null;
  }

  const resolvedCache = cacheContext.cacheAccessor(cacheContext.projectPath) as
    | InitContextEntityCache
    | null
    | undefined;
  if (!resolvedCache || resolvedCache.getDomainState?.("meta") !== "ready") {
    return null;
  }

  const cachedProjectConfig = resolvedCache.getProjectConfig?.();
  const cachedShadowInfo = resolvedCache.getShadowInfo?.();
  const metaDetail = resolvedCache.getMetaDetail?.();
  if (!cachedProjectConfig?.config || !cachedShadowInfo || metaDetail == null) {
    return null;
  }

  const projectRoot = cachedProjectConfig.root_dir;
  const shadowDirectory = cachedProjectConfig.config.shadow.directory;
  const specDir =
    cachedShadowInfo.enabled && cachedShadowInfo.worktree_dir
      ? cachedShadowInfo.worktree_dir
      : path.join(projectRoot, shadowDirectory);

  return {
    rootDir: projectRoot,
    projectRoot,
    specDir,
    sessionsDir: path.join(projectRoot, ".kspec-sessions"),
    manifestPath: cachedProjectConfig.manifest_path ?? null,
    manifest: cachedProjectConfig.manifest ?? null,
    shadow:
      cachedShadowInfo.enabled && cachedShadowInfo.branch_name && cachedShadowInfo.worktree_dir
        ? {
            enabled: true,
            worktreeDir: cachedShadowInfo.worktree_dir,
            branchName: cachedShadowInfo.branch_name,
            projectRoot,
          }
        : null,
    config: cachedProjectConfig.config,
  };
}

/**
 * Log a debug message (only when KSPEC_DEBUG=1)
 */
function debugLog(prefix: string, message: string): void {
  if (process.env.KSPEC_DEBUG === "1") {
    console.error(`[DEBUG] ${prefix}: ${message}`);
  }
}

function formatIssuePath(pathParts: PropertyKey[]): string {
  if (pathParts.length === 0) {
    return "(root)";
  }

  let path = "";
  for (const part of pathParts) {
    if (typeof part === "number") {
      path = `${path}[${part}]`;
      continue;
    }

    path = path ? `${path}.${String(part)}` : String(part);
  }

  return path;
}

function formatIssueValue(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (value === undefined) {
    return "undefined";
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function getIssueValue(issue: ZodError["issues"][number]): unknown {
  if ("input" in issue && issue.input !== undefined) {
    return issue.input;
  }

  if ("received" in issue) {
    return issue.received;
  }

  return undefined;
}

function formatValidationIssues(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const fieldPath = formatIssuePath(issue.path);
      const invalidValue = formatIssueValue(getIssueValue(issue));
      return `${fieldPath}=${invalidValue} (${issue.message})`;
    })
    .join("; ");
}

export function warnSkippedRecord(
  entityType: string,
  id: string,
  source: string,
  error: ZodError,
): void {
  const details = formatValidationIssues(error);

  console.warn(
    `[kspec] Warning: skipped invalid ${entityType} ${id} from ${source}: ${details}. ` +
      "Suggested action: fix the invalid field in the YAML record and rerun the command.",
  );
}

/**
 * Parse a manifest and emit deprecation warnings for deprecated fields.
 *
 * AC: @config-manifest-cleanup ac-4 — debug-level deprecation note for daemon block
 */
function parseManifestWithWarnings(rawManifest: unknown): Manifest {
  const manifest = ManifestSchema.parse(rawManifest);

  // AC: @config-manifest-cleanup ac-4 — log debug-level deprecation note for daemon block
  if (manifest.daemon) {
    debugLog(
      "manifest",
      'Deprecated "daemon" block found in manifest. Use kspec.config.yaml instead.',
    );
  }

  // Also warn for deprecated config block
  if (manifest.config) {
    debugLog(
      "manifest",
      'Deprecated "config" block found in manifest. Use kspec.config.yaml instead.',
    );
  }

  return manifest;
}

/**
 * Spec item with runtime metadata for source tracking.
 * _sourceFile is not serialized - it's used to know where to write updates.
 * _path tracks location within the file for nested items (e.g., "features[0].requirements[2]")
 */
export interface LoadedSpecItem extends SpecItem {
  _sourceFile?: string;
  _path?: string;
}

/**
 * Task with runtime metadata for source tracking.
 * _sourceFile is not serialized - it's used to know where to write updates.
 */
export interface LoadedTask extends Task {
  _sourceFile?: string;
}

/**
 * Parse YAML content into an object
 * Uses the modern yaml library which has consistent type handling
 */
export function parseYaml<T>(content: string): T {
  return YAML.parse(content) as T;
}

/**
 * Serialize object to YAML
 * Uses the modern yaml library for consistent formatting.
 *
 * WORKAROUND: The 'yaml' library (v2.8.2+) has a known behavior where block scalars
 * containing whitespace-only lines accumulate extra blank lines on each parse-stringify
 * cycle. The library's blockString() function adds indentation after newlines, which
 * causes lines containing only spaces to grow. We post-process the output to filter
 * these whitespace-only lines. See: https://github.com/eemeli/yaml - stringifyString.ts
 */

/**
 * Canonical key priority tiers for YAML serialization.
 * Keys are sorted by tier first, then alphabetically within each tier.
 * _ulid is always first (tier 0). Keys not listed default to tier 50.
 */
const KEY_PRIORITY: Record<string, number> = {
  // Tier 0: ULID — always first for record boundary detection
  _ulid: 0,

  // Tier 1: Identity fields
  slugs: 1,
  title: 2,
  type: 3,

  // Tier 2: Content / description
  description: 10,
  text: 10,
  content: 10,

  // Tier 3: Spec relationships
  spec_ref: 15,
  derivation: 16,
  meta_ref: 17,
  plan_ref: 18,
  origin: 19,

  // Tier 4: Status / state
  status: 20,
  maturity: 20,
  blocked_by: 21,
  closed_reason: 22,
  disposition: 23,

  // Tier 5: Relationships
  depends_on: 25,
  context: 26,
  implements: 27,
  relates_to: 28,
  tests: 29,
  traits: 30,
  supersedes: 31,
  acceptance_criteria: 32,

  // Tier 6: Work metadata
  priority: 35,
  complexity: 36,
  tags: 37,
  assignee: 38,

  // Tier 7: VCS / review
  vcs_refs: 40,
  review_url: 41,
  review_ref: 42,
  submission_linkage: 43,
  session_id: 44,

  // Tier 8: Timestamps
  created: 60,
  created_at: 60,
  created_by: 61,
  started_at: 62,
  submitted_at: 63,
  completed_at: 64,
  updated_at: 65,
  acted_at: 66,
  deprecated_in: 67,
  superseded_by: 68,
  verified_at: 69,
  verified_by: 70,

  // Tier 9: Audit / append-only
  notes: 80,
  todos: 81,

  // Tier 10: Automation / config
  automation: 90,
  traceability: 91,
};

/**
 * Compare two YAML map entries for canonical field ordering.
 * _ulid is always first. Known keys are ordered by priority tier,
 * with alphabetical tiebreaking within the same tier.
 * Unknown keys sort after tier 50 (alphabetically among themselves).
 */
export function canonicalKeyComparator(a: Pair, b: Pair): number {
  const aKey = String(a.key);
  const bKey = String(b.key);
  const aPriority = KEY_PRIORITY[aKey] ?? 50;
  const bPriority = KEY_PRIORITY[bKey] ?? 50;
  if (aPriority !== bPriority) return aPriority - bPriority;
  return aKey.localeCompare(bKey);
}

export function toYaml(obj: unknown): string {
  // JSON round-trip breaks shared object references so the yaml library
  // won't generate anchors/aliases that crash when sortMapEntries reorders keys.
  // structuredClone preserves shared refs, so JSON.parse(JSON.stringify()) is needed.
  const cloned = JSON.parse(JSON.stringify(obj));
  let yamlString = YAML.stringify(cloned, {
    indent: 2,
    lineWidth: 100,
    sortMapEntries: canonicalKeyComparator,
  });

  // Post-process to fix yaml library blank line accumulation bug.
  // Filter out lines that contain only spaces/tabs (not truly empty lines).
  yamlString = yamlString
    .split("\n")
    .filter((line) => !/^[ \t]+$/.test(line))
    .join("\n");

  return yamlString;
}

/**
 * Read a text file with batch buffer overlay semantics.
 */
export async function readFileBufferAware(filePath: string): Promise<string> {
  // AC: @batch-write-buffer ac-2 — check buffer first for read-after-write consistency
  const buffer = getActiveBatchBuffer();
  if (buffer?.isInScope(filePath)) {
    const buffered = buffer.read(filePath);
    if (buffered !== undefined) {
      if (buffered === null) {
        // File was deleted in this batch
        throw Object.assign(new Error(`ENOENT: no such file or directory, open '${filePath}'`), {
          code: "ENOENT",
        });
      }
      return typeof buffered === "string" ? buffered : Buffer.from(buffered).toString("utf-8");
    }
  }

  return fs.readFile(filePath, "utf-8");
}

/**
 * Read and parse a YAML file.
 */
export async function readYamlFile<T>(filePath: string): Promise<T> {
  const content = await readFileBufferAware(filePath);
  return parseYaml<T>(content);
}

/**
 * Write object to YAML file
 */
export async function writeYamlFile(filePath: string, data: unknown): Promise<void> {
  const content = toYaml(data);
  // AC: @batch-write-buffer ac-1 — buffer write if in batch mode
  const buffer = getActiveBatchBuffer();
  if (buffer?.isInScope(filePath)) {
    buffer.write(filePath, content);
    return;
  }
  await writeFileAtomic(filePath, content);
}

/**
 * Write object to YAML file while preserving formatting and comments.
 *
 * Note: This function is now equivalent to writeYamlFile() - the "preserve format"
 * naming is historical. Both use toYaml() which includes the whitespace-only line
 * fix. Kept for backwards compatibility with existing callers.
 */
export async function writeYamlFilePreserveFormat(filePath: string, data: unknown): Promise<void> {
  const content = toYaml(data);
  // AC: @batch-write-buffer ac-1 — buffer write if in batch mode
  const buffer = getActiveBatchBuffer();
  if (buffer?.isInScope(filePath)) {
    buffer.write(filePath, content);
    return;
  }
  await writeFileAtomic(filePath, content);
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, content, "utf-8");
  await fs.rename(tmpPath, filePath);
}

/**
 * Find task files in a directory
 */
export async function findTaskFiles(dir: string): Promise<string[]> {
  const files: string[] = [];

  try {
    const entries = (await readdirBufferAware(dir, { withFileTypes: true })) as Dirent[];

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // Recurse into subdirectories
        const subFiles = await findTaskFiles(fullPath);
        files.push(...subFiles);
      } else if (entry.isFile() && entry.name.endsWith(".tasks.yaml")) {
        files.push(fullPath);
      }
    }
  } catch {
    // Directory doesn't exist or not readable
  }

  return files;
}

/**
 * Find the manifest file.
 *
 * Discovery algorithm per directory:
 * 1. Check for explicit names: kynetic.yaml, kynetic.spec.yaml (backward compat)
 * 2. If not found, scan for *.yaml files with 'kynetic:' version field
 *
 * Searches current dir, then spec/ subdir, then parent directories.
 */
export async function findManifest(startDir: string): Promise<string | null> {
  let dir = startDir;

  while (true) {
    // Check current directory
    const manifestInDir = await findManifestInDir(dir);
    if (manifestInDir) {
      return manifestInDir;
    }

    // Also check in spec/ subdirectory
    const specDir = path.join(dir, "spec");
    try {
      const stat = await fs.stat(specDir);
      if (stat.isDirectory()) {
        const manifestInSpec = await findManifestInDir(specDir);
        if (manifestInSpec) {
          return manifestInSpec;
        }
      }
    } catch {
      // spec/ doesn't exist
    }

    const parentDir = path.dirname(dir);
    if (parentDir === dir) {
      // Reached root
      return null;
    }
    dir = parentDir;
  }
}

/**
 * Context for working with spec/task files.
 *
 * When shadow branch is enabled:
 * - rootDir points to the active code checkout root
 * - projectRoot points to the main repo root (where .kspec/ lives)
 * - specDir points to .kspec/ (where spec files are read/written)
 * - All file operations use specDir for resolution
 *
 * Without shadow branch:
 * - rootDir is the active checkout root
 * - projectRoot is the same directory as rootDir
 * - specDir is rootDir/spec/ (traditional layout)
 */
export interface KspecContext {
  /** Active code checkout root (linked worktree root when applicable) */
  rootDir: string;
  /** Main repo root used for .kspec and daemon identity */
  projectRoot: string;
  /** Spec files directory (.kspec/ when shadow enabled, otherwise spec/) */
  specDir: string;
  /**
   * Sessions storage directory (.kspec-sessions/ at project root).
   * Separate from specDir — session data lives outside the shadow branch.
   *
   * AC: @session-storage-path-resolution ac-context
   */
  sessionsDir: string;
  /** Path to manifest file */
  manifestPath: string | null;
  /** Parsed manifest */
  manifest: Manifest | null;
  /** Shadow branch configuration (null if not using shadow) */
  shadow: ShadowConfig | null;
  /**
   * Project configuration from kspec.config.yaml.
   * Loaded before shadow detection. Always present (defaults if no config file).
   *
   * AC: @project-config ac-2 — config available on KspecContext.config
   */
  config: ResolvedKspecConfig;
}

/**
 * Read and schema-parse the manifest at `manifestPath`, enforcing the
 * format-version ceiling on the RAW manifest first.
 *
 * The ceiling check runs against the raw YAML object (not the schema-parsed
 * manifest) because the schema defaults a missing `kynetic` field to "1.0",
 * which would erase the missing-field case. A read/parse failure keeps the
 * existing "manifest exists but may be invalid" behavior (returns null);
 * the format-version refusal is the only error allowed to escape.
 *
 * AC: @data-format-forward-compatibility ac-newer-version-refused
 * AC: @data-format-forward-compatibility ac-unrecognized-version-refused
 */
async function readManifestWithVersionCeiling(manifestPath: string): Promise<Manifest | null> {
  let rawManifest: unknown;
  try {
    rawManifest = await readYamlFile<unknown>(manifestPath);
  } catch {
    // Manifest exists but may be invalid
    return null;
  }

  assertRawManifestFormatVersionSupported(rawManifest);

  try {
    return parseManifestWithWarnings(rawManifest);
  } catch {
    // Manifest exists but may be invalid
    return null;
  }
}

/**
 * Enforce the format-version ceiling for the manifest in `specDir` BEFORE
 * any side effect. Used by the shadow path ahead of the pre-read sync block:
 * a sync pull must never mutate a project whose local manifest already
 * declares a newer format than this installation supports.
 *
 * Missing or unreadable manifests pass — they keep their existing handling.
 *
 * AC: @data-format-forward-compatibility ac-newer-version-refused
 */
async function assertSpecDirFormatVersionSupported(specDir: string): Promise<void> {
  const manifestPath = await findManifestInDir(specDir);
  if (!manifestPath) return;

  let rawManifest: unknown;
  try {
    rawManifest = await readYamlFile<unknown>(manifestPath);
  } catch {
    // Manifest exists but may be invalid — existing behavior, not a refusal
    return;
  }

  assertRawManifestFormatVersionSupported(rawManifest);
}

/**
 * Initialize context by finding manifest.
 *
 * Detection order:
 * 1. Load project config from git root (before shadow detection)
 * 2. Check for shadow branch (.kspec/ directory)
 * 3. Fall back to traditional spec/ directory
 *
 * When shadow is detected, all operations use .kspec/ as specDir.
 *
 * AC: @project-config ac-2 — config loaded before shadow detection
 */
export async function initContext(
  startDir?: string,
  options?: { syncMode?: ShadowSyncMode },
): Promise<KspecContext> {
  const cachedContext = tryGetCachedInitContext();
  if (cachedContext) {
    return cachedContext;
  }

  const cwd = startDir || getWorkingDirectoryOverride() || process.cwd();
  const projectRoots = resolveProjectRoots(cwd);

  // AC: @project-config ac-2, ac-6, ac-7 — load config before shadow detection
  // Config is loaded from worktree root (the checked-out code's config), falling
  // back to main root. In worktrees, the branch-specific kspec.config.yaml lives
  // at worktreeRoot, not mainRoot (the parent repo may have a different version).
  const configResult = await loadProjectConfig(
    cwd,
    projectRoots?.worktreeRoot ?? projectRoots?.mainRoot,
  );

  // AC: @project-config ac-3 — emit warning to stderr if config had issues
  if (configResult.warning) {
    console.error(`Warning: ${configResult.warning}`);
  }

  const { config } = configResult;

  // KSPEC_SPEC_DIR override: used by batch atomic mode to redirect to temp copy.
  // Suppressed when running inside runWithoutSpecDirOverride() (e.g. daemon
  // command execution) to avoid process-env races with concurrent threads.
  const alsContext = specDirOverrideStorage.getStore();
  const specDirOverride = alsContext?.ignore ? undefined : process.env.KSPEC_SPEC_DIR;
  if (specDirOverride) {
    const specDir = path.resolve(specDirOverride);
    const manifestPath = await findManifestInDir(specDir);

    // AC: @data-format-forward-compatibility ac-newer-version-refused
    // Ceiling check on the raw manifest before any project data is served
    const manifest: Manifest | null = manifestPath
      ? await readManifestWithVersionCeiling(manifestPath)
      : null;

    const rootDir = path.dirname(specDir);
    return {
      rootDir,
      projectRoot: rootDir,
      specDir,
      sessionsDir: path.join(rootDir, ".kspec-sessions"),
      manifestPath,
      manifest,
      shadow: null, // No shadow in overridden context
      config,
    };
  }

  // Check if running from inside the shadow worktree
  // AC: @config-shadow ac-8 — pass configured directory for detection
  const mainProjectRoot = await detectRunningFromShadowWorktree(cwd, config.shadow.directory);
  if (mainProjectRoot) {
    throw new ShadowError(
      errors.project.runningFromShadow,
      "RUNNING_FROM_SHADOW",
      `Run from project root: cd ${path.relative(cwd, mainProjectRoot) || mainProjectRoot}`,
    );
  }

  // Try to detect shadow branch first
  // AC: @config-shadow ac-1 ac-2 — use configured branch/directory names
  const shadow = await detectShadow(
    cwd,
    {
      branchName: config.shadow.branch,
      directory: config.shadow.directory,
    },
    projectRoots?.mainRoot,
  );

  if (shadow?.enabled) {
    // Shadow mode: use .kspec/ for everything
    const specDir = shadow.worktreeDir;

    // AC: @data-format-forward-compatibility ac-newer-version-refused
    // Format-version ceiling check BEFORE the pre-read sync block: the sync
    // path below can pull into the shadow worktree, and a project declaring
    // a newer format must be refused before any such side effect.
    await assertSpecDirFormatVersionSupported(specDir);

    // AC: @shadow-lazy-read-sync ac-no-sync-env — KSPEC_NO_SYNC disables all sync
    // AC: @shadow-lazy-read-sync ac-syncmode-consume-once — consume-once prevents double-pull
    // AC: @shadow-lazy-read-sync ac-drift-check — drift check replaces unconditional pull
    if (!process.env.KSPEC_NO_SYNC) {
      // AC: @shadow-lazy-read-sync ac-daemon-bypass — explicit syncMode override
      // allows daemon routes to skip per-request drift-check on cache-miss fallback
      const syncMode = options?.syncMode ?? consumeSyncMode();

      // AC: @config-shadow ac-3 ac-7 — pass configured shadow options so sync
      // uses the right branch name and remote instead of hardcoded defaults
      const shadowOpts: ShadowOptions = {
        branchName: config.shadow.branch,
        directory: config.shadow.directory,
        remote: config.shadow.remote?.value,
        remoteType: config.shadow.remote?.type,
      };

      // AC: @shadow-write-sync ac-write-skips-read-check — skip pre-read sync for mutating commands
      if (syncMode !== "skip") {
        try {
          const tracked = await hasRemoteTracking(specDir, shadowOpts);
          if (tracked) {
            let shouldPull = false;

            if (syncMode === "always") {
              // AC: @shadow-lazy-read-sync ac-session-start-always-pulls
              shouldPull = true;
            } else {
              // AC: @shadow-lazy-read-sync ac-drift-check — lightweight drift check
              // AC: @shadow-lazy-read-sync ac-threshold-from-config
              const remoteName = config.shadow.remote?.value ?? "origin";
              const thresholdMs = config.shadow.sync_interval * 1000;
              shouldPull = await shadowNeedsSync(specDir, remoteName, thresholdMs);
            }

            if (shouldPull) {
              const syncResult = await shadowPull(specDir, shadowOpts);
              if (syncResult.hadConflict) {
                console.error(
                  "Warning: Shadow sync conflict detected. Run `kspec shadow resolve` to fix.",
                );
                console.error("Continuing with local state...");
              }
            }
          }
        } catch {
          // Pre-read sync is best-effort — don't fail the command
        }
      }
    }

    const manifestPath = await findManifestInDir(specDir);

    // AC: @data-format-forward-compatibility ac-post-sync-newer-version-refused
    // Re-apply the ceiling to the manifest read AFTER the sync block: the
    // pre-sync check only saw the local manifest, so a sync pull can import
    // a manifest upgraded remotely to a newer format. The same invocation
    // must refuse here, before any entity read or mutation.
    const manifest: Manifest | null = manifestPath
      ? await readManifestWithVersionCeiling(manifestPath)
      : null;

    return {
      rootDir: projectRoots?.worktreeRoot ?? shadow.projectRoot,
      projectRoot: shadow.projectRoot,
      specDir,
      sessionsDir: path.join(shadow.projectRoot, ".kspec-sessions"),
      manifestPath,
      manifest,
      shadow,
      config,
    };
  }

  // Fail closed when a repo already has shadow state but the configured worktree
  // is missing or disconnected, rather than silently degrading into repo-root mode.
  if (projectRoots?.mainRoot) {
    const shadowStatus = await getShadowStatus(projectRoots.mainRoot, {
      branchName: config.shadow.branch,
      directory: config.shadow.directory,
    });
    if (shadowStatus.branchExists && !shadowStatus.healthy) {
      throw createShadowError(shadowStatus);
    }
  }

  // Traditional mode: find manifest in spec/ or current directory
  const manifestPath = await findManifest(cwd);

  let manifest: Manifest | null = null;
  let rootDir = projectRoots?.worktreeRoot ?? cwd;
  const projectRoot = projectRoots?.mainRoot ?? rootDir;
  let specDir = rootDir;

  if (manifestPath) {
    const manifestDir = path.dirname(manifestPath);
    // Handle spec/ subdirectory
    if (path.basename(manifestDir) === "spec") {
      rootDir = path.dirname(manifestDir);
      specDir = manifestDir;
    } else {
      rootDir = manifestDir;
      specDir = manifestDir;
    }

    // AC: @data-format-forward-compatibility ac-newer-version-refused
    // Ceiling check on the raw manifest before any project data is served
    manifest = await readManifestWithVersionCeiling(manifestPath);
  }

  return {
    rootDir,
    projectRoot,
    specDir,
    sessionsDir: path.join(projectRoot, ".kspec-sessions"),
    manifestPath,
    manifest,
    shadow: null,
    config,
  };
}

/**
 * Check if a filename is a potential manifest file.
 * Excludes files with suffixes that indicate other kspec file types.
 *
 * AC: @manifest-discovery ac-5 (excludes task/inbox/meta/runs files)
 */
function isManifestCandidate(filename: string): boolean {
  if (!filename.endsWith(".yaml")) return false;
  const exclusions = [".tasks.yaml", ".inbox.yaml", ".meta.yaml", ".runs.yaml"];
  return !exclusions.some((excl) => filename.endsWith(excl));
}

/**
 * Find manifest file within a specific directory (no parent traversal).
 * Used for shadow mode where we know exactly where to look.
 *
 * Discovery algorithm:
 * 1. Check for explicit names: kynetic.yaml, kynetic.spec.yaml (backward compat)
 * 2. If not found, scan directory for *.yaml files (excluding other kspec types)
 * 3. For each candidate, validate it contains a 'kynetic:' version field
 * 4. Return first valid match (alphabetically after explicit names)
 *
 * AC: @manifest-discovery ac-1, ac-2, ac-3, ac-4, ac-5
 */
export async function findManifestInDir(dir: string): Promise<string | null> {
  // AC: @manifest-discovery ac-1, ac-2 - explicit names have priority
  const priorityCandidates = ["kynetic.yaml", "kynetic.spec.yaml"];

  for (const candidate of priorityCandidates) {
    const filePath = path.join(dir, candidate);
    try {
      await accessBufferAware(filePath);
      return filePath;
    } catch {
      // File doesn't exist, try next
    }
  }

  // AC: @manifest-discovery ac-3, ac-4, ac-5 - glob fallback with validation
  try {
    const entries = (await readdirBufferAware(dir)) as string[];
    // AC: @manifest-discovery ac-4 - alphabetical order
    const candidates = entries.filter(isManifestCandidate).toSorted();

    for (const candidate of candidates) {
      const filePath = path.join(dir, candidate);
      try {
        const raw = await readYamlFile<unknown>(filePath);
        // AC: @manifest-discovery ac-5 - validate kynetic version field
        if (raw && typeof raw === "object" && "kynetic" in raw) {
          return filePath;
        }
      } catch {
        // Skip invalid files
      }
    }
  } catch {
    // Directory read failed
  }

  return null;
}

/**
 * Load tasks from a single file.
 * Helper function used by loadAllTasks.
 */
async function loadTasksFromFile(filePath: string): Promise<LoadedTask[]> {
  const tasks: LoadedTask[] = [];

  try {
    const raw = await readYamlFile<unknown>(filePath);

    // Handle both array format and object format
    let taskList: unknown[];

    if (Array.isArray(raw)) {
      taskList = raw;
    } else if (raw && typeof raw === "object" && "tasks" in raw) {
      const parsed = TasksFileSchema.safeParse(raw);
      if (parsed.success) {
        // Add _sourceFile to each task from this file
        for (const task of parsed.data.tasks) {
          tasks.push({ ...task, _sourceFile: filePath });
        }
        return tasks;
      }
      taskList = (raw as { tasks: unknown[] }).tasks || [];
    } else {
      // Single task object
      taskList = [raw];
    }

    for (const taskData of taskList) {
      const result = TaskSchema.safeParse(taskData);
      if (result.success) {
        // Add _sourceFile metadata
        tasks.push({ ...result.data, _sourceFile: filePath });
      } else {
        const rawTask = taskData as Record<string, unknown> | null;
        const taskId =
          rawTask && typeof rawTask._ulid === "string" ? rawTask._ulid : "<unknown-task>";
        warnSkippedRecord("task", taskId, filePath, result.error);
      }
    }
  } catch {
    // Skip invalid files
  }

  return tasks;
}

/**
 * Load all tasks from the project.
 * Each task includes _sourceFile metadata for write-back routing.
 *
 * When shadow is enabled, tasks are loaded from .kspec/ (ctx.specDir).
 * Otherwise, searches in traditional locations (rootDir, spec/, tasks/).
 */
export async function loadAllTasks(ctx: KspecContext): Promise<LoadedTask[]> {
  const tasks: LoadedTask[] = [];

  // When shadow is enabled (or spec dir is explicitly overridden), look only in specDir.
  // KSPEC_SPEC_DIR override is used by batch mode and some integration tests to isolate
  // task state to a temp directory; scanning ctx.rootDir can leak tasks from parent dirs.
  // Respects runWithoutSpecDirOverride() context (same as initContext).
  const specDirActive = (() => {
    const als = specDirOverrideStorage.getStore();
    return als?.ignore ? false : Boolean(process.env.KSPEC_SPEC_DIR);
  })();
  if (ctx.shadow?.enabled || specDirActive) {
    const taskFiles = await findTaskFiles(ctx.specDir);

    // Also check for standalone files in specDir
    const standaloneLocations = [
      path.join(ctx.specDir, "tasks.yaml"),
      path.join(ctx.specDir, "project.tasks.yaml"),
      path.join(ctx.specDir, "kynetic.tasks.yaml"),
      path.join(ctx.specDir, "backlog.tasks.yaml"),
      path.join(ctx.specDir, "active.tasks.yaml"),
    ];

    for (const loc of standaloneLocations) {
      try {
        await accessBufferAware(loc);
        if (!taskFiles.includes(loc)) {
          taskFiles.push(loc);
        }
      } catch {
        // File doesn't exist
      }
    }

    // Deduplicate and load
    const uniqueFiles = [...new Set(taskFiles)];
    for (const filePath of uniqueFiles) {
      const fileTasks = await loadTasksFromFile(filePath);
      tasks.push(...fileTasks);
    }

    return tasks;
  }

  // Traditional mode: look in multiple locations
  const taskFiles = await findTaskFiles(ctx.rootDir);

  // Also check common locations
  const additionalPaths = [path.join(ctx.rootDir, "tasks"), path.join(ctx.rootDir, "spec")];

  for (const additionalPath of additionalPaths) {
    const files = await findTaskFiles(additionalPath);
    taskFiles.push(...files);
  }

  // Also look for standalone tasks.yaml and project.tasks.yaml
  const standaloneLocations = [
    path.join(ctx.rootDir, "tasks.yaml"),
    path.join(ctx.rootDir, "project.tasks.yaml"),
    path.join(ctx.rootDir, "spec", "project.tasks.yaml"),
    path.join(ctx.rootDir, "backlog.tasks.yaml"),
    path.join(ctx.rootDir, "active.tasks.yaml"),
  ];

  for (const loc of standaloneLocations) {
    try {
      await accessBufferAware(loc);
      if (!taskFiles.includes(loc)) {
        taskFiles.push(loc);
      }
    } catch {
      // File doesn't exist
    }
  }

  // Deduplicate and load
  const uniqueFiles = [...new Set(taskFiles)];

  for (const filePath of uniqueFiles) {
    const fileTasks = await loadTasksFromFile(filePath);
    tasks.push(...fileTasks);
  }

  return tasks;
}

/**
 * Find a task by reference (ULID, slug, or short reference)
 */
export function findTaskByRef(tasks: LoadedTask[], ref: string): LoadedTask | undefined {
  // Remove @ prefix if present
  const cleanRef = ref.startsWith("@") ? ref.slice(1) : ref;

  return tasks.find((task) => {
    // Match full ULID
    if (task._ulid === cleanRef) return true;

    // Match short ULID (prefix)
    if (task._ulid.toLowerCase().startsWith(cleanRef.toLowerCase())) return true;

    // Match slug
    if (task.slugs.includes(cleanRef)) return true;

    return false;
  });
}

/**
 * Get the default task file path for new tasks without a spec_ref.
 *
 * When shadow enabled: .kspec/project.tasks.yaml
 * Otherwise: spec/project.tasks.yaml
 */
export function getDefaultTaskFilePath(ctx: KspecContext): string {
  return path.join(ctx.specDir, "project.tasks.yaml");
}

/**
 * Strip runtime metadata before serialization
 */
export function stripRuntimeMetadata(task: LoadedTask): Task {
  const { _sourceFile, ...cleanTask } = task;
  return cleanTask as Task;
}

/**
 * Extract the raw task array and format info from a YAML file.
 * Does NOT run schema validation — preserves original data for round-trip stability.
 */
export async function extractRawTaskArray(filePath: string): Promise<{
  rawTasks: unknown[];
  useTasksWrapper: boolean;
  wrapperObj?: Record<string, unknown>;
}> {
  let existingRaw: unknown = null;
  let useTasksWrapper = false;

  try {
    existingRaw = await readYamlFile<unknown>(filePath);
    if (existingRaw && typeof existingRaw === "object" && "tasks" in existingRaw) {
      useTasksWrapper = true;
    }
  } catch {
    // File doesn't exist
    return { rawTasks: [], useTasksWrapper: false };
  }

  if (!existingRaw) {
    return { rawTasks: [], useTasksWrapper: false };
  }

  if (Array.isArray(existingRaw)) {
    return { rawTasks: existingRaw, useTasksWrapper: false };
  }

  if (useTasksWrapper) {
    const wrapper = existingRaw as Record<string, unknown>;
    const tasks = wrapper.tasks;
    return {
      rawTasks: Array.isArray(tasks) ? tasks : [],
      useTasksWrapper: true,
      wrapperObj: wrapper,
    };
  }

  // Bare single-task object (not an array, not a {tasks:[...]} wrapper).
  // Treat as a single-element array so mutations can read and write it back.
  if (typeof existingRaw === "object") {
    return { rawTasks: [existingRaw], useTasksWrapper: false, wrapperObj: undefined };
  }

  return { rawTasks: [], useTasksWrapper: false };
}

/**
 * Merge a schema-normalized task onto the original raw task data.
 * Only adds fields that were in the original raw data or that contain
 * non-default values. This prevents Zod defaults from polluting YAML
 * output with fields that weren't originally present.
 *
 * Fields present in rawTask are always updated with the new value.
 * Fields NOT in rawTask are only added if they carry meaningful data
 * (i.e. non-empty arrays, non-null values, etc.).
 */
/** Schema-known keys — used to distinguish unknown (extension) fields from
 *  known fields that a mutation intentionally cleared.
 *
 *  Exported so the task-specific wrapper in src/parser/split-backend.ts
 *  can delegate to the shared `mergePreservingRawShape` helper without
 *  yaml.ts taking a dependency on the trait foundation. */
export const TASK_SCHEMA_KEYS: ReadonlySet<string> = new Set(Object.keys(TaskSchema.shape));

/**
 * Create a new task with auto-generated fields
 */
export function createTask(input: TaskInput): Task {
  const parsed = TaskInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`Invalid task input: ${formatValidationIssues(parsed.error)}`);
  }

  const validatedInput = parsed.data;
  const now = new Date().toISOString();

  return {
    ...validatedInput,
    _ulid: validatedInput._ulid || ulid(),
    slugs: validatedInput.slugs || [],
    type: validatedInput.type || "task",
    status: validatedInput.status || "pending",
    blocked_by: validatedInput.blocked_by || [],
    depends_on: validatedInput.depends_on || [],
    context: validatedInput.context || [],
    priority: validatedInput.priority || 3,
    tags: validatedInput.tags || [],
    vcs_refs: validatedInput.vcs_refs || [],
    created_at: validatedInput.created_at || now,
    notes: validatedInput.notes || [],
    todos: validatedInput.todos || [],
  };
}

/**
 * Get author from environment with fallback chain.
 * Priority:
 *   1. KSPEC_AUTHOR env var (explicit config, agent-agnostic)
 *   2. kspec.config.yaml identity.author (project-level default)
 *   3. git user.name (developer identity)
 *   4. USER/USERNAME env var (system user)
 *   5. undefined (will show as 'unknown' in output)
 *
 * For Claude Code integration, add to ~/.claude/settings.json:
 *   { "env": { "KSPEC_AUTHOR": "@claude" } }
 *
 * AC: @config-author ac-1 ac-2 ac-3 — author priority chain
 *
 * @param configAuthor Optional author from kspec.config.yaml identity.author
 */
export function getAuthor(configAuthor?: string | null): string | undefined {
  // 1. Explicit env var (works for any agent) — AC: ac-2
  if (process.env.KSPEC_AUTHOR) {
    return process.env.KSPEC_AUTHOR;
  }

  // 2. Project config author — AC: ac-1
  if (configAuthor) {
    return configAuthor;
  }

  // 3. Git user.name — AC: ac-3
  try {
    const gitUser = execSync("git config user.name", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    if (gitUser) {
      return gitUser;
    }
  } catch {
    // git not available or not in a repo
  }

  // 4. System user — AC: ac-3
  const systemUser = process.env.USER || process.env.USERNAME;
  if (systemUser) {
    return systemUser;
  }

  // 5. No author available
  return undefined;
}

/**
 * Create a new note entry.
 * If author is not provided, attempts to auto-detect from environment.
 */
export function createNote(content: string, author?: string, supersedes?: string): Note {
  return {
    _ulid: ulid(),
    created_at: new Date().toISOString(),
    author: author ?? getAuthor(),
    // Trim content to prevent whitespace-only lines from accumulating
    // in block scalars during YAML parse-stringify cycles
    content: content.trim(),
    supersedes: supersedes || null,
  };
}

/**
 * Create a new todo item.
 * The id should be the next available id for the task's todos array.
 */
export function createTodo(id: number, text: string, addedBy?: string): Todo {
  return {
    id,
    // Trim text to prevent whitespace-only lines from accumulating
    // in block scalars during YAML parse-stringify cycles
    text: text.trim(),
    done: false,
    added_at: new Date().toISOString(),
    added_by: addedBy ?? getAuthor(),
  };
}

/**
 * Check if task dependencies are met
 */
export function areDependenciesMet(task: LoadedTask, allTasks: LoadedTask[]): boolean {
  if (task.depends_on.length === 0) return true;

  for (const depRef of task.depends_on) {
    const depTask = findTaskByRef(allTasks, depRef);
    if (!depTask || depTask.status !== "completed") {
      return false;
    }
  }

  return true;
}

/**
 * Check if task is ready (pending/needs_work + deps met + not blocked)
 */
export function isTaskReady(task: LoadedTask, allTasks: LoadedTask[]): boolean {
  if (task.status !== "pending" && task.status !== "needs_work") return false;
  if (task.blocked_by.length > 0) return false;
  return areDependenciesMet(task, allTasks);
}

/**
 * Get ready tasks (pending/needs_work + deps met + not blocked), sorted by
 * status (needs_work first), then priority, then creation time.
 * Within the same tier, older tasks come first (FIFO).
 */
export function getReadyTasks(tasks: LoadedTask[]): LoadedTask[] {
  return tasks
    .filter((task) => isTaskReady(task, tasks))
    .toSorted((a, b) => {
      // Primary: needs_work before pending (fix cycles take priority)
      const statusOrder = (s: string) => (s === "needs_work" ? 0 : 1);
      const statusDiff = statusOrder(a.status) - statusOrder(b.status);
      if (statusDiff !== 0) return statusDiff;
      // Secondary: priority (lower number = higher priority)
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }
      // Tertiary: creation time (older first - FIFO within priority)
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    });
}

// ============================================================
// SPEC ITEM LOADING
// ============================================================

/**
 * Expand a glob-like include pattern to file paths.
 * Supports simple patterns like "modules/*.yaml" or "**\/*.yaml"
 */
export async function expandIncludePattern(pattern: string, baseDir: string): Promise<string[]> {
  const fullPattern = path.isAbsolute(pattern) ? pattern : path.join(baseDir, pattern);

  // If no glob characters, just return the path if it exists
  if (!pattern.includes("*")) {
    try {
      await accessBufferAware(fullPattern);
      return [fullPattern];
    } catch {
      return [];
    }
  }

  // Split pattern into directory part and file pattern
  const parts = pattern.split("/");
  let currentDir = baseDir;
  const result: string[] = [];

  // Find the first part with a glob
  const globIndex = parts.findIndex((p) => p.includes("*"));

  // Navigate to the directory before the glob
  if (globIndex > 0) {
    currentDir = path.join(baseDir, ...parts.slice(0, globIndex));
  }

  // Get the remaining pattern
  const remainingPattern = parts.slice(globIndex).join("/");

  await expandGlobRecursive(currentDir, remainingPattern, result);
  return result;
}

/**
 * Recursively expand glob patterns
 */
async function expandGlobRecursive(dir: string, pattern: string, result: string[]): Promise<void> {
  const parts = pattern.split("/");
  const currentPattern = parts[0];
  const remainingPattern = parts.slice(1).join("/");

  try {
    const entries = (await readdirBufferAware(dir, { withFileTypes: true })) as Dirent[];

    for (const entry of entries) {
      const matches = matchGlobPart(entry.name, currentPattern);

      if (matches) {
        const fullPath = path.join(dir, entry.name);

        if (remainingPattern) {
          // More pattern parts to process
          if (entry.isDirectory()) {
            await expandGlobRecursive(fullPath, remainingPattern, result);
          }
        } else {
          // This is the final pattern part
          if (currentPattern === "**") {
            // ** matches any depth - need special handling
            if (entry.isDirectory()) {
              await expandGlobRecursive(fullPath, "**", result);
            }
            // Also match files at this level
            result.push(fullPath);
          } else if (entry.isFile()) {
            result.push(fullPath);
          }
        }
      }

      // Handle ** - also recurse into directories without consuming the pattern
      if (currentPattern === "**" && entry.isDirectory()) {
        const fullPath = path.join(dir, entry.name);
        await expandGlobRecursive(fullPath, pattern, result);
      }
    }
  } catch {
    // Directory doesn't exist or not readable
  }
}

/**
 * Match a single path component against a glob pattern part
 */
function matchGlobPart(name: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern === "**") return true;

  // Convert glob pattern to regex
  const regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // Escape special regex chars
    .replace(/\*/g, ".*") // * matches anything
    .replace(/\?/g, "."); // ? matches single char

  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(name);
}

/**
 * Fields that may contain nested spec items
 */
const NESTED_ITEM_FIELDS = [
  "modules",
  "features",
  "requirements",
  "constraints",
  "decisions",
  "traits",
  "acceptance_criteria",
];

/**
 * Recursively extract all spec items from a raw YAML structure.
 * Items can be nested under modules/features/requirements/etc.
 * Tracks the path within the file for each item.
 */
export function extractItemsFromRaw(
  raw: unknown,
  sourceFile: string,
  items: LoadedSpecItem[] = [],
  currentPath: string = "",
): LoadedSpecItem[] {
  if (!raw || typeof raw !== "object") {
    return items;
  }

  // Check if this object is itself a spec item (has _ulid)
  if ("_ulid" in raw && typeof (raw as Record<string, unknown>)._ulid === "string") {
    // Strip nested item arrays before validation since they're processed separately
    // and the SpecItemSchema expects refs (strings), not nested objects
    const rawObj = raw as Record<string, unknown>;
    const cleanedForValidation: Record<string, unknown> = { ...rawObj };
    for (const field of NESTED_ITEM_FIELDS) {
      if (field in cleanedForValidation && Array.isArray(cleanedForValidation[field])) {
        const arr = cleanedForValidation[field] as unknown[];
        // Check if array contains nested items (objects with _ulid) vs refs (strings)
        const hasNestedItems = arr.some(
          (item) =>
            item && typeof item === "object" && "_ulid" in (item as Record<string, unknown>),
        );
        if (hasNestedItems) {
          // Strip nested items - they'll be extracted recursively
          delete cleanedForValidation[field];
        }
      }
    }

    const result = SpecItemSchema.safeParse(cleanedForValidation);
    if (result.success) {
      items.push({
        ...result.data,
        _sourceFile: sourceFile,
        _path: currentPath || undefined,
      });
    } else {
      const itemId =
        typeof rawObj._ulid === "string" ? rawObj._ulid : currentPath || "<unknown-item>";
      warnSkippedRecord("spec item", itemId, sourceFile, result.error);
    }

    // Even if the item itself was added, also extract nested items
    for (const field of NESTED_ITEM_FIELDS) {
      if (field in rawObj && Array.isArray(rawObj[field])) {
        const arr = rawObj[field] as unknown[];
        for (let i = 0; i < arr.length; i++) {
          const nestedPath = currentPath ? `${currentPath}.${field}[${i}]` : `${field}[${i}]`;
          extractItemsFromRaw(arr[i], sourceFile, items, nestedPath);
        }
      }
    }
  } else if (Array.isArray(raw)) {
    // Array of items at root level
    for (let i = 0; i < raw.length; i++) {
      const itemPath = currentPath ? `${currentPath}[${i}]` : `[${i}]`;
      extractItemsFromRaw(raw[i], sourceFile, items, itemPath);
    }
  } else {
    // Object that might contain item arrays (like manifest with modules/features/etc)
    const rawObj = raw as Record<string, unknown>;
    for (const field of NESTED_ITEM_FIELDS) {
      if (field in rawObj && Array.isArray(rawObj[field])) {
        const arr = rawObj[field] as unknown[];
        for (let i = 0; i < arr.length; i++) {
          const nestedPath = currentPath ? `${currentPath}.${field}[${i}]` : `${field}[${i}]`;
          extractItemsFromRaw(arr[i], sourceFile, items, nestedPath);
        }
      }
    }
  }

  return items;
}

/**
 * Load spec items from a single file.
 * Handles module files (the file itself is an item with nested children).
 */
export async function loadSpecFile(filePath: string): Promise<LoadedSpecItem[]> {
  try {
    const content = await readFileBufferAware(filePath);
    const items: LoadedSpecItem[] = [];

    // Parse all YAML documents in the file (handles files with ---)
    const documents = YAML.parseAllDocuments(content);

    for (const doc of documents) {
      if (doc.errors.length > 0) {
        // Skip documents with parse errors
        continue;
      }

      const raw = doc.toJS();
      if (raw) {
        const docItems = extractItemsFromRaw(raw, filePath);
        items.push(...docItems);
      }
    }

    return items;
  } catch {
    // File doesn't exist or parse error
    return [];
  }
}

/**
 * Load all spec items from the project.
 * Parses manifest, follows includes, and builds unified collection.
 */
export async function loadAllItems(ctx: KspecContext): Promise<LoadedSpecItem[]> {
  const cacheContext = getEntityCacheContext();
  if (cacheContext) {
    const cache = cacheContext.cacheAccessor(cacheContext.projectPath) as
      | {
          getDomainState?(domain: string): string | null | undefined;
          getAllItemDetails?(): LoadedSpecItem[] | null;
        }
      | null
      | undefined;
    if (cache?.getDomainState?.("items") === "ready") {
      return cache.getAllItemDetails?.() ?? [];
    }
  }

  const items: LoadedSpecItem[] = [];

  if (!ctx.manifest || !ctx.manifestPath) {
    return items;
  }

  const manifestDir = path.dirname(ctx.manifestPath);

  // Extract items from manifest itself (inline modules/features/etc)
  const manifestItems = extractItemsFromRaw(ctx.manifest, ctx.manifestPath);
  items.push(...manifestItems);

  // Process includes
  const includes = ctx.manifest.includes || [];

  for (const include of includes) {
    const expandedPaths = await expandIncludePattern(include, manifestDir);

    for (const filePath of expandedPaths) {
      const fileItems = await loadSpecFile(filePath);
      items.push(...fileItems);
    }
  }

  return items;
}

/**
 * Find a spec item by reference (ULID, slug, or short reference)
 */
export function findItemByRef(items: LoadedSpecItem[], ref: string): LoadedSpecItem | undefined {
  // Remove @ prefix if present
  const cleanRef = ref.startsWith("@") ? ref.slice(1) : ref;

  return items.find((item) => {
    // Match full ULID
    if (item._ulid === cleanRef) return true;

    // Match short ULID (prefix)
    if (item._ulid.toLowerCase().startsWith(cleanRef.toLowerCase())) return true;

    // Match slug
    if (item.slugs.includes(cleanRef)) return true;

    return false;
  });
}

/**
 * Combined item type for unified queries across tasks and spec items
 */
export type AnyLoadedItem = LoadedTask | LoadedSpecItem;

/**
 * Find any item (task or spec item) by reference
 */
export function findAnyItemByRef(
  tasks: LoadedTask[],
  items: LoadedSpecItem[],
  ref: string,
): AnyLoadedItem | undefined {
  // Try tasks first (more commonly referenced)
  const task = findTaskByRef(tasks, ref);
  if (task) return task;

  // Then try spec items
  return findItemByRef(items, ref);
}

/**
 * Build a ReferenceIndex from context.
 * Loads all tasks and spec items, then builds the index.
 */
export async function buildReferenceIndex(ctx: KspecContext): Promise<{
  index: ReferenceIndex;
  tasks: LoadedTask[];
  items: LoadedSpecItem[];
}> {
  // Dynamic import to avoid circular dependency (task-data-manager imports from yaml)
  const { resolveTaskDataManager } = await import("./task-data-manager.js");
  const tasks = await resolveTaskDataManager(ctx).loadAllTasks(ctx);
  const items = await loadAllItems(ctx);
  const reviews = await loadReviewRecords(ctx);
  const index = new ReferenceIndex(tasks, items, [], [], reviews);
  return { index, tasks, items };
}

/**
 * Build both ReferenceIndex and ItemIndex from context.
 * Use this when you need query capabilities in addition to reference resolution.
 * Pass plans for cross-namespace slug collision detection (plans aren't loaded by default
 * to avoid circular dependency with plans.ts).
 */
export async function buildIndexes(
  ctx: KspecContext,
  plans: LoadedPlan[] = [],
): Promise<{
  refIndex: ReferenceIndex;
  itemIndex: ItemIndex;
  traitIndex: TraitIndex;
  tasks: LoadedTask[];
  items: LoadedSpecItem[];
}> {
  // Dynamic import to avoid circular dependency (task-data-manager imports from yaml)
  const { resolveTaskDataManager } = await import("./task-data-manager.js");
  const tasks = await resolveTaskDataManager(ctx).loadAllTasks(ctx);
  const items = await loadAllItems(ctx);
  const reviews = await loadReviewRecords(ctx);
  const refIndex = new ReferenceIndex(tasks, items, [], plans, reviews);
  const itemIndex = new ItemIndex(tasks, items);
  const traitIndex = new TraitIndex(items, refIndex);
  return { refIndex, itemIndex, traitIndex, tasks, items };
}

// ============================================================
// SPEC ITEM CRUD (supports nested structures)
// ============================================================

/**
 * Strip runtime metadata from spec item before serialization
 */
function stripSpecItemMetadata(item: LoadedSpecItem): SpecItem {
  const { _sourceFile, _path, ...cleanItem } = item;
  return cleanItem as SpecItem;
}

function assertSpecItemPatch(
  updates: Partial<SpecItemInput>,
  operation: "updateSpecItem" | "saveSpecItem",
): void {
  const patch = updates as Record<string, unknown>;
  if ("_sourceFile" in patch || "_path" in patch) {
    throw new Error(
      `${operation} expects a patch object, not a full LoadedSpecItem. Pass only intended fields to update.`,
    );
  }
}

/**
 * Recursively collect AC validation errors from nested catalog structures.
 *
 * SpecItemPatchSchema validates top-level acceptance_criteria, but nested catalog
 * fields (features, requirements, etc.) pass through as unknown data. This helper
 * walks those nested structures and validates each acceptance_criteria entry
 * against the full AcceptanceCriterionSchema (id, given, when, then).
 */
function collectNestedAcErrors(data: Record<string, unknown>, parentPath: string = ""): string[] {
  const errors: string[] = [];
  // Catalog fields that can contain nested spec items with acceptance_criteria
  const catalogFields = [
    "modules",
    "features",
    "requirements",
    "constraints",
    "decisions",
    "traits",
  ];

  for (const field of catalogFields) {
    if (!(field in data) || !Array.isArray(data[field])) continue;
    const items = data[field] as unknown[];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      const itemPath = parentPath ? `${parentPath}.${field}[${i}]` : `${field}[${i}]`;

      // Validate acceptance_criteria field shape and entries
      if ("acceptance_criteria" in obj) {
        if (!Array.isArray(obj.acceptance_criteria)) {
          errors.push(
            `${itemPath}.acceptance_criteria: Expected array, received ${typeof obj.acceptance_criteria}`,
          );
        } else {
          const acs = obj.acceptance_criteria as unknown[];
          for (let j = 0; j < acs.length; j++) {
            const ac = acs[j];
            const acPath = `${itemPath}.acceptance_criteria[${j}]`;
            const parseResult = AcceptanceCriterionSchema.safeParse(ac);
            if (!parseResult.success) {
              for (const issue of parseResult.error.issues) {
                const fieldPath = issue.path.length > 0 ? `.${issue.path.join(".")}` : "";
                errors.push(`${acPath}${fieldPath}: ${issue.message}`);
              }
            }
          }
        }
      }

      // Recurse into deeper nesting (e.g. features[0].requirements[0].…)
      errors.push(...collectNestedAcErrors(obj, itemPath));
    }
  }
  return errors;
}

/**
 * Validate spec item patch data against the schema.
 *
 * Always validates known fields (including acceptance_criteria[].id) through
 * SpecItemPatchSchema. When allowUnknown is false, unknown fields are rejected.
 * When allowUnknown is true, unknown fields pass through but known fields are
 * still validated.
 *
 * Also validates acceptance_criteria entries in nested catalog structures (features,
 * requirements, etc.) against the full AcceptanceCriterionSchema. These fields are
 * not part of SpecItemPatchSchema but are supported by the parser as nested catalog items.
 *
 * @returns null if valid, or a formatted error string if invalid
 */
export function validateSpecItemPatchData(
  data: Record<string, unknown>,
  options: { allowUnknown?: boolean } = {},
): string | null {
  const schema = options.allowUnknown ? SpecItemPatchSchema : SpecItemPatchSchema.strict();
  const result = schema.safeParse(data);
  const schemaErrors = result.success
    ? []
    : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);

  // Validate acceptance_criteria in nested catalog structures (features, requirements, etc.)
  // These fields pass through SpecItemPatchSchema as unknown data but can contain
  // acceptance_criteria entries that must conform to the full AC schema.
  const nestedErrors = collectNestedAcErrors(data);

  const allErrors = [...schemaErrors, ...nestedErrors];
  return allErrors.length > 0 ? allErrors.join("; ") : null;
}

/**
 * Parse a path string into segments.
 * e.g., "features[0].requirements[2]" -> [["features", 0], ["requirements", 2]]
 */
function parsePath(pathStr: string): Array<[string, number]> {
  const segments: Array<[string, number]> = [];
  const regex = /(\w+)\[(\d+)\]/g;
  let match;
  while ((match = regex.exec(pathStr)) !== null) {
    segments.push([match[1], parseInt(match[2], 10)]);
  }
  return segments;
}

/**
 * Navigate to a location in a YAML structure using a path.
 * Returns the parent object and the array containing the target item.
 */
function navigateToPath(
  root: unknown,
  pathStr: string,
): { parent: Record<string, unknown>; array: unknown[]; index: number } | null {
  if (!pathStr) return null;

  const segments = parsePath(pathStr);
  if (segments.length === 0) return null;

  let current: unknown = root;

  // Navigate to the parent of the last segment
  for (let i = 0; i < segments.length - 1; i++) {
    const [field, index] = segments[i];
    if (typeof current !== "object" || current === null) return null;
    const obj = current as Record<string, unknown>;
    if (!Array.isArray(obj[field])) return null;
    current = (obj[field] as unknown[])[index];
  }

  // Get the final array and index
  const [finalField, finalIndex] = segments[segments.length - 1];
  if (typeof current !== "object" || current === null) return null;
  const parent = current as Record<string, unknown>;
  if (!Array.isArray(parent[finalField])) return null;

  return {
    parent,
    array: parent[finalField] as unknown[],
    index: finalIndex,
  };
}

/**
 * Find an item by ULID in a nested YAML structure.
 * Returns the path segments to reach it.
 */
function findItemInStructure(
  root: unknown,
  ulid: string,
  currentPath: string = "",
): { path: string; item: Record<string, unknown> } | null {
  if (!root || typeof root !== "object") return null;

  const obj = root as Record<string, unknown>;

  // Check if this is the item we're looking for
  if (obj._ulid === ulid) {
    return { path: currentPath, item: obj };
  }

  // Search nested item fields
  for (const field of NESTED_ITEM_FIELDS) {
    if (Array.isArray(obj[field])) {
      const arr = obj[field] as unknown[];
      for (let i = 0; i < arr.length; i++) {
        const nestedPath = currentPath ? `${currentPath}.${field}[${i}]` : `${field}[${i}]`;
        const result = findItemInStructure(arr[i], ulid, nestedPath);
        if (result) return result;
      }
    }
  }

  return null;
}

/**
 * Create a new spec item with auto-generated fields
 */
export function createSpecItem(input: SpecItemInput): SpecItem {
  const parsed = SpecItemInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`Invalid spec item input: ${formatValidationIssues(parsed.error)}`);
  }

  const validatedInput = parsed.data;
  return {
    _ulid: validatedInput._ulid || ulid(),
    slugs: validatedInput.slugs || [],
    title: validatedInput.title,
    type: validatedInput.type,
    status: validatedInput.status,
    priority: validatedInput.priority,
    tags: validatedInput.tags || [],
    description: validatedInput.description,
    acceptance_criteria: validatedInput.acceptance_criteria,
    depends_on: validatedInput.depends_on || [],
    implements: validatedInput.implements || [],
    relates_to: validatedInput.relates_to || [],
    tests: validatedInput.tests || [],
    traits: validatedInput.traits || [],
    notes: validatedInput.notes || [],
    created: validatedInput.created || new Date().toISOString(),
    created_by: validatedInput.created_by,
  };
}

/**
 * Map from item type to the field name used to store children of that type.
 */
const TYPE_TO_CHILD_FIELD: Record<string, string> = {
  feature: "features",
  requirement: "requirements",
  constraint: "constraints",
  decision: "decisions",
  module: "modules",
  trait: "traits",
};

/**
 * Add a spec item as a child of a parent item.
 * @param parent The parent item to add under
 * @param child The new child item to add
 * @param childField Optional field name override (defaults based on child.type)
 */
export async function addChildItem(
  _ctx: KspecContext,
  parent: LoadedSpecItem,
  child: SpecItem,
  childField?: string,
): Promise<{ item: SpecItem; path: string }> {
  if (!parent._sourceFile) {
    throw new Error("Parent item has no source file");
  }

  const field = childField || TYPE_TO_CHILD_FIELD[child.type || "feature"] || "features";

  // Lock the file to prevent concurrent read-modify-write races
  return withFileLock(parent._sourceFile, async () => {
    // Load the raw YAML
    const raw = await readYamlFile<unknown>(parent._sourceFile!);

    // Find the parent in the structure
    let parentObj: Record<string, unknown>;
    let parentPath: string;

    if (parent._path) {
      const nav = navigateToPath(raw, parent._path);
      if (!nav) {
        throw new Error(`Could not navigate to parent path: ${parent._path}`);
      }
      parentObj = nav.array[nav.index] as Record<string, unknown>;
      parentPath = parent._path;
    } else {
      // Parent is the root item
      parentObj = raw as Record<string, unknown>;
      parentPath = "";
    }

    // Ensure the child field array exists
    if (!Array.isArray(parentObj[field])) {
      parentObj[field] = [];
    }

    // Add the child
    const childArray = parentObj[field] as unknown[];
    const cleanChild = stripSpecItemMetadata(child as LoadedSpecItem);
    childArray.push(cleanChild);

    // Calculate the new child's path
    const childIndex = childArray.length - 1;
    const childPath = parentPath
      ? `${parentPath}.${field}[${childIndex}]`
      : `${field}[${childIndex}]`;

    // Write back with format preservation
    await writeYamlFilePreserveFormat(parent._sourceFile!, raw);

    return { item: cleanChild, path: childPath };
  });
}

/**
 * Add a trait item to the project-level traits array in kynetic.yaml.
 */
export async function addProjectLevelTraitItem(
  ctx: KspecContext,
  item: SpecItem,
): Promise<{ item: SpecItem; path: string }> {
  if (!ctx.manifestPath) {
    throw new Error("Could not find kynetic.yaml");
  }

  return withFileLock(ctx.manifestPath, async () => {
    const manifest = await readYamlFile<Record<string, unknown>>(ctx.manifestPath!);

    if (!manifest) {
      throw new Error("Could not load kynetic.yaml");
    }

    if (!Array.isArray(manifest.traits)) {
      manifest.traits = [];
    }

    const cleanItem = stripSpecItemMetadata(item as LoadedSpecItem);
    (manifest.traits as unknown[]).push(cleanItem);

    await writeYamlFilePreserveFormat(ctx.manifestPath!, manifest);

    const traitIndex = (manifest.traits as unknown[]).length - 1;
    return {
      item: cleanItem,
      path: `traits[${traitIndex}]`,
    };
  });
}

/**
 * Update a spec item in place within its source file.
 * Works with nested structures using the _path field.
 */
export async function updateSpecItem(
  _ctx: KspecContext,
  item: LoadedSpecItem,
  updates: Partial<SpecItemInput>,
): Promise<SpecItem> {
  if (!item._sourceFile) {
    throw new Error("Item has no source file");
  }
  assertSpecItemPatch(updates, "updateSpecItem");

  // Validate known schema fields (e.g. acceptance_criteria[].id) before writing.
  // Uses passthrough mode so callers can include extension fields.
  const validationError = validateSpecItemPatchData(updates as Record<string, unknown>, {
    allowUnknown: true,
  });
  if (validationError) {
    throw new Error(`Invalid patch data: ${validationError}`);
  }

  // Lock the file to prevent concurrent read-modify-write races
  return withFileLock(item._sourceFile, async () => {
    // Load the raw YAML
    const raw = await readYamlFile<unknown>(item._sourceFile!);

    // Find the item in the structure (use stored path or search by ULID)
    let targetObj: Record<string, unknown>;

    if (item._path) {
      const nav = navigateToPath(raw, item._path);
      const candidate = nav?.array[nav.index];
      if (
        candidate &&
        typeof candidate === "object" &&
        (candidate as Record<string, unknown>)._ulid === item._ulid
      ) {
        targetObj = candidate as Record<string, unknown>;
      } else {
        const found = findItemInStructure(raw, item._ulid);
        if (!found) {
          throw new Error(`Could not find item ${item._ulid} in structure (path: ${item._path})`);
        }
        targetObj = found.item;
      }
    } else {
      // Item might be the root, or we need to find it
      const found = findItemInStructure(raw, item._ulid);
      if (found) {
        targetObj = found.item;
      } else if ((raw as Record<string, unknown>)._ulid === item._ulid) {
        targetObj = raw as Record<string, unknown>;
      } else {
        throw new Error(`Could not find item ${item._ulid} in structure`);
      }
    }

    // Apply updates (but never change _ulid)
    for (const [key, value] of Object.entries(updates)) {
      if (key !== "_ulid" && key !== "_sourceFile" && key !== "_path") {
        targetObj[key] = value;
      }
    }

    // Write back with format preservation
    await writeYamlFilePreserveFormat(item._sourceFile!, raw);

    return { ...item, ...updates, _ulid: item._ulid } as SpecItem;
  });
}

/**
 * Check if an item is a trait with implementors.
 * Returns array of items that use this trait via the 'traits' field.
 */
export function findTraitImplementors(
  trait: LoadedSpecItem,
  allItems: LoadedSpecItem[],
): LoadedSpecItem[] {
  // Check if the item is actually a trait
  if (trait.type !== "trait") {
    return [];
  }

  // Find all items that reference this trait in their 'traits' array
  const traitRefs = [`@${trait._ulid}`, ...trait.slugs.map((s) => `@${s}`)];
  return allItems.filter((item) => {
    if (!item.traits || item.traits.length === 0) return false;
    return item.traits.some((traitRef: string) => traitRefs.includes(traitRef));
  });
}

/**
 * Delete a spec item from its source file.
 * Works with nested structures using the _path field.
 */
export async function deleteSpecItem(_ctx: KspecContext, item: LoadedSpecItem): Promise<boolean> {
  if (!item._sourceFile) {
    return false;
  }

  // Lock the file to prevent concurrent read-modify-write races
  return withFileLock(item._sourceFile, async () => {
    try {
      const raw = await readYamlFile<unknown>(item._sourceFile!);

      // If item has a path, navigate to it and remove from parent array
      if (item._path) {
        const nav = navigateToPath(raw, item._path);
        if (!nav) {
          return false;
        }
        // Remove the item from the array
        nav.array.splice(nav.index, 1);
        await writeYamlFilePreserveFormat(item._sourceFile!, raw);
        return true;
      }

      // No path - try to find it by ULID
      const found = findItemInStructure(raw, item._ulid);
      if (found?.path) {
        const nav = navigateToPath(raw, found.path);
        if (nav) {
          nav.array.splice(nav.index, 1);
          await writeYamlFilePreserveFormat(item._sourceFile!, raw);
          return true;
        }
      }

      // Maybe it's a root-level array item
      if (Array.isArray(raw)) {
        const index = raw.findIndex(
          (i: unknown) =>
            typeof i === "object" &&
            i !== null &&
            (i as Record<string, unknown>)._ulid === item._ulid,
        );
        if (index >= 0) {
          raw.splice(index, 1);
          await writeYamlFilePreserveFormat(item._sourceFile!, raw);
          return true;
        }
      }

      return false;
    } catch {
      return false;
    }
  });
}

/**
 * Save a spec item - either updates existing or adds to parent.
 * For new items, use addChildItem instead.
 */
export async function saveSpecItem(
  ctx: KspecContext,
  item: LoadedSpecItem,
  updates: Partial<SpecItemInput>,
): Promise<void> {
  assertSpecItemPatch(updates, "saveSpecItem");

  if (Object.keys(updates).length === 0) {
    throw new Error("Cannot save spec item without updates. Pass a patch.");
  }

  // If item has a source file and path, it's an update
  if (item._sourceFile && item._path) {
    await updateSpecItem(ctx, item, updates);
    return;
  }

  // Otherwise, this is more complex - would need a parent
  throw new Error("Cannot save new item without parent. Use addChildItem instead.");
}

// ============================================================
// INBOX SYSTEM
// ============================================================

/**
 * Inbox item with runtime metadata for source tracking.
 */
export interface LoadedInboxItem extends InboxItem {
  _sourceFile?: string;
}

/**
 * Get the inbox file path.
 *
 * When shadow enabled: .kspec/project.inbox.yaml
 * Otherwise: spec/project.inbox.yaml
 */
export function getInboxFilePath(ctx: KspecContext): string {
  return path.join(ctx.specDir, "project.inbox.yaml");
}

/**
 * Parse inbox items from raw YAML payload.
 *
 * Supports canonical { inbox: [...] } shape and legacy plain-array shape.
 */
function parseInboxItemsFromRaw(raw: unknown, source = "project.inbox.yaml"): InboxItem[] {
  // Handle { inbox: [...] } format
  if (raw && typeof raw === "object" && "inbox" in raw) {
    const parsed = InboxFileSchema.safeParse(raw);
    if (parsed.success) {
      return parsed.data.inbox;
    }

    const fallbackItems = (raw as { inbox?: unknown }).inbox;
    if (Array.isArray(fallbackItems)) {
      const items: InboxItem[] = [];
      for (const item of fallbackItems) {
        const result = InboxItemSchema.safeParse(item);
        if (result.success) {
          items.push(result.data);
        } else {
          const rawItem = item as Record<string, unknown> | null;
          const itemId =
            rawItem && typeof rawItem._ulid === "string" ? rawItem._ulid : "<unknown-inbox-item>";
          warnSkippedRecord("inbox item", itemId, source, result.error);
        }
      }
      return items;
    }
  }

  // Handle plain array format
  if (Array.isArray(raw)) {
    const items: InboxItem[] = [];
    for (const item of raw) {
      const result = InboxItemSchema.safeParse(item);
      if (result.success) {
        items.push(result.data);
      } else {
        const rawItem = item as Record<string, unknown> | null;
        const itemId =
          rawItem && typeof rawItem._ulid === "string" ? rawItem._ulid : "<unknown-inbox-item>";
        warnSkippedRecord("inbox item", itemId, source, result.error);
      }
    }
    return items;
  }

  return [];
}

/**
 * Load inbox items from an explicit file path.
 */
async function loadInboxItemsFromFile(inboxPath: string): Promise<InboxItem[]> {
  const raw = await readYamlFile<unknown>(inboxPath);
  return parseInboxItemsFromRaw(raw, inboxPath);
}

/**
 * Load all inbox items from the project.
 */
export async function loadInboxItems(ctx: KspecContext): Promise<LoadedInboxItem[]> {
  const cacheContext = getEntityCacheContext();
  const resolvedCache = cacheContext?.cacheAccessor(cacheContext.projectPath) as
    | InitContextEntityCache
    | null
    | undefined;
  if (resolvedCache?.getDomainState?.("inbox") === "ready") {
    const cachedItems = resolvedCache.getInboxIndex?.();
    if (cachedItems) {
      return cachedItems;
    }
  }

  const inboxPath = getInboxFilePath(ctx);

  try {
    const items = await loadInboxItemsFromFile(inboxPath);
    return items.map((item) => ({
      ...item,
      _sourceFile: inboxPath,
    }));
  } catch {
    // File doesn't exist or parse error
    return [];
  }
}

/**
 * Create a new inbox item with auto-generated fields.
 *
 * AC: @config-author — supports config author in fallback chain
 *
 * @param input Inbox item input
 * @param configAuthor Optional author from kspec.config.yaml identity.author
 */
export function createInboxItem(input: InboxItemInput, configAuthor?: string | null): InboxItem {
  return {
    _ulid: input._ulid || ulid(),
    text: input.text,
    created_at: input.created_at || new Date().toISOString(),
    tags: input.tags || [],
    added_by: input.added_by ?? getAuthor(configAuthor),
  };
}

/**
 * Strip runtime metadata before serialization.
 */
function stripInboxMetadata(item: LoadedInboxItem | InboxItem): InboxItem {
  const { _sourceFile, ...cleanItem } = item as LoadedInboxItem;
  return cleanItem as InboxItem;
}

/**
 * Extract the raw inbox array and wrapper metadata from a YAML file.
 * Does NOT run schema validation — preserves original data for round-trip stability.
 */
async function extractRawInboxArray(
  filePath: string,
): Promise<{ rawItems: unknown[]; wrapperObj?: Record<string, unknown> }> {
  let existingRaw: unknown = null;

  try {
    existingRaw = await readYamlFile<unknown>(filePath);
  } catch {
    // File doesn't exist
    return { rawItems: [] };
  }

  if (!existingRaw || typeof existingRaw !== "object") {
    return { rawItems: [] };
  }

  const wrapper = existingRaw as Record<string, unknown>;
  const inbox = wrapper.inbox;

  // Handle { inbox: [...] } format
  if (Array.isArray(inbox)) {
    return { rawItems: inbox, wrapperObj: wrapper };
  }

  // Handle plain array format (legacy)
  if (Array.isArray(existingRaw)) {
    return { rawItems: existingRaw };
  }

  return { rawItems: [] };
}

/**
 * Write raw inbox array back to file, preserving wrapper metadata.
 */
async function writeRawInboxArray(
  filePath: string,
  rawItems: unknown[],
  wrapperObj?: Record<string, unknown>,
): Promise<void> {
  const output = wrapperObj ? { ...wrapperObj, inbox: rawItems } : { inbox: rawItems };
  await writeYamlFilePreserveFormat(filePath, output);
}

/**
 * Find inbox item index in a raw array by ULID match.
 */
function findRawInboxIndex(rawItems: unknown[], ulid: string): number {
  return rawItems.findIndex(
    (i) => i && typeof i === "object" && (i as Record<string, unknown>)._ulid === ulid,
  );
}

/**
 * Merge a schema-normalized inbox item onto the original raw item data.
 * Only adds fields that were in the original raw data or that contain
 * non-default values. This prevents Zod defaults from polluting YAML
 * output with fields that weren't originally present.
 */
function mergeInboxPreservingRawShape(
  rawItem: Record<string, unknown>,
  normalizedItem: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(normalizedItem)) {
    if (key in rawItem) {
      // Field existed in raw — always include (even if value changed)
      result[key] = value;
    } else {
      // Field was added by schema normalization — only include if non-trivial
      const isEmptyArray = Array.isArray(value) && value.length === 0;
      const isNull = value === null || value === undefined;
      if (!isEmptyArray && !isNull) {
        result[key] = value;
      }
    }
  }

  return result;
}

/**
 * Save an inbox item (add or update).
 */
export async function saveInboxItem(ctx: KspecContext, item: LoadedInboxItem): Promise<void> {
  const inboxPath = getInboxFilePath(ctx);

  // Lock the file to prevent concurrent read-modify-write races
  await withFileLock(inboxPath, async () => {
    // Ensure directory exists
    const dir = path.dirname(inboxPath);
    await fs.mkdir(dir, { recursive: true });

    // Load raw inbox data without schema normalization
    const { rawItems, wrapperObj } = await extractRawInboxArray(inboxPath);

    const cleanItem = stripInboxMetadata(item);

    // Update existing or add new — replace only the target item
    const existingIndex = findRawInboxIndex(rawItems, item._ulid);
    if (existingIndex >= 0) {
      // Merge onto raw data to avoid adding Zod defaults for absent fields
      const rawTarget = rawItems[existingIndex] as Record<string, unknown>;
      rawItems[existingIndex] = mergeInboxPreservingRawShape(
        rawTarget,
        cleanItem as Record<string, unknown>,
      );
    } else {
      rawItems.push(cleanItem);
    }

    await writeRawInboxArray(inboxPath, rawItems, wrapperObj);
  });
}

/**
 * Atomically mutate an inbox item using the latest on-disk state.
 *
 * The callback receives the current item value while holding the inbox file lock,
 * so concurrent writers do not clobber unrelated fields (for example text vs tags).
 */
export async function mutateInboxItemAtomically(
  ctx: KspecContext,
  item: LoadedInboxItem,
  mutate: (
    latestItem: LoadedInboxItem,
  ) => InboxItem | LoadedInboxItem | Promise<InboxItem | LoadedInboxItem>,
): Promise<LoadedInboxItem> {
  const inboxPath = item._sourceFile || getInboxFilePath(ctx);
  let updatedItem: LoadedInboxItem | undefined;

  await withFileLock(inboxPath, async () => {
    // Ensure directory exists (important for default path in new repos)
    const dir = path.dirname(inboxPath);
    await fs.mkdir(dir, { recursive: true });

    // Load raw inbox data without schema normalization for non-target items
    const { rawItems, wrapperObj } = await extractRawInboxArray(inboxPath);

    if (rawItems.length === 0) {
      throw new Error(`Inbox file not found: ${inboxPath}`);
    }

    const itemIndex = findRawInboxIndex(rawItems, item._ulid);
    if (itemIndex === -1) {
      throw new Error(`Inbox item not found in file: ${item._ulid}`);
    }

    // Schema-parse only the target item for the mutation callback
    const rawTarget = rawItems[itemIndex];
    const parsed = InboxItemSchema.safeParse(rawTarget);
    if (!parsed.success) {
      throw new Error(`Invalid inbox item data for ${item._ulid}: ${parsed.error.message}`);
    }
    const latestItem: LoadedInboxItem = {
      ...parsed.data,
      _sourceFile: inboxPath,
    };

    const mutatedItem = await mutate(latestItem);
    const cleanMutatedItem = stripInboxMetadata(mutatedItem);

    // Merge onto raw data to avoid adding Zod defaults for absent fields
    rawItems[itemIndex] = mergeInboxPreservingRawShape(
      rawTarget as Record<string, unknown>,
      cleanMutatedItem as Record<string, unknown>,
    );

    await writeRawInboxArray(inboxPath, rawItems, wrapperObj);

    updatedItem = {
      ...cleanMutatedItem,
      _sourceFile: inboxPath,
    };
  });

  if (!updatedItem) {
    throw new Error(`Failed to mutate inbox item atomically: ${item._ulid}`);
  }

  return updatedItem;
}

/**
 * Delete an inbox item by ULID.
 */
export async function deleteInboxItem(ctx: KspecContext, ulid: string): Promise<boolean> {
  const inboxPath = getInboxFilePath(ctx);

  // Lock the file to prevent concurrent read-modify-write races
  return withFileLock(inboxPath, async () => {
    try {
      // Load raw inbox data without schema normalization for round-trip stability
      const { rawItems, wrapperObj } = await extractRawInboxArray(inboxPath);

      const index = findRawInboxIndex(rawItems, ulid);
      if (index < 0) {
        return false;
      }

      rawItems.splice(index, 1);
      await writeRawInboxArray(inboxPath, rawItems, wrapperObj);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Find an inbox item by reference (ULID or short ULID).
 */
export function findInboxItemByRef(
  items: LoadedInboxItem[],
  ref: string,
): LoadedInboxItem | undefined {
  const cleanRef = ref.startsWith("@") ? ref.slice(1) : ref;

  return items.find((item) => {
    // Match full ULID
    if (item._ulid === cleanRef) return true;
    // Match short ULID (prefix)
    if (item._ulid.toLowerCase().startsWith(cleanRef.toLowerCase())) return true;
    return false;
  });
}

// ============================================================
// TRIAGE SYSTEM
// ============================================================

/**
 * Triage record with runtime metadata for source tracking.
 */
export interface LoadedTriageRecord extends TriageRecord {
  _sourceFile?: string;
}

/**
 * Get the triage file path.
 * AC: @triage-record-schema ac-6
 *
 * When shadow enabled: .kspec/project.triage.yaml
 * Otherwise: spec/project.triage.yaml
 */
export function getTriageFilePath(ctx: KspecContext): string {
  return path.join(ctx.specDir, "project.triage.yaml");
}

/**
 * Extract the raw triage array and wrapper metadata from a YAML file.
 * Does NOT run schema validation — preserves original data for round-trip stability.
 */
async function extractRawTriageArray(
  filePath: string,
): Promise<{ rawRecords: unknown[]; wrapperObj?: Record<string, unknown> }> {
  let existingRaw: unknown = null;

  try {
    existingRaw = await readYamlFile<unknown>(filePath);
  } catch {
    // File doesn't exist
    return { rawRecords: [] };
  }

  if (!existingRaw || typeof existingRaw !== "object") {
    return { rawRecords: [] };
  }

  const wrapper = existingRaw as Record<string, unknown>;
  const triage = wrapper.triage;

  // Handle { kynetic_triage: "1.0", triage: [...] } format
  if (Array.isArray(triage)) {
    return { rawRecords: triage, wrapperObj: wrapper };
  }

  // Handle plain array format (legacy)
  if (Array.isArray(existingRaw)) {
    return { rawRecords: existingRaw };
  }

  return { rawRecords: [] };
}

/**
 * Write raw triage array back to file, preserving wrapper metadata.
 */
async function writeRawTriageArray(
  filePath: string,
  rawRecords: unknown[],
  wrapperObj?: Record<string, unknown>,
): Promise<void> {
  const output = wrapperObj
    ? { ...wrapperObj, triage: rawRecords }
    : { kynetic_triage: "1.0", triage: rawRecords };
  await writeYamlFilePreserveFormat(filePath, output);
}

/**
 * Find triage record index in a raw array by ULID match.
 */
function findRawTriageIndex(rawRecords: unknown[], ulid: string): number {
  return rawRecords.findIndex(
    (r) => r && typeof r === "object" && (r as Record<string, unknown>)._ulid === ulid,
  );
}

/**
 * Find triage record index in a raw array by inbox_ref match.
 */
function findRawTriageIndexByInboxRef(rawRecords: unknown[], inboxRef: string): number {
  return rawRecords.findIndex(
    (r) => r && typeof r === "object" && (r as Record<string, unknown>).inbox_ref === inboxRef,
  );
}

/**
 * Merge a schema-normalized triage record onto the original raw record data.
 * Only adds fields that were in the original raw data or that contain
 * non-default values. This prevents Zod defaults from polluting YAML
 * output with fields that weren't originally present.
 */
function mergeTriagePreservingRawShape(
  rawRecord: Record<string, unknown>,
  normalizedRecord: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(normalizedRecord)) {
    if (key in rawRecord) {
      // Field existed in raw — always include (even if value changed)
      result[key] = value;
    } else {
      // Field was added by schema normalization — only include if non-trivial
      const isEmptyArray = Array.isArray(value) && value.length === 0;
      const isNull = value === null || value === undefined;
      if (!isEmptyArray && !isNull) {
        result[key] = value;
      }
    }
  }

  return result;
}

/**
 * Load all triage records from the project.
 * AC: @triage-record-schema ac-6, ac-7
 */
export async function loadTriageRecords(ctx: KspecContext): Promise<LoadedTriageRecord[]> {
  const cacheContext = getEntityCacheContext();
  const resolvedCache = cacheContext?.cacheAccessor(cacheContext.projectPath) as
    | InitContextEntityCache
    | null
    | undefined;
  if (resolvedCache) {
    const cachedRecords = tryGetCachedTriageRecords(ctx, resolvedCache);
    if (cachedRecords) {
      return cachedRecords;
    }
  }

  const triagePath = getTriageFilePath(ctx);

  try {
    const raw = await readYamlFile<unknown>(triagePath);

    // Handle { kynetic_triage: "1.0", triage: [...] } format
    if (raw && typeof raw === "object" && "triage" in raw) {
      const parsed = TriageFileSchema.safeParse(raw);
      if (parsed.success) {
        return parsed.data.triage.map((record) => ({
          ...record,
          _sourceFile: triagePath,
        }));
      }

      const fallbackRecords = (raw as { triage?: unknown }).triage;
      if (Array.isArray(fallbackRecords)) {
        const records: LoadedTriageRecord[] = [];
        for (const item of fallbackRecords) {
          const result = TriageRecordSchema.safeParse(item);
          if (result.success) {
            records.push({ ...result.data, _sourceFile: triagePath });
          } else {
            const rawRecord = item as Record<string, unknown> | null;
            const recordId =
              rawRecord && typeof rawRecord._ulid === "string"
                ? rawRecord._ulid
                : "<unknown-triage-record>";
            warnSkippedRecord("triage record", recordId, triagePath, result.error);
          }
        }
        return records;
      }
    }

    // Handle plain array format
    if (Array.isArray(raw)) {
      const records: LoadedTriageRecord[] = [];
      for (const item of raw) {
        const result = TriageRecordSchema.safeParse(item);
        if (result.success) {
          records.push({ ...result.data, _sourceFile: triagePath });
        } else {
          const rawRecord = item as Record<string, unknown> | null;
          const recordId =
            rawRecord && typeof rawRecord._ulid === "string"
              ? rawRecord._ulid
              : "<unknown-triage-record>";
          warnSkippedRecord("triage record", recordId, triagePath, result.error);
        }
      }
      return records;
    }

    return [];
  } catch {
    // File doesn't exist or parse error
    return [];
  }
}

/**
 * Strip runtime metadata before serialization.
 */
function stripTriageMetadata(record: LoadedTriageRecord): TriageRecord {
  const { _sourceFile, ...cleanRecord } = record;
  return cleanRecord as TriageRecord;
}

/**
 * Save a triage record (add or update).
 * AC: @triage-record-schema ac-8 — upsert on inbox_ref (one record per inbox item)
 * AC: @triage-record-schema ac-9 — sets updated_at on every mutation
 * AC: @yaml-serialization-invariants ac-3 — round-trip stability via raw-data-preservation
 */
export async function saveTriageRecord(
  ctx: KspecContext,
  record: LoadedTriageRecord,
): Promise<void> {
  const triagePath = getTriageFilePath(ctx);

  // Lock the file to prevent concurrent read-modify-write races
  await withFileLock(triagePath, async () => {
    // Ensure directory exists
    const dir = path.dirname(triagePath);
    await fs.mkdir(dir, { recursive: true });

    // Load raw triage data without schema normalization
    const { rawRecords, wrapperObj } = await extractRawTriageArray(triagePath);

    const cleanRecord = stripTriageMetadata(record);

    // AC: ac-9 — set updated_at on every mutation
    cleanRecord.updated_at = new Date().toISOString();

    // AC: ac-8 — upsert: check for existing record by ULID first, then by inbox_ref
    const existingByUlid = findRawTriageIndex(rawRecords, record._ulid);
    if (existingByUlid >= 0) {
      // Merge onto raw data to avoid adding Zod defaults for absent fields
      const rawTarget = rawRecords[existingByUlid] as Record<string, unknown>;
      rawRecords[existingByUlid] = mergeTriagePreservingRawShape(
        rawTarget,
        cleanRecord as unknown as Record<string, unknown>,
      );
    } else {
      // Check for existing record with same inbox_ref (uniqueness constraint)
      // Preserve existing identity (_ulid, created_at) when upserting by inbox_ref
      const existingByInboxRef = findRawTriageIndexByInboxRef(rawRecords, record.inbox_ref);
      if (existingByInboxRef >= 0) {
        const rawExisting = rawRecords[existingByInboxRef] as Record<string, unknown>;
        const mergedRecord = {
          ...cleanRecord,
          _ulid: rawExisting._ulid as string,
          created_at: rawExisting.created_at as string,
        };
        rawRecords[existingByInboxRef] = mergeTriagePreservingRawShape(
          rawExisting,
          mergedRecord as unknown as Record<string, unknown>,
        );
      } else {
        rawRecords.push(cleanRecord);
      }
    }

    await writeRawTriageArray(triagePath, rawRecords, wrapperObj);
  });
}

/**
 * Find a triage record by reference (ULID or short ULID).
 */
export function findTriageRecordByRef(
  records: LoadedTriageRecord[],
  ref: string,
): LoadedTriageRecord | undefined {
  const cleanRef = ref.startsWith("@") ? ref.slice(1) : ref;

  return records.find((record) => {
    // Match full ULID
    if (record._ulid === cleanRef) return true;
    // Match short ULID (prefix)
    if (record._ulid.toLowerCase().startsWith(cleanRef.toLowerCase())) return true;
    return false;
  });
}

/**
 * Find a triage record by inbox item reference.
 * AC: @triage-record-schema ac-8 — lookup by inbox_ref for upsert
 */
export function findTriageRecordByInboxRef(
  records: LoadedTriageRecord[],
  inboxRef: string,
): LoadedTriageRecord | undefined {
  const cleanRef = inboxRef.startsWith("@") ? inboxRef.slice(1) : inboxRef;

  return records.find((record) => record.inbox_ref === cleanRef);
}

// ─── Patch Operations ────────────────────────────────────────────────────────

/**
 * A single patch operation for bulk patching
 */
export interface PatchOperation {
  ref: string;
  data: Record<string, unknown>;
}

/**
 * Result of a single patch operation
 */
export interface PatchResult {
  ref: string;
  status: "updated" | "skipped" | "error";
  ulid?: string;
  error?: string;
}

/**
 * Result of a bulk patch operation
 */
export interface BulkPatchResult {
  results: PatchResult[];
  summary: {
    total: number;
    updated: number;
    failed: number;
    skipped: number;
  };
}

/**
 * Options for patch operations
 */
export interface PatchOptions {
  allowUnknown?: boolean;
  dryRun?: boolean;
  failFast?: boolean;
}

/**
 * Bulk patch spec items.
 * Resolves refs, validates data, applies patches.
 * Continues on error by default (use failFast to stop on first error).
 */
export async function patchSpecItems(
  ctx: KspecContext,
  refIndex: ReferenceIndex,
  items: LoadedSpecItem[],
  patches: PatchOperation[],
  options: PatchOptions = {},
): Promise<BulkPatchResult> {
  const results: PatchResult[] = [];
  let stopProcessing = false;

  for (const patch of patches) {
    if (stopProcessing) {
      results.push({ ref: patch.ref, status: "skipped" });
      continue;
    }

    // Resolve ref
    const resolved = refIndex.resolve(patch.ref);
    if (!resolved.ok) {
      const errorMsg =
        resolved.error === "not_found"
          ? `Item not found: ${patch.ref}`
          : resolved.error === "ambiguous"
            ? `Ambiguous ref: ${patch.ref}`
            : `Duplicate slug: ${patch.ref}`;
      results.push({ ref: patch.ref, status: "error", error: errorMsg });
      if (options.failFast) {
        stopProcessing = true;
      }
      continue;
    }

    // Find the item
    const item = items.find((i) => i._ulid === resolved.ulid);
    if (!item) {
      // Ref resolved but it's not a spec item (might be a task)
      results.push({
        ref: patch.ref,
        status: "error",
        error: "Not a spec item",
      });
      if (options.failFast) {
        stopProcessing = true;
      }
      continue;
    }

    // Validate patch data against schema before dry-run or real write
    const patchValidationError = validateSpecItemPatchData(patch.data, {
      allowUnknown: options.allowUnknown,
    });
    if (patchValidationError) {
      results.push({
        ref: patch.ref,
        status: "error",
        error: `Invalid patch data: ${patchValidationError}`,
      });
      if (options.failFast) {
        stopProcessing = true;
      }
      continue;
    }

    // Dry run - just record what would happen
    if (options.dryRun) {
      results.push({ ref: patch.ref, status: "updated", ulid: item._ulid });
      continue;
    }

    // Apply the patch
    try {
      await updateSpecItem(ctx, item, patch.data);
      results.push({ ref: patch.ref, status: "updated", ulid: item._ulid });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      results.push({ ref: patch.ref, status: "error", error: errorMsg });
      if (options.failFast) {
        stopProcessing = true;
      }
    }
  }

  return {
    results,
    summary: {
      total: patches.length,
      updated: results.filter((r) => r.status === "updated").length,
      failed: results.filter((r) => r.status === "error").length,
      skipped: results.filter((r) => r.status === "skipped").length,
    },
  };
}
