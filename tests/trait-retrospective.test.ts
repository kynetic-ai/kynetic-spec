import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupTempDir,
  initGitRepo,
  kspec,
  setupTempFixtures,
  testUlid,
} from "./helpers/cli.js";

describe("Trait Retrospective", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    await initGitRepo(tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @trait-retrospective ac-1
  it("should not warn about orphaned spec when using @trait-retrospective", async () => {
    // Create a retrospective spec with no implementing tasks
    const specUlid = testUlid("SPEC");
    await kspec(
      `item add --under @test-core --type feature --slug retro-feature --title "Retrospective Feature" --description "Already implemented feature"`,
      tempDir,
    );

    // Add the trait
    await kspec(
      `item set @retro-feature --description "Retrospective spec" `,
      tempDir,
    );

    // Manually add trait to the spec (traits array manipulation)
    // Note: In real usage, users would add traits via YAML or trait add command
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const yaml = await import("yaml");

    const corePath = path.join(tempDir, "modules", "core.yaml");
    const coreContent = await fs.readFile(corePath, "utf-8");
    const coreData = yaml.parse(coreContent);

    // Find the feature and add traits array
    const findAndAddTrait = (items: any[]): boolean => {
      for (const item of items) {
        if (item.slugs?.includes("retro-feature")) {
          item.traits = ["@trait-retrospective"];
          item.status = { maturity: "draft", implementation: "not_started" };
          return true;
        }
        if (item.features && findAndAddTrait(item.features)) return true;
      }
      return false;
    };

    findAndAddTrait(coreData.modules || []);
    await fs.writeFile(corePath, yaml.stringify(coreData));

    // Run validation with alignment checks
    const result = await kspec("validate --alignment", tempDir);

    // Should NOT have orphaned_spec warning for retrospective spec
    expect(result.stdout).not.toMatch(/retro-feature/);
    expect(result.stdout).not.toMatch(/no implementing tasks/);
  });

  // AC: @trait-retrospective ac-1
  it("should warn about orphaned spec when NOT using @trait-retrospective", async () => {
    // Create a regular spec with no implementing tasks
    await kspec(
      `item add --under @test-core --type feature --slug regular-feature --title "Regular Feature" --description "Feature without tasks"`,
      tempDir,
    );

    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const yaml = await import("yaml");

    const corePath = path.join(tempDir, "modules", "core.yaml");
    const coreContent = await fs.readFile(corePath, "utf-8");
    const coreData = yaml.parse(coreContent);

    // Set status to not_started
    const findAndSetStatus = (items: any[]): boolean => {
      for (const item of items) {
        if (item.slugs?.includes("regular-feature")) {
          item.status = { maturity: "draft", implementation: "not_started" };
          return true;
        }
        if (item.features && findAndSetStatus(item.features)) return true;
      }
      return false;
    };

    findAndSetStatus(coreData.modules || []);
    await fs.writeFile(corePath, yaml.stringify(coreData));

    // Run validation with alignment checks
    const result = await kspec("validate --alignment", tempDir);

    // Should have orphaned_spec warning for non-retrospective spec
    expect(result.stdout).toMatch(/Orphaned/i);
  });

  // AC: @trait-retrospective ac-2, ac-3
  it("should warn when retrospective spec is implemented without verified_at/verified_by", async () => {
    // Create retrospective spec and set status to implemented
    await kspec(
      `item add --under @test-core --type feature --slug retro-impl --title "Implemented Retrospective" --description "Already done"`,
      tempDir,
    );

    // Add trait and set status to implemented without verification metadata
    await kspec(`item set @retro-impl --trait @trait-retrospective`, tempDir);
    await kspec(
      `item set @retro-impl --status implemented --maturity draft`,
      tempDir,
    );
    // Intentionally omit verified_at and verified_by

    // Run validation with completeness checks
    const result = await kspec("validate --completeness", tempDir);

    // Should warn about missing verification metadata
    expect(result.stdout).toMatch(/retro-impl/);
    expect(result.stdout).toMatch(/verified_at.*verified_by/i);
  });

  // AC: @trait-retrospective ac-2
  it("should not warn when retrospective spec has both verified_at and verified_by", async () => {
    // Create retrospective spec with complete verification metadata
    await kspec(
      `item add --under @test-core --type feature --slug retro-verified --title "Verified Retrospective" --description "Already done and verified"`,
      tempDir,
    );

    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const yaml = await import("yaml");

    const corePath = path.join(tempDir, "modules", "core.yaml");
    const coreContent = await fs.readFile(corePath, "utf-8");
    const coreData = yaml.parse(coreContent);

    // Add trait, status, and verification metadata
    const findAndUpdate = (items: any[]): boolean => {
      for (const item of items) {
        if (item.slugs?.includes("retro-verified")) {
          item.traits = ["@trait-retrospective"];
          item.status = { maturity: "draft", implementation: "implemented" };
          item.verified_at = "2026-01-20T00:00:00Z";
          item.verified_by = "@claude";
          return true;
        }
        if (item.features && findAndUpdate(item.features)) return true;
      }
      return false;
    };

    findAndUpdate(coreData.modules || []);
    await fs.writeFile(corePath, yaml.stringify(coreData));

    // Run validation with completeness checks
    const result = await kspec("validate --completeness", tempDir);

    // Should NOT warn about missing verification metadata for this spec
    expect(result.stdout).not.toMatch(/retro-verified.*verified_at/);
  });

  // AC: @trait-retrospective ac-4
  it("should display retrospective indicator in item get output", async () => {
    // Create retrospective spec with verification metadata
    await kspec(
      `item add --under @test-core --type feature --slug retro-display --title "Display Test" --description "Test display"`,
      tempDir,
    );

    // Add trait, status, and verification metadata
    await kspec(`item set @retro-display --trait @trait-retrospective`, tempDir);
    await kspec(
      `item set @retro-display --status implemented --maturity stable`,
      tempDir,
    );
    await kspec(
      `item set @retro-display --verified-by @claude --verified-at 2026-01-15T12:00:00Z`,
      tempDir,
    );

    // Run item get
    const result = await kspec("item get @retro-display", tempDir);

    // Should display retrospective indicator
    expect(result.stdout).toMatch(/implemented.*retrospective/i);
    // Should display verification info
    expect(result.stdout).toMatch(/Verified:/i);
    expect(result.stdout).toMatch(/2026-01-15/);
    expect(result.stdout).toMatch(/@claude/);
  });

  // AC: @trait-retrospective ac-4
  it("should support --verified-by and --verified-at flags", async () => {
    // Create a spec
    await kspec(
      `item add --under @test-core --type feature --slug flag-test --title "Flag Test" --description "Test flags"`,
      tempDir,
    );

    // Add trait and verification metadata
    await kspec(`item set @flag-test --trait @trait-retrospective`, tempDir);
    await kspec(
      `item set @flag-test --verified-by @agent --verified-at 2026-01-22T10:30:00Z`,
      tempDir,
    );

    // Verify fields are set by checking item get output
    const result = await kspec("item get @flag-test", tempDir);

    expect(result.stdout).toMatch(/Verified:/i);
    expect(result.stdout).toMatch(/2026-01-22/);
    expect(result.stdout).toMatch(/@agent/);
  });

  // AC: @trait-retrospective ac-4
  it("should default verified_at to now when only --verified-by provided", async () => {
    // Create a spec
    await kspec(
      `item add --under @test-core --type feature --slug default-date --title "Default Date Test" --description "Test default date"`,
      tempDir,
    );

    // Add trait
    await kspec(`item set @default-date --trait @trait-retrospective`, tempDir);

    // Use only --verified-by flag (should default verified_at to now)
    const beforeTime = new Date();
    await kspec(`item set @default-date --verified-by @auto`, tempDir);
    const afterTime = new Date();

    // Verify fields are set
    const result = await kspec("item get @default-date", tempDir);

    expect(result.stdout).toMatch(/Verified:/i);
    expect(result.stdout).toMatch(/@auto/);

    // Verify date is today (display only shows date, not time)
    const dateMatch = result.stdout.match(/Verified:\s+(\d{4}-\d{2}-\d{2})/);
    expect(dateMatch).toBeTruthy();
    if (dateMatch) {
      const verifiedDate = dateMatch[1];
      const today = new Date().toISOString().split("T")[0];
      expect(verifiedDate).toBe(today);
    }
  });
});
