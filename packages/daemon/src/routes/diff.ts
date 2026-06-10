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
 * - @review-content-diff-api ac-5: plan-subject markdown sections carry byte-free plan resource context
 * - @review-content-diff-api ac-6: task-subject description sections carry byte-free task resource context
 */

import { Elysia, t } from "elysia";
import { execFileSync } from "node:child_process";
import type {
  ReviewContentPlanResourceContext,
  ReviewContentTaskResourceContext,
} from "@kynetic-ai/shared";
import {
  initContext,
  loadAllItems,
  findPlanByRef,
  ReferenceIndex,
  resolveTaskDataManager,
  resolveTaskResources,
  projectResolvedTaskResources,
} from "../../parser/index.js";
import { loadResourceManifest } from "../../parser/entity-local-resources.js";
import { getPlanDir } from "../../parser/plan-storage-manager.js";
import { loadReviewRecords, findReviewByRef } from "../../parser/reviews.js";
import { parseUnifiedDiff } from "../../utils/git-diff-parser.js";
import { buildResourcesBaseUrl, toPlanResourceMetadata } from "./plan-resources.js";
import { buildTaskResourcesBaseUrl } from "./task-resources.js";
import { taskStorageIncompatibilityResponse } from "./task-storage-error.js";

// ─── Git Helpers ───

/**
 * Run git diff between two refs and return raw output.
 */
function runGitDiff(base: string, head: string, cwd: string, filePath?: string): string {
  const args = ["diff", `${base}..${head}`];
  if (filePath) {
    args.push("--", filePath);
  }
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large diffs
  });
}

/**
 * Get file content at a specific commit.
 */
function getFileAtCommit(commit: string, filePath: string, cwd: string): string | null {
  try {
    return execFileSync("git", ["show", `${commit}:${filePath}`], {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
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
    execFileSync("git", ["rev-parse", "--verify", ref], {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

// ─── Routes ───

export function createDiffRoutes() {
  return (
    new Elysia()

      // AC: @review-content-diff-api ac-1 - Full diff with file list, stats, and structured hunks
      .get(
        "/api/diff",
        async ({ query, set, projectContext }) => {
          const { base, head } = query;

          if (!base || !head) {
            set.status = 400;
            return {
              error: "validation_error",
              message: 'Both "base" and "head" query parameters are required',
              suggestion:
                "Provide base and head commit refs, e.g. GET /api/diff?base=abc123&head=def456",
            };
          }

          const projectPath = projectContext.path;

          // Validate refs exist
          if (!isValidGitRef(base, projectPath)) {
            set.status = 400;
            return {
              error: "invalid_ref",
              message: `Base ref "${base}" is not a valid git reference`,
              suggestion: "Check the ref exists with: git rev-parse --verify <ref>",
            };
          }

          if (!isValidGitRef(head, projectPath)) {
            set.status = 400;
            return {
              error: "invalid_ref",
              message: `Head ref "${head}" is not a valid git reference`,
              suggestion: "Check the ref exists with: git rev-parse --verify <ref>",
            };
          }

          try {
            const diffOutput = runGitDiff(base, head, projectPath);
            const parsed = parseUnifiedDiff(diffOutput, base, head);
            return parsed;
          } catch (err) {
            set.status = 500;
            return {
              error: "git_error",
              message: `Failed to compute diff: ${err instanceof Error ? err.message : String(err)}`,
              suggestion: "Ensure both refs are valid and the repository is accessible",
            };
          }
        },
        {
          query: t.Object({
            base: t.String(),
            head: t.String(),
          }),
        },
      )

      // AC: @review-content-diff-api ac-3 - Single file diff for lazy loading
      .get(
        "/api/diff/file",
        async ({ query, set, projectContext }) => {
          const { base, head, path: filePath } = query;

          if (!base || !head || !filePath) {
            set.status = 400;
            return {
              error: "validation_error",
              message: '"base", "head", and "path" query parameters are required',
              suggestion:
                "Provide all parameters, e.g. GET /api/diff/file?base=abc&head=def&path=src/index.ts",
            };
          }

          const projectPath = projectContext.path;

          if (!isValidGitRef(base, projectPath)) {
            set.status = 400;
            return {
              error: "invalid_ref",
              message: `Base ref "${base}" is not a valid git reference`,
              suggestion: "Check the ref exists with: git rev-parse --verify <ref>",
            };
          }

          if (!isValidGitRef(head, projectPath)) {
            set.status = 400;
            return {
              error: "invalid_ref",
              message: `Head ref "${head}" is not a valid git reference`,
              suggestion: "Check the ref exists with: git rev-parse --verify <ref>",
            };
          }

          try {
            const diffOutput = runGitDiff(base, head, projectPath, filePath);

            if (!diffOutput.trim()) {
              set.status = 404;
              return {
                error: "no_diff",
                message: `No diff found for file "${filePath}" between ${base} and ${head}`,
                suggestion: "The file may not have changed between these refs",
              };
            }

            const parsed = parseUnifiedDiff(diffOutput, base, head);
            const file = parsed.files[0];

            if (!file) {
              set.status = 404;
              return {
                error: "no_diff",
                message: `No diff found for file "${filePath}" between ${base} and ${head}`,
                suggestion: "The file may not have changed between these refs",
              };
            }

            return {
              base,
              head,
              file,
            };
          } catch (err) {
            set.status = 500;
            return {
              error: "git_error",
              message: `Failed to compute file diff: ${err instanceof Error ? err.message : String(err)}`,
              suggestion: "Ensure the file path and refs are valid",
            };
          }
        },
        {
          query: t.Object({
            base: t.String(),
            head: t.String(),
            path: t.String(),
          }),
        },
      )

      // AC: @review-content-diff-api ac-2 - Context expansion for a file region
      .get(
        "/api/diff/context",
        async ({ query, set, projectContext }) => {
          const { base, head, path: filePath, start, end } = query;

          if (!base || !head || !filePath || !start || !end) {
            set.status = 400;
            return {
              error: "validation_error",
              message: '"base", "head", "path", "start", and "end" query parameters are required',
              suggestion: "Provide all parameters for context expansion",
            };
          }

          const startLine = parseInt(start, 10);
          const endLine = parseInt(end, 10);

          if (isNaN(startLine) || isNaN(endLine) || startLine < 1 || endLine < startLine) {
            set.status = 400;
            return {
              error: "validation_error",
              message: '"start" and "end" must be positive integers with start <= end',
              suggestion: "Line numbers are 1-based",
            };
          }

          const projectPath = projectContext.path;

          if (!isValidGitRef(head, projectPath)) {
            set.status = 400;
            return {
              error: "invalid_ref",
              message: `Head ref "${head}" is not a valid git reference`,
              suggestion: "Check the ref exists with: git rev-parse --verify <ref>",
            };
          }

          try {
            const fileContent = getFileAtCommit(head, filePath, projectPath);

            if (fileContent === null) {
              set.status = 404;
              return {
                error: "file_not_found",
                message: `File "${filePath}" not found at commit ${head}`,
                suggestion: "Check the file path and commit ref are correct",
              };
            }

            const allLines = fileContent.split("\n");
            // Clamp to file bounds
            const clampedStart = Math.max(1, startLine);
            const clampedEnd = Math.min(allLines.length, endLine);

            const contextLines = allLines.slice(clampedStart - 1, clampedEnd).map((content, i) => ({
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
            set.status = 500;
            return {
              error: "git_error",
              message: `Failed to get file context: ${err instanceof Error ? err.message : String(err)}`,
              suggestion: "Ensure the file path and commit ref are valid",
            };
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
        },
      )

      // AC: @review-content-diff-api ac-4 - Review content (plans/specs)
      .get(
        "/api/reviews/:id/content",
        async ({ params, set, projectContext }) => {
          // AC: @shadow-lazy-read-sync ac-daemon-bypass — skip drift-check on daemon reads
          const ctx = await initContext(projectContext.path, { syncMode: "skip" });
          const reviews = await loadReviewRecords(ctx);
          const review = findReviewByRef(reviews, params.id);

          if (!review) {
            set.status = 404;
            return {
              error: "not_found",
              message: `Review "${params.id}" not found`,
              suggestion: "Use kspec review list or kspec search to find valid review references",
            };
          }

          const subject = review.subject;

          // Plan content
          if (subject.type === "plan") {
            const plan = await findPlanByRef(ctx, subject.ref);
            if (!plan) {
              set.status = 404;
              return {
                error: "not_found",
                message: `Plan "${subject.ref}" referenced by review not found`,
                suggestion: "The plan may have been deleted or the reference is invalid",
              };
            }

            // AC: @review-content-diff-api ac-5 — byte-free plan resource
            // context for the embedded plan markdown. Mirrors the plan detail
            // contract: the declared manifest metadata (never bytes) plus the
            // plan-scoped bytes base URL clients extend with selected-project
            // routing browser-side. Only declared resources appear, so clients
            // can rewrite declared safe paths and must leave undeclared or
            // unsafe paths visible. A missing manifest (legacy layout) yields
            // no context; an unreadable one degrades to content-without-context
            // rather than failing the whole review content response.
            let planResourceContext: ReviewContentPlanResourceContext | undefined;
            try {
              const manifest = await loadResourceManifest(getPlanDir(ctx, plan._ulid));
              if (manifest.resources.length > 0) {
                planResourceContext = {
                  owner_type: "plan",
                  owner_ref: subject.ref,
                  resources_base_url: buildResourcesBaseUrl(plan._ulid),
                  resources: manifest.resources.map((r) => toPlanResourceMetadata(r)),
                };
              }
            } catch {
              // Corrupt/unreadable manifest — serve plan content without
              // resource context; the plan resource routes surface the error.
            }

            return {
              review_id: review._ulid,
              subject_type: "plan",
              subject_ref: subject.ref,
              content: {
                title: plan.title,
                sections: [
                  {
                    id: "content",
                    type: "markdown",
                    title: "Plan Content",
                    content: plan.content,
                    ...(planResourceContext ? { resource_context: planResourceContext } : {}),
                  },
                  {
                    id: "specs",
                    type: "ref_list",
                    title: "Derived Specs",
                    refs: plan.derived_specs,
                  },
                  {
                    id: "tasks",
                    type: "ref_list",
                    title: "Derived Tasks",
                    refs: plan.derived_tasks,
                  },
                  ...(plan.notes && plan.notes.length > 0
                    ? [
                        {
                          id: "notes",
                          type: "notes",
                          title: "Notes",
                          notes: plan.notes,
                        },
                      ]
                    : []),
                ],
              },
            };
          }

          // Spec content
          if (subject.type === "spec") {
            const items = await loadAllItems(ctx);
            // AC: @api-contract ac-task-storage-incompatibility-* — translate the
            // storage error into a structured 409 instead of a 500.
            let tasks;
            try {
              tasks = await resolveTaskDataManager(ctx).loadAllTasks(ctx);
            } catch (err) {
              const conflict = taskStorageIncompatibilityResponse(err);
              if (conflict) {
                set.status = conflict.status;
                return conflict.body;
              }
              throw err;
            }
            const index = new ReferenceIndex(tasks, items);
            const resolved = index.resolve(subject.ref);

            if (!resolved.ok) {
              set.status = 404;
              return {
                error: "not_found",
                message: `Spec "${subject.ref}" referenced by review not found`,
                suggestion: "The spec may have been deleted or the reference is invalid",
              };
            }

            const specItem = items.find((i) => i._ulid === resolved.ulid);
            if (!specItem) {
              set.status = 404;
              return {
                error: "not_found",
                message: `Spec "${subject.ref}" not found in items`,
                suggestion: "The reference might point to a task instead of a spec item",
              };
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
                id: "description",
                type: "markdown",
                title: "Description",
                content: specItem.description || "",
              },
            ];

            if (specItem.acceptance_criteria && specItem.acceptance_criteria.length > 0) {
              sections.push({
                id: "acceptance_criteria",
                type: "acceptance_criteria",
                title: "Acceptance Criteria",
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
                id: "traits",
                type: "ref_list",
                title: "Traits",
                refs: specItem.traits,
              });
            }

            sections.push({
              id: "metadata",
              type: "metadata",
              title: "Metadata",
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
              subject_type: "spec",
              subject_ref: subject.ref,
              content: {
                title: specItem.title,
                sections,
              },
            };
          }

          // Code reviews don't have entity content — they use the diff endpoints
          if (subject.type === "code") {
            return {
              review_id: review._ulid,
              subject_type: "code",
              subject_ref: null,
              content: null,
              diff_params: {
                base: subject.base_commit,
                head: subject.head_commit,
              },
            };
          }

          // Task subject — return task details
          if (subject.type === "task") {
            // AC: @api-contract ac-task-storage-incompatibility-not-not-found —
            // do not collapse the storage error into a task-ref not_found here.
            let tasks;
            try {
              tasks = await resolveTaskDataManager(ctx).loadAllTasks(ctx);
            } catch (err) {
              const conflict = taskStorageIncompatibilityResponse(err);
              if (conflict) {
                set.status = conflict.status;
                return conflict.body;
              }
              throw err;
            }
            const items = await loadAllItems(ctx);
            const index = new ReferenceIndex(tasks, items);
            const resolved = index.resolve(subject.ref);

            if (!resolved.ok) {
              set.status = 404;
              return {
                error: "not_found",
                message: `Task "${subject.ref}" referenced by review not found`,
                suggestion: "The task may have been deleted or the reference is invalid",
              };
            }

            const task = tasks.find((tk) => tk._ulid === resolved.ulid);
            if (!task) {
              set.status = 404;
              return {
                error: "not_found",
                message: `Task "${subject.ref}" not found`,
              };
            }

            // AC: @review-content-diff-api ac-6 — byte-free task resource
            // context for the embedded task description. Reuses the same
            // resolver path as the task detail API (resolveTaskResources +
            // projectResolvedTaskResources) so drift semantics are identical:
            // the projection covers plan-owned refs and materialized
            // task-owned copies, and reports per-reference status so clients
            // rewrite only `present` resources while surfacing drifted/
            // missing/unresolved/unmatched references instead of silently
            // serving replacement bytes.
            let taskResourceContext: ReviewContentTaskResourceContext | undefined;
            if (task.resource_refs && task.resource_refs.length > 0) {
              const resolvedResources = await resolveTaskResources(ctx, task);
              const projected = projectResolvedTaskResources(resolvedResources);
              if (projected.length > 0) {
                taskResourceContext = {
                  owner_type: "task",
                  owner_ref: subject.ref,
                  resources_base_url: buildTaskResourcesBaseUrl(task._ulid),
                  resources: projected,
                };
              }
            }

            return {
              review_id: review._ulid,
              subject_type: "task",
              subject_ref: subject.ref,
              content: {
                title: task.title,
                sections: [
                  {
                    id: "description",
                    type: "markdown",
                    title: "Description",
                    content: task.description || "",
                    ...(taskResourceContext ? { resource_context: taskResourceContext } : {}),
                  },
                  ...(task.notes && task.notes.length > 0
                    ? [
                        {
                          id: "notes",
                          type: "notes",
                          title: "Notes",
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
        },
      )
  );
}
