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
          "no-leaky-test-daemon/localized-disable": "error",
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
  // AC: @daemon-test-guardrail-precision ac-direct-daemon-entry-invocations-flagged
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

    it("flags fetch(url) when url is a const bound to a localhost:<port> template literal", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";

describe("variable-bound localhost url", () => {
  it("fetches health via a hoisted url variable", async () => {
    const port = 3456;
    const url = \`http://localhost:\${port}/api/health\`;
    const response = await fetch(url);
    expect(response.status).toBe(200);
  });
});
`,
      });
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/localhost|fixture endpoint/i);
    });

    it("flags fetch(url) when url is a const bound to a literal http://localhost:<port>/... string", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";

describe("literal-bound localhost url", () => {
  it("fetches health via a literal url variable", async () => {
    const url = "http://localhost:3456/api/health";
    const response = await fetch(url);
    expect(response.status).toBe(200);
  });
});
`,
      });
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    it("flags new WebSocket(url) when url is a variable bound to a ws://localhost:<port> URL", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";

describe("variable-bound websocket url", () => {
  it("opens a websocket via a variable", () => {
    const port = 3456;
    const wsUrl = \`ws://localhost:\${port}/ws\`;
    const ws = new WebSocket(wsUrl);
    expect(ws).toBeDefined();
  });
});
`,
      });
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    it("does not flag fetch(url) when url is bound to a non-localhost URL", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";

describe("non-localhost url variable", () => {
  it("fetches a remote endpoint", async () => {
    const url = "https://example.com/api/health";
    const response = await fetch(url);
    expect(response.status).toBe(200);
  });
});
`,
      });
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("does not flag fetch(url) in one test() block when an unrelated earlier test() block declared a localhost-bound url with the same name", () => {
      // Scope-aware tracking: a prior test's `const url = http://localhost:<port>/...`
      // must not bleed into a later test that uses `const url = daemon.apiUrl`.
      // The two consts are in distinct lexical scopes (each it() body is a
      // separate BlockStatement) so the later fetch resolves to the local
      // non-localhost binding and is not flagged.
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";

declare const daemon: { apiUrl: string };

describe("scope isolation across tests", () => {
  it("asserts on a localhost-bound url string only", () => {
    const url = \`http://localhost:\${3456}/api/health\`;
    expect(url).toContain("localhost");
  });

  it("uses the fixture-resolved endpoint", async () => {
    const url = daemon.apiUrl + "/api/health";
    const response = await fetch(url);
    expect(response.status).toBe(200);
  });
});
`,
      });
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("does not flag fetch(url) when an inner block's const url shadows an outer localhost-bound declaration", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";

declare const daemon: { apiUrl: string };

const url = \`http://localhost:\${3456}/api/health\`; // module-level localhost binding

describe("inner-scope shadowing", () => {
  it("uses the fixture-resolved endpoint inside the test", async () => {
    const url = daemon.apiUrl + "/api/health";
    const response = await fetch(url);
    expect(response.status).toBe(200);
  });
});
`,
      });
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("does not flag fetch(url) when a later non-localhost reassignment shadows an earlier localhost let binding in the same scope", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";

declare const daemon: { apiUrl: string };

describe("reassignment shadowing", () => {
  it("uses a reassigned url variable", async () => {
    let url = \`http://localhost:\${3456}/api/health\`;
    url = daemon.apiUrl + "/api/health";
    const response = await fetch(url);
    expect(response.status).toBe(200);
  });
});
`,
      });
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("flags fetch(url) when a later localhost reassignment overrides an earlier non-localhost let binding in the same scope", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";

declare const daemon: { apiUrl: string };

describe("localhost reassignment", () => {
  it("reassigns to a localhost url", async () => {
    let url = daemon.apiUrl + "/api/health";
    url = \`http://localhost:\${3456}/api/health\`;
    const response = await fetch(url);
    expect(response.status).toBe(200);
  });
});
`,
      });
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    it("flags fetch(url) inside a closure that captures a localhost-bound outer const", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";

describe("closure captures outer localhost", () => {
  it("calls fetch via a captured closure", async () => {
    const url = \`http://localhost:\${3456}/api/health\`;
    const probe = async () => fetch(url);
    const response = await probe();
    expect(response.status).toBe(200);
  });
});
`,
      });
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    it("does not flag fetch(url) inside a function whose `url` parameter shadows an outer localhost binding", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";

const url = \`http://localhost:\${3456}/api/health\`;

async function probe(url: string) {
  return fetch(url);
}

describe("parameter shadowing", () => {
  it("calls probe with a fixture-resolved url", async () => {
    const response = await probe("https://example.com/api/health");
    expect(response.status).toBe(200);
  });
});
`,
      });
      expect(result.output).not.toContain("no-leaky-test-daemon");
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

    it("flags spawn(\"kspec\", [\"serve\", \"start\", \"--detach\"]) when argv carries the detach flag separately", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { spawn } from "child_process";

describe("argv-style detached serve without cleanup", () => {
  it("starts the daemon detached via argv array", () => {
    spawn("kspec", ["serve", "start", "--detach", "--port", "3456"]);
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/serve start --detach|cleanup/i);
    });

    it("flags spawnSync(\"kspec\", [\"serve\", \"start\", \"--detach\"]) when argv carries the detach flag separately", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";

describe("argv-style detached serve via spawnSync", () => {
  it("starts the daemon detached via spawnSync argv", () => {
    spawnSync("kspec", ["serve", "start", "--detach"]);
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    it("does not flag spawn(\"kspec\", [\"serve\", \"start\", \"--detach\"]) when followed by scoped cleanup", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { spawn } from "child_process";

describe("argv detached serve with scoped cleanup", () => {
  it("starts the daemon detached via argv and cleans up", () => {
    spawn("kspec", ["serve", "start", "--detach", "--port", "3456"]);
    const pid = readPidFromFile();
    onTestFinished(() => killPid(pid));
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.output).not.toContain("no-leaky-test-daemon");
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
    it("does not flag spawn(DAEMON_ENTRY) inside the shared daemon fixture (tests/helpers/daemon.ts)", () => {
      const result = runOxlint({
        relPath: "tests/helpers/daemon.ts",
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

    it("does not flag hardcoded spawn(\"bun\", [DAEMON_ENTRY]) inside the shared daemon fixture (tests/helpers/daemon.ts)", () => {
      const result = runOxlint({
        relPath: "tests/helpers/daemon.ts",
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

    it("does not flag fetch(\"http://localhost:<port>/...\") inside the mock daemon helper (tests/helpers/mock-daemon.ts)", () => {
      const result = runOxlint({
        relPath: "tests/helpers/mock-daemon.ts",
        source: `
export async function probeHealth(port) {
  return fetch(\`http://localhost:\${port}/api/health\`);
}
`,
      });
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("flags spawn(DAEMON_ENTRY) in an unsanctioned tests/helpers/ file (allowlist is narrow, not the whole helpers/ tree)", () => {
      const result = runOxlint({
        relPath: "tests/helpers/rogue-helper.ts",
        source: `
import { spawn } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";

export function startRogueDaemon(port) {
  return spawn("node", [DAEMON_ENTRY, "--port", String(port)]);
}
`,
      });
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    it("flags fetch(\"http://localhost:<port>/...\") in an unsanctioned tests/helpers/ file", () => {
      const result = runOxlint({
        relPath: "tests/helpers/rogue-helper.ts",
        source: `
export async function probeHealth(port) {
  return fetch(\`http://localhost:\${port}/api/health\`);
}
`,
      });
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/localhost|fixture endpoint/i);
    });

    it("flags spawn(DAEMON_ENTRY) inside a contract-test sibling of the shared fixture (tests/helpers/daemon.test.ts is not approved)", () => {
      const result = runOxlint({
        relPath: "tests/helpers/daemon.test.ts",
        source: `
import { describe, it, expect } from "vitest";
import { spawn } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";

describe("contract test", () => {
  it("starts a daemon directly", () => {
    const child = spawn("node", [DAEMON_ENTRY, "--port", "0"]);
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.output).toContain("no-leaky-test-daemon");
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

    it("flags oxlint-disable-next-line for the rule when the directive omits the `-- reason`", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { spawn } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";

describe("undocumented disable-next-line", () => {
  it("requires every per-line disable to document the behavior under test", () => {
    // oxlint-disable-next-line no-leaky-test-daemon/no-leaky-test-daemon
    const child = spawn("node", [DAEMON_ENTRY, "--port", "0"]);
    onTestFinished(() => process.kill(child.pid, "SIGTERM"));
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/reason|behavior under test|localized-disable/i);
    });

    it("flags oxlint-disable-line for the rule when the directive omits the `-- reason`", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { spawn } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";

describe("undocumented disable-line", () => {
  it("requires every per-line disable to document the behavior under test", () => {
    const child = spawn("node", [DAEMON_ENTRY, "--port", "0"]); // oxlint-disable-line no-leaky-test-daemon/no-leaky-test-daemon
    onTestFinished(() => process.kill(child.pid, "SIGTERM"));
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/reason|behavior under test|localized-disable/i);
    });

    it("flags a file-wide oxlint-disable for the rule even when individual statements are silenced", () => {
      const result = runOxlint({
        source: `
/* oxlint-disable no-leaky-test-daemon/no-leaky-test-daemon */
import { describe, it, expect, onTestFinished } from "vitest";
import { spawn } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";

describe("file-wide disable broad", () => {
  it("starts a daemon directly under a broad disable", () => {
    const child = spawn("node", [DAEMON_ENTRY, "--port", "0"]);
    onTestFinished(() => process.kill(child.pid, "SIGTERM"));
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/file.?wide|block.?wide|localized-disable/i);
    });

    it("flags a file-wide oxlint-disable that targets the plugin name (no rule suffix)", () => {
      const result = runOxlint({
        source: `
/* oxlint-disable no-leaky-test-daemon */
import { describe, it, expect, onTestFinished } from "vitest";
import { spawn } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";

describe("plugin-wide file disable", () => {
  it("starts a daemon directly under a plugin-wide disable", () => {
    const child = spawn("node", [DAEMON_ENTRY, "--port", "0"]);
    onTestFinished(() => process.kill(child.pid, "SIGTERM"));
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/file.?wide|block.?wide|localized-disable/i);
    });

    it("does not flag oxlint-disable-next-line that targets only an unrelated rule", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";

describe("unrelated disable", () => {
  it("uses an unrelated disable", () => {
    // oxlint-disable-next-line jest/valid-expect
    expect(true).toBe(true);
  });
});
`,
      });
      // The unrelated disable should not trigger localized-disable for our rule.
      expect(result.output).not.toContain("localized-disable");
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

/**
 * Daemon test guardrail precision tests.
 *
 * These tests cover @daemon-test-guardrail-precision: the classifier inside
 * the no-leaky-test-daemon rule must be tied to daemon behavior rather than
 * incidental token sequences. They exercise two precision properties:
 *
 *   1. Direct daemon entrypoint invocation through child-process APIs
 *      beyond `spawn` / `spawnSync` — `fork(<daemon entry>, ...)` and
 *      exec-file style calls (`execFile`, `execFileSync`) that launch the
 *      daemon entrypoint must be reported the same as a direct spawn,
 *      because they are equivalent ways to start the compiled daemon.
 *
 *   2. Detached-serve detection that ignores unrelated subprocesses whose
 *      argv tokens happen to overlap with kspec lifecycle words. The
 *      detached-serve diagnostic must only fire when the call actually
 *      invokes the kspec CLI (executable name, leading shell token, or
 *      `runKspec` wrapper), not when an arbitrary executable's arguments
 *      coincidentally include "serve", "start", and "--detach".
 */

describe("daemon test guardrail precision", () => {
  // AC: @daemon-test-guardrail-precision ac-direct-daemon-entry-invocations-flagged
  // AC: @daemon-test-harness-guardrails ac-direct-daemon-spawn-flagged
  describe("direct daemon entry via non-spawn child-process APIs is flagged", () => {
    it("flags fork(\"dist/daemon/index.js\", ...) as a direct daemon entrypoint invocation", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { fork } from "child_process";

describe("fork daemon entry literal", () => {
  it("forks the daemon entrypoint", () => {
    const child = fork("dist/daemon/index.js", ["--port", "0"]);
    onTestFinished(() => process.kill(child.pid, "SIGTERM"));
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    it("flags fork(DAEMON_ENTRY, ...) as a direct daemon entrypoint invocation", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { fork } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";

describe("fork daemon entry identifier", () => {
  it("forks via DAEMON_ENTRY", () => {
    const child = fork(DAEMON_ENTRY, ["--port", "0"]);
    onTestFinished(() => process.kill(child.pid, "SIGTERM"));
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    it("flags execFile(\"node\", [\"dist/daemon/index.js\", ...]) as a direct daemon entry invocation", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { execFile } from "child_process";

describe("execFile daemon entry literal", () => {
  it("execFiles the daemon entrypoint", () => {
    const child = execFile("node", ["dist/daemon/index.js", "--port", "0"]);
    onTestFinished(() => process.kill(child.pid, "SIGTERM"));
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    it("flags execFileSync(\"node\", [DAEMON_ENTRY, ...]) as a direct daemon entry invocation", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";

describe("execFileSync daemon entry identifier", () => {
  it("execFileSyncs the daemon entrypoint", () => {
    const stdout = execFileSync("node", [DAEMON_ENTRY, "--port", "0"]);
    expect(stdout).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    it("flags execFile(DAEMON_ENTRY, [...]) when the daemon entry IS the executable arg", () => {
      // Direct-executable form: a daemon entry built with a shebang is
      // directly invokable, so passing it as args[0] launches the compiled
      // daemon the same as the runtime form. The classifier must report
      // the daemon-entry-as-executable shape, not just the runtime form.
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { execFile } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";

describe("execFile daemon-entry executable", () => {
  it("execFiles the daemon entry directly", () => {
    const child = execFile(DAEMON_ENTRY, ["--port", "0"]);
    onTestFinished(() => process.kill(child.pid, "SIGTERM"));
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    it("flags execFileSync(\"dist/daemon/index.js\", [...]) when the daemon entry literal IS the executable arg", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";

describe("execFileSync daemon-entry literal executable", () => {
  it("execFileSyncs the daemon entry literal directly", () => {
    const stdout = execFileSync("dist/daemon/index.js", ["--port", "0"]);
    expect(stdout).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    it("flags spawn(DAEMON_ENTRY, [...]) when the daemon entry IS the executable arg", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { spawn } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";

describe("spawn daemon-entry executable", () => {
  it("spawns the daemon entry directly", () => {
    const child = spawn(DAEMON_ENTRY, ["--port", "0"]);
    onTestFinished(() => process.kill(child.pid, "SIGTERM"));
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    it("flags spawnSync(DAEMON_ENTRY) with no argv when the daemon entry IS the executable arg", () => {
      // Argv is optional for spawn-likes — the daemon entry alone is
      // enough to launch the compiled daemon when args[0] is the entry.
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";

describe("spawnSync daemon-entry executable, no argv", () => {
  it("spawnSyncs the daemon entry with no extra args", () => {
    const result = spawnSync(DAEMON_ENTRY);
    expect(result.status).toBe(0);
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    // The shell-string forms (`exec`, `execSync`) are equivalent to a
    // runtime-form spawn for the daemon entry — the OS shell still
    // launches the compiled daemon. The classifier must report these the
    // same as the spawn/execFile forms; otherwise contributors can
    // sidestep the shared-fixture contract by typing the same launch as
    // a single shell string.

    it("flags exec(\"node dist/daemon/index.js --port 0\") as a direct daemon entry invocation", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { exec } from "child_process";

describe("exec runtime-form shell string", () => {
  it("execs the daemon entrypoint via the shell", () => {
    const child = exec("node dist/daemon/index.js --port 0");
    onTestFinished(() => process.kill(child.pid, "SIGTERM"));
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    it("flags execSync(\"node dist/daemon/index.js --port 0\") as a direct daemon entry invocation", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { execSync } from "child_process";

describe("execSync runtime-form shell string", () => {
  it("execSyncs the daemon entrypoint via the shell", () => {
    const stdout = execSync("node dist/daemon/index.js --port 0");
    expect(stdout).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    it("flags execSync(\"dist/daemon/index.js --port 0\") when the daemon entry is the leading shell token", () => {
      // Direct-executable form via shell — a shebang'd daemon entry is
      // launched by name. The classifier reports this the same as
      // `execFile(DAEMON_ENTRY, [...])`.
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { execSync } from "child_process";

describe("execSync direct-executable shell string", () => {
  it("execSyncs the daemon entry as the leading token", () => {
    const stdout = execSync("dist/daemon/index.js --port 0");
    expect(stdout).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    it("flags exec with an absolute /…/dist/daemon/index.js path token in the shell command", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { exec } from "child_process";

describe("exec absolute daemon entry path", () => {
  it("execs the daemon entry via an absolute path", () => {
    const child = exec("node /workspace/dist/daemon/index.js --port 0");
    onTestFinished(() => process.kill(child.pid, "SIGTERM"));
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    it("flags exec(`node dist/daemon/index.js --port ${port}`) template literal as a direct daemon entry invocation", () => {
      // Template literals are tokenised the same way as plain string
      // literals; an interpolation that does not contain the daemon entry
      // path is preserved as a `${...}` placeholder so unrelated tokens
      // cannot accidentally satisfy the daemon-entry check.
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { exec } from "child_process";

describe("exec template literal runtime form", () => {
  it("execs via a template literal carrying the daemon entry token", () => {
    const port = 0;
    const child = exec(\`node dist/daemon/index.js --port \${port}\`);
    onTestFinished(() => process.kill(child.pid, "SIGTERM"));
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    it("flags execSync(\"bun dist/daemon/index.js …\") with the hardcoded-runtime message", () => {
      // The hardcoded-bun message fires for shell-string Bun launches
      // too: runtime selection belongs to the shared fixture, regardless
      // of whether the spawn was expressed as argv or as a shell command.
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { execSync } from "child_process";

describe("execSync hardcoded bun runtime", () => {
  it("execSyncs the daemon entry under bun via the shell", () => {
    const stdout = execSync("bun dist/daemon/index.js --port 0");
    expect(stdout).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/bun|runtime/i);
    });

    // AC: @daemon-test-guardrail-precision ac-direct-daemon-entry-invocations-flagged
    //
    // Regression set covering the precision blocker from review cycle 6:
    // exec/execSync shell strings whose runtime token is followed by Node
    // option flags before the daemon entry path are direct daemon launches
    // — `node --enable-source-maps dist/daemon/index.js` runs the daemon
    // the same as `node dist/daemon/index.js`. The classifier must walk
    // past flag-shaped tokens between the runtime and the script path so
    // these direct launches are reported.
    it("flags exec(\"node --enable-source-maps dist/daemon/index.js --port 0\") with a runtime flag between node and the daemon entry", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { exec } from "child_process";

describe("exec node runtime flag", () => {
  it("execs the daemon entry under node with --enable-source-maps", () => {
    const child = exec("node --enable-source-maps dist/daemon/index.js --port 0");
    onTestFinished(() => process.kill(child.pid, "SIGTERM"));
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    it("flags execSync(\"node --inspect-brk=0.0.0.0:9229 dist/daemon/index.js --port 0\") with a value-attached runtime flag", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { execSync } from "child_process";

describe("execSync node inspect-brk flag", () => {
  it("execSyncs the daemon entry under node with an inspect-brk flag", () => {
    const stdout = execSync("node --inspect-brk=0.0.0.0:9229 dist/daemon/index.js --port 0");
    expect(stdout).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    it("flags exec(\"/usr/bin/node --enable-source-maps --inspect dist/daemon/index.js --port 0\") with multiple runtime flags before a path-suffixed runtime", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { exec } from "child_process";

describe("exec path-suffixed node runtime with multiple flags", () => {
  it("execs the daemon entry under /usr/bin/node with stacked runtime flags", () => {
    const child = exec("/usr/bin/node --enable-source-maps --inspect dist/daemon/index.js --port 0");
    onTestFinished(() => process.kill(child.pid, "SIGTERM"));
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    it("flags exec(\"node -- dist/daemon/index.js --port 0\") with the `--` flag separator between node and the daemon entry", () => {
      // The `--` separator ends Node's option parsing. The classifier
      // walks past it the same as any other flag-shaped token; the daemon
      // entry remains the first non-flag token after the runtime, so the
      // call is still a direct daemon launch.
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { exec } from "child_process";

describe("exec node -- daemon entry", () => {
  it("execs the daemon entry under node with the -- separator", () => {
    const child = exec("node -- dist/daemon/index.js --port 0");
    onTestFinished(() => process.kill(child.pid, "SIGTERM"));
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    it("flags execSync(\"bun --hot dist/daemon/index.js --port 0\") with a Bun runtime flag before the daemon entry", () => {
      // The hardcoded-bun message must still fire for shell-string Bun
      // launches when runtime flags sit between `bun` and the script
      // path; runtime selection belongs to the shared fixture regardless
      // of how the command is expressed.
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { execSync } from "child_process";

describe("execSync bun runtime flag", () => {
  it("execSyncs the daemon entry under bun with --hot", () => {
    const stdout = execSync("bun --hot dist/daemon/index.js --port 0");
    expect(stdout).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/bun|runtime/i);
    });

    it("flags exec(`node --enable-source-maps dist/daemon/index.js --port ${port}`) template literal with a runtime flag", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { exec } from "child_process";

describe("exec template literal with node runtime flag", () => {
  it("execs the daemon entry under node with a runtime flag and an interpolated port", () => {
    const port = 0;
    const child = exec(\`node --enable-source-maps dist/daemon/index.js --port \${port}\`);
    onTestFinished(() => process.kill(child.pid, "SIGTERM"));
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    // AC: @daemon-test-guardrail-precision ac-direct-daemon-entry-invocations-flagged
    //
    // Regression set covering the false-negative half of the review cycle 7
    // blocker: Node/Bun runtime options that consume their value as a
    // separately-passed next token (e.g. `--require ./preload.js`,
    // `-r ./preload.js`, `--conditions production`) must not cause the
    // value (`./preload.js`) to be mistaken for the script path. The
    // walker must skip both the flag and the value, then continue
    // checking subsequent tokens for the daemon entry.
    it("flags exec(\"node --require ./register.js dist/daemon/index.js --port 0\") — separately-passed --require value is not the script", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { exec } from "child_process";

describe("exec node --require preload then daemon entry", () => {
  it("execs the daemon entry under node with a --require preload module", () => {
    const child = exec("node --require ./register.js dist/daemon/index.js --port 0");
    onTestFinished(() => process.kill(child.pid, "SIGTERM"));
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    it("flags execSync(\"node -r ./register.js dist/daemon/index.js --port 0\") — separately-passed -r value is not the script", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { execSync } from "child_process";

describe("execSync node -r preload then daemon entry", () => {
  it("execSyncs the daemon entry under node with a -r preload module", () => {
    const stdout = execSync("node -r ./register.js dist/daemon/index.js --port 0");
    expect(stdout).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    it("flags exec(\"node --conditions production dist/daemon/index.js\") — --conditions consumes its next token as a value", () => {
      // Coverage for the broader value-consuming-flag set: --conditions
      // (and -C) take a comma-separated condition string as a separate
      // next token. The walker must skip both before reading the script
      // path the same way it skips --require's value.
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { exec } from "child_process";

describe("exec node --conditions then daemon entry", () => {
  it("execs the daemon entry under node with a --conditions value", () => {
    const child = exec("node --conditions production dist/daemon/index.js");
    onTestFinished(() => process.kill(child.pid, "SIGTERM"));
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    it("flags exec(\"node --require ./preload.js --enable-source-maps dist/daemon/index.js\") — value-consuming and standalone flags interleaved", () => {
      // Mixed flag classes between the runtime and the script path: the
      // walker must skip the value-consuming flag's value AND the
      // standalone flag, then read the daemon entry from the next token.
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { exec } from "child_process";

describe("exec node mixed-flag classes then daemon entry", () => {
  it("execs the daemon entry under node with --require and --enable-source-maps", () => {
    const child = exec("node --require ./preload.js --enable-source-maps dist/daemon/index.js");
    onTestFinished(() => process.kill(child.pid, "SIGTERM"));
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    it("flags exec(\"node --require=./preload.js dist/daemon/index.js\") — bundled-equals --require is one flag-shaped token", () => {
      // The `--require=./preload.js` form is a single token that starts
      // with `-`, so the standalone-flag branch of the walk skips it
      // without needing to consume a separate value. The daemon entry is
      // then the next non-flag token and must be flagged.
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { exec } from "child_process";

describe("exec node --require=value then daemon entry", () => {
  it("execs the daemon entry under node with a bundled-equals --require", () => {
    const child = exec("node --require=./preload.js dist/daemon/index.js");
    onTestFinished(() => process.kill(child.pid, "SIGTERM"));
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    it("flags exec(`node --require ./preload.js dist/daemon/index.js --port ${port}`) template literal with a value-consuming runtime flag", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { exec } from "child_process";

describe("exec template literal with node --require flag", () => {
  it("execs the daemon entry under node with --require and an interpolated port", () => {
    const port = 0;
    const child = exec(\`node --require ./preload.js dist/daemon/index.js --port \${port}\`);
    onTestFinished(() => process.kill(child.pid, "SIGTERM"));
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    // Regression set covering the false-negative blocker from review cycle 11:
    // documented Node value-consuming options like `--import` (ESM preload)
    // and `--env-file` / `--env-file-if-exists` (env loader) accept their
    // value as a separately-passed next token. When the value-consuming set
    // omits them, the walker treats the value (`./setup.mjs`, `.env`) as
    // the script path and the real daemon entry that follows is silently
    // accepted. Verified with `node --import ./setup.mjs probe.js` and
    // `node --env-file .env probe.js` which both consume the next token
    // as the option's value before running the script.
    it("flags exec(\"node --import ./setup.mjs dist/daemon/index.js --port 0\") — --import consumes its next token as the ESM preload value", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { exec } from "child_process";

describe("exec node --import preload then daemon entry", () => {
  it("execs the daemon entry under node with an --import ESM preload module", () => {
    const child = exec("node --import ./setup.mjs dist/daemon/index.js --port 0");
    onTestFinished(() => process.kill(child.pid, "SIGTERM"));
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    it("flags execSync(\"node --env-file .env dist/daemon/index.js --port 0\") — --env-file consumes its next token as the env-file path", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { execSync } from "child_process";

describe("execSync node --env-file then daemon entry", () => {
  it("execSyncs the daemon entry under node with an --env-file path value", () => {
    const stdout = execSync("node --env-file .env dist/daemon/index.js --port 0");
    expect(stdout).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    it("flags exec(\"node --env-file-if-exists .env dist/daemon/index.js --port 0\") — --env-file-if-exists is a sibling value-consuming option of --env-file", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { exec } from "child_process";

describe("exec node --env-file-if-exists then daemon entry", () => {
  it("execs the daemon entry under node with an --env-file-if-exists path value", () => {
    const child = exec("node --env-file-if-exists .env dist/daemon/index.js --port 0");
    onTestFinished(() => process.kill(child.pid, "SIGTERM"));
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    it("flags spawn(\"node\", [\"--import\", \"./setup.mjs\", DAEMON_ENTRY, \"--port\", \"0\"]) — --import value in spawn argv-array form", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { spawn } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";

describe("spawn node --import preload then daemon entry argv", () => {
  it("spawns node with a separately-passed --import value and the daemon entry as the script", () => {
    const child = spawn("node", ["--import", "./setup.mjs", DAEMON_ENTRY, "--port", "0"]);
    onTestFinished(() => process.kill(child.pid, "SIGTERM"));
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    it("flags execFile(\"node\", [\"--env-file\", \".env\", \"dist/daemon/index.js\"]) — --env-file value in execFile argv-array form", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { execFile } from "child_process";

describe("execFile node --env-file then daemon entry argv", () => {
  it("execFiles node with a separately-passed --env-file value and the daemon entry literal as the script", () => {
    const child = execFile("node", ["--env-file", ".env", "dist/daemon/index.js"]);
    onTestFinished(() => process.kill(child.pid, "SIGTERM"));
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    it("flags execFileSync(\"node\", [\"--env-file-if-exists\", \".env\", DAEMON_ENTRY]) — --env-file-if-exists value in execFileSync argv-array form", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";

describe("execFileSync node --env-file-if-exists then daemon entry argv", () => {
  it("execFileSyncs node with a separately-passed --env-file-if-exists value and the daemon entry as the script", () => {
    const stdout = execFileSync("node", ["--env-file-if-exists", ".env", DAEMON_ENTRY]);
    expect(stdout).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    it("flags spawn(process.execPath, [\"--import\", \"./setup.mjs\", DAEMON_ENTRY]) — --import value with process.execPath runtime form", () => {
      // Combines the cycle 5 process.execPath fix with cycle 11's
      // --import value-consuming flag — every recognised runtime form
      // (bare `node`, path-suffixed `node`, `process.execPath`) must
      // skip the value-consuming flag's separately-passed value before
      // reading the daemon entry from the next token.
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { spawn } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";

describe("spawn process.execPath --import preload then daemon entry argv", () => {
  it("spawns process.execPath with a separately-passed --import value and the daemon entry as the script", () => {
    const child = spawn(process.execPath, ["--import", "./setup.mjs", DAEMON_ENTRY, "--port", "0"]);
    onTestFinished(() => process.kill(child.pid, "SIGTERM"));
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    // Regression set covering the false-negative blocker from review cycle 8:
    // standalone Node runtime flags that were previously mis-modelled as
    // value-consuming. When a standalone flag (e.g. `--use-openssl-ca`,
    // `--tls-min-v1.0`) is in the value-consuming set, the walker skips
    // both the flag AND the next token — and when that next token is the
    // daemon entry path, the real launch is silently accepted. The Node
    // CLI documents these as boolean flags that take no value, so they
    // must NOT consume the following token. Verified via `node --use-openssl-ca
    // probe.js` which prints `script-ran` (the script ran, the flag did not
    // consume the path).
    it("flags exec(\"node --use-openssl-ca dist/daemon/index.js --port 0\") — --use-openssl-ca is standalone, not value-consuming", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { exec } from "child_process";

describe("exec node --use-openssl-ca then daemon entry", () => {
  it("execs the daemon entry under node with the --use-openssl-ca standalone flag", () => {
    const child = exec("node --use-openssl-ca dist/daemon/index.js --port 0");
    onTestFinished(() => process.kill(child.pid, "SIGTERM"));
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    it("flags execSync(\"node --tls-min-v1.0 dist/daemon/index.js --port 0\") — --tls-min-v1.0 is standalone, not value-consuming", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { execSync } from "child_process";

describe("execSync node --tls-min-v1.0 then daemon entry", () => {
  it("execSyncs the daemon entry under node with the --tls-min-v1.0 standalone flag", () => {
    const stdout = execSync("node --tls-min-v1.0 dist/daemon/index.js --port 0");
    expect(stdout).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    it("flags exec(\"node --use-bundled-ca dist/daemon/index.js\") — --use-bundled-ca is standalone, not value-consuming", () => {
      // Sibling of --use-openssl-ca: another standalone CA-store selector
      // that previously could have been mis-modelled in the same way.
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { exec } from "child_process";

describe("exec node --use-bundled-ca then daemon entry", () => {
  it("execs the daemon entry under node with the --use-bundled-ca standalone flag", () => {
    const child = exec("node --use-bundled-ca dist/daemon/index.js");
    onTestFinished(() => process.kill(child.pid, "SIGTERM"));
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    it("flags exec(\"node --stack-trace-limit=50 dist/daemon/index.js\") — --stack-trace-limit only takes a value via the bundled =N form, not whitespace", () => {
      // --stack-trace-limit only accepts the bundled `=N` form; the bare
      // `node --stack-trace-limit 50 script.js` errors out with `bad
      // option: --stack-trace-limit`. So it MUST NOT be modelled as a
      // whitespace-value-consuming flag — that would skip the daemon
      // entry token after a bare appearance. The bundled form is one
      // token starting with `-` and is correctly handled by the
      // standalone-flag branch of the walker.
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { exec } from "child_process";

describe("exec node --stack-trace-limit=N then daemon entry", () => {
  it("execs the daemon entry under node with a bundled-equals --stack-trace-limit flag", () => {
    const child = exec("node --stack-trace-limit=50 dist/daemon/index.js");
    onTestFinished(() => process.kill(child.pid, "SIGTERM"));
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    // Regression set covering the cycle 9 template-literal blocker: the
    // daemon-entry detector was only recognising plain string literals
    // and the `DAEMON_ENTRY` identifier in spawn-like first-arg and
    // argv-element positions, so a no-substitution template literal that
    // resolves to the same daemon path was silently accepted. The
    // template-literal form resolves to the same string at runtime and
    // must classify the same way as the literal form.
    it("flags spawn(`dist/daemon/index.js`, [...]) when the daemon entry is a no-substitution template literal in args[0]", () => {
      const result = runOxlint({
        source: [
          "import { describe, it, expect, onTestFinished } from \"vitest\";",
          "import { spawn } from \"child_process\";",
          "",
          "describe(\"spawn template-literal daemon entry executable\", () => {",
          "  it(\"spawns the daemon entry as a template literal\", () => {",
          "    const child = spawn(`dist/daemon/index.js`, [\"--port\", \"0\"]);",
          "    onTestFinished(() => process.kill(child.pid, \"SIGTERM\"));",
          "    expect(child.pid).toBeDefined();",
          "  });",
          "});",
          "",
        ].join("\n"),
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    it("flags execFile(\"node\", [`dist/daemon/index.js`, ...]) when the daemon entry argv element is a no-substitution template literal", () => {
      const result = runOxlint({
        source: [
          "import { describe, it, expect, onTestFinished } from \"vitest\";",
          "import { execFile } from \"child_process\";",
          "",
          "describe(\"execFile node with template-literal daemon entry argv\", () => {",
          "  it(\"execFiles the daemon entrypoint as a template literal in argv\", () => {",
          "    const child = execFile(\"node\", [`dist/daemon/index.js`, \"--port\", \"0\"]);",
          "    onTestFinished(() => process.kill(child.pid, \"SIGTERM\"));",
          "    expect(child.pid).toBeDefined();",
          "  });",
          "});",
          "",
        ].join("\n"),
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    it("flags spawnSync(`/workspace/dist/daemon/index.js`, [...]) when the daemon entry is an absolute-path template literal in args[0]", () => {
      const result = runOxlint({
        source: [
          "import { describe, it, expect } from \"vitest\";",
          "import { spawnSync } from \"child_process\";",
          "",
          "describe(\"spawnSync absolute template-literal daemon entry\", () => {",
          "  it(\"spawnSyncs the absolute daemon entry path as a template literal\", () => {",
          "    const result = spawnSync(`/workspace/dist/daemon/index.js`, [\"--port\", \"0\"]);",
          "    expect(result.status).toBe(0);",
          "  });",
          "});",
          "",
        ].join("\n"),
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    // Regression set covering the cycle 9 quoted-shell-token blocker:
    // when `exec` / `execSync` shell strings carry the daemon entry
    // wrapped in single or double quotes, the shell strips the quotes
    // before executing — so the launch is identical to the bare form.
    // The classifier must normalise quoted tokens via the same rule.
    it("flags exec(\"'dist/daemon/index.js' --port 0\") — single-quoted daemon entry as the leading shell token", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { exec } from "child_process";

describe("exec single-quoted daemon entry shell string", () => {
  it("execs a single-quoted daemon entry as the leading token", () => {
    const child = exec("'dist/daemon/index.js' --port 0");
    onTestFinished(() => process.kill(child.pid, "SIGTERM"));
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    it("flags exec(\"node 'dist/daemon/index.js' --port 0\") — single-quoted daemon entry as the runtime-form script token", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { exec } from "child_process";

describe("exec node single-quoted daemon entry runtime form", () => {
  it("execs the single-quoted daemon entry under node", () => {
    const child = exec("node 'dist/daemon/index.js' --port 0");
    onTestFinished(() => process.kill(child.pid, "SIGTERM"));
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    it("flags execSync(\"\\\"node\\\" \\\"dist/daemon/index.js\\\" --port 0\") — double-quoted runtime AND daemon entry tokens", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { execSync } from "child_process";

describe("execSync double-quoted runtime and daemon entry shell string", () => {
  it("execSyncs the daemon entry under double-quoted node", () => {
    const stdout = execSync('"node" "dist/daemon/index.js" --port 0');
    expect(stdout).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    it("flags exec(\"node '/workspace/dist/daemon/index.js' --port 0\") — single-quoted absolute daemon entry path", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { exec } from "child_process";

describe("exec node single-quoted absolute daemon entry", () => {
  it("execs a quoted absolute daemon entry path under node", () => {
    const child = exec("node '/workspace/dist/daemon/index.js' --port 0");
    onTestFinished(() => process.kill(child.pid, "SIGTERM"));
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    // Regression set covering the cycle 9 spawn-like script-position
    // blocker (positives): the argv-array runtime walk must mirror the
    // exec/execSync shell-string walker — value-consuming flags skip
    // their separately-passed value, standalone flags skip one element,
    // and the first non-flag element must be the daemon entry. These
    // forms previously matched only because the classifier asked
    // "does the array contain DAEMON_ENTRY anywhere"; the precise walk
    // must keep flagging them.
    it("flags spawn(\"node\", [\"--require\", \"./pre.js\", DAEMON_ENTRY, \"--port\", \"0\"]) — value-consuming flag then daemon entry in argv", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { spawn } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";

describe("spawn node --require preload then daemon entry argv", () => {
  it("spawns node with a separately-passed --require value and the daemon entry as the script", () => {
    const child = spawn("node", ["--require", "./pre.js", DAEMON_ENTRY, "--port", "0"]);
    onTestFinished(() => process.kill(child.pid, "SIGTERM"));
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    it("flags execFile(\"node\", [\"-r\", \"./pre.js\", \"dist/daemon/index.js\"]) — short-form value-consuming flag then daemon entry literal", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { execFile } from "child_process";

describe("execFile node -r preload then daemon entry argv", () => {
  it("execFiles node with a separately-passed -r value and the daemon entry literal as the script", () => {
    const child = execFile("node", ["-r", "./pre.js", "dist/daemon/index.js"]);
    onTestFinished(() => process.kill(child.pid, "SIGTERM"));
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    it("flags spawn(\"node\", [\"--enable-source-maps\", \"--inspect\", DAEMON_ENTRY]) — multiple standalone flags then daemon entry", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { spawn } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";

describe("spawn node multiple standalone flags then daemon entry argv", () => {
  it("spawns node with two standalone flags before the daemon entry script", () => {
    const child = spawn("node", ["--enable-source-maps", "--inspect", DAEMON_ENTRY]);
    onTestFinished(() => process.kill(child.pid, "SIGTERM"));
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    it("flags execFileSync(\"node\", [\"--require=./pre.js\", DAEMON_ENTRY]) — bundled-equals --require is one standalone-flag-shaped element", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";

describe("execFileSync node --require=value then daemon entry argv", () => {
  it("execFileSyncs the daemon entry under node with a bundled-equals --require flag", () => {
    const stdout = execFileSync("node", ["--require=./pre.js", DAEMON_ENTRY]);
    expect(stdout).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    it("flags spawn(process.execPath, [\"--require\", \"./pre.js\", DAEMON_ENTRY]) — process.execPath runtime with value-consuming flag then daemon entry", () => {
      // Combines the cycle 5 process.execPath fix with the cycle 9
      // script-position walk — the latter must apply uniformly across
      // every recognised runtime form, including the MemberExpression
      // shape.
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { spawn } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";

describe("spawn process.execPath --require preload then daemon entry argv", () => {
  it("spawns process.execPath with a separately-passed --require value and the daemon entry as the script", () => {
    const child = spawn(process.execPath, ["--require", "./pre.js", DAEMON_ENTRY, "--port", "0"]);
    onTestFinished(() => process.kill(child.pid, "SIGTERM"));
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });
  });

  // AC: @daemon-test-guardrail-precision ac-unrelated-subprocesses-not-reported
  describe("non-kspec subprocesses are not reported as daemon lifecycle violations", () => {
    it("does not flag spawn(\"echo\", [\"serve\", \"start\", \"--detach\"]) — argv tokens overlap but executable is unrelated", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { spawn } from "child_process";

describe("non-kspec subprocess with overlapping argv tokens", () => {
  it("runs echo with daemon-lifecycle words", () => {
    const child = spawn("echo", ["serve", "start", "--detach"]);
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("does not flag spawnSync(\"git\", [\"log\", \"serve\", \"start\", \"--detach\"]) — git is not a kspec lifecycle command", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";

describe("git subprocess with overlapping argv tokens", () => {
  it("runs git log with daemon-lifecycle words", () => {
    const result = spawnSync("git", ["log", "serve", "start", "--detach"]);
    expect(result.status).toBe(0);
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-unrelated-subprocesses-not-reported
    //
    // Cycle-12 blocker: the prior classifier was a substring scan, so a
    // non-daemon kspec subcommand whose ARGUMENT VALUE happened to spell
    // "serve start --detach" was misreported as a daemon lifecycle launch.
    // The shell tokeniser keeps the inner-quoted "serve start --detach" as
    // a single argv slot — kspec receives `argv[2] = "serve start --detach"`
    // as the second positional under the `search` subcommand, never the
    // `serve start` lifecycle path. The fixed classifier requires the FIRST
    // TWO non-flag positionals after `kspec` to be exactly `serve` then
    // `start`, so this case must NOT be reported.
    it("does not flag exec(\"kspec search 'serve start --detach'\") — kspec subcommand is search, not serve start (cycle-12 blocker)", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { exec } from "child_process";

describe("kspec non-daemon subcommand whose argument quotes the lifecycle string", () => {
  it("execs kspec search with a quoted argument that mentions serve start --detach", () => {
    exec("kspec search \\"serve start --detach\\"");
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-unrelated-subprocesses-not-reported
    //
    // Cycle-12 blocker (argv form): each spawn argv element is one OS argv
    // slot — the runtime does NOT re-split on whitespace, so the literal
    // element "serve start --detach" is a single positional that kspec
    // search receives as `argv[2]`. The fixed argv-array walker treats it
    // as one positional after `search`; the subcommand is `search`, not
    // `serve start`, so it must NOT be reported.
    it("does not flag spawn(\"kspec\", [\"search\", \"serve start --detach\"]) — kspec subcommand is search (cycle-12 blocker)", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { spawn } from "child_process";

describe("kspec non-daemon argv whose later element spells the lifecycle string", () => {
  it("spawns kspec search with a single-element argument that mentions serve start --detach", () => {
    const child = spawn("kspec", ["search", "serve start --detach"]);
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-unrelated-subprocesses-not-reported
    //
    // Variant covering the runKspec helper shape: the helper forwards a
    // shell-style space-separated args string to the kspec CLI through a
    // shell, so quoted multi-word tokens stay one positional. A non-daemon
    // kspec subcommand passed via the helper must not be reported even
    // when the quoted argument mentions the lifecycle words.
    it("does not flag runKspec(\"search 'serve start --detach'\") — kspec subcommand is search (cycle-12 variant)", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";

describe("runKspec helper with a non-daemon subcommand", () => {
  it("runs kspec search via the helper with a quoted argument", () => {
    runKspec("search \\"serve start --detach\\"");
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-unrelated-subprocesses-not-reported
    //
    // Variant covering execFile (and by extension execFileSync) — the
    // executable arg must be `kspec` for the lifecycle check to engage,
    // and even then the argv array is walked element-by-element with the
    // first two non-flag positionals required to be `serve` then `start`.
    it("does not flag execFile(\"kspec\", [\"search\", \"serve start --detach\"]) — kspec subcommand is search", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { execFile } from "child_process";

describe("execFile kspec non-daemon subcommand", () => {
  it("execs kspec search via execFile", () => {
    execFile("kspec", ["search", "serve start --detach"], () => {});
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-unrelated-subprocesses-not-reported
    //
    // The classifier must also remain robust when the lifecycle string is
    // genuinely a prose value (e.g. an inbox capture body or a search
    // pattern). The kspec subcommand `inbox add` consumes the next
    // positional as the inbox text; that text mentioning "serve start
    // --detach" is content, not a lifecycle launch.
    it("does not flag spawn(\"kspec\", [\"inbox\", \"add\", \"serve start --detach repro\"]) — subcommand is inbox add", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { spawn } from "child_process";

describe("kspec inbox add with lifecycle words in the body", () => {
  it("spawns kspec inbox add with a free-form text argument", () => {
    const child = spawn("kspec", ["inbox", "add", "serve start --detach repro"]);
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("does not flag exec(\"echo --port 3456\") — no daemon entry, no kspec lifecycle command", () => {
      // Regression: a shell string with overlapping tokens but no daemon
      // entry path and no leading kspec executable must not be reported.
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { exec } from "child_process";

describe("non-daemon shell string", () => {
  it("execs an unrelated shell command", () => {
    exec("echo --port 3456");
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-unrelated-subprocesses-not-reported
    //
    // Regression set covering the precision blocker from review cycle 3:
    // an unrelated shell command must not be reported just because one of
    // its argument tokens happens to end in `dist/daemon/index.js`. The
    // daemon-entry token is only a daemon launch when it sits in an
    // executable position — either as the first shell token (direct
    // executable) or as the immediate next token after a recognised JS
    // runtime (`node` / `bun`).
    it("does not flag exec(\"echo dist/daemon/index.js\") — daemon path is an argument to echo, not a launch", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { exec } from "child_process";

describe("echo with daemon path argument", () => {
  it("execs echo with the daemon path as an argument", () => {
    exec("echo dist/daemon/index.js");
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("does not flag execSync(\"cat /workspace/dist/daemon/index.js\") — cat reads the file, does not launch the daemon", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { execSync } from "child_process";

describe("cat with absolute daemon path argument", () => {
  it("execs cat to read the daemon file", () => {
    const contents = execSync("cat /workspace/dist/daemon/index.js");
    expect(contents).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("does not flag exec(\"grep -r dist/daemon/index.js src/\") — grep searches for the path string, does not launch the daemon", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { exec } from "child_process";

describe("grep referencing daemon path", () => {
  it("execs grep to find references to the daemon path", () => {
    exec("grep -r dist/daemon/index.js src/");
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("does not flag exec(`echo ${someFlag} dist/daemon/index.js`) template literal — daemon path is not in the executable position", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { exec } from "child_process";

describe("template literal with daemon path argument", () => {
  it("execs an unrelated shell command interpolating the daemon path", () => {
    const someFlag = "--quiet";
    exec(\`echo \${someFlag} dist/daemon/index.js\`);
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("does not flag execSync(\"nodemon dist/daemon/index.js\") — nodemon is not the recognised node runtime token", () => {
      // Substring-of-runtime guard: a shell command whose first token
      // contains `node` as a substring (e.g. `nodemon`) is NOT recognised
      // as the JS runtime. Without this guard, `nodemon dist/daemon/index.js`
      // would be reported. The runtime form requires an exact match on
      // `node`/`bun` or a path with that final segment.
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { execSync } from "child_process";

describe("nodemon should not be confused with node runtime", () => {
  it("execSyncs nodemon with the daemon path", () => {
    execSync("nodemon dist/daemon/index.js --watch src");
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-unrelated-subprocesses-not-reported
    //
    // Precision regression for the runtime-flag walk added in cycle 7:
    // walking past flag-shaped tokens between the runtime and the script
    // path must not over-broaden the rule. When the first non-flag token
    // after `node` is some other path (a different script, an unrelated
    // file argument), `node` is launching that path — not the daemon —
    // and the call must not be reported even though the daemon entry
    // appears later in the command line as data.
    it("does not flag exec(\"node ./other-script.js dist/daemon/index.js\") — node launches other-script.js, daemon path is consumed as argv", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { exec } from "child_process";

describe("node launches a different script with daemon path as argv", () => {
  it("execs node running other-script.js with the daemon path forwarded as an argv token", () => {
    exec("node ./other-script.js dist/daemon/index.js");
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("does not flag exec(\"node --inspect echo dist/daemon/index.js\") — first non-flag token after node is echo, not the daemon entry", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { exec } from "child_process";

describe("node --inspect launching echo with daemon path argv", () => {
  it("execs node --inspect echo with the daemon path as an echo argument", () => {
    exec("node --inspect echo dist/daemon/index.js");
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("does not flag exec(\"node --version\") — flag-only command line with no script path token", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { exec } from "child_process";

describe("node --version with no script path", () => {
  it("execs node --version", () => {
    exec("node --version");
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-unrelated-subprocesses-not-reported
    //
    // Regression set covering the false-positive half of the review cycle
    // 7 blocker: Node/Bun eval-mode flags (`-e`, `--eval`, `-p`, `--print`
    // and the bundled `--eval=...` / `--print=...` forms) put the runtime
    // into eval mode. The runtime evaluates a JavaScript source string
    // instead of executing a script file, so any `dist/daemon/index.js`
    // token after them is either the eval source string or an argument
    // forwarded to the eval'd code via process.argv — never a script the
    // runtime is launching. The walker must abort and report no daemon
    // launch.
    it("does not flag exec(\"node --eval dist/daemon/index.js\") — --eval evaluates the next token as source, not as a script path", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { exec } from "child_process";

describe("node --eval with daemon path as eval source", () => {
  it("execs node evaluating the daemon path as a JavaScript expression", () => {
    exec("node --eval dist/daemon/index.js");
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("does not flag execSync(\"node -e dist/daemon/index.js\") — -e evaluates the next token as source", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { execSync } from "child_process";

describe("node -e with daemon path as eval source", () => {
  it("execSyncs node evaluating the daemon path as a JavaScript expression", () => {
    execSync("node -e dist/daemon/index.js");
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("does not flag exec(\"node --print dist/daemon/index.js\") — --print evaluates and prints, no script is executed", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { exec } from "child_process";

describe("node --print with daemon path as eval source", () => {
  it("execs node printing the eval result of the daemon path expression", () => {
    exec("node --print dist/daemon/index.js");
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("does not flag execSync(\"node -p dist/daemon/index.js\") — -p evaluates and prints", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { execSync } from "child_process";

describe("node -p with daemon path as eval source", () => {
  it("execSyncs node printing the eval result of the daemon path expression", () => {
    execSync("node -p dist/daemon/index.js");
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("does not flag exec(\"node --eval=console.log(1) dist/daemon/index.js\") — bundled --eval=CODE puts runtime in eval mode", () => {
      // The `--eval=CODE` form is a single token. Without recognising it
      // as eval mode, the standalone-flag branch would skip it and the
      // walker would report `dist/daemon/index.js` as the script — a
      // false positive. Recognising the prefix `--eval=` aborts the walk
      // the same way the bare `--eval` form does.
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { exec } from "child_process";

describe("node --eval=CODE with daemon path as forwarded argv", () => {
  it("execs node evaluating inline source with the daemon path as an argv token", () => {
    exec("node --eval=console.log(1) dist/daemon/index.js");
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    // Negative regressions for the value-consuming-flag walk: when the
    // daemon path is the value of a value-consuming flag (e.g.
    // `--require dist/daemon/index.js`) and not in script-path position,
    // the runtime is preloading it as a module, not executing it as the
    // main entrypoint. The walker correctly skips both the flag and its
    // value, leaves no script-path-position token holding the daemon
    // entry, and the call must not be reported.
    it("does not flag exec(\"node --require dist/daemon/index.js other-script.js\") — daemon path is the --require preload value, not the script", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { exec } from "child_process";

describe("node --require with daemon path as preload value", () => {
  it("execs node preloading the daemon module before running other-script.js", () => {
    exec("node --require dist/daemon/index.js other-script.js");
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("does not flag execSync(\"node -r dist/daemon/index.js\") — daemon path is the -r preload value with no following script", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { execSync } from "child_process";

describe("node -r with daemon path as preload value, no script", () => {
  it("execSyncs node with the daemon path as a -r preload value", () => {
    execSync("node -r dist/daemon/index.js");
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-direct-daemon-entry-invocations-flagged
    //
    // Regression set covering the false-negative blocker from review
    // cycle 10: the previous shell tokeniser used a plain whitespace
    // split, which broke when a value-consuming flag's value was a
    // single-quoted or double-quoted string containing whitespace.
    // The reviewer's failing probe was:
    //
    //     exec("node --require './pre load.js' dist/daemon/index.js --port 0")
    //
    // Plain whitespace split yielded
    //   ["node", "--require", "'./pre", "load.js'", "dist/daemon/index.js",
    //    "--port", "0"]
    // so `--require` consumed only `'./pre` as its value and `load.js'`
    // landed in the script position before the real daemon entry — the
    // launch was silently accepted. The quote-aware tokeniser keeps the
    // whole quoted value as one token (`'./pre load.js'` →
    // `./pre load.js` after stripShellQuotes), so the walker advances
    // past the value-consuming flag correctly and identifies
    // `dist/daemon/index.js` as the script position.
    it("flags exec(\"node --require './pre load.js' dist/daemon/index.js --port 0\") — single-quoted preload value with internal whitespace", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { exec } from "child_process";

describe("exec node --require single-quoted preload then daemon entry", () => {
  it("execs the daemon entry under node with a single-quoted preload value containing whitespace", () => {
    const child = exec("node --require './pre load.js' dist/daemon/index.js --port 0");
    onTestFinished(() => process.kill(child.pid, "SIGTERM"));
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    it("flags exec(\"node --require \\\"./pre load.js\\\" dist/daemon/index.js --port 0\") — double-quoted preload value with internal whitespace", () => {
      // Same false-negative shape as the single-quoted variant above,
      // but using double quotes to verify the quote-aware tokeniser
      // handles `"..."` pairs identically to `'...'`.
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { exec } from "child_process";

describe("exec node --require double-quoted preload then daemon entry", () => {
  it("execs the daemon entry under node with a double-quoted preload value containing whitespace", () => {
    const child = exec('node --require "./pre load.js" dist/daemon/index.js --port 0');
    onTestFinished(() => process.kill(child.pid, "SIGTERM"));
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    it("flags execSync(`node --require '${preload}' dist/daemon/index.js`) template literal — quoted interpolated preload value", () => {
      // Template-literal variant: the placeholder sentinel
      // `\${...}` lives inside the single quotes, so the quote-aware
      // tokeniser keeps the whole `'\${...}'` as one token and the
      // value-consuming flag walker correctly skips it before reading
      // the daemon entry.
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { execSync } from "child_process";

describe("execSync template literal with quoted interpolated preload value", () => {
  it("execSyncs the daemon entry under node with a quoted interpolated preload value", () => {
    const preload = "./pre load.js";
    execSync(\`node --require '\${preload}' dist/daemon/index.js\`);
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    // AC: @daemon-test-guardrail-precision ac-unrelated-subprocesses-not-reported
    //
    // Regression set covering the false-positive blocker from review
    // cycle 10: Node's parse-only flags (`--check`, `-c`, and the
    // `--syntax-check` alias) cause the runtime to syntax-check the
    // script and exit without ever executing it. The daemon never
    // starts, so reporting `node --check dist/daemon/index.js` as a
    // direct daemon launch is a false positive that violates
    // ac-unrelated-subprocesses-not-reported. The walker must abort at
    // the parse-only flag and report no launch.
    //
    // The short form `-c` is gated on `runtime === "node"` because Bun
    // treats `-c` as `--config <path>` (value-consuming). The `bun -c`
    // case is covered by the positive regression below to verify the
    // short-flag classification flips per runtime.
    it("does not flag execSync(\"node --check dist/daemon/index.js\") — --check parses the script but never executes it", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { execSync } from "child_process";

describe("node --check syntax-checks the daemon path without running it", () => {
  it("execSyncs node --check on the daemon entry path", () => {
    execSync("node --check dist/daemon/index.js");
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("does not flag exec(\"node -c dist/daemon/index.js\") — -c is the Node short form of --check (parse-only)", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { exec } from "child_process";

describe("node -c (short for --check) syntax-checks the daemon path", () => {
  it("execs node -c on the daemon entry path", () => {
    exec("node -c dist/daemon/index.js");
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("does not flag execSync(\"node --syntax-check dist/daemon/index.js\") — --syntax-check is the legacy parse-only alias", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { execSync } from "child_process";

describe("node --syntax-check parses the daemon path without running it", () => {
  it("execSyncs node --syntax-check on the daemon entry path", () => {
    execSync("node --syntax-check dist/daemon/index.js");
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("does not flag execFile(\"node\", [\"--check\", DAEMON_ENTRY]) — argv-array form of --check parses but does not execute", () => {
      // Mirrors the spawn-like argv-array branch: the script-position
      // walk receives the runtime tag from args[0] and recognises
      // `--check` as a parse-only no-script flag the same way the
      // shell-string walker does.
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { execFile } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";

describe("execFile node --check argv-array form", () => {
  it("execFiles node --check on the daemon entry path", () => {
    execFile("node", ["--check", DAEMON_ENTRY]);
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("does not flag spawn(process.execPath, [\"-c\", DAEMON_ENTRY]) — process.execPath is Node, so -c is parse-only", () => {
      // The runtime tag derived from `process.execPath` must classify
      // as Node so the runtime-ambiguous `-c` is recognised as
      // parse-only and the call is not reported as a daemon launch.
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { spawn } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";

describe("spawn process.execPath -c argv-array form", () => {
  it("spawns the current Node interpreter to syntax-check the daemon path", () => {
    spawn(process.execPath, ["-c", DAEMON_ENTRY]);
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("flags exec(\"bun -c bunfig.toml dist/daemon/index.js\") — Bun's -c is value-consuming (--config), not parse-only", () => {
      // Runtime-disambiguation regression: `-c` means different things
      // to Node and Bun. Node treats `-c` as `--check` (parse-only),
      // but Bun treats it as `-c, --config <path>` (value-consuming,
      // takes a bunfig.toml path). Treating Bun's `-c` as no-script
      // would silently accept this real daemon launch. The walker must
      // gate the short-flag classification on the leading runtime
      // token and, for Bun, fall through to the standalone-flag /
      // value-consuming-flag classes so the daemon entry token after
      // the config path is reported.
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { exec } from "child_process";

describe("exec bun -c (--config) then daemon entry", () => {
  it("execs the daemon entry under bun with a -c config flag", () => {
    const child = exec("bun -c bunfig.toml dist/daemon/index.js");
    onTestFinished(() => process.kill(child.pid, "SIGTERM"));
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      // Bun's `-c` is value-consuming, so the walker skips both the
      // flag and the next token (`bunfig.toml`), then reads
      // `dist/daemon/index.js` from the script position. The launch
      // must be reported as a daemon-runtime-parity violation
      // (hardcoded bun) — i.e. the rule fires either via the daemon
      // entry detection or the runtime parity message; the call is
      // not silently accepted.
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-unrelated-subprocesses-not-reported
    //
    // Regression set covering the precision blocker from review cycle 4:
    // a spawn-like (`spawn` / `spawnSync` / `execFile` / `execFileSync`)
    // call whose argv array contains the daemon entry path as a data
    // argument — but whose executable (args[0]) is not a recognised JS
    // runtime — must not be reported as a daemon launch. The runtime
    // form is only valid when args[0] is `node` or `bun` (bare or
    // path-suffixed); anything else (e.g. `cat`, `grep`, `docker`) is an
    // unrelated subprocess that consumes the path as data.
    it("does not flag spawn(\"cat\", [DAEMON_ENTRY]) — cat reads the daemon file, does not launch the daemon", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { spawn } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";

describe("cat with daemon path argv", () => {
  it("spawns cat to print the daemon file", () => {
    const child = spawn("cat", [DAEMON_ENTRY]);
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("does not flag execFile(\"grep\", [\"dist/daemon/index.js\", \"src/\"]) — grep searches for the path string, does not launch the daemon", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { execFile } from "child_process";

describe("grep with daemon path argv", () => {
  it("execFiles grep to find references to the daemon path", () => {
    execFile("grep", ["dist/daemon/index.js", "src/"]);
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("does not flag spawnSync(\"nodemon\", [DAEMON_ENTRY, \"--watch\", \"src\"]) — nodemon is not the recognised node runtime executable", () => {
      // Substring-of-runtime guard for the spawn-like form: an executable
      // whose name contains `node` as a substring (e.g. `nodemon`) is NOT
      // recognised as the node runtime. The argv form requires an exact
      // match on `node`/`bun` or a path with that final segment.
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";

describe("nodemon should not be confused with node runtime in argv form", () => {
  it("spawnSyncs nodemon with the daemon path as argv", () => {
    spawnSync("nodemon", [DAEMON_ENTRY, "--watch", "src"]);
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("does not flag execFileSync(\"docker\", [\"run\", \"image\", \"dist/daemon/index.js\"]) — docker is not a JS runtime", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";

describe("docker run with daemon path argv", () => {
  it("execFileSyncs docker with the daemon path as a positional arg", () => {
    execFileSync("docker", ["run", "image", "dist/daemon/index.js"]);
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("flags execFile(\"/usr/bin/node\", [DAEMON_ENTRY, ...]) — path-suffixed runtime is recognised", () => {
      // Positive precision regression: the runtime gate must still match
      // path-suffixed runtimes (`/usr/bin/node`, `./node_modules/.bin/bun`)
      // — only substring confusables (`nodemon`, `bunyan`) are excluded.
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { execFile } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";

describe("execFile path-suffixed node runtime", () => {
  it("execFiles /usr/bin/node with the daemon entry as argv", () => {
    const child = execFile("/usr/bin/node", [DAEMON_ENTRY, "--port", "0"]);
    onTestFinished(() => process.kill(child.pid, "SIGTERM"));
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    // AC: @daemon-test-guardrail-precision ac-direct-daemon-entry-invocations-flagged
    //
    // Regression set covering the precision blocker from review cycle 5:
    // `process.execPath` is the absolute path to the currently-running
    // Node interpreter, so `spawn(process.execPath, [DAEMON_ENTRY, ...])`
    // launches the compiled daemon entry just as `spawn("node",
    // [DAEMON_ENTRY, ...])` does. The runtime gate must recognise this
    // MemberExpression form so direct daemon launches via the current
    // Node runtime are not silently accepted.
    it("flags spawn(process.execPath, [DAEMON_ENTRY, ...]) — process.execPath is the current Node runtime", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { spawn } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";

describe("spawn process.execPath with daemon entry argv", () => {
  it("spawns the current Node interpreter with the daemon entry as argv", () => {
    const child = spawn(process.execPath, [DAEMON_ENTRY, "--port", "0"]);
    onTestFinished(() => process.kill(child.pid, "SIGTERM"));
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    it("flags execFile(process.execPath, [\"dist/daemon/index.js\", ...]) — process.execPath with literal daemon path argv", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { execFile } from "child_process";

describe("execFile process.execPath with literal daemon entry argv", () => {
  it("execFiles the current Node interpreter with the literal daemon entry path", () => {
    const child = execFile(process.execPath, ["dist/daemon/index.js", "--port", "0"]);
    onTestFinished(() => process.kill(child.pid, "SIGTERM"));
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    it("flags spawnSync(process.execPath, [DAEMON_ENTRY, ...]) — process.execPath in the synchronous spawn variant", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";

describe("spawnSync process.execPath with daemon entry argv", () => {
  it("spawnSyncs the current Node interpreter with the daemon entry as argv", () => {
    const result = spawnSync(process.execPath, [DAEMON_ENTRY, "--port", "0"]);
    expect(result.status).toBe(0);
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    it("flags execFileSync(process.execPath, [DAEMON_ENTRY, ...]) — process.execPath in the synchronous execFile variant", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";

describe("execFileSync process.execPath with daemon entry argv", () => {
  it("execFileSyncs the current Node interpreter with the daemon entry as argv", () => {
    execFileSync(process.execPath, [DAEMON_ENTRY, "--port", "0"]);
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    // AC: @daemon-test-guardrail-precision ac-unrelated-subprocesses-not-reported
    //
    // Negative precision regressions for the process.execPath recognition:
    // only the exact `process.execPath` MemberExpression is recognised —
    // unrelated objects that share the property name (`other.execPath`)
    // and `process` accesses to other properties (`process.argv0`,
    // `process.cwd`) must NOT be confused with a Node runtime expression.
    // Without these guards, the recognition would over-broaden and start
    // reporting unrelated subprocesses as daemon launches.
    it("does not flag spawn(other.execPath, [DAEMON_ENTRY]) — only process.execPath is recognised, not arbitrary .execPath properties", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { spawn } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";
const customRuntime = { execPath: "/custom/runtime" };

describe("spawn other-object.execPath with daemon entry argv", () => {
  it("spawns a custom-object .execPath with the daemon path as argv", () => {
    const child = spawn(customRuntime.execPath, [DAEMON_ENTRY]);
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("does not flag spawn(process.argv0, [DAEMON_ENTRY]) — only process.execPath is recognised, not other process properties", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { spawn } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";

describe("spawn process.argv0 with daemon entry argv", () => {
  it("spawns process.argv0 with the daemon path as argv", () => {
    const child = spawn(process.argv0, [DAEMON_ENTRY]);
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-direct-daemon-entry-invocations-flagged
    //
    // Regression set covering the precision blocker from review cycle 6:
    // `process["execPath"]` and `process[\`execPath\`]` resolve to the
    // same property as `process.execPath` at runtime — both are the
    // absolute path to the currently-running Node interpreter — so the
    // computed-access form launches the daemon just like the dot-access
    // form. The rule must classify static-string bracket access the same
    // as dot access while still rejecting dynamic property expressions
    // that cannot be statically resolved to "execPath".
    it("flags spawn(process[\"execPath\"], [DAEMON_ENTRY, ...]) — static-string computed access resolves to process.execPath", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { spawn } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";

describe("spawn process[\\"execPath\\"] with daemon entry argv", () => {
  it("spawns the current Node interpreter via process[\\"execPath\\"] with the daemon entry as argv", () => {
    const child = spawn(process["execPath"], [DAEMON_ENTRY, "--port", "0"]);
    onTestFinished(() => process.kill(child.pid, "SIGTERM"));
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    it("flags execFile(process[\"execPath\"], [\"dist/daemon/index.js\", ...]) — static-string computed access in the execFile variant", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { execFile } from "child_process";

describe("execFile process[\\"execPath\\"] with literal daemon entry argv", () => {
  it("execFiles the current Node interpreter via process[\\"execPath\\"] with the literal daemon entry path", () => {
    const child = execFile(process["execPath"], ["dist/daemon/index.js", "--port", "0"]);
    onTestFinished(() => process.kill(child.pid, "SIGTERM"));
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    it("flags spawnSync(process[`execPath`], [DAEMON_ENTRY, ...]) — no-substitution template literal computed access", () => {
      // A no-substitution template literal (`process[\`execPath\`]`) is
      // statically resolvable to the same property as dot access. The
      // rule treats it the same as the string-literal computed form.
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";

describe("spawnSync process[\\\`execPath\\\`] with daemon entry argv", () => {
  it("spawnSyncs the current Node interpreter via a no-substitution template-literal property", () => {
    const result = spawnSync(process[\`execPath\`], [DAEMON_ENTRY, "--port", "0"]);
    expect(result.status).toBe(0);
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
    });

    // AC: @daemon-test-guardrail-precision ac-unrelated-subprocesses-not-reported
    //
    // Negative precision regressions for the new computed-access support.
    // The recognition is restricted to static "execPath" property values;
    // dynamic property expressions, other static property names, and
    // computed access on unrelated objects must NOT be confused with
    // process.execPath.
    it("does not flag spawn(process[propName], [DAEMON_ENTRY]) — dynamic property expression is not statically resolvable to execPath", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { spawn } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";

describe("spawn process[propName] with daemon entry argv", () => {
  it("spawns process[propName] with the daemon path as argv", () => {
    const propName = "execPath";
    const child = spawn(process[propName], [DAEMON_ENTRY]);
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("does not flag spawn(process[\"argv0\"], [DAEMON_ENTRY]) — computed access to a non-execPath property", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { spawn } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";

describe("spawn process[\\"argv0\\"] with daemon entry argv", () => {
  it("spawns process[\\"argv0\\"] with the daemon path as argv", () => {
    const child = spawn(process["argv0"], [DAEMON_ENTRY]);
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("does not flag spawn(other[\"execPath\"], [DAEMON_ENTRY]) — computed access on an unrelated object", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { spawn } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";
const customRuntime = { execPath: "/custom/runtime" };

describe("spawn other-object[\\"execPath\\"] with daemon entry argv", () => {
  it("spawns a custom-object computed execPath with the daemon path as argv", () => {
    const child = spawn(customRuntime["execPath"], [DAEMON_ENTRY]);
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    // Regression set covering the cycle 9 spawn-like script-position
    // blocker (negatives): the argv-array runtime walk must abort when
    // a no-script flag (eval / version / help) appears before the
    // daemon-entry-shaped element. Without the walk, these runtime
    // invocations were silently mis-reported as direct daemon launches
    // even though the runtime never executes the daemon entry — `--eval`
    // evaluates the next element as JS source, `--version`/`-v` prints
    // the runtime version and exits, and `--help`/`-h` prints help and
    // exits. The reviewer's probes were
    // `spawn("node", ["--eval", "dist/daemon/index.js"])` and
    // `execFile("node", ["--version", DAEMON_ENTRY])`.
    it("does not flag spawn(\"node\", [\"--eval\", \"dist/daemon/index.js\"]) — --eval consumes the next argv element as source, no script is launched", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { spawn } from "child_process";

describe("spawn node --eval with daemon path as eval source argv", () => {
  it("spawns node with --eval and the daemon path as the eval source", () => {
    const child = spawn("node", ["--eval", "dist/daemon/index.js"]);
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("does not flag execFile(\"node\", [\"--version\", DAEMON_ENTRY]) — --version prints version and exits without executing any script", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { execFile } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";

describe("execFile node --version with daemon entry argv", () => {
  it("execFiles node with --version and the daemon path forwarded as argv", () => {
    execFile("node", ["--version", DAEMON_ENTRY], (_err, stdout) => {
      expect(stdout).toBeDefined();
    });
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("does not flag spawnSync(\"node\", [\"-v\", DAEMON_ENTRY]) — short-form -v also exits without executing any script", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";

describe("spawnSync node -v with daemon entry argv", () => {
  it("spawnSyncs node with -v and the daemon path forwarded as argv", () => {
    const result = spawnSync("node", ["-v", DAEMON_ENTRY]);
    expect(result.status).toBe(0);
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("does not flag execFileSync(\"node\", [\"--help\", \"dist/daemon/index.js\"]) — --help prints help and exits without executing any script", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";

describe("execFileSync node --help with daemon entry argv", () => {
  it("execFileSyncs node with --help and the daemon path forwarded as argv", () => {
    const stdout = execFileSync("node", ["--help", "dist/daemon/index.js"]);
    expect(stdout).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("does not flag spawn(\"node\", [\"-h\", DAEMON_ENTRY]) — short-form -h also exits without executing any script", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { spawn } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";

describe("spawn node -h with daemon entry argv", () => {
  it("spawns node with -h and the daemon path forwarded as argv", () => {
    const child = spawn("node", ["-h", DAEMON_ENTRY]);
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("does not flag spawn(\"node\", [\"--print\", DAEMON_ENTRY]) — --print evaluates inline source, no script is launched", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { spawn } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";

describe("spawn node --print with daemon path as eval source argv", () => {
  it("spawns node with --print and the daemon path as the eval source", () => {
    const child = spawn("node", ["--print", DAEMON_ENTRY]);
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("does not flag spawn(\"node\", [\"--require\", DAEMON_ENTRY, \"./other.js\"]) — daemon path is the --require value, not the script", () => {
      // The argv-array script-position walk must consume the daemon
      // path as the value of --require, then continue to find the
      // actual script (./other.js) in the script position. Without the
      // value-consuming step the walk would either stop at the daemon
      // path (false positive) or skip it as a flag.
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { spawn } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";

describe("spawn node --require with daemon path as preload value argv", () => {
  it("spawns node with the daemon path as the --require preload value before another script", () => {
    const child = spawn("node", ["--require", DAEMON_ENTRY, "./other.js"]);
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("does not flag spawn(\"node\", [\"./other-script.js\", DAEMON_ENTRY]) — node runs other-script.js, daemon path is forwarded argv", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { spawn } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";

describe("spawn node launches another script with daemon path argv", () => {
  it("spawns node with another script and the daemon path forwarded as argv", () => {
    const child = spawn("node", ["./other-script.js", DAEMON_ENTRY]);
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("does not flag spawn(\"node\", [\"--inspect\", \"./other-script.js\", DAEMON_ENTRY]) — first non-flag argv is other-script.js, not the daemon entry", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { spawn } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";

describe("spawn node --inspect launching other-script with daemon path argv", () => {
  it("spawns node with --inspect, another script, and the daemon path as argv", () => {
    const child = spawn("node", ["--inspect", "./other-script.js", DAEMON_ENTRY]);
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    // Sibling regressions for the shell-string walker — the same
    // `isShellRuntimeNoScriptFlag` predicate now applies to both walkers,
    // so `node --version dist/daemon/index.js` and `node --help …` must
    // also abort the shell-string walk and report no daemon launch.
    it("does not flag exec(\"node --version dist/daemon/index.js\") — shell-string walker also recognises --version as no-script", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { exec } from "child_process";

describe("exec node --version with daemon path as forwarded argv", () => {
  it("execs node with --version followed by the daemon path", () => {
    exec("node --version dist/daemon/index.js");
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("does not flag execSync(\"node --help dist/daemon/index.js\") — shell-string walker also recognises --help as no-script", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { execSync } from "child_process";

describe("execSync node --help with daemon path as forwarded argv", () => {
  it("execSyncs node with --help followed by the daemon path", () => {
    const stdout = execSync("node --help dist/daemon/index.js");
    expect(stdout).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });
  });

  // Regression: exec/execSync of `kspec serve start --detach` must remain
  // classified as a detached-serve violation (cleanup escape hatch
  // available), not as a direct daemon entry invocation. The new
  // exec/execSync direct-entry detector must not steal calls that don't
  // carry the daemon entry path token.
  describe("exec/execSync of kspec lifecycle stays classified as detached-serve", () => {
    it("flags exec(\"kspec serve start --detach\") with the missing-cleanup message, not the direct-spawn message", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { exec } from "child_process";

describe("exec kspec serve start --detach", () => {
  it("starts the daemon detached via exec", () => {
    exec("kspec serve start --detach --port 3456");
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/scoped cleanup|onTestFinished/i);
      // The direct-spawn message is reserved for daemon-entry invocations.
      expect(result.output).not.toMatch(/shared daemon fixture/i);
    });

    it("does not flag exec(\"kspec serve start --detach\") when scoped cleanup is registered", () => {
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { exec } from "child_process";

describe("exec kspec serve start --detach with cleanup", () => {
  it("starts the daemon detached via exec and registers cleanup", () => {
    exec("kspec serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => killPid(pid));
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });
  });
});

/**
 * Daemon test guardrail precision: detached cleanup timing.
 *
 * These tests cover @daemon-test-guardrail-precision for the detached-serve
 * cleanup-timing analysis the rule performs:
 *
 *   ac-detached-cleanup-before-observation
 *     A detached daemon start is reported when the test performs later
 *     awaits, assertions, or daemon observations before registering
 *     cleanup for that daemon. The mere presence of an ancestor
 *     `afterEach` hook with a `process.kill` / `child.kill("SIGTERM")`
 *     pattern is not proof that the just-started daemon is owned by
 *     cleanup — if the captured pid/handle is assigned only AFTER an
 *     intervening `expect()` or `await`, an assertion failure leaves
 *     the binding null and the daemon leaks.
 *
 *   ac-local-exception-is-local
 *     Suppressions of the rule must be local to the violating statement.
 *     File- or block-wide disables and disables that target an unrelated
 *     preceding statement are rejected.
 *
 *   ac-exception-reason-states-subject
 *     A per-line suppression must include a `-- <reason>` text describing
 *     the behavior under test. Undocumented disables are rejected.
 *
 * The allowed-narrow cases describe the canonical safe shape (capture pid
 * or child handle inline, register cleanup before any await/expect) so
 * the fix cannot accidentally over-tighten and reject legitimate patterns.
 */
describe("daemon test guardrail precision: detached cleanup timing", () => {
  // AC: @daemon-test-guardrail-precision ac-detached-cleanup-before-observation
  describe("detached daemon flagged when cleanup is not bound before later observations", () => {
    it("flags runKspec(\"serve start --detach\") when an afterEach closes over a let pid that is assigned only after an expect()", () => {
      // UNSAFE: the afterEach captures `pid`, but the test body runs
      // `expect(...)` before `pid = readPidFromFile()`. If the assertion
      // throws, `pid` is still null when the afterEach runs and the
      // detached daemon process is leaked. The presence of an afterEach
      // with a `process.kill` pattern must not exempt the detached start
      // because the binding is not complete until after the observation.
      const result = runOxlint({
        source: `
import { describe, it, expect, afterEach } from "vitest";

describe("detached cleanup deferred until after assertion", () => {
  let pid: number | null = null;
  afterEach(() => { if (pid !== null) process.kill(pid, "SIGTERM"); });

  it("starts daemon and asserts before capturing pid", () => {
    runKspec("serve start --detach --port 3456");
    expect(true).toBe(true);
    pid = readPidFromFile();
  });
});
`,
      });
      // The rule must report this detached start because pid capture
      // (and therefore cleanup binding) does not happen until after the
      // intervening expect().
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/serve start --detach|scoped cleanup|onTestFinished/i);
    });

    it("flags runKspec(\"serve start --detach\") when an afterEach closes over a let pid that is assigned only after an awaited probe", () => {
      // UNSAFE: same shape as the assertion case but the intervening
      // operation is an `await` on a daemon observation. The await can
      // throw or hang before `pid` is captured, leaking the daemon.
      const result = runOxlint({
        source: `
import { describe, it, expect, afterEach } from "vitest";

describe("detached cleanup deferred until after await", () => {
  let pid: number | null = null;
  afterEach(() => { if (pid !== null) process.kill(pid, "SIGTERM"); });

  it("starts daemon and awaits readiness before capturing pid", async () => {
    runKspec("serve start --detach --port 3456");
    await waitForReady("http://127.0.0.1:3456/api/health");
    pid = readPidFromFile();
  });
});
`,
      });
      // The rule must report this detached start because the awaited
      // probe runs before the pid binding is complete.
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/serve start --detach|scoped cleanup|onTestFinished/i);
    });

    it("flags spawn(\"kspec\", [\"serve\", \"start\", \"--detach\"]) when an afterEach closes over a let child that is assigned only after an awaited probe", () => {
      // UNSAFE argv-form variant: the spawn returns a child handle, but
      // the test does not capture it until after `await waitForReady()`.
      // The afterEach closes over `child`, yet the binding is null when
      // the await runs. The detached start is unsafe regardless of the
      // child-handle vs pid-file flavor.
      const result = runOxlint({
        source: `
import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "child_process";

describe("detached child handle deferred until after await", () => {
  let child: { pid: number; kill: (sig: string) => void } | null = null;
  afterEach(() => { if (child) child.kill("SIGTERM"); });

  it("spawns daemon and awaits readiness before capturing the child handle", async () => {
    spawn("kspec", ["serve", "start", "--detach", "--port", "3456"]);
    await waitForReady("http://127.0.0.1:3456/api/health");
    child = readChildFromPidFile();
  });
});
`,
      });
      // The rule must report this spawn() because the child-handle
      // binding does not happen until after the await.
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/serve start --detach|scoped cleanup|onTestFinished/i);
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-before-observation
    // (allowed narrow case)
    it("does not flag runKspec(\"serve start --detach\") when the pid is read and onTestFinished cleanup is registered before any await/expect", () => {
      // ALLOWED narrow: the canonical safe shape — capture pid inline,
      // register `onTestFinished` cleanup, then run assertions. Cleanup
      // is bound to this specific daemon before any operation that could
      // throw or suspend the test.
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";

describe("detached cleanup registered immediately", () => {
  it("starts daemon, captures pid, registers cleanup, then asserts", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => process.kill(pid, "SIGTERM"));
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-before-observation
    // (allowed narrow case, child handle flavor)
    it("does not flag spawn(\"kspec\", [\"serve\", \"start\", \"--detach\"]) when the child handle is captured inline and onTestFinished kills it before any await/expect", () => {
      // ALLOWED narrow: the child-handle flavor of the safe shape — the
      // spawn return value is captured by the same statement, the kill
      // closure binds to the just-spawned handle, and only then does the
      // test perform observations.
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { spawn } from "child_process";

describe("detached child handle cleanup registered immediately", () => {
  it("starts daemon via spawn, registers handle cleanup, then asserts", () => {
    const child = spawn("kspec", ["serve", "start", "--detach", "--port", "3456"]);
    onTestFinished(() => child.kill("SIGTERM"));
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });
  });

  // AC: @daemon-test-guardrail-precision ac-local-exception-is-local
  // AC: @daemon-test-guardrail-precision ac-exception-reason-states-subject
  describe("detached cleanup suppressions stay local and state subject", () => {
    it("accepts a per-line oxlint-disable-next-line with -- reason on the offending detached start", () => {
      // ALLOWED suppression: the disable sits immediately above the
      // offending statement and names the behavior under test (the CLI's
      // own --detach exit ordering when a bind race is in flight). Tests
      // of the CLI's own detach behavior need this hatch.
      const result = runOxlint({
        source: `
import { describe, it, expect, afterEach } from "vitest";

describe("intentional unsafe ordering with localized disable", () => {
  let pid: number | null = null;
  afterEach(() => { if (pid !== null) process.kill(pid, "SIGTERM"); });

  it("verifies serve start --detach exits non-zero when port is in use", () => {
    // oxlint-disable-next-line no-leaky-test-daemon/no-leaky-test-daemon -- exercising CLI exit ordering when --detach loses the bind race
    runKspec("serve start --detach --port 3456");
    expect(true).toBe(true);
    pid = readPidFromFile();
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("flags a per-line oxlint-disable-next-line on the offending detached start that omits the -- reason", () => {
      // The directive names the rule but supplies no `-- <reason>`. The
      // localized-disable companion rule reports it so undocumented
      // suppressions cannot silently bypass the cleanup-timing check.
      const result = runOxlint({
        source: `
import { describe, it, expect, afterEach } from "vitest";

describe("undocumented detached disable", () => {
  let pid: number | null = null;
  afterEach(() => { if (pid !== null) process.kill(pid, "SIGTERM"); });

  it("disables without stating the behavior under test", () => {
    // oxlint-disable-next-line no-leaky-test-daemon/no-leaky-test-daemon
    runKspec("serve start --detach --port 3456");
    expect(true).toBe(true);
    pid = readPidFromFile();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/reason|behavior under test|localized-disable/i);
    });

    it("flags a file-wide oxlint-disable for the rule when the file would otherwise rely on it to silence an unsafe detached start", () => {
      // A file-wide directive disables the rule across every statement in
      // the file. The localized-disable companion rule rejects it: the
      // suppression must be scoped to the violating line, not the file.
      const result = runOxlint({
        source: `
/* oxlint-disable no-leaky-test-daemon/no-leaky-test-daemon */
import { describe, it, expect, afterEach } from "vitest";

describe("file-wide disable broadens the exception", () => {
  let pid: number | null = null;
  afterEach(() => { if (pid !== null) process.kill(pid, "SIGTERM"); });

  it("starts daemon under a broad disable directive", () => {
    runKspec("serve start --detach --port 3456");
    expect(true).toBe(true);
    pid = readPidFromFile();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/file.?wide|block.?wide|localized-disable/i);
    });

    it("does not silence the offending detached start when an oxlint-disable-next-line sits above an unrelated preceding statement", () => {
      // The disable directive applies to the line immediately following
      // it (the `const noop` declaration), not the detached start two
      // lines below. The detached start must therefore still be flagged
      // as if no disable were present.
      const result = runOxlint({
        source: `
import { describe, it, expect, afterEach } from "vitest";

describe("disable on the wrong line", () => {
  let pid: number | null = null;
  afterEach(() => { if (pid !== null) process.kill(pid, "SIGTERM"); });

  it("places the disable two lines above the offending detached start", () => {
    // oxlint-disable-next-line no-leaky-test-daemon/no-leaky-test-daemon -- this disable applies only to the literal below
    const noop = "harmless";
    runKspec("serve start --detach --port 3456");
    expect(noop).toBe("harmless");
    pid = readPidFromFile();
  });
});
`,
      });
      // The disable applies only to the next line (the `const noop`
      // declaration). The detached start two lines down is unrelated to
      // the directive and must still be reported by the cleanup-timing
      // rule, so the disable misplacement cannot bypass enforcement.
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/serve start --detach|scoped cleanup|onTestFinished/i);
    });
  });
});

/**
 * Daemon test guardrail precision: cleanup callback must be bound to a
 * concrete daemon handle before any later observation.
 *
 * These tests cover @daemon-test-guardrail-precision
 * `ac-detached-cleanup-bound-before-observation`. The earlier
 * `ac-detached-cleanup-before-observation` AC required cleanup to be
 * REGISTERED before any later await/expect/daemon observation. The
 * tightened AC additionally requires the registered cleanup callback
 * to OWN a concrete pid, child handle, or stop handle for the
 * just-started detached daemon at the moment of registration. A
 * callback that closes over a `let` binding which is still null/undefined
 * at registration time and only gets the real pid/handle AFTER an
 * intervening observation is unsafe: an assertion failure or thrown
 * await between the registration and the binding leaves the cleanup
 * closure with no daemon to kill, and the detached process leaks.
 *
 * Each unsafe example below WAS a false negative in the
 * `no-leaky-test-daemon` rule — the rule used to see an
 * `onTestFinished(...)` registration before the next observation and
 * accept it as cleanup even though the captured variable was unbound.
 * The lint-rule fix that closed
 * `ac-detached-cleanup-bound-before-observation` now requires the
 * cleanup closure to own a concrete pid/child handle/stop handle at
 * registration time, so the unsafe shapes below all produce a
 * `cleanupClosureUnbound` diagnostic and the assertions hold. The
 * tests are therefore plain `it(...)` again.
 *
 * Allowed-narrow cases describe the canonical safe shape (pid or child
 * handle is captured BEFORE the cleanup registration, so the closure
 * already owns a concrete value when registered) so the fix cannot
 * accidentally over-tighten and reject legitimate patterns. They use
 * plain `it(...)` because they pass today and must still pass after
 * the fix.
 */
describe("daemon test guardrail precision: cleanup callback bound before observation", () => {
  // AC: @daemon-test-guardrail-precision ac-detached-cleanup-bound-before-observation
  describe("detached daemon flagged when cleanup closure is unbound at registration", () => {
    it("flags runKspec(\"serve start --detach\") when onTestFinished closes over a let pid that is assigned only after an intervening expect()", () => {
      // UNSAFE: cleanup IS registered before the expect(), but the closure
      // captures a `let pid` that is still undefined at registration time.
      // The pid file is read AFTER the expect() runs. If the assertion
      // throws, the onTestFinished callback fires with `pid === undefined`
      // and process.kill(undefined, ...) cannot kill the detached daemon.
      // The current rule treats the registration-before-observation as
      // sufficient cleanup and does NOT flag this — that is the false
      // negative this regression locks in.
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";

describe("cleanup closure captures unbound pid", () => {
  it("registers cleanup over a pid let, then asserts, then captures pid", () => {
    let pid: number | undefined;
    runKspec("serve start --detach --port 3456");
    onTestFinished(() => { if (pid !== undefined) process.kill(pid, "SIGTERM"); });
    expect(true).toBe(true);
    pid = readPidFromFile();
  });
});
`,
      });
      // The rule must report this detached start because the cleanup
      // callback's captured `pid` is undefined at the moment of
      // registration and only gets the real pid AFTER the intervening
      // expect(). An assertion failure leaves the daemon orphaned.
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/serve start --detach|scoped cleanup|onTestFinished|bound|captured/i);
    });

    it("flags runKspec(\"serve start --detach\") when onTestFinished closes over a let pid that is assigned only after an intervening await", () => {
      // UNSAFE: same shape as the assertion variant but the intervening
      // operation is an `await waitForReady(...)` against the daemon. The
      // await can throw or hang before pid is captured. The rule currently
      // accepts the early onTestFinished registration as cleanup despite
      // the unbound capture.
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";

describe("cleanup closure captures unbound pid before await", () => {
  it("registers cleanup over a pid let, then awaits readiness, then captures pid", async () => {
    let pid: number | undefined;
    runKspec("serve start --detach --port 3456");
    onTestFinished(() => { if (pid !== undefined) process.kill(pid, "SIGTERM"); });
    await waitForReady("http://127.0.0.1:3456/api/health");
    pid = readPidFromFile();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/serve start --detach|scoped cleanup|onTestFinished|bound|captured/i);
    });

    it("flags spawn(\"kspec\", [\"serve\", \"start\", \"--detach\"]) when onTestFinished closes over a let child handle that is assigned only after an intervening await", () => {
      // UNSAFE child-handle variant: the spawn returns a child handle but
      // the test doesn't capture it inline — it reassigns `let child`
      // only after an `await waitForReady(...)` against the daemon. The
      // onTestFinished closure references `child` while it is still null,
      // so a thrown await never hits the kill path. The rule currently
      // misses this because the registration sits before the await.
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { spawn } from "child_process";

describe("cleanup closure captures unbound child handle", () => {
  it("spawns daemon, registers handle cleanup, awaits readiness, then captures child", async () => {
    let child: { pid: number; kill: (sig: string) => void } | null = null;
    spawn("kspec", ["serve", "start", "--detach", "--port", "3456"]);
    onTestFinished(() => { if (child) child.kill("SIGTERM"); });
    await waitForReady("http://127.0.0.1:3456/api/health");
    child = readChildFromPidFile();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/serve start --detach|scoped cleanup|onTestFinished|bound|captured/i);
    });

    it("flags runKspec(\"serve start --detach\") when onTestFinished captures pid before a daemon-host fetch observation but pid is bound only after the fetch", () => {
      // UNSAFE: the intervening observation is a `fetch` to the daemon
      // host (a recognised daemon network observation per the existing
      // observation gate). The cleanup registration sits before it, but
      // the pid binding sits after — same unbound-closure leak as the
      // expect/await variants.
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";

describe("cleanup closure captures unbound pid before daemon fetch", () => {
  it("registers cleanup, fetches health, then captures pid", async () => {
    let pid: number | undefined;
    runKspec("serve start --detach --port 3456");
    onTestFinished(() => { if (pid !== undefined) process.kill(pid, "SIGTERM"); });
    const response = await fetch("http://127.0.0.1:3456/api/health");
    expect(response.status).toBe(200);
    pid = readPidFromFile();
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/serve start --detach|scoped cleanup|onTestFinished|bound|captured/i);
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-bound-before-observation
    // (allowed narrow case)
    it("does not flag runKspec(\"serve start --detach\") when pid is captured BEFORE the onTestFinished registration and BEFORE any observation", () => {
      // ALLOWED narrow: the canonical safe shape — pid is bound to a
      // concrete value by `const pid = readPidFromFile()` BEFORE the
      // onTestFinished registration. The cleanup closure captures the
      // already-resolved value, so an assertion failure two lines down
      // still has a real pid to kill. The fix must continue to accept
      // this shape without over-tightening.
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";

describe("cleanup closure captures concrete pid before observation", () => {
  it("starts daemon, captures pid as a const, registers cleanup, then asserts", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => process.kill(pid, "SIGTERM"));
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-bound-before-observation
    // (allowed narrow case, child handle flavor)
    it("does not flag spawn(\"kspec\", [\"serve\", \"start\", \"--detach\"]) when the child handle is captured by the spawn statement and onTestFinished kills it before any observation", () => {
      // ALLOWED narrow: the spawn return value is captured by the same
      // statement (`const child = spawn(...)`), so the onTestFinished
      // closure binds to the concrete handle at registration time. No
      // unbound let, no later reassignment.
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { spawn } from "child_process";

describe("cleanup closure captures concrete child handle before observation", () => {
  it("spawns daemon, captures child via const, registers cleanup, then asserts", () => {
    const child = spawn("kspec", ["serve", "start", "--detach", "--port", "3456"]);
    onTestFinished(() => child.kill("SIGTERM"));
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-bound-before-observation
    // (ownership: pre-existing concrete value cannot represent the just-started daemon)
    it("flags runKspec(\"serve start --detach\") when onTestFinished captures a const pid bound to a literal BEFORE the daemon start", () => {
      // UNSAFE (cycle-7 reviewer probe): `pid` is concretely bound at
      // registration — but to a literal `12345` set BEFORE the daemon
      // was started. The cleanup closure has SOMETHING to kill, but
      // not the just-started daemon — process.kill(12345, "SIGTERM")
      // either kills nothing (no such pid) or kills an unrelated
      // process while the new detached daemon leaks. The earlier
      // binding-only check accepted this shape because the
      // concretely-bound predicate did not look at the binding's
      // position relative to the detached start. The ownership leg
      // added in this fix rejects bindings whose source range ends
      // before the detached-start begins.
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";

describe("cleanup closure captures pid bound to a literal before the daemon start", () => {
  it("binds pid before runKspec, registers cleanup over the stale literal", () => {
    const pid = 12345;
    runKspec("serve start --detach --port 3456");
    onTestFinished(() => process.kill(pid, "SIGTERM"));
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/own|just-started|concrete|registration time/i);
      expect(result.output).toContain("pid");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-bound-before-observation
    // (ownership: child-handle variant)
    it("flags spawn(\"kspec\", [\"serve\", \"start\", \"--detach\"]) when onTestFinished captures a const child handle from an UNRELATED spawn that ran BEFORE the detached start", () => {
      // UNSAFE: a child handle from an unrelated spawn (e.g. `spawn
      // ("echo", ["ready"])`) is concretely bound BEFORE the daemon
      // start. The cleanup closure has a concrete handle to call
      // .kill("SIGTERM") on — but not the handle for the daemon this
      // test just started. Same ownership defect as the literal-pid
      // probe, surfaced through the child-handle daemon-kill shape.
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { spawn } from "child_process";

describe("cleanup closure captures unrelated child handle from a pre-start spawn", () => {
  it("spawns an unrelated process first, then starts the daemon, then kills the unrelated handle", () => {
    const child = spawn("echo", ["ready"]);
    spawn("kspec", ["serve", "start", "--detach", "--port", "3456"]);
    onTestFinished(() => child.kill("SIGTERM"));
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/own|just-started|concrete|registration time/i);
      expect(result.output).toContain("child");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-bound-before-observation
    // (ownership: imported / undeclared identifier captured)
    it("flags runKspec(\"serve start --detach\") when onTestFinished captures a pid imported from another module (cannot represent the just-started daemon)", () => {
      // UNSAFE: `pid` is an imported binding — a value defined in a
      // different module, not derived from this test's daemon start.
      // The earlier check treated undeclared identifiers as
      // conservatively bound (to avoid false positives on globals like
      // `console`). The ownership leg distinguishes "no visible
      // declaration" from "binding produced by the just-started
      // daemon": imports/globals cannot represent the daemon, so they
      // are not owned and the cleanup is rejected.
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { pid } from "./pid-from-other-module";

describe("cleanup closure captures imported pid", () => {
  it("uses an imported pid as the kill target", () => {
    runKspec("serve start --detach --port 3456");
    onTestFinished(() => process.kill(pid, "SIGTERM"));
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/own|just-started|concrete|registration time/i);
      expect(result.output).toContain("pid");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-bound-before-observation
    // (cycle-5 reviewer probe: TS-asserted `undefined` initializer must be
    // recognised as a placeholder, not a concrete value-producing binding)
    it("flags runKspec(\"serve start --detach\") when onTestFinished captures a const pid initialised to `undefined as number | undefined` (TS-wrapped undefined is still undefined at registration time)", () => {
      // UNSAFE (cycle-5 reviewer probe): the test starts the detached
      // daemon, then declares `const pid = undefined as number | undefined`
      // AFTER the start, then registers `onTestFinished(() => { if (pid !==
      // undefined) process.kill(pid, "SIGTERM"); })`. The declarator's
      // source range ends AFTER the detached-start begins, so the
      // declarator-position check alone says "owned". But the initializer
      // is a TS-wrapped `undefined` — at registration time the closure
      // captures a binding whose runtime value is still undefined, so an
      // intervening assertion failure leaves the cleanup with no captured
      // pid and the detached daemon leaks. The earlier
      // `isNullOrUndefinedInitializer` only inspected bare Literal `null`,
      // bare Identifier `undefined`, and `void <expr>` — it did NOT unwrap
      // transparent TS wrappers, so the TSAsExpression node was treated as
      // a concrete initializer. The fix unwraps the same set of
      // transparent wrappers as the kill-target analysis
      // (TSAsExpression / TSSatisfiesExpression / TSNonNullExpression /
      // TSTypeAssertion / TSInstantiationExpression / parens / chain
      // wrappers) before classifying the initializer, so wrapped
      // `undefined` is correctly recognised as a placeholder and the
      // cleanup is rejected.
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";

describe("cleanup closure captures pid initialised to TS-wrapped undefined", () => {
  it("declares const pid = undefined as number | undefined after the start, registers cleanup", () => {
    runKspec("serve start --detach --port 3456");
    const pid = undefined as number | undefined;
    onTestFinished(() => { if (pid !== undefined) process.kill(pid, "SIGTERM"); });
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/own|just-started|concrete|registration time/i);
      expect(result.output).toContain("pid");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-bound-before-observation
    // (cycle-5: TS-asserted `null` initializer is the same placeholder shape)
    it("flags runKspec(\"serve start --detach\") when onTestFinished captures a const pid initialised to `null as any` (TS-wrapped null is still null at registration time)", () => {
      // UNSAFE: `null as any` is the null counterpart of the cycle-5
      // probe. The runtime value at registration is null; the closure has
      // no concrete pid to kill at teardown if an intervening observation
      // fails. The unwrap discipline must classify wrapped `null` the
      // same way as wrapped `undefined`.
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";

describe("cleanup closure captures pid initialised to TS-wrapped null", () => {
  it("declares const pid = null as any after the start, registers cleanup", () => {
    runKspec("serve start --detach --port 3456");
    const pid = null as any;
    onTestFinished(() => { if (pid !== null) process.kill(pid, "SIGTERM"); });
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/own|just-started|concrete|registration time/i);
      expect(result.output).toContain("pid");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-bound-before-observation
    // (cycle-5: stacked transparent wrappers around `undefined` still resolve
    // as a placeholder)
    it("flags runKspec(\"serve start --detach\") when onTestFinished captures a const pid initialised to `(undefined)!` (non-null assertion over undefined unwraps to a placeholder)", () => {
      // UNSAFE: stacking parens + non-null assertion over `undefined`
      // produces a TS-coerced placeholder. The fixed-point unwrap loop
      // strips ParenthesizedExpression, then TSNonNullExpression, then
      // (some parsers wrap the non-null assertion in a ChainExpression)
      // ChainExpression, until the underlying Identifier `undefined` is
      // exposed. Without the unwrap, the rule would see the
      // TSNonNullExpression and treat it as a concrete value.
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";

describe("cleanup closure captures pid initialised to non-null-asserted undefined", () => {
  it("declares const pid = (undefined)! after the start, registers cleanup", () => {
    runKspec("serve start --detach --port 3456");
    const pid = (undefined)! as number;
    onTestFinished(() => { if (pid !== undefined) process.kill(pid, "SIGTERM"); });
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/own|just-started|concrete|registration time/i);
      expect(result.output).toContain("pid");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-bound-before-observation
    // (cycle-5: assignment-RHS variant — TS-wrapped undefined as the RHS of a
    // post-start assignment still leaves the binding placeholder-only)
    it("flags runKspec(\"serve start --detach\") when onTestFinished captures a let pid that is later assigned `undefined as any` after the start (TS-wrapped placeholder RHS)", () => {
      // UNSAFE: the assignment-RHS leg of the binding analysis must
      // recognise TS-wrapped null/undefined the same way as the
      // declarator-init leg. `let pid: number | undefined; runKspec(...);
      // pid = undefined as any; onTestFinished(...);` reaches the
      // AssignmentExpression branch of findConcreteBindingInStatements.
      // Without the unwrap, the TSAsExpression RHS would mark the
      // binding as concretely re-bound after the start, hiding the
      // placeholder semantics.
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";

describe("cleanup closure captures pid reassigned to TS-wrapped undefined", () => {
  it("declares let pid, starts daemon, assigns TS-wrapped undefined, then registers cleanup", () => {
    let pid: number | undefined;
    runKspec("serve start --detach --port 3456");
    pid = undefined as any;
    onTestFinished(() => { if (pid !== undefined) process.kill(pid, "SIGTERM"); });
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/own|just-started|concrete|registration time/i);
      expect(result.output).toContain("pid");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-bound-before-observation
    // (cycle-5: positive control — wrapped concrete value remains concrete)
    it("does not flag runKspec(\"serve start --detach\") when const pid = (readPidFromFile() as number) is captured AFTER the start and onTestFinished kills it", () => {
      // ALLOWED narrow: the unwrap discipline must NOT strip transparent
      // wrappers around a real value-producing expression. Wrapping a
      // `readPidFromFile()` CallExpression in a TS cast does not turn it
      // into a placeholder — the runtime value at registration time is
      // the daemon's pid. The unwrap classifier checks the underlying
      // expression: CallExpression is neither Literal-null nor Identifier-
      // undefined nor void, so the initializer is concrete and ownership
      // holds (declarator ends after the start).
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { readPidFromFile } from "./helpers/pid";

describe("cleanup closure captures TS-cast over a concrete read", () => {
  it("declares const pid = readPidFromFile() as number after the start, registers cleanup", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile() as number;
    onTestFinished(() => process.kill(pid, "SIGTERM"));
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-bound-before-observation
    // (ownership: kill target is a member expression on a binding that
    // pre-dates the daemon start)
    it("flags runKspec(\"serve start --detach\") when onTestFinished captures process.kill(holder.pid, ...) where holder was declared BEFORE the daemon start", () => {
      // UNSAFE (cycle-8 reviewer probe): the kill target is `holder.pid`,
      // a MemberExpression. The earlier ownership check only inspected
      // bare-Identifier kill targets, so a MemberExpression target was
      // silently accepted as scoped cleanup even though `holder` was
      // declared as `const holder = {}` BEFORE the daemon start AND the
      // `holder.pid` field is assigned only AFTER the intervening
      // assertion. The framework invokes the callback at teardown, but
      // the callback's defensive guard keeps it from killing anything;
      // even without the guard, `process.kill(undefined, ...)` cannot
      // kill the just-started daemon. The fix walks MemberExpression
      // chains to the root identifier and runs the same ownership
      // predicate as the bare-Identifier case, so the root `holder` is
      // rejected because its declarator's range ends BEFORE the
      // detached-start begins.
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";

describe("cleanup closure captures process.kill(holder.pid) where holder predates the start", () => {
  it("declares holder before runKspec, registers cleanup over a stale member-expression target", () => {
    const holder = {};
    runKspec("serve start --detach --port 3456");
    onTestFinished(() => {
      if (holder.pid !== undefined) process.kill(holder.pid, "SIGTERM");
    });
    expect(true).toBe(true);
    holder.pid = 12345;
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/own|just-started|concrete|registration time/i);
      expect(result.output).toContain("holder");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-bound-before-observation
    // (ownership: kill target is a deep member chain, root predates start)
    it("flags runKspec(\"serve start --detach\") when onTestFinished captures process.kill(state.daemon.pid, ...) and `state` predates the daemon start", () => {
      // UNSAFE: the kill target is a deep MemberExpression chain
      // `state.daemon.pid`. Walking the chain to its root yields
      // `state`, which is declared BEFORE the runKspec start. The
      // closure has a structured object to read at teardown, but the
      // root binding cannot represent the just-started daemon — it
      // existed before the daemon did.
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";

describe("cleanup closure captures a deep member chain rooted in a binding that predates the start", () => {
  it("declares state before runKspec, registers cleanup over state.daemon.pid", () => {
    const state = { daemon: {} };
    runKspec("serve start --detach --port 3456");
    onTestFinished(() => process.kill(state.daemon.pid, "SIGTERM"));
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/own|just-started|concrete|registration time/i);
      expect(result.output).toContain("state");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-bound-before-observation
    // (ownership: kill receiver is a member chain, root predates start)
    it("flags runKspec(\"serve start --detach\") when onTestFinished captures handle.child.kill(\"SIGTERM\") and `handle` predates the daemon start", () => {
      // UNSAFE: the kill RECEIVER (callee.object) is a MemberExpression
      // `handle.child`. The earlier check only extracted bare-Identifier
      // receivers, so a member-receiver was accepted silently. Walking
      // the chain to the root `handle` and applying the ownership
      // predicate rejects this shape because `handle` was declared
      // before the daemon start.
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";

describe("cleanup closure captures member-receiver kill where the receiver root predates the start", () => {
  it("declares handle before runKspec, registers a deep .kill receiver", () => {
    const handle = { child: { kill: () => {} } };
    runKspec("serve start --detach --port 3456");
    onTestFinished(() => handle.child.kill("SIGTERM"));
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/own|just-started|concrete|registration time/i);
      expect(result.output).toContain("handle");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-bound-before-observation
    // (ownership: unverifiable kill target — call expression cannot be tied
    // to the just-started daemon)
    it("flags runKspec(\"serve start --detach\") when onTestFinished registers process.kill(getStalePid(), ...) — call expression target cannot be statically tied to the daemon", () => {
      // UNSAFE: `process.kill(getStalePid(), "SIGTERM")` — the kill
      // target is a CallExpression. Static analysis cannot determine
      // whether the function returns the just-started daemon's pid;
      // the conservative answer is to reject the cleanup as unbound so
      // the missing-cleanup contract still applies. A bare-literal
      // target like `process.kill(12345, "SIGTERM")` falls under the
      // same rejection: a literal cannot represent the just-started
      // daemon's pid.
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";

describe("cleanup closure registers a call-expression kill target", () => {
  it("uses getStalePid() as the kill target", () => {
    runKspec("serve start --detach --port 3456");
    onTestFinished(() => process.kill(getStalePid(), "SIGTERM"));
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-bound-before-observation
    // (callback-local literal kill target — cycle-3 reviewer probe)
    it("flags runKspec(\"serve start --detach\") when onTestFinished body declares `const pid = 12345` and process.kill(pid, ...) — callback-local literal cannot represent the daemon", () => {
      // UNSAFE (cycle-3 reviewer probe): the cleanup callback declares
      // its own `const pid = 12345` and calls process.kill(pid, ...).
      // The earlier rule treated callback-local kill targets as
      // inherently dynamic (a runtime read at cleanup time) and
      // skipped the binding check entirely — but a literal pid is
      // statically resolvable AT WRITE TIME and cannot have been
      // chosen to match the daemon process the test just started.
      // The cleanup hook fires, attempts to kill PID 12345 (which is
      // either nonexistent or unrelated), and the just-started
      // detached daemon leaks. The fix narrows the callback-local
      // exemption: a callback-local kill target counts as cleanup
      // only when its binding plausibly derives from a runtime read
      // (CallExpression, MemberExpression, outer-Identifier read).
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";

describe("cleanup closure body declares its own pid as a stale literal", () => {
  it("registers cleanup whose pid is a callback-local literal", () => {
    runKspec("serve start --detach --port 3456");
    onTestFinished(() => {
      const pid = 12345;
      process.kill(pid, "SIGTERM");
    });
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/own|just-started|concrete|registration time/i);
      expect(result.output).toContain("pid");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-bound-before-observation
    // (callback-local literal via let + later assignment)
    it("flags runKspec(\"serve start --detach\") when onTestFinished body uses `let pid; pid = 99999;` then process.kill(pid, ...) — every assignment is literal", () => {
      // UNSAFE: callback-local `let pid;` with a later literal
      // assignment also fails the dynamic check. The rule walks all
      // VariableDeclarators AND AssignmentExpressions inside the
      // callback that target `name`; if every value source is a
      // static literal, the binding is rejected. This locks in the
      // generalised stale-literal rejection beyond just the const
      // initializer shape.
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";

describe("cleanup closure body declares pid as let then assigns a literal", () => {
  it("uses let + literal assignment for the kill target", () => {
    runKspec("serve start --detach --port 3456");
    onTestFinished(() => {
      let pid;
      pid = 99999;
      process.kill(pid, "SIGTERM");
    });
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("pid");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-bound-before-observation
    // (callback-local kill target wrapped in a TS assertion is still
    // rejected when the binding is literal-only)
    it("flags runKspec(\"serve start --detach\") when onTestFinished body declares `const pid = 12345 as number` — wrapped literal still resolves as static", () => {
      // UNSAFE: even with a TS `as number` cast, the binding's value
      // is a literal — the cast does not introduce any runtime read.
      // The static-literal classifier unwraps transparent TS wrappers
      // before checking, so `12345 as number` is rejected the same
      // as a bare `12345`.
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";

describe("cleanup closure body declares pid as a TS-asserted literal", () => {
  it("uses const pid = 12345 as number for the kill target", () => {
    runKspec("serve start --detach --port 3456");
    onTestFinished(() => {
      const pid = 12345 as number;
      process.kill(pid, "SIGTERM");
    });
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("pid");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-bound-before-observation
    // (cycle-4 reviewer probe: callback-local CallExpression init is
    // still unsafe — the runtime read is deferred to teardown time)
    it("flags runKspec(\"serve start --detach\") when onTestFinished body declares `const pid = readPidFromFile()` then process.kill(pid, ...) — callback-local read is deferred to teardown, not owned at registration", () => {
      // UNSAFE (cycle-4 reviewer probe): the cleanup callback declares
      // `const pid = readPidFromFile()` inside its own body. The
      // initializer is a CallExpression — but it is evaluated at
      // teardown, not at registration. Per
      // ac-detached-cleanup-bound-before-observation, the cleanup
      // callback must "capture or otherwise own" the concrete pid AT
      // REGISTRATION TIME so the cleanup contract survives an
      // intervening assertion failure. A callback-local binding —
      // literal OR dynamic — never owns anything at registration; the
      // closure has no captured outer pid to fall back on if
      // readPidFromFile() throws (file not yet written) or returns NaN
      // at teardown. The earlier dynamic-RHS exemption was the bug:
      // it accepted runtime-read shapes that defer ownership entirely.
      // The correct pattern reads the pid OUTSIDE the callback after
      // the start, then registers a closure that captures the outer
      // const (covered by the next test).
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { readPidFromFile } from "./helpers/pid";

describe("cleanup closure reads the pid file at cleanup time", () => {
  it("registers cleanup that reads pid from disk inside the callback", () => {
    runKspec("serve start --detach --port 3456");
    onTestFinished(() => {
      const pid = readPidFromFile();
      process.kill(pid, "SIGTERM");
    });
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/own|just-started|concrete|registration time/i);
      expect(result.output).toContain("pid");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-bound-before-observation
    // (allowed-narrow: read pid OUTSIDE the callback after the start,
    // then register a closure that captures the outer const — the
    // safe alternative to the cycle-4 callback-local probe above)
    it("does not flag runKspec(\"serve start --detach\") when pid is read OUTSIDE the callback after the start and onTestFinished closes over the outer const", () => {
      // ALLOWED: the test reads `const pid = readPidFromFile()` after
      // the daemon start completes but BEFORE registering cleanup.
      // The cleanup closure captures the outer `pid` binding, which
      // is owned at registration time — an intervening assertion
      // failure cannot leave the cleanup with nothing to kill. The
      // ownership predicate validates that `pid`'s declarator ends
      // after the detached start begins, so this safe shape is
      // accepted.
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { readPidFromFile } from "./helpers/pid";

describe("cleanup closure captures outer pid read after the start", () => {
  it("reads pid outside the callback then registers the cleanup", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => process.kill(pid, "SIGTERM"));
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-bound-before-observation
    // (cycle-4 reviewer probe: callback-local MemberExpression init
    // via deferred read is still unsafe)
    it("flags runKspec(\"serve start --detach\") when onTestFinished body declares `const pid = state.lastPid` then process.kill(pid, ...) — callback-local member read is still deferred to teardown", () => {
      // UNSAFE (cycle-4 reviewer probe variant): even when the
      // callback-local initializer is a MemberExpression — a value
      // that "looks like" it could come from runtime state — the
      // read still happens at teardown. The cleanup closure has
      // nothing concrete bound at registration time, so an
      // intervening assertion failure cannot guarantee the cleanup
      // has a usable target. The fix's blanket "callback-local kill
      // targets are always rejected" rule covers all initializer
      // shapes, not just literals.
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";

describe("cleanup closure body declares pid as a callback-local member read", () => {
  it("registers cleanup that reads pid from outer state inside the callback", () => {
    const state: { lastPid?: number } = {};
    runKspec("serve start --detach --port 3456");
    onTestFinished(() => {
      const pid = state.lastPid as number;
      process.kill(pid, "SIGTERM");
    });
    expect(true).toBe(true);
    state.lastPid = 12345;
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("pid");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-bound-before-observation
    // (cycle-4 reviewer probe: callback-local let with later
    // CallExpression assignment is still unsafe)
    it("flags runKspec(\"serve start --detach\") when onTestFinished body uses `let pid; pid = readPidFromFile();` then process.kill(pid, ...) — callback-local let + dynamic assign is still deferred", () => {
      // UNSAFE (cycle-4 reviewer probe variant): a callback-local
      // `let pid;` followed by a CallExpression assignment inside
      // the same callback also fails the contract. Both the
      // declaration and the assignment execute at teardown, not at
      // registration. There is no concrete pid bound at registration,
      // and the cleanup closure has no captured outer fallback.
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { readPidFromFile } from "./helpers/pid";

describe("cleanup closure body uses let + later dynamic assignment", () => {
  it("declares pid then assigns from a runtime read inside the callback", () => {
    runKspec("serve start --detach --port 3456");
    onTestFinished(() => {
      let pid;
      pid = readPidFromFile();
      process.kill(pid, "SIGTERM");
    });
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("pid");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-bound-before-observation
    // (cycle-3 reviewer probe: TS as-cast on captured pid in the kill
    // call must not be rejected when the underlying binding is owned)
    it("does not flag runKspec(\"serve start --detach\") when pid is captured before cleanup and the callback uses process.kill(pid as number, \"SIGTERM\") — TS cast unwrapped to root identifier", () => {
      // ALLOWED narrow (cycle-3 reviewer probe): the test captures
      // `const pid = readPidFromFile() as number` AFTER the daemon
      // start, then registers cleanup that uses `pid as number` in
      // the kill call. The previous rule's
      // extractRootCaptureIdentifierName stopped at the
      // TSAsExpression and resolved the kill target to
      // UNVERIFIABLE_KILL_TARGET — rejecting the safe shape and
      // breaking the contract that legitimate cleanup must keep
      // working. The fix unwraps transparent TS wrappers
      // (TSAsExpression / TSNonNullExpression / TSTypeAssertion /
      // TSSatisfiesExpression / parens / chain wrappers) before
      // walking MemberExpression chains, so the root identifier is
      // recovered and the ownership predicate validates `pid`'s
      // declarator (which ends after the detached start begins).
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { readPidFromFile } from "./helpers/pid";

describe("cleanup closure uses TS cast in the kill call", () => {
  it("captures pid after the start and casts in the kill call", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile() as number;
    onTestFinished(() => process.kill(pid as number, "SIGTERM"));
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-bound-before-observation
    // (cycle-3: TS non-null assertion variant)
    it("does not flag runKspec(\"serve start --detach\") when pid is captured before cleanup and the callback uses process.kill(pid!, \"SIGTERM\") — TS non-null assertion unwrapped to root identifier", () => {
      // ALLOWED narrow: the TS non-null assertion `pid!` is another
      // transparent wrapper. The unwrap fixed-point loop strips it
      // (and the ChainExpression wrapper that some parsers emit
      // around the non-null assertion) before resolving the root
      // identifier. The capture-after-start ownership predicate then
      // accepts the binding.
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { readPidFromFile } from "./helpers/pid";

describe("cleanup closure uses TS non-null assertion in the kill call", () => {
  it("captures pid after the start and asserts non-null in the kill call", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => process.kill(pid!, "SIGTERM"));
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-bound-before-observation
    // (cycle-3: stacked transparent wrappers must all be unwrapped)
    it("does not flag runKspec(\"serve start --detach\") when the kill call uses ((pid as number)!) — stacked TS wrappers unwrapped", () => {
      // ALLOWED narrow: stacking TS assertion + non-null assertion
      // in parentheses still resolves to the underlying `pid`
      // identifier. The unwrap is a fixed-point loop precisely so
      // that wrapped wrappers don't escape the root extractor.
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { readPidFromFile } from "./helpers/pid";

describe("cleanup closure uses stacked TS wrappers in the kill call", () => {
  it("captures pid after the start and uses ((pid as number)!) in the kill call", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => process.kill(((pid as number)!), "SIGTERM"));
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-bound-before-observation
    // (cycle-3: TS-cast on a member-expression kill target — root
    // identifier still recovered and ownership validated)
    it("flags runKspec(\"serve start --detach\") when the kill call uses (holder.pid as number) and `holder` predates the daemon start", () => {
      // UNSAFE: combining a member-expression kill target with a TS
      // cast must still resolve to the root identifier `holder`,
      // which the ownership predicate rejects because `holder` is
      // declared before the start. The fix unwraps the TS cast at
      // every level of the descent, so a wrapped MemberExpression
      // does not escape the chain walk.
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";

describe("cleanup closure uses a TS-asserted member kill target rooted in a pre-start binding", () => {
  it("declares holder before the start and asserts in the kill call", () => {
    const holder = {} as { pid?: number };
    runKspec("serve start --detach --port 3456");
    onTestFinished(() => process.kill((holder.pid as number), "SIGTERM"));
    expect(true).toBe(true);
    holder.pid = 12345;
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("holder");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-bound-before-observation
    // (allowed-narrow: member-expression kill target rooted in the spawn
    // child handle whose declarator IS the detached daemon start)
    it("does not flag spawn(\"kspec\", [\"serve\", \"start\", \"--detach\"]) when onTestFinished kills via process.kill(child.pid, \"SIGTERM\") and `child` is captured by the spawn statement", () => {
      // ALLOWED narrow: the cleanup uses a MemberExpression kill target
      // `child.pid`, but the root `child` is bound by `const child =
      // spawn("kspec", ["serve", "start", "--detach"])` — the
      // declarator's range encompasses the detached-start expression,
      // so the ownership predicate accepts the binding. The fix must
      // continue to accept this shape without over-tightening so the
      // canonical spawn-handle cleanup pattern keeps working with
      // either `child.kill("SIGTERM")` or `process.kill(child.pid,
      // "SIGTERM")` as the call form.
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";
import { spawn } from "child_process";

describe("cleanup closure captures process.kill(child.pid) where child IS the spawn", () => {
  it("captures child via const, registers process.kill(child.pid) cleanup, then asserts", () => {
    const child = spawn("kspec", ["serve", "start", "--detach", "--port", "3456"]);
    onTestFinished(() => process.kill(child.pid, "SIGTERM"));
    expect(child.pid).toBeDefined();
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });
  });
});

/**
 * Daemon test guardrail precision: approved daemon helper boundary is
 * explicit.
 *
 * These tests cover @daemon-test-guardrail-precision
 * `ac-approved-daemon-helper-boundary-explicit`. The earlier helper
 * coverage relied on the rule's path allowlist
 * (`tests/helpers/daemon.ts`, `tests/helpers/mock-daemon.ts`,
 * `tools/eslint-rules/`, the lint test files themselves) to identify
 * approved daemon-test fixtures. The tightened AC requires the
 * approved-helper boundary to be EXPLICIT: a local helper function
 * declared inside an ordinary test file is NOT an approved helper,
 * and wrapping a detached daemon start (via the kspec CLI) inside
 * such a helper must NOT make the start invisible to the rule.
 *
 * The current `no-leaky-test-daemon` rule's `isInHelperFunction`
 * predicate exempts ANY named function declaration or arrow assigned
 * to a const/let from the cleanup-timing check as long as the
 * function does not cross an it/test/describe/lifecycle boundary.
 * That predicate was too permissive: it treated the mere PRESENCE of a
 * helper-shaped function as proof that some caller would register
 * cleanup, but the rule never actually verified cleanup at the call
 * site. The lint-rule fix that closed
 * `ac-approved-daemon-helper-boundary-explicit` removes the local-
 * helper exemption from the cleanup-timing path entirely: only the
 * path allowlist (`tests/helpers/daemon.ts`,
 * `tests/helpers/mock-daemon.ts`, `tools/eslint-rules/`, and the lint
 * test files) marks an approved daemon-test fixture. A detached start
 * inside a local function declaration / arrow / function expression in
 * an ordinary test file now produces a `localWrapperUnsafe`
 * diagnostic and the assertions hold. The tests are therefore plain
 * `it(...)` again.
 *
 * Allowed-narrow cases describe the canonical safe shapes (the
 * shared `tests/helpers/daemon.ts` fixture, which is path-allowlisted
 * and therefore exempt from the rule entirely) so the fix cannot
 * accidentally over-tighten and reject the genuinely-approved fixture
 * implementations. They use plain `it(...)` because they pass today
 * and must still pass after the fix.
 *
 * Note: direct daemon entrypoint launches (`spawn("node", [DAEMON_ENTRY,
 * ...])`) inside a local helper function are ALREADY flagged by the
 * existing direct-daemon-spawn check, which runs at the CallExpression
 * before the helper-function exemption applies. That shape is
 * therefore existing-pass control coverage (see the `direct daemon
 * spawn is flagged outside the shared fixture` describe block above)
 * and is intentionally NOT duplicated here as a new failing
 * regression.
 */
describe("daemon test guardrail precision: approved helper boundary is explicit", () => {
  // AC: @daemon-test-guardrail-precision ac-approved-daemon-helper-boundary-explicit
  describe("local wrappers around detached daemon starts are not approved helpers", () => {
    it("flags a function declaration in a test file that wraps runKspec(\"serve start --detach\") with no caller cleanup", () => {
      // UNSAFE: the test file declares `function startDetachedDaemon()`
      // whose body calls `runKspec("serve start --detach ...")`. The
      // call site invokes the helper but registers no cleanup. The
      // current rule sees the detached start INSIDE a named function
      // declaration, treats it as inside a helper, and skips the
      // missing-cleanup check entirely — even though the wrapper is
      // not the approved shared fixture. The detached daemon leaks.
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";

function startDetachedDaemon() {
  runKspec("serve start --detach --port 3456");
}

describe("local function wrapper hides detached start", () => {
  it("calls the wrapper without cleanup", () => {
    startDetachedDaemon();
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/serve start --detach|shared daemon fixture|startTestDaemon|scoped cleanup|approved helper/i);
    });

    it("flags a const arrow function in a test file that wraps spawn(\"kspec\", [\"serve\", \"start\", \"--detach\"]) with no caller cleanup", () => {
      // UNSAFE: the const-arrow form of the local wrapper (the rule's
      // `isInHelperFunction` predicate also matches
      // `VariableDeclarator` initialisers with arrow/function values).
      // The argv-array spawn form is wrapped behind the arrow, the
      // call site calls the arrow without cleanup, and the rule
      // currently misses the unsafe start.
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { spawn } from "child_process";

const startDetachedDaemon = () => {
  spawn("kspec", ["serve", "start", "--detach", "--port", "3456"]);
};

describe("const arrow wrapper hides detached spawn", () => {
  it("calls the arrow wrapper without cleanup", () => {
    startDetachedDaemon();
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/serve start --detach|shared daemon fixture|startTestDaemon|scoped cleanup|approved helper/i);
    });

    it("flags a function declaration in a test file that wraps execSync(\"kspec serve start --detach\") with no caller cleanup", () => {
      // UNSAFE: shell-string CLI form of the wrapper. The execSync call
      // tokenises to `kspec serve start --detach`, the rule's detach
      // classifier recognises the lifecycle path, but the helper-
      // function exemption swallows the report. The wrapper is not
      // the approved fixture and the call site provides no cleanup.
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { execSync } from "child_process";

function startDetachedDaemon() {
  execSync("kspec serve start --detach --port 3456");
}

describe("execSync wrapper hides detached start", () => {
  it("calls the execSync wrapper without cleanup", () => {
    startDetachedDaemon();
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/serve start --detach|shared daemon fixture|startTestDaemon|scoped cleanup|approved helper/i);
    });

    it("flags a function expression assigned to a const in a test file that wraps spawnSync(\"kspec\", [\"serve\", \"start\", \"--detach\"]) with no caller cleanup", () => {
      // UNSAFE: function-expression-in-VariableDeclarator form (the
      // rule's `isInHelperFunction` matches `init.type ===
      // "FunctionExpression"` too). spawnSync argv-array form behind
      // the wrapper. Caller registers no cleanup.
      const result = runOxlint({
        source: `
import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";

const startDetachedDaemon = function () {
  spawnSync("kspec", ["serve", "start", "--detach", "--port", "3456"]);
};

describe("function expression wrapper hides detached spawnSync", () => {
  it("calls the function-expression wrapper without cleanup", () => {
    startDetachedDaemon();
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/serve start --detach|shared daemon fixture|startTestDaemon|scoped cleanup|approved helper/i);
    });

    // AC: @daemon-test-guardrail-precision ac-approved-daemon-helper-boundary-explicit
    // (allowed narrow case: explicit shared fixture path)
    it("does not flag a function declaration that wraps spawn(\"kspec\", [\"serve\", \"start\", \"--detach\"]) inside the shared daemon fixture (tests/helpers/daemon.ts)", () => {
      // ALLOWED narrow: the shared fixture implementation lives at
      // `tests/helpers/daemon.ts`, which is on the rule's explicit
      // path allowlist. The rule never runs in that file at all, so
      // the wrapper there is genuinely an approved helper and the
      // detached start is not flagged. This control test must keep
      // passing after the fix — the boundary tightening is for
      // arbitrary local wrappers in ordinary test files, not the
      // approved fixture file.
      const result = runOxlint({
        relPath: "tests/helpers/daemon.ts",
        source: `
import { spawn } from "child_process";

export function startTestDaemon(port: number) {
  return spawn("kspec", ["serve", "start", "--detach", "--port", String(port)]);
}
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-approved-daemon-helper-boundary-explicit
    // (allowed narrow case: inline detached start with proper cleanup is unchanged)
    it("does not flag an inline runKspec(\"serve start --detach\") in a test body when pid is captured and onTestFinished cleanup is registered before any observation", () => {
      // ALLOWED narrow: the canonical safe inline shape — no wrapper,
      // pid captured inline, cleanup registered before any observation.
      // The fix to the wrapper boundary must not regress this baseline.
      const result = runOxlint({
        source: `
import { describe, it, expect, onTestFinished } from "vitest";

describe("inline detached start with proper cleanup", () => {
  it("starts daemon, captures pid, registers cleanup, then asserts", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => process.kill(pid, "SIGTERM"));
    expect(true).toBe(true);
  });
});
`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });
  });
});
