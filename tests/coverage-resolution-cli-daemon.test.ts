import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TestResultRunRecordInput } from "../src/schema/test-result-runs.js";
import { initContext, writeTestRun } from "../src/parser/index.js";
import { invalidateCoverageStateReadModelCache } from "../src/parser/coverage-state-read-model.js";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  kspec,
  type KspecOptions,
  testUlid,
} from "./helpers/cli.js";
import {
  createTestApp,
  makeRequest,
  requestJson,
  setupInlineFixtures,
} from "./daemon-api/helpers.js";

// AC: @trait-api-endpoint ac-4 - N/A: coverage resolution actions are not list endpoints.
// AC: @trait-semantic-exit-codes ac-3 - N/A: coverage resolution actions do not prompt for confirmation.
// AC: @trait-semantic-exit-codes ac-5 - N/A: coverage resolution actions target one criterion, not an empty result set.
// AC: @trait-semantic-exit-codes ac-7 - N/A: coverage resolution actions do not provide batch mode.
// AC: @trait-error-guidance ac-4 - N/A: coverage precondition diagnostics describe action suitability, not lifecycle transitions.

const ITEM_ULID = testUlid("FEAT", 801);
const RUN_ID = testUlid("RUNN", 801);
const tempDirs: string[] = [];

afterEach(async () => {
  invalidateCoverageStateReadModelCache();
  while (tempDirs.length > 0) {
    await cleanupTempDir(tempDirs.pop()!);
  }
});

async function setupResolutionProject(options: { changeText?: boolean } = {}): Promise<string> {
  const tempDir = await createTempDir("coverage-resolution-cli-daemon-");
  tempDirs.push(tempDir);
  initGitRepo(tempDir);
  setupInlineFixtures(tempDir, {
    skipCommit: true,
    manifest: [
      'kynetic: "1.1"',
      "task_storage:",
      "  format: split",
      "project:",
      "  name: Coverage Resolution Fixture",
      "includes:",
      "  - modules/coverage.yaml",
      "coverage:",
      "  scan_paths:",
      "    - tests",
      "",
    ].join("\n"),
    modules: {
      "coverage.yaml": coverageModule("covered criterion"),
    },
  });
  mkdirSync(path.join(tempDir, "tests"), { recursive: true });
  writeFileSync(
    path.join(tempDir, "kspec.config.yaml"),
    [
      "identity:",
      "  author: neutral-operator",
      "coverage:",
      "  scan_paths:",
      "    - tests",
      "",
    ].join("\n"),
  );
  writeFileSync(
    path.join(tempDir, "tests", "coverage-resolution.test.ts"),
    ["// AC: @coverage-api-widget ac-covered", "it('covers mapped criterion', () => {});", ""].join(
      "\n",
    ),
  );
  const fixtureCommit = commit(tempDir, "coverage resolution fixture sources", {
    GIT_AUTHOR_DATE: "2026-06-24T11:45:00.000Z",
    GIT_COMMITTER_DATE: "2026-06-24T11:45:00.000Z",
  });
  const ctx = await initContext(tempDir, { syncMode: "skip" });
  await writeTestRun(ctx, normalizedRun({ codeRevision: fixtureCommit }), { skipCommit: true });
  commit(tempDir, "coverage resolution fixture run", {
    GIT_AUTHOR_DATE: "2026-06-24T12:05:00.000Z",
    GIT_COMMITTER_DATE: "2026-06-24T12:05:00.000Z",
  });
  if (options.changeText !== false) {
    writeFileSync(
      path.join(tempDir, "modules", "coverage.yaml"),
      coverageModule("changed criterion"),
    );
    commit(tempDir, "change covered criterion text", {
      GIT_AUTHOR_DATE: "2026-06-24T13:00:00.000Z",
      GIT_COMMITTER_DATE: "2026-06-24T13:00:00.000Z",
    });
  }
  return tempDir;
}

function coverageModule(coveredGiven: string): string {
  return [
    `- _ulid: ${ITEM_ULID}`,
    "  slugs: [coverage-api-widget]",
    "  title: Coverage API Widget",
    "  type: feature",
    "  description: Fixture for coverage resolution adapter behavior.",
    "  acceptance_criteria:",
    "    - id: ac-covered",
    `      given: ${coveredGiven}`,
    "      when: state is requested",
    "      then: it is covered",
    "    - id: ac-failing",
    "      given: failing criterion",
    "      when: state is requested",
    "      then: it is failing",
    "",
  ].join("\n");
}

function normalizedRun(options: { codeRevision: string | null }): TestResultRunRecordInput {
  return {
    format: 1,
    run: {
      id: RUN_ID,
      completed_at: "2026-06-24T12:00:00.000Z",
    },
    producer: {
      kind: "local",
      label: "neutral-runner",
      code_revision: options.codeRevision,
    },
    cases: [
      {
        id: "case-covered",
        display_name: "covers mapped criterion",
        status: "passed",
        refs: [{ item_ref: "@coverage-api-widget", ac_id: "ac-covered" }],
      },
      {
        id: "case-failing",
        display_name: "fails mapped criterion",
        status: "failed",
        refs: [{ item_ref: "@coverage-api-widget", ac_id: "ac-failing" }],
      },
    ],
  };
}

function commit(tempDir: string, message: string, env: Record<string, string> = {}): string {
  execSync(`git add -A && git commit -m "${message}"`, {
    cwd: tempDir,
    env: { ...process.env, ...env },
    stdio: "pipe",
  });
  return head(tempDir);
}

function head(tempDir: string): string {
  return execSync("git rev-parse HEAD", {
    cwd: tempDir,
    encoding: "utf-8",
    stdio: "pipe",
  }).trim();
}

function shadowHead(tempDir: string): string {
  return execSync("git rev-parse HEAD", {
    cwd: path.join(tempDir, ".kspec"),
    encoding: "utf-8",
    stdio: "pipe",
  }).trim();
}

function shadowStatus(tempDir: string): string {
  return execSync("git status --short", {
    cwd: path.join(tempDir, ".kspec"),
    encoding: "utf-8",
    stdio: "pipe",
  }).trim();
}

function commitShadow(tempDir: string, message: string, env: Record<string, string> = {}): string {
  execSync(`git add -A && git commit -m "${message}"`, {
    cwd: path.join(tempDir, ".kspec"),
    env: { ...process.env, KSPEC_SHADOW_COMMIT: "1", ...env },
    stdio: "pipe",
  });
  return shadowHead(tempDir);
}

const CLI_ACTOR_ENV = { KSPEC_AUTHOR: "neutral-operator" };

function cliJson<T>(tempDir: string, args: string, options: KspecOptions = {}): T {
  const result = kspec(`--json ${args}`, tempDir, {
    ...options,
    env: { ...CLI_ACTOR_ENV, ...options.env },
  });
  return JSON.parse(result.stdout) as T;
}

async function daemonJson<T>(
  tempDir: string,
  urlPath: string,
  body: unknown,
): Promise<{ response: Response; data: T }> {
  const { app } = createTestApp();
  const response = await requestJson(app, tempDir, "POST", urlPath, body);
  return { response, data: JSON.parse(await response.text()) as T };
}

async function setupResolutionShadowProject(): Promise<string> {
  const tempDir = await createTempDir("coverage-resolution-cli-daemon-shadow-");
  tempDirs.push(tempDir);
  initGitRepo(tempDir);
  writeFileSync(path.join(tempDir, "README.md"), "# Coverage Resolution Fixture\n");
  commit(tempDir, "initial project");

  const initResult = kspec("init --no-prompt", tempDir, { env: CLI_ACTOR_ENV });
  if (initResult.exitCode !== 0) {
    throw new Error(`kspec init --no-prompt failed: ${initResult.stderr || initResult.stdout}`);
  }

  writeFileSync(
    path.join(tempDir, ".kspec", "kynetic.yaml"),
    [
      'kynetic: "1.1"',
      "task_storage:",
      "  format: split",
      "project:",
      "  name: Coverage Resolution Shadow Fixture",
      "includes:",
      "  - modules/coverage.yaml",
      "coverage:",
      "  scan_paths:",
      "    - tests",
      "",
    ].join("\n"),
  );
  mkdirSync(path.join(tempDir, ".kspec", "modules"), { recursive: true });
  writeFileSync(
    path.join(tempDir, ".kspec", "modules", "coverage.yaml"),
    coverageModule("covered criterion"),
  );
  commitShadow(tempDir, "coverage resolution fixture specs", {
    GIT_AUTHOR_DATE: "2026-06-24T11:40:00.000Z",
    GIT_COMMITTER_DATE: "2026-06-24T11:40:00.000Z",
  });

  mkdirSync(path.join(tempDir, "tests"), { recursive: true });
  writeFileSync(
    path.join(tempDir, "kspec.config.yaml"),
    [
      "identity:",
      "  author: neutral-operator",
      "coverage:",
      "  scan_paths:",
      "    - tests",
      "",
    ].join("\n"),
  );
  writeFileSync(
    path.join(tempDir, "tests", "coverage-resolution.test.ts"),
    ["// AC: @coverage-api-widget ac-covered", "it('covers mapped criterion', () => {});", ""].join(
      "\n",
    ),
  );
  const fixtureCommit = commit(tempDir, "coverage resolution fixture sources", {
    GIT_AUTHOR_DATE: "2026-06-24T11:45:00.000Z",
    GIT_COMMITTER_DATE: "2026-06-24T11:45:00.000Z",
  });

  const ctx = await initContext(tempDir, { syncMode: "skip" });
  await writeTestRun(ctx, normalizedRun({ codeRevision: fixtureCommit }), { skipCommit: true });
  commitShadow(tempDir, "coverage resolution fixture run", {
    GIT_AUTHOR_DATE: "2026-06-24T12:05:00.000Z",
    GIT_COMMITTER_DATE: "2026-06-24T12:05:00.000Z",
  });
  writeFileSync(
    path.join(tempDir, ".kspec", "modules", "coverage.yaml"),
    coverageModule("changed criterion"),
  );
  commitShadow(tempDir, "change covered criterion text", {
    GIT_AUTHOR_DATE: "2026-06-24T13:00:00.000Z",
    GIT_COMMITTER_DATE: "2026-06-24T13:00:00.000Z",
  });

  return tempDir;
}

function normalizeResolutionResponse(value: any): any {
  return {
    ...value,
    current: {
      ...value.current,
      source_evidence_ids: value.current.source_evidence_ids.map(normalizeEvidenceId),
      secondary_causes: value.current.secondary_causes.map((cause: any) => ({
        ...cause,
        source_evidence_ids: cause.source_evidence_ids.map(normalizeEvidenceId),
      })),
    },
    effects: value.effects.map((effect: any) =>
      effect.kind === "verification_stamp"
        ? {
            ...effect,
            verified_at: "<timestamp>",
          }
        : effect.kind === "task" && effect.operation === "created_task"
          ? {
              ...effect,
              task_ref: "<created-task>",
            }
          : effect,
    ),
  };
}

function normalizeEvidenceId(value: string): string {
  return value
    .replace(/annotation:\/tmp\/coverage-resolution-cli-daemon-[^/]+/g, "annotation:<tmp>")
    .replace(
      /recorded_verification:([^:]+):([^:]+):.+$/,
      "recorded_verification:$1:$2:<timestamp>",
    );
}

describe("coverage resolution CLI and daemon adapters", () => {
  // AC: @coverage-resolution-mutation-interface ac-action-set
  // AC: @coverage-resolution-mutation-interface ac-current-state-required
  // AC: @coverage-resolution-mutation-interface ac-cli-daemon-equivalence
  // AC: @trait-api-endpoint ac-1
  // AC: @trait-api-endpoint ac-5
  // AC: @trait-api-endpoint ac-6
  // AC: @trait-semantic-exit-codes ac-1
  it("returns equivalent successful responses for all resolution actions", async () => {
    const cliReverifyDir = await setupResolutionProject();
    const daemonReverifyDir = await setupResolutionProject();

    const cliReverify = cliJson(
      cliReverifyDir,
      "coverage resolve reverify --item @coverage-api-widget --ac ac-covered --actor neutral-operator",
    );
    const daemonReverify = await daemonJson<any>(
      daemonReverifyDir,
      "/api/coverage/resolve/reverify",
      {
        target: { item_ref: "@coverage-api-widget", ac_id: "ac-covered" },
        actor: "neutral-operator",
      },
    );

    expect(daemonReverify.response.status).toBe(200);
    expect(daemonReverify.response.headers.get("X-Request-Id")).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(normalizeResolutionResponse(daemonReverify.data.data)).toEqual(
      normalizeResolutionResponse(cliReverify),
    );

    const cliRevertDir = await setupResolutionProject();
    const daemonRevertDir = await setupResolutionProject();
    const cliRevertPreview = cliJson<any>(
      cliRevertDir,
      "coverage resolve revert-spec-text --item @coverage-api-widget --ac ac-covered --dry-run",
    );
    const daemonRevertPreview = await daemonJson<any>(
      daemonRevertDir,
      "/api/coverage/resolve/revert-spec-text?dry_run=true",
      { target: { item_ref: "@coverage-api-widget", ac_id: "ac-covered" } },
    );

    expect(normalizeResolutionResponse(daemonRevertPreview.data.data)).toEqual(
      normalizeResolutionResponse(cliRevertPreview),
    );

    const cliRevert = cliJson(
      cliRevertDir,
      `coverage resolve revert-spec-text --item @coverage-api-widget --ac ac-covered --expected-fingerprint ${cliRevertPreview.target.current_fingerprint}`,
    );
    const daemonRevert = await daemonJson<any>(
      daemonRevertDir,
      "/api/coverage/resolve/revert-spec-text",
      {
        target: { item_ref: "@coverage-api-widget", ac_id: "ac-covered" },
        expected_current_fingerprint: daemonRevertPreview.data.data.target.current_fingerprint,
      },
    );

    expect(daemonRevert.response.status).toBe(200);
    expect(normalizeResolutionResponse(daemonRevert.data.data)).toEqual(
      normalizeResolutionResponse(cliRevert),
    );

    const cliDispatchDir = await setupResolutionProject();
    const daemonDispatchDir = await setupResolutionProject();
    const cliDispatch = cliJson(
      cliDispatchDir,
      "coverage resolve dispatch-fix --item @coverage-api-widget --ac ac-failing --automation-eligible",
    );
    const daemonDispatch = await daemonJson<any>(
      daemonDispatchDir,
      "/api/coverage/resolve/dispatch-fix",
      {
        target: { item_ref: "@coverage-api-widget", ac_id: "ac-failing" },
        automation_eligible: true,
      },
    );

    expect(daemonDispatch.response.status).toBe(200);
    expect(normalizeResolutionResponse(daemonDispatch.data.data)).toEqual(
      normalizeResolutionResponse(cliDispatch),
    );
  });

  // AC: @coverage-resolution-mutation-interface ac-cli-daemon-equivalence
  // AC: @trait-api-endpoint ac-5
  it("commits CLI reverify verification stamps to the shadow branch", async () => {
    const cliDir = await setupResolutionShadowProject();
    const beforeHead = shadowHead(cliDir);

    const cliReverify = cliJson<any>(
      cliDir,
      "coverage resolve reverify --item @coverage-api-widget --ac ac-covered --actor neutral-operator",
    );

    expect(cliReverify).toMatchObject({
      action: "explicit-reverify",
      stored: true,
      effects: expect.arrayContaining([expect.objectContaining({ operation: "wrote_stamp" })]),
    });
    expect(shadowHead(cliDir)).not.toBe(beforeHead);
    expect(shadowStatus(cliDir)).toBe("");
  });

  // AC: @coverage-resolution-mutation-interface ac-dry-run-preview
  // AC: @trait-dry-run ac-1
  // AC: @trait-dry-run ac-2
  // AC: @trait-dry-run ac-3
  // AC: @trait-dry-run ac-5
  // AC: @trait-dry-run ac-6
  it("previews dispatch-fix through CLI and daemon without changing state", async () => {
    const cliDir = await setupResolutionProject({ changeText: false });
    const daemonDir = await setupResolutionProject({ changeText: false });
    const cliHead = head(cliDir);
    const daemonHead = head(daemonDir);

    const cliPreview = cliJson(
      cliDir,
      "coverage resolve dispatch-fix --item @coverage-api-widget --ac ac-failing --automation-eligible --dry-run",
    );
    const daemonPreview = await daemonJson<any>(
      daemonDir,
      "/api/coverage/resolve/dispatch-fix?dry_run=true",
      {
        target: { item_ref: "@coverage-api-widget", ac_id: "ac-failing" },
        automation_eligible: true,
      },
    );

    expect(head(cliDir)).toBe(cliHead);
    expect(head(daemonDir)).toBe(daemonHead);
    expect(daemonPreview.response.status).toBe(200);
    expect(daemonPreview.data.data.dry_run).toBe(true);
    expect(daemonPreview.data.data.stored).toBe(false);
    expect(normalizeResolutionResponse(daemonPreview.data.data)).toEqual(
      normalizeResolutionResponse(cliPreview),
    );
  });

  // AC: @trait-dry-run ac-4
  // AC: @trait-semantic-exit-codes ac-2
  // AC: @trait-error-guidance ac-1
  // AC: @trait-error-guidance ac-2
  // AC: @trait-error-guidance ac-6
  it("reports precondition failures with semantic CLI and HTTP errors", async () => {
    const cliDir = await setupResolutionProject();
    const daemonDir = await setupResolutionProject();

    const cliResult = kspec(
      "--json coverage resolve reverify --item @coverage-api-widget --ac ac-failing",
      cliDir,
      { expectFail: true, env: CLI_ACTOR_ENV },
    );
    const cliBody = JSON.parse(cliResult.stdout);
    const daemonResult = await daemonJson<any>(daemonDir, "/api/coverage/resolve/reverify", {
      target: { item_ref: "@coverage-api-widget", ac_id: "ac-failing" },
    });

    expect(cliResult.exitCode).toBe(1);
    expect(cliBody.diagnostics[0]).toMatchObject({
      satisfied: false,
      suggestion: expect.stringContaining("Fix failing tests"),
    });
    expect(daemonResult.response.status).toBe(409);
    expect(daemonResult.data).toMatchObject({
      error: "precondition_failed",
      suggestion: expect.stringContaining("Fix failing tests"),
      response: {
        action: "explicit-reverify",
        stored: false,
      },
    });
  });

  // AC: @coverage-resolution-mutation-interface ac-static-readonly-refusal
  // AC: @trait-semantic-exit-codes ac-4
  it("refuses non-dry-run writes in read-only mode while allowing computed dry runs", async () => {
    const cliDir = await setupResolutionProject();
    const daemonDir = await setupResolutionProject();

    const cliResult = kspec(
      "--json coverage resolve reverify --item @coverage-api-widget --ac ac-covered --actor neutral-operator",
      cliDir,
      { expectFail: true, env: { ...CLI_ACTOR_ENV, KSPEC_READ_ONLY: "1" } },
    );
    const cliDryRunResult = kspec(
      "--json coverage resolve reverify --item @coverage-api-widget --ac ac-covered --actor neutral-operator --dry-run",
      cliDir,
      { env: { ...CLI_ACTOR_ENV, KSPEC_READ_ONLY: "1" } },
    );
    const cliDryRun = JSON.parse(cliDryRunResult.stdout);
    const { app } = createTestApp();
    const daemonResponse = await makeRequest(app, daemonDir, "/api/coverage/resolve/reverify", {
      method: "POST",
      headers: { "X-Kspec-Read-Only": "true" },
      body: JSON.stringify({
        target: { item_ref: "@coverage-api-widget", ac_id: "ac-covered" },
        actor: "neutral-operator",
      }),
    });

    expect(cliResult.exitCode).toBe(3);
    expect(JSON.parse(cliResult.stderr)).toMatchObject({
      success: false,
      details: {
        code: "coverage_resolution_read_only",
        suggestion: expect.stringContaining("live writable"),
      },
    });
    expect(cliDryRun).toMatchObject({ dry_run: true, stored: false });
    expect(daemonResponse.status).toBe(409);
    expect(await daemonResponse.json()).toMatchObject({
      error: "read_only",
      suggestion: expect.stringContaining("live writable"),
    });
  });

  // AC: @trait-api-endpoint ac-2
  // AC: @trait-api-endpoint ac-3
  // AC: @trait-error-guidance ac-3
  // AC: @trait-error-guidance ac-5
  // AC: @trait-semantic-exit-codes ac-6
  // AC: @trait-semantic-exit-codes ac-8
  it("returns structured validation and not-found diagnostics", async () => {
    const cliDir = await setupResolutionProject();
    const daemonDir = await setupResolutionProject();
    const { app } = createTestApp();

    const invalidBodyResponse = await requestJson(
      app,
      daemonDir,
      "POST",
      "/api/coverage/resolve/reverify",
      { target: { item_ref: "@coverage-api-widget" } },
    );
    const notFoundResponse = await requestJson(
      app,
      daemonDir,
      "POST",
      "/api/coverage/resolve/reverify",
      { target: { item_ref: "@missing-widget", ac_id: "ac-covered" } },
    );
    const cliResult = kspec(
      "--json coverage resolve reverify --item @missing-widget --ac ac-covered",
      cliDir,
      { expectFail: true },
    );

    expect(invalidBodyResponse.status).toBe(400);
    expect(await invalidBodyResponse.json()).toMatchObject({
      error: "validation_error",
      details: [expect.objectContaining({ field: "target.ac_id" })],
    });
    expect(notFoundResponse.status).toBe(404);
    expect(await notFoundResponse.json()).toMatchObject({
      error: "not_found",
      suggestion: expect.stringContaining("kspec search"),
    });
    expect(cliResult.exitCode).toBe(1);
    expect(JSON.parse(cliResult.stderr)).toMatchObject({
      success: false,
      details: {
        code: "coverage_resolution_target_not_found",
        suggestion: expect.stringContaining("kspec search"),
      },
    });
  });
});
