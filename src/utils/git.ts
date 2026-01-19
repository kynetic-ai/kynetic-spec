/**
 * Git integration utilities
 */

import { execSync } from 'node:child_process';

export interface GitCommit {
  hash: string;
  fullHash: string;
  date: Date;
  message: string;
  author: string;
}

export interface GitFileStatus {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';
  staged: boolean;
}

export interface GitWorkingTree {
  clean: boolean;
  staged: GitFileStatus[];
  unstaged: GitFileStatus[];
  untracked: string[];
}

/**
 * Check if current directory is in a git repository
 */
export function isGitRepo(cwd?: string): boolean {
  try {
    execSync('git rev-parse --git-dir', {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the current git branch name
 */
export function getCurrentBranch(cwd?: string): string | null {
  try {
    return (
      execSync('git branch --show-current', {
        cwd,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim() || null
    );
  } catch {
    return null;
  }
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

  try {
    // Format: hash|ISO date|subject|author name
    // Using %aI for ISO 8601 author date
    let cmd = `git log --format="%H|%aI|%s|%an" -n ${limit}`;

    if (since) {
      cmd += ` --since="${since.toISOString()}"`;
    }

    const output = execSync(cmd, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();

    if (!output) return [];

    return output.split('\n').map((line) => {
      const [fullHash, dateStr, message, author] = line.split('|');
      return {
        hash: fullHash.slice(0, 7),
        fullHash,
        date: new Date(dateStr),
        message,
        author,
      };
    });
  } catch {
    return [];
  }
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

  try {
    const output = execSync('git status --porcelain', {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();

    if (!output) {
      return result;
    }

    result.clean = false;

    for (const line of output.split('\n')) {
      if (!line) continue;

      const indexStatus = line[0];
      const workTreeStatus = line[1];
      // Path starts after status codes - trim to normalize
      const path = line.slice(2).trim();

      // Untracked files
      if (indexStatus === '?' && workTreeStatus === '?') {
        result.untracked.push(path);
        continue;
      }

      // Staged changes (index has changes)
      if (indexStatus !== ' ' && indexStatus !== '?') {
        result.staged.push({
          path,
          status: parseStatusCode(indexStatus),
          staged: true,
        });
      }

      // Unstaged changes (work tree has changes)
      if (workTreeStatus !== ' ' && workTreeStatus !== '?') {
        result.unstaged.push({
          path,
          status: parseStatusCode(workTreeStatus),
          staged: false,
        });
      }
    }

    return result;
  } catch {
    return result;
  }
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
  try {
    // Get the commit hash at the given time
    const sinceCommit = execSync(
      `git log --format="%H" --before="${since.toISOString()}" -n 1`,
      {
        cwd,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'],
      }
    ).trim();

    if (!sinceCommit) {
      // No commit before this time, diff from the beginning
      // Using Git's magic empty tree hash - this is the hash of an empty tree object
      // that exists conceptually in every Git repo (commonly used for initial diffs)
      const diff = execSync('git diff 4b825dc642cb6eb9a060e54bf8d69288fbee4904..HEAD', {
        cwd,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim();

      return diff || null;
    }

    // Get diff from that commit to HEAD (includes committed changes)
    const committedDiff = execSync(`git diff ${sinceCommit}..HEAD`, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();

    // Get diff for working tree changes (uncommitted)
    const workingTreeDiff = execSync('git diff HEAD', {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();

    // Combine both diffs
    const combined = [committedDiff, workingTreeDiff].filter(Boolean).join('\n\n');
    return combined || null;
  } catch {
    return null;
  }
}

function parseStatusCode(
  code: string
): 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' {
  switch (code) {
    case 'M':
      return 'modified';
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    default:
      return 'modified';
  }
}
