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
