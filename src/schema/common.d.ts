import { z } from "zod";
/**
 * ULID pattern - 26 character Crockford base32
 * Excludes I, L, O, U to avoid confusion with 1, 1, 0, V
 */
export declare const ulidPattern: RegExp;
/**
 * Slug pattern - lowercase alphanumeric with hyphens
 */
export declare const slugPattern: RegExp;
/**
 * Reference pattern - @ prefix followed by slug or ULID (or short ULID)
 */
export declare const refPattern: RegExp;
export declare const UlidSchema: z.ZodString;
export declare const SlugSchema: z.ZodString;
export declare const RefSchema: z.ZodString;
export declare const PrioritySchema: z.ZodUnion<[z.ZodEnum<["high", "medium", "low"]>, z.ZodNumber]>;
export declare const DateTimeSchema: z.ZodUnion<[z.ZodString, z.ZodString]>;
export declare const MaturitySchema: z.ZodEnum<["draft", "proposed", "stable", "deferred", "deprecated"]>;
export declare const ImplementationStatusSchema: z.ZodEnum<["not_started", "in_progress", "implemented", "verified"]>;
export declare const TaskStatusSchema: z.ZodEnum<["pending", "in_progress", "pending_review", "blocked", "completed", "cancelled"]>;
export declare const TaskTypeSchema: z.ZodEnum<["epic", "task", "bug", "spike", "infra"]>;
export declare const ItemTypeSchema: z.ZodEnum<["module", "feature", "requirement", "constraint", "decision", "task", "trait"]>;
export declare const VcsRefSchema: z.ZodObject<{
    ref: z.ZodString;
    type: z.ZodOptional<z.ZodEnum<["branch", "tag", "commit"]>>;
}, "strip", z.ZodTypeAny, {
    ref: string;
    type?: "branch" | "tag" | "commit" | undefined;
}, {
    ref: string;
    type?: "branch" | "tag" | "commit" | undefined;
}>;
export type Ulid = z.infer<typeof UlidSchema>;
export type Slug = z.infer<typeof SlugSchema>;
export type Ref = z.infer<typeof RefSchema>;
export type Priority = z.infer<typeof PrioritySchema>;
export type DateTime = z.infer<typeof DateTimeSchema>;
export type Maturity = z.infer<typeof MaturitySchema>;
export type ImplementationStatus = z.infer<typeof ImplementationStatusSchema>;
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type TaskType = z.infer<typeof TaskTypeSchema>;
export type ItemType = z.infer<typeof ItemTypeSchema>;
export type VcsRef = z.infer<typeof VcsRefSchema>;
//# sourceMappingURL=common.d.ts.map