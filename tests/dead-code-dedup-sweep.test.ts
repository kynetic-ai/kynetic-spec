/**
 * Tests for Dead Code and Deduplication Sweep
 *
 * Verifies that dead code has been removed and utilities have been deduplicated
 * across skill.ts, skill-render.ts, and agents.ts.
 *
 * AC: @dead-code-and-deduplication-sweep ac-1 through ac-5
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  contentsEqual,
  copyDirectory,
  directoriesEqual,
} from "../src/parser/skill-render.js";

const SRC_DIR = path.resolve(import.meta.dirname, "../src");

// AC: @dead-code-and-deduplication-sweep ac-1
describe("ac-1: SkillRenderResult, SkillStatusResult, getSkillSyncStatus removed from skill.ts", () => {
  it("should not contain SkillRenderResult interface", async () => {
    const content = await fs.readFile(
      path.join(SRC_DIR, "cli/commands/skill.ts"),
      "utf-8"
    );
    expect(content).not.toMatch(/interface\s+SkillRenderResult/);
  });

  it("should not contain SkillStatusResult interface", async () => {
    const content = await fs.readFile(
      path.join(SRC_DIR, "cli/commands/skill.ts"),
      "utf-8"
    );
    expect(content).not.toMatch(/interface\s+SkillStatusResult/);
  });

  it("should not contain getSkillSyncStatus function", async () => {
    const content = await fs.readFile(
      path.join(SRC_DIR, "cli/commands/skill.ts"),
      "utf-8"
    );
    expect(content).not.toMatch(/async\s+function\s+getSkillSyncStatus/);
  });

  it("should not export getSkillSyncStatus", async () => {
    const content = await fs.readFile(
      path.join(SRC_DIR, "cli/commands/skill.ts"),
      "utf-8"
    );
    expect(content).not.toContain("getSkillSyncStatus");
  });
});

// AC: @dead-code-and-deduplication-sweep ac-2
describe("ac-2: toKebabCase removed from skill-render.ts", () => {
  it("should not contain toKebabCase function", async () => {
    const content = await fs.readFile(
      path.join(SRC_DIR, "parser/skill-render.ts"),
      "utf-8"
    );
    expect(content).not.toMatch(/function\s+toKebabCase/);
  });
});

// AC: @dead-code-and-deduplication-sweep ac-3
describe("ac-3: EXPECTED_TEMPLATES removed from agents.ts", () => {
  it("should not contain EXPECTED_TEMPLATES constant", async () => {
    const content = await fs.readFile(
      path.join(SRC_DIR, "cli/commands/agents.ts"),
      "utf-8"
    );
    expect(content).not.toMatch(/const\s+EXPECTED_TEMPLATES/);
  });
});

// AC: @dead-code-and-deduplication-sweep ac-4
describe("ac-4: contentsEqual, directoriesEqual, copyDirectory imported from skill-render.ts", () => {
  it("should export contentsEqual from skill-render.ts", () => {
    expect(typeof contentsEqual).toBe("function");
  });

  it("should export directoriesEqual from skill-render.ts", () => {
    expect(typeof directoriesEqual).toBe("function");
  });

  it("should export copyDirectory from skill-render.ts", () => {
    expect(typeof copyDirectory).toBe("function");
  });

  it("should import these functions in skill.ts rather than defining them locally", async () => {
    const content = await fs.readFile(
      path.join(SRC_DIR, "cli/commands/skill.ts"),
      "utf-8"
    );
    // Verify they are imported (from the import block)
    expect(content).toMatch(
      /import\s*\{[^}]*contentsEqual[^}]*\}\s*from\s*["'].*skill-render/
    );
    expect(content).toMatch(
      /import\s*\{[^}]*copyDirectory[^}]*\}\s*from\s*["'].*skill-render/
    );
    expect(content).toMatch(
      /import\s*\{[^}]*directoriesEqual[^}]*\}\s*from\s*["'].*skill-render/
    );

    // Verify no local function definitions for these
    expect(content).not.toMatch(/^async\s+function\s+copyDirectory/m);
    expect(content).not.toMatch(/^function\s+contentsEqual/m);
    expect(content).not.toMatch(/^async\s+function\s+directoriesEqual/m);
  });

  it("contentsEqual correctly compares trimmed strings", () => {
    expect(contentsEqual("hello ", " hello")).toBe(true);
    expect(contentsEqual("hello", "world")).toBe(false);
  });
});

// AC: @dead-code-and-deduplication-sweep ac-5
describe("ac-5: redundant manual defaults removed from skill add/import/install", () => {
  it("should not have hardcoded platform defaults in skill add command", async () => {
    const content = await fs.readFile(
      path.join(SRC_DIR, "cli/commands/skill.ts"),
      "utf-8"
    );
    // The old pattern was: platforms: options.platform && options.platform.length > 0 ? options.platform : ["claude-code"]
    // Now uses conditional spread: ...(options.platform && options.platform.length > 0 && { platforms: options.platform })
    expect(content).not.toMatch(
      /platforms:\s*\n?\s*options\.platform\s*&&\s*options\.platform\.length\s*>\s*0\s*\?\s*options\.platform\s*:\s*\["claude-code"\]/
    );
  });

  it("should not have hardcoded depends_on defaults in skill add command", async () => {
    const content = await fs.readFile(
      path.join(SRC_DIR, "cli/commands/skill.ts"),
      "utf-8"
    );
    // The old pattern was: depends_on: options.dependsOn && options.dependsOn.length > 0 ? options.dependsOn : []
    expect(content).not.toMatch(
      /depends_on:\s*\n?\s*options\.dependsOn\s*&&\s*options\.dependsOn\.length\s*>\s*0\s*\?\s*options\.dependsOn\s*:\s*\[\]/
    );
  });

  it("should not have hardcoded tags defaults in skill add command", async () => {
    const content = await fs.readFile(
      path.join(SRC_DIR, "cli/commands/skill.ts"),
      "utf-8"
    );
    // The old pattern was: tags: options.tag && options.tag.length > 0 ? parseTagsArray(options.tag) : []
    expect(content).not.toMatch(
      /tags:\s*\n?\s*options\.tag\s*&&\s*options\.tag\.length\s*>\s*0\s*\?\s*parseTagsArray\(options\.tag\)\s*:\s*\[\]/
    );
  });

  it("should not have hardcoded defaults in skill import command", async () => {
    const content = await fs.readFile(
      path.join(SRC_DIR, "cli/commands/skill.ts"),
      "utf-8"
    );
    // In import, old pattern had: platforms: ["claude-code"], depends_on: [], tags: []
    // Search for the import section's skillData that has all three hardcoded
    // We check that there's no skillData block with all three defaults together
    const importSection = content.slice(
      content.indexOf("// Build skill object\n"),
      content.indexOf("// Build skill object\n") + 2000
    );
    // The import section should not have standalone depends_on: [] or tags: []
    expect(importSection).not.toMatch(/^\s+depends_on:\s*\[\],?\s*$/m);
    expect(importSection).not.toMatch(/^\s+tags:\s*\[\],?\s*$/m);
  });
});
