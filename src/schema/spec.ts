import { z } from 'zod';
import {
  UlidSchema,
  SlugSchema,
  RefSchema,
  PrioritySchema,
  DateTimeSchema,
  MaturitySchema,
  ImplementationStatusSchema,
  ItemTypeSchema,
} from './common.js';

/**
 * Status block for spec items
 */
export const StatusSchema = z.object({
  maturity: MaturitySchema.default('draft'),
  implementation: ImplementationStatusSchema.default('not_started'),
});

/**
 * Acceptance criteria in Given/When/Then format
 */
export const AcceptanceCriterionSchema = z.object({
  id: z.string(),
  given: z.string(),
  when: z.string(),
  then: z.string(),
});

/**
 * Implementation traceability
 */
export const ImplementationRefSchema = z.object({
  path: z.string(),
  function: z.string().optional(),
  lines: z.string().optional(),
});

/**
 * Traceability block
 */
export const TraceabilitySchema = z.object({
  implementation: z.array(ImplementationRefSchema).optional(),
  tests: z.array(z.object({ path: z.string() })).optional(),
  commits: z.array(z.string()).optional(),
  issues: z.array(z.string()).optional(),
});

/**
 * Full spec item schema
 */
export const SpecItemSchema = z.object({
  // Identity
  _ulid: UlidSchema,
  slugs: z.array(SlugSchema).default([]),
  title: z.string().min(1, 'Title is required'),
  type: ItemTypeSchema.optional(),

  // Status
  status: StatusSchema.optional(),

  // Classification
  priority: PrioritySchema.optional(),
  tags: z.array(z.string()).default([]),

  // Content
  description: z.string().optional(),
  acceptance_criteria: z.array(AcceptanceCriterionSchema).optional(),

  // Relationships (references start with @)
  depends_on: z.array(RefSchema).default([]),
  implements: z.array(RefSchema).default([]),
  relates_to: z.array(RefSchema).default([]),
  tests: z.array(RefSchema).default([]),
  supersedes: RefSchema.nullable().optional(),

  // Traceability
  traceability: TraceabilitySchema.optional(),

  // Lifecycle
  created: DateTimeSchema.optional(),
  created_by: z.string().optional(),
  deprecated_in: z.string().nullable().optional(),
  superseded_by: RefSchema.nullable().optional(),
});

/**
 * Spec item input schema (for creating new items, ULID auto-generated)
 */
export const SpecItemInputSchema = SpecItemSchema.omit({ _ulid: true }).extend({
  _ulid: UlidSchema.optional(),
});

/**
 * Root manifest schema
 */
export const ManifestSchema = z.object({
  kynetic: z.string().default('1.0'),
  project: z.object({
    name: z.string(),
    version: z.string().default('0.1.0'),
    status: MaturitySchema.default('draft'),
  }),

  // Inline items (small projects)
  modules: z.array(z.any()).optional(), // Recursive, define separately if needed
  features: z.array(z.any()).optional(),
  requirements: z.array(z.any()).optional(),
  constraints: z.array(z.any()).optional(),
  decisions: z.array(z.any()).optional(),

  // External references (large projects)
  includes: z.array(z.string()).optional(),

  // Hooks configuration
  hooks: z.record(z.string()).optional(),
});

export type Status = z.infer<typeof StatusSchema>;
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;
export type ImplementationRef = z.infer<typeof ImplementationRefSchema>;
export type Traceability = z.infer<typeof TraceabilitySchema>;
export type SpecItem = z.infer<typeof SpecItemSchema>;
export type SpecItemInput = z.infer<typeof SpecItemInputSchema>;
export type Manifest = z.infer<typeof ManifestSchema>;
