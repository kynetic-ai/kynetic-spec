import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as YAML from "yaml";
import { buildPromptWithSkills } from "../src/agent-runtime/prompts.js";
import {
  formatSkillInvocation,
  resolveSkillReferenceTokensForPlatform,
} from "../src/parser/skill-render.js";
import { cleanupTempDir, createTempDir, testUlid } from "./helpers/cli.js";

describe("Portable skill reference resolution", () => {
  const tempDirs: string[] = [];

  async function createProjectWithMeta(): Promise<string> {
    const tempDir = await createTempDir("kspec-portable-skill-");
    tempDirs.push(tempDir);

    await fs.writeFile(
      path.join(tempDir, "kynetic.yaml"),
      YAML.stringify({ kynetic: "1.0", project: { name: "Portable Skill Test" } }),
    );
    await fs.writeFile(
      path.join(tempDir, "kynetic.meta.yaml"),
      YAML.stringify({
        kynetic_meta: "1.0",
        skills: [
          {
            _ulid: testUlid("SKIL", 1),
            id: "reflect",
            name: "Reflect",
            description: "Core reflect skill",
            origin: "core",
          },
          {
            _ulid: testUlid("SKIL", 2),
            id: "helper",
            name: "Helper",
            description: "Project helper skill",
            origin: "project",
          },
        ],
      }),
    );

    return tempDir;
  }

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((tempDir) => cleanupTempDir(tempDir)));
  });

  // AC: @portable-skill-references ac-1
  it("formats droid core skill invocations with the kspec namespace", () => {
    expect(formatSkillInvocation("reflect", "droid", "core")).toBe("/kspec-reflect");
  });

  // AC: @portable-skill-references ac-2
  it("formats droid project skill invocations without the core namespace", () => {
    expect(formatSkillInvocation("helper", "droid", "project")).toBe("/helper");
  });

  // AC: @portable-skill-references ac-3
  it("resolves portable tokens to droid slash invocations for core skills", () => {
    const origins = new Map([
      ["reflect", "core" as const],
      ["helper", "project" as const],
    ]);

    expect(
      resolveSkillReferenceTokensForPlatform(
        "Use {skill:reflect} and then {skill:helper}.",
        "droid",
        origins,
      ),
    ).toBe("Use /kspec-reflect and then /helper.");
  });

  // AC: @portable-skill-references ac-4
  it("rewrites prompt skill references for the droid ACP adapter", async () => {
    const tempDir = await createProjectWithMeta();
    const skillDir = path.join(tempDir, "skills", "helper");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "# Helper\n\nUse {skill:reflect} and then {skill:helper}.",
    );

    const prompt = await buildPromptWithSkills({
      basePrompt: "Base prompt",
      skillIds: ["helper"],
      specDir: tempDir,
      adapterId: "droid-acp",
    });

    expect(prompt).toContain("/kspec-reflect");
    expect(prompt).toContain("/helper");
    expect(prompt).not.toContain("{skill:reflect}");
    expect(prompt).not.toContain("{skill:helper}");
  });
});
