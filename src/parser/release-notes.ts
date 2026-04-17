/**
 * Release notes parser — reads the project's human-authored RELEASE_NOTES.md
 * and exposes helpers for selecting the slice for a single version or an
 * inclusive range of versions.
 *
 * The file format is fixed by the release skill:
 * - Each released version is a level-2 markdown heading of the form
 *   `## vX.Y.Z` (the `v` prefix is optional but canonical).
 * - An optional `## Unreleased` section captures changes staged for the
 *   next release; it is excluded from version lookups and range queries.
 * - Section bodies are free-form markdown up to the next level-2 heading.
 *
 * The parser performs no reformatting — it returns the markdown exactly as
 * authored, so release notes stay a single source of truth for humans and
 * the CLI alike.
 *
 * AC: @release-notes-accessible ac-current-version-notes, ac-version-range-notes,
 *     ac-upgrade-surfaces-notes, ac-notes-mention-new-config
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Canonical filename for release notes. Lives at the repository root and is
 * included in the published npm package (see `files` in package.json).
 */
export const RELEASE_NOTES_FILENAME = "RELEASE_NOTES.md";

/**
 * A single parsed entry from the release notes file.
 *
 * `version` is the normalized semver string (no `v` prefix). The special
 * string `"unreleased"` is used for the Unreleased section.
 *
 * `heading` is the heading text as authored (e.g. `v0.12.0` or `Unreleased`).
 *
 * `body` is the markdown content below the heading, verbatim. It does not
 * include the heading line itself and has a single trailing newline removed.
 */
export interface ReleaseNotesEntry {
  version: string;
  heading: string;
  body: string;
}

/**
 * Result of loading and parsing a release notes file.
 */
export interface ReleaseNotes {
  /** Absolute path to the source file. */
  filePath: string;
  /** Optional preamble — markdown before the first `## ` heading. */
  preamble: string;
  /** Parsed entries in file order (most-recent-first per authoring convention). */
  entries: ReleaseNotesEntry[];
}

/**
 * Structured error emitted by this module. Carries a short code so callers
 * (e.g. the CLI) can render actionable guidance without string matching.
 */
export class ReleaseNotesError extends Error {
  constructor(
    message: string,
    public code: "file_not_found" | "version_not_found" | "invalid_range" | "parse_error",
    public suggestion?: string,
  ) {
    super(message);
    this.name = "ReleaseNotesError";
  }
}

/**
 * Locate the release notes file starting from a project root.
 * Returns the absolute path if it exists, otherwise null.
 */
export async function findReleaseNotesFile(projectDir: string): Promise<string | null> {
  const filePath = path.join(projectDir, RELEASE_NOTES_FILENAME);
  try {
    const stat = await fs.stat(filePath);
    if (stat.isFile()) return filePath;
  } catch {
    // Not present
  }
  return null;
}

/**
 * Normalize a version string for comparison. Accepts `0.12.0`, `v0.12.0`,
 * and the special value `unreleased` (case-insensitive).
 */
export function normalizeVersion(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.toLowerCase() === "unreleased") return "unreleased";
  // Strip a leading `v` or `V`
  return trimmed.replace(/^[vV]/, "");
}

/**
 * Parse a markdown release notes document. Each `## ` heading starts a new
 * entry. The parser preserves the body exactly as authored — it only
 * identifies heading boundaries.
 */
export function parseReleaseNotes(markdown: string, filePath: string): ReleaseNotes {
  const lines = markdown.split(/\r?\n/);

  // Build entries by finding all `## ` (level-2) headings.
  interface HeadingLoc {
    line: number;
    heading: string;
    version: string;
  }
  const headings: HeadingLoc[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^##\s+(.+?)\s*$/);
    if (!m) continue;
    // Skip deeper headings (### ... are level 3)
    if (lines[i].startsWith("### ")) continue;
    const heading = m[1];
    const version = normalizeVersion(heading);
    headings.push({ line: i, heading, version });
  }

  // Preamble is everything before the first heading.
  const preambleEnd = headings.length > 0 ? headings[0].line : lines.length;
  const preamble = lines.slice(0, preambleEnd).join("\n").trimEnd();

  const entries: ReleaseNotesEntry[] = [];
  for (let i = 0; i < headings.length; i++) {
    const start = headings[i].line + 1;
    const end = i + 1 < headings.length ? headings[i + 1].line : lines.length;
    const bodyLines = lines.slice(start, end);
    // Trim trailing blank lines so each entry has predictable spacing.
    while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1].trim() === "") {
      bodyLines.pop();
    }
    entries.push({
      version: headings[i].version,
      heading: headings[i].heading,
      body: bodyLines.join("\n"),
    });
  }

  return { filePath, preamble, entries };
}

/**
 * Load and parse the release notes file at a project root.
 *
 * AC: @release-notes-accessible ac-current-version-notes
 */
export async function loadReleaseNotes(projectDir: string): Promise<ReleaseNotes> {
  const filePath = await findReleaseNotesFile(projectDir);
  if (!filePath) {
    throw new ReleaseNotesError(
      `Release notes file not found: ${path.join(projectDir, RELEASE_NOTES_FILENAME)}`,
      "file_not_found",
      `Create ${RELEASE_NOTES_FILENAME} at the project root. See the release skill for the authoring conventions.`,
    );
  }
  const raw = await fs.readFile(filePath, "utf-8");
  return parseReleaseNotes(raw, filePath);
}

/**
 * Compare two normalized semver strings. Returns negative if a < b, 0 if
 * equal, positive if a > b. The special `"unreleased"` value always sorts
 * after any numeric version.
 */
export function compareVersions(a: string, b: string): number {
  if (a === b) return 0;
  if (a === "unreleased") return 1;
  if (b === "unreleased") return -1;
  const ap = a.split(".").map((n) => Number.parseInt(n, 10));
  const bp = b.split(".").map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const ai = Number.isFinite(ap[i]) ? ap[i] : 0;
    const bi = Number.isFinite(bp[i]) ? bp[i] : 0;
    if (ai !== bi) return ai - bi;
  }
  return 0;
}

/**
 * Return the parsed entry for a single version.
 *
 * AC: @release-notes-accessible ac-current-version-notes
 */
export function getVersionNotes(notes: ReleaseNotes, version: string): ReleaseNotesEntry {
  const target = normalizeVersion(version);
  const entry = notes.entries.find((e) => e.version === target);
  if (!entry) {
    const known = notes.entries.filter((e) => e.version !== "unreleased").map((e) => e.heading);
    throw new ReleaseNotesError(
      `No release notes found for version ${version}`,
      "version_not_found",
      known.length > 0
        ? `Known versions: ${known.join(", ")}`
        : "No versioned entries found in RELEASE_NOTES.md.",
    );
  }
  return entry;
}

/**
 * Return the parsed entries for an inclusive version range, sorted in
 * ascending chronological order (oldest first). Unreleased entries are
 * excluded.
 *
 * AC: @release-notes-accessible ac-version-range-notes
 * AC: @release-notes-accessible ac-upgrade-surfaces-notes
 */
export function getRangeNotes(notes: ReleaseNotes, from: string, to: string): ReleaseNotesEntry[] {
  const lo = normalizeVersion(from);
  const hi = normalizeVersion(to);
  if (lo === "unreleased" || hi === "unreleased") {
    throw new ReleaseNotesError(
      `Range bounds must be released versions, not "unreleased"`,
      "invalid_range",
      `Provide numeric versions for --from and --to (e.g. 0.10.0, 0.12.0).`,
    );
  }
  if (compareVersions(lo, hi) > 0) {
    throw new ReleaseNotesError(
      `Invalid range: --from (${from}) is newer than --to (${to})`,
      "invalid_range",
      `Pass --from as the older version and --to as the newer version.`,
    );
  }

  const inRange = notes.entries.filter((e) => {
    if (e.version === "unreleased") return false;
    return compareVersions(e.version, lo) >= 0 && compareVersions(e.version, hi) <= 0;
  });

  // AC: @release-notes-accessible ac-version-range-notes
  // Chronological order: ascending by version.
  return inRange.slice().sort((a, b) => compareVersions(a.version, b.version));
}

/**
 * Return the entries for every version strictly greater than `from` and up
 * to (and including) `to`. Used by `kspec upgrade` to surface the slice of
 * the notes that applies to a version skew.
 *
 * AC: @release-notes-accessible ac-upgrade-surfaces-notes
 */
export function getInterveningNotes(
  notes: ReleaseNotes,
  from: string | null,
  to: string,
): ReleaseNotesEntry[] {
  const hi = normalizeVersion(to);
  if (hi === "unreleased") {
    throw new ReleaseNotesError(
      `Upgrade target must be a released version, not "unreleased"`,
      "invalid_range",
      `Pass a numeric version as the upgrade target.`,
    );
  }

  const loNorm = from ? normalizeVersion(from) : null;

  const result = notes.entries.filter((e) => {
    if (e.version === "unreleased") return false;
    if (compareVersions(e.version, hi) > 0) return false;
    if (loNorm && compareVersions(e.version, loNorm) <= 0) return false;
    return true;
  });

  return result.slice().sort((a, b) => compareVersions(a.version, b.version));
}

/**
 * Render one entry back to markdown (heading plus body). This preserves the
 * authored content verbatim and is what the CLI prints.
 */
export function renderEntry(entry: ReleaseNotesEntry): string {
  return `## ${entry.heading}\n${entry.body ? entry.body + "\n" : ""}`;
}

/**
 * Render multiple entries back to markdown.
 */
export function renderEntries(entries: ReleaseNotesEntry[]): string {
  return entries.map(renderEntry).join("\n");
}
