/**
 * Session migrate command.
 *
 * AC: @session-legacy-migration ac-migration-copy ac-migration-idempotent
 * Copies session directories from .kspec/sessions/ to .kspec-sessions/.
 * Does not delete originals. Idempotent — skips sessions that already exist.
 */

import { initContext } from "../../../parser/index.js";
import { hasLegacySessions, migrateLegacySessions } from "../../../sessions/legacy.js";
import { EXIT_CODES } from "../../exit-codes.js";
import { error, output } from "../../output.js";

export async function sessionMigrateAction(): Promise<void> {
  try {
    const ctx = await initContext();

    // Check if there are legacy sessions to migrate
    const hasLegacy = await hasLegacySessions(ctx.specDir);
    if (!hasLegacy) {
      output({ migrated: 0, skipped: 0, message: "No legacy sessions found" }, () => {
        console.log("No legacy sessions found in .kspec/sessions/.");
      });
      return;
    }

    // AC: @session-legacy-migration ac-migration-copy ac-migration-idempotent
    const result = await migrateLegacySessions(ctx.sessionsDir, ctx.specDir);

    output(result, () => {
      if (result.migrated > 0) {
        console.log(
          `Migrated ${result.migrated} session(s) from .kspec/sessions/ to .kspec-sessions/.`,
        );
        for (const id of result.migratedIds) {
          console.log(`  + ${id}`);
        }
      }

      if (result.skipped > 0) {
        console.log(`Skipped ${result.skipped} session(s) (already exist in .kspec-sessions/).`);
      }

      if (result.migrated === 0 && result.skipped > 0) {
        console.log("All legacy sessions already migrated.");
      }

      console.log("\nNote: Original sessions in .kspec/sessions/ were not deleted.");
    });
  } catch (err) {
    error("Failed to migrate sessions", err);
    process.exit(EXIT_CODES.ERROR);
  }
}
