import { TriageActionSchema } from "../schema/triage.js";

/**
 * Valid triage actions derived from the Zod schema.
 * Single source of truth — use this instead of hardcoding action strings.
 */
export const VALID_ACTIONS: readonly string[] = TriageActionSchema.options;
