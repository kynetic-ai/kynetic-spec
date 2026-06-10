/**
 * Tests for diff content API endpoint logic
 *
 * Spec: @review-content-diff-api
 *
 * Tests the git diff parser, context extraction, and review content
 * route handlers.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Elysia } from "elysia";
import { stringify as yamlStringify } from "yaml";
import { parseUnifiedDiff } from "../src/utils/git-diff-parser";
import { createTempDir, cleanupTempDir, initGitRepo, testUlid, seedSplitTask } from "./helpers/cli";
import { projectContextMiddleware } from "../dist/daemon/middleware/project-context.js";
import { createDiffRoutes } from "../dist/daemon/routes/diff.js";
// Register split backend in the dist module space (routes use dist, not src)
import { ensureSplitBackendRegistered } from "../dist/parser/split-backend.js";
ensureSplitBackendRegistered();

describe("parseUnifiedDiff", () => {
  // AC: @review-content-diff-api ac-1
  it("should parse a simple file modification diff", () => {
    const diffOutput = `diff --git a/src/index.ts b/src/index.ts
index abc1234..def5678 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,5 +1,6 @@
 import { foo } from './foo';

-const x = 1;
+const x = 2;
+const y = 3;

 export { foo };
`;

    const result = parseUnifiedDiff(diffOutput, "abc123", "def456");

    expect(result.base).toBe("abc123");
    expect(result.head).toBe("def456");
    expect(result.files).toHaveLength(1);
    expect(result.stats.totalFiles).toBe(1);
    expect(result.stats.totalAdditions).toBe(2);
    expect(result.stats.totalDeletions).toBe(1);

    const file = result.files[0];
    expect(file.oldPath).toBe("src/index.ts");
    expect(file.newPath).toBe("src/index.ts");
    expect(file.status).toBe("modified");
    expect(file.stats.additions).toBe(2);
    expect(file.stats.deletions).toBe(1);
    expect(file.hunks).toHaveLength(1);

    const hunk = file.hunks[0];
    expect(hunk.oldStart).toBe(1);
    expect(hunk.oldCount).toBe(5);
    expect(hunk.newStart).toBe(1);
    expect(hunk.newCount).toBe(6);

    // Check change lines have correct types and line numbers
    const changes = hunk.changes;
    const added = changes.filter((c) => c.type === "added");
    const deleted = changes.filter((c) => c.type === "deleted");
    const unchanged = changes.filter((c) => c.type === "unchanged");

    expect(added).toHaveLength(2);
    expect(deleted).toHaveLength(1);
    expect(unchanged.length).toBeGreaterThan(0);

    // Verify line numbers on added lines
    for (const line of added) {
      expect(line.oldLineNumber).toBeNull();
      expect(line.newLineNumber).toBeGreaterThan(0);
    }

    // Verify line numbers on deleted lines
    for (const line of deleted) {
      expect(line.oldLineNumber).toBeGreaterThan(0);
      expect(line.newLineNumber).toBeNull();
    }

    // Verify line numbers on unchanged lines
    for (const line of unchanged) {
      expect(line.oldLineNumber).toBeGreaterThan(0);
      expect(line.newLineNumber).toBeGreaterThan(0);
    }
  });

  // AC: @review-content-diff-api ac-1
  it("should parse a new file diff", () => {
    const diffOutput = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,3 @@
+export const newThing = true;
+
+export function hello() {}
`;

    const result = parseUnifiedDiff(diffOutput, "abc", "def");

    expect(result.files).toHaveLength(1);
    const file = result.files[0];
    expect(file.status).toBe("added");
    expect(file.stats.additions).toBe(3);
    expect(file.stats.deletions).toBe(0);
    expect(file.hunks).toHaveLength(1);
  });

  // AC: @review-content-diff-api ac-1
  it("should parse a deleted file diff", () => {
    const diffOutput = `diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
index abc1234..0000000
--- a/src/old.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-export const oldThing = true;
-
-export function goodbye() {}
`;

    const result = parseUnifiedDiff(diffOutput, "abc", "def");

    expect(result.files).toHaveLength(1);
    const file = result.files[0];
    expect(file.status).toBe("deleted");
    expect(file.stats.additions).toBe(0);
    expect(file.stats.deletions).toBe(3);
  });

  // AC: @review-content-diff-api ac-1
  it("should parse multi-file diffs", () => {
    const diffOutput = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 line1
+added line
 line2
 line3
diff --git a/src/b.ts b/src/b.ts
index 333..444 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,3 +1,2 @@
 line1
-removed line
 line3
`;

    const result = parseUnifiedDiff(diffOutput, "abc", "def");

    expect(result.files).toHaveLength(2);
    expect(result.stats.totalFiles).toBe(2);
    expect(result.stats.totalAdditions).toBe(1);
    expect(result.stats.totalDeletions).toBe(1);

    expect(result.files[0].newPath).toBe("src/a.ts");
    expect(result.files[0].stats.additions).toBe(1);
    expect(result.files[0].stats.deletions).toBe(0);

    expect(result.files[1].newPath).toBe("src/b.ts");
    expect(result.files[1].stats.additions).toBe(0);
    expect(result.files[1].stats.deletions).toBe(1);
  });

  // AC: @review-content-diff-api ac-1
  it("should parse multiple hunks in a single file", () => {
    const diffOutput = `diff --git a/src/multi.ts b/src/multi.ts
index 111..222 100644
--- a/src/multi.ts
+++ b/src/multi.ts
@@ -1,3 +1,4 @@
 line1
+added at top
 line2
 line3
@@ -10,3 +11,4 @@
 line10
+added at bottom
 line11
 line12
`;

    const result = parseUnifiedDiff(diffOutput, "abc", "def");

    expect(result.files).toHaveLength(1);
    expect(result.files[0].hunks).toHaveLength(2);
    expect(result.files[0].hunks[0].oldStart).toBe(1);
    expect(result.files[0].hunks[1].oldStart).toBe(10);
    expect(result.files[0].stats.additions).toBe(2);
  });

  // AC: @review-content-diff-api ac-1
  it("should return empty files array for empty diff", () => {
    const result = parseUnifiedDiff("", "abc", "def");

    expect(result.files).toHaveLength(0);
    expect(result.stats.totalFiles).toBe(0);
    expect(result.stats.totalAdditions).toBe(0);
    expect(result.stats.totalDeletions).toBe(0);
  });

  // AC: @review-content-diff-api ac-1
  it("should handle renamed files", () => {
    const diffOutput = `diff --git a/old-name.ts b/new-name.ts
similarity index 90%
rename from old-name.ts
rename to new-name.ts
index 111..222 100644
--- a/old-name.ts
+++ b/new-name.ts
@@ -1,3 +1,3 @@
 line1
-old content
+new content
 line3
`;

    const result = parseUnifiedDiff(diffOutput, "abc", "def");

    expect(result.files).toHaveLength(1);
    const file = result.files[0];
    expect(file.status).toBe("renamed");
    expect(file.oldPath).toBe("old-name.ts");
    expect(file.newPath).toBe("new-name.ts");
  });

  // AC: @review-content-diff-api ac-1
  it("should track line numbers correctly through a hunk", () => {
    const diffOutput = `diff --git a/src/test.ts b/src/test.ts
index 111..222 100644
--- a/src/test.ts
+++ b/src/test.ts
@@ -5,7 +5,8 @@
 line5
 line6
-line7old
+line7new
+line7extra
 line8
 line9
 line10
`;

    const result = parseUnifiedDiff(diffOutput, "abc", "def");
    const changes = result.files[0].hunks[0].changes;

    // line5: unchanged, old=5, new=5
    expect(changes[0]).toEqual({
      type: "unchanged",
      content: "line5",
      oldLineNumber: 5,
      newLineNumber: 5,
    });

    // line6: unchanged, old=6, new=6
    expect(changes[1]).toEqual({
      type: "unchanged",
      content: "line6",
      oldLineNumber: 6,
      newLineNumber: 6,
    });

    // deleted line7old: old=7, new=null
    expect(changes[2]).toEqual({
      type: "deleted",
      content: "line7old",
      oldLineNumber: 7,
      newLineNumber: null,
    });

    // added line7new: old=null, new=7
    expect(changes[3]).toEqual({
      type: "added",
      content: "line7new",
      oldLineNumber: null,
      newLineNumber: 7,
    });

    // added line7extra: old=null, new=8
    expect(changes[4]).toEqual({
      type: "added",
      content: "line7extra",
      oldLineNumber: null,
      newLineNumber: 8,
    });

    // line8: unchanged, old=8, new=9
    expect(changes[5]).toEqual({
      type: "unchanged",
      content: "line8",
      oldLineNumber: 8,
      newLineNumber: 9,
    });
  });
});

describe("Diff API - Git Integration", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-diff-test-");
    initGitRepo(tempDir);

    // Create initial commit
    await fs.writeFile(
      path.join(tempDir, "file1.ts"),
      "const x = 1;\nconst y = 2;\nconst z = 3;\n",
    );
    await fs.writeFile(
      path.join(tempDir, "file2.ts"),
      'export const a = "hello";\nexport const b = "world";\n',
    );
    execSync('git add -A && git commit -m "initial"', { cwd: tempDir, stdio: "pipe" });

    // Create second commit with changes
    await fs.writeFile(
      path.join(tempDir, "file1.ts"),
      "const x = 1;\nconst y = 42;\nconst z = 3;\n",
    );
    await fs.writeFile(path.join(tempDir, "file3.ts"), "export const newFile = true;\n");
    execSync('git add -A && git commit -m "changes"', { cwd: tempDir, stdio: "pipe" });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @review-content-diff-api ac-1
  it("should parse real git diff output between commits", () => {
    const commits = execSync('git log --format="%H" --reverse', {
      cwd: tempDir,
      encoding: "utf-8",
    })
      .trim()
      .split("\n");

    const base = commits[0];
    const head = commits[1];

    const diffOutput = execSync(`git diff ${base}..${head}`, {
      cwd: tempDir,
      encoding: "utf-8",
    });

    const result = parseUnifiedDiff(diffOutput, base, head);

    // Should have 2 files: file1.ts (modified) and file3.ts (added)
    expect(result.files.length).toBe(2);
    expect(result.stats.totalFiles).toBe(2);

    const modifiedFile = result.files.find((f) => f.newPath === "file1.ts");
    expect(modifiedFile).toBeDefined();
    expect(modifiedFile!.status).toBe("modified");
    expect(modifiedFile!.stats.additions).toBe(1);
    expect(modifiedFile!.stats.deletions).toBe(1);

    const newFile = result.files.find((f) => f.newPath === "file3.ts");
    expect(newFile).toBeDefined();
    expect(newFile!.status).toBe("added");
    expect(newFile!.stats.additions).toBe(1);
  });

  // AC: @review-content-diff-api ac-3
  it("should parse single-file diff from git", () => {
    const commits = execSync('git log --format="%H" --reverse', {
      cwd: tempDir,
      encoding: "utf-8",
    })
      .trim()
      .split("\n");

    const base = commits[0];
    const head = commits[1];

    const diffOutput = execSync(`git diff ${base}..${head} -- file1.ts`, {
      cwd: tempDir,
      encoding: "utf-8",
    });

    const result = parseUnifiedDiff(diffOutput, base, head);

    expect(result.files).toHaveLength(1);
    expect(result.files[0].newPath).toBe("file1.ts");
    expect(result.files[0].status).toBe("modified");
  });

  // AC: @review-content-diff-api ac-2
  it("should extract context lines from file at commit", () => {
    const head = execSync("git rev-parse HEAD", {
      cwd: tempDir,
      encoding: "utf-8",
    }).trim();

    // Get file content at HEAD
    const content = execSync(`git show ${head}:file1.ts`, {
      cwd: tempDir,
      encoding: "utf-8",
    });

    const lines = content.split("\n");
    // Extract lines 1-2
    const contextLines = lines.slice(0, 2);
    expect(contextLines).toHaveLength(2);
    expect(contextLines[0]).toBe("const x = 1;");
    expect(contextLines[1]).toBe("const y = 42;");
  });

  // AC: @review-content-diff-api ac-2
  it("should handle context line ranges at file boundaries", () => {
    const head = execSync("git rev-parse HEAD", {
      cwd: tempDir,
      encoding: "utf-8",
    }).trim();

    const content = execSync(`git show ${head}:file1.ts`, {
      cwd: tempDir,
      encoding: "utf-8",
    });

    const allLines = content.split("\n");
    // Request beyond file end — should clamp
    const startLine = 1;
    const endLine = 100;
    const clampedEnd = Math.min(allLines.length, endLine);
    const contextLines = allLines.slice(startLine - 1, clampedEnd);

    expect(contextLines.length).toBeLessThanOrEqual(allLines.length);
    expect(contextLines[0]).toBe("const x = 1;");
  });

  // AC: @review-content-diff-api ac-1
  it("should handle diff with no changes between identical refs", () => {
    const head = execSync("git rev-parse HEAD", {
      cwd: tempDir,
      encoding: "utf-8",
    }).trim();

    const diffOutput = execSync(`git diff ${head}..${head}`, {
      cwd: tempDir,
      encoding: "utf-8",
    });

    const result = parseUnifiedDiff(diffOutput, head, head);
    expect(result.files).toHaveLength(0);
    expect(result.stats.totalFiles).toBe(0);
  });
});

describe("Diff API - Context Expansion Route", () => {
  let tempDir: string;
  let app: Elysia;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-diff-context-route-");
    initGitRepo(tempDir);

    // Create .kspec/ so projectContextMiddleware accepts the directory
    mkdirSync(path.join(tempDir, ".kspec"), { recursive: true });

    // Create a file with known content
    writeFileSync(
      path.join(tempDir, "example.ts"),
      "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n",
    );
    execSync('git add -A && git commit -m "initial"', { cwd: tempDir, stdio: "pipe" });

    const { middleware } = projectContextMiddleware();
    app = new Elysia().use(middleware).use(createDiffRoutes());
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @review-content-diff-api ac-2
  it("should return context lines with line numbers for a valid range", async () => {
    const head = execSync("git rev-parse HEAD", { cwd: tempDir, encoding: "utf-8" }).trim();
    const base = head; // base not used for context but required by route

    const url = `http://localhost/api/diff/context?base=${base}&head=${head}&path=example.ts&start=2&end=5`;
    const response = await app.handle(
      new Request(url, { headers: { Host: "localhost", "X-Kspec-Dir": tempDir } }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.path).toBe("example.ts");
    expect(body.startLine).toBe(2);
    expect(body.endLine).toBe(5);
    expect(body.lines).toHaveLength(4);
    expect(body.lines[0]).toEqual({ lineNumber: 2, content: "line2" });
    expect(body.lines[3]).toEqual({ lineNumber: 5, content: "line5" });
    expect(body.totalLines).toBeGreaterThan(0);
  });

  // AC: @review-content-diff-api ac-2
  it("should clamp range to file boundaries when end exceeds file length", async () => {
    const head = execSync("git rev-parse HEAD", { cwd: tempDir, encoding: "utf-8" }).trim();

    const url = `http://localhost/api/diff/context?base=${head}&head=${head}&path=example.ts&start=8&end=999`;
    const response = await app.handle(
      new Request(url, { headers: { Host: "localhost", "X-Kspec-Dir": tempDir } }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.startLine).toBe(8);
    // Should clamp to actual file length
    expect(body.endLine).toBeLessThanOrEqual(body.totalLines);
    expect(body.lines.length).toBeGreaterThan(0);
    expect(body.lines.length).toBeLessThanOrEqual(body.totalLines - 7);
  });

  // AC: @review-content-diff-api ac-2
  it("should return 400 for invalid line range (start > end)", async () => {
    const head = execSync("git rev-parse HEAD", { cwd: tempDir, encoding: "utf-8" }).trim();

    const url = `http://localhost/api/diff/context?base=${head}&head=${head}&path=example.ts&start=5&end=2`;
    const response = await app.handle(
      new Request(url, { headers: { Host: "localhost", "X-Kspec-Dir": tempDir } }),
    );

    const text = await response.text();
    expect(response.status).toBe(400);
    const body = JSON.parse(text);
    expect(body.error).toBe("validation_error");
  });

  // AC: @review-content-diff-api ac-2
  it("should return 404 for non-existent file", async () => {
    const head = execSync("git rev-parse HEAD", { cwd: tempDir, encoding: "utf-8" }).trim();

    const url = `http://localhost/api/diff/context?base=${head}&head=${head}&path=nonexistent.ts&start=1&end=5`;
    const response = await app.handle(
      new Request(url, { headers: { Host: "localhost", "X-Kspec-Dir": tempDir } }),
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("file_not_found");
  });

  // AC: @review-content-diff-api ac-2
  it("should return 400 for invalid head ref", async () => {
    const head = execSync("git rev-parse HEAD", { cwd: tempDir, encoding: "utf-8" }).trim();

    const url = `http://localhost/api/diff/context?base=${head}&head=nonexistent-ref&path=example.ts&start=1&end=5`;
    const response = await app.handle(
      new Request(url, { headers: { Host: "localhost", "X-Kspec-Dir": tempDir } }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("invalid_ref");
  });
});

describe("Diff API - Review Content Route", () => {
  const REVIEW_PLAN_ULID = testUlid("RVPK", 1);
  const REVIEW_SPEC_ULID = testUlid("RVSP", 2);
  const REVIEW_CODE_ULID = testUlid("RVCD", 3);
  const REVIEW_TASK_ULID = testUlid("RVTK", 4);
  const REVIEW_EXT_ULID = testUlid("RVXT", 5);
  const PLAN_ULID = testUlid("PKАН".replace(/[^0-9A-HJKMNP-TV-Z]/g, "0"), 6);
  const SPEC_ULID = testUlid("SPEC", 7);
  const TASK_ULID = testUlid("TASK", 8);

  let tempDir: string;
  let app: Elysia;

  function makeRequest(reviewId: string) {
    return app.handle(
      new Request(`http://localhost/api/reviews/${reviewId}/content`, {
        headers: { Host: "localhost", "X-Kspec-Dir": tempDir },
      }),
    );
  }

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-diff-review-content-");
    initGitRepo(tempDir);

    // Create .kspec/ so projectContextMiddleware accepts the directory
    mkdirSync(path.join(tempDir, ".kspec"), { recursive: true });

    // Create minimal kspec project structure
    mkdirSync(path.join(tempDir, "modules"), { recursive: true });

    // Manifest
    writeFileSync(
      path.join(tempDir, "kynetic.yaml"),
      `kynetic: "1.1"
task_storage:
  format: split
project:
  name: Test Project
  version: "0.1.0"
  status: draft
includes:
  - modules/test.yaml
`,
    );

    // Spec item
    writeFileSync(
      path.join(tempDir, "modules", "test.yaml"),
      `features:
  - _ulid: "${SPEC_ULID}"
    slugs:
      - test-feature
    title: "Test Feature"
    type: feature
    description: "A test feature for review content tests"
    acceptance_criteria:
      - id: ac-1
        given: "a condition"
        when: "something happens"
        then: "expected result"
    traits:
      - "@some-trait"
    tags:
      - test
    created: "2026-01-01T00:00:00Z"
`,
    );

    // Tasks (split format)
    seedSplitTask(tempDir, {
      _ulid: TASK_ULID,
      slugs: ["task-test"],
      title: "Test Task",
      description: "A test task for review content",
      status: "in_progress",
      spec_ref: "@test-feature",
      created_at: "2026-01-01T00:00:00Z",
      notes: [
        {
          _ulid: testUlid("N0TE", 1),
          created_at: "2026-01-02T00:00:00Z",
          author: "@test",
          content: "Started working on this task",
        },
      ],
    });

    // Plans
    writeFileSync(
      path.join(tempDir, "project.plans.yaml"),
      `kynetic_plans: "1.0"
plans:
  - _ulid: "${PLAN_ULID}"
    slugs:
      - plan-test
    title: "Test Plan"
    content: "## Plan Content\\n\\nThis is the plan markdown body."
    status: approved
    derived_specs:
      - "@test-feature"
    derived_tasks:
      - "@task-test"
    created_at: "2026-01-01T00:00:00Z"
    notes:
      - _ulid: "${testUlid("PN0T", 1)}"
        created_at: "2026-01-02T00:00:00Z"
        author: "@test"
        content: "Plan approved"
`,
    );

    // Reviews — multiple subject types
    writeFileSync(
      path.join(tempDir, "project.reviews.yaml"),
      `kynetic_reviews: "1.0"
reviews:
  - _ulid: "${REVIEW_PLAN_ULID}"
    slugs:
      - review-plan
    title: "Review plan"
    lifecycle_state: open
    author: "@test"
    subject:
      type: plan
      ref: "@plan-test"
      shadow_commit: "abc123"
      content_hash: "hash1"
    created_at: "2026-01-01T00:00:00Z"
  - _ulid: "${REVIEW_SPEC_ULID}"
    slugs:
      - review-spec
    title: "Review spec"
    lifecycle_state: open
    author: "@test"
    subject:
      type: spec
      ref: "@test-feature"
      shadow_commit: "abc123"
      content_hash: "hash2"
    created_at: "2026-01-01T00:00:00Z"
  - _ulid: "${REVIEW_CODE_ULID}"
    slugs:
      - review-code
    title: "Review code"
    lifecycle_state: open
    author: "@test"
    subject:
      type: code
      base_commit: "aaa111"
      head_commit: "bbb222"
    created_at: "2026-01-01T00:00:00Z"
  - _ulid: "${REVIEW_TASK_ULID}"
    slugs:
      - review-task
    title: "Review task"
    lifecycle_state: open
    author: "@test"
    subject:
      type: task
      ref: "@task-test"
      shadow_commit: "abc123"
      content_hash: "hash3"
    created_at: "2026-01-01T00:00:00Z"
  - _ulid: "${REVIEW_EXT_ULID}"
    slugs:
      - review-external
    title: "Review external"
    lifecycle_state: open
    author: "@test"
    subject:
      type: external
      url: "https://github.com/example/issue/1"
      provider: github
    created_at: "2026-01-01T00:00:00Z"
`,
    );

    execSync('git add -A && git commit -m "kspec project setup"', { cwd: tempDir, stdio: "pipe" });

    const { middleware } = projectContextMiddleware();
    app = new Elysia().use(middleware).use(createDiffRoutes());
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @review-content-diff-api ac-4
  it("should return plan content with sections for plan subject", async () => {
    const response = await makeRequest("review-plan");

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.review_id).toBe(REVIEW_PLAN_ULID);
    expect(body.subject_type).toBe("plan");
    expect(body.subject_ref).toBe("@plan-test");
    expect(body.content.title).toBe("Test Plan");

    const sections = body.content.sections;
    const contentSection = sections.find((s: { id: string }) => s.id === "content");
    expect(contentSection).toBeDefined();
    expect(contentSection.type).toBe("markdown");

    const specsSection = sections.find((s: { id: string }) => s.id === "specs");
    expect(specsSection).toBeDefined();
    expect(specsSection.type).toBe("ref_list");
    expect(specsSection.refs).toContain("@test-feature");

    const tasksSection = sections.find((s: { id: string }) => s.id === "tasks");
    expect(tasksSection).toBeDefined();
    expect(tasksSection.refs).toContain("@task-test");

    const notesSection = sections.find((s: { id: string }) => s.id === "notes");
    expect(notesSection).toBeDefined();
    expect(notesSection.type).toBe("notes");
  });

  // AC: @review-content-diff-api ac-4
  it("should return spec content with description, ACs, traits, and metadata for spec subject", async () => {
    const response = await makeRequest("review-spec");

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.review_id).toBe(REVIEW_SPEC_ULID);
    expect(body.subject_type).toBe("spec");
    expect(body.subject_ref).toBe("@test-feature");
    expect(body.content.title).toBe("Test Feature");

    const sections = body.content.sections;
    const descSection = sections.find((s: { id: string }) => s.id === "description");
    expect(descSection).toBeDefined();
    expect(descSection.type).toBe("markdown");
    expect(descSection.content).toContain("test feature");

    const acSection = sections.find((s: { id: string }) => s.id === "acceptance_criteria");
    expect(acSection).toBeDefined();
    expect(acSection.type).toBe("acceptance_criteria");
    expect(acSection.criteria).toHaveLength(1);
    expect(acSection.criteria[0].id).toBe("ac-1");

    const traitsSection = sections.find((s: { id: string }) => s.id === "traits");
    expect(traitsSection).toBeDefined();
    expect(traitsSection.refs).toContain("@some-trait");

    const metaSection = sections.find((s: { id: string }) => s.id === "metadata");
    expect(metaSection).toBeDefined();
    expect(metaSection.type).toBe("metadata");
    expect(metaSection.metadata._ulid).toBe(SPEC_ULID);
  });

  // AC: @review-content-diff-api ac-4
  it("should return diff_params for code subject (no entity content)", async () => {
    const response = await makeRequest("review-code");

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.review_id).toBe(REVIEW_CODE_ULID);
    expect(body.subject_type).toBe("code");
    expect(body.content).toBeNull();
    expect(body.diff_params.base).toBe("aaa111");
    expect(body.diff_params.head).toBe("bbb222");
  });

  // AC: @review-content-diff-api ac-4
  it("should return task content with description and notes for task subject", async () => {
    const response = await makeRequest("review-task");

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.review_id).toBe(REVIEW_TASK_ULID);
    expect(body.subject_type).toBe("task");
    expect(body.subject_ref).toBe("@task-test");
    expect(body.content.title).toBe("Test Task");

    const sections = body.content.sections;
    const descSection = sections.find((s: { id: string }) => s.id === "description");
    expect(descSection).toBeDefined();
    expect(descSection.content).toContain("test task");

    const notesSection = sections.find((s: { id: string }) => s.id === "notes");
    expect(notesSection).toBeDefined();
    expect(notesSection.notes).toHaveLength(1);
  });

  // AC: @review-content-diff-api ac-4
  it("should return null content for external subject", async () => {
    const response = await makeRequest("review-external");

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.review_id).toBe(REVIEW_EXT_ULID);
    expect(body.subject_type).toBe("external");
    expect(body.content).toBeNull();
  });

  // AC: @review-content-diff-api ac-4
  it("should return 404 for non-existent review", async () => {
    const response = await makeRequest("nonexistent-review");

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("not_found");
    expect(body.suggestion).toBeDefined();
  });
});

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Build a strict 9-field resource manifest entry with overridable fields. */
function resourceMetadata(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "resource",
    label: null,
    path: "file.bin",
    content_type: "application/octet-stream",
    bytes: 0,
    sha256: "",
    git_commit: null,
    git_path: null,
    description: null,
    ...overrides,
  };
}

describe("Diff API - Review Content Resource Context", () => {
  const REVIEW_PLAN_RES_ULID = testUlid("RCRP", 11);
  const REVIEW_TASK_RES_ULID = testUlid("RCRT", 12);
  const REVIEW_PLAN_PLAIN_ULID = testUlid("RCRV", 13);
  const REVIEW_TASK_PLAIN_ULID = testUlid("RCRW", 14);
  const PLAN_RES_ULID = testUlid("PRES", 15);
  const PLAN_PLAIN_ULID = testUlid("PPXN", 16);
  const TASK_RES_ULID = testUlid("TRES", 17);
  const TASK_PLAIN_ULID = testUlid("TPXN", 18);

  const PLAN_IMG_BYTES = Buffer.from("plan-architecture-diagram-bytes");
  const PLAN_DOC_BYTES = Buffer.from("plan-design-doc-bytes");
  const TASK_COPY_BYTES = Buffer.from("materialized-task-owned-copy-bytes");
  const DRIFT_RECORDED_BYTES = Buffer.from("doc-as-recorded-at-derivation");
  const DRIFT_CURRENT_BYTES = Buffer.from("doc-changed-after-derivation");

  const PLAN_IMG_SHA = sha256(PLAN_IMG_BYTES);
  const PLAN_DOC_SHA = sha256(PLAN_DOC_BYTES);
  const TASK_COPY_SHA = sha256(TASK_COPY_BYTES);
  const DRIFT_RECORDED_SHA = sha256(DRIFT_RECORDED_BYTES);
  const DRIFT_CURRENT_SHA = sha256(DRIFT_CURRENT_BYTES);

  let tempDir: string;
  let app: Elysia;

  function makeRequest(reviewId: string) {
    return app.handle(
      new Request(`http://localhost/api/reviews/${reviewId}/content`, {
        headers: { Host: "localhost", "X-Kspec-Dir": tempDir },
      }),
    );
  }

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-diff-review-resource-ctx-");
    initGitRepo(tempDir);

    mkdirSync(path.join(tempDir, ".kspec"), { recursive: true });
    mkdirSync(path.join(tempDir, "modules"), { recursive: true });

    writeFileSync(
      path.join(tempDir, "kynetic.yaml"),
      `kynetic: "1.1"
task_storage:
  format: split
project:
  name: Test Project
  version: "0.1.0"
  status: draft
includes:
  - modules/test.yaml
`,
    );
    writeFileSync(path.join(tempDir, "modules", "test.yaml"), "features: []\n");

    // Plan with declared resources. The markdown references one declared
    // image, one declared doc, and one undeclared path.
    writeFileSync(
      path.join(tempDir, "project.plans.yaml"),
      `kynetic_plans: "1.0"
plans:
  - _ulid: "${PLAN_RES_ULID}"
    slugs:
      - plan-resourced
    title: "Plan With Resources"
    content: "![arch](./resources/img/arch.png) and [doc](./resources/docs/design.md) plus ![ghost](./resources/img/undeclared.png)"
    status: approved
    derived_specs: []
    derived_tasks: []
    created_at: "2026-01-01T00:00:00Z"
  - _ulid: "${PLAN_PLAIN_ULID}"
    slugs:
      - plan-plain
    title: "Plan Without Resources"
    content: "No resources referenced here."
    status: approved
    derived_specs: []
    derived_tasks: []
    created_at: "2026-01-01T00:00:00Z"
`,
    );

    // Declared plan resource manifest + bytes (folder layout: plans/<ulid>/).
    const planDir = path.join(tempDir, "plans", PLAN_RES_ULID);
    mkdirSync(path.join(planDir, "resources", "img"), { recursive: true });
    mkdirSync(path.join(planDir, "resources", "docs"), { recursive: true });
    writeFileSync(path.join(planDir, "resources", "img", "arch.png"), PLAN_IMG_BYTES);
    writeFileSync(path.join(planDir, "resources", "docs", "design.md"), PLAN_DOC_BYTES);
    writeFileSync(
      path.join(planDir, "resources.yaml"),
      yamlStringify({
        resources: [
          resourceMetadata({
            id: "arch-png",
            path: "img/arch.png",
            content_type: "image/png",
            bytes: PLAN_IMG_BYTES.length,
            sha256: PLAN_IMG_SHA,
          }),
          resourceMetadata({
            id: "design-doc",
            path: "docs/design.md",
            content_type: "text/markdown",
            bytes: PLAN_DOC_BYTES.length,
            sha256: PLAN_DOC_SHA,
          }),
        ],
      }),
    );

    // Task with resource_refs covering a plan-owned present reference, a
    // materialized task-owned copy, and a drifted task-owned reference. The
    // description also references one unmatched path.
    seedSplitTask(tempDir, {
      _ulid: TASK_RES_ULID,
      slugs: ["task-resourced"],
      title: "Task With Resources",
      description:
        "![arch](./resources/img/arch.png) ![copy](./resources/img/copy.png) [drifty](./resources/docs/drifty.md) ![nowhere](./resources/img/nowhere.png)",
      status: "in_progress",
      created_at: "2026-01-01T00:00:00Z",
      resource_refs: [
        {
          owner_type: "plan",
          owner_ref: "@plan-resourced",
          id: "arch-png",
          path: "img/arch.png",
          sha256: PLAN_IMG_SHA,
          git_commit: null,
          git_path: null,
          recorded_at: "2026-01-01T00:00:00.000Z",
        },
        {
          owner_type: "task",
          owner_ref: TASK_RES_ULID,
          id: "copy-png",
          path: "img/copy.png",
          sha256: TASK_COPY_SHA,
          git_commit: null,
          git_path: null,
          recorded_at: "2026-01-01T00:00:00.000Z",
        },
        {
          owner_type: "task",
          owner_ref: TASK_RES_ULID,
          id: "drifty-doc",
          path: "docs/drifty.md",
          sha256: DRIFT_RECORDED_SHA,
          git_commit: null,
          git_path: null,
          recorded_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    seedSplitTask(tempDir, {
      _ulid: TASK_PLAIN_ULID,
      slugs: ["task-plain"],
      title: "Task Without Resources",
      description: "Nothing resource-shaped here.",
      status: "pending",
      created_at: "2026-01-01T00:00:00Z",
    });

    // Task-owned resource manifest: the copy matches its recorded hash, the
    // drifty doc's current bytes differ from the recorded hash.
    const taskDir = path.join(tempDir, "tasks", TASK_RES_ULID);
    mkdirSync(path.join(taskDir, "resources", "img"), { recursive: true });
    mkdirSync(path.join(taskDir, "resources", "docs"), { recursive: true });
    writeFileSync(path.join(taskDir, "resources", "img", "copy.png"), TASK_COPY_BYTES);
    writeFileSync(path.join(taskDir, "resources", "docs", "drifty.md"), DRIFT_CURRENT_BYTES);
    writeFileSync(
      path.join(taskDir, "resources.yaml"),
      yamlStringify({
        resources: [
          resourceMetadata({
            id: "copy-png",
            path: "img/copy.png",
            content_type: "image/png",
            bytes: TASK_COPY_BYTES.length,
            sha256: TASK_COPY_SHA,
          }),
          resourceMetadata({
            id: "drifty-doc",
            path: "docs/drifty.md",
            content_type: "text/markdown",
            bytes: DRIFT_CURRENT_BYTES.length,
            sha256: DRIFT_CURRENT_SHA,
          }),
        ],
      }),
    );

    writeFileSync(
      path.join(tempDir, "project.reviews.yaml"),
      `kynetic_reviews: "1.0"
reviews:
  - _ulid: "${REVIEW_PLAN_RES_ULID}"
    slugs:
      - review-plan-resourced
    title: "Review plan with resources"
    lifecycle_state: open
    author: "@test"
    subject:
      type: plan
      ref: "@plan-resourced"
      shadow_commit: "abc123"
      content_hash: "hash1"
    created_at: "2026-01-01T00:00:00Z"
  - _ulid: "${REVIEW_PLAN_PLAIN_ULID}"
    slugs:
      - review-plan-plain
    title: "Review plan without resources"
    lifecycle_state: open
    author: "@test"
    subject:
      type: plan
      ref: "@plan-plain"
      shadow_commit: "abc123"
      content_hash: "hash2"
    created_at: "2026-01-01T00:00:00Z"
  - _ulid: "${REVIEW_TASK_RES_ULID}"
    slugs:
      - review-task-resourced
    title: "Review task with resources"
    lifecycle_state: open
    author: "@test"
    subject:
      type: task
      ref: "@task-resourced"
      shadow_commit: "abc123"
      content_hash: "hash3"
    created_at: "2026-01-01T00:00:00Z"
  - _ulid: "${REVIEW_TASK_PLAIN_ULID}"
    slugs:
      - review-task-plain
    title: "Review task without resources"
    lifecycle_state: open
    author: "@test"
    subject:
      type: task
      ref: "@task-plain"
      shadow_commit: "abc123"
      content_hash: "hash4"
    created_at: "2026-01-01T00:00:00Z"
`,
    );

    execSync('git add -A && git commit -m "kspec project setup"', { cwd: tempDir, stdio: "pipe" });

    const { middleware } = projectContextMiddleware();
    app = new Elysia().use(middleware).use(createDiffRoutes());
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @review-content-diff-api ac-5
  it("attaches byte-free plan resource context to the plan content markdown section", async () => {
    const response = await makeRequest("review-plan-resourced");

    expect(response.status).toBe(200);
    const body = await response.json();
    const contentSection = body.content.sections.find((s: { id: string }) => s.id === "content");
    expect(contentSection).toBeDefined();

    const context = contentSection.resource_context;
    expect(context).toBeDefined();
    expect(context.owner_type).toBe("plan");
    expect(context.owner_ref).toBe("@plan-resourced");
    expect(context.resources_base_url).toBe(`/api/plans/${PLAN_RES_ULID}/resources`);

    // Bounded declared metadata — only manifest-declared resources, with the
    // strict byte-free metadata shape (no embedded bytes, no per-entry URL).
    expect(context.resources).toHaveLength(2);
    const arch = context.resources.find((r: { id: string }) => r.id === "arch-png");
    expect(arch).toEqual({
      id: "arch-png",
      label: null,
      path: "img/arch.png",
      content_type: "image/png",
      bytes: PLAN_IMG_BYTES.length,
      sha256: PLAN_IMG_SHA,
      git_commit: null,
      git_path: null,
      description: null,
    });
    // The undeclared reference in the plan markdown has no metadata entry, so
    // clients cannot rewrite it.
    expect(
      context.resources.find((r: { path: string }) => r.path === "img/undeclared.png"),
    ).toBeUndefined();
  });

  // AC: @review-content-diff-api ac-5
  it("never embeds resource bytes in plan review content responses", async () => {
    const response = await makeRequest("review-plan-resourced");
    const raw = JSON.stringify(await response.json());
    expect(raw).not.toContain(PLAN_IMG_BYTES.toString());
    expect(raw).not.toContain(PLAN_DOC_BYTES.toString());
    expect(raw).not.toContain(PLAN_IMG_BYTES.toString("base64"));
  });

  // AC: @review-content-diff-api ac-5
  it("omits resource context for plan subjects without declared resources", async () => {
    const response = await makeRequest("review-plan-plain");

    expect(response.status).toBe(200);
    const body = await response.json();
    const contentSection = body.content.sections.find((s: { id: string }) => s.id === "content");
    expect(contentSection).toBeDefined();
    expect(contentSection.resource_context).toBeUndefined();
  });

  // AC: @review-content-diff-api ac-6
  it("attaches byte-free task resource context with resolved status to the description section", async () => {
    const response = await makeRequest("review-task-resourced");

    expect(response.status).toBe(200);
    const body = await response.json();
    const descSection = body.content.sections.find((s: { id: string }) => s.id === "description");
    expect(descSection).toBeDefined();

    const context = descSection.resource_context;
    expect(context).toBeDefined();
    expect(context.owner_type).toBe("task");
    expect(context.owner_ref).toBe("@task-resourced");
    expect(context.resources_base_url).toBe(`/api/tasks/${TASK_RES_ULID}/resources`);

    // Bounded resolved-resource status projection: plan-owned present,
    // materialized task-owned present, and drifted reference all reported.
    expect(context.resources).toHaveLength(3);

    const planOwned = context.resources.find((r: { id: string }) => r.id === "arch-png");
    expect(planOwned.owner_type).toBe("plan");
    expect(planOwned.status).toBe("present");
    expect(planOwned.path).toBe("img/arch.png");

    const taskOwned = context.resources.find((r: { id: string }) => r.id === "copy-png");
    expect(taskOwned.owner_type).toBe("task");
    expect(taskOwned.status).toBe("present");

    const drifted = context.resources.find((r: { id: string }) => r.id === "drifty-doc");
    expect(drifted.status).toBe("drift");
    expect(drifted.recorded_sha256).toBe(DRIFT_RECORDED_SHA);
    expect(drifted.current_sha256).toBe(DRIFT_CURRENT_SHA);
    expect(drifted.message).toBeTruthy();
  });

  // AC: @review-content-diff-api ac-6
  it("never embeds resource bytes in task review content responses", async () => {
    const response = await makeRequest("review-task-resourced");
    const raw = JSON.stringify(await response.json());
    expect(raw).not.toContain(TASK_COPY_BYTES.toString());
    expect(raw).not.toContain(DRIFT_CURRENT_BYTES.toString());
    expect(raw).not.toContain(TASK_COPY_BYTES.toString("base64"));
  });

  // AC: @review-content-diff-api ac-6
  it("omits resource context for task subjects without resource refs", async () => {
    const response = await makeRequest("review-task-plain");

    expect(response.status).toBe(200);
    const body = await response.json();
    const descSection = body.content.sections.find((s: { id: string }) => s.id === "description");
    expect(descSection).toBeDefined();
    expect(descSection.resource_context).toBeUndefined();
  });
});

// AC: @trait-json-output ac-1 — N/A: These are daemon API endpoints, not CLI commands. The daemon always returns JSON (Elysia serializes all responses as JSON automatically). There is no --json flag or ANSI mode for HTTP API endpoints.
// AC: @trait-json-output ac-2 — N/A: Same as ac-1, daemon endpoints always return JSON.
// AC: @trait-json-output ac-3 — N/A: Daemon error responses are always JSON objects with error field (see errorResponse calls in routes).
// AC: @trait-json-output ac-4 — N/A: These endpoints don't output kspec references; they output git diffs and entity content.
// AC: @trait-json-output ac-5 — N/A: These endpoints don't output timestamps directly; entity content uses ISO 8601 from the underlying schema.
// AC: @trait-json-output ac-6 — N/A: No formatting flags exist on HTTP API endpoints.

// AC: @trait-error-guidance ac-1
// AC: @trait-error-guidance ac-2
// Verified in route implementation: all errorResponse calls include message + suggestion fields.

// AC: @trait-error-guidance ac-3 — N/A: These endpoints don't resolve kspec references for the diff API. The review content endpoint uses findReviewByRef which provides appropriate error messages.
// AC: @trait-error-guidance ac-4 — N/A: These endpoints don't perform state transitions.
// AC: @trait-error-guidance ac-5
// Verified in route implementation: validation errors indicate which parameters are missing.

// AC: @trait-error-guidance ac-6 — N/A: These are HTTP API endpoints, not CLI commands. All responses are JSON.

// AC: @trait-localhost-security ac-loopback-default — N/A: diff API route handler tests do not invoke app.listen(); default loopback bind is exercised in tests/cli-serve.test.ts (daemon child startup).
// AC: @trait-localhost-security ac-loopback-rejects-nonlocal — N/A: localhostOnly middleware is a server-level concern, exercised in tests/daemon-api/server.test.ts and tests/daemon-server.test.ts.
// AC: @trait-localhost-security ac-external-host-explicit — N/A: explicit non-loopback bind is exercised in tests/cli-serve.test.ts where daemon.host is configured.
// AC: @trait-localhost-security ac-external-warning — N/A: external-bind warning is surfaced from the CLI lifecycle path and exercised in tests/cli-serve.test.ts.
