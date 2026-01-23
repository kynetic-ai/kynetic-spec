import { z } from "zod";
// Common types used across spec and task schemas
/**
 * ULID pattern - 26 character Crockford base32
 * Excludes I, L, O, U to avoid confusion with 1, 1, 0, V
 */
export const ulidPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
/**
 * Slug pattern - lowercase alphanumeric with hyphens
 */
export const slugPattern = /^[a-z][a-z0-9-]*$/;
/**
 * Reference pattern - @ prefix followed by slug or ULID (or short ULID)
 */
export const refPattern = /^@[a-zA-Z0-9-]+$/;
// Base schemas
export const UlidSchema = z.string().regex(ulidPattern, "Invalid ULID format");
export const SlugSchema = z.string().regex(slugPattern, "Invalid slug format");
export const RefSchema = z
    .string()
    .regex(refPattern, "Invalid reference format");
// Priority can be string or number
export const PrioritySchema = z.union([
    z.enum(["high", "medium", "low"]),
    z.number().int().min(1).max(5),
]);
// ISO 8601 date or datetime
export const DateTimeSchema = z.union([
    z.string().datetime(),
    z.string().date(),
]);
// Maturity status
export const MaturitySchema = z.enum([
    "draft",
    "proposed",
    "stable",
    "deferred",
    "deprecated",
]);
// Implementation status
export const ImplementationStatusSchema = z.enum([
    "not_started",
    "in_progress",
    "implemented",
    "verified",
]);
// Task status
export const TaskStatusSchema = z.enum([
    "pending",
    "in_progress",
    "pending_review",
    "blocked",
    "completed",
    "cancelled",
]);
// Task type
export const TaskTypeSchema = z.enum(["epic", "task", "bug", "spike", "infra"]);
// Item type
export const ItemTypeSchema = z.enum([
    "module",
    "feature",
    "requirement",
    "constraint",
    "decision",
    "task",
    "trait",
]);
// VCS reference
export const VcsRefSchema = z.object({
    ref: z.string(),
    type: z.enum(["branch", "tag", "commit"]).optional(),
});
//# sourceMappingURL=common.js.map