/**
 * Diff Content API Routes
 *
 * REST endpoints for serving parsed git diffs and entity content
 * for the review content viewers.
 *
 * AC Coverage:
 * - @review-content-diff-api ac-1: GET /api/diff returns parsed diff with file list, stats, hunks
 * - @review-content-diff-api ac-2: GET /api/diff/context returns expanded context lines
 * - @review-content-diff-api ac-3: GET /api/diff/file returns single-file parsed diff
 * - @review-content-diff-api ac-4: GET /api/reviews/:id/content returns parsed entity content
 */

import { Elysia, t } from 'elysia';
import { execSync } from 'node:child_process';
import {
  initContext,
  loadAllItems,
  loadAllTasks,
  findPlanByRef,
  ReferenceIndex,
} from '../../parser/index.js';
import {
  loadReviewRecords,
  findReviewByRef,
} from '../../parser/reviews.js';
import { parseUnifiedDiff } from '../../utils/git-diff-parser.js';

// ─── Git Helpers ───

/**
 * Run git diff between two refs and return raw output.
 */
function runGitDiff(base: string, head: string, cwd: string, filePath?: string): string {
  const pathArg = filePath ? ` -- ${JSON.stringify(filePath)}` : '';
  const cmd = `git diff ${base}..${head}${pathArg}`;
  return execSync(cmd, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large diffs
  });
}

/**
 * Get file content at a specific commit.
 */
function getFileAtCommit(commit: string, filePath: string, cwd: string): string | null {
  try {
    return execSync(`git show ${commit}:${filePath}`, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/**
 * Validate a git ref (commit hash, branch name, tag) exists in the repo.
 */
function isValidGitRef(ref: string, cwd: string): boolean {
  try {
    execSync(`git rev-parse --verify ${ref}`, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

// ─── Routes ───

export function createDiffRoutes() {
  return new Elysia()

    // AC: @review-content-diff-api ac-1 - Full diff with file list, stats, and structured hunks
    .get(
      '/api/diff',
      async ({ query, error: errorResponse, projectContext }) => {
        const { base, head } = query;

        if (!base || !head) {
          return errorResponse(400, {
            error: 'validation_error',
            message: 'Both "base" and "head" query parameters are required',
            suggestion: 'Provide base and head commit refs, e.g. GET /api/diff?base=abc123&head=def456',
          });
        }

        const projectPath = projectContext.path;

        // Validate refs exist
        if (!isValidGitRef(base, projectPath)) {
          return errorResponse(400, {
            error: 'invalid_ref',
            message: `Base ref "${base}" is not a valid git reference`,
            suggestion: 'Check the ref exists with: git rev-parse --verify <ref>',
          });
        }

        if (!isValidGitRef(head, projectPath)) {
          return errorResponse(400, {
            error: 'invalid_ref',
            message: `Head ref "${head}" is not a valid git reference`,
            suggestion: 'Check the ref exists with: git rev-parse --verify <ref>',
          });
        }

        try {
          const diffOutput = runGitDiff(base, head, projectPath);
          const parsed = parseUnifiedDiff(diffOutput, base, head);
          return parsed;
        } catch (err) {
          return errorResponse(500, {
            error: 'git_error',
            message: `Failed to compute diff: ${err instanceof Error ? err.message : String(err)}`,
            suggestion: 'Ensure both refs are valid and the repository is accessible',
          });
        }
      },
      {
        query: t.Object({
          base: t.String(),
          head: t.String(),
        }),
      }
    )

    // AC: @review-content-diff-api ac-3 - Single file diff for lazy loading
    .get(
      '/api/diff/file',
      async ({ query, error: errorResponse, projectContext }) => {
        const { base, head, path: filePath } = query;

        if (!base || !head || !filePath) {
          return errorResponse(400, {
            error: 'validation_error',
            message: '"base", "head", and "path" query parameters are required',
            suggestion: 'Provide all parameters, e.g. GET /api/diff/file?base=abc&head=def&path=src/index.ts',
          });
        }

        const projectPath = projectContext.path;

        if (!isValidGitRef(base, projectPath)) {
          return errorResponse(400, {
            error: 'invalid_ref',
            message: `Base ref "${base}" is not a valid git reference`,
            suggestion: 'Check the ref exists with: git rev-parse --verify <ref>',
          });
        }

        if (!isValidGitRef(head, projectPath)) {
          return errorResponse(400, {
            error: 'invalid_ref',
            message: `Head ref "${head}" is not a valid git reference`,
            suggestion: 'Check the ref exists with: git rev-parse --verify <ref>',
          });
        }

        try {
          const diffOutput = runGitDiff(base, head, projectPath, filePath);

          if (!diffOutput.trim()) {
            return errorResponse(404, {
              error: 'no_diff',
              message: `No diff found for file "${filePath}" between ${base} and ${head}`,
              suggestion: 'The file may not have changed between these refs',
            });
          }

          const parsed = parseUnifiedDiff(diffOutput, base, head);
          const file = parsed.files[0];

          if (!file) {
            return errorResponse(404, {
              error: 'no_diff',
              message: `No diff found for file "${filePath}" between ${base} and ${head}`,
              suggestion: 'The file may not have changed between these refs',
            });
          }

          return {
            base,
            head,
            file,
          };
        } catch (err) {
          return errorResponse(500, {
            error: 'git_error',
            message: `Failed to compute file diff: ${err instanceof Error ? err.message : String(err)}`,
            suggestion: 'Ensure the file path and refs are valid',
          });
        }
      },
      {
        query: t.Object({
          base: t.String(),
          head: t.String(),
          path: t.String(),
        }),
      }
    )

    // AC: @review-content-diff-api ac-2 - Context expansion for a file region
    .get(
      '/api/diff/context',
      async ({ query, error: errorResponse, projectContext }) => {
        const { base, head, path: filePath, start, end } = query;

        if (!base || !head || !filePath || !start || !end) {
          return errorResponse(400, {
            error: 'validation_error',
            message: '"base", "head", "path", "start", and "end" query parameters are required',
            suggestion: 'Provide all parameters for context expansion',
          });
        }

        const startLine = parseInt(start, 10);
        const endLine = parseInt(end, 10);

        if (isNaN(startLine) || isNaN(endLine) || startLine < 1 || endLine < startLine) {
          return errorResponse(400, {
            error: 'validation_error',
            message: '"start" and "end" must be positive integers with start <= end',
            suggestion: 'Line numbers are 1-based',
          });
        }

        const projectPath = projectContext.path;

        if (!isValidGitRef(head, projectPath)) {
          return errorResponse(400, {
            error: 'invalid_ref',
            message: `Head ref "${head}" is not a valid git reference`,
            suggestion: 'Check the ref exists with: git rev-parse --verify <ref>',
          });
        }

        try {
          const fileContent = getFileAtCommit(head, filePath, projectPath);

          if (fileContent === null) {
            return errorResponse(404, {
              error: 'file_not_found',
              message: `File "${filePath}" not found at commit ${head}`,
              suggestion: 'Check the file path and commit ref are correct',
            });
          }

          const allLines = fileContent.split('\n');
          // Clamp to file bounds
          const clampedStart = Math.max(1, startLine);
          const clampedEnd = Math.min(allLines.length, endLine);

          const contextLines = allLines
            .slice(clampedStart - 1, clampedEnd)
            .map((content, i) => ({
              lineNumber: clampedStart + i,
              content,
            }));

          return {
            base,
            head,
            path: filePath,
            startLine: clampedStart,
            endLine: clampedEnd,
            totalLines: allLines.length,
            lines: contextLines,
          };
        } catch (err) {
          return errorResponse(500, {
            error: 'git_error',
            message: `Failed to get file context: ${err instanceof Error ? err.message : String(err)}`,
            suggestion: 'Ensure the file path and commit ref are valid',
          });
        }
      },
      {
        query: t.Object({
          base: t.String(),
          head: t.String(),
          path: t.String(),
          start: t.String(),
          end: t.String(),
        }),
      }
    )

    // AC: @review-content-diff-api ac-4 - Review content (plans/specs)
    .get(
      '/api/reviews/:id/content',
      async ({ params, error: errorResponse, projectContext }) => {
        const ctx = await initContext(projectContext.path);
        const reviews = await loadReviewRecords(ctx);
        const review = findReviewByRef(reviews, params.id);

        if (!review) {
          return errorResponse(404, {
            error: 'not_found',
            message: `Review "${params.id}" not found`,
            suggestion: 'Use kspec review list or kspec search to find valid review references',
          });
        }

        const subject = review.subject;

        // Plan content
        if (subject.type === 'plan') {
          const plan = await findPlanByRef(ctx, subject.ref);
          if (!plan) {
            return errorResponse(404, {
              error: 'not_found',
              message: `Plan "${subject.ref}" referenced by review not found`,
              suggestion: 'The plan may have been deleted or the reference is invalid',
            });
          }

          return {
            review_id: review._ulid,
            subject_type: 'plan',
            subject_ref: subject.ref,
            content: {
              title: plan.title,
              sections: [
                {
                  id: 'content',
                  type: 'markdown',
                  title: 'Plan Content',
                  content: plan.content,
                },
                {
                  id: 'specs',
                  type: 'ref_list',
                  title: 'Derived Specs',
                  refs: plan.derived_specs,
                },
                {
                  id: 'tasks',
                  type: 'ref_list',
                  title: 'Derived Tasks',
                  refs: plan.derived_tasks,
                },
                ...(plan.notes && plan.notes.length > 0
                  ? [
                      {
                        id: 'notes',
                        type: 'notes',
                        title: 'Notes',
                        notes: plan.notes,
                      },
                    ]
                  : []),
              ],
            },
          };
        }

        // Spec content
        if (subject.type === 'spec') {
          const items = await loadAllItems(ctx);
          const tasks = await loadAllTasks(ctx);
          const index = new ReferenceIndex(tasks, items);
          const resolved = index.resolve(subject.ref);

          if (!resolved.ok) {
            return errorResponse(404, {
              error: 'not_found',
              message: `Spec "${subject.ref}" referenced by review not found`,
              suggestion: 'The spec may have been deleted or the reference is invalid',
            });
          }

          const specItem = items.find((i) => i._ulid === resolved.ulid);
          if (!specItem) {
            return errorResponse(404, {
              error: 'not_found',
              message: `Spec "${subject.ref}" not found in items`,
              suggestion: 'The reference might point to a task instead of a spec item',
            });
          }

          const sections: Array<{
            id: string;
            type: string;
            title: string;
            content?: string;
            criteria?: Array<{ id: string; given?: string; when?: string; then?: string }>;
            refs?: string[];
            metadata?: Record<string, unknown>;
          }> = [
            {
              id: 'description',
              type: 'markdown',
              title: 'Description',
              content: specItem.description || '',
            },
          ];

          if (specItem.acceptance_criteria && specItem.acceptance_criteria.length > 0) {
            sections.push({
              id: 'acceptance_criteria',
              type: 'acceptance_criteria',
              title: 'Acceptance Criteria',
              criteria: specItem.acceptance_criteria.map((ac) => ({
                id: ac.id,
                given: ac.given,
                when: ac.when,
                then: ac.then,
              })),
            });
          }

          if (specItem.traits && specItem.traits.length > 0) {
            sections.push({
              id: 'traits',
              type: 'ref_list',
              title: 'Traits',
              refs: specItem.traits,
            });
          }

          sections.push({
            id: 'metadata',
            type: 'metadata',
            title: 'Metadata',
            metadata: {
              _ulid: specItem._ulid,
              slugs: specItem.slugs,
              type: specItem.type,
              parent: specItem.parent,
              tags: specItem.tags,
              created_at: specItem.created_at,
            },
          });

          return {
            review_id: review._ulid,
            subject_type: 'spec',
            subject_ref: subject.ref,
            content: {
              title: specItem.title,
              sections,
            },
          };
        }

        // Code reviews don't have entity content — they use the diff endpoints
        if (subject.type === 'code') {
          return {
            review_id: review._ulid,
            subject_type: 'code',
            subject_ref: null,
            content: null,
            diff_params: {
              base: subject.base_commit,
              head: subject.head_commit,
            },
          };
        }

        // Task subject — return task details
        if (subject.type === 'task') {
          const tasks = await loadAllTasks(ctx);
          const items = await loadAllItems(ctx);
          const index = new ReferenceIndex(tasks, items);
          const resolved = index.resolve(subject.ref);

          if (!resolved.ok) {
            return errorResponse(404, {
              error: 'not_found',
              message: `Task "${subject.ref}" referenced by review not found`,
              suggestion: 'The task may have been deleted or the reference is invalid',
            });
          }

          const task = tasks.find((t) => t._ulid === resolved.ulid);
          if (!task) {
            return errorResponse(404, {
              error: 'not_found',
              message: `Task "${subject.ref}" not found`,
            });
          }

          return {
            review_id: review._ulid,
            subject_type: 'task',
            subject_ref: subject.ref,
            content: {
              title: task.title,
              sections: [
                {
                  id: 'description',
                  type: 'markdown',
                  title: 'Description',
                  content: task.description || '',
                },
                ...(task.notes && task.notes.length > 0
                  ? [
                      {
                        id: 'notes',
                        type: 'notes',
                        title: 'Notes',
                        notes: task.notes,
                      },
                    ]
                  : []),
              ],
            },
          };
        }

        // External subject — no structured content available
        return {
          review_id: review._ulid,
          subject_type: subject.type,
          subject_ref: null,
          content: null,
        };
      },
      {
        params: t.Object({
          id: t.String(),
        }),
      }
    );
}
