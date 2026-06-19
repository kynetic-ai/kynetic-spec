import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReviewAnchorSchema, ReviewPlanTextAnchorSchema } from "../src/schema/review-records.js";
import { sectionPlanMarkdown } from "../src/parser/plan-text-anchors.js";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  CLI_PATH,
  kspec as kspecRun,
  kspecJson,
  kspecOutput,
} from "./helpers/cli.js";

const canRunShadowTests = (() => {
  try {
    const version = execSync("git --version", { encoding: "utf-8" }).trim();
    const match = version.match(/(\d+)\.(\d+)/);
    if (!match) return false;
    const [, major, minor] = match.map(Number);
    return (major > 2 || (major === 2 && minor >= 42)) && existsSync(CLI_PATH);
  } catch {
    return false;
  }
})();

async function setupShadowProject(): Promise<string> {
  const projectDir = await createTempDir("kspec-plan-text-anchors-");
  initGitRepo(projectDir);
  await fs.writeFile(path.join(projectDir, "README.md"), "# Test\n", "utf-8");
  execSync('git add README.md && git commit -m "initial"', {
    cwd: projectDir,
    stdio: "pipe",
  });

  const result = kspecRun("init --no-prompt", projectDir, {
    env: { KSPEC_AUTHOR: "@test" },
  });
  if (result.exitCode !== 0) {
    throw new Error(`kspec init --no-prompt failed: ${result.stderr}`);
  }
  return projectDir;
}

function codePointOffset(haystack: string, needle: string): number {
  const codePoints = Array.from(haystack);
  const needleCodePoints = Array.from(needle);
  for (let index = 0; index <= codePoints.length - needleCodePoints.length; index += 1) {
    if (codePoints.slice(index, index + needleCodePoints.length).join("") === needle) {
      return index;
    }
  }
  return -1;
}

describe("Plan text anchors", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await cleanupTempDir(dir);
    }
  });

  // AC: @review-plan-text-anchors ac-deterministic-sectioning
  it("sections markdown deterministically with preamble and duplicate heading suffixes", () => {
    const content = [
      "Opening context\n",
      "\n",
      "# Intro\n",
      "First body\n",
      "## Details\n",
      "Nested body\n",
      "# Intro\n",
      "Second body\n",
    ].join("");

    const first = sectionPlanMarkdown(content);
    const second = sectionPlanMarkdown(content);

    expect(first.map((section) => section.id)).toEqual(["preamble", "intro", "details", "intro-2"]);
    expect(second.map((section) => section.id)).toEqual(first.map((section) => section.id));
    expect(first[0].content).toBe("Opening context\n\n");
    expect(first[1].content).toBe("# Intro\nFirst body\n");
    expect(sectionPlanMarkdown("Only preamble\n").map((section) => section.id)).toEqual([
      "preamble",
    ]);
  });

  // AC: @review-plan-text-anchors ac-plan-text-anchor-stored
  // AC: @review-plan-text-anchors ac-plan-text-anchor-validation
  it("accepts the plan-text anchor shape and rejects invalid shape fields", () => {
    const valid = ReviewPlanTextAnchorSchema.safeParse({
      type: "plan_text",
      section: "intro",
      offset: 3,
      quoted_text: "target",
      created_at_rev: 1,
    });
    expect(valid.success && valid.data).toEqual({
      type: "plan_text",
      section: "intro",
      offset: 3,
      quoted_text: "target",
      created_at_rev: 1,
    });
    expect(ReviewAnchorSchema.safeParse(valid.success && valid.data).success).toBe(true);

    expect(
      ReviewPlanTextAnchorSchema.safeParse({
        type: "plan_text",
        section: "intro",
        offset: -1,
        quoted_text: "target",
        created_at_rev: 1,
      }).success,
    ).toBe(false);
    expect(
      ReviewPlanTextAnchorSchema.safeParse({
        type: "plan_text",
        section: "intro",
        offset: 0,
        quoted_text: "",
        created_at_rev: 1,
      }).success,
    ).toBe(false);
    expect(
      ReviewPlanTextAnchorSchema.safeParse({
        type: "plan_text",
        section: "intro",
        offset: 0,
        quoted_text: "target",
        created_at_rev: 0,
      }).success,
    ).toBe(false);
  });

  it.runIf(canRunShadowTests)(
    "creates and round-trips a CLI plan-text anchor using code-point offsets",
    async () => {
      const projectDir = await setupShadowProject();
      tempDirs.push(projectDir);

      const planContent = "# Intro\n你好🙂 prefix target span\n";
      const contentPath = path.join(projectDir, "anchor-plan.md");
      await fs.writeFile(contentPath, planContent, "utf-8");
      kspecOutput(
        `plan add --title "Anchor Plan" --content-file "${contentPath}" --slug anchor-plan`,
        projectDir,
      );
      kspecOutput('plan publish @anchor-plan --note "Initial revision"', projectDir);
      kspecOutput(
        'review add --title "Plan Review" --subject-type plan --subject-ref @anchor-plan --slug plan-review',
        projectDir,
      );

      const section = sectionPlanMarkdown(planContent).find(
        (candidate) => candidate.id === "intro",
      );
      expect(section).toBeDefined();
      const offset = codePointOffset(section?.content ?? "", "target span");
      expect(offset).toBeGreaterThan(0);

      // AC: @review-plan-text-anchors ac-plan-text-anchor-stored
      // AC: @review-plan-text-anchors ac-span-integrity
      kspecOutput(
        `review comment @plan-review --body "Anchored" --plan-section intro --plan-offset ${offset} --quoted-text "target span" --created-at-rev 1`,
        projectDir,
      );

      const review = kspecJson<{
        threads: Array<{
          anchor: {
            type: string;
            section: string;
            offset: number;
            quoted_text: string;
            created_at_rev: number;
          };
        }>;
      }>("review get @plan-review", projectDir);

      expect(review.threads[0].anchor).toEqual({
        type: "plan_text",
        section: "intro",
        offset,
        quoted_text: "target span",
        created_at_rev: 1,
      });
    },
  );

  it.runIf(canRunShadowTests)(
    "rejects invalid CLI plan-text anchors without storing threads",
    async () => {
      const projectDir = await setupShadowProject();
      tempDirs.push(projectDir);

      const contentPath = path.join(projectDir, "anchor-plan.md");
      await fs.writeFile(contentPath, "# Intro\nTarget text\n", "utf-8");
      kspecOutput(
        `plan add --title "Anchor Plan" --content-file "${contentPath}" --slug anchor-plan`,
        projectDir,
      );
      kspecOutput('plan publish @anchor-plan --note "Initial revision"', projectDir);
      kspecOutput(
        'review add --title "Plan Review" --subject-type plan --subject-ref @anchor-plan --slug plan-review',
        projectDir,
      );
      kspecOutput(
        'review add --title "Task Review" --subject-type task --subject-ref @task-slug --slug task-review',
        projectDir,
      );

      // AC: @review-plan-text-anchors ac-plan-text-anchor-validation
      const badShape = kspecRun(
        'review comment @plan-review --body "Bad" --plan-section intro --plan-offset -1 --quoted-text "Target" --created-at-rev 1',
        projectDir,
        { expectFail: true },
      );
      expect(`${badShape.stderr}\n${badShape.stdout}`).toContain("offset");

      const decimalOffset = kspecRun(
        'review comment @plan-review --body "Bad" --plan-section intro --plan-offset 8.5 --quoted-text "Target" --created-at-rev 1',
        projectDir,
        { expectFail: true },
      );
      expect(`${decimalOffset.stderr}\n${decimalOffset.stdout}`).toContain("offset");
      expect(`${decimalOffset.stderr}\n${decimalOffset.stdout}`).toContain("whole number");

      const partialRevision = kspecRun(
        'review comment @plan-review --body "Bad" --plan-section intro --plan-offset 8 --quoted-text "Target" --created-at-rev 1abc',
        projectDir,
        { expectFail: true },
      );
      expect(`${partialRevision.stderr}\n${partialRevision.stdout}`).toContain("created_at_rev");

      // AC: @review-plan-text-anchors ac-nonexistent-revision-rejected
      const badRevision = kspecRun(
        'review comment @plan-review --body "Bad" --plan-section intro --plan-offset 8 --quoted-text "Target" --created-at-rev 9',
        projectDir,
        { expectFail: true },
      );
      expect(`${badRevision.stderr}\n${badRevision.stdout}`).toContain("created_at_rev");
      expect(`${badRevision.stderr}\n${badRevision.stdout}`).toContain("9");

      // AC: @review-plan-text-anchors ac-plan-subject-only
      const wrongSubject = kspecRun(
        'review comment @task-review --body "Bad" --plan-section intro --plan-offset 8 --quoted-text "Target" --created-at-rev 1',
        projectDir,
        { expectFail: true },
      );
      expect(`${wrongSubject.stderr}\n${wrongSubject.stdout}`).toContain(
        "plan-text anchors apply only to plan-subject reviews",
      );

      // AC: @review-plan-text-anchors ac-span-integrity
      const mismatch = kspecRun(
        'review comment @plan-review --body "Bad" --plan-section intro --plan-offset 0 --quoted-text "Target" --created-at-rev 1',
        projectDir,
        { expectFail: true },
      );
      expect(`${mismatch.stderr}\n${mismatch.stdout}`).toContain("quoted_text");

      const review = kspecJson<{ threads: unknown[] }>("review get @plan-review", projectDir);
      expect(review.threads).toHaveLength(0);
    },
  );
});
