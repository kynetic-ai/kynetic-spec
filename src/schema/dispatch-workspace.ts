import { z } from "zod";
import { DateTimeSchema, RefSchema, SlugSchema } from "./common.js";

export const DispatchWorkspaceBranchOwnershipSchema = z.enum(["dispatcher-managed", "adopted"]);

export const DispatchWorkspaceBranchProvenanceSchema = z.object({
  ownership: DispatchWorkspaceBranchOwnershipSchema,
  source: z.string().min(1, "Branch provenance source is required"),
  remote_ref: z.string().nullable().optional(),
  adopted_from: z.string().nullable().optional(),
  adopted_at: DateTimeSchema.nullable().optional(),
  rehydrated: z.boolean().nullable().optional(),
});

export const DispatchWorkspaceLifecycleStateSchema = z.enum([
  "provisioning",
  "ready",
  "active",
  "stale",
  "integrating",
  "closing",
  "cleanup_blocked",
  "closed",
]);

export const DispatchWorkspaceHealthStatusSchema = z.enum(["healthy", "stale", "invalid"]);

export const DispatchWorkspaceBootstrapStatusSchema = z.enum(["not_run", "succeeded", "failed"]);

export const DispatchWorkspaceIntegrationStatusSchema = z.enum([
  "pending",
  "in_progress",
  "merged",
  "abandoned",
  "reset",
]);

export const DispatchWorkspaceCleanupStatusSchema = z.enum([
  "not_scheduled",
  "scheduled",
  "blocked",
  "completed",
]);

export const DispatchWorkspaceRoleSchema = z.enum(["worker", "reviewer"]);

export const DispatchWorkspaceBranchModeSchema = z.enum(["branch", "detached"]);

export const DispatchWorkspacePublicationModeSchema = z.enum(["pull_request", "manual_merge"]);

export const DispatchWorkspaceIntegrationOutcomeSchema = z.enum([
  "pending",
  "pull_request",
  "manual_merge",
  "merged",
  "abandoned",
  "reset",
]);

export const DispatchWorkspaceIssueSchema = z.object({
  code: z.string().min(1, "Issue code is required"),
  message: z.string().min(1, "Issue message is required"),
  suggestion: z.string().nullable().optional(),
});

export const DispatchWorkspaceWorktreeSchema = z.object({
  path: z.string().min(1, "Worktree path is required"),
  branch_mode: DispatchWorkspaceBranchModeSchema,
  branch_ref: z.string().nullable().optional(),
  head: z.string().nullable().optional(),
  last_seen_at: DateTimeSchema.nullable().optional(),
});

export const DispatchWorkspaceBootstrapStepResultSchema = z.object({
  source: z.enum(["dispatch", "agent"]),
  name: z.string().min(1, "Bootstrap step name is required"),
  run: z.string().min(1, "Bootstrap step command is required"),
  idempotent: z.boolean(),
  allowTrackedChanges: z.boolean(),
  reviewerRerunAllowed: z.boolean(),
  status: z.enum(["succeeded", "failed", "skipped"]),
  role: DispatchWorkspaceRoleSchema,
  output: z.string().nullable().optional(),
});

export const DispatchWorkspaceBootstrapRoleStateSchema = z.object({
  status: DispatchWorkspaceBootstrapStatusSchema.default("not_run"),
  configHash: z.string().nullable().optional(),
  canonicalBranchHead: z.string().nullable().optional(),
  lastRunAt: DateTimeSchema.nullable().optional(),
  invalidationReasons: z.array(z.string()).default([]),
  steps: z.array(DispatchWorkspaceBootstrapStepResultSchema).default([]),
  failureMessage: z.string().nullable().optional(),
});

export const DispatchWorkspaceBootstrapStateSchema =
  DispatchWorkspaceBootstrapRoleStateSchema.extend({
    lastRole: DispatchWorkspaceRoleSchema.nullable().optional(),
    roleStates: z
      .object({
        worker: DispatchWorkspaceBootstrapRoleStateSchema,
        reviewer: DispatchWorkspaceBootstrapRoleStateSchema,
      })
      .default({
        worker: {
          status: "not_run",
          configHash: null,
          canonicalBranchHead: null,
          lastRunAt: null,
          invalidationReasons: [],
          steps: [],
          failureMessage: null,
        },
        reviewer: {
          status: "not_run",
          configHash: null,
          canonicalBranchHead: null,
          lastRunAt: null,
          invalidationReasons: [],
          steps: [],
          failureMessage: null,
        },
      }),
  });

export const DispatchWorkspaceIntegrationStateSchema = z.object({
  status: DispatchWorkspaceIntegrationStatusSchema.default("pending"),
  target_branch: z.string().min(1, "Target branch is required"),
  target_commit: z.string().min(1, "Target commit is required"),
  publication_mode: DispatchWorkspacePublicationModeSchema,
  outcome: DispatchWorkspaceIntegrationOutcomeSchema,
  detail: z.string().nullable().optional(),
  updated_at: DateTimeSchema,
});

export const DispatchWorkspaceHealthStateSchema = z.object({
  status: DispatchWorkspaceHealthStatusSchema,
  summary: z.string().min(1, "Health summary is required"),
  issues: z.array(DispatchWorkspaceIssueSchema).default([]),
  updated_at: DateTimeSchema,
});

export const DispatchWorkspaceCleanupStateSchema = z.object({
  status: DispatchWorkspaceCleanupStatusSchema.default("not_scheduled"),
  eligible: z.boolean().default(false),
  reason: z.string().nullable().optional(),
  detail: z.string().nullable().optional(),
  updated_at: DateTimeSchema,
});

export const DispatchWorkspaceTimestampsSchema = z.object({
  created_at: DateTimeSchema,
  updated_at: DateTimeSchema,
  last_reconciled_at: DateTimeSchema.nullable().optional(),
  last_active_at: DateTimeSchema.nullable().optional(),
  closed_at: DateTimeSchema.nullable().optional(),
});

export const DispatchWorkspaceRecordSchema = z.object({
  workspace_id: z.string().min(1, "Workspace ID is required"),
  /**
   * Canonical full task ULID — the authoritative identity for this workspace.
   * Optional for backward compatibility with historical records persisted
   * before canonical task identity was recorded separately from `task_ref`;
   * such records are backfilled (resolvable) or classified stale (unresolvable)
   * on load. New records always populate it.
   * AC: @dispatch-canonical-task-identity ac-workspace-registry-canonical-task-identity
   * AC: @dispatch-canonical-task-identity ac-historical-workspace-records-normalize-or-stale
   */
  task_id: z.string().min(1, "Task ID must be a non-empty ULID").optional(),
  /** Display task ref (slug or @ULID); never an identity key. */
  task_ref: RefSchema,
  task_slug: SlugSchema,
  worktree_root: z.string().min(1, "Worktree root is required"),
  resolved_base_branch: z.string().min(1, "Resolved base branch is required"),
  base_branch_point: z.string().min(1, "Base branch point is required"),
  canonical_branch: z.string().min(1, "Canonical branch is required"),
  canonical_branch_head: z.string().min(1, "Canonical branch head is required"),
  branch_provenance: DispatchWorkspaceBranchProvenanceSchema.optional().default({
    ownership: "dispatcher-managed",
    source: "provisioned",
    remote_ref: null,
    adopted_from: null,
    adopted_at: null,
    rehydrated: null,
  }),
  lifecycle_state: DispatchWorkspaceLifecycleStateSchema,
  active_role: DispatchWorkspaceRoleSchema.nullable().optional(),
  worktrees: z.object({
    worker: DispatchWorkspaceWorktreeSchema,
    reviewer: DispatchWorkspaceWorktreeSchema.nullable().optional(),
  }),
  bootstrap: DispatchWorkspaceBootstrapStateSchema,
  integration: DispatchWorkspaceIntegrationStateSchema,
  health: DispatchWorkspaceHealthStateSchema,
  cleanup: DispatchWorkspaceCleanupStateSchema,
  timestamps: DispatchWorkspaceTimestampsSchema,
});

export const DispatchWorkspaceRegistryFileSchema = z.object({
  kynetic_dispatch_workspaces: z.string().default("1.0"),
  workspaces: z.array(DispatchWorkspaceRecordSchema).default([]),
});

export type DispatchWorkspaceLifecycleState = z.infer<typeof DispatchWorkspaceLifecycleStateSchema>;
export type DispatchWorkspaceHealthStatus = z.infer<typeof DispatchWorkspaceHealthStatusSchema>;
export type DispatchWorkspaceBootstrapStatus = z.infer<
  typeof DispatchWorkspaceBootstrapStatusSchema
>;
export type DispatchWorkspaceIntegrationStatus = z.infer<
  typeof DispatchWorkspaceIntegrationStatusSchema
>;
export type DispatchWorkspaceCleanupStatus = z.infer<typeof DispatchWorkspaceCleanupStatusSchema>;
export type DispatchWorkspaceRole = z.infer<typeof DispatchWorkspaceRoleSchema>;
export type DispatchWorkspaceBranchMode = z.infer<typeof DispatchWorkspaceBranchModeSchema>;
export type DispatchWorkspacePublicationMode = z.infer<
  typeof DispatchWorkspacePublicationModeSchema
>;
export type DispatchWorkspaceIntegrationOutcome = z.infer<
  typeof DispatchWorkspaceIntegrationOutcomeSchema
>;
export type DispatchWorkspaceBranchOwnership = z.infer<
  typeof DispatchWorkspaceBranchOwnershipSchema
>;
export type DispatchWorkspaceBranchProvenance = z.infer<
  typeof DispatchWorkspaceBranchProvenanceSchema
>;
export type DispatchWorkspaceIssue = z.infer<typeof DispatchWorkspaceIssueSchema>;
export type DispatchWorkspaceWorktree = z.infer<typeof DispatchWorkspaceWorktreeSchema>;
export type DispatchWorkspaceBootstrapStepResult = z.infer<
  typeof DispatchWorkspaceBootstrapStepResultSchema
>;
export type DispatchWorkspaceBootstrapRoleState = z.infer<
  typeof DispatchWorkspaceBootstrapRoleStateSchema
>;
export type DispatchWorkspaceBootstrapState = z.infer<typeof DispatchWorkspaceBootstrapStateSchema>;
export type DispatchWorkspaceIntegrationState = z.infer<
  typeof DispatchWorkspaceIntegrationStateSchema
>;
export type DispatchWorkspaceHealthState = z.infer<typeof DispatchWorkspaceHealthStateSchema>;
export type DispatchWorkspaceCleanupState = z.infer<typeof DispatchWorkspaceCleanupStateSchema>;
export type DispatchWorkspaceTimestamps = z.infer<typeof DispatchWorkspaceTimestampsSchema>;
export type DispatchWorkspaceRecord = z.infer<typeof DispatchWorkspaceRecordSchema>;
export type DispatchWorkspaceRegistryFile = z.infer<typeof DispatchWorkspaceRegistryFileSchema>;
