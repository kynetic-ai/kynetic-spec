/**
 * Unit tests for the release notes parser.
 *
 * AC: @release-notes-accessible ac-current-version-notes
 * AC: @release-notes-accessible ac-version-range-notes
 * AC: @release-notes-accessible ac-notes-mention-new-config
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  RELEASE_NOTES_FILENAME,
  ReleaseNotesError,
  compareVersions,
  findReleaseNotesFile,
  getInterveningNotes,
  getRangeNotes,
  getVersionNotes,
  loadReleaseNotes,
  normalizeVersion,
  parseReleaseNotes,
  renderEntries,
  renderEntry,
} from "../src/parser/release-notes.js";
import { cleanupTempDir, createTempDir } from "./helpers/cli.js";

const WELL_FORMED = `# kspec Release Notes

Intro paragraph.

## Unreleased

Staged changes.

### New or changed configuration

- \`kspec something-new\` — new thing.

## v0.12.0

Summary paragraph for 0.12.0.

### New or changed configuration

- \`dispatch.publication_mode\` controls how dispatched work is published.

### Breaking changes

- Something broke.

## v0.11.0

Summary paragraph for 0.11.0.

### New or changed configuration

- No new configuration keys.

## v0.10.0

Summary paragraph for 0.10.0.

### New or changed configuration

- Something configurable.
`;

describe("release-notes parser", () => {
  // AC: @release-notes-accessible ac-current-version-notes
  it("parses a well-formed file into version entries", () => {
    const notes = parseReleaseNotes(WELL_FORMED, "/virtual/RELEASE_NOTES.md");
    expect(notes.entries.map((e) => e.version)).toEqual([
      "unreleased",
      "0.12.0",
      "0.11.0",
      "0.10.0",
    ]);
    expect(notes.preamble).toContain("# kspec Release Notes");
  });

  // AC: @release-notes-accessible ac-current-version-notes
  it("preserves body content verbatim", () => {
    const notes = parseReleaseNotes(WELL_FORMED, "/virtual/RELEASE_NOTES.md");
    const twelve = getVersionNotes(notes, "0.12.0");
    expect(twelve.body).toContain("Summary paragraph for 0.12.0.");
    expect(twelve.body).toContain("### New or changed configuration");
    expect(twelve.body).toContain("### Breaking changes");
  });

  // AC: @release-notes-accessible ac-current-version-notes
  it("accepts versions with or without a 'v' prefix", () => {
    const notes = parseReleaseNotes(WELL_FORMED, "/virtual/RELEASE_NOTES.md");
    const a = getVersionNotes(notes, "0.12.0");
    const b = getVersionNotes(notes, "v0.12.0");
    expect(a.version).toBe(b.version);
  });

  it("throws version_not_found for unknown versions with known-version guidance", () => {
    const notes = parseReleaseNotes(WELL_FORMED, "/virtual/RELEASE_NOTES.md");
    let caught: ReleaseNotesError | null = null;
    try {
      getVersionNotes(notes, "99.99.99");
    } catch (err) {
      caught = err as ReleaseNotesError;
    }
    expect(caught).toBeTruthy();
    expect(caught!.code).toBe("version_not_found");
    expect(caught!.suggestion).toContain("v0.12.0");
  });

  // AC: @release-notes-accessible ac-version-range-notes
  it("returns range entries in ascending chronological order", () => {
    const notes = parseReleaseNotes(WELL_FORMED, "/virtual/RELEASE_NOTES.md");
    const range = getRangeNotes(notes, "0.10.0", "0.12.0");
    expect(range.map((e) => e.version)).toEqual([
      "0.10.0",
      "0.11.0",
      "0.12.0",
    ]);
  });

  // AC: @release-notes-accessible ac-version-range-notes
  it("treats range bounds as inclusive", () => {
    const notes = parseReleaseNotes(WELL_FORMED, "/virtual/RELEASE_NOTES.md");
    const range = getRangeNotes(notes, "0.11.0", "0.11.0");
    expect(range.map((e) => e.version)).toEqual(["0.11.0"]);
  });

  it("rejects inverted ranges with actionable guidance", () => {
    const notes = parseReleaseNotes(WELL_FORMED, "/virtual/RELEASE_NOTES.md");
    let caught: ReleaseNotesError | null = null;
    try {
      getRangeNotes(notes, "0.12.0", "0.10.0");
    } catch (err) {
      caught = err as ReleaseNotesError;
    }
    expect(caught).toBeTruthy();
    expect(caught!.code).toBe("invalid_range");
    expect(caught!.suggestion).toMatch(/older/);
  });

  it("excludes Unreleased from range queries", () => {
    const notes = parseReleaseNotes(WELL_FORMED, "/virtual/RELEASE_NOTES.md");
    const range = getRangeNotes(notes, "0.10.0", "0.12.0");
    expect(range.every((e) => e.version !== "unreleased")).toBe(true);
  });

  it("rejects Unreleased as a range bound", () => {
    const notes = parseReleaseNotes(WELL_FORMED, "/virtual/RELEASE_NOTES.md");
    expect(() => getRangeNotes(notes, "unreleased", "0.12.0")).toThrowError(
      ReleaseNotesError,
    );
  });

  // AC: @release-notes-accessible ac-upgrade-surfaces-notes
  it("returns intervening notes: strictly greater than from, up to and including to", () => {
    const notes = parseReleaseNotes(WELL_FORMED, "/virtual/RELEASE_NOTES.md");
    const notesInRange = getInterveningNotes(notes, "0.10.0", "0.12.0");
    expect(notesInRange.map((e) => e.version)).toEqual(["0.11.0", "0.12.0"]);
  });

  // AC: @release-notes-accessible ac-upgrade-surfaces-notes
  it("returns all entries up to target when from is null (unknown source)", () => {
    const notes = parseReleaseNotes(WELL_FORMED, "/virtual/RELEASE_NOTES.md");
    const notesInRange = getInterveningNotes(notes, null, "0.11.0");
    expect(notesInRange.map((e) => e.version)).toEqual(["0.10.0", "0.11.0"]);
  });

  it("returns an empty list when source and target are identical", () => {
    const notes = parseReleaseNotes(WELL_FORMED, "/virtual/RELEASE_NOTES.md");
    const notesInRange = getInterveningNotes(notes, "0.12.0", "0.12.0");
    expect(notesInRange).toEqual([]);
  });

  it("handles a file with no entries", () => {
    const notes = parseReleaseNotes("# Just a title\n", "/virtual/RELEASE_NOTES.md");
    expect(notes.entries).toEqual([]);
    expect(notes.preamble).toBe("# Just a title");
  });

  it("compareVersions orders semver correctly and treats unreleased as newest", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("0.9.0", "0.10.0")).toBeLessThan(0);
    expect(compareVersions("0.12.0", "0.12.0")).toBe(0);
    expect(compareVersions("0.1.2", "0.1.1")).toBeGreaterThan(0);
    expect(compareVersions("unreleased", "99.0.0")).toBeGreaterThan(0);
    expect(compareVersions("99.0.0", "unreleased")).toBeLessThan(0);
  });

  it("normalizeVersion strips a leading v and lower-cases Unreleased", () => {
    expect(normalizeVersion("v0.12.0")).toBe("0.12.0");
    expect(normalizeVersion("V0.12.0")).toBe("0.12.0");
    expect(normalizeVersion("0.12.0")).toBe("0.12.0");
    expect(normalizeVersion("Unreleased")).toBe("unreleased");
  });

  it("renderEntry echoes the authored content verbatim", () => {
    const notes = parseReleaseNotes(WELL_FORMED, "/virtual/RELEASE_NOTES.md");
    const entry = getVersionNotes(notes, "0.10.0");
    const out = renderEntry(entry);
    expect(out).toContain("## v0.10.0");
    expect(out).toContain("Summary paragraph for 0.10.0.");
  });

  it("renderEntries joins multiple entries", () => {
    const notes = parseReleaseNotes(WELL_FORMED, "/virtual/RELEASE_NOTES.md");
    const range = getRangeNotes(notes, "0.10.0", "0.11.0");
    const out = renderEntries(range);
    expect(out.indexOf("v0.10.0")).toBeLessThan(out.indexOf("v0.11.0"));
  });

  describe("loadReleaseNotes (filesystem)", () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await createTempDir("release-notes-parser-");
    });

    afterEach(async () => {
      await cleanupTempDir(tempDir);
    });

    it("loads and parses a real file from disk", async () => {
      const filePath = path.join(tempDir, RELEASE_NOTES_FILENAME);
      await fs.writeFile(filePath, WELL_FORMED, "utf-8");
      const notes = await loadReleaseNotes(tempDir);
      expect(notes.filePath).toBe(filePath);
      expect(notes.entries.map((e) => e.version)).toEqual([
        "unreleased",
        "0.12.0",
        "0.11.0",
        "0.10.0",
      ]);
    });

    it("throws file_not_found when missing, with suggestion", async () => {
      let caught: ReleaseNotesError | null = null;
      try {
        await loadReleaseNotes(tempDir);
      } catch (err) {
        caught = err as ReleaseNotesError;
      }
      expect(caught).toBeTruthy();
      expect(caught!.code).toBe("file_not_found");
      expect(caught!.suggestion).toMatch(/release skill/i);
    });

    it("findReleaseNotesFile returns null when missing", async () => {
      const result = await findReleaseNotesFile(tempDir);
      expect(result).toBeNull();
    });
  });

  // AC: @release-notes-accessible ac-notes-mention-new-config
  // Every versioned entry in the project's RELEASE_NOTES.md must document a
  // "New or changed configuration" subsection so users learn about config
  // keys introduced in that version (even if the answer is "none").
  describe("project RELEASE_NOTES.md", () => {
    it("every versioned entry has a 'New or changed configuration' subsection", async () => {
      const projectRoot = path.resolve(__dirname, "..");
      const notes = await loadReleaseNotes(projectRoot);
      const versioned = notes.entries.filter((e) => e.version !== "unreleased");
      expect(versioned.length).toBeGreaterThan(0);
      for (const entry of versioned) {
        expect(
          entry.body,
          `${entry.heading} missing '### New or changed configuration' section`,
        ).toMatch(/^###\s+New or changed configuration\s*$/m);
      }
    });

    it("every versioned entry has a 'Breaking changes' subsection", async () => {
      const projectRoot = path.resolve(__dirname, "..");
      const notes = await loadReleaseNotes(projectRoot);
      const versioned = notes.entries.filter((e) => e.version !== "unreleased");
      for (const entry of versioned) {
        expect(
          entry.body,
          `${entry.heading} missing '### Breaking changes' section`,
        ).toMatch(/^###\s+Breaking changes\s*$/m);
      }
    });

    it("includes entries for every released kspec version since versioning began", async () => {
      const projectRoot = path.resolve(__dirname, "..");
      const notes = await loadReleaseNotes(projectRoot);
      const versions = notes.entries
        .filter((e) => e.version !== "unreleased")
        .map((e) => e.version);

      // Must cover every release published prior to this change.
      const expected = [
        "0.1.0",
        "0.1.1",
        "0.1.2",
        "0.3.0",
        "0.4.0",
        "0.5.0",
        "0.6.0",
        "0.7.0",
        "0.8.0",
        "0.9.0",
        "0.9.1",
        "0.10.0",
        "0.11.0",
        "0.12.0",
      ];
      for (const ver of expected) {
        expect(versions).toContain(ver);
      }
    });
  });

  // AC: @release-notes-accessible ac-notes-mention-new-config (indirectly)
  // The task also requires the release skill to document the authoring
  // conventions the CLI relies on. Load the rendered release skill and
  // assert the "Maintaining release notes" section exists with the
  // subsections the release workflow enforces.
  describe("release skill", () => {
    it("release skill contains the 'Maintaining release notes' section with required sub-headings", async () => {
      const projectRoot = path.resolve(__dirname, "..");
      // Prefer the source file in .kspec/skills/; fall back to the rendered
      // skill so the test works both in the shadow worktree and in a clean
      // checkout where skills are only available as rendered output.
      const candidates = [
        path.join(projectRoot, ".kspec", "skills", "release", "SKILL.md"),
        path.join(projectRoot, ".agents", "skills", "release", "SKILL.md"),
        path.join(projectRoot, ".claude", "skills", "release", "SKILL.md"),
      ];
      let content: string | null = null;
      for (const candidate of candidates) {
        try {
          content = await fs.readFile(candidate, "utf-8");
          break;
        } catch {
          // Try next candidate
        }
      }
      expect(content, "release skill file not found").toBeTruthy();
      expect(content!).toMatch(/^##\s+Maintaining release notes\s*$/m);
      expect(content!).toMatch(/^###\s+Where the file lives\s*$/m);
      expect(content!).toMatch(/^###\s+Required per-version subsections\s*$/m);
      expect(content!).toMatch(/^###\s+Adding an entry\s*$/m);
      expect(content!).toMatch(/^###\s+Promoting Unreleased at release time\s*$/m);
      expect(content!).toMatch(/^###\s+Pre-release check\s*$/m);
    });
  });
});
