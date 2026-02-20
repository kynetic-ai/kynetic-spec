/**
 * Tests for configurable validation defaults.
 *
 * AC: @config-validation
 *
 * Tests that validation behavior can be configured via kspec.config.yaml:
 * - ac-1: require_acceptance promotes missing AC to errors
 * - ac-2: strict_refs treats dangling refs as errors
 * - ac-3: strict_refs: false treats dangling refs as warnings
 * - ac-4: CLI --strict overrides config strict_refs: false
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { validate } from "../../src/parser/validate.js";
import { initContext, type KspecContext } from "../../src/parser/yaml.js";
import { createTempDir, cleanupTempDir, initGitRepo, testUlid } from "../helpers/cli.js";

describe("Configurable Validation Defaults", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("validate-config-test-");
    initGitRepo(tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  async function setupMinimalProject(): Promise<KspecContext> {
    // Create manifest - use spec/ directory (non-shadow mode for testing)
    const specDir = path.join(tempDir, "spec");
    await fs.mkdir(specDir, { recursive: true });
    await fs.mkdir(path.join(specDir, "modules"), { recursive: true });

    await fs.writeFile(
      path.join(specDir, "kynetic.yaml"),
      `
kynetic: "1.0"
title: Test Project
project:
  name: test
includes:
  - modules/core.yaml
`
    );

    // Create a spec file with an item that has no acceptance criteria
    const specUlid = testUlid("NOAC01");
    await fs.writeFile(
      path.join(specDir, "modules", "core.yaml"),
      `
_ulid: ${specUlid}
title: Feature Without AC
type: feature
slugs:
  - feature-no-ac
description: This feature has no acceptance criteria
`
    );

    // Create tasks file
    await fs.writeFile(
      path.join(specDir, "project.tasks.yaml"),
      `
tasks: []
`
    );

    return await initContext(tempDir);
  }

  async function setupProjectWithDanglingRef(): Promise<KspecContext> {
    // Create manifest - use spec/ directory (non-shadow mode for testing)
    const specDir = path.join(tempDir, "spec");
    await fs.mkdir(specDir, { recursive: true });
    await fs.mkdir(path.join(specDir, "modules"), { recursive: true });

    await fs.writeFile(
      path.join(specDir, "kynetic.yaml"),
      `
kynetic: "1.0"
title: Test Project
project:
  name: test
includes:
  - modules/core.yaml
`
    );

    // Create a spec file
    const specUlid = testUlid("SPEC01");
    await fs.writeFile(
      path.join(specDir, "modules", "core.yaml"),
      `
_ulid: ${specUlid}
title: Some Feature
type: feature
slugs:
  - some-feature
description: A feature
acceptance_criteria:
  - id: ac-1
    given: something
    when: something happens
    then: result
`
    );

    // Create tasks file with dangling ref
    const taskUlid = testUlid("TASK01");
    await fs.writeFile(
      path.join(specDir, "project.tasks.yaml"),
      `
tasks:
  - _ulid: ${taskUlid}
    title: Task with bad ref
    status: pending
    spec_ref: "@nonexistent-spec"
    priority: 3
`
    );

    return await initContext(tempDir);
  }

  // AC: @config-validation ac-1 — require_acceptance promotes missing AC to errors
  describe("require_acceptance", () => {
    it("treats missing AC as warning when require_acceptance is false", async () => {
      const ctx = await setupMinimalProject();

      const result = await validate(ctx, {
        schema: true,
        refs: true,
        completeness: true,
        requireAcceptance: false,
      });

      // Should have warning, not error
      expect(result.completenessWarnings.some(
        w => w.type === "missing_acceptance_criteria"
      )).toBe(true);
      // Schema errors should not include the AC warning
      expect(result.schemaErrors.some(
        e => e.message.includes("no acceptance criteria")
      )).toBe(false);
      // Validation should still pass (warnings don't fail)
      expect(result.valid).toBe(true);
    });

    it("treats missing AC as error when require_acceptance is true", async () => {
      const ctx = await setupMinimalProject();

      const result = await validate(ctx, {
        schema: true,
        refs: true,
        completeness: true,
        requireAcceptance: true,
      });

      // Warning should be promoted to error
      expect(result.completenessWarnings.some(
        w => w.type === "missing_acceptance_criteria"
      )).toBe(false);
      expect(result.schemaErrors.some(
        e => e.message.includes("no acceptance criteria")
      )).toBe(true);
      // Validation should fail
      expect(result.valid).toBe(false);
    });
  });

  // AC: @config-validation ac-2 — strict_refs treats dangling refs as errors
  describe("strict_refs: true", () => {
    it("treats dangling refs as errors when strict_refs is true", async () => {
      const ctx = await setupProjectWithDanglingRef();

      const result = await validate(ctx, {
        schema: true,
        refs: true,
        completeness: true,
        strictRefs: true,
      });

      // Should be an error
      expect(result.refErrors.some(
        e => e.ref === "@nonexistent-spec"
      )).toBe(true);
      // Should not be a warning
      expect(result.refWarnings.some(
        w => w.ref === "@nonexistent-spec"
      )).toBe(false);
      // Validation should fail
      expect(result.valid).toBe(false);
    });
  });

  // AC: @config-validation ac-3 — strict_refs: false treats dangling refs as warnings
  describe("strict_refs: false", () => {
    it("treats dangling refs as warnings when strict_refs is false", async () => {
      const ctx = await setupProjectWithDanglingRef();

      const result = await validate(ctx, {
        schema: true,
        refs: true,
        completeness: true,
        strictRefs: false,
      });

      // Should be a warning, not an error
      expect(result.refWarnings.some(
        w => w.ref === "@nonexistent-spec"
      )).toBe(true);
      // Should not be in errors
      expect(result.refErrors.some(
        e => e.ref === "@nonexistent-spec"
      )).toBe(false);
      // Validation should still pass (dangling refs are just warnings)
      expect(result.valid).toBe(true);
    });
  });

  // AC: @config-validation ac-4 — CLI --strict overrides config strict_refs: false
  describe("CLI --strict override", () => {
    it("default strictRefs behavior is strict (errors)", async () => {
      const ctx = await setupProjectWithDanglingRef();

      // Not passing strictRefs explicitly = undefined = default strict behavior
      const result = await validate(ctx, {
        schema: true,
        refs: true,
        completeness: true,
        // strictRefs not specified - should default to strict
      });

      // Should be an error (default is strict)
      expect(result.refErrors.some(
        e => e.ref === "@nonexistent-spec"
      )).toBe(true);
      expect(result.valid).toBe(false);
    });

    it("strictRefs: true always treats dangling refs as errors", async () => {
      // This simulates CLI --strict overriding config strict_refs: false
      const ctx = await setupProjectWithDanglingRef();

      const result = await validate(ctx, {
        schema: true,
        refs: true,
        completeness: true,
        strictRefs: true, // Explicit true (as if --strict was passed)
      });

      expect(result.refErrors.some(
        e => e.ref === "@nonexistent-spec"
      )).toBe(true);
      expect(result.valid).toBe(false);
    });
  });

  // Combined scenarios
  describe("combined settings", () => {
    it("both strict_refs: false and require_acceptance: true work together", async () => {
      // Setup a project that has both issues - use spec/ directory (non-shadow)
      const specDir = path.join(tempDir, "spec");
      await fs.mkdir(specDir, { recursive: true });
      await fs.mkdir(path.join(specDir, "modules"), { recursive: true });

      await fs.writeFile(
        path.join(specDir, "kynetic.yaml"),
        `
kynetic: "1.0"
title: Test Project
project:
  name: test
includes:
  - modules/core.yaml
`
      );

      const specUlid = testUlid("NOAC02");
      await fs.writeFile(
        path.join(specDir, "modules", "core.yaml"),
        `
_ulid: ${specUlid}
title: Feature Without AC
type: feature
slugs:
  - feature-no-ac
description: No AC here
`
      );

      const taskUlid = testUlid("TASK02");
      await fs.writeFile(
        path.join(specDir, "project.tasks.yaml"),
        `
tasks:
  - _ulid: ${taskUlid}
    title: Task with bad ref
    status: pending
    spec_ref: "@ghost"
    priority: 3
`
      );

      const ctx = await initContext(tempDir);

      const result = await validate(ctx, {
        schema: true,
        refs: true,
        completeness: true,
        strictRefs: false,
        requireAcceptance: true,
      });

      // Dangling ref should be warning (strict_refs: false)
      expect(result.refWarnings.some(w => w.ref === "@ghost")).toBe(true);
      expect(result.refErrors.some(e => e.ref === "@ghost")).toBe(false);

      // Missing AC should be error (require_acceptance: true)
      expect(result.schemaErrors.some(
        e => e.message.includes("no acceptance criteria")
      )).toBe(true);

      // Validation should fail because of require_acceptance error
      expect(result.valid).toBe(false);
    });
  });
});
