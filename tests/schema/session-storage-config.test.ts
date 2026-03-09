/**
 * Tests for session storage configuration in manifest schema
 *
 * AC coverage:
 * - @session-storage-modes ac-config: sessions.storage accepts "local" or "branch"
 * - @session-storage-modes ac-config-default: defaults to "local" when not set
 * - @session-storage-modes ac-config-invalid: Zod validation error for unsupported values
 * - @session-storage-modes ac-branch-name: sessions.branch accepts a string
 * - @session-storage-modes ac-branch-name-default: sessions.branch is optional (defaults handled elsewhere)
 */

import { describe, it, expect } from "vitest";
import { ManifestSchema } from "../../src/schema/spec.js";

const baseManifest = {
  kynetic: "1.0",
  project: {
    name: "Test Project",
    version: "1.0.0",
    status: "draft",
  },
};

describe("Session Storage Config in ManifestSchema", () => {
  // AC: @session-storage-modes ac-config
  it('accepts sessions.storage set to "local"', () => {
    const result = ManifestSchema.safeParse({
      ...baseManifest,
      sessions: { storage: "local" },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sessions?.storage).toBe("local");
    }
  });

  // AC: @session-storage-modes ac-config
  it('accepts sessions.storage set to "branch"', () => {
    const result = ManifestSchema.safeParse({
      ...baseManifest,
      sessions: { storage: "branch" },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sessions?.storage).toBe("branch");
    }
  });

  // AC: @session-storage-modes ac-config-default
  it("defaults storage to 'local' when sessions block is present without storage", () => {
    const result = ManifestSchema.safeParse({
      ...baseManifest,
      sessions: {},
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sessions?.storage).toBe("local");
    }
  });

  // AC: @session-storage-modes ac-config-default
  it("defaults sessions.storage to 'local' when sessions block is omitted", () => {
    const result = ManifestSchema.safeParse(baseManifest);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sessions).toEqual({ storage: "local" });
    }
  });

  // AC: @session-storage-modes ac-config-invalid
  it("rejects unsupported sessions.storage value", () => {
    const result = ManifestSchema.safeParse({
      ...baseManifest,
      sessions: { storage: "remote" },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const storageError = result.error.issues.find(
        (issue) => issue.path.includes("storage")
      );
      expect(storageError).toBeDefined();
      expect(storageError!.message).toContain("Invalid enum value");
      expect(storageError!.message).toContain("local");
      expect(storageError!.message).toContain("branch");
    }
  });

  // AC: @session-storage-modes ac-config-invalid
  it("rejects invalid type for sessions.storage", () => {
    const result = ManifestSchema.safeParse({
      ...baseManifest,
      sessions: { storage: 42 },
    });

    expect(result.success).toBe(false);
  });

  // AC: @session-storage-modes ac-branch-name
  it("accepts sessions.branch as a string", () => {
    const result = ManifestSchema.safeParse({
      ...baseManifest,
      sessions: { storage: "branch", branch: "kspec-sessions" },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sessions?.branch).toBe("kspec-sessions");
    }
  });

  // AC: @session-storage-modes ac-branch-name-default
  it("allows sessions.branch to be omitted", () => {
    const result = ManifestSchema.safeParse({
      ...baseManifest,
      sessions: { storage: "branch" },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sessions?.branch).toBeUndefined();
    }
  });

  it("works alongside other manifest fields", () => {
    const result = ManifestSchema.safeParse({
      ...baseManifest,
      sessions: { storage: "branch", branch: "my-sessions" },
      includes: ["modules/main.yaml"],
      hooks: { "pre-commit": "npm test" },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sessions?.storage).toBe("branch");
      expect(result.data.sessions?.branch).toBe("my-sessions");
      expect(result.data.includes).toEqual(["modules/main.yaml"]);
    }
  });
});
