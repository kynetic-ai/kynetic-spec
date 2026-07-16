import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { stringify as yamlStringify } from "yaml";
import { registerAgentCommands } from "../src/cli/commands/agent.js";
import * as parser from "../src/parser/index.js";
import { getRunningDaemonClient } from "../src/cli/daemon-client.js";
import { runWithOutputState } from "../src/cli/output.js";
import {
  cleanupTempDir,
  createIsolatedKspecHome,
  createTempDir,
  initGitRepo,
  kspec,
  type IsolatedKspecHome,
  type KspecOptions,
} from "./helpers/cli.js";
import {
  startMockDaemon,
  writeMockDaemonMetadata,
  type MockDaemonClient,
} from "./helpers/mock-daemon.js";

vi.mock("../src/cli/daemon-client.js", () => ({
  getRunningDaemonClient: vi.fn<typeof getRunningDaemonClient>(),
}));

const TASK_ID = "01KXH2PT5BATGSN8TNY7W7NE55";
const CLEANUP_ID = "01KXH2PT5BATGSN8TNY7W7NE56";
const NOW = "2026-07-16T12:00:00.000Z";

const CLOSED_ERRORS = [
  [
    "validation_failed",
    "Invalid dispatch lifecycle request.",
    "Check the command options and try again.",
    1,
  ],
  ["task_not_found", "Task not found.", "Verify the task reference with `kspec task get`.", 3],
  ["task_identity_ambiguous", "Task reference is ambiguous.", "Use a canonical task ULID.", 3],
  [
    "task_identity_mismatch",
    "Task identity does not match the resolved task.",
    "Provide one matching task reference or task ID.",
    3,
  ],
  [
    "invalid_transition",
    "Dispatch lifecycle transition is not valid from the current authority.",
    "Check dispatch status and choose a valid action.",
    3,
  ],
  [
    "control_store_unavailable",
    "Dispatch control storage is unavailable.",
    "Retry after the daemon can access the control store.",
    3,
  ],
  [
    "control_store_corrupt",
    "Dispatch control storage is corrupt.",
    "Repair the dispatch control record before retrying.",
    3,
  ],
  [
    "control_commit_failed",
    "Dispatch control change could not be committed.",
    "Retry; if it persists, inspect shadow-branch health.",
    3,
  ],
  [
    "cancellation_timeout",
    "Dispatch cancellation timed out.",
    "Retry hard stop after active work settles.",
    3,
  ],
  [
    "cancellation_failed",
    "Dispatch cancellation failed.",
    "Retry hard stop and inspect daemon logs.",
    3,
  ],
  [
    "session_closure_failed",
    "Dispatch session closure failed.",
    "Retry hard stop after the session store is available.",
    3,
  ],
  [
    "cleanup_ownership_mismatch",
    "Dispatch cleanup ownership could not be verified.",
    "Do not retry blindly; inspect the matching session evidence.",
    3,
  ],
  [
    "cleanup_process_birth_mismatch",
    "Dispatch process identity changed before cleanup.",
    "Do not signal the process; inspect the matching session evidence.",
    3,
  ],
  [
    "cleanup_leader_missing_group_alive",
    "Dispatch cleanup found a live verified process group.",
    "Retry hard stop after the process group exits.",
    3,
  ],
  [
    "cleanup_identity_unverifiable",
    "Dispatch cleanup identity cannot be verified.",
    "Restore readable ownership evidence before retrying.",
    3,
  ],
  [
    "cleanup_group_unverifiable",
    "Dispatch cleanup group cannot be verified.",
    "Do not signal the group; restore verification evidence before retrying.",
    3,
  ],
  [
    "internal_error",
    "Dispatch lifecycle command failed.",
    "Retry; if it persists, inspect daemon logs.",
    3,
  ],
] as const;

function lifecycleStatus(overrides: Record<string, unknown> = {}) {
  return {
    running: false,
    activeInvocations: 0,
    queuedInvocations: 0,
    invocations: [],
    queued: [],
    globalAuthority: "stopped",
    projection: "stopped",
    cleanupState: { status: "idle", entries: [] },
    heldCount: 0,
    heldTasks: [],
    taskControls: [],
    ...overrides,
  };
}

function controlSuccess(action: string, overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    data: {
      global_authority: action === "pause" ? "paused" : action === "stop" ? "stopped" : "running",
      projection: action === "pause" ? "paused" : action === "stop" ? "stopped" : "running",
      cleanup_state: { status: "idle", entries: [] },
      active_count: 0,
      queue_depth: 0,
      held_count: 0,
      held_tasks: [],
      task_controls: [],
      degraded_targets: [],
      outcome: "applied",
      ...overrides,
    },
    error: null,
  };
}

function runLifecycleCli(
  args: string,
  cwd: string,
  isolated: IsolatedKspecHome,
  options: KspecOptions = {},
) {
  return kspec(args, cwd, {
    ...options,
    env: {
      ...isolated.env,
      KSPEC_NO_DAEMON: "",
      ...options.env,
    },
    expectFail: true,
  });
}

async function runLifecycleHandler(args: string[], json = false) {
  const program = new Command();
  program.exitOverride();
  registerAgentCommands(program);
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...values) => stdout.push(values.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...values) => stderr.push(values.join(" ")));
  let exitCode = 0;
  const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCode = code ?? 0;
    return undefined as never;
  }) as never);
  try {
    await runWithOutputState(() => program.parseAsync(["agent", ...args], { from: "user" }), {
      outputFormat: json ? "json" : "text",
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "unreachable") throw error;
  } finally {
    exit.mockRestore();
  }
  return { exitCode, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

function recordLifecycleRequest(payload: unknown, status = 200) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return new Response(JSON.stringify(payload), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  return requests;
}

async function withTtyInput(answer: string, fn: () => Promise<void>) {
  const stdin = process.stdin as NodeJS.ReadStream & { isTTY?: boolean };
  const descriptor = Object.getOwnPropertyDescriptor(stdin, "isTTY");
  Object.defineProperty(stdin, "isTTY", { configurable: true, value: true });
  stdin.push(`${answer}\n`);
  try {
    await fn();
  } finally {
    if (descriptor) Object.defineProperty(stdin, "isTTY", descriptor);
    else delete stdin.isTTY;
  }
}

describe("safe lifecycle commands through the built CLI", () => {
  let tempDir: string;
  let isolated: IsolatedKspecHome;
  let mock: MockDaemonClient;

  function writeProject(manifest = yamlStringify({ kynetic: "1", title: "Lifecycle CLI" })) {
    writeFileSync(join(tempDir, "kynetic.yaml"), manifest);
    writeFileSync(
      join(tempDir, "kynetic.meta.yaml"),
      yamlStringify({ kynetic_meta: "1.0", agents: [] }),
    );
    writeFileSync(join(tempDir, "project.tasks.yaml"), yamlStringify([]));
  }

  beforeAll(async () => {
    tempDir = await createTempDir("kspec-secret-raw-context-should-never-render-");
    initGitRepo(tempDir);
    isolated = await createIsolatedKspecHome(tempDir);
    writeProject();
    const started = await startMockDaemon({
      asChildProcess: true,
      mode: "refuse",
      bindHost: "127.0.0.1",
    });
    if (!started) throw new Error("lifecycle mock daemon failed to start");
    mock = started;
    writeMockDaemonMetadata({ home: isolated, client: mock });
  });

  afterAll(async () => {
    await mock?.stop();
    await cleanupTempDir(tempDir);
  });

  it.each([
    ["start", "agent dispatch start --reason operator --json", "running"],
    ["pause", "agent dispatch pause --reason operator --json", "paused"],
    ["resume", "agent dispatch resume --reason operator --json", "running"],
    ["stop", "agent dispatch stop --reason operator --force --json", "stopped"],
  ])("parses and executes the real global %s grammar", (action, command, authority) => {
    const before = mock.requests().length;
    const result = runLifecycleCli(command, tempDir, isolated);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({
          global_authority: authority,
          projection: authority,
        }),
        error: null,
      }),
    );
    const requests = mock.requests().slice(before);
    const request = requests.find(
      (entry) => entry.method === "POST" && entry.url === "/api/agent/dispatch/control",
    );
    expect(request).toBeDefined();
    expect(JSON.parse(request!.body)).toEqual({
      scope: "global",
      action,
      reason: "operator",
    });
    expect(requests.some((entry) => entry.url === "/api/agent/status")).toBe(false);
  });

  it.each(["pause", "resume", "stop"])("parses and executes the real task %s grammar", (action) => {
    const before = mock.requests().length;
    const force = action === "stop" ? " --force" : "";
    const result = runLifecycleCli(
      `agent dispatch task ${action} @task-alias --reason operator${force} --json`,
      tempDir,
      isolated,
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({ task_id: TASK_ID, task_ref: "@task-alias" }),
        error: null,
      }),
    );
    const requests = mock.requests().slice(before);
    const request = requests.find(
      (entry) => entry.method === "POST" && entry.url === "/api/agent/dispatch/control",
    );
    expect(request).toBeDefined();
    expect(JSON.parse(request!.body)).toEqual({
      scope: "task",
      action,
      task_ref: "@task-alias",
      reason: "operator",
    });
  });

  it.each(["agent status --json", "agent dispatch status --json"])(
    "parses the real status grammar for %s",
    (command) => {
      const before = mock.requests().length;
      const result = runLifecycleCli(command, tempDir, isolated);

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(
        expect.objectContaining({
          globalAuthority: "stopped",
          projection: "stopped",
          cleanupState: { status: "idle", entries: [] },
          activeCount: 0,
          queuedInvocations: 0,
          heldCount: 0,
          heldTasks: [],
          taskControls: [],
        }),
      );
      const requests = mock.requests().slice(before);
      expect(
        requests.some(
          (entry) => entry.method === "GET" && entry.url === "/api/agent/dispatch/status",
        ),
      ).toBe(true);
      expect(requests.some((entry) => entry.url === "/api/agent/status")).toBe(false);
    },
  );

  it.each(
    ["agent status --json", "agent dispatch status --json"].flatMap((command) => [
      [command, "top-level", lifecycleStatus({ cwd: "/secret/raw" }), "/secret/raw"],
      [
        command,
        "nested",
        lifecycleStatus({
          activeInvocations: 1,
          queuedInvocations: 1,
          invocations: [
            {
              invocationId: "invocation",
              sessionId: "session",
              agentId: "worker",
              agentName: "Worker",
              elapsedMs: 1,
              resolvedAdapter: "codex-acp",
              error: "raw daemon detail",
            },
          ],
          queued: [
            {
              agentId: "reviewer",
              agentName: "Reviewer",
              waitMs: 1,
              error: "raw queued detail",
            },
          ],
        }),
        "raw daemon detail",
      ],
    ]) as Array<[string, string, Record<string, unknown>, string]>,
  )(
    "fails closed when %s receives an unknown %s status field",
    async (command, _location, maliciousStatus, rawValue) => {
      const malicious = await startMockDaemon({
        asChildProcess: true,
        mode: "refuse",
        bindHost: "127.0.0.1",
        agentDispatchStatus: maliciousStatus,
      });
      if (!malicious) throw new Error("malicious lifecycle mock daemon failed to start");
      writeMockDaemonMetadata({ home: isolated, client: malicious });
      try {
        const result = runLifecycleCli(command, tempDir, isolated);

        expect(result.exitCode).toBe(3);
        expect(JSON.parse(result.stderr)).toEqual({
          ok: false,
          data: null,
          error: {
            code: "internal_error",
            message: "Dispatch lifecycle command failed.",
            suggestion: "Retry; if it persists, inspect daemon logs.",
          },
        });
        expect(`${result.stdout}\n${result.stderr}`).not.toContain(rawValue);
      } finally {
        await malicious.stop();
        writeMockDaemonMetadata({ home: isolated, client: mock });
      }
    },
  );

  it.each([
    ["human mutation", "agent dispatch pause"],
    ["JSON mutation", "agent dispatch pause --json"],
    ["human status", "agent status"],
    ["JSON status", "agent dispatch status --json"],
  ])("maps project-context failure for %s without exposing raw details", (_label, command) => {
    const distinctive = "format_version_newer_than_supported";
    writeProject(yamlStringify({ kynetic: "999.0", title: "Unsupported" }));
    try {
      const before = mock.requests().length;
      const result = runLifecycleCli(command, tempDir, isolated);

      expect(result.exitCode).toBe(3);
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(distinctive);
      if (command.endsWith("--json")) {
        expect(JSON.parse(result.stderr)).toEqual({
          ok: false,
          data: null,
          error: {
            code: "internal_error",
            message: "Dispatch lifecycle command failed.",
            suggestion: "Retry; if it persists, inspect daemon logs.",
          },
        });
      } else {
        expect(result.stderr).toBe(
          "Error: Dispatch lifecycle command failed.\n" +
            "Suggestion: Retry; if it persists, inspect daemon logs.",
        );
      }
      expect(mock.requests().slice(before)).toHaveLength(0);
    } finally {
      writeProject();
    }
  });
});

describe("safe agent dispatch lifecycle CLI", () => {
  beforeEach(() => {
    vi.mocked(getRunningDaemonClient).mockReturnValue({
      apiUrl: "http://127.0.0.1:4567",
      wsUrl: "ws://127.0.0.1:4567/ws",
    });
    vi.spyOn(parser, "initContext").mockResolvedValue({
      rootDir: "/tmp/project",
      projectRoot: "/tmp/project",
    } as Awaited<ReturnType<typeof parser.initContext>>);
    delete process.env.KSPEC_SESSION_ID;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.KSPEC_SESSION_ID;
  });

  it("keeps the lifecycle failure surface closed to exactly seventeen codes", () => {
    expect(CLOSED_ERRORS).toHaveLength(17);
    expect(new Set(CLOSED_ERRORS.map(([code]) => code))).toHaveLength(17);
  });

  // AC: @cli-agent-commands ac-start-reports-authority
  // AC: @cli-agent-commands ac-pause-reports-authority
  // AC: @cli-agent-commands ac-resume-reports-authority
  // AC: @cli-agent-commands ac-lifecycle-command-reports-projection
  // AC: @trait-semantic-exit-codes ac-1
  it.each([
    ["start", "running"],
    ["pause", "paused"],
    ["resume", "running"],
  ])("POSTs canonical global %s and renders authority/projection", async (action, authority) => {
    const requests = recordLifecycleRequest(controlSuccess(action));
    const result = await runLifecycleHandler(["dispatch", action]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`Dispatch ${action}: ${authority} (${authority})`);
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]!.url).pathname).toBe("/api/agent/dispatch/control");
    expect(JSON.parse(String(requests[0]!.init?.body))).toEqual({ scope: "global", action });
  });

  // AC: @cli-agent-commands ac-task-control-canonicalization
  it("POSTs canonical task grammar and reports canonical response identity", async () => {
    const requests = recordLifecycleRequest(
      controlSuccess("pause", {
        global_authority: "running",
        projection: "running",
        task_id: TASK_ID,
        task_ref: "@task-alias",
      }),
    );
    const result = await runLifecycleHandler([
      "dispatch",
      "task",
      "pause",
      "@task-alias",
      "--reason",
      "hold",
    ]);

    expect(result.stdout).toBe(`Dispatch pause: running (running) for ${TASK_ID}`);
    expect(JSON.parse(String(requests[0]!.init?.body))).toEqual({
      scope: "task",
      action: "pause",
      task_ref: "@task-alias",
      reason: "hold",
    });
  });

  // AC: @cli-agent-commands ac-lifecycle-status-authority
  // AC: @cli-agent-commands ac-lifecycle-status-projection
  // AC: @cli-agent-commands ac-lifecycle-status-active-count
  // AC: @cli-agent-commands ac-lifecycle-status-queued-count
  // AC: @cli-agent-commands ac-lifecycle-status-held-count
  it.each([["status"], ["dispatch", "status"]])(
    "GETs internal lifecycle status and preserves complete rows for %s",
    async (...args) => {
      const taskRow = {
        task_id: TASK_ID,
        task_ref: "@task-alias",
        title: "Task",
        scope: "task",
        mode: "paused",
        reason: "hold",
        actor: "operator",
        source: "cli",
        controlled_at: NOW,
        updated_at: NOW,
      };
      const cleanup = {
        cleanup_id: CLEANUP_ID,
        scope: "task",
        task_id: TASK_ID,
        status: "pending",
        phase: "owned",
      };
      const status = lifecycleStatus({
        globalAuthority: "paused",
        projection: "draining",
        activeInvocations: 1,
        queuedInvocations: 2,
        cleanupState: { status: "pending", entries: [cleanup] },
        heldCount: 1,
        heldTasks: [taskRow],
        taskControls: [
          {
            ...taskRow,
            scope: undefined,
            cleanup_state: { status: "pending", entries: [cleanup] },
          },
        ].map(({ scope: _scope, ...row }) => row),
      });
      const requests = recordLifecycleRequest(status);
      const result = await runLifecycleHandler(args, true);

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(expect.objectContaining(status));
      expect(new URL(requests[0]!.url).pathname).toBe("/api/agent/dispatch/status");
      expect(requests[0]!.init?.method ?? "GET").toBe("GET");
    },
  );

  // AC: @trait-error-guidance ac-1
  // AC: @trait-error-guidance ac-2
  // AC: @trait-error-guidance ac-6
  // AC: @trait-semantic-exit-codes ac-4
  it.each(CLOSED_ERRORS)(
    "maps %s to closed CLI copy and exit",
    async (code, message, suggestion, exitCode) => {
      const requests = recordLifecycleRequest(
        {
          ok: false,
          data: null,
          error: { code, message: "/secret/raw", suggestion: "/cwd/raw" },
        },
        500,
      );
      const result = await runLifecycleHandler(["dispatch", "pause"], true);

      expect(result.exitCode).toBe(exitCode);
      expect(JSON.parse(result.stderr)).toEqual({
        ok: false,
        data: null,
        error: {
          code,
          message,
          suggestion,
        },
      });
      expect(result.stderr).not.toContain("/secret/raw");
      expect(requests).toHaveLength(1);
    },
  );

  // AC: @cli-agent-commands ac-declined-stop-sends-no-request
  // AC: @cli-agent-commands ac-declined-stop-exit
  // AC: @trait-semantic-exit-codes ac-3
  it("declining an interactive hard stop exits 2 without a request", async () => {
    const requests = recordLifecycleRequest(controlSuccess("stop"));
    let result!: Awaited<ReturnType<typeof runLifecycleHandler>>;
    await withTtyInput("n", async () => {
      result = await runLifecycleHandler(["dispatch", "stop"]);
    });
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("Hard stop cancelled.");
    expect(requests).toHaveLength(0);
  });

  it("rejects dispatch-owned hard stop before prompting or requesting", async () => {
    process.env.KSPEC_SESSION_ID = "01KXH2PT5BATGSN8TNY7W7NE57";
    const requests = recordLifecycleRequest(controlSuccess("stop"));
    const result = await runLifecycleHandler([
      "dispatch",
      "task",
      "stop",
      `@${TASK_ID}`,
      "--force",
    ]);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("A dispatch-owned session cannot hard-stop its host.");
    expect(requests).toHaveLength(0);
  });

  it.each([
    [["dispatch", "stop"], false],
    [["dispatch", "stop"], true],
  ] as const)("requires --force for non-interactive or JSON hard stop", async (args, json) => {
    const requests = recordLifecycleRequest(controlSuccess("stop"));
    const result = await runLifecycleHandler([...args], json);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Hard stop requires --force when stdin is not a TTY.");
    expect(requests).toHaveLength(0);
  });

  it.each([
    lifecycleStatus({ heldCount: 1, heldTasks: [] }),
    lifecycleStatus({ global_authority: "stopped" }),
    lifecycleStatus({
      cleanupState: {
        status: "pending",
        entries: [
          {
            cleanup_id: CLEANUP_ID,
            scope: "task",
            task_id: TASK_ID,
            status: "pending",
            phase: "owned",
          },
          {
            cleanup_id: "01KXH2PT5BATGSN8TNY7W7NE58",
            scope: "task",
            task_id: TASK_ID,
            status: "pending",
            phase: "owned",
          },
        ],
      },
    }),
  ])("fails closed on malformed status rows rather than rendering them", async (malformed) => {
    recordLifecycleRequest(malformed);
    const result = await runLifecycleHandler(["dispatch", "status"], true);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).not.toContain(JSON.stringify(malformed));
  });
});
