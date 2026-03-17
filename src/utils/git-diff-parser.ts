/**
 * Git unified diff parser
 *
 * Parses standard unified diff output from `git diff` into structured types
 * suitable for rendering in diff viewers.
 *
 * AC: @review-content-diff-api ac-1
 */

/**
 * A single change line within a diff hunk.
 */
export interface DiffChangeLine {
  type: 'added' | 'deleted' | 'unchanged';
  content: string;
  oldLineNumber: number | null;
  newLineNumber: number | null;
}

/**
 * A hunk (contiguous block of changes) within a file diff.
 */
export interface DiffHunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  changes: DiffChangeLine[];
}

/**
 * Per-file diff statistics.
 */
export interface DiffFileStats {
  additions: number;
  deletions: number;
}

/**
 * Parsed diff for a single file.
 */
export interface DiffFile {
  oldPath: string;
  newPath: string;
  status: 'added' | 'deleted' | 'modified' | 'renamed';
  stats: DiffFileStats;
  hunks: DiffHunk[];
}

/**
 * Full parsed diff response.
 */
export interface ParsedDiff {
  base: string;
  head: string;
  files: DiffFile[];
  stats: {
    totalFiles: number;
    totalAdditions: number;
    totalDeletions: number;
  };
}

/**
 * Parse unified diff output from git into structured types.
 *
 * Handles the standard unified diff format produced by `git diff`.
 */
export function parseUnifiedDiff(diffOutput: string, base: string, head: string): ParsedDiff {
  const files: DiffFile[] = [];

  // Split by file diffs (each starts with "diff --git")
  const fileDiffs = diffOutput.split(/^diff --git /m).filter(Boolean);

  for (const fileDiff of fileDiffs) {
    const lines = fileDiff.split('\n');

    // Parse file paths from the first line: "a/path b/path"
    const headerMatch = lines[0].match(/^a\/(.+?)\s+b\/(.+)$/);
    if (!headerMatch) continue;

    const oldPath = headerMatch[1];
    const newPath = headerMatch[2];

    // Determine file status from diff metadata
    let status: DiffFile['status'] = 'modified';
    const metaLines = lines.slice(1);
    for (const line of metaLines) {
      if (line.startsWith('new file mode')) {
        status = 'added';
        break;
      }
      if (line.startsWith('deleted file mode')) {
        status = 'deleted';
        break;
      }
      if (line.startsWith('rename from') || line.startsWith('similarity index')) {
        status = 'renamed';
      }
      if (line.startsWith('@@')) break;
    }

    // Parse hunks
    const hunks: DiffHunk[] = [];
    let currentHunk: DiffHunk | null = null;
    let oldLine = 0;
    let newLine = 0;

    for (const line of metaLines) {
      // Hunk header: @@ -oldStart,oldCount +newStart,newCount @@ optional context
      const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
      if (hunkMatch) {
        if (currentHunk) {
          hunks.push(currentHunk);
        }

        const oldStart = parseInt(hunkMatch[1], 10);
        const oldCount = hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1;
        const newStart = parseInt(hunkMatch[3], 10);
        const newCount = hunkMatch[4] !== undefined ? parseInt(hunkMatch[4], 10) : 1;

        currentHunk = {
          header: line,
          oldStart,
          oldCount,
          newStart,
          newCount,
          changes: [],
        };

        oldLine = oldStart;
        newLine = newStart;
        continue;
      }

      if (!currentHunk) continue;

      // Skip the "\ No newline at end of file" marker
      if (line.startsWith('\\ No newline at end of file')) continue;

      if (line.startsWith('+')) {
        currentHunk.changes.push({
          type: 'added',
          content: line.slice(1),
          oldLineNumber: null,
          newLineNumber: newLine,
        });
        newLine++;
      } else if (line.startsWith('-')) {
        currentHunk.changes.push({
          type: 'deleted',
          content: line.slice(1),
          oldLineNumber: oldLine,
          newLineNumber: null,
        });
        oldLine++;
      } else if (line.startsWith(' ')) {
        // Context line (unchanged)
        currentHunk.changes.push({
          type: 'unchanged',
          content: line.slice(1),
          oldLineNumber: oldLine,
          newLineNumber: newLine,
        });
        oldLine++;
        newLine++;
      }
    }

    if (currentHunk) {
      hunks.push(currentHunk);
    }

    // Compute per-file stats
    let additions = 0;
    let deletions = 0;
    for (const hunk of hunks) {
      for (const change of hunk.changes) {
        if (change.type === 'added') additions++;
        if (change.type === 'deleted') deletions++;
      }
    }

    files.push({
      oldPath,
      newPath,
      status,
      stats: { additions, deletions },
      hunks,
    });
  }

  // Compute total stats
  let totalAdditions = 0;
  let totalDeletions = 0;
  for (const file of files) {
    totalAdditions += file.stats.additions;
    totalDeletions += file.stats.deletions;
  }

  return {
    base,
    head,
    files,
    stats: {
      totalFiles: files.length,
      totalAdditions,
      totalDeletions,
    },
  };
}
