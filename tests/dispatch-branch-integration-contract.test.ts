import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import { execSync } from "node:child_process";
import * as path from "node:path";
import * as YAML from "yaml";
import { buildOrientationContext } from "../src/agent-runtime/dispatch.js";
import {
  provisionDispatchWorkspace,
  reconcileDispatchWorkspaceLifecycle,
} from "../src/agent-runtime/workspace.js";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  testUlid,
} from "./helpers/cli.js";

function git(cwd: string, command: string): string {
  return execSync(`git ${command}`, {
    cwd,
    stdio: "pipe",
    encoding: "utf-8",
  }).trim();
}

async function seedRepo(dir: string): Promise<void> {
  initGitRepo(dir);
  await fs.writeFile(path.join(dir, "README.md"), "seed\n", "utf-8");
  git(dir, "add README.md");
  git(dir, 'commit -m "init"');
}

async function setupShadowSpecDir(dir: string): Promise<string> {
  const specDir = path.join(dir, ".kspec");
  await fs.mkdir(specDir, { recursive: true });
  await fs.writeFile(
    path.join(specDir, "kynetic.yaml"),
    'kynetic: "1"\ntitle: "Dispatch Branch Integration Test"\n',
    "utf-8",
  );
  await fs.writeFile(path.join(specDir, "project.tasks.yaml"), "tasks: []\n", "utf-8");
  return specDir;
}

async function readWorkspaceRecord(
  registryPath: string,
  taskRef: string,
): Promise<Record<string, any>> {
  const raw = YAML.parse(await fs.readFile(registryPath, "utf-8")) as {
    workspaces?: Array<Record<string, any>>;
  };
  return raw.workspaces?.find((workspace) => workspace.task_ref === taskRef) ?? {};
}

async function createToolPath(options: { gh: boolean }): Promise<string> {
  const binDir = await createTempDir("kspec-dispatch-tools-");
  const gitPath = execSync("command -v git", {
    encoding: "utf-8",
    shell: "/bin/bash",
  }).trim();
  await fs.writeFile(
    path.join(binDir, "git"),
    `#!/bin/sh\nexec "${gitPath}" "$@"\n`,
    { encoding: "utf-8", mode: 0o755 },
  );
  if (options.gh) {
    await fs.writeFile(
      path.join(binDir, "gh"),
      '#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo "gh version 99.0.0"\n  exit 0\nfi\nexit 0\n',
      { encoding: "utf-8", mode: 0o755 },
    );
  }
  return binDir;
}

describe("dispatch branch integration contract", () => {
  let tempDir: string;
  let specDir: string;
  let originalPath: string | undefined;
  let originalSpecDir: string | undefined;
  let toolDirs: string[];

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-dispatch-branch-integration-");
    specDir = await setupShadowSpecDir(tempDir);
    originalPath = process.env.PATH;
    originalSpecDir = process.env.KSPEC_SPEC_DIR;
    process.env.KSPEC_SPEC_DIR = specDir;
    toolDirs = [];
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    if (originalSpecDir === undefined) {
      delete process.env.KSPEC_SPEC_DIR;
    } else {
      process.env.KSPEC_SPEC_DIR = originalSpecDir;
    }
    await Promise.all(toolDirs.map((dir) => cleanupTempDir(dir)));
    await cleanupTempDir(tempDir);
  });

  // AC: @dispatch-branch-integration-contract ac-1
  // AC: @dispatch-branch-integration-contract ac-3
  it("records the integration target branch, branch-point commit, and pull-request publication mode", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");
    git(tempDir, "remote add origin https://github.com/example/repo.git");
    const toolDir = await createToolPath({ gh: true });
    toolDirs.push(toolDir);
    process.env.PATH = `${toolDir}:${originalPath ?? ""}`;

    const taskRef = `@${testUlid("TASK", 21)}`;
    const baseCommit = git(tempDir, "rev-parse agent-dev");
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Dispatch Branch Integration",
        slugs: ["task-implement-dispatch-branch-integration-contract"],
      },
    });

    expect(workspace.metadata.integrationTargetBranch).toBe("agent-dev");
    expect(workspace.metadata.integrationTargetCommit).toBe(baseCommit);
    expect(workspace.metadata.publicationMode).toBe("pull_request");
    expect(workspace.metadata.integrationState).toBe("pending");
    expect(workspace.metadata.integrationOutcome).toBe("pull_request");
    const record = await readWorkspaceRecord(workspace.metadataPath, taskRef);
    expect(record.integration).toMatchObject({
      target_branch: "agent-dev",
      target_commit: baseCommit,
      publication_mode: "pull_request",
      outcome: "pull_request",
      status: "pending",
    });
  });

  // AC: @dispatch-branch-integration-contract ac-2
  // AC: @dispatch-branch-integration-contract ac-4
  it("renders worker orientation with canonical branch, integration target, canonical head, and PR target guidance", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");
    git(tempDir, "remote add origin https://github.com/example/repo.git");
    const toolDir = await createToolPath({ gh: true });
    toolDirs.push(toolDir);
    process.env.PATH = `${toolDir}:${originalPath ?? ""}`;

    const taskRef = `@${testUlid("TASK", 22)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Dispatch Worker Orientation",
        slugs: ["task-dispatch-worker-orientation"],
      },
    });

    const orientation = buildOrientationContext(
      taskRef,
      "task.ready",
      { title: "Dispatch Worker Orientation" },
      workspace.metadata,
      "worker",
    );

    expect(orientation).toContain(`Canonical branch: ${workspace.metadata.canonicalBranch}`);
    expect(orientation).toContain(
      `Integration target: ${workspace.metadata.integrationTargetBranch} @ ${workspace.metadata.integrationTargetCommit}`,
    );
    expect(orientation).toContain(`Canonical head: ${workspace.metadata.canonicalBranchHead}`);
    expect(orientation).toContain("Publication mode: pull_request");
    expect(orientation).toContain(
      `Publish via PR: create or update a pull request from ${workspace.metadata.canonicalBranch} into ${workspace.metadata.integrationTargetBranch}.`,
    );
    expect(orientation).not.toContain("hardcoded branch");
  });

  // AC: @dispatch-branch-integration-contract ac-2
  it("renders reviewer orientation with the snapshot under review", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");
    const taskRef = `@${testUlid("TASK", 23)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      role: "reviewer",
      task: {
        title: "Dispatch Reviewer Orientation",
        slugs: ["task-dispatch-reviewer-orientation"],
      },
    });

    const orientation = buildOrientationContext(
      taskRef,
      "task.pending_review",
      { title: "Dispatch Reviewer Orientation" },
      workspace.metadata,
      "reviewer",
    );

    expect(orientation).toContain(`Canonical branch: ${workspace.metadata.canonicalBranch}`);
    expect(orientation).toContain(
      `Snapshot under review: ${workspace.metadata.canonicalBranchHead}`,
    );
  });

  // AC: @dispatch-branch-integration-contract ac-3
  // AC: @dispatch-branch-integration-contract ac-5
  it("falls back to deterministic manual merge guidance when hosted PR tooling is unavailable", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");
    const toolDir = await createToolPath({ gh: false });
    toolDirs.push(toolDir);
    process.env.PATH = `${toolDir}:${originalPath ?? ""}`;

    const taskRef = `@${testUlid("TASK", 24)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Dispatch Manual Merge Guidance",
        slugs: ["task-dispatch-manual-merge-guidance"],
      },
    });

    const orientation = buildOrientationContext(
      taskRef,
      "task.ready",
      { title: "Dispatch Manual Merge Guidance" },
      workspace.metadata,
      "worker",
    );

    expect(workspace.metadata.publicationMode).toBe("manual_merge");
    expect(workspace.metadata.integrationOutcome).toBe("manual_merge");
    expect(orientation).toContain("Publication mode: manual_merge");
    expect(orientation).toContain(
      `Publish via manual merge: merge ${workspace.metadata.canonicalBranch} back into ${workspace.metadata.integrationTargetBranch}; if conflicts occur, stop and escalate with the conflict details instead of improvising.`,
    );
  });

  // AC: @dispatch-branch-integration-contract ac-3
  // AC: @dispatch-branch-integration-contract ac-4
  it("re-evaluates publication mode for legacy pending workspace records when PR tooling is available", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");
    git(tempDir, "remote add origin https://github.com/example/repo.git");
    const toolDir = await createToolPath({ gh: true });
    toolDirs.push(toolDir);
    process.env.PATH = `${toolDir}:${originalPath ?? ""}`;

    const taskRef = `@${testUlid("TASK", 26)}`;
    const baseCommit = git(tempDir, "rev-parse agent-dev");
    const registryPath = path.join(specDir, "project.dispatch-workspaces.yaml");
    await fs.writeFile(
      registryPath,
      YAML.stringify({
        kynetic_dispatch_workspaces: "1.0",
        workspaces: [
          {
            workspace_id: "dispatch-workspace-legacy",
            task_ref: taskRef,
            task_slug: "task-legacy-branch-integration",
            worktree_root: path.join(tempDir, ".kspec-worktrees"),
            resolved_base_branch: "agent-dev",
            base_branch_point: baseCommit,
            canonical_branch: "dispatch/task/task-legacy-branch-integration/legacy",
            canonical_branch_head: baseCommit,
            lifecycle_state: "ready",
            active_role: null,
            worktrees: {
              worker: {
                path: path.join(tempDir, ".kspec-worktrees", "task-legacy-branch-integration-legacy"),
                branch_mode: "branch",
                branch_ref: "dispatch/task/task-legacy-branch-integration/legacy",
                head: baseCommit,
                last_seen_at: new Date().toISOString(),
              },
              reviewer: null,
            },
            bootstrap: {
              status: "not_started",
              detail: null,
              updated_at: new Date().toISOString(),
            },
            integration: {
              status: "pending",
              target_branch: "agent-dev",
              detail: null,
              updated_at: new Date().toISOString(),
            },
            health: {
              status: "healthy",
              summary: "healthy",
              issues: [],
              updated_at: new Date().toISOString(),
            },
            cleanup: {
              status: "not_scheduled",
              eligible: false,
              reason: null,
              detail: null,
              updated_at: new Date().toISOString(),
            },
            timestamps: {
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              last_reconciled_at: new Date().toISOString(),
              last_active_at: null,
              closed_at: null,
            },
          },
        ],
      }),
      "utf-8",
    );

    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Legacy Dispatch Branch Integration",
        slugs: ["task-legacy-branch-integration"],
      },
    });

    expect(workspace.metadata.publicationMode).toBe("pull_request");
    expect(workspace.metadata.integrationOutcome).toBe("pull_request");
    const record = await readWorkspaceRecord(workspace.metadataPath, taskRef);
    expect(record.integration).toMatchObject({
      status: "pending",
      target_branch: "agent-dev",
      target_commit: baseCommit,
      publication_mode: "pull_request",
      outcome: "pull_request",
    });
  });

  // AC: @dispatch-branch-integration-contract ac-6
  it("persists integration outcomes when merge-back state changes become known", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");
    const taskRef = `@${testUlid("TASK", 25)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Dispatch Integration Outcome",
        slugs: ["task-dispatch-integration-outcome"],
      },
    });

    const merged = await reconcileDispatchWorkspaceLifecycle({
      projectDir: tempDir,
      taskRef,
      cleanupState: {
        integrationState: "merged",
        taskStatus: "completed",
      },
      task: {
        title: "Dispatch Integration Outcome",
        slugs: ["task-dispatch-integration-outcome"],
      },
    });
    const mergedMetadata = JSON.parse(
      JSON.stringify(await readWorkspaceRecord(workspace.metadataPath, taskRef)),
    ) as Record<string, any>;

    expect(merged).not.toBeNull();
    expect(mergedMetadata).toMatchObject({
      integration: {
        status: "merged",
        outcome: "merged",
      },
      cleanup: {
        eligible: true,
        reason: "integrated-into-base-branch",
      },
    });

    await reconcileDispatchWorkspaceLifecycle({
      projectDir: tempDir,
      taskRef,
      cleanupState: {
        integrationState: "reset",
        taskStatus: "pending",
      },
      task: {
        title: "Dispatch Integration Outcome",
        slugs: ["task-dispatch-integration-outcome"],
      },
    });
    const resetMetadata = JSON.parse(
      JSON.stringify(await readWorkspaceRecord(workspace.metadataPath, taskRef)),
    ) as Record<string, any>;

    expect(resetMetadata).toMatchObject({
      integration: {
        status: "reset",
        outcome: "reset",
      },
      cleanup: {
        eligible: true,
        reason: "task-reset",
      },
    });
  });
});
