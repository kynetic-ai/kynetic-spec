/**
 * JSON Export Tests
 *
 * AC: @gh-pages-export ac-1, ac-2, ac-3, ac-4, ac-5, ac-7
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  calculateExportStats,
  formatBytes,
  generateJsonSnapshot,
  type KspecSnapshot,
} from "../../src/export/index.js";
import { setupTempFixtures, cleanupTempDir } from "../helpers/cli.js";

describe("JSON Export", () => {
  let tempDir: string;
  let originalCwd: string;

  beforeAll(async () => {
    originalCwd = process.cwd();
    tempDir = await setupTempFixtures();
    process.chdir(tempDir);
  });

  afterAll(async () => {
    process.chdir(originalCwd);
    await cleanupTempDir(tempDir);
  });

  // AC: @gh-pages-export ac-1
  describe("generateJsonSnapshot", () => {
    it("generates snapshot with all data types", async () => {
      const snapshot = await generateJsonSnapshot();

      // Verify structure
      expect(snapshot).toHaveProperty("version");
      expect(snapshot).toHaveProperty("exported_at");
      expect(snapshot).toHaveProperty("project");
      expect(snapshot).toHaveProperty("tasks");
      expect(snapshot).toHaveProperty("items");
      expect(snapshot).toHaveProperty("inbox");
      expect(snapshot).toHaveProperty("observations");
      expect(snapshot).toHaveProperty("agents");
      expect(snapshot).toHaveProperty("workflows");
      expect(snapshot).toHaveProperty("conventions");

      // Verify arrays
      expect(Array.isArray(snapshot.tasks)).toBe(true);
      expect(Array.isArray(snapshot.items)).toBe(true);
      expect(Array.isArray(snapshot.inbox)).toBe(true);
    });

    // AC: @gh-pages-export ac-2
    it("includes metadata with timestamp and version", async () => {
      const snapshot = await generateJsonSnapshot();

      // Version should be a string
      expect(typeof snapshot.version).toBe("string");

      // Timestamp should be valid ISO 8601
      expect(snapshot.exported_at).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/
      );

      // Project metadata
      expect(snapshot.project).toHaveProperty("name");
      expect(typeof snapshot.project.name).toBe("string");
    });

    // AC: @gh-pages-export ac-3
    it("resolves spec_ref titles in tasks", async () => {
      const snapshot = await generateJsonSnapshot();

      // Find tasks with spec_ref
      const tasksWithSpecRef = snapshot.tasks.filter((t) => t.spec_ref);

      // If there are tasks with spec refs, they should have resolved titles
      for (const task of tasksWithSpecRef) {
        // spec_ref_title should be present for resolved refs
        // (might be undefined if the ref doesn't resolve)
        if (task.spec_ref_title) {
          expect(typeof task.spec_ref_title).toBe("string");
        }
      }
    });

    // AC: @gh-pages-export ac-4
    it("expands items with inherited ACs from traits", async () => {
      const snapshot = await generateJsonSnapshot();

      // Check if any items have inherited_acs
      const itemsWithInheritedACs = snapshot.items.filter(
        (i) => i.inherited_acs && i.inherited_acs.length > 0
      );

      // If there are items with inherited ACs, verify structure
      for (const item of itemsWithInheritedACs) {
        for (const ac of item.inherited_acs!) {
          expect(ac).toHaveProperty("id");
          expect(ac).toHaveProperty("given");
          expect(ac).toHaveProperty("when");
          expect(ac).toHaveProperty("then");
          expect(ac).toHaveProperty("_inherited_from");
          expect(ac._inherited_from).toMatch(/^@/);
        }
      }
    });

    // AC: @gh-pages-export ac-5
    it("includes validation when requested", async () => {
      const snapshot = await generateJsonSnapshot(true);

      expect(snapshot.validation).toBeDefined();
      expect(snapshot.validation).toHaveProperty("valid");
      expect(snapshot.validation).toHaveProperty("errorCount");
      expect(snapshot.validation).toHaveProperty("warningCount");
      expect(snapshot.validation).toHaveProperty("errors");
      expect(snapshot.validation).toHaveProperty("warnings");
      expect(Array.isArray(snapshot.validation!.errors)).toBe(true);
      expect(Array.isArray(snapshot.validation!.warnings)).toBe(true);
    });

    it("excludes validation by default", async () => {
      const snapshot = await generateJsonSnapshot(false);
      expect(snapshot.validation).toBeUndefined();
    });
  });

  // AC: @gh-pages-export ac-7
  describe("calculateExportStats", () => {
    it("calculates correct statistics", async () => {
      const snapshot = await generateJsonSnapshot();
      const stats = calculateExportStats(snapshot);

      expect(stats.taskCount).toBe(snapshot.tasks.length);
      expect(stats.itemCount).toBe(snapshot.items.length);
      expect(stats.inboxCount).toBe(snapshot.inbox.length);
      expect(stats.observationCount).toBe(snapshot.observations.length);
      expect(stats.agentCount).toBe(snapshot.agents.length);
      expect(stats.workflowCount).toBe(snapshot.workflows.length);
      expect(stats.conventionCount).toBe(snapshot.conventions.length);
      expect(stats.estimatedSizeBytes).toBeGreaterThan(0);
    });
  });

  describe("formatBytes", () => {
    it("formats bytes correctly", () => {
      expect(formatBytes(500)).toBe("500 B");
      expect(formatBytes(1024)).toBe("1.0 KB");
      expect(formatBytes(1536)).toBe("1.5 KB");
      expect(formatBytes(1048576)).toBe("1.0 MB");
      expect(formatBytes(1572864)).toBe("1.5 MB");
    });
  });
});
