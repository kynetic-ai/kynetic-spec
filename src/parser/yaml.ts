import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import * as YAML from 'yaml';
import { ulid } from 'ulid';
import { z } from 'zod';
import {
  TaskSchema,
  TasksFileSchema,
  TaskInputSchema,
  ManifestSchema,
  SpecItemSchema,
  InboxItemSchema,
  InboxFileSchema,
  type Task,
  type TasksFile,
  type TaskInput,
  type Manifest,
  type SpecItem,
  type SpecItemInput,
  type Note,
  type Todo,
  type InboxItem,
  type InboxItemInput,
} from '../schema/index.js';
import { ReferenceIndex } from './refs.js';
import { ItemIndex } from './items.js';
import { TraitIndex } from './traits.js';
import {
  type ShadowConfig,
  detectShadow,
  detectRunningFromShadowWorktree,
  shadowAutoCommit,
  generateCommitMessage,
  SHADOW_WORKTREE_DIR,
  ShadowError,
} from './shadow.js';
import { errors } from '../strings/index.js';

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
export function toYaml(obj: unknown): string {
  let yamlString = YAML.stringify(obj, {
    indent: 2,
    lineWidth: 100,
    sortMapEntries: false,
  });

  // Post-process to fix yaml library blank line accumulation bug.
  // Filter out lines that contain only spaces/tabs (not truly empty lines).
  yamlString = yamlString
    .split('\n')
    .filter(line => !/^[ \t]+$/.test(line))
    .join('\n');

  return yamlString;
}

/**
 * Read and parse a YAML file
 */
export async function readYamlFile<T>(filePath: string): Promise<T> {
  const content = await fs.readFile(filePath, 'utf-8');
  return parseYaml<T>(content);
}

/**
 * Write object to YAML file
 */
export async function writeYamlFile(filePath: string, data: unknown): Promise<void> {
  const content = toYaml(data);
  await fs.writeFile(filePath, content, 'utf-8');
}

/**
 * Write object to YAML file while preserving formatting and comments.
 *
 * Note: This function is now equivalent to writeYamlFile() - the "preserve format"
 * naming is historical. Both use toYaml() which includes the whitespace-only line
 * fix. Kept for backwards compatibility with existing callers.
 */
export async function writeYamlFilePreserveFormat(
  filePath: string,
  data: unknown
): Promise<void> {
  const content = toYaml(data);
  await fs.writeFile(filePath, content, 'utf-8');
}

/**
 * Find task files in a directory
 */
export async function findTaskFiles(dir: string): Promise<string[]> {
  const files: string[] = [];

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // Recurse into subdirectories
        const subFiles = await findTaskFiles(fullPath);
        files.push(...subFiles);
      } else if (entry.isFile() && entry.name.endsWith('.tasks.yaml')) {
        files.push(fullPath);
      }
    }
  } catch (error) {
    // Directory doesn't exist or not readable
  }

  return files;
}

/**
 * Find the manifest file (kynetic.yaml or kynetic.spec.yaml)
 */
export async function findManifest(startDir: string): Promise<string | null> {
  let dir = startDir;

  while (true) {
    const candidates = ['kynetic.yaml', 'kynetic.spec.yaml'];

    for (const candidate of candidates) {
      const filePath = path.join(dir, candidate);
      try {
        await fs.access(filePath);
        return filePath;
      } catch {
        // File doesn't exist, try next
      }
    }

    // Also check in spec/ subdirectory
    const specDir = path.join(dir, 'spec');
    for (const candidate of candidates) {
      const filePath = path.join(specDir, candidate);
      try {
        await fs.access(filePath);
        return filePath;
      } catch {
        // File doesn't exist, try next
      }
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
 * - rootDir points to the project root (where .kspec/ lives)
 * - specDir points to .kspec/ (where spec files are read/written)
 * - All file operations use specDir for resolution
 *
 * Without shadow branch:
 * - rootDir is the project root
 * - specDir is rootDir/spec/ (traditional layout)
 */
export interface KspecContext {
  /** Project root directory */
  rootDir: string;
  /** Spec files directory (.kspec/ when shadow enabled, otherwise spec/) */
  specDir: string;
  /** Path to manifest file */
  manifestPath: string | null;
  /** Parsed manifest */
  manifest: Manifest | null;
  /** Shadow branch configuration (null if not using shadow) */
  shadow: ShadowConfig | null;
}

/**
 * Initialize context by finding manifest.
 *
 * Detection order:
 * 1. Check for shadow branch (.kspec/ directory)
 * 2. Fall back to traditional spec/ directory
 *
 * When shadow is detected, all operations use .kspec/ as specDir.
 */
export async function initContext(startDir?: string): Promise<KspecContext> {
  const cwd = startDir || process.cwd();

  // Check if running from inside the shadow worktree
  const mainProjectRoot = await detectRunningFromShadowWorktree(cwd);
  if (mainProjectRoot) {
    throw new ShadowError(
      errors.project.runningFromShadow,
      'RUNNING_FROM_SHADOW',
      `Run from project root: cd ${path.relative(cwd, mainProjectRoot) || mainProjectRoot}`
    );
  }

  // Try to detect shadow branch first
  const shadow = await detectShadow(cwd);

  if (shadow?.enabled) {
    // Shadow mode: use .kspec/ for everything
    const specDir = shadow.worktreeDir;
    const manifestPath = await findManifestInDir(specDir);

    let manifest: Manifest | null = null;
    if (manifestPath) {
      try {
        const rawManifest = await readYamlFile<unknown>(manifestPath);
        manifest = ManifestSchema.parse(rawManifest);
      } catch {
        // Manifest exists but may be invalid
      }
    }

    return {
      rootDir: shadow.projectRoot,
      specDir,
      manifestPath,
      manifest,
      shadow,
    };
  }

  // Traditional mode: find manifest in spec/ or current directory
  const manifestPath = await findManifest(cwd);

  let manifest: Manifest | null = null;
  let rootDir = cwd;
  let specDir = cwd;

  if (manifestPath) {
    const manifestDir = path.dirname(manifestPath);
    // Handle spec/ subdirectory
    if (path.basename(manifestDir) === 'spec') {
      rootDir = path.dirname(manifestDir);
      specDir = manifestDir;
    } else {
      rootDir = manifestDir;
      specDir = manifestDir;
    }

    try {
      const rawManifest = await readYamlFile<unknown>(manifestPath);
      manifest = ManifestSchema.parse(rawManifest);
    } catch {
      // Manifest exists but may be invalid
    }
  }

  return { rootDir, specDir, manifestPath, manifest, shadow: null };
}

/**
 * Find manifest file within a specific directory (no parent traversal).
 * Used for shadow mode where we know exactly where to look.
 */
async function findManifestInDir(dir: string): Promise<string | null> {
  const candidates = ['kynetic.yaml', 'kynetic.spec.yaml'];

  for (const candidate of candidates) {
    const filePath = path.join(dir, candidate);
    try {
      await fs.access(filePath);
      return filePath;
    } catch {
      // File doesn't exist, try next
    }
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
    } else if (raw && typeof raw === 'object' && 'tasks' in raw) {
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

  // When shadow is enabled, look only in specDir
  if (ctx.shadow?.enabled) {
    const taskFiles = await findTaskFiles(ctx.specDir);

    // Also check for standalone files in specDir
    const standaloneLocations = [
      path.join(ctx.specDir, 'tasks.yaml'),
      path.join(ctx.specDir, 'project.tasks.yaml'),
      path.join(ctx.specDir, 'kynetic.tasks.yaml'),
      path.join(ctx.specDir, 'backlog.tasks.yaml'),
      path.join(ctx.specDir, 'active.tasks.yaml'),
    ];

    for (const loc of standaloneLocations) {
      try {
        await fs.access(loc);
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
  const additionalPaths = [
    path.join(ctx.rootDir, 'tasks'),
    path.join(ctx.rootDir, 'spec'),
  ];

  for (const additionalPath of additionalPaths) {
    const files = await findTaskFiles(additionalPath);
    taskFiles.push(...files);
  }

  // Also look for standalone tasks.yaml and project.tasks.yaml
  const standaloneLocations = [
    path.join(ctx.rootDir, 'tasks.yaml'),
    path.join(ctx.rootDir, 'project.tasks.yaml'),
    path.join(ctx.rootDir, 'spec', 'project.tasks.yaml'),
    path.join(ctx.rootDir, 'backlog.tasks.yaml'),
    path.join(ctx.rootDir, 'active.tasks.yaml'),
  ];

  for (const loc of standaloneLocations) {
    try {
      await fs.access(loc);
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
  const cleanRef = ref.startsWith('@') ? ref.slice(1) : ref;

  return tasks.find(task => {
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
  return path.join(ctx.specDir, 'project.tasks.yaml');
}

/**
 * Strip runtime metadata before serialization
 */
function stripRuntimeMetadata(task: LoadedTask): Task {
  const { _sourceFile, ...cleanTask } = task;
  return cleanTask as Task;
}

/**
 * Save a task to its source file (or default location for new tasks).
 * Preserves file format (tasks: [...] wrapper vs plain array).
 */
export async function saveTask(ctx: KspecContext, task: LoadedTask): Promise<void> {
  // Determine target file: use _sourceFile if present, otherwise default
  const taskFilePath = task._sourceFile || getDefaultTaskFilePath(ctx);

  // Ensure directory exists
  const dir = path.dirname(taskFilePath);
  await fs.mkdir(dir, { recursive: true });

  // Load existing tasks from the target file
  let existingRaw: unknown = null;
  let useTasksWrapper = false;

  try {
    existingRaw = await readYamlFile<unknown>(taskFilePath);
    // Detect if file uses { tasks: [...] } format
    if (existingRaw && typeof existingRaw === 'object' && 'tasks' in existingRaw) {
      useTasksWrapper = true;
    }
  } catch {
    // File doesn't exist, start fresh
  }

  // Parse existing tasks from file
  let fileTasks: Task[] = [];

  if (existingRaw) {
    if (Array.isArray(existingRaw)) {
      for (const t of existingRaw) {
        const result = TaskSchema.safeParse(t);
        if (result.success) {
          fileTasks.push(result.data);
        }
      }
    } else if (useTasksWrapper) {
      // Try TasksFileSchema first (has kynetic_tasks version)
      const parsed = TasksFileSchema.safeParse(existingRaw);
      if (parsed.success) {
        fileTasks = parsed.data.tasks;
      } else {
        // Fall back to raw tasks array (common format without version field)
        const rawTasks = (existingRaw as { tasks: unknown[] }).tasks;
        if (Array.isArray(rawTasks)) {
          for (const t of rawTasks) {
            const result = TaskSchema.safeParse(t);
            if (result.success) {
              fileTasks.push(result.data);
            }
          }
        }
      }
    }
  }

  // Strip runtime metadata before saving
  const cleanTask = stripRuntimeMetadata(task);

  // Update existing or add new
  const existingIndex = fileTasks.findIndex(t => t._ulid === task._ulid);
  if (existingIndex >= 0) {
    fileTasks[existingIndex] = cleanTask;
  } else {
    fileTasks.push(cleanTask);
  }

  // Save in the same format as original (or tasks: wrapper for new files)
  // Use format-preserving write to maintain formatting and comments
  if (useTasksWrapper) {
    await writeYamlFilePreserveFormat(taskFilePath, { tasks: fileTasks });
  } else {
    await writeYamlFilePreserveFormat(taskFilePath, fileTasks);
  }
}

/**
 * Delete a task from its source file.
 * Requires _sourceFile to know which file to modify.
 */
export async function deleteTask(ctx: KspecContext, task: LoadedTask): Promise<void> {
  if (!task._sourceFile) {
    throw new Error('Cannot delete task without _sourceFile metadata');
  }

  const taskFilePath = task._sourceFile;

  // Load existing file
  let existingRaw: unknown = null;
  let useTasksWrapper = false;

  try {
    existingRaw = await readYamlFile<unknown>(taskFilePath);
    if (existingRaw && typeof existingRaw === 'object' && 'tasks' in existingRaw) {
      useTasksWrapper = true;
    }
  } catch {
    throw new Error(`Task file not found: ${taskFilePath}`);
  }

  // Parse existing tasks
  let fileTasks: Task[] = [];

  if (existingRaw) {
    if (Array.isArray(existingRaw)) {
      for (const t of existingRaw) {
        const result = TaskSchema.safeParse(t);
        if (result.success) {
          fileTasks.push(result.data);
        }
      }
    } else if (useTasksWrapper) {
      const parsed = TasksFileSchema.safeParse(existingRaw);
      if (parsed.success) {
        fileTasks = parsed.data.tasks;
      } else {
        const rawTasks = (existingRaw as { tasks: unknown[] }).tasks;
        if (Array.isArray(rawTasks)) {
          for (const t of rawTasks) {
            const result = TaskSchema.safeParse(t);
            if (result.success) {
              fileTasks.push(result.data);
            }
          }
        }
      }
    }
  }

  // Remove the task
  const originalCount = fileTasks.length;
  fileTasks = fileTasks.filter(t => t._ulid !== task._ulid);

  if (fileTasks.length === originalCount) {
    throw new Error(`Task not found in file: ${task._ulid}`);
  }

  // Save the modified file with format preservation
  if (useTasksWrapper) {
    await writeYamlFilePreserveFormat(taskFilePath, { tasks: fileTasks });
  } else {
    await writeYamlFilePreserveFormat(taskFilePath, fileTasks);
  }
}

/**
 * Create a new task with auto-generated fields
 */
export function createTask(input: TaskInput): Task {
  const now = new Date().toISOString();

  return {
    ...input,
    _ulid: input._ulid || ulid(),
    slugs: input.slugs || [],
    type: input.type || 'task',
    status: input.status || 'pending',
    blocked_by: input.blocked_by || [],
    depends_on: input.depends_on || [],
    context: input.context || [],
    priority: input.priority || 3,
    tags: input.tags || [],
    vcs_refs: input.vcs_refs || [],
    created_at: input.created_at || now,
    notes: input.notes || [],
    todos: input.todos || [],
  };
}

/**
 * Get author from environment with fallback chain.
 * Priority:
 *   1. KSPEC_AUTHOR env var (explicit config, agent-agnostic)
 *   2. git user.name (developer identity)
 *   3. USER/USERNAME env var (system user)
 *   4. undefined (will show as 'unknown' in output)
 *
 * For Claude Code integration, add to ~/.claude/settings.json:
 *   { "env": { "KSPEC_AUTHOR": "@claude" } }
 */
export function getAuthor(): string | undefined {
  // 1. Explicit config (works for any agent)
  if (process.env.KSPEC_AUTHOR) {
    return process.env.KSPEC_AUTHOR;
  }

  // 2. Git user.name
  try {
    const gitUser = execSync('git config user.name', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    if (gitUser) {
      return gitUser;
    }
  } catch {
    // git not available or not in a repo
  }

  // 3. System user
  const systemUser = process.env.USER || process.env.USERNAME;
  if (systemUser) {
    return systemUser;
  }

  // 4. No author available
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
    if (!depTask || depTask.status !== 'completed') {
      return false;
    }
  }

  return true;
}

/**
 * Check if task is ready (pending + deps met + not blocked)
 */
export function isTaskReady(task: LoadedTask, allTasks: LoadedTask[]): boolean {
  if (task.status !== 'pending') return false;
  if (task.blocked_by.length > 0) return false;
  return areDependenciesMet(task, allTasks);
}

/**
 * Get ready tasks (pending + deps met + not blocked), sorted by priority then creation time.
 * Within the same priority tier, older tasks come first (FIFO).
 */
export function getReadyTasks(tasks: LoadedTask[]): LoadedTask[] {
  return tasks
    .filter(task => isTaskReady(task, tasks))
    .sort((a, b) => {
      // Primary: priority (lower number = higher priority)
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }
      // Secondary: creation time (older first - FIFO within priority)
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
export async function expandIncludePattern(
  pattern: string,
  baseDir: string
): Promise<string[]> {
  const fullPattern = path.isAbsolute(pattern) ? pattern : path.join(baseDir, pattern);

  // If no glob characters, just return the path if it exists
  if (!pattern.includes('*')) {
    try {
      await fs.access(fullPattern);
      return [fullPattern];
    } catch {
      return [];
    }
  }

  // Split pattern into directory part and file pattern
  const parts = pattern.split('/');
  let currentDir = baseDir;
  const result: string[] = [];

  // Find the first part with a glob
  let globIndex = parts.findIndex(p => p.includes('*'));

  // Navigate to the directory before the glob
  if (globIndex > 0) {
    currentDir = path.join(baseDir, ...parts.slice(0, globIndex));
  }

  // Get the remaining pattern
  const remainingPattern = parts.slice(globIndex).join('/');

  await expandGlobRecursive(currentDir, remainingPattern, result);
  return result;
}

/**
 * Recursively expand glob patterns
 */
async function expandGlobRecursive(
  dir: string,
  pattern: string,
  result: string[]
): Promise<void> {
  const parts = pattern.split('/');
  const currentPattern = parts[0];
  const remainingPattern = parts.slice(1).join('/');

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });

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
          if (currentPattern === '**') {
            // ** matches any depth - need special handling
            if (entry.isDirectory()) {
              await expandGlobRecursive(fullPath, '**', result);
            }
            // Also match files at this level
            result.push(fullPath);
          } else if (entry.isFile()) {
            result.push(fullPath);
          }
        }
      }

      // Handle ** - also recurse into directories without consuming the pattern
      if (currentPattern === '**' && entry.isDirectory()) {
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
  if (pattern === '*') return true;
  if (pattern === '**') return true;

  // Convert glob pattern to regex
  const regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape special regex chars
    .replace(/\*/g, '.*') // * matches anything
    .replace(/\?/g, '.'); // ? matches single char

  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(name);
}

/**
 * Fields that may contain nested spec items
 */
const NESTED_ITEM_FIELDS = [
  'modules',
  'features',
  'requirements',
  'constraints',
  'decisions',
  'traits',
  'acceptance_criteria',
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
  currentPath: string = ''
): LoadedSpecItem[] {
  if (!raw || typeof raw !== 'object') {
    return items;
  }

  // Check if this object is itself a spec item (has _ulid)
  if ('_ulid' in raw && typeof (raw as Record<string, unknown>)._ulid === 'string') {
    const result = SpecItemSchema.safeParse(raw);
    if (result.success) {
      items.push({
        ...result.data,
        _sourceFile: sourceFile,
        _path: currentPath || undefined,
      });
    }

    // Even if the item itself was added, also extract nested items
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
    const content = await fs.readFile(filePath, 'utf-8');
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
  } catch (error) {
    // File doesn't exist or parse error
    return [];
  }
}

/**
 * Load all spec items from the project.
 * Parses manifest, follows includes, and builds unified collection.
 */
export async function loadAllItems(ctx: KspecContext): Promise<LoadedSpecItem[]> {
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
export function findItemByRef(
  items: LoadedSpecItem[],
  ref: string
): LoadedSpecItem | undefined {
  // Remove @ prefix if present
  const cleanRef = ref.startsWith('@') ? ref.slice(1) : ref;

  return items.find(item => {
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
  ref: string
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
  const tasks = await loadAllTasks(ctx);
  const items = await loadAllItems(ctx);
  const index = new ReferenceIndex(tasks, items);
  return { index, tasks, items };
}

/**
 * Build both ReferenceIndex and ItemIndex from context.
 * Use this when you need query capabilities in addition to reference resolution.
 */
export async function buildIndexes(ctx: KspecContext): Promise<{
  refIndex: ReferenceIndex;
  itemIndex: ItemIndex;
  traitIndex: TraitIndex;
  tasks: LoadedTask[];
  items: LoadedSpecItem[];
}> {
  const tasks = await loadAllTasks(ctx);
  const items = await loadAllItems(ctx);
  const refIndex = new ReferenceIndex(tasks, items);
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
  pathStr: string
): { parent: Record<string, unknown>; array: unknown[]; index: number } | null {
  if (!pathStr) return null;

  const segments = parsePath(pathStr);
  if (segments.length === 0) return null;

  let current: unknown = root;

  // Navigate to the parent of the last segment
  for (let i = 0; i < segments.length - 1; i++) {
    const [field, index] = segments[i];
    if (typeof current !== 'object' || current === null) return null;
    const obj = current as Record<string, unknown>;
    if (!Array.isArray(obj[field])) return null;
    current = (obj[field] as unknown[])[index];
  }

  // Get the final array and index
  const [finalField, finalIndex] = segments[segments.length - 1];
  if (typeof current !== 'object' || current === null) return null;
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
  currentPath: string = ''
): { path: string; item: Record<string, unknown> } | null {
  if (!root || typeof root !== 'object') return null;

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
  return {
    _ulid: input._ulid || ulid(),
    slugs: input.slugs || [],
    title: input.title,
    type: input.type,
    status: input.status,
    priority: input.priority,
    tags: input.tags || [],
    description: input.description,
    depends_on: input.depends_on || [],
    implements: input.implements || [],
    relates_to: input.relates_to || [],
    tests: input.tests || [],
    traits: input.traits || [],
    notes: input.notes || [],
    created: input.created || new Date().toISOString(),
    created_by: input.created_by,
  };
}

/**
 * Map from item type to the field name used to store children of that type.
 */
const TYPE_TO_CHILD_FIELD: Record<string, string> = {
  feature: 'features',
  requirement: 'requirements',
  constraint: 'constraints',
  decision: 'decisions',
  module: 'modules',
  trait: 'traits',
};

/**
 * Add a spec item as a child of a parent item.
 * @param parent The parent item to add under
 * @param child The new child item to add
 * @param childField Optional field name override (defaults based on child.type)
 */
export async function addChildItem(
  ctx: KspecContext,
  parent: LoadedSpecItem,
  child: SpecItem,
  childField?: string
): Promise<{ item: SpecItem; path: string }> {
  if (!parent._sourceFile) {
    throw new Error('Parent item has no source file');
  }

  const field = childField || TYPE_TO_CHILD_FIELD[child.type || 'feature'] || 'features';

  // Load the raw YAML
  const raw = await readYamlFile<unknown>(parent._sourceFile);

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
    parentPath = '';
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
  const childPath = parentPath ? `${parentPath}.${field}[${childIndex}]` : `${field}[${childIndex}]`;

  // Write back with format preservation
  await writeYamlFilePreserveFormat(parent._sourceFile, raw);

  return { item: cleanChild, path: childPath };
}

/**
 * Update a spec item in place within its source file.
 * Works with nested structures using the _path field.
 */
export async function updateSpecItem(
  ctx: KspecContext,
  item: LoadedSpecItem,
  updates: Partial<SpecItemInput>
): Promise<SpecItem> {
  if (!item._sourceFile) {
    throw new Error('Item has no source file');
  }

  // Load the raw YAML
  const raw = await readYamlFile<unknown>(item._sourceFile);

  // Find the item in the structure (use stored path or search by ULID)
  let targetObj: Record<string, unknown>;

  if (item._path) {
    const nav = navigateToPath(raw, item._path);
    if (!nav) {
      throw new Error(`Could not navigate to path: ${item._path}`);
    }
    targetObj = nav.array[nav.index] as Record<string, unknown>;
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
    if (key !== '_ulid' && key !== '_sourceFile' && key !== '_path') {
      targetObj[key] = value;
    }
  }

  // Write back with format preservation
  await writeYamlFilePreserveFormat(item._sourceFile, raw);

  return { ...item, ...updates, _ulid: item._ulid } as SpecItem;
}

/**
 * Delete a spec item from its source file.
 * Works with nested structures using the _path field.
 */
export async function deleteSpecItem(ctx: KspecContext, item: LoadedSpecItem): Promise<boolean> {
  if (!item._sourceFile) {
    return false;
  }

  try {
    const raw = await readYamlFile<unknown>(item._sourceFile);

    // If item has a path, navigate to it and remove from parent array
    if (item._path) {
      const nav = navigateToPath(raw, item._path);
      if (!nav) {
        return false;
      }
      // Remove the item from the array
      nav.array.splice(nav.index, 1);
      await writeYamlFilePreserveFormat(item._sourceFile, raw);
      return true;
    }

    // No path - try to find it by ULID
    const found = findItemInStructure(raw, item._ulid);
    if (found && found.path) {
      const nav = navigateToPath(raw, found.path);
      if (nav) {
        nav.array.splice(nav.index, 1);
        await writeYamlFilePreserveFormat(item._sourceFile, raw);
        return true;
      }
    }

    // Maybe it's a root-level array item
    if (Array.isArray(raw)) {
      const index = raw.findIndex((i: unknown) =>
        typeof i === 'object' && i !== null && (i as Record<string, unknown>)._ulid === item._ulid
      );
      if (index >= 0) {
        raw.splice(index, 1);
        await writeYamlFilePreserveFormat(item._sourceFile, raw);
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Save a spec item - either updates existing or adds to parent.
 * For new items, use addChildItem instead.
 */
export async function saveSpecItem(ctx: KspecContext, item: LoadedSpecItem): Promise<void> {
  // If item has a source file and path, it's an update
  if (item._sourceFile && item._path) {
    await updateSpecItem(ctx, item, item);
    return;
  }

  // Otherwise, this is more complex - would need a parent
  throw new Error('Cannot save new item without parent. Use addChildItem instead.');
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
  return path.join(ctx.specDir, 'project.inbox.yaml');
}

/**
 * Load all inbox items from the project.
 */
export async function loadInboxItems(ctx: KspecContext): Promise<LoadedInboxItem[]> {
  const inboxPath = getInboxFilePath(ctx);

  try {
    const raw = await readYamlFile<unknown>(inboxPath);

    // Handle { inbox: [...] } format
    if (raw && typeof raw === 'object' && 'inbox' in raw) {
      const parsed = InboxFileSchema.safeParse(raw);
      if (parsed.success) {
        return parsed.data.inbox.map(item => ({ ...item, _sourceFile: inboxPath }));
      }
    }

    // Handle plain array format
    if (Array.isArray(raw)) {
      const items: LoadedInboxItem[] = [];
      for (const item of raw) {
        const result = InboxItemSchema.safeParse(item);
        if (result.success) {
          items.push({ ...result.data, _sourceFile: inboxPath });
        }
      }
      return items;
    }

    return [];
  } catch {
    // File doesn't exist or parse error
    return [];
  }
}

/**
 * Create a new inbox item with auto-generated fields.
 */
export function createInboxItem(input: InboxItemInput): InboxItem {
  return {
    _ulid: input._ulid || ulid(),
    text: input.text,
    created_at: input.created_at || new Date().toISOString(),
    tags: input.tags || [],
    added_by: input.added_by ?? getAuthor(),
  };
}

/**
 * Strip runtime metadata before serialization.
 */
function stripInboxMetadata(item: LoadedInboxItem): InboxItem {
  const { _sourceFile, ...cleanItem } = item;
  return cleanItem as InboxItem;
}

/**
 * Save an inbox item (add or update).
 */
export async function saveInboxItem(ctx: KspecContext, item: LoadedInboxItem): Promise<void> {
  const inboxPath = getInboxFilePath(ctx);

  // Ensure directory exists
  const dir = path.dirname(inboxPath);
  await fs.mkdir(dir, { recursive: true });

  // Load existing items
  let existingItems: InboxItem[] = [];

  try {
    const raw = await readYamlFile<unknown>(inboxPath);
    if (raw && typeof raw === 'object' && 'inbox' in raw) {
      const parsed = InboxFileSchema.safeParse(raw);
      if (parsed.success) {
        existingItems = parsed.data.inbox;
      }
    } else if (Array.isArray(raw)) {
      for (const i of raw) {
        const result = InboxItemSchema.safeParse(i);
        if (result.success) {
          existingItems.push(result.data);
        }
      }
    }
  } catch {
    // File doesn't exist, start fresh
  }

  const cleanItem = stripInboxMetadata(item);

  // Update existing or add new
  const existingIndex = existingItems.findIndex(i => i._ulid === item._ulid);
  if (existingIndex >= 0) {
    existingItems[existingIndex] = cleanItem;
  } else {
    existingItems.push(cleanItem);
  }

  // Save with { inbox: [...] } format and format preservation
  await writeYamlFilePreserveFormat(inboxPath, { inbox: existingItems });
}

/**
 * Delete an inbox item by ULID.
 */
export async function deleteInboxItem(ctx: KspecContext, ulid: string): Promise<boolean> {
  const inboxPath = getInboxFilePath(ctx);

  try {
    const raw = await readYamlFile<unknown>(inboxPath);
    let existingItems: InboxItem[] = [];

    if (raw && typeof raw === 'object' && 'inbox' in raw) {
      const parsed = InboxFileSchema.safeParse(raw);
      if (parsed.success) {
        existingItems = parsed.data.inbox;
      }
    }

    const index = existingItems.findIndex(i => i._ulid === ulid);
    if (index < 0) {
      return false;
    }

    existingItems.splice(index, 1);
    await writeYamlFilePreserveFormat(inboxPath, { inbox: existingItems });
    return true;
  } catch {
    return false;
  }
}

/**
 * Find an inbox item by reference (ULID or short ULID).
 */
export function findInboxItemByRef(
  items: LoadedInboxItem[],
  ref: string
): LoadedInboxItem | undefined {
  const cleanRef = ref.startsWith('@') ? ref.slice(1) : ref;

  return items.find(item => {
    // Match full ULID
    if (item._ulid === cleanRef) return true;
    // Match short ULID (prefix)
    if (item._ulid.toLowerCase().startsWith(cleanRef.toLowerCase())) return true;
    return false;
  });
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
  status: 'updated' | 'skipped' | 'error';
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
  options: PatchOptions = {}
): Promise<BulkPatchResult> {
  const results: PatchResult[] = [];
  let stopProcessing = false;

  for (const patch of patches) {
    if (stopProcessing) {
      results.push({ ref: patch.ref, status: 'skipped' });
      continue;
    }

    // Resolve ref
    const resolved = refIndex.resolve(patch.ref);
    if (!resolved.ok) {
      const errorMsg = resolved.error === 'not_found'
        ? `Item not found: ${patch.ref}`
        : resolved.error === 'ambiguous'
          ? `Ambiguous ref: ${patch.ref}`
          : `Duplicate slug: ${patch.ref}`;
      results.push({ ref: patch.ref, status: 'error', error: errorMsg });
      if (options.failFast) {
        stopProcessing = true;
      }
      continue;
    }

    // Find the item
    const item = items.find(i => i._ulid === resolved.ulid);
    if (!item) {
      // Ref resolved but it's not a spec item (might be a task)
      results.push({ ref: patch.ref, status: 'error', error: 'Not a spec item' });
      if (options.failFast) {
        stopProcessing = true;
      }
      continue;
    }

    // Dry run - just record what would happen
    if (options.dryRun) {
      results.push({ ref: patch.ref, status: 'updated', ulid: item._ulid });
      continue;
    }

    // Apply the patch
    try {
      await updateSpecItem(ctx, item, patch.data);
      results.push({ ref: patch.ref, status: 'updated', ulid: item._ulid });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      results.push({ ref: patch.ref, status: 'error', error: errorMsg });
      if (options.failFast) {
        stopProcessing = true;
      }
    }
  }

  return {
    results,
    summary: {
      total: patches.length,
      updated: results.filter(r => r.status === 'updated').length,
      failed: results.filter(r => r.status === 'error').length,
      skipped: results.filter(r => r.status === 'skipped').length,
    },
  };
}
