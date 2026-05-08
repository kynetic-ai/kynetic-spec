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
 * Each assertion checks the lint exit code AND the relevant rule name (and,
 * for positive cases, a specific message fragment) so that a generic parser
 * failure cannot satisfy the test by accident.
 *
 * MERGE GATE NOTE — these cases use `it.fails()` so that today's rule gaps
 * are captured as live regressions WITHOUT introducing a `npm test` failure
 * on the branch that advances to `dev`. The plan deliberately splits
 * regressions and the rule fix across two tasks
 * (@task-add-guardrail-classification-regressions and
 * @task-fix-guardrail-daemon-command-classification) so the rule cannot be
 * silently weakened to make existing examples pass. The expected-failure
 * markers act as the forcing function: once the rule fix lands, each
 * assertion will succeed, the `it.fails()` modifier will itself fail, and
 * the dependent task MUST remove the `.fails()` modifier from each `it`
 * below to close the regression. Do not silence by deleting the test —
 * convert `it.fails(...)` back to `it(...)`.
 */
describe("daemon test guardrail precision", () => {
  // AC: @daemon-test-guardrail-precision ac-direct-daemon-entry-invocations-flagged
  // AC: @daemon-test-harness-guardrails ac-direct-daemon-spawn-flagged
  describe("direct daemon entry via non-spawn child-process APIs is flagged", () => {
    it.fails("flags fork(\"dist/daemon/index.js\", ...) as a direct daemon entrypoint invocation", () => {
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

    it.fails("flags fork(DAEMON_ENTRY, ...) as a direct daemon entrypoint invocation", () => {
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

    it.fails("flags execFile(\"node\", [\"dist/daemon/index.js\", ...]) as a direct daemon entry invocation", () => {
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

    it.fails("flags execFileSync(\"node\", [DAEMON_ENTRY, ...]) as a direct daemon entry invocation", () => {
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
  });

  // AC: @daemon-test-guardrail-precision ac-unrelated-subprocesses-not-reported
  describe("non-kspec subprocesses are not reported as daemon lifecycle violations", () => {
    it.fails("does not flag spawn(\"echo\", [\"serve\", \"start\", \"--detach\"]) — argv tokens overlap but executable is unrelated", () => {
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

    it.fails("does not flag spawnSync(\"git\", [\"log\", \"serve\", \"start\", \"--detach\"]) — git is not a kspec lifecycle command", () => {
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
  });
});
