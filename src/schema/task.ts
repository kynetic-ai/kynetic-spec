import { z } from 'zod';
import {
  UlidSchema,
  SlugSchema,
  RefSchema,
  DateTimeSchema,
  TaskStatusSchema,
  TaskTypeSchema,
  VcsRefSchema,
} from './common.js';

/**
 * Note entry - append-only work log
 */
export const NoteSchema = z.object({
  _ulid: UlidSchema,
  created_at: DateTimeSchema,
  author: z.string().optional(),
  content: z.string(),
  supersedes: UlidSchema.nullable().optional(),
});

/**
 * Todo item - lightweight checklist
 */
export const TodoSchema = z.object({
  id: z.number().int().positive(),
  text: z.string(),
  done: z.boolean().default(false),
  done_at: DateTimeSchema.optional(),
  added_at: DateTimeSchema,
  added_by: z.string().optional(),
  promoted_to: RefSchema.optional(),
});

/**
 * Full task schema
 */
export const TaskSchema = z.object({
  // Identity
  _ulid: UlidSchema,
  slugs: z.array(SlugSchema).default([]),
  title: z.string().min(1, 'Title is required'),
  type: TaskTypeSchema.default('task'),

  // Spec relationship
  spec_ref: RefSchema.nullable().optional(),
  derivation: z.enum(['auto', 'manual']).optional(),

  // State
  status: TaskStatusSchema.default('pending'),
  blocked_by: z.array(z.string()).default([]),
  closed_reason: z.string().nullable().optional(),

  // Dependencies
  depends_on: z.array(RefSchema).default([]),
  context: z.array(RefSchema).default([]),

  // Work metadata
  priority: z.number().int().min(1).max(5).default(3),
  complexity: z.number().int().min(1).max(5).optional(),
  tags: z.array(z.string()).default([]),
  assignee: z.string().nullable().optional(),

  // VCS references
  vcs_refs: z.array(VcsRefSchema).default([]),

  // Timestamps
  created_at: DateTimeSchema,
  started_at: DateTimeSchema.nullable().optional(),
  completed_at: DateTimeSchema.nullable().optional(),

  // Notes (work log)
  notes: z.array(NoteSchema).default([]),

  // Todos (emergent subtasks)
  todos: z.array(TodoSchema).default([]),
});

/**
 * Task input schema (for creating new tasks, some fields auto-generated)
 * All fields except title are optional - defaults will be applied
 */
export const TaskInputSchema = z.object({
  // Identity (auto-generated if not provided)
  _ulid: UlidSchema.optional(),
  slugs: z.array(SlugSchema).optional(),
  title: z.string().min(1, 'Title is required'),
  type: TaskTypeSchema.optional(),

  // Spec relationship
  spec_ref: RefSchema.nullable().optional(),
  derivation: z.enum(['auto', 'manual']).optional(),

  // State
  status: TaskStatusSchema.optional(),
  blocked_by: z.array(z.string()).optional(),
  closed_reason: z.string().nullable().optional(),

  // Dependencies
  depends_on: z.array(RefSchema).optional(),
  context: z.array(RefSchema).optional(),

  // Work metadata
  priority: z.number().int().min(1).max(5).optional(),
  complexity: z.number().int().min(1).max(5).optional(),
  tags: z.array(z.string()).optional(),
  assignee: z.string().nullable().optional(),

  // VCS references
  vcs_refs: z.array(VcsRefSchema).optional(),

  // Timestamps
  created_at: DateTimeSchema.optional(),
  started_at: DateTimeSchema.nullable().optional(),
  completed_at: DateTimeSchema.nullable().optional(),

  // Notes (work log)
  notes: z.array(NoteSchema).optional(),

  // Todos (emergent subtasks)
  todos: z.array(TodoSchema).optional(),
});

/**
 * Tasks file schema (collection of tasks)
 */
export const TasksFileSchema = z.object({
  kynetic_tasks: z.string().default('1.0'),
  tasks: z.array(TaskSchema),
});

export type Note = z.infer<typeof NoteSchema>;
export type Todo = z.infer<typeof TodoSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type TaskInput = z.infer<typeof TaskInputSchema>;
export type TasksFile = z.infer<typeof TasksFileSchema>;
