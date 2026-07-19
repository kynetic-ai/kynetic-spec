/**
 * CLI tests for `kspec plan import` sibling-resources manifest enforcement
 * and `kspec plan set --content-file` resource-ref validation.
 *
 * AC: @plan-resource-derivation-semantics-1 ac-plan-task-resource-refs-are-structured
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
 * AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as yamlParse } from "yaml";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  kspec as kspecRun,
  kspecJson,
} from "./helpers/cli";

const projectCli = path.resolve(__dirname, "..", "dist", "cli", "index.js");
const canRunInit = existsSync(projectCli);

async function setupFolderProject(projectDir: string): Promise<void> {
  initGitRepo(projectDir);
  await fs.writeFile(path.join(projectDir, "README.md"), "# Test", "utf-8");
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
}

interface PlanRecord {
  _ulid: string;
  slugs: string[];
}

describe.runIf(canRunInit)("Integration: plan import with sibling resources.yaml", () => {
  let tempDir: string;
  let planMdPath: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    await setupFolderProject(tempDir);
    planMdPath = path.join(tempDir, "imports", "plan.md");
    await fs.mkdir(path.dirname(planMdPath), { recursive: true });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  async function writePlan(content: string): Promise<void> {
    await fs.writeFile(planMdPath, content, "utf-8");
  }

  async function writeSiblingManifest(yaml: string): Promise<void> {
    const manifestPath = path.join(path.dirname(planMdPath), "resources.yaml");
    await fs.writeFile(manifestPath, yaml, "utf-8");
  }

  async function writeSiblingResource(relPath: string, body: string): Promise<void> {
    const fullPath = path.join(path.dirname(planMdPath), "resources", relPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, body, "utf-8");
  }

  // AC: @plan-resource-derivation-semantics-1 ac-plan-task-resource-refs-are-structured
  it("imports resource files declared in sibling resources.yaml and copies them into the plan folder", async () => {
    await writePlan(`# Resource Plan

See ![shot](./resources/screenshots/login.png) for the login flow.

## Specs

\`\`\`yaml
- title: Stub
  slug: stub
  type: feature
\`\`\`

## Tasks

derive_from_specs: true
`);
    await writeSiblingManifest(
      `resources:
  - id: login-shot
    path: screenshots/login.png
    label: Login shot
`,
    );
    await writeSiblingResource("screenshots/login.png", "PNG_BYTES");

    const result = kspecRun(`plan import "${planMdPath}"`, tempDir);
    expect(result.exitCode).toBe(0);

    const plan = kspecJson<PlanRecord>("plan get @plan-resource-plan", tempDir);
    const planDir = path.join(tempDir, ".kspec", "plans", plan._ulid);
    const copiedFile = path.join(planDir, "resources", "screenshots", "login.png");
    expect(existsSync(copiedFile)).toBe(true);
    const manifestRaw = await fs.readFile(path.join(planDir, "resources.yaml"), "utf-8");
    const parsed = yamlParse(manifestRaw) as { resources: Array<{ id: string; path: string }> };
    expect(parsed.resources).toHaveLength(1);
    expect(parsed.resources[0].id).toBe("login-shot");
    expect(parsed.resources[0].path).toBe("screenshots/login.png");
  });

  // AC: @plan-resource-derivation-semantics-1 ac-plan-task-resource-refs-are-structured
  it("rejects an import whose markdown references resources without a sibling resources.yaml", async () => {
    await writePlan(`# Plan

![shot](./resources/screenshots/login.png)

## Specs

\`\`\`yaml
- title: Stub
  slug: stub
  type: feature
\`\`\`
`);
    const result = kspecRun(`plan import "${planMdPath}" --json`, tempDir, { expectFail: true });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("missing_sibling_manifest");
  });

  // AC: @plan-resource-derivation-semantics-1 ac-plan-task-resource-refs-are-structured
  it("rejects an import whose markdown link is not declared in the sibling manifest", async () => {
    await writePlan(`# Plan

![shot](./resources/screenshots/login.png)

## Specs

\`\`\`yaml
- title: Stub
  slug: stub
  type: feature
\`\`\`
`);
    await writeSiblingManifest(
      `resources:
  - id: other
    path: other.png
`,
    );
    await writeSiblingResource("other.png", "X");
    const result = kspecRun(`plan import "${planMdPath}" --json`, tempDir, { expectFail: true });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("undeclared_markdown_link");
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
  it("rejects an import whose sibling manifest declares an unsafe path", async () => {
    await writePlan(`# Plan

## Specs

\`\`\`yaml
- title: Stub
  slug: stub
  type: feature
\`\`\`
`);
    await writeSiblingManifest(
      `resources:
  - id: bad
    path: ../escape.png
`,
    );
    const result = kspecRun(`plan import "${planMdPath}" --json`, tempDir, { expectFail: true });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/(invalid_resource_path|invalid_sibling_manifest)/);
  });

  // AC: @plan-resource-derivation-semantics-1 ac-plan-task-resource-refs-are-structured
  it("rejects an import when a declared resource file is missing from the sibling tree", async () => {
    await writePlan(`# Plan

![shot](./resources/missing.png)

## Specs

\`\`\`yaml
- title: Stub
  slug: stub
  type: feature
\`\`\`
`);
    await writeSiblingManifest(
      `resources:
  - id: missing
    path: missing.png
`,
    );
    const result = kspecRun(`plan import "${planMdPath}" --json`, tempDir, { expectFail: true });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("missing_sibling_source_file");
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
  // Regression: a symlinked sibling resource that points outside the sibling
  // resources/ tree must be rejected before any bytes are copied into the
  // plan directory. fs.stat would silently follow the link and let an
  // arbitrary outside file masquerade as a declared sibling resource.
  it("rejects an import whose sibling resource is a symlink to a file outside the sibling tree", async () => {
    await writePlan(`# Plan

![shot](./resources/linked.txt)

## Specs

\`\`\`yaml
- title: Stub
  slug: stub
  type: feature
\`\`\`
`);
    await writeSiblingManifest(
      `resources:
  - id: linked
    path: linked.txt
`,
    );
    const outside = path.join(tempDir, "outside.txt");
    await fs.writeFile(outside, "OUTSIDE_SECRET", "utf-8");
    const siblingResourcesDir = path.join(path.dirname(planMdPath), "resources");
    await fs.mkdir(siblingResourcesDir, { recursive: true });
    await fs.symlink(outside, path.join(siblingResourcesDir, "linked.txt"));

    const result = kspecRun(`plan import "${planMdPath}" --json`, tempDir, { expectFail: true });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("unsafe_sibling_source_file");

    // Validation rejected the import before save, so no plan directory may
    // exist under .kspec/plans/ holding the outside bytes.
    const plansRoot = path.join(tempDir, ".kspec", "plans");
    let planDirs: string[] = [];
    try {
      planDirs = await fs.readdir(plansRoot);
    } catch {
      planDirs = [];
    }
    for (const planUlid of planDirs) {
      const copied = path.join(plansRoot, planUlid, "resources", "linked.txt");
      expect(existsSync(copied)).toBe(false);
    }
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
  // Defence in depth: an intermediate symlinked directory under resources/
  // would let the per-entry fs.lstat see a regular file (because lstat
  // follows intermediate symlinks). The realpath containment check rejects
  // it because the resolved path escapes the sibling resources realpath.
  it("rejects an import whose sibling resources/ contains a symlinked subdirectory pointing outside the tree", async () => {
    await writePlan(`# Plan

![shot](./resources/sub/linked.txt)

## Specs

\`\`\`yaml
- title: Stub
  slug: stub
  type: feature
\`\`\`
`);
    await writeSiblingManifest(
      `resources:
  - id: nested
    path: sub/linked.txt
`,
    );
    const outsideDir = path.join(tempDir, "elsewhere");
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(path.join(outsideDir, "linked.txt"), "ESCAPED", "utf-8");
    const siblingResourcesDir = path.join(path.dirname(planMdPath), "resources");
    await fs.mkdir(siblingResourcesDir, { recursive: true });
    await fs.symlink(outsideDir, path.join(siblingResourcesDir, "sub"));

    const result = kspecRun(`plan import "${planMdPath}" --json`, tempDir, { expectFail: true });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("unsafe_sibling_source_file");
  });
});

describe.runIf(canRunInit)("Integration: plan import --into resource validation", () => {
  let tempDir: string;
  let planRef: string;
  let editPath: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    await setupFolderProject(tempDir);
    const addResult = kspecRun('plan add --title "Existing Plan" --content "stub"', tempDir);
    if (addResult.exitCode !== 0) throw new Error(addResult.stderr);
    planRef = "@plan-existing-plan";
    editPath = path.join(tempDir, "edit.md");

    const sourceFile = path.join(tempDir, "shot.png");
    await fs.writeFile(sourceFile, "PNG", "utf-8");
    const attach = kspecRun(
      `plan resource add ${planRef} "${sourceFile}" --id login --path screenshots/login.png`,
      tempDir,
    );
    if (attach.exitCode !== 0) {
      throw new Error(`attach failed: ${attach.stderr}`);
    }
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @plan-resource-derivation-semantics-1 ac-plan-task-resource-refs-are-structured
  it("accepts an --into re-import whose markdown links resolve against the existing resources", async () => {
    await fs.writeFile(
      editPath,
      `# Existing Plan

![shot](./resources/screenshots/login.png)

## Specs

\`\`\`yaml
- title: Stub
  slug: stub
  type: feature
\`\`\`
`,
      "utf-8",
    );
    const result = kspecRun(`plan import "${editPath}" --into ${planRef}`, tempDir);
    expect(result.exitCode).toBe(0);
  });

  // AC: @plan-resource-derivation-semantics-1 ac-plan-task-resource-refs-are-structured
  it("rejects an --into re-import whose markdown links are not attached", async () => {
    await fs.writeFile(
      editPath,
      `# Existing Plan

![shot](./resources/screenshots/missing.png)

## Specs

\`\`\`yaml
- title: Stub
  slug: stub
  type: feature
\`\`\`
`,
      "utf-8",
    );
    const result = kspecRun(`plan import "${editPath}" --into ${planRef} --json`, tempDir, {
      expectFail: true,
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("undeclared_markdown_link");
  });
});

describe.runIf(canRunInit)("Integration: plan set --content-file resource validation", () => {
  let tempDir: string;
  let planRef: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    await setupFolderProject(tempDir);
    const addResult = kspecRun('plan add --title "Set Plan" --content "stub"', tempDir);
    if (addResult.exitCode !== 0) throw new Error(addResult.stderr);
    planRef = "@plan-set-plan";
    const sourceFile = path.join(tempDir, "shot.png");
    await fs.writeFile(sourceFile, "PNG", "utf-8");
    kspecRun(
      `plan resource add ${planRef} "${sourceFile}" --id shot --path shots/login.png`,
      tempDir,
    );
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @plan-resource-derivation-semantics-1 ac-plan-task-resource-refs-are-structured
  it("accepts --content-file whose markdown links resolve against attached resources", async () => {
    const contentFile = path.join(tempDir, "new-content.md");
    await fs.writeFile(
      contentFile,
      `# Set Plan

![attached](./resources/shots/login.png)
`,
      "utf-8",
    );
    const result = kspecRun(`plan set ${planRef} --content-file "${contentFile}"`, tempDir);
    expect(result.exitCode).toBe(0);
    const plan = kspecJson<{ content: string }>(`plan get ${planRef}`, tempDir);
    expect(plan.content).toContain("./resources/shots/login.png");
  });

  // AC: @plan-resource-derivation-semantics-1 ac-plan-task-resource-refs-are-structured
  it("rejects --content-file whose markdown link is not attached to the plan", async () => {
    const contentFile = path.join(tempDir, "bad-content.md");
    await fs.writeFile(
      contentFile,
      `# Set Plan

![missing](./resources/missing/file.png)
`,
      "utf-8",
    );
    const result = kspecRun(`plan set ${planRef} --content-file "${contentFile}" --json`, tempDir, {
      expectFail: true,
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("undeclared_markdown_link");
  });
});
