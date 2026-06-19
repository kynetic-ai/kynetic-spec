import type { Elysia } from "elysia";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupTempDir,
  createTempDir,
  createTestApp,
  initGitRepo,
  makeRequest,
} from "./helpers.js";
import { CLI_PATH, kspec as kspecRun, kspecJson, kspecOutput } from "../helpers/cli.js";
import { sectionPlanMarkdown } from "../../src/parser/plan-text-anchors.js";

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

let tempDir: string;
let app: Elysia;

async function setupProject(): Promise<void> {
  tempDir = await createTempDir("kspec-daemon-plan-text-anchors-");
  initGitRepo(tempDir);
  await fs.writeFile(path.join(tempDir, "README.md"), "# Test\n", "utf-8");
  execSync('git add README.md && git commit -m "initial"', {
    cwd: tempDir,
    stdio: "pipe",
  });

  const result = kspecRun("init --no-prompt", tempDir, {
    env: { KSPEC_AUTHOR: "@test" },
  });
  if (result.exitCode !== 0) {
    throw new Error(`kspec init --no-prompt failed: ${result.stderr}`);
  }

  const planContent = "# Intro\nPlan text target\n";
  const contentPath = path.join(tempDir, "anchor-plan.md");
  await fs.writeFile(contentPath, planContent, "utf-8");
  kspecOutput(
    `plan add --title "Anchor Plan" --content-file "${contentPath}" --slug anchor-plan`,
    tempDir,
  );
  kspecOutput('plan publish @anchor-plan --note "Initial revision"', tempDir);
  kspecOutput(
    'review add --title "Plan Review" --subject-type plan --subject-ref @anchor-plan --slug plan-review',
    tempDir,
  );
  kspecOutput(
    'review add --title "Task Review" --subject-type task --subject-ref @task-slug --slug task-review',
    tempDir,
  );
  ({ app } = createTestApp());
}

function request(urlPath: string, init?: RequestInit) {
  return makeRequest(app, tempDir, urlPath, init);
}

describe.runIf(canRunShadowTests)("Daemon plan-text review anchors", () => {
  beforeEach(async () => {
    await setupProject();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @review-plan-text-anchors ac-plan-text-anchor-stored
  // AC: @review-plan-text-anchors ac-span-integrity
  it("creates a plan-text anchor through the comments route", async () => {
    const section = sectionPlanMarkdown("# Intro\nPlan text target\n").find(
      (candidate) => candidate.id === "intro",
    );
    expect(section).toBeDefined();
    const offset = Array.from(section?.content ?? "").indexOf("P");

    const response = await request("/api/reviews/plan-review/comments", {
      method: "POST",
      body: JSON.stringify({
        body: "Anchor this span.",
        kind: "nit",
        anchor: {
          type: "plan_text",
          section: "intro",
          offset,
          quoted_text: "Plan text",
          created_at_rev: 1,
        },
      }),
    });

    expect(response.status).toBe(200);
    const thread = await response.json();
    expect(thread.anchor).toEqual({
      type: "plan_text",
      section: "intro",
      offset,
      quoted_text: "Plan text",
      created_at_rev: 1,
    });
  });

  // AC: @review-plan-text-anchors ac-plan-text-anchor-validation
  // AC: @review-plan-text-anchors ac-nonexistent-revision-rejected
  // AC: @review-plan-text-anchors ac-plan-subject-only
  // AC: @review-plan-text-anchors ac-span-integrity
  it("rejects invalid plan-text anchors through the comments route without storing threads", async () => {
    const before = kspecJson<{ threads: unknown[] }>("review get @plan-review", tempDir);

    const badShape = await request("/api/reviews/plan-review/comments", {
      method: "POST",
      body: JSON.stringify({
        body: "Bad anchor.",
        anchor: {
          type: "plan_text",
          section: "intro",
          offset: -1,
          quoted_text: "Plan text",
          created_at_rev: 1,
        },
      }),
    });
    expect(badShape.status).toBe(400);
    expect(JSON.stringify(await badShape.json())).toContain("anchor.offset");

    const badRevision = await request("/api/reviews/plan-review/comments", {
      method: "POST",
      body: JSON.stringify({
        body: "Bad anchor.",
        anchor: {
          type: "plan_text",
          section: "intro",
          offset: 8,
          quoted_text: "Plan text",
          created_at_rev: 9,
        },
      }),
    });
    expect(badRevision.status).toBe(400);
    expect(JSON.stringify(await badRevision.json())).toContain("created_at_rev");

    const wrongSubject = await request("/api/reviews/task-review/comments", {
      method: "POST",
      body: JSON.stringify({
        body: "Bad anchor.",
        anchor: {
          type: "plan_text",
          section: "intro",
          offset: 8,
          quoted_text: "Plan text",
          created_at_rev: 1,
        },
      }),
    });
    expect(wrongSubject.status).toBe(400);
    expect(JSON.stringify(await wrongSubject.json())).toContain(
      "plan-text anchors apply only to plan-subject reviews",
    );

    const mismatch = await request("/api/reviews/plan-review/comments", {
      method: "POST",
      body: JSON.stringify({
        body: "Bad anchor.",
        anchor: {
          type: "plan_text",
          section: "intro",
          offset: 0,
          quoted_text: "Plan text",
          created_at_rev: 1,
        },
      }),
    });
    expect(mismatch.status).toBe(400);
    expect(JSON.stringify(await mismatch.json())).toContain("quoted_text");

    const after = kspecJson<{ threads: unknown[] }>("review get @plan-review", tempDir);
    expect(after.threads).toHaveLength(before.threads.length);
  });
});
