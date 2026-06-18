/**
 * Behavioral redaction tests for the runner contract redactor at every
 * diagnostic surface that observes invocation failures.
 *
 * The previous implementation built a `contract.redact` closure and stopped
 * there; no production caller actually invoked it. These tests run a real
 * runner-backed invocation whose contract resolves a host-supplied secret,
 * coerce the adapter into emitting that secret value via stderr and via a
 * JSON-RPC error reply, and then assert the resolved secret literal does
 * not appear in:
 *
 *   1. process.stderr writes from the adapter stderr forwarder
 *   2. process.stderr writes from the ACP framing error log
 *   3. the `agent.failed` session event in events.jsonl
 *   4. the persisted session metadata's `close_reason`
 *   5. the direct task-note body
 *   6. the returned InvocationResult.error value
 *
 * Each surface is checked for both absence of the secret literal and presence
 * of the `[REDACTED]` marker so a regression that silently drops the
 * redactor (no-op) cannot pass.
 *
 * AC: @runner-environment-secret-boundaries ac-diagnostics-redact-secrets
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as path from "node:path";

import { runInvocation } from "../src/agent-runtime/invocation.js";
import { registerAdapter } from "../src/agents/adapters.js";
import { REDACTION_MARKER } from "../src/agents/redaction.js";
import { mergeRunnerConfigs } from "../src/agents/runner-config.js";
import type { EffectiveRunnerRegistry } from "../src/agents/runner-config.js";
import type { Agent } from "../src/schema/meta.js";
import { testUlid, createTempDir, cleanupTempDir, readTestOutput } from "./helpers/cli.js";
import * as YAML from "yaml";

const MOCK_ACP = path.join(__dirname, "mocks", "acp-mock.js");

const SECRET_LITERAL = "supersecret-token-XYZ-987654321";
const SECRET_VAR_NAME = "REDACTION_TEST_SECRET_KEY";

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    _ulid: testUlid("AGNT"),
    id: "secret-redaction-worker",
    name: "Secret Redaction Worker",
    capabilities: [],
    tools: [],
    conventions: [],
    dispatch: [],
    skills: [],
    auto_approve: false,
    concurrency: { max_concurrent: 1 },
    runner: "secret-runner",
    ...overrides,
  };
}

/**
 * Build a runner registry where the named runner:
 *   - resolves `SECRET_VAR_NAME` from `user_env` as a required secret binding
 *     (so the contract captures the resolved value for redaction);
 *   - sets the MOCK_ACP_* control vars so the mock fails with a JSON-RPC
 *     error containing the secret value AND emits the secret value to stderr;
 *   - sets `env.inherit: ambient` so the mock process inherits PATH etc.
 *
 * The MOCK_ACP_* env.set values are non-secret literal strings — they are
 * deliberately short of any secret literal so we can prove the secret only
 * arrives in the child via the env.secrets binding, not via env.set.
 */
function buildRegistry(extraEnvSet: Record<string, string> = {}): EffectiveRunnerRegistry {
  return mergeRunnerConfigs(null, {
    runners: {
      "secret-runner": {
        kind: "acp_process",
        adapter: "mock-secret-acp",
        env: {
          inherit: "ambient",
          set: {
            MOCK_ACP_FAIL_TEMPLATE: "adapter rejected: token {VAR} not valid",
            MOCK_ACP_FAIL_VAR: SECRET_VAR_NAME,
            MOCK_ACP_EXIT_CODE: "1",
            ...extraEnvSet,
          },
          secrets: {
            [SECRET_VAR_NAME]: { source: "user_env", required: true },
          },
        },
      },
    },
  });
}

function registerMockSecretAdapter(): void {
  registerAdapter("mock-secret-acp", {
    command: "node",
    args: [MOCK_ACP],
    env: {
      MOCK_ACP_PROJECT_DIR: process.cwd(),
    },
    description: "Mock ACP adapter for secret redaction tests",
  });
}

interface SessionEvent {
  type: string;
  data: Record<string, unknown>;
}

async function readEventsJsonl(sessionsDir: string, sessionId: string): Promise<SessionEvent[]> {
  const eventsPath = path.join(sessionsDir, sessionId, "events.jsonl");
  const raw = await readTestOutput(eventsPath);
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((line) => JSON.parse(line) as SessionEvent);
}

async function readSessionMetadata(
  sessionsDir: string,
  sessionId: string,
): Promise<Record<string, unknown>> {
  const sessionYamlPath = path.join(sessionsDir, sessionId, "session.yaml");
  const content = await readTestOutput(sessionYamlPath);
  return YAML.parse(content) as Record<string, unknown>;
}

// ─── ac-diagnostics-redact-secrets ───────────────────────────────────────────

describe(
  "runInvocation: secret redaction at diagnostic surfaces (failure path)",
  { timeout: 120_000 },
  () => {
    let testDir: string;
    let sessionsDir: string;
    let stderrSpy: ReturnType<typeof vi.spyOn>;
    let stderrChunks: string[];
    let originalHostSecret: string | undefined;

    beforeEach(async () => {
      testDir = await createTempDir("kspec-secret-redact-");
      sessionsDir = path.join(testDir, "sessions");

      // Plant the secret in the parent host env so env.secrets:user_env can
      // resolve it. The runner contract picks it up for the child + redactor.
      originalHostSecret = process.env[SECRET_VAR_NAME];
      process.env[SECRET_VAR_NAME] = SECRET_LITERAL;

      registerMockSecretAdapter();

      stderrChunks = [];
      stderrSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation((chunk: unknown): boolean => {
          stderrChunks.push(
            typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString(),
          );
          return true;
        });
    });

    afterEach(async () => {
      stderrSpy.mockRestore();
      if (originalHostSecret === undefined) {
        delete process.env[SECRET_VAR_NAME];
      } else {
        process.env[SECRET_VAR_NAME] = originalHostSecret;
      }
      await cleanupTempDir(testDir);
    });

    it(
      "redacts the resolved secret from every diagnostic surface when the adapter " +
        "fails with the secret in stderr and in the JSON-RPC error message",
      async () => {
        const agent = makeAgent();
        const taskRef = `@${testUlid("TASK")}`;
        const notes: Array<{ taskRef: string; note: string }> = [];

        const result = await runInvocation({
          agent,
          specDir: testDir,
          sessionsDir,
          cwd: process.cwd(),
          taskRef,
          prompt: "Drive the adapter into a secret-laden failure",
          trigger: "task.ready",
          runnerRegistry: buildRegistry({
            // Push the resolved secret literal back out via stderr too —
            // mock writes this exact string with a newline.
            MOCK_ACP_EMIT_ACTIONABLE_STDERR: `adapter trace [secret=${SECRET_LITERAL}]`,
          }),
          taskBookkeeping: {
            addTaskNote: async (ref, note) => {
              notes.push({ taskRef: ref, note });
            },
            blockTask: async () => undefined,
          },
        });

        // ─── 1. InvocationResult.error must not contain the secret literal ─
        expect(result.outcome).toBe("failed");
        expect(result.error).toBeDefined();
        expect(result.error!).not.toContain(SECRET_LITERAL);
        expect(result.error!).toContain(REDACTION_MARKER);

        // ─── 2. agent.failed session event must redact error + reason ─────
        const events = await readEventsJsonl(sessionsDir, result.session.id);
        const failedEvent = events.find((e) => e.type === "agent.failed");
        expect(failedEvent).toBeDefined();
        const failedData = failedEvent!.data;
        const failedJson = JSON.stringify(failedData);
        expect(failedJson).not.toContain(SECRET_LITERAL);
        expect(failedData.error).toBe(failedData.reason);
        expect(String(failedData.error)).toContain(REDACTION_MARKER);

        // No other events should carry the literal either.
        const allEventsJson = JSON.stringify(events);
        expect(allEventsJson).not.toContain(SECRET_LITERAL);

        // ─── 3. Persisted session metadata close_reason must be redacted ──
        const metadata = await readSessionMetadata(sessionsDir, result.session.id);
        expect(metadata.status).toBe("failed");
        const closeReason = String(metadata.close_reason ?? "");
        expect(closeReason).not.toContain(SECRET_LITERAL);
        expect(closeReason).toContain(REDACTION_MARKER);
        // Whole metadata payload must be free of the secret literal so any
        // future field that derives from the failure path is covered too.
        expect(JSON.stringify(metadata)).not.toContain(SECRET_LITERAL);

        // ─── 4. Direct task-note body must not contain the secret ─────────
        expect(notes).toHaveLength(1);
        expect(notes[0]?.taskRef).toBe(taskRef);
        expect(notes[0]?.note).not.toContain(SECRET_LITERAL);
        expect(notes[0]?.note).toContain(REDACTION_MARKER);

        // ─── 5. process.stderr writes from adapter stderr + ACP framing ───
        // The mock writes `adapter trace [secret=<literal>]` via console.error
        // and the JSON-RPC error reply contains the literal as well — both
        // surface through process.stderr.write. We assert on the captured
        // chunks across the whole invocation rather than per-line so a
        // partial newline split cannot let the literal slip through.
        const combinedStderr = stderrChunks.join("");
        expect(combinedStderr).not.toContain(SECRET_LITERAL);
        expect(combinedStderr).toContain(REDACTION_MARKER);
      },
    );
  },
);

// ─── Direct bookkeeping boundary ─────────────────────────────────────────────
//
// The adapter spawn intentionally receives resolved `env.secrets` so the
// adapter process can use the credential. Failure bookkeeping runs in-process
// through a direct collaborator and must only receive the redacted task note
// body, not a runner environment payload.

describe("runInvocation: direct bookkeeping boundary (failure path)", { timeout: 120_000 }, () => {
  let testDir: string;
  let sessionsDir: string;
  let originalHostSecret: string | undefined;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-direct-bookkeeping-boundary-");
    sessionsDir = path.join(testDir, "sessions");

    originalHostSecret = process.env[SECRET_VAR_NAME];
    process.env[SECRET_VAR_NAME] = SECRET_LITERAL;

    registerMockSecretAdapter();
  });

  afterEach(async () => {
    if (originalHostSecret === undefined) {
      delete process.env[SECRET_VAR_NAME];
    } else {
      process.env[SECRET_VAR_NAME] = originalHostSecret;
    }
    await cleanupTempDir(testDir);
  });

  // AC: @runner-environment-secret-boundaries ac-secret-values-not-stored-inline
  // AC: @runner-environment-secret-boundaries ac-diagnostics-redact-secrets
  it("does not expose the runner-resolved env.secrets value to direct task bookkeeping", async () => {
    const agent = makeAgent();
    const taskRef = `@${testUlid("TASK")}`;
    const notes: Array<{ taskRef: string; note: string }> = [];

    const result = await runInvocation({
      agent,
      specDir: testDir,
      sessionsDir,
      cwd: process.cwd(),
      taskRef,
      prompt: "Drive the adapter into a secret-laden failure",
      trigger: "task.ready",
      runnerRegistry: buildRegistry(),
      taskBookkeeping: {
        addTaskNote: async (ref, note) => {
          notes.push({ taskRef: ref, note });
        },
        blockTask: async () => undefined,
      },
    });

    expect(result.outcome).toBe("failed");
    expect(notes).toHaveLength(1);
    expect(notes[0]?.taskRef).toBe(taskRef);
    expect(notes[0]?.note).not.toContain(SECRET_LITERAL);
    expect(notes[0]?.note).toContain(REDACTION_MARKER);
  });
});

// ─── Negative control: implicit/legacy path no-op redactor ───────────────────

describe(
  "runInvocation: implicit/legacy path passes diagnostics through unchanged",
  { timeout: 60_000 },
  () => {
    let testDir: string;
    let sessionsDir: string;
    let stderrSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
      testDir = await createTempDir("kspec-secret-redact-implicit-");
      sessionsDir = path.join(testDir, "sessions");
      registerMockSecretAdapter();
      stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((): boolean => true);
    });

    afterEach(async () => {
      stderrSpy.mockRestore();
      await cleanupTempDir(testDir);
    });

    it(
      "leaves diagnostic text unchanged on the implicit path (no env.secrets " +
        "resolved → no-op redactor)",
      async () => {
        const agent = makeAgent({
          // No runner — implicit/legacy path.
          runner: undefined,
          adapter: "mock-secret-acp",
        });

        const result = await runInvocation({
          agent,
          specDir: testDir,
          sessionsDir,
          cwd: process.cwd(),
          prompt: "Implicit-path failure",
          trigger: "manual",
          runnerRegistry: { runners: {} },
          env: {
            // Force a failure with a known, distinctive literal in the
            // adapter's error message. No secrets resolved → contract.redact
            // is a no-op, so the literal must appear verbatim in result.error.
            MOCK_ACP_FAIL_TEMPLATE: "implicit-path failure unique-marker-ABC",
            MOCK_ACP_EXIT_CODE: "1",
          },
        });

        expect(result.outcome).toBe("failed");
        expect(result.error).toContain("unique-marker-ABC");
        // And specifically must NOT contain the redaction marker — proof the
        // no-op path is preserved when there are no secrets to capture.
        expect(result.error).not.toContain(REDACTION_MARKER);
      },
    );
  },
);
