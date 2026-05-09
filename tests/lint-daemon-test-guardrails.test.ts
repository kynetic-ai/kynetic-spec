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
 * Today, the rule still has the gap, so those assertions throw. This
 * helper catches that failure and then re-asserts the EXACT current gap
 * shape via `assertKnownGapShape` — so a generic parser/helper failure
 * (which would also throw inside `assertPostFixBehavior`) cannot satisfy
 * the regression by accident: such a failure would not match the known
 * gap shape and would re-throw.
 *
 * When the dependent rule fix lands, `assertPostFixBehavior` succeeds, the
 * catch block does not run, and this helper throws to force the dependent
 * task to remove the helper wrapper and let the post-fix assertions stand
 * on their own.
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
    // gap and not an unrelated oxlint or helper error — any assertion
    // failure here re-throws and fails the test.
    assertKnownGapShape();
  }
  if (postFixPassed) {
    throw new Error(
      "Classifier no longer exhibits the captured gap. " +
        "Remove expectClassifierGap() and let the post-fix assertions stand.",
    );
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
 * The unsafe regression cases are written as failing-before-fix assertions
 * inside `expectClassifierGap()` (the same helper used by the classifier
 * regressions earlier in this file). The helper:
 *
 *   1. Calls `expectOxlintRanCleanly` to confirm oxlint exited with a
 *      diagnostics-shaped exit code (0 or 1) and emitted no parser, helper,
 *      or panic output. This is the precondition that bare `it.fails()`
 *      cannot enforce — under `it.fails`, ANY thrown assertion in the body
 *      counts as the expected failure, so an unrelated oxlint crash can
 *      satisfy the regression by accident.
 *
 *   2. Runs the AC's required post-fix assertions (the rule MUST report
 *      the unsafe cleanup-timing shape, exit non-zero, mention
 *      no-leaky-test-daemon, and reference the safe-shape vocabulary).
 *      Today these assertions throw because the rule still treats the
 *      ancestor `afterEach` with a kill pattern as proof of cleanup.
 *
 *   3. On that throw, asserts the EXACT current gap shape (oxlint exits 0
 *      and emits no `no-leaky-test-daemon` diagnostic). A generic
 *      parser/helper failure does NOT match the known gap shape and
 *      re-throws, so the regression cannot pass for reasons unrelated to
 *      the cleanup-timing gap.
 *
 *   4. When @task-fix-detached-cleanup-timing-analysis lands and the
 *      post-fix assertions begin to succeed, the helper itself throws to
 *      force that task to remove the `expectClassifierGap()` wrapper and
 *      let the post-fix assertions stand on their own.
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
      expectClassifierGap(
        result,
        () => {
          // Post-fix: the rule must report this detached start because
          // pid capture (and therefore cleanup binding) does not happen
          // until after the intervening expect().
          expect(result.exitCode).not.toBe(0);
          expect(result.output).toContain("no-leaky-test-daemon");
          expect(result.output).toMatch(/serve start --detach|scoped cleanup|onTestFinished/i);
        },
        () => {
          // Known gap today: the rule treats the ancestor afterEach with
          // a process.kill pattern as proof of cleanup and silently
          // accepts the detached start. No diagnostic emitted.
          expect(result.exitCode).toBe(0);
          expect(result.output).not.toContain("no-leaky-test-daemon");
        },
      );
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
      expectClassifierGap(
        result,
        () => {
          // Post-fix: the rule must report this detached start because
          // the awaited probe runs before the pid binding is complete.
          expect(result.exitCode).not.toBe(0);
          expect(result.output).toContain("no-leaky-test-daemon");
          expect(result.output).toMatch(/serve start --detach|scoped cleanup|onTestFinished/i);
        },
        () => {
          // Known gap today: the rule accepts the ancestor afterEach as
          // proof of cleanup despite the intervening await. No diagnostic.
          expect(result.exitCode).toBe(0);
          expect(result.output).not.toContain("no-leaky-test-daemon");
        },
      );
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
      expectClassifierGap(
        result,
        () => {
          // Post-fix: the rule must report this spawn() because the
          // child-handle binding does not happen until after the await.
          expect(result.exitCode).not.toBe(0);
          expect(result.output).toContain("no-leaky-test-daemon");
          expect(result.output).toMatch(/serve start --detach|scoped cleanup|onTestFinished/i);
        },
        () => {
          // Known gap today: the rule accepts the ancestor afterEach
          // closing over `child` as proof of cleanup, regardless of when
          // the binding actually completes. No diagnostic emitted.
          expect(result.exitCode).toBe(0);
          expect(result.output).not.toContain("no-leaky-test-daemon");
        },
      );
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
      expectClassifierGap(
        result,
        () => {
          // Post-fix: the disable applies only to the next line (the
          // `const noop` declaration). The detached start two lines down
          // is unrelated to the directive and must still be reported by
          // the cleanup-timing rule, so the disable misplacement cannot
          // bypass enforcement.
          expect(result.exitCode).not.toBe(0);
          expect(result.output).toContain("no-leaky-test-daemon");
          expect(result.output).toMatch(/serve start --detach|scoped cleanup|onTestFinished/i);
        },
        () => {
          // Known gap today: the underlying cleanup-timing analysis does
          // not report this shape at all (ancestor afterEach with kill
          // pattern is treated as cleanup), so disable placement is moot
          // and oxlint exits 0 with no diagnostic.
          expect(result.exitCode).toBe(0);
          expect(result.output).not.toContain("no-leaky-test-daemon");
        },
      );
    });
  });
});
