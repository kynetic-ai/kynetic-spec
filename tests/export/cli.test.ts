/**
 * Export CLI Integration Tests
 *
 * AC: @gh-pages-export ac-1, ac-6, ac-7
 * AC: @trait-dry-run ac-1, ac-2, ac-3
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTempDir, kspec, setupTempFixtures } from "../helpers/cli.js";

describe("Export CLI", () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await setupTempFixtures();
  });

  afterAll(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @gh-pages-export ac-7
  // AC: @trait-dry-run ac-1, ac-2, ac-3
  describe("kspec export --dry-run", () => {
    it("shows statistics without writing files", () => {
      const result = kspec("export --format json --dry-run", tempDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Dry Run");
      expect(result.stdout).toContain("Tasks:");
      expect(result.stdout).toContain("Items:");
      expect(result.stdout).toContain("Estimated size:");
    });

    it("shows validation info when --include-validation used", () => {
      const result = kspec(
        "export --format json --dry-run --include-validation",
        tempDir
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Validation:");
      expect(result.stdout).toContain("Status:");
      expect(result.stdout).toContain("Errors:");
    });
  });

  // AC: @gh-pages-export ac-1
  describe("kspec export --format json", () => {
    it("outputs valid JSON to stdout", () => {
      const result = kspec("export --format json", tempDir);

      expect(result.exitCode).toBe(0);

      // Should contain JSON structure
      expect(result.stdout).toContain('"version"');
      expect(result.stdout).toContain('"exported_at"');
      expect(result.stdout).toContain('"tasks"');
      expect(result.stdout).toContain('"items"');
    });

    it("writes to file when --output specified", async () => {
      const outputPath = path.join(tempDir, "export-test.json");

      const result = kspec(
        `export --format json -o "${outputPath}"`,
        tempDir
      );

      expect(result.exitCode).toBe(0);

      // Verify file was created
      const content = await fs.readFile(outputPath, "utf-8");
      const parsed = JSON.parse(content);

      expect(parsed).toHaveProperty("version");
      expect(parsed).toHaveProperty("exported_at");
      expect(parsed).toHaveProperty("tasks");
    });
  });

  // AC: @gh-pages-export ac-6
  describe("kspec export --format html", () => {
    it("requires --output for html format", () => {
      const result = kspec("export --format html", tempDir, { expectFail: true });

      expect(result.exitCode).toBe(2); // USAGE_ERROR
      expect(result.stderr).toContain("requires --output");
    });

    it("generates HTML file", async () => {
      const outputPath = path.join(tempDir, "export-test.html");

      const result = kspec(
        `export --format html -o "${outputPath}"`,
        tempDir
      );

      expect(result.exitCode).toBe(0);

      // Verify file was created
      const content = await fs.readFile(outputPath, "utf-8");

      expect(content).toContain("<!DOCTYPE html>");
      expect(content).toContain("kspec-data");
      expect(content).toContain("window.KSPEC_STATIC_DATA");
    });
  });

  describe("error handling", () => {
    it("rejects invalid format", () => {
      const result = kspec("export --format xml", tempDir, { expectFail: true });

      expect(result.exitCode).toBe(2); // USAGE_ERROR
      expect(result.stderr).toContain("Invalid format");
    });
  });
});
