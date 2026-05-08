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
  // AC: @daemon-test-guardrail-precision ac-unrelated-subprocesses-not-reported
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
 * incidental token sequences. They are written as failing-before-fix
 * regressions that capture today's known classifier gaps:
 *
 *   1. Direct daemon entrypoint invocation through child-process APIs
 *      beyond `spawn` / `spawnSync`. The current `readDaemonSpawn`
 *      implementation only inspects `spawn` / `spawnSync`, so
 *      `fork("dist/daemon/index.js", ...)` and exec-file style calls that
 *      launch the daemon entrypoint are silently allowed even though the
 *      AC says any direct daemon-entrypoint start outside the approved
 *      helper paths must be reported.
 *
 *   2. Detached-serve detection that fires on any subprocess whose argv
 *      argument array happens to contain the words "serve", "start", and
 *      "--detach", regardless of whether the executable is actually a
 *      kspec lifecycle command. The AC requires the guardrail to ignore
 *      unrelated subprocesses with coincidentally overlapping argv tokens.
 *
 * Each test runs the AC's required post-fix assertions (exit code AND rule
 * name AND, where appropriate, message fragment) inside the helper
 * `expectClassifierGap`. Today those assertions throw, the helper validates
 * the failure shape against the EXACT current classifier gap, and the test
 * passes. A generic parser/helper failure does NOT match the known gap
 * shape and re-throws — so an unrelated oxlint crash cannot satisfy the
 * regression by accident (this is the explicit task contract, and it is
 * what bare `it.fails()` could not enforce: under `it.fails`, ANY thrown
 * assertion in the body counts as the expected failure, including a
 * precondition failure caused by an unrelated parser crash).
 *
 * The plan deliberately splits regressions and the rule fix across two
 * tasks (@task-add-guardrail-classification-regressions and
 * @task-fix-guardrail-daemon-command-classification). The
 * `expectClassifierGap` wrapper is the forcing function: once the rule fix
 * lands, the post-fix assertions succeed, the catch block does not run,
 * and the helper throws to force the dependent task to remove the wrapper
 * and let the post-fix assertions stand on their own. Do not silence by
 * deleting the test — remove `expectClassifierGap(...)` and inline its
 * `assertPostFixBehavior` callback into the test body.
 */

/**
 * Asserts that oxlint itself ran without a parser, helper, or internal
 * failure. Used as the precondition for every classifier-gap regression so
 * that an unrelated oxlint crash cannot satisfy the bug-shape assertions
 * that follow. Exit code 0 means "no diagnostics" and exit code 1 means
 * "rule diagnostics emitted"; any other exit code, or any error/panic
 * fragment in the output, is treated as a parser/helper failure that
 * invalidates the regression.
 */
function expectOxlintRanCleanly(result: OxlintResult): void {
  expect([0, 1]).toContain(result.exitCode);
  expect(result.output).not.toMatch(
    /panic|panicked|internal error|failed to parse|parse error|cannot find|module not found|enoent/i,
  );
}

/**
 * Selective expected-failure helper for classifier-gap regressions.
 *
 * The test asserts the AC's post-fix behavior via `assertPostFixBehavior`.
 * Today, the rule still has the classifier gap, so those assertions throw.
 * This helper catches that failure and then re-asserts the EXACT current
 * gap shape via `assertKnownGapShape` — so a generic parser/helper failure
 * (which would also throw inside `assertPostFixBehavior`) cannot satisfy
 * the regression by accident: such a failure would not match the known
 * gap shape and would re-throw.
 *
 * When the dependent rule fix lands, `assertPostFixBehavior` succeeds, the
 * catch block does not run, and this helper throws to force the dependent
 * task (@task-fix-guardrail-daemon-command-classification) to remove the
 * helper wrapper and let the post-fix assertions stand on their own.
 */
function expectClassifierGap(
  result: OxlintResult,
  assertPostFixBehavior: () => void,
  assertKnownGapShape: () => void,
): void {
  expectOxlintRanCleanly(result);
  let postFixPassed = false;
  try {
    assertPostFixBehavior();
    postFixPassed = true;
  } catch {
    // Expected failure today. Verify the failure shape is the known
    // classifier gap and not an unrelated oxlint or helper error — any
    // assertion failure here re-throws and fails the test.
    assertKnownGapShape();
  }
  if (postFixPassed) {
    throw new Error(
      "Classifier no longer exhibits the captured gap. " +
        "Remove expectClassifierGap() and let the post-fix assertions stand " +
        "(see @task-fix-guardrail-daemon-command-classification).",
    );
  }
}

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
      expectClassifierGap(
        result,
        () => {
          // Post-fix: the rule must report this fork() as a direct daemon
          // entrypoint invocation outside the approved helper paths.
          expect(result.exitCode).not.toBe(0);
          expect(result.output).toContain("no-leaky-test-daemon");
          expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
        },
        () => {
          // Known gap today: readDaemonSpawn only handles spawn/spawnSync,
          // so fork() is silently allowed. No diagnostic emitted.
          expect(result.exitCode).toBe(0);
          expect(result.output).not.toContain("no-leaky-test-daemon");
        },
      );
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
      expectClassifierGap(
        result,
        () => {
          expect(result.exitCode).not.toBe(0);
          expect(result.output).toContain("no-leaky-test-daemon");
          expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
        },
        () => {
          expect(result.exitCode).toBe(0);
          expect(result.output).not.toContain("no-leaky-test-daemon");
        },
      );
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
      expectClassifierGap(
        result,
        () => {
          expect(result.exitCode).not.toBe(0);
          expect(result.output).toContain("no-leaky-test-daemon");
          expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
        },
        () => {
          expect(result.exitCode).toBe(0);
          expect(result.output).not.toContain("no-leaky-test-daemon");
        },
      );
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
      expectClassifierGap(
        result,
        () => {
          expect(result.exitCode).not.toBe(0);
          expect(result.output).toContain("no-leaky-test-daemon");
          expect(result.output).toMatch(/shared daemon fixture|startTestDaemon/i);
        },
        () => {
          expect(result.exitCode).toBe(0);
          expect(result.output).not.toContain("no-leaky-test-daemon");
        },
      );
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
      expectClassifierGap(
        result,
        () => {
          // Post-fix: the rule must ignore this — echo is not a kspec
          // lifecycle command, so the overlapping argv tokens are
          // coincidental and must not produce a diagnostic.
          expect(result.exitCode).toBe(0);
          expect(result.output).not.toContain("no-leaky-test-daemon");
        },
        () => {
          // Known gap today: argsResolveToDetachedServe scans all argv
          // tokens regardless of executable, so echo is incorrectly
          // flagged.
          expect(result.exitCode).not.toBe(0);
          expect(result.output).toContain("no-leaky-test-daemon");
        },
      );
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
      expectClassifierGap(
        result,
        () => {
          expect(result.exitCode).toBe(0);
          expect(result.output).not.toContain("no-leaky-test-daemon");
        },
        () => {
          expect(result.exitCode).not.toBe(0);
          expect(result.output).toContain("no-leaky-test-daemon");
        },
      );
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
 * The unsafe regression cases are written as failing-before-fix
 * assertions and marked with `it.fails`: today's rule treats the ancestor
 * `afterEach` with a kill pattern as proof of cleanup, so the cases here
 * pass through unflagged and the assertions throw. `it.fails` inverts the
 * pass/fail signal so the suite stays green while the rule has the gap
 * AND fails loudly the moment the dependent rule fix in
 * @task-fix-detached-cleanup-timing-analysis lands and the unsafe cases
 * begin to be reported — that is the cue to drop the `.fails` marker.
 *
 * The allowed-narrow cases describe the canonical safe shape (capture pid
 * or child handle inline, register cleanup before any await/expect) so
 * the fix cannot accidentally over-tighten and reject legitimate patterns.
 */
describe("daemon test guardrail precision: detached cleanup timing", () => {
  // AC: @daemon-test-guardrail-precision ac-detached-cleanup-before-observation
  describe("detached daemon flagged when cleanup is not bound before later observations", () => {
    // Marked `it.fails`: passes today (rule does not yet flag this shape, so
    // the assertion below throws) and will fail the moment the dependent
    // rule fix begins reporting it — that is the cue to drop the marker.
    it.fails("flags runKspec(\"serve start --detach\") when an afterEach closes over a let pid that is assigned only after an expect()", () => {
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
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/serve start --detach|scoped cleanup|onTestFinished/i);
    });

    // Marked `it.fails`: passes today (rule gap) and will fail when the
    // dependent rule fix begins reporting this shape — drop the marker then.
    it.fails("flags runKspec(\"serve start --detach\") when an afterEach closes over a let pid that is assigned only after an awaited probe", () => {
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
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/serve start --detach|scoped cleanup|onTestFinished/i);
    });

    // Marked `it.fails`: passes today (rule gap) and will fail when the
    // dependent rule fix begins reporting this shape — drop the marker then.
    it.fails("flags spawn(\"kspec\", [\"serve\", \"start\", \"--detach\"]) when an afterEach closes over a let child that is assigned only after an awaited probe", () => {
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

    // Marked `it.fails`: passes today (the detached-start cleanup-timing
    // gap means the rule does not flag this shape regardless of the
    // disable placement) and will fail when the dependent rule fix begins
    // reporting the underlying detached start — drop the marker then.
    it.fails("does not silence the offending detached start when an oxlint-disable-next-line sits above an unrelated preceding statement", () => {
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
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toMatch(/serve start --detach|scoped cleanup|onTestFinished/i);
    });
  });
});
