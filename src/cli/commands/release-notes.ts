/**
 * Release notes command — displays the human-authored release notes for the
 * currently installed version, or for an inclusive version range.
 *
 * The command reads RELEASE_NOTES.md from the project root (the file is
 * shipped in the published npm package), so the CLI and humans share one
 * source of truth. Output is the authored markdown verbatim — no
 * reformatting, no alternate structured output mode.
 *
 * AC: @release-notes-accessible ac-current-version-notes
 * AC: @release-notes-accessible ac-version-range-notes
 * AC: @release-notes-accessible ac-notes-mention-new-config (validated by
 *     the parser test suite against the project's own RELEASE_NOTES.md)
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { Command } from "commander";
import { EXIT_CODES } from "../exit-codes.js";
import { error, output } from "../output.js";
import {
  ReleaseNotesError,
  getRangeNotes,
  getVersionNotes,
  loadReleaseNotes,
  renderEntries,
  renderEntry,
} from "../../parser/release-notes.js";

/**
 * Resolve the project root where the shipped RELEASE_NOTES.md lives.
 *
 * This file is compiled to `dist/cli/commands/release-notes.js`, so walking
 * three levels up from the module's own file path lands on the package
 * root — which works identically whether kspec is installed from npm or
 * run from a local checkout, and does not depend on process.cwd().
 */
function resolvePackageRoot(): string {
  const here = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(here), "..", "..", "..");
}

/**
 * Get the currently installed kspec version from the shipped package.json.
 */
function getInstalledVersion(): string {
  const require = createRequire(import.meta.url);
  const pkgJson = require("../../../package.json") as { version: string };
  return pkgJson.version;
}

/**
 * Register the `release-notes` top-level command.
 *
 * Usage:
 *   kspec release-notes                       # current installed version
 *   kspec release-notes --from A --to B       # inclusive range
 *
 * AC: @release-notes-accessible ac-current-version-notes
 * AC: @release-notes-accessible ac-version-range-notes
 * AC: @trait-error-guidance ac-1, ac-2, ac-3
 * AC: @trait-semantic-exit-codes ac-1, ac-2, ac-3
 */
export function registerReleaseNotesCommand(program: Command): void {
  program
    .command("release-notes")
    .description(
      "Show release notes for the installed kspec version or a version range",
    )
    .option(
      "--from <version>",
      "Older bound of the inclusive range (e.g. 0.10.0)",
    )
    .option("--to <version>", "Newer bound of the inclusive range (e.g. 0.12.0)")
    .action(async (options: { from?: string; to?: string }) => {
      const fromRaw = options.from;
      const toRaw = options.to;

      // --from and --to must be paired. Accepting only one would silently
      // change the meaning of the command, so reject early with guidance.
      if ((fromRaw && !toRaw) || (!fromRaw && toRaw)) {
        error(
          "--from and --to must be provided together.",
          {
            suggestion:
              "Use both flags to show a range, or omit both to show the current version's notes.",
          },
        );
        process.exit(EXIT_CODES.USAGE_ERROR);
        return;
      }

      const projectRoot = resolvePackageRoot();

      let notes;
      try {
        notes = await loadReleaseNotes(projectRoot);
      } catch (err) {
        handleReleaseNotesError(err);
        return;
      }

      if (fromRaw && toRaw) {
        // AC: @release-notes-accessible ac-version-range-notes
        let entries;
        try {
          entries = getRangeNotes(notes, fromRaw, toRaw);
        } catch (err) {
          handleReleaseNotesError(err);
          return;
        }

        output(
          {
            mode: "range",
            from: fromRaw,
            to: toRaw,
            versions: entries.map((e) => e.version),
            markdown: renderEntries(entries),
          },
          () => {
            if (entries.length === 0) {
              console.log(
                `No release notes in the range ${fromRaw} to ${toRaw}.`,
              );
              return;
            }
            process.stdout.write(renderEntries(entries));
          },
        );
        return;
      }

      // Default: current installed version.
      // AC: @release-notes-accessible ac-current-version-notes
      const currentVersion = getInstalledVersion();
      let entry;
      try {
        entry = getVersionNotes(notes, currentVersion);
      } catch (err) {
        handleReleaseNotesError(err);
        return;
      }

      output(
        {
          mode: "version",
          version: entry.version,
          heading: entry.heading,
          markdown: renderEntry(entry),
        },
        () => {
          process.stdout.write(renderEntry(entry));
        },
      );
    });
}

/**
 * Translate a ReleaseNotesError into an error message + exit code.
 *
 * AC: @trait-error-guidance ac-1, ac-2, ac-3
 * AC: @trait-semantic-exit-codes ac-2, ac-3
 */
function handleReleaseNotesError(err: unknown): never {
  if (err instanceof ReleaseNotesError) {
    error(err.message, err.suggestion ? { suggestion: err.suggestion } : undefined);
    switch (err.code) {
      case "file_not_found":
        process.exit(EXIT_CODES.NOT_FOUND);
      case "version_not_found":
        process.exit(EXIT_CODES.NOT_FOUND);
      case "invalid_range":
        process.exit(EXIT_CODES.USAGE_ERROR);
      case "parse_error":
        process.exit(EXIT_CODES.VALIDATION_FAILED);
    }
  }
  const message = err instanceof Error ? err.message : String(err);
  error(`Failed to load release notes: ${message}`, {
    suggestion:
      "Check that RELEASE_NOTES.md exists at the project root and is readable.",
  });
  process.exit(EXIT_CODES.ERROR);
}
