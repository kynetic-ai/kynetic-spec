import { z } from "zod";
import { UlidSchema } from "./common.js";
import { DispatchOwnershipSchema } from "../sessions/types.js";

const CanonicalUlidSchema = UlidSchema.refine((value) => value === value.toUpperCase(), {
  message: "Canonical ULIDs must use uppercase Crockford base32",
});

export const DispatchControlSourceSchema = z.enum([
  "cli",
  "api",
  "ui",
  "daemon_startup",
  "daemon_shutdown",
  "recovery",
]);

export const DispatchControlAuthoritySchema = z.enum(["stopped", "running", "paused"]);
export const DispatchTaskControlModeSchema = z.enum(["paused", "stopped"]);
export const DispatchCleanupPhaseSchema = z.enum(["owned", "signals_sent", "sessions_closed"]);
export const DispatchCleanupErrorCodeSchema = z.enum([
  "cancellation_timeout",
  "cancellation_failed",
  "session_closure_failed",
  "cleanup_ownership_mismatch",
  "cleanup_process_birth_mismatch",
  "cleanup_leader_missing_group_alive",
  "cleanup_identity_unverifiable",
  "cleanup_group_unverifiable",
  "internal_error",
]);

const TimestampSchema = z.string().datetime({ offset: true });

const ControlMetadataSchema = z
  .object({
    reason: z.string(),
    actor: z.string(),
    source: DispatchControlSourceSchema,
    controlled_at: TimestampSchema,
    updated_at: TimestampSchema,
  })
  .strict();

export const DispatchGlobalControlSchema = z
  .object({
    authority: DispatchControlAuthoritySchema,
    reason: z.string().optional(),
    actor: z.string().optional(),
    source: DispatchControlSourceSchema.optional(),
    controlled_at: TimestampSchema.optional(),
    updated_at: TimestampSchema.optional(),
  })
  .strict();

export const DispatchTaskControlSchema = ControlMetadataSchema.extend({
  mode: DispatchTaskControlModeSchema,
}).strict();

export const DispatchPendingCleanupSchema = z
  .object({
    cleanup_id: CanonicalUlidSchema,
    status: z.enum(["pending", "failed"]),
    phase: DispatchCleanupPhaseSchema,
    error_code: DispatchCleanupErrorCodeSchema.optional(),
    targets: z.array(
      DispatchOwnershipSchema.extend({
        session_metadata_path: z.string().min(1),
      }).strict(),
    ),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.status === "pending" && entry.error_code !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["error_code"],
        message: "Pending cleanup forbids error_code",
      });
    }
    if (entry.status === "failed" && entry.error_code === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["error_code"],
        message: "Failed cleanup requires error_code",
      });
    }
  });

export const DispatchCleanupEntryStatusSchema = z
  .object({
    cleanup_id: CanonicalUlidSchema,
    scope: z.enum(["global", "task"]),
    task_id: CanonicalUlidSchema.optional(),
    status: z.enum(["pending", "failed"]),
    phase: DispatchCleanupPhaseSchema,
    error_code: DispatchCleanupErrorCodeSchema.optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if ((entry.scope === "task") !== (entry.task_id !== undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["task_id"],
        message: "task_id is required exactly for task-scoped cleanup",
      });
    }
    if ((entry.status === "failed") !== (entry.error_code !== undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["error_code"],
        message: "error_code is required exactly for failed cleanup",
      });
    }
  });

export const DispatchCleanupStateSchema = z
  .object({
    status: z.enum(["idle", "pending", "failed"]),
    entries: z.array(DispatchCleanupEntryStatusSchema),
  })
  .strict()
  .superRefine((state, ctx) => {
    const failed = state.entries.some((entry) => entry.status === "failed");
    const expected = state.entries.length === 0 ? "idle" : failed ? "failed" : "pending";
    if (state.status !== expected) {
      ctx.addIssue({ code: "custom", path: ["status"], message: `Expected ${expected} status` });
    }
    const identities = new Set<string>();
    const cleanupIds = new Set<string>();
    for (const [index, entry] of state.entries.entries()) {
      const identity = entry.scope === "global" ? "global" : `task:${entry.task_id}`;
      if (identities.has(identity)) {
        ctx.addIssue({
          code: "custom",
          path: ["entries", index],
          message: "Duplicate cleanup scope identity",
        });
      }
      if (cleanupIds.has(entry.cleanup_id)) {
        ctx.addIssue({
          code: "custom",
          path: ["entries", index, "cleanup_id"],
          message: "Duplicate cleanup_id",
        });
      }
      identities.add(identity);
      cleanupIds.add(entry.cleanup_id);
      if (index > 0) {
        const previous = state.entries[index - 1]!;
        const previousKey = `${previous.scope === "global" ? "0" : `1:${previous.task_id}`}:${previous.cleanup_id}`;
        const currentKey = `${entry.scope === "global" ? "0" : `1:${entry.task_id}`}:${entry.cleanup_id}`;
        if (previousKey.localeCompare(currentKey) > 0) {
          ctx.addIssue({
            code: "custom",
            path: ["entries", index],
            message: "Cleanup entries must be sorted by scope, task_id, and cleanup_id",
          });
        }
      }
    }
  });

const canonicalRecord = <T extends z.ZodTypeAny>(valueSchema: T) =>
  z.record(z.string(), valueSchema).superRefine((record, ctx) => {
    for (const key of Object.keys(record)) {
      const parsed = CanonicalUlidSchema.safeParse(key);
      if (!parsed.success) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "Record keys must be canonical task ULIDs",
        });
      }
    }
  });

const PendingCleanupRecordSchema = z
  .record(z.string(), DispatchPendingCleanupSchema)
  .superRefine((record, ctx) => {
    const cleanupIds = new Set<string>();
    for (const [key, entry] of Object.entries(record)) {
      if (key !== "global" && !CanonicalUlidSchema.safeParse(key).success) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "Cleanup keys must be global or a canonical task ULID",
        });
      }
      if (cleanupIds.has(entry.cleanup_id)) {
        ctx.addIssue({
          code: "custom",
          path: [key, "cleanup_id"],
          message: "Duplicate cleanup_id",
        });
      }
      cleanupIds.add(entry.cleanup_id);
    }
  });

export const DispatchControlSchema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().nonnegative(),
    global: DispatchGlobalControlSchema,
    tasks: canonicalRecord(DispatchTaskControlSchema),
    pending_cleanup: PendingCleanupRecordSchema,
  })
  .strict();

export type DispatchControl = z.infer<typeof DispatchControlSchema>;
export type DispatchGlobalControl = z.infer<typeof DispatchGlobalControlSchema>;
export type DispatchTaskControl = z.infer<typeof DispatchTaskControlSchema>;
export type DispatchPendingCleanup = z.infer<typeof DispatchPendingCleanupSchema>;
export type DispatchCleanupErrorCode = z.infer<typeof DispatchCleanupErrorCodeSchema>;
export type DispatchCleanupEntryStatus = z.infer<typeof DispatchCleanupEntryStatusSchema>;
export type DispatchCleanupState = z.infer<typeof DispatchCleanupStateSchema>;

export function createMissingDispatchControl(): DispatchControl {
  return {
    version: 1,
    revision: 0,
    global: { authority: "stopped" },
    tasks: {},
    pending_cleanup: {},
  };
}
