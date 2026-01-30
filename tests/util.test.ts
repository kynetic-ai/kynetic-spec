import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { kspec, kspecJson, setupTempFixtures, cleanupTempDir } from "./helpers/cli";

describe("Integration: util commands", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  describe("util ulid", () => {
    // AC: @cli-utilities ac-1
    it("should generate a single valid ULID by default", async () => {
      const result = await kspec("util ulid", tempDir);
      expect(result.exitCode).toBe(0);

      // ULID format: 26 chars, Crockford base32
      const ulid = result.stdout.trim();
      expect(ulid).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    });

    // AC: @cli-utilities ac-1
    it("should generate multiple ULIDs with --count option", async () => {
      const result = await kspec("util ulid --count 5", tempDir);
      expect(result.exitCode).toBe(0);

      const ulids = result.stdout.trim().split("\n");
      expect(ulids).toHaveLength(5);

      // Each should be valid ULID format
      for (const ulid of ulids) {
        expect(ulid).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      }

      // All should be unique
      const uniqueUlids = new Set(ulids);
      expect(uniqueUlids.size).toBe(5);
    });

    // AC: @cli-utilities ac-1
    it("should generate multiple ULIDs with -c short option", async () => {
      const result = await kspec("util ulid -c 3", tempDir);
      expect(result.exitCode).toBe(0);

      const ulids = result.stdout.trim().split("\n");
      expect(ulids).toHaveLength(3);
    });

    // AC: @cli-utilities ac-1
    it("should output JSON format with --json flag", async () => {
      const result = await kspecJson<{ ulids: string[] }>("util ulid --count 2", tempDir);

      expect(result.ulids).toHaveLength(2);
      for (const ulid of result.ulids) {
        expect(ulid).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      }
    });

    // AC: @cli-utilities ac-1 (Crockford base32 format)
    it("should generate ULIDs using valid Crockford base32 characters only", async () => {
      // Generate many ULIDs to have a good sample
      const result = await kspec("util ulid --count 10", tempDir);
      expect(result.exitCode).toBe(0);

      const ulids = result.stdout.trim().split("\n");

      // Crockford base32 excludes: I, L, O, U (lowercase variants too)
      const invalidChars = /[ILOUilou]/;

      for (const ulid of ulids) {
        expect(ulid).not.toMatch(invalidChars);
        // Should be all uppercase or digits
        expect(ulid).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      }
    });

    it("should handle invalid count gracefully", async () => {
      // Invalid count should default to 1
      const result = await kspec("util ulid --count abc", tempDir);
      expect(result.exitCode).toBe(0);

      const ulids = result.stdout.trim().split("\n");
      expect(ulids).toHaveLength(1);
    });

    it("should handle zero count as 1", async () => {
      const result = await kspec("util ulid --count 0", tempDir);
      expect(result.exitCode).toBe(0);

      const ulids = result.stdout.trim().split("\n");
      expect(ulids).toHaveLength(1);
    });

    it("should handle negative count as 1", async () => {
      const result = await kspec("util ulid --count -5", tempDir);
      expect(result.exitCode).toBe(0);

      const ulids = result.stdout.trim().split("\n");
      expect(ulids).toHaveLength(1);
    });
  });
});
