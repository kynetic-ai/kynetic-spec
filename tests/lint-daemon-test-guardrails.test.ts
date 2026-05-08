/**
 * Daemon test fixture guardrail tests.
 *
 * These tests cover the guardrails layered on top of the no-leaky-test-daemon
 * rule for @daemon-test-harness-guardrails:
 *
 *   ac-direct-daemon-spawn-flagged
 *     A test file that starts a real daemon directly (spawn DAEMON_ENTRY)
 *     outside the shared helper paths is flagged even when cleanup is
 *     registered — the rule's escape hatch is the helper allowlist or a
 *     local oxlint-disable, not cleanup.
 *
 *   ac-detached-serve-without-cleanup-flagged
 *     A test file that starts a detached daemon via the CLI without scoped
 *     cleanup is flagged. Existing behavior of the rule, exercised here
 *     against the "use shared fixture" message path so the AC has a
 *     dedicated annotation.
 *
 *   ac-helper-internals-allowed
 *     The shared daemon fixture, the mock daemon helper, and the lint rule's
 *     own fixture-string test file are allowlisted by path. The rule does
 *     not flag spawn(DAEMON_ENTRY), serve start --detach, hardcoded
 *     spawn("bun", [DAEMON_ENTRY]), or localhost:port URL construction in
 *     those locations.
 *
 *   ac-exceptions-are-localized
 *     A test that needs to violate the normal pattern can declare a local
 *     oxlint-disable-next-line with a "-- reason" describing the behavior
 *     under test. Bare `oxlint-disable` (whole-file) is rejected — the
 *     guardrail enforces narrow per-statement exceptions.
 */

import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const PROJECT_ROOT = path.resolve(__dirname, "..");
const RULE_PATH = path.resolve(
  PROJECT_ROOT,
  "tools/eslint-rules/no-leaky-test-daemon.js",
);

interface OxlintInvocation {
  /** Source contents of the test file the lint rule will inspect. */
  source: string;
  /**
   * Relative path inside the synthetic project where the test file is
   * written. Defaults to a path under tests/ so the override applies
   * (the real .oxlintrc.json scopes this rule to tests/**).
   */
  relPath?: string;
}

interface OxlintResult {
  exitCode: number;
  output: string;
}

function runOxlint({
  source,
  relPath = "tests/sample-test.ts",
}: OxlintInvocation): OxlintResult {
  const projectDir = mkdtempSync(path.join(os.tmpdir(), "guardrail-lint-"));
  const testFile = path.join(projectDir, relPath);
  mkdirSync(path.dirname(testFile), { recursive: true });

  const config = {
    plugins: ["typescript"],
    overrides: [
      {
        files: ["tests/**/*.ts"],
        jsPlugins: [RULE_PATH],
        rules: {
          "no-leaky-test-daemon/no-leaky-test-daemon": "error",
        },
      },
    ],
  };
  const configFile = path.join(projectDir, ".oxlintrc.json");
  writeFileSync(configFile, JSON.stringify(config));
  writeFileSync(testFile, source);

  try {
    const output = execSync(
      `npx oxlint --config "${configFile}" "${testFile}"`,
      {
        cwd: PROJECT_ROOT,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    rmSync(projectDir, { recursive: true, force: true });
    return { exitCode: 0, output };
  } catch (err: unknown) {
    const error = err as { status: number; stdout: string; stderr: string };
    rmSync(projectDir, { recursive: true, force: true });
    return {
      exitCode: error.status,
      output: (error.stdout || "") + (error.stderr || ""),
    };
  }
}

describe("daemon test harness guardrails", () => {
  // AC: @daemon-test-harness-guardrails ac-direct-daemon-spawn-flagged
  describe("direct daemon spawn is flagged outside the shared fixture", () => {
    it("flags spawn(node, [DAEMON_ENTRY]) in a test even when afterEach kills the child", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";

describe("direct spawn with cleanup", () => {
  let child;
  afterEach(() => {
    if (child) child.kill("SIGTERM");
  });

  it("starts a daemon directly", () => {
    child = spawn("node", [DAEMON_ENTRY, "--port", "0"]);
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    it("flags spawn with the dist/daemon/index.js literal in a test body", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { spawn } from "child_process";

describe("direct spawn with onTestFinished", () => {
  it("starts the compiled daemon", () => {
    const child = spawn("node", ["dist/daemon/index.js", "--port", "0"]);
    onTestFinished(() => process.kill(child.pid, "SIGTERM"));
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    it("flags hardcoded spawn(\"bun\", [DAEMON_ENTRY]) outside a runtime parity test", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { spawn } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";

describe("bun-hardcoded spawn", () => {
  it("starts the daemon under bun", () => {
    const child = spawn("bun", [DAEMON_ENTRY, "--port", "0"]);
    onTestFinished(() => process.kill(child.pid, "SIGTERM"));
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/bun|runtime/i);
    });

    it("flags fetch() with a localhost:<port> URL constructed by the test", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";

describe("manual localhost URL", () => {
  it("fetches health by hardcoded host", async () => {
    const port = 3456;
    const response = await fetch(\`http://localhost:\${port}/api/health\`);
    expect(response.status).toBe(200);
  });
});
`,
      });
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/localhost|fixture endpoint/i);
    });

    it("flags new WebSocket() with a ws://localhost:<port> URL", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";

describe("manual websocket URL", () => {
  it("opens a websocket by hardcoded host", () => {
    const port = 3456;
    const ws = new WebSocket(\`ws://localhost:\${port}/ws\`);
    expect(ws).toBeDefined();
  });
});
`,
      });
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/localhost|fixture endpoint/i);
    });
  });

  // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
  describe("detached serve without scoped cleanup is flagged", () => {
    it("flags runKspec(\"serve start --detach\") with no onTestFinished or afterEach", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";

describe("detached serve without cleanup", () => {
  it("starts the daemon detached", () => {
    runKspec("serve start --detach --port 3456");
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    it("flags execSync(\"kspec serve start --detach\") in a test body", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { execSync } from "child_process";

describe("execSync detached serve", () => {
  it("starts the daemon detached via execSync", () => {
    execSync("kspec serve start --detach --port 3456");
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    it("does not flag runKspec(\"serve start --detach\") when the test reads the pid file and registers killPid via onTestFinished", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";

describe("detached serve with scoped cleanup", () => {
  it("starts the daemon detached and cleans up", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => killPid(pid));
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });
  });

  // AC: @daemon-test-harness-guardrails ac-helper-internals-allowed
  describe("helper internals are allowlisted by path", () => {
    it("does not flag spawn(DAEMON_ENTRY) inside tests/helpers/", () => {
      const result = runOxlint({
        relPath: "tests/helpers/sample-helper.ts",
        source: `
import { spawn } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";

export function startHelperDaemon(port) {
  return spawn("node", [DAEMON_ENTRY, "--port", String(port)]);
}
`,
      });
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("does not flag hardcoded spawn(\"bun\", [DAEMON_ENTRY]) inside tests/helpers/", () => {
      const result = runOxlint({
        relPath: "tests/helpers/sample-helper.ts",
        source: `
import { spawn } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";

export function startBunDaemon(port) {
  return spawn("bun", [DAEMON_ENTRY, "--port", String(port)]);
}
`,
      });
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("does not flag fetch(\"http://localhost:<port>/...\") inside tests/helpers/", () => {
      const result = runOxlint({
        relPath: "tests/helpers/sample-helper.ts",
        source: `
export async function probeHealth(port) {
  return fetch(\`http://localhost:\${port}/api/health\`);
}
`,
      });
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("does not flag the explicit fixture strings inside tests/lint-no-leaky-test-daemon.test.ts", () => {
      const result = runOxlint({
        relPath: "tests/lint-no-leaky-test-daemon.test.ts",
        source: `
import { describe, it, expect } from "vitest";

describe("rule fixture", () => {
  it("contains a daemon-spawn fixture string", () => {
    const fixture = \`
      import { spawn } from "child_process";
      const DAEMON_ENTRY = "dist/daemon/index.js";
      const child = spawn("bun", [DAEMON_ENTRY, "--port", "0"]);
      runKspec("serve start --detach --port 3456");
      const url = \\\`http://localhost:\\\${port}/api/health\\\`;
    \`;
    expect(fixture).toContain("DAEMON_ENTRY");
  });
});
`,
      });
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("does not flag the new daemon-test guardrail test file's own fixture strings", () => {
      const result = runOxlint({
        relPath: "tests/lint-daemon-test-guardrails.test.ts",
        source: `
import { describe, it, expect } from "vitest";

describe("guardrail fixture", () => {
  it("contains fixture strings inside string templates", () => {
    const fixture = \`spawn("bun", [DAEMON_ENTRY])\`;
    const url = "http://localhost:3456/api/health";
    expect(fixture).toBeDefined();
    expect(url).toBeDefined();
  });
});
`,
      });
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });
  });

  // AC: @daemon-test-harness-guardrails ac-exceptions-are-localized
  describe("intentional exceptions are localized to the offending statement", () => {
    it("accepts oxlint-disable-next-line with a -- reason for a direct daemon spawn under test", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { spawn } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";

describe("intentional direct spawn", () => {
  it("verifies daemon dies on EADDRINUSE without a parent kspec wrapper", () => {
    // oxlint-disable-next-line no-leaky-test-daemon/no-leaky-test-daemon -- intentionally bypasses the shared fixture to observe raw daemon exit on bind failure
    const child = spawn("node", [DAEMON_ENTRY, "--port", "0"]);
    onTestFinished(() => process.kill(child.pid, "SIGTERM"));
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("accepts oxlint-disable-next-line with a -- reason for a localhost:<port> fetch under test", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";

describe("intentional localhost url", () => {
  it("verifies the CLI's own daemon-control behavior", async () => {
    const port = 3456;
    // oxlint-disable-next-line no-leaky-test-daemon/no-leaky-test-daemon -- testing the CLI's hardcoded localhost daemon-control path
    const response = await fetch(\`http://localhost:\${port}/api/health\`);
    expect(response.status).toBe(200);
  });
});
`,
      });
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("does not silence the rule for the next statement when the disable is attached to an unrelated line", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { spawn } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";

describe("disable on the wrong line", () => {
  it("does not exempt a later spawn", () => {
    // oxlint-disable-next-line no-leaky-test-daemon/no-leaky-test-daemon -- this disable applies only to the literal below
    const noop = "harmless";
    const child = spawn("node", [DAEMON_ENTRY, "--port", "0"]);
    onTestFinished(() => process.kill(child.pid, "SIGTERM"));
    expect(noop).toBe("harmless");
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.output).toContain("no-leaky-test-daemon");
    });
  });

  // AC: @daemon-test-harness-guardrails ac-helper-internals-allowed
  // AC: @daemon-test-harness-guardrails ac-exceptions-are-localized
  describe("does not regress legitimate non-daemon patterns", () => {
    it("does not flag fetch(\"http://localhost/api/...\") with no port (in-process app.handle pattern)", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";

declare const app: { handle: (r: Request) => Promise<Response> };

describe("in-process route handler", () => {
  it("hits the daemon app directly", async () => {
    const response = await app.handle(
      new Request("http://localhost/api/health", { method: "GET", headers: { Host: "localhost" } }),
    );
    expect(response.status).toBe(200);
  });
});
`,
      });
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("does not flag a localhost:<port> string used as an assertion target (not a fetch)", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";

describe("origin allowlist", () => {
  it("recognizes the dev-server origin", () => {
    const allowed = ["http://localhost:5173", "http://127.0.0.1:5173"];
    expect(allowed).toContain("http://localhost:5173");
  });
});
`,
      });
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("does not flag spawn(\"bun\", [\"run\", \"some-script.mjs\"]) — non-daemon bun usage", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";

describe("bun script harness", () => {
  it("runs a bun script", () => {
    const result = spawnSync("bun", ["run", "some-script.mjs"]);
    expect(result.status).toBe(0);
  });
});
`,
      });
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });
  });
});
