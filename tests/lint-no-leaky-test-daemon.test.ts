/**
 * Tests for the no-leaky-test-daemon oxlint rule.
 *
 * Covers the behavior shared with the daemon test harness guardrails:
 *   - Detached CLI daemon starts (`runKspec("serve start --detach")`,
 *     `execSync(...)`, etc.) without scoped cleanup are flagged. Tests
 *     of the CLI's own --detach behavior keep the cleanup escape hatch.
 *   - Direct daemon spawn (`spawn(_, [DAEMON_ENTRY, ...])`) is always
 *     flagged in non-helper test paths regardless of cleanup, because
 *     the shared fixture is the sanctioned startup path.
 *
 * The guardrail-specific semantics for the wider fixture contract live in
 * tests/lint-daemon-test-guardrails.test.ts so the AC annotations for
 * @daemon-test-harness-guardrails stay grouped there. The cases here that
 * cover the same lint rule behavior reuse fixture strings that name a
 * specific concrete scenario (e.g. cleanup placement, callee shape).
 */

import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
function runOxlint(fileContent: string): { exitCode: number; output: string } {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "lint-test-"));
  // Place the synthetic test file under tests/ so the rule's path-based
  // helper allowlist (tests/helpers/, tools/eslint-rules/, etc.) does not
  // accidentally exempt the input — the override below only matches the
  // tests/ glob and the file must therefore be under that root.
  const testFile = path.join(tempDir, "tests", "synthetic-test.ts");
  fs.mkdirSync(path.dirname(testFile), { recursive: true });
  const projectRoot = path.resolve(__dirname, "..");
  const pluginPath = path.resolve(projectRoot, "tools/eslint-rules/no-leaky-test-daemon.js");
  const config = {
    plugins: ["typescript"],
    overrides: [
      {
        files: ["tests/**/*.ts"],
        jsPlugins: [pluginPath],
        rules: {
          "no-leaky-test-daemon/no-leaky-test-daemon": "error",
        },
      },
    ],
  };
  const configFile = path.join(tempDir, ".oxlintrc.json");
  writeFileSync(configFile, JSON.stringify(config));
  writeFileSync(testFile, fileContent);

  try {
    const output = execSync(`npx oxlint --config ${configFile} ${testFile}`, {
      cwd: projectRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    rmSync(tempDir, { recursive: true, force: true });
    return { exitCode: 0, output };
  } catch (err: unknown) {
    const error = err as { status: number; stdout: string; stderr: string };
    const output = (error.stdout || "") + (error.stderr || "");
    rmSync(tempDir, { recursive: true, force: true });
    return { exitCode: error.status, output };
  }
}

describe("no-leaky-test-daemon lint rule", () => {
  describe("positive cases (should flag)", () => {
    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    it("should flag runKspec with serve start --detach and no cleanup", () => {
      const result = runOxlint(`
import { describe, it, expect } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("onTestFinished");
    });

    it("should flag template literal with serve start --detach and no cleanup", () => {
      const result = runOxlint(`
import { describe, it, expect } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    const port = 3456;
    runKspec(\`serve start --detach --port \${port}\`);
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-harness-guardrails ac-direct-daemon-spawn-flagged
    it("should flag spawn with DAEMON_ENTRY and no cleanup", () => {
      const result = runOxlint(`
import { describe, it, expect } from "vitest";
import { spawn } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";

describe("test suite", () => {
  it("should spawn daemon", () => {
    const child = spawn("node", [DAEMON_ENTRY, "--port", "3456"]);
    expect(child.pid).toBeDefined();
  });
});
`);
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    it("should flag execSync with serve start --detach and no cleanup", () => {
      const result = runOxlint(`
import { describe, it, expect } from "vitest";
import { execSync } from "child_process";

describe("test suite", () => {
  it("should start daemon via exec", () => {
    execSync("kspec serve start --detach --port 3456");
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-harness-guardrails ac-direct-daemon-spawn-flagged
    it("should flag spawn with dist/daemon/index.js string literal and no cleanup", () => {
      const result = runOxlint(`
import { describe, it, expect } from "vitest";
import { spawn } from "child_process";

describe("test suite", () => {
  it("should spawn daemon", () => {
    const child = spawn("node", ["dist/daemon/index.js", "--port", "3456"]);
    expect(child.pid).toBeDefined();
  });
});
`);
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    // Blocker 1 repro: unrelated afterEach with generic 'stop' should not count as cleanup
    it("should flag serve start --detach when afterEach only stops an unrelated fixture", () => {
      const result = runOxlint(`
import { describe, it, expect, afterEach } from "vitest";

describe("test suite", () => {
  afterEach(() => stopUnrelatedFixture());

  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    // Blocker 2 repro: cleanup registered after an await is too late
    it("should flag serve start --detach when cleanup is registered after an await", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

describe("test suite", () => {
  it("should start daemon", async () => {
    runKspec("serve start --detach --port 3456");
    await somethingAsync();
    onTestFinished(() => process.kill(pid, "SIGTERM"));
  });
});
`);
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    // Blocker 2 variant: cleanup after expect is too late
    it("should flag serve start --detach when cleanup is registered after an expect", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    expect(true).toBe(true);
    onTestFinished(() => process.kill(pid, "SIGTERM"));
  });
});
`);
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    // Blocker 2 (cycle 2): try/finally with unrelated teardown is not daemon cleanup
    it("should flag serve start --detach in try/finally with only unrelated teardown", () => {
      const result = runOxlint(`
import { describe, it, expect } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    try {
      runKspec("serve start --detach --port 3456");
      expect(true).toBe(true);
    } finally {
      stopUnrelatedFixture();
    }
  });
});
`);
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-before-observation
    // Cycle 13 blocker: an in-flow `onTestFinished(...)` whose callback
    // only tears down an unrelated fixture is NOT cleanup for the
    // detached daemon. The `onTestFinished` substring is present, but the
    // callback never kills the daemon — a registration-name match would
    // silently accept a leak. The cleanup-timing predicate must require a
    // daemon-specific kill/stop pattern (`process.kill`, `SIGTERM`,
    // `killPid`, `stopDaemon`, `serve stop`, etc.) inside the statement.
    it("should flag serve start --detach when in-flow onTestFinished only tears down an unrelated fixture", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    onTestFinished(() => stopUnrelatedFixture());
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-before-observation
    // Companion to the unrelated-fixture case: an in-flow afterEach-style
    // registration whose callback closes a network blocker (no kill, no
    // stop) is also not daemon cleanup, so the detached start must still
    // be reported.
    it("should flag serve start --detach when in-flow onTestFinished only closes a network blocker", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    onTestFinished(() => blocker.close());
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-before-observation
    // Cycle-2 reviewer probe (1): a `console.log("SIGTERM docs")` between
    // the detached start and the next observation contains the literal
    // SIGTERM substring as DATA inside a string literal, but the only
    // CallExpression is `console.log(...)`. Token-only text matching
    // accepted this as cleanup — the AST-based predicate must reject it
    // because no daemon-shaped CallExpression is registered.
    it("should flag serve start --detach when the only later statement is console.log of a SIGTERM-text string", () => {
      const result = runOxlint(`
import { describe, it, expect } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    console.log("SIGTERM docs");
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-before-observation
    // Cycle-2 reviewer probe (2): a string-literal binding whose initializer
    // text contains `killPid` is NOT a cleanup registration. The token-only
    // text scan accepted this; the AST-based predicate rejects it because
    // a VariableDeclaration with a string initializer has no daemon-shaped
    // CallExpression.
    it("should flag serve start --detach when the only later statement binds a string literal containing 'killPid'", () => {
      const result = runOxlint(`
import { describe, it, expect } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const cleanupDocs = "killPid should be used later";
    expect(cleanupDocs).toBe("killPid should be used later");
  });
});
`);
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-before-observation
    // Cycle-2 reviewer probe (3): a try/finally finalizer whose only
    // statement is a `console.log("SIGTERM docs")` does not actually kill
    // the daemon — the SIGTERM substring is data inside a string literal.
    // The text-based finalizer scan was accepting this; the AST-based
    // walker must reject it because the finalizer subtree contains no
    // daemon-cleanup CallExpression.
    it("should flag serve start --detach in try/finally whose finalizer only logs a SIGTERM-text string", () => {
      const result = runOxlint(`
import { describe, it, expect } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    try {
      runKspec("serve start --detach --port 3456");
      expect(true).toBe(true);
    } finally {
      console.log("SIGTERM docs");
    }
  });
});
`);
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-before-observation
    // Cycle-3 reviewer probe: a `const cleanup = () => killPid(pid);`
    // declaration between the detached start and the next observation
    // contains a daemon-shaped `killPid(pid)` CallExpression in the arrow
    // body — but the arrow is bound to `cleanup` and never invoked, so the
    // detached daemon is leaked when the assertion runs. The cycle-2
    // walker descended into all function/arrow bodies and accepted the
    // unregistered arrow as cleanup; the gated walker must stop at the
    // arrow because its parent is a VariableDeclarator (not a recognised
    // cleanup-registration call) and report the missing-cleanup
    // violation.
    it("should flag serve start --detach when a later statement is a const arrow cleanup that is never registered", () => {
      const result = runOxlint(`
import { describe, it, expect } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    const result = runKspec("serve start --detach --port 3456");
    const cleanup = () => killPid(result.pid);
    expect(cleanup).toBeDefined();
  });
});
`);
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-before-observation
    // Cycle-3 variant (named function declaration): a `function later() {
    // killPid(pid); }` declaration after the detached start defines a kill
    // call but never invokes it. The walker must stop at the
    // FunctionDeclaration body (its parent is a BlockStatement, not a
    // registration call) so the missing-cleanup violation fires.
    it("should flag serve start --detach when a later statement is a named function that is never invoked", () => {
      const result = runOxlint(`
import { describe, it, expect } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    const result = runKspec("serve start --detach --port 3456");
    function later() {
      killPid(result.pid);
    }
    expect(later).toBeDefined();
  });
});
`);
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-before-observation
    // Cycle-3 variant (callback to unrelated callee): an arrow passed to
    // `console.log` is never invoked as cleanup — `console.log` does not
    // run its argument as a teardown callback. The walker must stop at
    // the arrow because its parent CallExpression's callee is `console`
    // .log, not a recognised cleanup-registration wrapper.
    it("should flag serve start --detach when the only later statement passes a kill arrow to an unrelated callee", () => {
      const result = runOxlint(`
import { describe, it, expect } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    const result = runKspec("serve start --detach --port 3456");
    console.log(() => killPid(result.pid));
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-before-observation
    // Cycle-3 variant (try/finally finalizer with unregistered arrow):
    // the finalizer defines a `const cleanup = () => killPid(pid);` but
    // never calls it — the kill is stored, not executed. The
    // try/finally-finalizer subtree walker uses the same gated descent as
    // the in-flow walker, so this must still report the missing cleanup.
    it("should flag serve start --detach in try/finally whose finalizer only declares an unregistered cleanup arrow", () => {
      const result = runOxlint(`
import { describe, it, expect } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    try {
      const result = runKspec("serve start --detach --port 3456");
      expect(result).toBeDefined();
    } finally {
      const cleanup = () => killPid(result.pid);
      expect(cleanup).toBeDefined();
    }
  });
});
`);
      expect(result.output).toContain("no-leaky-test-daemon");
    });
  });

  describe("negative cases (should NOT flag)", () => {
    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // (negative case: cleanup is registered, so the rule must not flag)
    it("should allow serve start --detach with onTestFinished cleanup", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = 12345;
    onTestFinished(() => killPid(pid));
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-harness-guardrails ac-direct-daemon-spawn-flagged
    // Direct daemon spawn outside helper paths is flagged even when an
    // afterEach hook stops the child. The new strict semantic requires
    // tests to use the shared fixture or annotate a localized exception.
    it("should flag spawn with DAEMON_ENTRY in a non-helper file even when afterEach stops the child", () => {
      const result = runOxlint(`
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";

describe("test suite", () => {
  let child;
  afterEach(() => {
    if (child) child.kill("SIGTERM");
  });

  it("should spawn daemon", () => {
    child = spawn("node", [DAEMON_ENTRY, "--port", "3456"]);
    expect(child.pid).toBeDefined();
  });
});
`);
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-harness-guardrails ac-direct-daemon-spawn-flagged
    // A named helper function declared in a non-helper test file does not
    // exempt the spawn — the helper allowlist is path-based.
    it("should flag spawn in a named helper function inside a non-helper test file", () => {
      const result = runOxlint(`
import { describe, it, expect } from "vitest";
import { spawn } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";

function startDaemon(port) {
  return spawn("node", [DAEMON_ENTRY, "--port", String(port)]);
}

describe("test suite", () => {
  it("should spawn daemon", () => {
    const child = startDaemon(3456);
    expect(child.pid).toBeDefined();
  });
});
`);
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-harness-guardrails ac-direct-daemon-spawn-flagged
    it("should flag spawn in a named const arrow function inside a non-helper test file", () => {
      const result = runOxlint(`
import { describe, it, expect } from "vitest";
import { spawn } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";

const startDaemon = (port) => {
  return spawn("node", [DAEMON_ENTRY, "--port", String(port)]);
};

describe("test suite", () => {
  it("should spawn daemon", () => {
    const child = startDaemon(3456);
    expect(child.pid).toBeDefined();
  });
});
`);
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    it("should allow spawn for non-daemon binaries", () => {
      const result = runOxlint(`
import { describe, it, expect } from "vitest";
import { spawn } from "child_process";

describe("test suite", () => {
  it("should spawn a non-daemon process", () => {
    const child = spawn("node", ["some-script.js"]);
    expect(child.pid).toBeDefined();
  });
});
`);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("should allow serve start --detach in try/finally with cleanup", () => {
      const result = runOxlint(`
import { describe, it, expect } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    try {
      runKspec("serve start --detach --port 3456");
      expect(true).toBe(true);
    } finally {
      process.kill(pid, "SIGTERM");
    }
  });
});
`);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("should not flag kspec commands without --detach", () => {
      const result = runOxlint(`
import { describe, it, expect } from "vitest";

describe("test suite", () => {
  it("should start daemon in foreground", () => {
    runKspec("serve start --port 3456");
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-harness-guardrails ac-direct-daemon-spawn-flagged
    // Direct daemon spawn is flagged regardless of cleanup placement —
    // the escape hatch is the helper path allowlist or a localized
    // oxlint-disable, not a process.kill onTestFinished registration.
    it("should flag spawn with DAEMON_ENTRY even when paired with onTestFinished process.kill", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";
import { spawn } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";

describe("test suite", () => {
  it("should spawn daemon", () => {
    const child = spawn("node", [DAEMON_ENTRY, "--port", "3456"]);
    onTestFinished(() => process.kill(child.pid, "SIGTERM"));
    expect(child.pid).toBeDefined();
  });
});
`);
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    // Blocker (cycle 3): non-spawn callees with detach strings are not daemon spawns
    it("should not flag expect().toContain with serve start --detach string", () => {
      const result = runOxlint(`
import { describe, it, expect } from "vitest";

describe("test suite", () => {
  it("should verify command string", () => {
    const cmd = getCommand();
    expect(cmd).toContain("serve start --detach");
  });
});
`);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("should not flag console.log with serve start --detach string", () => {
      const result = runOxlint(`
import { describe, it, expect } from "vitest";

describe("test suite", () => {
  it("should log command", () => {
    console.log("serve start --detach --port 3456");
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-before-observation
    // The mere presence of an ancestor afterEach with a `process.kill`
    // pattern is NOT proof that this specific detached daemon is owned by
    // cleanup — the captured `pid` is bound only after `expect(...)`, so
    // an assertion failure leaves `pid` unset and the daemon is leaked.
    // Cleanup must be registered in the same control flow before the next
    // await/expect.
    it("should flag serve start --detach when afterEach closes over a pid bound only after a later expect()", () => {
      const result = runOxlint(`
import { describe, it, expect, afterEach } from "vitest";

describe("test suite", () => {
  let pid;
  afterEach(() => process.kill(pid));

  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    pid = 12345;
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-before-observation
    // Child-handle flavor of the same gap — afterEach closes over a
    // `child` binding that is not assigned until after the detached start
    // and a later expect(). The kill pattern in afterEach does not exempt
    // the unsafe binding ordering.
    it("should flag serve start --detach when afterEach closes over a child handle bound only after a later expect()", () => {
      const result = runOxlint(`
import { describe, it, expect, afterEach } from "vitest";

describe("test suite", () => {
  let child;
  afterEach(() => {
    if (child) child.kill("SIGTERM");
  });

  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    child = { pid: 12345, kill: () => {} };
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).toContain("no-leaky-test-daemon");
    });
  });

  // AC: @daemon-test-harness-guardrails ac-helper-internals-allowed
  // AC: @daemon-test-harness-guardrails ac-exceptions-are-localized
  // The full tests/ tree is the ultimate validation that the helper
  // allowlist and the localized-exception model leave no residual
  // violations after the migration to the shared fixture.
  describe("real codebase validation", () => {
    it("should pass against the full tests/ directory with zero violations", () => {
      const projectRoot = path.resolve(__dirname, "..");
      try {
        const output = execSync(
          `npx oxlint --config .oxlintrc.json tests/ 2>&1 | grep "no-leaky-test-daemon" || true`,
          {
            cwd: projectRoot,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        expect(output.trim()).toBe("");
      } catch (err: unknown) {
        const error = err as { stdout: string; stderr: string };
        const output = (error.stdout || "") + (error.stderr || "");
        // If grep exits non-zero it means no matches — that's the expected result
        if (!output.includes("no-leaky-test-daemon")) {
          // Good — no violations
        } else {
          throw new Error(`Found no-leaky-test-daemon violations in tests/:\n${output}`);
        }
      }
    });
  });
});
