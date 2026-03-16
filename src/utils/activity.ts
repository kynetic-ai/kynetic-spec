/**
 * Task activity git query — extracts raw commit data for a task's YAML block
 * from shadow branch git history using git log -L.
 *
 * AC: @task-activity-git-query ac-1, ac-2
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

export interface RawTaskCommit {
  hash: string;
  fullHash: string;
  timestamp: string;
  author: string;
  message: string;
  diff: string;
}

/**
 * Find the line range for a task's YAML block in project.tasks.yaml.
 *
 * Uses the _ulid-first invariant (@yaml-serialization-invariants ac-1):
 * each task record starts with `- _ulid:` and the next record starts
 * with the next `- _ulid:` (or EOF).
 *
 * @returns [startLine, endLine] (1-indexed, inclusive) or null if not found
 */
export function findTaskBlockLines(
  specDir: string,
  taskUlid: string,
): [number, number] | null {
  const tasksFile = path.join(specDir, "project.tasks.yaml");
  let content: string;
  try {
    content = readFileSync(tasksFile, "utf-8");
  } catch {
    return null;
  }

  const lines = content.split("\n");
  let startLine: number | null = null;
  let endLine: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("- _ulid: ")) {
      if (startLine !== null) {
        // Found the next task block — end is the line before
        endLine = i; // 0-indexed, so this is line i+1 in 1-indexed, but we want the previous
        break;
      }
      const ulid = line.slice("- _ulid: ".length).trim();
      if (ulid === taskUlid) {
        startLine = i + 1; // Convert to 1-indexed
      }
    }
  }

  if (startLine === null) return null;

  // If no next _ulid found, block extends to EOF
  if (endLine === null) {
    // Find last non-empty line
    let lastNonEmpty = lines.length;
    while (lastNonEmpty > 0 && lines[lastNonEmpty - 1].trim() === "") {
      lastNonEmpty--;
    }
    endLine = lastNonEmpty; // Already 1-indexed (length of array)
  }

  return [startLine, endLine];
}

/**
 * Query shadow branch git history for all commits that modified a task's
 * YAML block using git log -L (line range tracking).
 *
 * AC: @task-activity-git-query ac-1 — returns all commits that modified the task's data
 * AC: @task-activity-git-query ac-2 — only includes changes to the specific task's block
 *
 * @param specDir - Path to the .kspec worktree directory
 * @param taskUlid - The task's full ULID
 * @returns Array of raw commit objects in reverse chronological order (newest first)
 */
export function getRawTaskCommits(
  specDir: string,
  taskUlid: string,
): RawTaskCommit[] {
  const blockLines = findTaskBlockLines(specDir, taskUlid);
  if (!blockLines) return [];

  const [startLine, endLine] = blockLines;

  try {
    // git log -L tracks all commits that touched the specified line range.
    // This captures the complete history regardless of commit message content,
    // including manual edits, batch operations, and field reordering.
    const output = execSync(
      `git log -L ${startLine},${endLine}:project.tasks.yaml --format="%H%x00%aI%x00%an%x00%s%x00"`,
      {
        cwd: specDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "ignore"],
        maxBuffer: 10 * 1024 * 1024, // 10MB for large histories
      },
    );

    return parseGitLogLOutput(output);
  } catch {
    return [];
  }
}

/**
 * Parse the output of git log -L with our custom format.
 *
 * Output structure per commit:
 *   <fullHash>\0<isoDate>\0<author>\0<subject>\0\n
 *   \n
 *   diff --git a/... b/...\n
 *   --- a/...\n
 *   +++ b/...\n
 *   @@ ... @@\n
 *   <diff lines>\n
 *   \n
 *   <next commit header...>
 */
export function parseGitLogLOutput(output: string): RawTaskCommit[] {
  if (!output.trim()) return [];

  const commits: RawTaskCommit[] = [];

  // Split on the format boundary: each commit starts with a line containing NUL bytes
  // The format produces: HASH\0DATE\0AUTHOR\0SUBJECT\0
  // followed by blank line then diff output
  const lines = output.split("\n");
  let i = 0;

  while (i < lines.length) {
    // Find the next commit header (contains NUL bytes)
    if (!lines[i].includes("\x00")) {
      i++;
      continue;
    }

    const parts = lines[i].split("\x00");
    if (parts.length < 4) {
      i++;
      continue;
    }

    const [fullHash, timestamp, author, message] = parts;

    // Collect diff lines until next commit header or end
    i++;
    const diffLines: string[] = [];

    while (i < lines.length) {
      if (lines[i].includes("\x00")) break; // Next commit
      diffLines.push(lines[i]);
      i++;
    }

    // Trim leading/trailing blank lines from diff
    const diff = diffLines.join("\n").trim();

    commits.push({
      hash: fullHash.slice(0, 7),
      fullHash,
      timestamp,
      author,
      message,
      diff,
    });
  }

  return commits;
}
