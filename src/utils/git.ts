/**
 * Git integration utilities
 */

import { spawnSync } from "node:child_process";

export interface GitCommit {
  hash: string;
  fullHash: string;
  date: Date;
  message: string;
  author: string;
  body: string;
  taskRefs: string[];
}

export interface GitFileStatus {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "untracked";
  staged: boolean;
}

export interface GitWorkingTree {
  clean: boolean;
  staged: GitFileStatus[];
  unstaged: GitFileStatus[];
  untracked: string[];
}

/**
 * Run git with an args array (no shell) and return stdout, or null on any
 * failure (non-zero exit, spawn error). Dynamic values like branch and remote
 * names come from repository state and may contain shell metacharacters, so
 * they must never pass through a shell. Mirrors runGitSync in src/parser/shadow.ts.
 */
function runGit(args: string[], cwd?: string): string | null {
  try {
    const result = spawnSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    if (result.error || result.status !== 0) return null;
    return result.stdout ?? "";
  } catch {
    return null;
  }
}

/**
 * Check if current directory is in a git repository
 */
export function isGitRepo(cwd?: string): boolean {
  return runGit(["rev-parse", "--git-dir"], cwd) !== null;
}

/**
 * Get the current git branch name
 */
export function getCurrentBranch(cwd?: string): string | null {
  return runGit(["branch", "--show-current"], cwd)?.trim() || null;
}

/**
 * Get recent git commits
 *
 * @param options.limit Number of commits to return
 * @param options.since Only commits after this date
 * @param options.cwd Working directory
 */
export function getRecentCommits(options: {
  limit?: number;
  since?: Date;
  cwd?: string;
}): GitCommit[] {
  const { limit = 10, since, cwd } = options;

  // Format: hash, ISO date, subject, author name, body — NUL-delimited records
  // %x00 separates fields within a record, %x01 separates records
  // Body (%b) may contain newlines and pipes, so we use NUL delimiters
  const args = ["log", "--format=%H%x00%aI%x00%s%x00%an%x00%b%x01", "-n", String(limit)];

  if (since) {
    args.push(`--since=${since.toISOString()}`);
  }

  const output = runGit(args, cwd)?.trim();

  if (!output) return [];

  // Split records by \x01, filter empty entries
  return output
    .split("\x01")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [fullHash, dateStr, message, author, ...bodyParts] = record.split("\x00");
      const body = bodyParts.join("\x00").trim();

      // Parse Task: @slug trailers from body (anchored to line start per git trailer convention)
      const taskRefs: string[] = [];
      const trailerPattern = /^Task:\s*@([\w-]+)/gm;
      let match;
      while ((match = trailerPattern.exec(body)) !== null) {
        taskRefs.push(match[1]);
      }

      return {
        hash: fullHash.slice(0, 7),
        fullHash,
        date: new Date(dateStr),
        message,
        author,
        body,
        taskRefs,
      };
    });
}

/**
 * Get the working tree status (staged, unstaged, untracked files)
 */
export function getWorkingTreeStatus(cwd?: string): GitWorkingTree {
  const result: GitWorkingTree = {
    clean: true,
    staged: [],
    unstaged: [],
    untracked: [],
  };

  const output = runGit(["status", "--porcelain"], cwd)?.trim();

  if (!output) {
    return result;
  }

  result.clean = false;

  for (const line of output.split("\n")) {
    if (!line) continue;

    const indexStatus = line[0];
    const workTreeStatus = line[1];
    // Path starts after status codes - trim to normalize
    const path = line.slice(2).trim();

    // Untracked files
    if (indexStatus === "?" && workTreeStatus === "?") {
      result.untracked.push(path);
      continue;
    }

    // Staged changes (index has changes)
    if (indexStatus !== " " && indexStatus !== "?") {
      result.staged.push({
        path,
        status: parseStatusCode(indexStatus),
        staged: true,
      });
    }

    // Unstaged changes (work tree has changes)
    if (workTreeStatus !== " " && workTreeStatus !== "?") {
      result.unstaged.push({
        path,
        status: parseStatusCode(workTreeStatus),
        staged: false,
      });
    }
  }

  return result;
}

/**
 * Get git diff since a specific timestamp
 *
 * Returns unified diff output showing all changes made after the given timestamp.
 * Includes both committed changes and working tree changes.
 *
 * @param since - Date to get changes since
 * @param cwd - Working directory
 * @returns Diff output as string, or null if no changes or error
 */
export function getDiffSince(since: Date, cwd?: string): string | null {
  // Get the commit hash at the given time
  const sinceLog = runGit(
    ["log", "--format=%H", `--before=${since.toISOString()}`, "-n", "1"],
    cwd,
  );
  if (sinceLog === null) return null;
  const sinceCommit = sinceLog.trim();

  if (!sinceCommit) {
    // No commit before this time, diff from the beginning
    // Using Git's magic empty tree hash - this is the hash of an empty tree object
    // that exists conceptually in every Git repo (commonly used for initial diffs)
    const diff = runGit(["diff", "4b825dc642cb6eb9a060e54bf8d69288fbee4904..HEAD"], cwd)?.trim();

    return diff || null;
  }

  // Get diff from that commit to HEAD (includes committed changes)
  const committedDiff = runGit(["diff", `${sinceCommit}..HEAD`], cwd);
  if (committedDiff === null) return null;

  // Get diff for working tree changes (uncommitted)
  const workingTreeDiff = runGit(["diff", "HEAD"], cwd);
  if (workingTreeDiff === null) return null;

  // Combine both diffs
  const combined = [committedDiff.trim(), workingTreeDiff.trim()].filter(Boolean).join("\n\n");
  return combined || null;
}

/**
 * Get the current HEAD commit hash (full 40-char SHA).
 * AC: @portable-task-submission-linkage ac-1
 */
export function getHeadCommit(cwd?: string): string | null {
  return runGit(["rev-parse", "HEAD"], cwd)?.trim() || null;
}

/**
 * Get the upstream remote name, URL, and upstream ref for the current branch.
 * Returns { remote, url, upstream_ref } or null if no upstream is configured.
 * upstream_ref is the merge ref (e.g. "refs/heads/main") from branch.<name>.merge,
 * which may differ from the local branch name when tracking a differently named remote branch.
 * AC: @portable-task-submission-linkage ac-1
 */
export function getBranchRemote(
  branch: string,
  cwd?: string,
): { remote: string; url: string; upstream_ref: string | null } | null {
  const remote = runGit(["config", "--get", `branch.${branch}.remote`], cwd)?.trim();
  if (!remote) return null;

  const url = runGit(["remote", "get-url", remote], cwd);
  if (url === null) return null;

  // Capture the upstream merge ref (e.g. refs/heads/some-branch)
  // null when no merge ref is configured — tracking remote but no specific branch
  const upstreamRef = runGit(["config", "--get", `branch.${branch}.merge`], cwd)?.trim() || null;

  return { remote, url: url.trim() || "", upstream_ref: upstreamRef };
}

/**
 * Capture submission linkage context from current git state.
 * Returns structured data for storage in task.submission_linkage.
 * AC: @portable-task-submission-linkage ac-1, ac-3, ac-5
 */
export function captureSubmissionLinkage(
  cwd?: string,
  reviewUrl?: string,
  dispatchBaseBranch?: string | null,
): {
  branch: string | null;
  commit: string;
  remote: string | null;
  remote_url: string | null;
  upstream_ref: string | null;
  review_url: string | null;
  captured_at: string;
} | null {
  const commit = getHeadCommit(cwd);
  if (!commit) return null;

  const branch = getCurrentBranch(cwd);

  let remote: string | null = null;
  let remoteUrl: string | null = null;
  let upstreamRef: string | null = null;
  if (branch) {
    const remoteInfo = getBranchRemote(branch, cwd);
    if (remoteInfo) {
      remote = remoteInfo.remote;
      remoteUrl = remoteInfo.url;
      upstreamRef = remoteInfo.upstream_ref;
    }
  }

  // AC: @portable-task-submission-linkage ac-5 — fallback to dispatch config base_branch
  if (!upstreamRef && dispatchBaseBranch) {
    upstreamRef = dispatchBaseBranch;
  }

  return {
    branch,
    commit,
    remote: remote || null,
    remote_url: remoteUrl || null,
    upstream_ref: upstreamRef || null,
    review_url: reviewUrl || null,
    captured_at: new Date().toISOString(),
  };
}

function parseStatusCode(code: string): "modified" | "added" | "deleted" | "renamed" | "untracked" {
  switch (code) {
    case "M":
      return "modified";
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    default:
      return "modified";
  }
}
