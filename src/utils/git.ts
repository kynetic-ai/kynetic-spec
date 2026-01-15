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
