import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { loadProjectConfig } from "../parser/config.js";

const DISPATCH_WORKSPACE_METADATA_FILE = ".kspec-dispatch-workspace.json";

interface GitResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

export interface ResolvedDispatchWorkspaceConfig {
  baseBranch: string;
  baseBranchStartPoint: string;
  baseBranchSource: "configured" | "remote-head" | "current-branch" | "default";
  worktreeRoot: string;
}

export interface DispatchWorkspaceMetadata {
  taskRef: string;
  taskSlug: string;
  baseBranch: string;
  mergeTargetBranch: string;
  canonicalBranch: string;
  worktreeRoot: string;
  worktreeDir: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProvisionDispatchWorkspaceOptions {
  projectDir: string;
  taskRef: string;
  task?: {
    title?: string;
    slugs?: string[];
  };
}

export interface ProvisionedDispatchWorkspace {
  cwd: string;
  metadataPath: string;
  metadata: DispatchWorkspaceMetadata;
}

export class DispatchWorkspaceError extends Error {
  suggestion: string;

  constructor(message: string, suggestion: string) {
    super(message);
    this.name = "DispatchWorkspaceError";
    this.suggestion = suggestion;
  }
}

function runGit(cwd: string, args: string[]): GitResult {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: "pipe",
  });
  return {
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    status: result.status,
  };
}

function runGitOrThrow(
  cwd: string,
  args: string[],
  message: string,
  suggestion: string,
): string {
  const result = runGit(cwd, args);
  if (result.status === 0) {
    return result.stdout;
  }
  const detail = result.stderr || result.stdout || "git command failed";
  throw new DispatchWorkspaceError(`${message}: ${detail}`, suggestion);
}

function listGitRemotes(projectDir: string): string[] {
  const result = runGit(projectDir, ["remote"]);
  if (result.status !== 0 || !result.stdout) {
    return [];
  }
  const remotes = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
  const originFirst = remotes.filter((remote) => remote === "origin");
  const rest = remotes.filter((remote) => remote !== "origin");
  return [...originFirst, ...rest];
}

function refExists(projectDir: string, ref: string): boolean {
  const result = runGit(projectDir, ["show-ref", "--verify", "--quiet", ref]);
  return result.status === 0;
}

function resolveBranchStartPoint(
  projectDir: string,
  branch: string,
): { startPoint: string; branch: string } | null {
  if (refExists(projectDir, `refs/heads/${branch}`)) {
    return { startPoint: branch, branch };
  }

  for (const remote of listGitRemotes(projectDir)) {
    const remoteRef = `refs/remotes/${remote}/${branch}`;
    if (refExists(projectDir, remoteRef)) {
      return { startPoint: `${remote}/${branch}`, branch };
    }
  }

  return null;
}

function resolveRemoteHeadBranch(projectDir: string): string | null {
  for (const remote of listGitRemotes(projectDir)) {
    const result = runGit(projectDir, ["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`]);
    if (result.status !== 0 || !result.stdout) continue;
    const prefix = `refs/remotes/${remote}/`;
    if (result.stdout.startsWith(prefix)) {
      return result.stdout.slice(prefix.length);
    }
  }
  return null;
}

function resolveCurrentBranch(projectDir: string): string | null {
  const result = runGit(projectDir, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return result.status === 0 && result.stdout ? result.stdout : null;
}

function normalizeTaskSlug(taskRef: string, task?: { title?: string; slugs?: string[] }): string {
  const preferred = task?.slugs?.[0] ?? task?.title ?? taskRef.replace(/^@/, "task");
  const normalized = preferred
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/--+/g, "-");
  return normalized || "task";
}

function shortTaskId(taskRef: string): string {
  return taskRef.replace(/^@/, "").slice(0, 8).toLowerCase();
}

function metadataPathFor(worktreeDir: string): string {
  return path.join(worktreeDir, DISPATCH_WORKSPACE_METADATA_FILE);
}

async function readWorkspaceMetadata(worktreeDir: string): Promise<DispatchWorkspaceMetadata | null> {
  try {
    const raw = await fs.readFile(metadataPathFor(worktreeDir), "utf-8");
    return JSON.parse(raw) as DispatchWorkspaceMetadata;
  } catch {
    return null;
  }
}

async function writeWorkspaceMetadata(
  worktreeDir: string,
  metadata: DispatchWorkspaceMetadata,
): Promise<string> {
  const metadataPath = metadataPathFor(worktreeDir);
  await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf-8");
  return metadataPath;
}

async function ensureUsableWorktreeRoot(
  projectDir: string,
  worktreeRoot: string,
): Promise<void> {
  const shadowDir = path.join(projectDir, ".kspec");
  const relativeToShadow = path.relative(shadowDir, worktreeRoot);
  const insideShadow = relativeToShadow === "" || (!relativeToShadow.startsWith("..") && !path.isAbsolute(relativeToShadow));
  if (insideShadow) {
    throw new DispatchWorkspaceError(
      `Resolved dispatch worktree root "${worktreeRoot}" is inside the shadow worktree.`,
      "Set dispatch.worktree_root to a directory outside .kspec/.",
    );
  }

  try {
    await fs.mkdir(worktreeRoot, { recursive: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DispatchWorkspaceError(
      `Cannot create dispatch worktree root "${worktreeRoot}": ${message}`,
      "Fix the path or permissions for dispatch.worktree_root and try again.",
    );
  }

  const stat = await fs.stat(worktreeRoot).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new DispatchWorkspaceError(
      `Resolved dispatch worktree root "${worktreeRoot}" is not a directory.`,
      "Choose a directory path for dispatch.worktree_root.",
    );
  }
}

function parseWorktreeList(projectDir: string): Array<{ path: string; branch: string | null }> {
  const result = runGit(projectDir, ["worktree", "list", "--porcelain"]);
  if (result.status !== 0 || !result.stdout) {
    return [];
  }

  const entries: Array<{ path: string; branch: string | null }> = [];
  const blocks = result.stdout.split(/\n\s*\n/).filter(Boolean);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const worktreePath = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
    if (!worktreePath) continue;
    const branchRef = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length) ?? null;
    entries.push({ path: worktreePath, branch: branchRef });
  }
  return entries;
}

function findExistingWorktreeForBranch(projectDir: string, canonicalBranch: string): string | null {
  const branchRef = `refs/heads/${canonicalBranch}`;
  return parseWorktreeList(projectDir).find((entry) => entry.branch === branchRef)?.path ?? null;
}

async function assertPathSafeForWorktree(worktreeDir: string, projectDir: string): Promise<void> {
  const existing = await fs.stat(worktreeDir).catch(() => null);
  if (!existing) return;

  const registered = parseWorktreeList(projectDir).some((entry) => entry.path === worktreeDir);
  if (registered) return;

  const entries = await fs.readdir(worktreeDir).catch(() => []);
  if (entries.length > 0) {
    throw new DispatchWorkspaceError(
      `Dispatch worktree path "${worktreeDir}" already exists and is not a registered git worktree.`,
      "Remove or rename that directory, or choose a different dispatch.worktree_root.",
    );
  }
}

export async function resolveDispatchWorkspaceConfig(
  projectDir: string,
): Promise<ResolvedDispatchWorkspaceConfig> {
  const { config } = await loadProjectConfig(projectDir, projectDir);
  const configuredBaseBranch = config.dispatch.base_branch?.trim() || null;
  const rawRoot = config.dispatch.worktree_root?.trim() || ".kspec-worktrees";
  const worktreeRoot = path.isAbsolute(rawRoot)
    ? rawRoot
    : path.resolve(projectDir, rawRoot);

  if (configuredBaseBranch) {
    const resolved = resolveBranchStartPoint(projectDir, configuredBaseBranch);
    if (!resolved) {
      throw new DispatchWorkspaceError(
        `Configured dispatch.base_branch "${configuredBaseBranch}" does not exist in this repository.`,
        "Create or fetch that branch, or update kspec.config.yaml to a valid base branch.",
      );
    }
    return {
      baseBranch: configuredBaseBranch,
      baseBranchStartPoint: resolved.startPoint,
      baseBranchSource: "configured",
      worktreeRoot,
    };
  }

  const remoteHeadBranch = resolveRemoteHeadBranch(projectDir);
  if (remoteHeadBranch) {
    const resolved = resolveBranchStartPoint(projectDir, remoteHeadBranch);
    if (resolved) {
      return {
        baseBranch: remoteHeadBranch,
        baseBranchStartPoint: resolved.startPoint,
        baseBranchSource: "remote-head",
        worktreeRoot,
      };
    }
  }

  const currentBranch = resolveCurrentBranch(projectDir);
  if (currentBranch) {
    const resolved = resolveBranchStartPoint(projectDir, currentBranch) ?? {
      startPoint: currentBranch,
      branch: currentBranch,
    };
    return {
      baseBranch: currentBranch,
      baseBranchStartPoint: resolved.startPoint,
      baseBranchSource: "current-branch",
      worktreeRoot,
    };
  }

  return {
    baseBranch: "main",
    baseBranchStartPoint: "main",
    baseBranchSource: "default",
    worktreeRoot,
  };
}

export async function provisionDispatchWorkspace(
  options: ProvisionDispatchWorkspaceOptions,
): Promise<ProvisionedDispatchWorkspace> {
  const { projectDir, taskRef, task } = options;
  const slug = normalizeTaskSlug(taskRef, task);
  const shortId = shortTaskId(taskRef);
  const canonicalBranch = `dispatch/task/${slug}/${shortId}`;

  const resolvedConfig = await resolveDispatchWorkspaceConfig(projectDir);
  await ensureUsableWorktreeRoot(projectDir, resolvedConfig.worktreeRoot);

  const desiredWorktreeDir = path.join(resolvedConfig.worktreeRoot, `${slug}-${shortId}`);
  await assertPathSafeForWorktree(desiredWorktreeDir, projectDir);

  const existingWorktreeDir = findExistingWorktreeForBranch(projectDir, canonicalBranch);
  const worktreeDir = existingWorktreeDir ?? desiredWorktreeDir;
  const existingMetadata = await readWorkspaceMetadata(worktreeDir);
  const baseBranch = existingMetadata?.baseBranch ?? resolvedConfig.baseBranch;
  const mergeTargetBranch = existingMetadata?.mergeTargetBranch ?? baseBranch;

  if (!existingWorktreeDir) {
    const branchExists = refExists(projectDir, `refs/heads/${canonicalBranch}`);
    if (branchExists) {
      runGitOrThrow(
        projectDir,
        ["worktree", "add", worktreeDir, canonicalBranch],
        `Failed to attach existing dispatch branch "${canonicalBranch}"`,
        "Inspect git worktree state and remove stale registrations before retrying.",
      );
    } else {
      runGitOrThrow(
        projectDir,
        ["worktree", "add", "-b", canonicalBranch, worktreeDir, resolvedConfig.baseBranchStartPoint],
        `Failed to create dispatch worktree for ${taskRef} from "${resolvedConfig.baseBranchStartPoint}"`,
        "Ensure the base branch exists locally or on a tracked remote, then retry dispatch.",
      );
    }
  }

  const now = new Date().toISOString();
  const metadata: DispatchWorkspaceMetadata = {
    taskRef,
    taskSlug: slug,
    baseBranch,
    mergeTargetBranch,
    canonicalBranch,
    worktreeRoot: resolvedConfig.worktreeRoot,
    worktreeDir,
    createdAt: existingMetadata?.createdAt ?? now,
    updatedAt: now,
  };
  const metadataPath = await writeWorkspaceMetadata(worktreeDir, metadata);

  return {
    cwd: worktreeDir,
    metadataPath,
    metadata,
  };
}
