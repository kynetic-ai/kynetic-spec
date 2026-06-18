import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { runInvocation } from "../src/agent-runtime/invocation.js";
import { registerAdapter } from "../src/agents/adapters.js";
import type { Agent } from "../src/schema/meta.js";
import { cleanupTempDir, createTempDir, readTestOutputSync, testUlid } from "./helpers/cli.js";

const MOCK_ACP = path.join(__dirname, "mocks", "acp-mock.js");
const MOCK_KSPEC_CLI = path.join(__dirname, "mocks", "kspec-capture-mock.cjs");

function makeTestAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    _ulid: testUlid("AGNT"),
    id: "test-worker",
    name: "Test Worker Agent",
    capabilities: [],
    tools: [],
    conventions: [],
    dispatch: [],
    skills: [],
    auto_approve: false,
    concurrency: { max_concurrent: 1 },
    adapter: "daemon-isolation-mock-acp",
    ...overrides,
  };
}

describe("agent invocation daemon isolation", () => {
  const tempDirs: string[] = [];
  let originalNoDaemon: string | undefined;
  let originalCaptureFile: string | undefined;
  let originalCaptureEnvVars: string | undefined;

  beforeEach(() => {
    originalNoDaemon = process.env.KSPEC_NO_DAEMON;
    originalCaptureFile = process.env.KSPEC_CAPTURE_FILE;
    originalCaptureEnvVars = process.env.KSPEC_CAPTURE_ENV_VARS;
    process.env.KSPEC_NO_DAEMON = "0";
    delete process.env.KSPEC_CAPTURE_FILE;
    delete process.env.KSPEC_CAPTURE_ENV_VARS;
  });

  afterEach(async () => {
    if (originalNoDaemon === undefined) {
      delete process.env.KSPEC_NO_DAEMON;
    } else {
      process.env.KSPEC_NO_DAEMON = originalNoDaemon;
    }
    if (originalCaptureFile === undefined) {
      delete process.env.KSPEC_CAPTURE_FILE;
    } else {
      process.env.KSPEC_CAPTURE_FILE = originalCaptureFile;
    }
    if (originalCaptureEnvVars === undefined) {
      delete process.env.KSPEC_CAPTURE_ENV_VARS;
    } else {
      process.env.KSPEC_CAPTURE_ENV_VARS = originalCaptureEnvVars;
    }
    for (const dir of tempDirs.splice(0)) {
      await cleanupTempDir(dir);
    }
  });

  async function tempDir(prefix: string): Promise<string> {
    const dir = await createTempDir(prefix);
    tempDirs.push(dir);
    return dir;
  }

  // AC: @agent-invocation-lifecycle ac-invocation-commands-do-not-proxy-to-supervising-daemon
  it("spawns dispatched agents with daemon proxying disabled", async () => {
    const testDir = await tempDir("kspec-invocation-daemon-env-");
    const verifyEnvFile = path.join(testDir, "agent-env.json");
    const mutationLockFile = path.join(testDir, "dispatch-shadow-mutation");

    registerAdapter("daemon-isolation-mock-acp", {
      command: "node",
      args: [MOCK_ACP],
      env: {
        MOCK_ACP_VERIFY_ENV_FILE: verifyEnvFile,
        MOCK_ACP_VERIFY_ENV_VARS:
          "KSPEC_NO_DAEMON,KSPEC_SHADOW_MUTATION_LOCK_FILE,CUSTOM_AGENT_ENV",
      },
      description: "Mock ACP that captures environment for daemon isolation tests",
    });

    const result = await runInvocation({
      agent: makeTestAgent(),
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: testDir,
      prompt: "Verify daemon isolation env",
      trigger: "task.ready",
      kspecCliPath: MOCK_KSPEC_CLI,
      mutationLockFile,
      env: { CUSTOM_AGENT_ENV: "preserved" },
    });

    expect(result.outcome).toBe("success");
    const capturedEnv = JSON.parse(readTestOutputSync(verifyEnvFile));
    expect(capturedEnv).toMatchObject({
      KSPEC_NO_DAEMON: "1",
      KSPEC_SHADOW_MUTATION_LOCK_FILE: mutationLockFile,
      CUSTOM_AGENT_ENV: "preserved",
    });
  });

  // AC: @agent-invocation-lifecycle ac-invocation-lifecycle-helper-commands-do-not-proxy
  it("writes invocation failure notes without spawning a daemon-proxied helper", async () => {
    const testDir = await tempDir("kspec-invocation-note-env-");
    const captureFile = path.join(testDir, "kspec-calls.json");
    const mutationLockFile = path.join(testDir, "dispatch-shadow-mutation");
    const notes: Array<{ taskRef: string; note: string }> = [];

    registerAdapter("daemon-isolation-fail-mock-acp", {
      command: "node",
      args: [MOCK_ACP],
      env: {
        MOCK_ACP_EXIT_CODE: "1",
      },
      description: "Mock ACP that fails so invocation writes task notes",
    });

    process.env.KSPEC_CAPTURE_FILE = captureFile;
    process.env.KSPEC_CAPTURE_ENV_VARS = "KSPEC_NO_DAEMON,KSPEC_SHADOW_MUTATION_LOCK_FILE";

    const result = await runInvocation({
      agent: makeTestAgent({ adapter: "daemon-isolation-fail-mock-acp" }),
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: testDir,
      taskRef: `@${testUlid("TASK")}`,
      prompt: "Force failure note",
      trigger: "task.ready",
      mutationLockFile,
      env: { KSPEC_CAPTURE_FILE: captureFile },
      taskBookkeeping: {
        addTaskNote: async (taskRef, note) => {
          notes.push({ taskRef, note });
        },
        blockTask: async () => undefined,
      },
    });

    expect(result.outcome).toBe("failed");
    expect(notes).toHaveLength(1);
    expect(notes[0]?.note).toContain("[AGENT-FAIL]");
    expect(fsSync.existsSync(captureFile)).toBe(false);
  });
});
