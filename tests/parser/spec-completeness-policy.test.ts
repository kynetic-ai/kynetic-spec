import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { validate } from "../../src/parser/validate.js";
import { initContext, type KspecContext } from "../../src/parser/yaml.js";
import { cleanupTempDir, createTempDir, initGitRepo, testUlid } from "../helpers/cli.js";

describe("Spec completeness policy", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("spec-completeness-policy-");
    initGitRepo(tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  async function setupProject(itemYaml: string): Promise<KspecContext> {
    const specDir = path.join(tempDir, "spec");
    await fs.mkdir(path.join(specDir, "modules"), { recursive: true });

    await fs.writeFile(
      path.join(specDir, "kynetic.yaml"),
      `
kynetic: "1.0"
title: Test Project
project:
  name: test
includes:
  - modules/items.yaml
`,
    );

    await fs.writeFile(path.join(specDir, "modules", "items.yaml"), itemYaml);
    await fs.writeFile(path.join(specDir, "project.tasks.yaml"), "tasks: []\n");

    return initContext(tempDir);
  }

  // AC: @spec-completeness-policy ac-module-exempt
  it("exempts modules from missing AC and description completeness warnings", async () => {
    const ctx = await setupProject(`
_ulid: ${testUlid("MOD000")}
title: Core Module
type: module
slugs:
  - core-module
`);

    const result = await validate(ctx, { completeness: true });
    const moduleWarnings = result.completenessWarnings.filter(
      (warning) => warning.itemRef === "@core-module",
    );

    expect(moduleWarnings).toHaveLength(0);
  });

  // AC: @spec-completeness-policy ac-feature-required
  it("warns when feature-like items are missing acceptance criteria", async () => {
    const cases = [
      { type: "feature", slug: "feature-without-ac", ulidPrefix: "FEAT00" },
      { type: "requirement", slug: "requirement-without-ac", ulidPrefix: "REQ000" },
      { type: "constraint", slug: "constraint-without-ac", ulidPrefix: "CONS00" },
      { type: "trait", slug: "trait-without-ac", ulidPrefix: "TRAI00" },
    ] as const;

    for (const testCase of cases) {
      const ctx = await setupProject(`
_ulid: ${testUlid(testCase.ulidPrefix)}
title: ${testCase.type} without AC
type: ${testCase.type}
slugs:
  - ${testCase.slug}
description: Missing AC on purpose
`);

      const result = await validate(ctx, { completeness: true });
      const warning = result.completenessWarnings.find(
        (entry) =>
          entry.type === "missing_acceptance_criteria" &&
          entry.itemRef === `@${testCase.slug}`,
      );

      expect(warning?.message).toContain("has no acceptance criteria");
    }
  });

  // AC: @spec-completeness-policy ac-description-required
  it("warns when non-module items are missing descriptions", async () => {
    const ctx = await setupProject(`
_ulid: ${testUlid("DESC00")}
title: Decision Without Description
type: decision
slugs:
  - decision-without-description
acceptance_criteria:
  - id: ac-1
    given: a decision exists
    when: completeness validation runs
    then: it keeps its own acceptance criteria
`);

    const result = await validate(ctx, { completeness: true });
    const warning = result.completenessWarnings.find(
      (entry) =>
        entry.type === "missing_description" &&
        entry.itemRef === "@decision-without-description",
    );

    expect(warning?.message).toContain("has no description");
  });

  // AC: @spec-completeness-policy ac-decision-required
  it("warns when decisions are missing acceptance criteria", async () => {
    const ctx = await setupProject(`
_ulid: ${testUlid("DECI00")}
title: Decision Without AC
type: decision
slugs:
  - decision-without-ac
description: Decisions must still carry rationale in acceptance criteria
`);

    const result = await validate(ctx, { completeness: true });
    const warning = result.completenessWarnings.find(
      (entry) =>
        entry.type === "missing_acceptance_criteria" &&
        entry.itemRef === "@decision-without-ac",
    );

    expect(warning?.message).toContain("has no acceptance criteria");
  });
});
