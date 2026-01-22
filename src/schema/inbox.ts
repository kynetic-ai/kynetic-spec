import { z } from "zod";
import { DateTimeSchema, UlidSchema } from "./common.js";

/**
 * Inbox item - low-friction capture for ideas that aren't tasks yet.
 * Intentionally simple: just text, timestamp, optional tags, and who added it.
 */
export const InboxItemSchema = z.object({
  _ulid: UlidSchema,
  text: z.string().min(1, "Text is required"),
  created_at: DateTimeSchema,
  tags: z.array(z.string()).default([]),
  added_by: z.string().optional(), // e.g., "@claude", "alice"
});

/**
 * Inbox item input schema (for creating new items)
 */
export const InboxItemInputSchema = z.object({
  _ulid: UlidSchema.optional(),
  text: z.string().min(1, "Text is required"),
  created_at: DateTimeSchema.optional(),
  tags: z.array(z.string()).optional(),
  added_by: z.string().optional(),
});

/**
 * Inbox file schema (collection of inbox items)
 */
export const InboxFileSchema = z.object({
  inbox: z.array(InboxItemSchema),
});

export type InboxItem = z.infer<typeof InboxItemSchema>;
export type InboxItemInput = z.infer<typeof InboxItemInputSchema>;
export type InboxFile = z.infer<typeof InboxFileSchema>;
