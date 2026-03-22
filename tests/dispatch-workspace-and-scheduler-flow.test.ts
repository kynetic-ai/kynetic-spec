import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { execSync } from "node:child_process";
import * as path from "node:path";
import * as YAML from "yaml";
import * as invocationModule from "../src/agent-runtime/invocation.js";
import { DispatchEngine } from "../src/agent-runtime/dispatch.js";
import {
  reconcileDispatchWorkspaceArtifacts,
  reconcileDispatchWorkspaceLifecycle,
} from "../src/agent-runtime/workspace.js";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  testUlid,
} from "./helpers/cli.js";

const MOCK_KSPEC_CLI = path.join(__dirname, "mocks", "kspec-capture-mock.cjs");

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
  git(dir, "checkout -b agent-dev");
}

async function setupProject(dir: string): Promise<void> {
  await fs.writeFile(
    path.join(dir, "kynetic.yaml"),
    'kynetic: "1"\ntitle: Test Project\n',
    "utf-8",
  );
  await fs.writeFile(
    path.join(dir, "kynetic.meta.yaml"),
    [
      'kynetic_meta: "1.0"',
      "agents:",
      "  - _ulid: 01AGNT00000000000000000000",
      "    id: task-worker",
      '    name: "Task Worker"',
      "    dispatch:",
      "      - on: task.ready",
      "      - on: task.needs_work",
      "    concurrency:",
      "      max_concurrent: 1",
      "    adapter: mock-acp",
      "    auto_approve: false",
      "  - _ulid: 01AGNT00000000000000000001",
      "    id: pr-reviewer",
      '    name: "PR Reviewer"',
      "    dispatch:",
      "      - on: task.pending_review",
      "    concurrency:",
      "      max_concurrent: 1",
      "    adapter: mock-acp",
      "    auto_approve: false",
      "",
    ].join("\n"),
    "utf-8",
  );
  await fs.writeFile(
    path.join(dir, "kspec.config.yaml"),
    [
      "dispatch:",
      "  base_branch: agent-dev",
      "  worktree_root: .dispatch-root",
      "  bootstrap:",
      "    steps:",
      "      - run: mkdir -p .dispatch-cache && printf ready > .dispatch-cache/bootstrap.txt",
      "        idempotent: true",
      "",
    ].join("\n"),
    "utf-8",
  );
}

type TaskRecord = {
  _ulid: string;
  title: string;
  slugs: string[];
  status: "pending" | "pending_review" | "needs_work" | "completed";
  priority?: number;
  automation?: "eligible" | "manual_only";
  created_at?: string;
  review_url?: string;
};

async function writeTasks(dir: string, tasks: TaskRecord[]): Promise<void> {
  await fs.writeFile(
    path.join(dir, "project.tasks.yaml"),
    YAML.stringify({
      tasks: tasks.map((task) => ({
        _ulid: task._ulid,
        type: "task",
        title: task.title,
        slugs: task.slugs,
        status: task.status,
        priority: task.priority ?? 1,
        blocked_by: [],
        depends_on: [],
        context: [],
        tags: [],
        vcs_refs: [],
        notes: [],
        todos: [],
        created_at: task.created_at ?? new Date().toISOString(),
        automation: task.automation ?? "eligible",
        ...(task.review_url ? { review_url: task.review_url } : {}),
      })),
    }),
    "utf-8",
  );
}

async function waitFor(
  assertion: () => void | Promise<void>,
  options?: { attempts?: number; delayMs?: number },
): Promise<void> {
  const attempts = options?.attempts ?? 120;
  const delayMs = options?.delayMs ?? 10;
  let lastError: unknown;

  for (let i = 0; i < attempts; i++) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}

// AC: @dispatch-workspace-configuration ac-1
// AC: @dispatch-invocation-worktree-isolation ac-1
// AC: @dispatch-invocation-worktree-isolation ac-2
// AC: @dispatch-invocation-worktree-isolation ac-3
// AC: @canonical-task-workspace-contract ac-2
// AC: @canonical-task-workspace-contract ac-4
// AC: @dispatch-runtime-bootstrap-contract ac-1
// AC: @dispatch-workspace-orientation-prompt ac-1
// AC: @dispatch-workspace-orientation-prompt ac-2
// AC: @dispatch-workspace-orientation-prompt ac-3
// AC: @dispatch-role-workflow-entry-contract ac-1
// AC: @dispatch-role-workflow-entry-contract ac-2
// AC: @dispatch-workspace-cleanup-policy ac-1
// AC: @dispatch-workspace-cleanup-policy ac-2
// AC: @dispatch-workspace-cleanup-policy ac-3
// AC: @dispatch-scheduling-priority-model ac-2
// AC: @dispatch-scheduling-priority-model ac-6
describe("dispatch workspace and scheduler flow", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-dispatch-workspace-flow-");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  it("runs a worker-reviewer-fix-cycle flow in isolated worktrees and preserves scheduler ordering", { timeout: 30_000 }, async () => {
    await seedRepo(tempDir);
    await setupProject(tempDir);

    const primaryTaskId = testUlid("TASK", 41);
    const trailingTaskId = testUlid("TASK", 42);
    const primaryTaskRef = `@${primaryTaskId}`;
    const trailingTaskRef = `@${trailingTaskId}`;
    const primaryTitle = "Dispatch Flow Primary";
    const primarySlug = "task-dispatch-flow-primary";
    const trailingTitle = "Dispatch Flow Trailing";
    const trailingSlug = "task-dispatch-flow-trailing";

    await writeTasks(tempDir, [
      {
        _ulid: primaryTaskId,
        title: primaryTitle,
        slugs: [primarySlug],
        status: "pending",
        created_at: "2026-03-12T00:00:00.000Z",
      },
      {
        _ulid: trailingTaskId,
        title: trailingTitle,
        slugs: [trailingSlug],
        status: "pending",
        created_at: "2026-03-12T00:00:01.000Z",
      },
    ]);

    const invocations: Array<{
      agentId: string;
      taskRef: string;
      cwd: string;
      prompt: string;
      env: NodeJS.ProcessEnv | undefined;
    }> = [];
    let firstWorkerHead: string | null = null;
    let reviewerCwd: string | null = null;
    let reviewerHandled = false;
    let trailingHandled = false;
    let fixCycleHandled = false;

    vi.spyOn(invocationModule, "runInvocation").mockImplementation(async (options) => {
      const invocation = {
        agentId: options.agent.id,
        taskRef: options.taskRef,
        cwd: options.cwd,
        prompt: options.prompt,
        env: options.env,
      };
      invocations.push(invocation);

      if (invocations.length === 1) {
        expect(invocation.agentId).toBe("task-worker");
        expect(invocation.taskRef).toBe(primaryTaskRef);
        expect(invocation.cwd).toBe(path.join(tempDir, ".dispatch-root", `${primarySlug}-01task00`));
        await expect(
          fs.readFile(path.join(invocation.cwd, ".dispatch-cache", "bootstrap.txt"), "utf-8"),
        ).resolves.toBe("ready");
        expect(invocation.env?.KSPEC_DISPATCH_BASE_BRANCH).toBe("agent-dev");
        expect(invocation.env?.KSPEC_DISPATCH_MERGE_TARGET).toBe("agent-dev");
        expect(invocation.prompt).toContain("Workflow entrypoint: `/kspec:task-work`");
        expect(invocation.prompt).toContain("Workspace mode: mutable worker branch");
        expect(invocation.prompt).toContain("Integration target: agent-dev @");

        await fs.writeFile(path.join(invocation.cwd, "worker-progress.txt"), "progress\n", "utf-8");
        git(invocation.cwd, "add worker-progress.txt");
        git(invocation.cwd, 'commit -m "worker progress"');
        firstWorkerHead = git(invocation.cwd, "rev-parse HEAD");

        await writeTasks(tempDir, [
          {
            _ulid: primaryTaskId,
            title: primaryTitle,
            slugs: [primarySlug],
            status: "pending_review",
            review_url: "https://example.com/pr/41",
            created_at: "2026-03-12T00:00:00.000Z",
          },
          {
            _ulid: trailingTaskId,
            title: trailingTitle,
            slugs: [trailingSlug],
            status: "pending",
            created_at: "2026-03-12T00:00:01.000Z",
          },
        ]);
      } else if (
        invocation.agentId === "pr-reviewer"
        && invocation.taskRef === primaryTaskRef
        && !reviewerHandled
      ) {
        reviewerHandled = true;
        expect(invocation.agentId).toBe("pr-reviewer");
        expect(invocation.taskRef).toBe(primaryTaskRef);
        expect(invocation.cwd).toBe(path.join(tempDir, ".dispatch-root", `${primarySlug}-01task00-review`));
        reviewerCwd = invocation.cwd;
        expect(invocation.cwd).not.toBe(invocations[0]?.cwd);
        expect(git(invocation.cwd, "branch --show-current")).toBe("");
        expect(git(invocation.cwd, "rev-parse HEAD")).toBe(firstWorkerHead);
        expect(invocation.prompt).toContain("Workflow entrypoint: `/kspec:review`");
        expect(invocation.prompt).toContain("Workspace mode: detached review snapshot");
        expect(invocation.prompt).toContain("Cycle context: Review cycle on a detached snapshot.");

        await writeTasks(tempDir, [
          {
            _ulid: primaryTaskId,
            title: primaryTitle,
            slugs: [primarySlug],
            status: "needs_work",
            created_at: "2026-03-12T00:00:00.000Z",
          },
          {
            _ulid: trailingTaskId,
            title: trailingTitle,
            slugs: [trailingSlug],
            status: "pending",
            created_at: "2026-03-12T00:00:01.000Z",
          },
        ]);
      } else if (
        invocation.agentId === "task-worker"
        && invocation.taskRef === trailingTaskRef
        && !trailingHandled
      ) {
        trailingHandled = true;
        expect(invocation.cwd).toBe(path.join(tempDir, ".dispatch-root", `${trailingSlug}-01task00`));
        expect(invocation.prompt).toContain("Workflow entrypoint: `/kspec:task-work`");

        await writeTasks(tempDir, [
          {
            _ulid: primaryTaskId,
            title: primaryTitle,
            slugs: [primarySlug],
            status: "needs_work",
            created_at: "2026-03-12T00:00:00.000Z",
          },
          {
            _ulid: trailingTaskId,
            title: trailingTitle,
            slugs: [trailingSlug],
            status: "completed",
            created_at: "2026-03-12T00:00:01.000Z",
          },
        ]);
      } else if (
        invocation.agentId === "task-worker"
        && invocation.taskRef === primaryTaskRef
        && firstWorkerHead !== null
        && !fixCycleHandled
      ) {
        fixCycleHandled = true;
        expect(invocation.agentId).toBe("task-worker");
        expect(invocation.taskRef).toBe(primaryTaskRef);
        expect(invocation.cwd).toBe(invocations[0]?.cwd);
        expect(git(invocation.cwd, "rev-parse HEAD")).toBe(firstWorkerHead);
        expect(invocation.prompt).toContain("Fix cycle");
        expect(invocation.prompt).toContain("Cycle context: Fix cycle after review.");

        await writeTasks(tempDir, [
          {
            _ulid: primaryTaskId,
            title: primaryTitle,
            slugs: [primarySlug],
            status: "completed",
            created_at: "2026-03-12T00:00:00.000Z",
          },
          {
            _ulid: trailingTaskId,
            title: trailingTitle,
            slugs: [trailingSlug],
            status: "completed",
            created_at: "2026-03-12T00:00:01.000Z",
          },
        ]);
      }

      return {
        session: {} as never,
        outcome: "success" as const,
        durationMs: 1,
      };
    });

    const engine = new DispatchEngine({
      projectDir: tempDir,
      specDir: tempDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });

    await engine.start();

    await waitFor(() => {
      expect(invocations).toHaveLength(4);
    }, { attempts: 500, delayMs: 20 });

    expect(invocations[0] && [invocations[0].agentId, invocations[0].taskRef]).toEqual([
      "task-worker",
      primaryTaskRef,
    ]);
    expect(invocations[1] && [invocations[1].agentId, invocations[1].taskRef]).toEqual([
      "pr-reviewer",
      primaryTaskRef,
    ]);
    expect(invocations.map((entry) => [entry.agentId, entry.taskRef])).toContainEqual([
      "task-worker",
      trailingTaskRef,
    ]);
    expect(invocations.map((entry) => [entry.agentId, entry.taskRef])).toContainEqual([
      "task-worker",
      primaryTaskRef,
    ]);
    expect(reviewerHandled).toBe(true);
    expect(trailingHandled).toBe(true);
    expect(fixCycleHandled).toBe(true);

    await waitFor(async () => {
      await expect(fs.access(reviewerCwd!)).rejects.toThrow();
    }, { attempts: 500, delayMs: 20 });

    await engine.stop();

    const primaryWorkerDir = invocations[0]!.cwd;
    await fs.access(primaryWorkerDir);

    await reconcileDispatchWorkspaceLifecycle({
      projectDir: tempDir,
      taskRef: primaryTaskRef,
      cleanupState: { integrationState: "merged", taskStatus: "completed" },
      task: { title: primaryTitle, slugs: [primarySlug] },
    });
    await reconcileDispatchWorkspaceArtifacts(tempDir);

    await expect(fs.access(primaryWorkerDir)).rejects.toThrow();
    expect(git(tempDir, `branch --list dispatch/task/${primarySlug}/01task00`)).toBe("");
  });
});
