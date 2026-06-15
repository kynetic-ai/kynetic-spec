/**
 * CLI Actor Resolution
 *
 * CLI-side adapter over the shared actor-write utility. Resolves and
 * canonicalizes an actor value for a CLI write the same way the daemon routes
 * do: absent values resolve through the author precedence chain, recognized
 * variants persist in canonical form, and values that classify to no configured
 * human or agent identity are rejected with the structured validation feedback
 * printed to the operator.
 *
 * Using this everywhere a CLI command writes an actor field guarantees that CLI
 * writes and daemon writes persist the same canonical value for the same input.
 *
 * AC: @actor-identity-resolution ac-7 — recognized variant persists as canonical id
 * AC: @actor-identity-resolution ac-8 — out-of-pool value rejected with validation feedback
 */

import type { KspecContext } from "../parser/yaml.js";
import { resolveActorForContext } from "../identity/actor-write-context.js";
import { error, isJsonMode } from "./output.js";
import { EXIT_CODES } from "./exit-codes.js";

/**
 * Resolve and canonicalize an actor value for a CLI write, or exit with the
 * rejection feedback. The exit is intercepted in batch/in-process execution
 * (see batch-context.ts) so it surfaces as the command's failure rather than
 * killing the host process.
 *
 * @param ctx      the loaded project context
 * @param explicit the caller-supplied actor value (e.g. `--author`), if any
 * @param field    the actor field name, used in the validation feedback
 * @returns the canonical actor string to persist
 */
export async function resolveCliActor(
  ctx: KspecContext,
  explicit: string | null | undefined,
  field: string,
): Promise<string> {
  const result = await resolveActorForContext(ctx, { explicit, field });
  if (!result.ok) {
    error(
      result.error.message,
      isJsonMode()
        ? { field: result.error.field, reason: result.error.reason, pool: result.error.pool }
        : undefined,
    );
    process.exit(EXIT_CODES.VALIDATION_FAILED);
  }
  return result.actor;
}
