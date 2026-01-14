import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import yaml from 'js-yaml';
import { ulid } from 'ulid';
import { z } from 'zod';
import {
  TaskSchema,
  TasksFileSchema,
  TaskInputSchema,
  ManifestSchema,
  SpecItemSchema,
  type Task,
  type TasksFile,
  type TaskInput,
  type Manifest,
  type SpecItem,
  type Note,
} from '../schema/index.js';

/**
 * Task with runtime metadata for source tracking.
 * _sourceFile is not serialized - it's used to know where to write updates.
 */
export interface LoadedTask extends Task {
  _sourceFile?: string;
}

/**
 * Parse YAML content into an object
 */
export function parseYaml<T>(content: string): T {
  return yaml.load(content) as T;
}

/**
 * Serialize object to YAML
 */
export function toYaml(obj: unknown): string {
  return yaml.dump(obj, {
    indent: 2,
    lineWidth: 100,
    noRefs: true,
    sortKeys: false,
  });
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
 * Context for working with spec/task files
 */
export interface KspecContext {
  rootDir: string;
  manifestPath: string | null;
  manifest: Manifest | null;
}

/**
 * Initialize context by finding manifest
 */
export async function initContext(startDir?: string): Promise<KspecContext> {
  const cwd = startDir || process.cwd();
  const manifestPath = await findManifest(cwd);

  let manifest: Manifest | null = null;
  let rootDir = cwd;

  if (manifestPath) {
    rootDir = path.dirname(manifestPath);
    // Handle spec/ subdirectory
    if (path.basename(rootDir) === 'spec') {
      rootDir = path.dirname(rootDir);
    }

    try {
      const rawManifest = await readYamlFile<unknown>(manifestPath);
      manifest = ManifestSchema.parse(rawManifest);
    } catch (error) {
      // Manifest exists but may be invalid
    }
  }

  return { rootDir, manifestPath, manifest };
}

/**
 * Load all tasks from the project.
 * Each task includes _sourceFile metadata for write-back routing.
 */
export async function loadAllTasks(ctx: KspecContext): Promise<LoadedTask[]> {
  const tasks: LoadedTask[] = [];

  // Look for tasks in root directory
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

  // Deduplicate
  const uniqueFiles = [...new Set(taskFiles)];

  for (const filePath of uniqueFiles) {
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
          continue;
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
    } catch (error) {
      // Skip invalid files
    }
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
 * New tasks go to spec/project.tasks.yaml (or project.tasks.yaml if no spec dir).
 */
export function getDefaultTaskFilePath(ctx: KspecContext): string {
  const specDir = path.join(ctx.rootDir, 'spec');
  // Prefer spec/project.tasks.yaml if spec directory exists
  return path.join(specDir, 'project.tasks.yaml');
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
  if (useTasksWrapper) {
    await writeYamlFile(taskFilePath, { tasks: fileTasks });
  } else {
    await writeYamlFile(taskFilePath, fileTasks);
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
 * Create a new note entry
 */
export function createNote(content: string, author?: string, supersedes?: string): Note {
  return {
    _ulid: ulid(),
    created_at: new Date().toISOString(),
    author,
    content,
    supersedes: supersedes || null,
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
 * Get ready tasks (pending + deps met + not blocked), sorted by priority
 */
export function getReadyTasks(tasks: LoadedTask[]): LoadedTask[] {
  return tasks
    .filter(task => isTaskReady(task, tasks))
    .sort((a, b) => a.priority - b.priority);
}
