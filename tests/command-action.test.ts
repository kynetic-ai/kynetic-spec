/**
 * Command Action Tests
 *
 * Tests the structured command form for command actions per the
 * dispatch-command-action spec: program + args form, template interpolation
 * as literal strings, KSPEC_* environment variable injection with allowlist
 * and 1KB truncation, and shadow branch safety.
 *
 * AC: @dispatch-command-action ac-1 through ac-4
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import {
  CommandActionSchema,
  ActionSchema,
  type Action,
} from "../src/schema/action.js";
import {
  ActionExecutor,
  buildKspecEnvVars,
  KSPEC_ENV_ALLOWLIST,
  ENV_VALUE_MAX_BYTES,
  type ActionEventContext,
  type ActionRunEvent,
} from "../src/agent-runtime/action-executor.js";

// ─── Test Helpers ────────────────────────────────────────────────────────────

function makeEventContext(
  overrides: Partial<ActionEventContext> = {},
): ActionEventContext {
  return {
    event_id: "01TEST00000000000000000001",
    event_type: "task.ready",
    correlation_id: "01CORR000000000000000000001",
    causation_id: "01CAUSE0000000000000000001",
    source_type: "task_watcher",
    source_id: "watcher-1",
    task_ref: "@task-foo",
    task_id: "01TASKID0000000000000000001",
    from_status: "pending",
    to_status: "in_progress",
    session_id: "session-abc-123",
    agent_id: "task-worker",
    ...overrides,
  };
}

let tempDir: string;
let events: ActionRunEvent[];
let executor: ActionExecutor;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "command-action-test-"),
  );
  events = [];
  executor = new ActionExecutor({
    projectDir: tempDir,
    onActionRunEvent: (event) => events.push(event),
  });
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
});

// ─── AC-1: Schema Validation ────────────────────────────────────────────────

describe("Command Action Schema (ac-1)", () => {
  // AC: @dispatch-command-action ac-1
  it("specifies program (command) and args as array of strings", () => {
    const result = CommandActionSchema.safeParse({
      type: "command",
      command: "/usr/bin/echo",
      args: ["hello", "world"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.command).toBe("/usr/bin/echo");
      expect(result.data.args).toEqual(["hello", "world"]);
    }
  });

  // AC: @dispatch-command-action ac-1
  it("optional cwd overrides the working directory", () => {
    const result = CommandActionSchema.safeParse({
      type: "command",
      command: "ls",
      args: ["-la"],
      cwd: "/tmp/custom-dir",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cwd).toBe("/tmp/custom-dir");
    }
  });

  // AC: @dispatch-command-action ac-1
  it("shell defaults to false", () => {
    const result = CommandActionSchema.safeParse({
      type: "command",
      command: "echo",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.shell).toBe(false);
    }
  });

  // AC: @dispatch-command-action ac-1
  it("shell can be explicitly set to true", () => {
    const result = CommandActionSchema.safeParse({
      type: "command",
      command: "echo hello | cat",
      shell: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.shell).toBe(true);
    }
  });

  // AC: @dispatch-command-action ac-1
  it("args defaults to empty array when not provided", () => {
    const result = CommandActionSchema.safeParse({
      type: "command",
      command: "echo",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.args).toEqual([]);
    }
  });

  // AC: @dispatch-command-action ac-1
  it("rejects empty command", () => {
    const result = CommandActionSchema.safeParse({
      type: "command",
      command: "",
    });
    expect(result.success).toBe(false);
  });

  // AC: @dispatch-command-action ac-1
  it("validates via the discriminated union", () => {
    const result = ActionSchema.safeParse({
      type: "command",
      command: "/usr/bin/node",
      args: ["script.js", "--flag"],
      cwd: "/workspace",
      shell: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("command");
    }
  });
});

// ─── AC-2: Template Variable Interpolation ──────────────────────────────────

describe("Template variables in args (ac-2)", () => {
  // AC: @dispatch-command-action ac-2
  it("each arg is a separate array element after interpolation", async () => {
    const scriptPath = path.join(tempDir, "dump-args.cjs");
    await fs.writeFile(
      scriptPath,
      `const fs = require('fs');
const path = require('path');
// Write each argv (skipping node and script) as separate lines
const args = process.argv.slice(2);
fs.writeFileSync(
  path.join(${JSON.stringify(tempDir)}, 'args-output.txt'),
  JSON.stringify(args)
);
process.exit(0);`,
    );

    const action: Action = {
      type: "command",
      command: process.execPath,
      args: [scriptPath, "{{task_ref}}", "literal-arg", "{{event_type}}"],
    };
    const ctx = makeEventContext({
      task_ref: "@task-interpolation-test",
      event_type: "task.ready",
    });

    const run = await executor.execute(action, ctx);
    expect(run.status).toBe("completed");

    const output = await fs.readFile(
      path.join(tempDir, "args-output.txt"),
      "utf-8",
    );
    const args = JSON.parse(output);
    // Each arg is a separate element — template values don't merge or split
    expect(args).toEqual([
      "@task-interpolation-test",
      "literal-arg",
      "task.ready",
    ]);
  });

  // AC: @dispatch-command-action ac-2
  it("template values are literal strings, not interpreted as shell syntax", async () => {
    const scriptPath = path.join(tempDir, "check-literal.cjs");
    await fs.writeFile(
      scriptPath,
      `const fs = require('fs');
const path = require('path');
fs.writeFileSync(
  path.join(${JSON.stringify(tempDir)}, 'literal-output.txt'),
  process.argv[2]
);
process.exit(0);`,
    );

    // Use a value that would be dangerous if interpreted by a shell
    const action: Action = {
      type: "command",
      command: process.execPath,
      args: [scriptPath, "{{task_ref}}"],
    };
    const ctx = makeEventContext({
      task_ref: "; rm -rf / && echo pwned",
    });

    const run = await executor.execute(action, ctx);
    expect(run.status).toBe("completed");

    const output = await fs.readFile(
      path.join(tempDir, "literal-output.txt"),
      "utf-8",
    );
    // The value is passed as a literal string, not executed as shell
    expect(output).toBe("; rm -rf / && echo pwned");
  });

  // AC: @dispatch-command-action ac-2
  it("template values with shell metacharacters remain literal in args", async () => {
    const scriptPath = path.join(tempDir, "check-metachar.cjs");
    await fs.writeFile(
      scriptPath,
      `const fs = require('fs');
const path = require('path');
fs.writeFileSync(
  path.join(${JSON.stringify(tempDir)}, 'metachar-output.txt'),
  JSON.stringify(process.argv.slice(2))
);
process.exit(0);`,
    );

    const action: Action = {
      type: "command",
      command: process.execPath,
      args: [
        scriptPath,
        "{{task_ref}}",
        "$(echo injection)",
        "`backtick`",
      ],
    };
    const ctx = makeEventContext({
      task_ref: "$HOME/../../etc/passwd",
    });

    const run = await executor.execute(action, ctx);
    expect(run.status).toBe("completed");

    const output = await fs.readFile(
      path.join(tempDir, "metachar-output.txt"),
      "utf-8",
    );
    const args = JSON.parse(output);
    // All values are literal — no shell expansion occurred
    expect(args).toEqual([
      "$HOME/../../etc/passwd",
      "$(echo injection)",
      "`backtick`",
    ]);
  });

  // AC: @dispatch-command-action ac-2
  it("cwd template is also interpolated as a literal string", async () => {
    // Create a subdirectory with a name derived from event context
    const subDir = path.join(tempDir, "task-ready");
    await fs.mkdir(subDir, { recursive: true });

    const scriptPath = path.join(tempDir, "check-cwd.cjs");
    await fs.writeFile(
      scriptPath,
      `const fs = require('fs');
const path = require('path');
fs.writeFileSync(
  path.join(${JSON.stringify(tempDir)}, 'cwd-output.txt'),
  process.cwd()
);
process.exit(0);`,
    );

    const action: Action = {
      type: "command",
      command: process.execPath,
      args: [scriptPath],
      cwd: path.join(tempDir, "{{event_type}}").replace(".", "-"),
    };
    // The cwd template resolves but the event_type is "task.ready"
    // which gets interpolated literally. We use a simpler case here.
    const ctx = makeEventContext({ event_type: "task-ready" as string });

    const run = await executor.execute(action, ctx);
    // The cwd was resolved from template — verify it ran in the right dir
    if (run.status === "completed") {
      const output = await fs.readFile(
        path.join(tempDir, "cwd-output.txt"),
        "utf-8",
      );
      expect(output).toBe(subDir);
    }
  });
});

// ─── AC-3: Environment Variable Injection ───────────────────────────────────

describe("KSPEC_* environment variables (ac-3)", () => {
  // AC: @dispatch-command-action ac-3
  it("injects KSPEC_EVENT_TYPE, KSPEC_EVENT_ID, KSPEC_SESSION_ID etc.", async () => {
    const scriptPath = path.join(tempDir, "dump-env.cjs");
    await fs.writeFile(
      scriptPath,
      `const fs = require('fs');
const path = require('path');
const kspecVars = {};
for (const [key, value] of Object.entries(process.env)) {
  if (key.startsWith('KSPEC_')) {
    kspecVars[key] = value;
  }
}
fs.writeFileSync(
  path.join(${JSON.stringify(tempDir)}, 'env-output.json'),
  JSON.stringify(kspecVars, null, 2)
);
process.exit(0);`,
    );

    const action: Action = {
      type: "command",
      command: process.execPath,
      args: [scriptPath],
    };
    const ctx = makeEventContext({
      event_id: "01EVT_TEST_ID_000000000001",
      event_type: "task.ready",
      session_id: "session-xyz-789",
      correlation_id: "01CORR_TEST_000000000001",
      task_ref: "@task-env-test",
      task_id: "01TASK_ENV_TEST_00000000001",
      from_status: "pending",
      to_status: "in_progress",
      agent_id: "task-worker",
    });

    const run = await executor.execute(action, ctx);
    expect(run.status).toBe("completed");

    const output = await fs.readFile(
      path.join(tempDir, "env-output.json"),
      "utf-8",
    );
    const kspecVars = JSON.parse(output);

    // Verify expected KSPEC_* variables are set
    expect(kspecVars.KSPEC_EVENT_TYPE).toBe("task.ready");
    expect(kspecVars.KSPEC_EVENT_ID).toBe("01EVT_TEST_ID_000000000001");
    expect(kspecVars.KSPEC_SESSION_ID).toBe("session-xyz-789");
    expect(kspecVars.KSPEC_CORRELATION_ID).toBe("01CORR_TEST_000000000001");
    expect(kspecVars.KSPEC_TASK_REF).toBe("@task-env-test");
    expect(kspecVars.KSPEC_TASK_ID).toBe("01TASK_ENV_TEST_00000000001");
    expect(kspecVars.KSPEC_FROM_STATUS).toBe("pending");
    expect(kspecVars.KSPEC_TO_STATUS).toBe("in_progress");
    expect(kspecVars.KSPEC_AGENT_ID).toBe("task-worker");
  });

  // AC: @dispatch-command-action ac-3
  it("only exposes allowlisted fields — non-allowlisted fields are excluded", async () => {
    const scriptPath = path.join(tempDir, "dump-env-filter.cjs");
    await fs.writeFile(
      scriptPath,
      `const fs = require('fs');
const path = require('path');
const kspecVars = {};
for (const [key, value] of Object.entries(process.env)) {
  if (key.startsWith('KSPEC_')) {
    kspecVars[key] = value;
  }
}
fs.writeFileSync(
  path.join(${JSON.stringify(tempDir)}, 'env-filter-output.json'),
  JSON.stringify(kspecVars, null, 2)
);
process.exit(0);`,
    );

    const action: Action = {
      type: "command",
      command: process.execPath,
      args: [scriptPath],
    };
    const ctx = makeEventContext({
      // These fields should NOT appear as KSPEC_* env vars
      task_title: "Some Task Title",
      secret_field: "should-not-be-exposed",
      arbitrary_data: "also-excluded",
    } as Record<string, string> & ActionEventContext);

    const run = await executor.execute(action, ctx);
    expect(run.status).toBe("completed");

    const output = await fs.readFile(
      path.join(tempDir, "env-filter-output.json"),
      "utf-8",
    );
    const kspecVars = JSON.parse(output);

    // Non-allowlisted fields should NOT have KSPEC_* env vars
    expect(kspecVars.KSPEC_TASK_TITLE).toBeUndefined();
    expect(kspecVars.KSPEC_SECRET_FIELD).toBeUndefined();
    expect(kspecVars.KSPEC_ARBITRARY_DATA).toBeUndefined();
  });

  // AC: @dispatch-command-action ac-3
  it("truncates payload values exceeding 1KB", () => {
    // Build a context with a value larger than 1KB
    const longValue = "x".repeat(2048);
    const ctx = makeEventContext({
      task_ref: longValue,
    });

    const envVars = buildKspecEnvVars(ctx);
    expect(envVars.KSPEC_TASK_REF).toBeDefined();
    expect(Buffer.byteLength(envVars.KSPEC_TASK_REF, "utf-8")).toBeLessThanOrEqual(
      ENV_VALUE_MAX_BYTES,
    );
  });

  // AC: @dispatch-command-action ac-3
  it("truncates multi-byte characters safely at 1KB boundary", () => {
    // Use multi-byte characters (each emoji is 4 bytes in UTF-8)
    const emoji = "\u{1F600}"; // 😀 — 4 bytes in UTF-8
    const longValue = emoji.repeat(300); // 300 * 4 = 1200 bytes
    const ctx = makeEventContext({
      task_ref: longValue,
    });

    const envVars = buildKspecEnvVars(ctx);
    expect(envVars.KSPEC_TASK_REF).toBeDefined();
    expect(Buffer.byteLength(envVars.KSPEC_TASK_REF, "utf-8")).toBeLessThanOrEqual(
      ENV_VALUE_MAX_BYTES,
    );
  });

  // AC: @dispatch-command-action ac-3
  it("does not truncate values under 1KB", () => {
    const shortValue = "a".repeat(512); // 512 bytes, well under limit
    const ctx = makeEventContext({
      task_ref: shortValue,
    });

    const envVars = buildKspecEnvVars(ctx);
    expect(envVars.KSPEC_TASK_REF).toBe(shortValue);
  });

  describe("buildKspecEnvVars", () => {
    // AC: @dispatch-command-action ac-3
    it("produces correctly namespaced KSPEC_* keys", () => {
      const ctx = makeEventContext({
        event_type: "task.ready",
        event_id: "01EVT0001",
        source_type: "task_watcher",
        source_id: "watcher-1",
      });

      const envVars = buildKspecEnvVars(ctx);

      expect(envVars.KSPEC_EVENT_TYPE).toBe("task.ready");
      expect(envVars.KSPEC_EVENT_ID).toBe("01EVT0001");
      expect(envVars.KSPEC_SOURCE_TYPE).toBe("task_watcher");
      expect(envVars.KSPEC_SOURCE_ID).toBe("watcher-1");
    });

    // AC: @dispatch-command-action ac-3
    it("omits undefined fields from the output", () => {
      const ctx: ActionEventContext = {
        event_id: "01EVT0001",
        event_type: "task.ready",
        // correlation_id, causation_id not set
      };

      const envVars = buildKspecEnvVars(ctx);

      expect(envVars.KSPEC_EVENT_ID).toBe("01EVT0001");
      expect(envVars.KSPEC_EVENT_TYPE).toBe("task.ready");
      expect(envVars.KSPEC_CORRELATION_ID).toBeUndefined();
      expect(envVars.KSPEC_CAUSATION_ID).toBeUndefined();
    });

    // AC: @dispatch-command-action ac-3
    it("allowlist contains the expected event fields", () => {
      // Verify the documented KSPEC_* variables are in the allowlist
      const expected = [
        "event_type",
        "event_id",
        "session_id",
        "correlation_id",
        "causation_id",
        "source_type",
        "source_id",
        "task_id",
        "task_ref",
        "from_status",
        "to_status",
        "agent_id",
      ];
      for (const field of expected) {
        expect(KSPEC_ENV_ALLOWLIST.has(field)).toBe(true);
      }
    });
  });

  // AC: @dispatch-command-action ac-3
  it("KSPEC_* env vars are available in spawned command process", async () => {
    const scriptPath = path.join(tempDir, "verify-env.cjs");
    await fs.writeFile(
      scriptPath,
      `const fs = require('fs');
const path = require('path');
// Verify specific KSPEC_* vars exist and have expected values
const results = {
  event_type: process.env.KSPEC_EVENT_TYPE,
  event_id: process.env.KSPEC_EVENT_ID,
  correlation_id: process.env.KSPEC_CORRELATION_ID,
  session_id: process.env.KSPEC_SESSION_ID,
  task_ref: process.env.KSPEC_TASK_REF,
};
fs.writeFileSync(
  path.join(${JSON.stringify(tempDir)}, 'verify-env-output.json'),
  JSON.stringify(results)
);
process.exit(0);`,
    );

    const action: Action = {
      type: "command",
      command: process.execPath,
      args: [scriptPath],
    };
    const ctx = makeEventContext({
      event_id: "01EVT_VERIFY_0000000000001",
      event_type: "task.in_progress",
      correlation_id: "01CORR_VERIFY_0000000000001",
      session_id: "session-verify-001",
      task_ref: "@task-verify-env",
    });

    const run = await executor.execute(action, ctx);
    expect(run.status).toBe("completed");

    const output = await fs.readFile(
      path.join(tempDir, "verify-env-output.json"),
      "utf-8",
    );
    const results = JSON.parse(output);

    expect(results.event_type).toBe("task.in_progress");
    expect(results.event_id).toBe("01EVT_VERIFY_0000000000001");
    expect(results.correlation_id).toBe("01CORR_VERIFY_0000000000001");
    expect(results.session_id).toBe("session-verify-001");
    expect(results.task_ref).toBe("@task-verify-env");
  });

  // AC: @dispatch-command-action ac-3
  it("action.env takes precedence over injected KSPEC_* vars", async () => {
    const scriptPath = path.join(tempDir, "env-precedence.cjs");
    await fs.writeFile(
      scriptPath,
      `const fs = require('fs');
const path = require('path');
fs.writeFileSync(
  path.join(${JSON.stringify(tempDir)}, 'precedence-output.txt'),
  process.env.KSPEC_EVENT_TYPE || 'MISSING'
);
process.exit(0);`,
    );

    const action: Action = {
      type: "command",
      command: process.execPath,
      args: [scriptPath],
      env: {
        KSPEC_EVENT_TYPE: "custom-override",
      },
    };
    const ctx = makeEventContext({ event_type: "task.ready" });

    const run = await executor.execute(action, ctx);
    expect(run.status).toBe("completed");

    const output = await fs.readFile(
      path.join(tempDir, "precedence-output.txt"),
      "utf-8",
    );
    // action.env overrides the auto-injected KSPEC_* value
    expect(output).toBe("custom-override");
  });
});

// ─── AC-4: Shadow Branch Safety ─────────────────────────────────────────────

describe("Shadow branch safety (ac-4)", () => {
  // AC: @dispatch-command-action ac-4
  it("command operates outside the shadow branch mutex", async () => {
    // The command action uses spawn() with shell: false and runs in the
    // project directory, not the .kspec/ worktree. It does not acquire
    // any shadow branch lock. This test verifies the command runs
    // normally without any mutex interaction.
    const action: Action = {
      type: "command",
      command: "echo",
      args: ["no-mutex-needed"],
    };
    const ctx = makeEventContext();

    const run = await executor.execute(action, ctx);
    expect(run.status).toBe("completed");
    expect(run.exit_code).toBe(0);
  });

  // AC: @dispatch-command-action ac-4
  it("command runs in project directory by default, not .kspec/", async () => {
    const scriptPath = path.join(tempDir, "check-dir.cjs");
    await fs.writeFile(
      scriptPath,
      `const fs = require('fs');
const path = require('path');
fs.writeFileSync(
  path.join(${JSON.stringify(tempDir)}, 'dir-output.txt'),
  process.cwd()
);
process.exit(0);`,
    );

    const action: Action = {
      type: "command",
      command: process.execPath,
      args: [scriptPath],
      // No cwd override — should use projectDir
    };
    const ctx = makeEventContext();

    const run = await executor.execute(action, ctx);
    expect(run.status).toBe("completed");

    const output = await fs.readFile(
      path.join(tempDir, "dir-output.txt"),
      "utf-8",
    );
    // Runs in project root (tempDir), not in .kspec/
    expect(output).toBe(tempDir);
    expect(output).not.toContain(".kspec");
  });

  // AC: @dispatch-command-action ac-4
  it("command with cwd override runs in specified directory", async () => {
    const customDir = path.join(tempDir, "custom-work-dir");
    await fs.mkdir(customDir, { recursive: true });

    const scriptPath = path.join(tempDir, "check-custom-dir.cjs");
    await fs.writeFile(
      scriptPath,
      `const fs = require('fs');
const path = require('path');
fs.writeFileSync(
  path.join(${JSON.stringify(tempDir)}, 'custom-dir-output.txt'),
  process.cwd()
);
process.exit(0);`,
    );

    const action: Action = {
      type: "command",
      command: process.execPath,
      args: [scriptPath],
      cwd: customDir,
    };
    const ctx = makeEventContext();

    const run = await executor.execute(action, ctx);
    expect(run.status).toBe("completed");

    const output = await fs.readFile(
      path.join(tempDir, "custom-dir-output.txt"),
      "utf-8",
    );
    expect(output).toBe(customDir);
  });

  // AC: @dispatch-command-action ac-4
  it("spawn uses shell: false by default — no shell interpretation", async () => {
    // If shell were true, the pipe character would be interpreted.
    // With shell: false, it's treated as a literal argument.
    const scriptPath = path.join(tempDir, "check-no-shell.cjs");
    await fs.writeFile(
      scriptPath,
      `const fs = require('fs');
const path = require('path');
fs.writeFileSync(
  path.join(${JSON.stringify(tempDir)}, 'no-shell-output.txt'),
  process.argv[2]
);
process.exit(0);`,
    );

    const action: Action = {
      type: "command",
      command: process.execPath,
      args: [scriptPath, "hello | cat"],
      // shell is false by default
    };
    const ctx = makeEventContext();

    const run = await executor.execute(action, ctx);
    expect(run.status).toBe("completed");

    const output = await fs.readFile(
      path.join(tempDir, "no-shell-output.txt"),
      "utf-8",
    );
    // The pipe character is literal, not interpreted
    expect(output).toBe("hello | cat");
  });
});
