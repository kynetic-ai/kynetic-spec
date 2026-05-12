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
 *
 * Cleanup-effect classifier regressions added by
 * `@task-add-guardrail-cleanup-effect-regressions` are now post-fix:
 * `@task-fix-guardrail-cleanup-effect-classification` landed the rule
 * change that closes the classifier gap, so the previously-staged
 * `expectClassifierGap` wrappers are inlined as direct assertions.
 */

import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

type OxlintResult = { exitCode: number; output: string };

// AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
function runOxlint(fileContent: string): OxlintResult {
  return runOxlintAt("tests/synthetic-test.ts", fileContent);
}

/**
 * Variant of `runOxlint` that places the synthetic test file at a
 * caller-specified relative path under the temp directory. Used by the
 * cycle-7 helper-import path-resolution regressions to put the test at
 * a NESTED path (e.g. `tests/e2e/synthetic-test.ts`) so a relative
 * import like `./helpers/daemon` resolves to a NESTED helpers directory
 * (`tests/e2e/helpers/daemon`) instead of the canonical shared helper
 * (`tests/helpers/daemon`). The approved-helper allowlist must reject
 * the nested path because the nested helper is not the vetted shared
 * implementation.
 *
 * The relative path must live under `tests/...` so the lint config
 * override (which matches the `tests/**\/*.ts` glob) applies; placing
 * the file outside that glob makes the rule a no-op and the regression
 * cannot distinguish "rule rejected" from "rule not run".
 */
function runOxlintAt(relativePath: string, fileContent: string): OxlintResult {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "lint-test-"));
  const testFile = path.join(tempDir, relativePath);
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

/**
 * Precondition for every selective expected-failure regression: oxlint
 * itself ran without a parser, helper, or internal failure. Exit code 0
 * means "no diagnostics" and exit code 1 means "rule diagnostics emitted";
 * any other exit code, or any error/panic fragment in the output, is
 * treated as a parser/helper failure that invalidates the regression.
 */
function expectOxlintRanCleanly(result: OxlintResult): void {
  expect([0, 1]).toContain(result.exitCode);
  expect(result.output).not.toMatch(
    /panic|panicked|internal error|failed to parse|parse error|cannot find|module not found|enoent/i,
  );
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

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-before-observation
    // Cycle-4 variant (unreachable conditional kill): the only later
    // statement is `if (false) killPid(result.pid)` — the kill is in a
    // conditional consequent that never executes on the straight-line
    // path. The walker must not descend into the consequent so the
    // missing-cleanup violation fires before the next observation.
    it("should flag serve start --detach when the only later statement is an unreachable conditional kill", () => {
      const result = runOxlint(`
import { describe, it, expect } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    const result = runKspec("serve start --detach --port 3456");
    if (false) killPid(result.pid);
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-before-observation
    // Cycle-4 variant (conditional registration): a registration that
    // sits inside a conditional consequent — `if (shouldCleanup)
    // onTestFinished(() => killPid(pid))` — is not guaranteed to
    // register cleanup before the next observation. The walker must
    // not descend into the IfStatement's branches.
    it("should flag serve start --detach when onTestFinished is registered inside a conditional consequent", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    const result = runKspec("serve start --detach --port 3456");
    const shouldCleanup = true;
    if (shouldCleanup) onTestFinished(() => killPid(result.pid));
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-before-observation
    // Cycle-4 variant (process.on with non-exit event): the cleanup
    // arrow is passed to `process.on("message", ...)` rather than an
    // exit/signal event. A `message` handler runs during normal IPC
    // and is not guaranteed to fire before the test ends, so the
    // detached daemon would still leak.
    it("should flag serve start --detach when cleanup is registered via process.on with a non-exit event", () => {
      const result = runOxlint(`
import { describe, it, expect } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    const result = runKspec("serve start --detach --port 3456");
    process.on("message", () => killPid(result.pid));
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-before-observation
    // Cycle-4 variant (loop body cleanup): a kill that lives in a
    // `for` loop body may never execute if the iterable is empty. The
    // walker must not credit cleanup that depends on loop iteration.
    it("should flag serve start --detach when the only later cleanup is inside a for loop body", () => {
      const result = runOxlint(`
import { describe, it, expect } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    const result = runKspec("serve start --detach --port 3456");
    const pids: number[] = [];
    for (const pid of pids) killPid(pid);
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-before-observation
    // Cycle-5 reviewer probe (unawaited fetch as daemon observation): the
    // observation gate must include `fetch(...)` calls. An unawaited fetch
    // initiates an HTTP request to the daemon synchronously; if the
    // request errors (connection refused, abort, daemon not yet listening)
    // the test fails before the later `onTestFinished` registration runs.
    // The cycle-4 walker only matched `await` and `expect(...)`, so this
    // detached start escaped the rule even though the daemon was observed
    // before cleanup was registered.
    it("should flag serve start --detach when an unawaited fetch observes the daemon before cleanup", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    fetch("http://127.0.0.1:3456/api/health");
    const pid = readPidFromFile();
    onTestFinished(() => killPid(pid));
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-before-observation
    // Cycle-5 variant (unawaited new WebSocket as daemon observation): the
    // WebSocket constructor opens a connection synchronously. The same
    // cleanup-timing concern applies: a connection failure surfaces as a
    // test error before the later `onTestFinished` registration runs.
    it("should flag serve start --detach when an unawaited new WebSocket observes the daemon before cleanup", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    new WebSocket("ws://127.0.0.1:3456/api/ws");
    const pid = readPidFromFile();
    onTestFinished(() => killPid(pid));
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-before-observation
    // Cycle-5 variant (IIFE expect as same-statement observation): an
    // immediately-invoked arrow whose body contains `expect(...)` runs at
    // this statement, so it IS an observation on the straight-line
    // execution path — even though function bodies in general are stored.
    // The walker must descend into IIFE callees (function in callee
    // position of its parent CallExpression) but not into stored function
    // bodies (function in argument or right-hand-side position).
    it("should flag serve start --detach when an IIFE expect runs before cleanup is registered", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    (() => expect(true).toBe(true))();
    const pid = readPidFromFile();
    onTestFinished(() => killPid(pid));
  });
});
`);
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-before-observation
    // Cycle-6 reviewer probe (lifecycle hook registered inside test body):
    // a `beforeEach(() => killPid(...))` registered as a sibling of the
    // detached daemon start does NOT scope cleanup to the current test.
    // The hook is added to the parent describe scope at runtime; vitest
    // does not retroactively run newly-registered hooks for the test that
    // just registered them, and the registration itself can be skipped if
    // an earlier statement in the same test throws. The cleanup walker
    // must not credit `beforeEach` (or `afterEach`/`beforeAll`/`afterAll`)
    // as in-flow cleanup for a daemon just started in the test body.
    it("should flag serve start --detach when beforeEach is registered as in-test cleanup", () => {
      const result = runOxlint(`
import { describe, it, expect, beforeEach } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    const result = runKspec("serve start --detach --port 3456");
    beforeEach(() => killPid(result.pid));
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-before-observation
    // Cycle-6 reviewer probe (afterEach variant): same shape as the
    // beforeEach probe — `afterEach` registered inside an `it` body is
    // not scoped cleanup for the just-started daemon.
    it("should flag serve start --detach when afterEach is registered as in-test cleanup", () => {
      const result = runOxlint(`
import { describe, it, expect, afterEach } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    const result = runKspec("serve start --detach --port 3456");
    afterEach(() => killPid(result.pid));
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-before-observation
    // Companion to the lifecycle-hook probes: `afterAll` and `beforeAll`
    // are also rejected because they only fire at the suite boundary, so
    // a leaked daemon can survive every other test in the file before
    // the kill ever runs.
    it("should flag serve start --detach when afterAll is registered as in-test cleanup", () => {
      const result = runOxlint(`
import { describe, it, expect, afterAll } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    const result = runKspec("serve start --detach --port 3456");
    afterAll(() => killPid(result.pid));
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    it("should flag serve start --detach when beforeAll is registered as in-test cleanup", () => {
      const result = runOxlint(`
import { describe, it, expect, beforeAll } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    const result = runKspec("serve start --detach --port 3456");
    beforeAll(() => killPid(result.pid));
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-before-observation
    // Cycle-7 reviewer probe (identifier-bound 127.0.0.1 daemon URL
    // observed before cleanup): `const url = "http://127.0.0.1:3456/..."`
    // followed by `fetch(url)` is a daemon observation just like the
    // inline-literal form. The cleanup-timing observation gate must
    // resolve the identifier through the binding tracker; the
    // identifier-bound binding tracker must record bindings whose RHS
    // matches the broader loopback host+port pattern (127.0.0.1, [::1])
    // — not just the narrower `localhost:` pattern that drives the
    // `localhostDaemonUrl` reporting predicate.
    it("should flag serve start --detach when an identifier-bound 127.0.0.1 URL fetch precedes cleanup", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    const result = runKspec("serve start --detach --port 3456");
    const url = "http://127.0.0.1:3456/api/health";
    fetch(url);
    onTestFinished(() => killPid(result.pid));
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-before-observation
    // Cycle-7 variant (identifier-bound IPv6 loopback URL): same shape
    // as the 127.0.0.1 probe — `[::1]:<port>` is a legitimate IPv6
    // loopback address tests use to talk to the local daemon, so an
    // identifier-bound `[::1]` daemon URL observed before cleanup must
    // also be recognised by the observation gate.
    it("should flag serve start --detach when an identifier-bound [::1] URL fetch precedes cleanup", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    const result = runKspec("serve start --detach --port 3456");
    const url = "http://[::1]:3456/api/health";
    fetch(url);
    onTestFinished(() => killPid(result.pid));
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-before-observation
    // Cycle-7 variant (identifier-bound localhost URL): the
    // identifier-bound case must trip `missingCleanup` symmetrically
    // for the original `localhost:` host as well — without the
    // Program:exit deferral introduced for cycle 7, the cleanup-timing
    // analysis ran at the daemon-start CallExpression entry, BEFORE
    // the later `const url = "http://localhost:..."` VariableDeclarator
    // was visited, so the binding lookup returned null even for the
    // host the existing binding tracker already supported.
    it("should flag serve start --detach when an identifier-bound localhost URL fetch precedes cleanup", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    const result = runKspec("serve start --detach --port 3456");
    const url = "http://localhost:3456/api/health";
    fetch(url);
    onTestFinished(() => killPid(result.pid));
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).toContain("Detached daemon start");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-before-observation
    // Cycle-7 variant (identifier-bound 127.0.0.1 WebSocket URL): the
    // observation surface includes `new WebSocket(...)` symmetric with
    // `fetch(...)`, so an identifier-bound 127.0.0.1 WebSocket URL
    // observed before cleanup must also be flagged.
    it("should flag serve start --detach when an identifier-bound 127.0.0.1 WebSocket URL precedes cleanup", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    const result = runKspec("serve start --detach --port 3456");
    const url = "ws://127.0.0.1:3456/api/ws";
    new WebSocket(url);
    onTestFinished(() => killPid(result.pid));
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-cleanup-registration-is-test-scoped
    // Process-lifecycle `process.on("exit", ...)` is a global shutdown
    // hook, not a per-test cleanup boundary. The handler fires when the
    // Node process is tearing down — which can be after every other test
    // in the file has run against the leaked daemon. The spec demands
    // cleanup be registered at the current-test boundary (vitest
    // `onTestFinished` or a same-flow `try/finally` finalizer), not at a
    // process-wide event. Treating `process.on("exit", ...)` as
    // sufficient lets the daemon survive subsequent tests.
    //
    // A `process.on(...)` registration MAY exist alongside a valid
    // per-test cleanup as a supplemental safety net, but it does NOT
    // satisfy the guardrail by itself.
    //
    // FLIPPED-ON-FIX (cycle 7): the helper-origin fix in this task
    // (`@task-fix-guardrail-cleanup-effect-classification`) closed
    // the conservative-trust path that previously credited bare
    // unimported helper names. The fixture's `() => killPid(
    // result.pid)` listener body now has no trusted origin, so the
    // body fails the cleanup-effect classifier and the rule flags
    // the missing scoped cleanup. Per the flip-on-fix protocol
    // recorded in earlier cycles, this test moves from `it.fails`
    // to `it`. (The boundary-classification false negative for
    // `process.on(...)` carrier shapes with a directly-terminating
    // inline body is still tracked by
    // `@task-fix-guardrail-cleanup-boundary-classification`.)
    it("should flag serve start --detach when only cleanup is process.on(\"exit\", ...)", () => {
      const result = runOxlint(`
import { describe, it, expect } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    const result = runKspec("serve start --detach --port 3456");
    process.on("exit", () => killPid(result.pid));
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-cleanup-registration-is-test-scoped
    // `beforeExit` is a process-lifecycle hook just like `exit`: it runs
    // when the event loop is empty, which is a process boundary, not the
    // per-test boundary the spec requires. A daemon left running by this
    // test will survive every later test in the file.
    //
    // FLIPPED-ON-FIX (cycle 7): see the `process.on("exit", ...)`
    // sibling above for the flip-on-fix protocol summary. Same
    // mechanism — the cycle-7 helper-origin rejection on bare
    // unimported `killPid` denies the fixture's listener-body the
    // cleanup-effect credit, so the rule flags as expected.
    it("should flag serve start --detach when only cleanup is process.on(\"beforeExit\", ...)", () => {
      const result = runOxlint(`
import { describe, it, expect } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    const result = runKspec("serve start --detach --port 3456");
    process.on("beforeExit", () => killPid(result.pid));
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-cleanup-registration-is-test-scoped
    // Signal handlers (`SIGTERM`, `SIGINT`, etc.) are process-wide
    // shutdown handlers — they only run when the Node process receives
    // the signal, not when this individual test finishes. A handler
    // registered here does nothing for a daemon that leaks into the
    // next test in the same file.
    //
    // FLIPPED-ON-FIX (cycle 7): see the `process.on("exit", ...)`
    // sibling above for the flip-on-fix protocol summary.
    it("should flag serve start --detach when only cleanup is process.on(\"SIGTERM\", ...)", () => {
      const result = runOxlint(`
import { describe, it, expect } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    const result = runKspec("serve start --detach --port 3456");
    process.on("SIGTERM", () => killPid(result.pid));
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-cleanup-registration-is-test-scoped
    // `process.once(...)` is the single-shot sibling of `process.on(...)`
    // — it still registers on a process-lifecycle event and still fires
    // only at process shutdown, not at the per-test boundary. Treating
    // a `.once` variant as cleanup would carry the same leak risk as
    // `.on`.
    it("should flag serve start --detach when only cleanup is process.once(\"exit\", ...)", () => {
      const result = runOxlint(`
import { describe, it, expect } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    const result = runKspec("serve start --detach --port 3456");
    process.once("exit", () => killPid(result.pid));
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-cleanup-registration-is-test-scoped
    // `Promise.finally(...)` is not a per-test cleanup boundary. The
    // callback runs when the underlying promise settles — which may
    // happen asynchronously, after the test has already moved on, or
    // never if the chain is dropped on the floor. The vitest
    // `onTestFinished` boundary is the only test-scoped hook for
    // detached daemon cleanup.
    it("should flag serve start --detach when only cleanup is Promise.finally", () => {
      const result = runOxlint(`
import { describe, it, expect } from "vitest";

describe("test suite", () => {
  it("should start daemon", async () => {
    const result = runKspec("serve start --detach --port 3456");
    Promise.resolve().finally(() => killPid(result.pid));
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-cleanup-registration-is-test-scoped
    // `queueMicrotask(...)` schedules the callback on the microtask
    // queue, but the kill runs whenever the microtask drains — not at
    // the per-test cleanup boundary. The callback can be skipped by an
    // earlier synchronous throw, and even on the happy path the daemon
    // is not guaranteed to be terminated before the next test starts.
    it("should flag serve start --detach when only cleanup is queueMicrotask", () => {
      const result = runOxlint(`
import { describe, it, expect } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    const result = runKspec("serve start --detach --port 3456");
    queueMicrotask(() => killPid(result.pid));
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    // Cleanup-effect semantics: the rule's old callee-shape predicate
    // accepted `process.kill(...)` regardless of signal and accepted any
    // local helper named `killPid` / `stopDaemon` / `stopMockDaemon` by
    // name alone. The cleanup-effect adversarial probes below assert that
    // cleanup callbacks must actually terminate the daemon to satisfy the
    // guardrail — the classifier split landed in
    // `@task-fix-guardrail-cleanup-effect-classification` (signal validity
    // for process.kill / child.kill, helper origin via approved import or
    // inspected local body).

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-probes-do-not-count
    // Liveness probe — `process.kill(pid, 0)` returns whether the target
    // process is reachable but does NOT send a terminating signal. Pre-fix
    // the rule accepted this as cleanup because it only matched the
    // `process.kill(...)` callee shape; the leak survives because the
    // daemon is still running when the test ends.
    it("should flag serve start --detach when onTestFinished cleanup is process.kill(pid, 0) (liveness probe)", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => process.kill(pid, 0));
    expect(true).toBe(true);
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-probes-do-not-count
    // SIGUSR1 is a user-defined signal — Node uses it for the debugger
    // and many programs use it for runtime introspection. It does NOT
    // terminate the receiving process. A cleanup callback that sends
    // SIGUSR1 leaves the daemon running.
    it("should flag serve start --detach when onTestFinished cleanup uses process.kill with SIGUSR1", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => process.kill(pid, "SIGUSR1"));
    expect(true).toBe(true);
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-probes-do-not-count
    // SIGCONT resumes a stopped process. Sending it to a running daemon
    // does nothing useful and certainly does not terminate it.
    it("should flag serve start --detach when onTestFinished cleanup uses process.kill with SIGCONT", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => process.kill(pid, "SIGCONT"));
    expect(true).toBe(true);
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-probes-do-not-count
    // SIGWINCH is the terminal window-change signal — historically
    // delivered to interactive shells. It is not a daemon-relevant
    // termination signal; programs typically install no handler and the
    // default action is to ignore it.
    it("should flag serve start --detach when onTestFinished cleanup uses process.kill with SIGWINCH", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => process.kill(pid, "SIGWINCH"));
    expect(true).toBe(true);
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-operation-terminates-daemon
    // Same shape as the SIGUSR1 process.kill probe but on the child
    // handle. The child-handle callee gate already rejects non-terminating
    // signals; this probe documents that contract symmetrically with the
    // `process.kill` cases and protects against future regressions if the
    // child-handle branch is broadened.
    it("should flag serve start --detach when child handle cleanup uses .kill('SIGUSR1')", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";
import { spawn } from "child_process";

describe("test suite", () => {
  it("should start daemon", () => {
    const child = spawn("kspec", ["serve", "start", "--detach", "--port", "3456"]);
    onTestFinished(() => child.kill("SIGUSR1"));
    expect(child.pid).toBeDefined();
  });
});
`);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // Locally defined function declaration named `killPid` whose body is
    // a no-op — pre-fix the rule trusted the name alone. The helper does
    // nothing, so the daemon outlives the test.
    it("should flag serve start --detach when cleanup calls a locally defined no-op killPid helper", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

function killPid(_pid: number): void {
  // intentionally empty — local no-op shaped like the approved helper
}

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => killPid(pid));
    expect(true).toBe(true);
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // Same shape as the killPid probe but using the `stopDaemon` name
    // recognised by the cleanup classifier. A locally defined `stopDaemon`
    // can be a no-op or do unrelated work; the name does not prove it
    // stops the daemon.
    it("should flag serve start --detach when cleanup calls a locally defined no-op stopDaemon helper", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

function stopDaemon(_pid: number): void {
  // intentionally empty — local no-op
}

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => stopDaemon(pid));
    expect(true).toBe(true);
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // `stopMockDaemon` is also in the approved-name set. The same
    // false-negative shape applies — a local no-op definition satisfies
    // the rule today even though no kill ever runs.
    it("should flag serve start --detach when cleanup calls a locally defined no-op stopMockDaemon helper", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

function stopMockDaemon(_pid: number): void {
  // intentionally empty — local no-op
}

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => stopMockDaemon(pid));
    expect(true).toBe(true);
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // Local arrow definition variant: `const killPid = (_pid) => { ... }`
    // with an empty body must be rejected for the same reason as the
    // function-declaration no-op. The VariableDeclarator + arrow shape
    // is a common no-op pattern in tests that mock cleanup.
    it("should flag serve start --detach when cleanup calls a locally defined no-op killPid arrow", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

const killPid = (_pid: number): void => {
  // intentionally empty — local no-op arrow
};

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => killPid(pid));
    expect(true).toBe(true);
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // A local helper whose body only forwards to an unrelated logger
    // (no terminating syscall) must not be trusted — the name alone
    // cannot bridge the gap when the body proves the helper does not
    // stop the daemon.
    it("should flag serve start --detach when cleanup calls a local stopDaemon helper that only logs", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

function stopDaemon(pid: number): void {
  console.log("would stop", pid);
}

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => stopDaemon(pid));
    expect(true).toBe(true);
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // Cycle-1 reviewer probe: a recognised helper name imported from an
    // unapproved module path must not satisfy cleanup. The shared
    // daemon-fixture allowlist (`APPROVED_HELPER_IMPORT_PATH_PATTERNS`)
    // is the boundary that vets the helper body out of band; an import
    // from `./fake-cleanup` lives outside that boundary and the rule
    // cannot prove the helper stops the daemon. Pre-fix the classifier
    // fell through to "free identifier" because the local-definition
    // lookup returned null, and the daemon was credited as cleaned up
    // when in reality the import target could be a no-op.
    it("should flag serve start --detach when cleanup calls killPid imported from an unapproved module", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";
import { killPid } from "./fake-cleanup";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => killPid(pid));
    expect(true).toBe(true);
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // Same shape as the killPid unapproved-import probe but using the
    // `stopDaemon` name. The unapproved-import rejection must apply to
    // every name in `TRUSTED_HELPER_NAMES`, not just `killPid`.
    it("should flag serve start --detach when cleanup calls stopDaemon imported from an unapproved module", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";
import { stopDaemon } from "./fake-cleanup";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => stopDaemon(pid));
    expect(true).toBe(true);
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // Default-import shape: `import killPid from "./fake-cleanup"` binds
    // the local name `killPid` from a non-approved source. Same rejection
    // — the import-binding scan treats default specifiers identically
    // to named specifiers because what matters is the locally-bound
    // identifier, not the wire format of the import.
    it("should flag serve start --detach when cleanup calls killPid imported as a default from an unapproved module", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";
import killPid from "./fake-cleanup";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => killPid(pid));
    expect(true).toBe(true);
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // AC: @daemon-test-guardrail-precision ac-cleanup-probes-do-not-count
    // Cycle-3 reviewer probe: a no-op `function killPid(_pid) { ... }`
    // declared INSIDE the `it` callback body (not at module scope) must
    // not satisfy cleanup. Pre-fix `findLocalHelperDefinition` scanned
    // only `Program.body` and missed the nested declaration; the use
    // site then fell through the unapproved-import gate to the
    // free-identifier conservative-trust path and silently credited the
    // no-op. The scope-walking lookup now visits every enclosing
    // BlockStatement (the `it` body) before the Program, so the inner
    // FunctionDeclaration is found and its body is inspected for a
    // terminating primitive.
    it("should flag serve start --detach when cleanup calls a nested no-op killPid helper declared inside the it body", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    function killPid(_pid: number): void {
      console.log("noop");
    }
    onTestFinished(() => killPid(pid));
    expect(true).toBe(true);
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // Cycle-3 variant: nested arrow declaration `const stopDaemon = (_pid)
    // => { ... }` with a no-op body. Same scope-walk requirement, applied
    // to a different recognised helper name and the VariableDeclarator +
    // ArrowFunctionExpression init shape rather than FunctionDeclaration.
    it("should flag serve start --detach when cleanup calls a nested no-op stopDaemon arrow declared inside the it body", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    const stopDaemon = (_pid: number): void => {
      // intentionally empty — nested local no-op arrow
    };
    onTestFinished(() => stopDaemon(pid));
    expect(true).toBe(true);
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // Cycle-3 variant: nested helper declared inside the `describe`
    // callback (one block deeper than module scope but one shallower
    // than the `it` body). The scope walk must reach this intermediate
    // BlockStatement too — the rule cannot assume the helper sits in
    // the same block as the use site.
    it("should flag serve start --detach when cleanup calls a no-op killPid helper declared in the describe block", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

describe("test suite", () => {
  function killPid(_pid: number): void {
    console.log("noop");
  }
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => killPid(pid));
    expect(true).toBe(true);
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // Cycle-3 variant: a nested local helper SHADOWS an approved import
    // of the same name. Lexical scoping says the inner function is what
    // runs when `killPid(pid)` is invoked, so the import's vetted body
    // does not apply. Before the local-first ordering fix, the approved
    // import would short-circuit the check and silently trust the
    // shadowed name even though the actual call target is the no-op.
    it("should flag serve start --detach when a nested no-op killPid shadows an approved import", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";
import { killPid } from "./helpers/daemon";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    function killPid(_pid: number): void {
      console.log("shadowed noop");
    }
    onTestFinished(() => killPid(pid));
    expect(true).toBe(true);
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-operation-terminates-daemon
    // AC: @daemon-test-guardrail-precision ac-cleanup-probes-do-not-count
    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // Cycle-4 reviewer probe: a local helper with a terminating default
    // parameter (`function killPid(pid, signal = "SIGTERM") { process
    // .kill(pid, signal); }`) is called with a non-terminating override
    // at the use site (`killPid(pid, "SIGUSR1")`). Pre-fix the helper-
    // body inspection trusted the parameter's "SIGTERM" default and
    // credited the cleanup; in reality JS resolves the override at the
    // call site, so `process.kill(pid, "SIGUSR1")` runs and leaves the
    // daemon alive. The call-site validation now rejects the override
    // because the actual argument supplied at the parameter position is
    // a non-terminating Literal.
    it("should flag serve start --detach when cleanup calls killPid with a non-terminating signal that overrides the helper's terminating default", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

function killPid(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  process.kill(pid, signal);
}

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => killPid(pid, "SIGUSR1"));
    expect(true).toBe(true);
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-operation-terminates-daemon
    // AC: @daemon-test-guardrail-precision ac-cleanup-probes-do-not-count
    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // Cycle-4 variant: same override gap on an arrow helper with the
    // terminating default. The body inspection threads the override
    // check through arrow function shapes too — what matters is whether
    // the param has an AssignmentPattern default, not the function
    // syntax that declared it.
    it("should flag serve start --detach when cleanup calls a killPid arrow with a non-terminating signal that overrides the arrow's terminating default", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

const killPid = (pid: number, signal: NodeJS.Signals = "SIGTERM"): void => {
  process.kill(pid, signal);
};

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => killPid(pid, "SIGCONT"));
    expect(true).toBe(true);
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-operation-terminates-daemon
    // AC: @daemon-test-guardrail-precision ac-cleanup-probes-do-not-count
    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // Cycle-4 variant: the override-rejection extends to child-handle
    // cleanup on a local object literal whose `kill` method uses a
    // terminating-default parameter. `const handle = { kill(signal =
    // "SIGTERM") { process.kill(pid, signal); } }; handle.kill("SIGUSR1
    // ")` overrides the default at the call site exactly like the
    // helper-name path; the receiver check threads the kill call
    // through to body inspection so the override is caught.
    it("should flag serve start --detach when cleanup is a local literal whose kill default is overridden with a non-terminating signal", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    const handle = {
      pid,
      kill(signal: NodeJS.Signals = "SIGTERM") {
        process.kill(pid, signal);
      },
    };
    onTestFinished(() => handle.kill("SIGUSR1"));
    expect(true).toBe(true);
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // Cycle-4 reviewer probe: the approved-helper import allowlist
    // previously used a path-tail anchor (`(^|/)helpers/(daemon|mock-
    // daemon)`), so ANY module specifier whose path happened to end in
    // `helpers/daemon` — including bare specifiers resolved from
    // `node_modules` like `some-unapproved-package/helpers/daemon` —
    // was trusted by name. The body of that package lives outside the
    // path allowlist (`HELPER_PATH_PATTERNS`) and is not vetted, so the
    // call site cannot prove the daemon is stopped. The allowlist is
    // now anchored to a relative-path prefix (`./` or `../`), and a
    // bare specifier never matches.
    it("should flag serve start --detach when cleanup calls killPid imported from an unapproved package whose path tail ends in helpers/daemon", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";
import { killPid } from "some-unapproved-package/helpers/daemon";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => killPid(pid));
    expect(true).toBe(true);
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // Cycle-4 variant: scoped npm package specifier ending in
    // `helpers/mock-daemon` (the other approved name). Same gap as the
    // unscoped case — the relative-prefix anchor rejects all bare and
    // scoped specifiers regardless of tail.
    it("should flag serve start --detach when cleanup calls stopMockDaemon imported from a scoped unapproved package whose path tail ends in helpers/mock-daemon", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";
import { stopMockDaemon } from "@some-scope/some-package/helpers/mock-daemon";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => stopMockDaemon(pid));
    expect(true).toBe(true);
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // Cycle-4 variant: a bare specifier whose entire path is
    // `helpers/daemon` (no package-name prefix) — historically the
    // pattern matched a bare path too because the anchor accepted
    // `^helpers/daemon`. The relative-prefix anchor rejects bare
    // specifiers because they don't begin with `./` or `../`; only
    // in-repo relative imports may bind a trusted name.
    it("should flag serve start --detach when cleanup calls killPid imported from the bare helpers/daemon specifier", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";
import { killPid } from "helpers/daemon";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => killPid(pid));
    expect(true).toBe(true);
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // Cycle-4 variant: an arbitrary deep path whose final segments are
    // `helpers/daemon`, but whose prefix is not a `./` or `../` walk —
    // a TS-alias-style root-rooted form (`tests/helpers/daemon`) the
    // old comment claimed to support but real test code never used.
    // Rejected because the relative-prefix anchor requires `./` or
    // `../`. Any root-rooted form that authors do need can be brought
    // back through an explicit alias, but it must travel through the
    // vetted shared-helper module — not a wildcard-like path tail.
    it("should flag serve start --detach when cleanup calls killPid imported from a root-rooted tests/helpers/daemon specifier", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";
import { killPid } from "tests/helpers/daemon";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => killPid(pid));
    expect(true).toBe(true);
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-operation-terminates-daemon
    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // Cycle-4 variant: helper has the terminating default and the call
    // site explicitly passes the liveness-probe signal `0`. The probe
    // form is the canonical "is the process alive" Node API and never
    // terminates anything — it must not satisfy cleanup even when the
    // body's parameter default would.
    it("should flag serve start --detach when cleanup calls killPid with the liveness-probe signal 0 overriding the helper's terminating default", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

function killPid(pid: number, signal: NodeJS.Signals | number = "SIGTERM"): void {
  process.kill(pid, signal as NodeJS.Signals);
}

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => killPid(pid, 0));
    expect(true).toBe(true);
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-operation-terminates-daemon
    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // Cycle-4 variant: helper has the terminating default and the call
    // site passes a runtime-computed signal value (CallExpression,
    // TemplateLiteral, MemberExpression). The rule cannot statically
    // prove a runtime-computed signal is terminating, so the override
    // is rejected the same way `isTerminatingKillSignalArg` rejects
    // computed signals at the top-level classifier.
    it("should flag serve start --detach when cleanup calls killPid with a runtime-computed signal overriding the helper's terminating default", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

function killPid(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  process.kill(pid, signal);
}

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    const dynamicSignal = (): NodeJS.Signals => "SIGUSR1";
    onTestFinished(() => killPid(pid, dynamicSignal()));
    expect(true).toBe(true);
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // AC: @daemon-test-guardrail-precision ac-cleanup-probes-do-not-count
    // Cycle-5 reviewer probe: a parameter binding shadows the helper
    // name `killPid` and defaults to an inspectable empty arrow. Pre-fix
    // `findLocalHelperDefinition` saw the parameter and returned null,
    // and `isTrustedHelperByOrigin` then fell through past the
    // (non-existent) imports to the free-identifier conservative-trust
    // path that silently credited the no-op default. The runtime value
    // of the parameter comes from the test framework's call to the
    // arrow (vitest's `it` invokes the callback with a context object,
    // not an override), but the rule cannot statically prove that — and
    // an explicit caller override could replace the default with any
    // function, so parameter bindings must be rejected as opaque local
    // bindings regardless of the default's shape. The
    // `LOCAL_BINDING_OPAQUE` sentinel routes the use site to the
    // explicit reject branch.
    it("should flag serve start --detach when cleanup helper is bound by a parameter default to a no-op arrow", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

describe("test suite", () => {
  it("should start daemon", (killPid = (_pid: number) => {}) => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => killPid(pid));
    expect(true).toBe(true);
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // Cycle-5 variant: a parameter shadow whose default IS a terminating
    // primitive must STILL be rejected — a caller can override the
    // default with any value at the call site, so the rule cannot prove
    // the runtime value terminates. This mirrors the cycle-4 reviewer
    // logic: helper-body inspection that trusts a terminating-default
    // parameter (`signal = "SIGTERM"`) still requires call-site
    // validation; for a parameter that BINDS the helper itself, the
    // call-site is opaque (the framework invokes the callback), so the
    // entire binding is rejected. The fix's symmetric stance is that
    // local opaque bindings are rejected regardless of the default's
    // contents because the binding value is not the default's value at
    // runtime.
    it("should flag serve start --detach when cleanup helper is bound by a parameter default to a terminating arrow", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

describe("test suite", () => {
  it("should start daemon", (killPid = (p: number) => process.kill(p, "SIGTERM")) => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => killPid(pid));
    expect(true).toBe(true);
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // Cycle-5 variant: a `let stopDaemon;` declaration inside the `it`
    // body binds the helper name with no initializer at all. The rule
    // cannot inspect a missing initializer for a terminating primitive,
    // and the binding shadows any outer import. Pre-fix the lookup
    // walked past this VariableDeclaration without matching (its init
    // is not a function literal) and the use site fell through to
    // free-identifier trust. The opaque-binding scan now classifies the
    // declarator as opaque because the id binds `stopDaemon` and the
    // init is missing.
    it("should flag serve start --detach when cleanup helper is bound by a local let with no initializer", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    let stopDaemon: (pid: number) => void;
    stopDaemon = (_pid: number) => { /* runtime injection */ };
    const pid = readPidFromFile();
    onTestFinished(() => stopDaemon(pid));
    expect(true).toBe(true);
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // Cycle-5 variant: a local binding via a CallExpression initializer
    // (`const killPid = makeKill()`) shadows any outer import. The
    // factory result could be anything — a terminating helper, a
    // no-op, or even a value not callable at all. The rule cannot
    // inspect the factory's return value statically; the binding is a
    // definite local declaration so the opaque-binding scan rejects
    // it. Pre-fix the lookup walked past this declarator because the
    // init type was CallExpression rather than a function literal, and
    // the use site fell through to free-identifier trust.
    it("should flag serve start --detach when cleanup helper is bound by a local const initialized from a factory call", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

declare function makeKill(): (pid: number) => void;

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const killPid = makeKill();
    const pid = readPidFromFile();
    onTestFinished(() => killPid(pid));
    expect(true).toBe(true);
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // Cycle-5 variant: an object-destructure binding
    // (`const { killPid } = require("./fake-cleanup")`) is a local
    // declarator that binds `killPid` through ObjectPattern shorthand.
    // The init is a CallExpression and `decl.id` is not the simple
    // Identifier form, so `matchHelperDefinitionInStatement` does not
    // match. Pre-fix the use site fell through past the binding to
    // free-identifier trust, silently crediting any value the require
    // returned. The opaque-binding scan now recognises ObjectPattern
    // bindings of `killPid` and rejects.
    it("should flag serve start --detach when cleanup helper is bound by an object-destructure of a require call", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const { killPid } = require("./fake-cleanup");
    const pid = readPidFromFile();
    onTestFinished(() => killPid(pid));
    expect(true).toBe(true);
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // Cycle-5 variant: a parameter shadow inside the `onTestFinished`
    // callback itself. The arrow `(killPid) => killPid(pid)` binds the
    // helper name in the callback's parameter slot — the call site
    // resolves to the parameter, not any outer scope. Same opaque-
    // binding principle applies: the parameter is a definite local
    // binding the rule cannot inspect, even though the textual call
    // shape matches the cleanup pattern. The lexically-closest
    // parameter shadow wins so the LOCAL_BINDING_OPAQUE sentinel fires
    // at the innermost arrow.
    it("should flag serve start --detach when cleanup helper is bound by a parameter on the onTestFinished callback itself", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";
import { killPid } from "./helpers/daemon";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(((killPid: (pid: number) => void = (_p) => {}) => () => killPid(pid))());
    expect(true).toBe(true);
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-operation-terminates-daemon
    // AC: @daemon-test-guardrail-precision ac-cleanup-probes-do-not-count
    // Cycle-1 reviewer probe: a local object literal whose `kill`
    // method body is a no-op must not satisfy child-handle cleanup.
    // Pre-fix the child-handle branch accepted any non-`process` `.kill()`
    // call with no signal because `isTerminatingKillSignalArg(undefined)`
    // returns true. The receiver check rejects the literal here because
    // the kill body never reaches a terminating primitive.
    it("should flag serve start --detach when cleanup is a local literal with a no-op kill shorthand method", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const fake = { kill() { console.log("noop"); } };
    onTestFinished(() => fake.kill());
    expect(true).toBe(true);
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-operation-terminates-daemon
    // AC: @daemon-test-guardrail-precision ac-cleanup-probes-do-not-count
    // Same receiver-shape gap but with the longhand arrow-property form
    // `{ kill: () => {} }` — empty arrow body. The literal still has a
    // `kill` property, but the body has no terminating primitive, so
    // the receiver check rejects.
    it("should flag serve start --detach when cleanup is a local literal with an empty arrow kill property", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const fake = { pid: 12345, kill: () => {} };
    onTestFinished(() => fake.kill("SIGTERM"));
    expect(true).toBe(true);
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-operation-terminates-daemon
    // AC: @daemon-test-guardrail-precision ac-cleanup-probes-do-not-count
    // Logger-only kill body: the property exists and is a function, but
    // the body only writes to console. No terminating primitive is
    // reachable, so the receiver check rejects on the same grounds the
    // helper-body inspection rejects a logger-only `stopDaemon` helper.
    it("should flag serve start --detach when cleanup is a local literal with a logger-only kill property", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const fake = {
      pid: 12345,
      kill: function (signal?: string) { console.log("would kill", signal); },
    };
    onTestFinished(() => fake.kill("SIGTERM"));
    expect(true).toBe(true);
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-before-observation
    // Cycle-6 reviewer probe (helper binding order): a `const killPid =
    // (p) => process.kill(p, "SIGTERM")` declared AFTER the
    // `onTestFinished(() => killPid(pid))` registration sits in the
    // temporal dead zone until its declarator runs. The intervening
    // `expect(true).toBe(true)` can throw before initialization, in
    // which case teardown invokes the cleanup arrow while `killPid` is
    // still unbound — ReferenceError at teardown leaves the daemon
    // running. Pre-fix `findLocalHelperDefinition` returned the
    // declarator regardless of position, the body inspection saw the
    // terminating `process.kill`, and the use site was silently
    // credited. The source-order check now classifies the binding as
    // opaque when the declarator is at or after the use site's
    // containing statement in the same enclosing block.
    it("should flag serve start --detach when cleanup helper is bound by a const arrow declared after the registration", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => killPid(pid));
    expect(true).toBe(true);
    const killPid = (p: number): void => process.kill(p, "SIGTERM");
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-before-observation
    // Cycle-6 variant (function expression instead of arrow init): a
    // `const killPid = function (p) { ... }` declared after the
    // registration has the same TDZ shape as the arrow form. The
    // source-order check operates on the declarator's containing
    // statement, not the init's surface shape, so both forms must be
    // rejected uniformly.
    it("should flag serve start --detach when cleanup helper is bound by a const function expression declared after the registration", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => killPid(pid));
    expect(true).toBe(true);
    const killPid = function (p: number) { process.kill(p, "SIGTERM"); };
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-before-observation
    // Cycle-6 variant (let arrow init): a `let killPid = ...` with a
    // function init carries the same TDZ semantics as `const`. The
    // declaration-keyword surface differs but the binding is still in
    // TDZ until the declarator runs.
    it("should flag serve start --detach when cleanup helper is bound by a let arrow declared after the registration", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => killPid(pid));
    expect(true).toBe(true);
    let killPid = (p: number): void => process.kill(p, "SIGTERM");
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-before-observation
    // Cycle-6 variant (registration via afterEach in describe scope,
    // const helper later in same describe body): even outside an `it`
    // callback, the same TDZ window applies in the describe block —
    // `afterEach(() => killPid(pid))` captures `killPid` by reference,
    // and the lexically-later `const killPid = ...` declarator runs
    // only if every preceding statement completes. The reviewer's
    // concern generalises: any cleanup-shape registration in a block
    // whose helper binding sits below it in the same block can be
    // unreached at teardown.
    it("should flag serve start --detach when describe-scope helper const is declared after afterEach registration", () => {
      const result = runOxlint(`
import { describe, it, expect, afterEach } from "vitest";

describe("test suite", () => {
  let pid;
  afterEach(() => killPid(pid));

  const killPid = (p: number): void => process.kill(p, "SIGTERM");

  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    pid = readPidFromFile();
    expect(true).toBe(true);
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-before-observation
    // Cycle-6 variant (program-level helper declared after the it
    // block): the helper `const killPid = ...` sits at module scope
    // AFTER the `describe(...)` call that contains the registration.
    // Top-level statements run in source order at module load time, so
    // the same TDZ window applies — if the describe body's evaluation
    // throws before the program reaches the const, the helper binding
    // is still unbound at teardown. The source-order walk reaches the
    // Program scope and verifies the declarator precedes the use
    // site's containing top-level statement.
    it("should flag serve start --detach when program-level cleanup helper const is declared after the describe block", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => killPid(pid));
    expect(true).toBe(true);
  });
});

const killPid = (p: number): void => process.kill(p, "SIGTERM");
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // Cycle-7 reviewer probe (ForStatement init binds helper name to a
    // no-op arrow): `for (const killPid = (_p) => {}; true; ) {
    // runKspec("serve start --detach"); ...; onTestFinished(() =>
    // killPid(pid)); ... break; }`. The init's VariableDeclaration
    // binds `killPid` in the for-statement's own scope, not in the
    // enclosing BlockStatement, so pre-fix the parent-walk visited
    // function params and Block/Program statement lists only, missed
    // the binding entirely, and the use site fell through to
    // free-identifier conservative-trust. The fix recognises the
    // ForStatement.init binding and returns LOCAL_BINDING_OPAQUE — even
    // a terminating-shaped init in this shape is too unusual to credit
    // here; the canonical safe helper is a top-level FunctionDeclaration
    // or block-level declarator.
    it("should flag serve start --detach when cleanup helper is bound by a ForStatement init to a no-op arrow", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    for (const killPid = (_p: number) => {}; true; ) {
      runKspec("serve start --detach --port 3456");
      const pid = readPidFromFile();
      onTestFinished(() => killPid(pid));
      expect(true).toBe(true);
      break;
    }
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // Cycle-7 variant (ForStatement init with terminating-shaped arrow):
    // the same ForStatement.init binding shape, but the init is a
    // terminating-shaped arrow `(p) => process.kill(p, "SIGTERM")`. The
    // rule still rejects because the for-init binding scope is unusual
    // enough that the conservative LOCAL_BINDING_OPAQUE classification
    // applies regardless of the init shape. Tests pinning this behavior
    // prevent a regression where the for-init branch silently accepts a
    // terminating-shaped init while the no-op variant is rejected — the
    // two would diverge on init shape, exactly the gap
    // ac-cleanup-helper-origin-is-trusted prohibits.
    it("should flag serve start --detach when cleanup helper is bound by a ForStatement init to a terminating arrow", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    for (const killPid = (p: number) => process.kill(p, "SIGTERM"); true; ) {
      runKspec("serve start --detach --port 3456");
      const pid = readPidFromFile();
      onTestFinished(() => killPid(pid));
      expect(true).toBe(true);
      break;
    }
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // Cycle-7 reviewer probe (ForOfStatement left binds helper name to
    // a no-op arrow): `for (const killPid of [(_p) => {}]) { ... }`. The
    // left binding is a VariableDeclaration on the for-of statement, not
    // on the body block, so the pre-fix walker missed the binding and
    // the use site fell through to free-identifier trust. The for-of
    // left rebinds on every iteration; even if one of the iterated
    // values were a terminating primitive the rule cannot prove which
    // iteration's value is captured by the cleanup closure. Classified
    // as opaque so the use site is rejected.
    it("should flag serve start --detach when cleanup helper is bound by a ForOfStatement left binding", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    for (const killPid of [(_p: number) => {}]) {
      runKspec("serve start --detach --port 3456");
      const pid = readPidFromFile();
      onTestFinished(() => killPid(pid));
      expect(true).toBe(true);
      break;
    }
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // Cycle-7 variant (ForInStatement left binding): symmetric to the
    // for-of probe. `for (const killPid in { kill: (_p) => {} }) { ... }`
    // — `killPid` is rebound to each enumerable property name on every
    // iteration, so even if the iterated value were callable the binding
    // value at teardown time is a string (the property key), which would
    // throw at call time. Classified as opaque on the same grounds as
    // the for-of variant.
    it("should flag serve start --detach when cleanup helper is bound by a ForInStatement left binding", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    for (const killPid in { kill: (_p: number) => {} }) {
      runKspec("serve start --detach --port 3456");
      const pid = readPidFromFile();
      onTestFinished(() => killPid(pid));
      expect(true).toBe(true);
      break;
    }
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // Cycle-7 reviewer probe (CatchClause param binds helper name):
    // `try { ... } catch (killPid) { runKspec("serve start --detach"); ...
    // onTestFinished(() => killPid(pid)); ... }`. The catch param
    // receives whatever value was thrown — typically an Error instance,
    // never a terminating primitive — and the rule cannot prove the
    // runtime value satisfies cleanup. Pre-fix the walker missed the
    // CatchClause binding entirely. Classified as opaque so the use
    // site is rejected.
    it("should flag serve start --detach when cleanup helper is bound by a CatchClause param", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    try {
      throw new Error("boom");
    } catch (killPid: any) {
      runKspec("serve start --detach --port 3456");
      const pid = readPidFromFile();
      onTestFinished(() => killPid(pid));
      expect(true).toBe(true);
    }
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // Cycle-7 variant (CatchClause destructured param): `catch ({
    // killPid }) { ... }`. ObjectPattern destructuring binds `killPid`
    // from a property of the caught value. The shared `patternBindsName`
    // predicate recognises the destructure binding so the CatchClause
    // branch in `findLocalHelperDefinition` still classifies the use
    // site as opaque.
    it("should flag serve start --detach when cleanup helper is bound by a CatchClause object-destructure param", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    try {
      throw { killPid: (_p: number) => {} };
    } catch ({ killPid }: any) {
      runKspec("serve start --detach --port 3456");
      const pid = readPidFromFile();
      onTestFinished(() => killPid(pid));
      expect(true).toBe(true);
    }
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // Cycle-7 reviewer blocker 1 (bare unimported helper name): a
    // `runKspec("serve start --detach")` followed by `onTestFinished(()
    // => killPid(pid))` where `killPid` has NO import and NO local
    // definition. Pre-fix `isTrustedHelperByOrigin` fell through to
    // `return true` on the free-identifier path — "conservative trust"
    // — silently crediting the bare name as cleanup. The AC explicitly
    // states that helper name alone does not prove daemon termination,
    // so the rule must reject. Post-fix the free-identifier path
    // returns false and this shape is flagged as missing scoped
    // cleanup.
    it("should flag serve start --detach when cleanup calls a bare unimported killPid helper", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => killPid(pid));
    expect(true).toBe(true);
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // Cycle-7 variant (bare unimported stopDaemon): the
    // free-identifier rejection must apply to every name in
    // `TRUSTED_HELPER_NAMES`, not just `killPid`. Same pre-fix gap as
    // the bare-killPid probe — the conservative-trust fallback
    // accepted any unbound name from the trusted-helper set.
    it("should flag serve start --detach when cleanup calls a bare unimported stopDaemon helper", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => stopDaemon(pid));
    expect(true).toBe(true);
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // Cycle-7 reviewer blocker 2 (approved-helper specifier resolved
    // to a nested non-canonical path): a synthetic test under
    // `tests/e2e/` importing `./helpers/daemon` resolves on disk to
    // `tests/e2e/helpers/daemon`, NOT the canonical shared helper at
    // `tests/helpers/daemon`. Pre-fix the approved-import check only
    // tested the raw specifier string, so the relative-prefix
    // prefilter matched and the helper was silently trusted by name.
    // The resolved-path check must reject the import because the
    // resolved path is outside the approved-helper-implementation
    // allowlist (`tests/helpers/daemon.ts`, `tests/helpers/
    // mock-daemon.ts`). The file is placed via `runOxlintAt` at
    // `tests/e2e/synthetic-test.ts` so the import resolution is
    // anchored on the nested test directory.
    it("should flag serve start --detach when cleanup helper is imported via a relative specifier that resolves outside the approved helper path", () => {
      const result = runOxlintAt(
        "tests/e2e/synthetic-test.ts",
        `
import { describe, it, expect, onTestFinished } from "vitest";
import { killPid } from "./helpers/daemon";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => killPid(pid));
    expect(true).toBe(true);
  });
});
`,
      );
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // Cycle-7 blocker 2 variant (intermediate-path relative import
    // resolved off the canonical helper): a synthetic test at
    // `tests/integration/synthetic-test.ts` importing `../helpers/
    // daemon` resolves to `tests/helpers/daemon`, the CANONICAL path.
    // The post-fix resolved-path check must accept this case — the
    // relative-prefix prefilter recognises chained `../` forms and
    // the resolved path matches the implementation allowlist. This
    // negative companion proves the path resolution doesn't
    // over-reject legitimate cross-directory imports of the shared
    // helper, only mis-resolved nested-helper shapes.
    it("should allow serve start --detach when cleanup helper is imported via a relative specifier that resolves to the canonical shared helper path", () => {
      const result = runOxlintAt(
        "tests/integration/synthetic-test.ts",
        `
import { describe, it, expect, onTestFinished } from "vitest";
import { killPid } from "../helpers/daemon";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => killPid(pid));
    expect(true).toBe(true);
  });
});
`,
      );
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // AC: @daemon-test-guardrail-precision ac-cleanup-operation-terminates-daemon
    // Cycle-8 reviewer blocker 1 (approved-helper import aliased from a
    // non-cleanup export): `import { startTestDaemon as killPid } from
    // "./helpers/daemon"` resolves to the canonical approved helper AND
    // the local alias is the recognised cleanup callee name `killPid` —
    // pre-fix the import was trusted by alias-and-path alone. But the
    // IMPORTED export `startTestDaemon` is a daemon STARTER, not a
    // terminating cleanup helper: invoking the local alias at teardown
    // re-starts a daemon instead of stopping the one the test owns.
    // The fix anchors approved-import trust on the imported export
    // name itself, not just the local alias and resolved path.
    it("should flag serve start --detach when cleanup helper is imported via an alias renaming a non-cleanup export from the approved helper path", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";
import { startTestDaemon as killPid } from "./helpers/daemon";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => killPid(pid));
    expect(true).toBe(true);
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // Cycle-8 blocker 1 variant (approved-helper import aliased from a
    // different non-cleanup export): symmetric to the
    // startTestDaemon-as-killPid probe but renaming
    // `allocateTestDaemonPort` (a port allocator, not a cleanup) to the
    // local alias `stopDaemon`. The imported-export-name check must
    // reject ANY non-cleanup export under an aliased local name, not
    // just `startTestDaemon`.
    it("should flag serve start --detach when cleanup helper is imported via an alias renaming an allocator export from the approved helper path", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";
import { allocateTestDaemonPort as stopDaemon } from "./helpers/daemon";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => stopDaemon(pid));
    expect(true).toBe(true);
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // Cycle-8 blocker 1 variant (default import bound to a cleanup-shaped
    // name): `import killPid from "./helpers/daemon"` binds the default
    // export to the local name `killPid` — but a default export could
    // be ANY value the module's `export default` happens to be, and the
    // rule cannot statically tie it to one of the approved cleanup
    // exports. ImportDefaultSpecifier shapes are rejected outright.
    it("should flag serve start --detach when cleanup helper is bound via a default import from the approved helper path", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";
import killPid from "./helpers/daemon";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => killPid(pid));
    expect(true).toBe(true);
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // Cycle-8 blocker 1 variant (namespace import bound to a
    // cleanup-shaped name): `import * as killPid from "./helpers/daemon"`
    // binds the WHOLE module namespace to a single identifier; calling
    // `killPid(pid)` on a module namespace is a TypeError at runtime,
    // but the rule cannot otherwise tie the namespace object to an
    // approved cleanup primitive. ImportNamespaceSpecifier shapes are
    // rejected outright.
    it("should flag serve start --detach when cleanup helper is bound via a namespace import from the approved helper path", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";
import * as killPid from "./helpers/daemon";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => killPid(pid));
    expect(true).toBe(true);
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-operation-terminates-daemon
    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // AC: @daemon-test-guardrail-precision ac-cleanup-probes-do-not-count
    // Cycle-8 reviewer blocker 2 (helper body terminates a hardcoded
    // literal pid that ignores the call-site argument): pre-fix the
    // body inspection accepted any terminating primitive in the
    // helper's body, then separately validated the call-site argument
    // for ownership. The two checks did not connect: a helper body
    // like `function killPid(_pid) { process.kill(12345, "SIGTERM"); }`
    // satisfied the terminating-primitive predicate but always killed
    // a hardcoded literal pid unrelated to whatever the call site
    // passed. The fix requires the kill TARGET to be a verifiable
    // shape (Identifier or non-computed MemberExpression chain) — a
    // Literal target cannot represent the just-started daemon.
    it("should flag serve start --detach when cleanup calls a local killPid whose body process.kill targets a hardcoded literal pid", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

function killPid(_pid: number): void {
  process.kill(12345, "SIGTERM");
}

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => killPid(pid));
    expect(true).toBe(true);
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-operation-terminates-daemon
    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // Cycle-8 blocker 2 variant (arrow helper, literal pid target):
    // same vulnerability surfaced through an arrow-function helper
    // shape. The verifiable-target requirement must apply to every
    // helper body the inspection visits, not only function
    // declarations.
    it("should flag serve start --detach when cleanup calls a local arrow killPid whose body process.kill targets a hardcoded literal pid", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

const killPid = (_pid: number): void => {
  process.kill(99999, "SIGTERM");
};

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => killPid(pid));
    expect(true).toBe(true);
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-operation-terminates-daemon
    // Cycle-8 blocker 2 variant (object-literal kill method whose body
    // terminates a hardcoded literal pid): the child-handle receiver
    // path runs the same helper-body inspection on the literal's
    // `kill` method body. A `{ kill() { process.kill(12345, "SIGTERM");
    // } }` literal satisfies the terminating-primitive predicate but
    // always kills a hardcoded literal pid — same gap as the
    // function-helper variant, surfaced through the receiver-check
    // path.
    it("should flag serve start --detach when cleanup is a local literal whose kill body process.kill targets a hardcoded literal pid", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    const handle = {
      pid,
      kill(_signal: string) { process.kill(12345, "SIGTERM"); },
    };
    onTestFinished(() => handle.kill("SIGTERM"));
    expect(true).toBe(true);
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });

    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-operation-terminates-daemon
    // Cycle-8 blocker 2 variant (top-level cleanup callback with a
    // literal pid target): the top-level cleanup classifier
    // (`isDaemonCleanupCallExpression`) carries the same
    // verifiable-target requirement as helper-body inspection — an
    // `onTestFinished(() => process.kill(12345, "SIGTERM"))` cannot
    // represent the test's owned daemon and falls under the same AC.
    it("should flag serve start --detach when onTestFinished cleanup is process.kill with a hardcoded literal pid target", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    onTestFinished(() => process.kill(12345, "SIGTERM"));
    expect(true).toBe(true);
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("has no scoped cleanup registration");
    });
  });

  describe("negative cases (should NOT flag)", () => {
    // AC: @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged
    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // Negative case: cleanup is registered, so the rule must not flag.
    // The helper-name `killPid` is resolved through the approved helper
    // import (`./helpers/daemon`) which matches
    // `APPROVED_HELPER_IMPORT_PATH_PATTERNS`, so the origin contract is
    // satisfied. Cycle-5 reviewer blocker 2 required this test to back
    // the helper-name claim with a proven origin instead of relying on
    // the free-identifier conservative-trust fallback: a bare,
    // unimported `killPid(pid)` cannot be the canonical accepted shape
    // because the same callee shape covers no-op shadows and unapproved
    // imports that the rule must reject (see the positive flag-it cases
    // for parameter-bound and unapproved-import shadows of the same
    // name).
    it("should allow serve start --detach with onTestFinished cleanup", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";
import { killPid } from "./helpers/daemon";

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

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-before-observation
    // (negative case: defensive guard INSIDE a registered callback is
    // valid — the callback runs at the cleanup boundary regardless of
    // whether the test failed mid-flight, and the inner conditional
    // just protects against running kill on an unset pid.)
    it("should allow serve start --detach with a defensive guard inside the onTestFinished callback", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";
import { killPid } from "./helpers/daemon";

describe("test suite", () => {
  it("should start daemon", () => {
    const result = runKspec("serve start --detach --port 3456");
    onTestFinished(() => {
      if (result.pid) killPid(result.pid);
    });
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-before-observation
    // Cycle-5 reviewer probe (stored arrow with expect, cleanup before
    // invocation): a `const later = () => expect(true).toBe(true)`
    // declaration between the detached start and `onTestFinished` is
    // STORED, not on the straight-line execution path. The earlier
    // walker descended into all function/arrow bodies and treated the
    // inner expect as an observation, falsely reporting `missingCleanup`
    // when cleanup IS registered before the function is actually
    // invoked. The walker must stop at the arrow because its parent is a
    // VariableDeclarator (not an IIFE in callee position) and continue
    // forward so the later `onTestFinished(...)` registration is
    // recognised as cleanup.
    it("should allow serve start --detach when a stored arrow with expect is invoked after cleanup", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";
import { killPid } from "./helpers/daemon";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const later = () => expect(true).toBe(true);
    const pid = readPidFromFile();
    onTestFinished(() => killPid(pid));
    later();
  });
});
`);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-before-observation
    // Cycle-6 negative companion to the binding-order positives: a
    // FunctionDeclaration helper declared AFTER the cleanup registration
    // is still safe. ES2015+ block-scoped function declarations are
    // hoisted with their value to the start of the enclosing scope, so
    // `function killPid(p) { process.kill(p, "SIGTERM"); }` is callable
    // from every statement in the block regardless of source position.
    // The source-order check is intentionally scoped to
    // VariableDeclarator-with-function-init bindings only.
    it("should allow serve start --detach when a hoisted FunctionDeclaration helper is declared after the registration", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => killPid(pid));
    expect(true).toBe(true);
    function killPid(p) { process.kill(p, "SIGTERM"); }
  });
});
`);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-before-observation
    // Cycle-6 negative companion: a `const killPid = ...` arrow init
    // declared BEFORE the cleanup registration is safe. The
    // declarator runs in source order before `onTestFinished` is
    // called, so by the time the cleanup arrow is registered (and
    // certainly by the time it fires at teardown), the binding is
    // initialized. The source-order check accepts this shape because
    // the declarator's index is strictly less than the registration's
    // index in the enclosing block.
    it("should allow serve start --detach when a const arrow helper is declared before the registration", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    const killPid = (p) => process.kill(p, "SIGTERM");
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => killPid(pid));
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // Cycle-7 negative companion: a for-of loop whose left binding is
    // an UNRELATED name (`item`, not `killPid`) does not shadow the
    // approved `killPid` import from `./helpers/daemon`. The parent
    // walk visits the ForOfStatement and finds the binding does not
    // match the target name, so the lookup continues up to the
    // approved import and the use site is credited. Pre-fix this case
    // also passed (the for-of binding scope was simply skipped); the
    // fix must preserve that behavior — only matching bindings should
    // be classified as opaque.
    it("should allow serve start --detach when an unrelated for-of binding precedes the registration", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";
import { killPid } from "./helpers/daemon";

describe("test suite", () => {
  it("should start daemon", () => {
    for (const item of [1, 2, 3]) {
      runKspec("serve start --detach --port 3456");
      const pid = readPidFromFile();
      onTestFinished(() => killPid(pid));
      expect(item).toBe(item);
      break;
    }
  });
});
`);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // Cycle-7 negative companion: a catch clause whose param is an
    // UNRELATED name (`err`, not `killPid`) does not shadow the
    // approved `killPid` import. The CatchClause branch in the walker
    // checks the param against the target name; a non-match falls
    // through and the approved import resolves the use site. Mirror
    // of the unrelated-for-of-binding probe.
    it("should allow serve start --detach when an unrelated catch param precedes the registration", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";
import { killPid } from "./helpers/daemon";

describe("test suite", () => {
  it("should start daemon", () => {
    try {
      runKspec("serve start --detach --port 3456");
      const pid = readPidFromFile();
      onTestFinished(() => killPid(pid));
      expect(true).toBe(true);
    } catch (err: unknown) {
      // unrelated error binding
    }
  });
});
`);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-before-observation
    // Cycle-5 variant (stored function declaration with expect): a named
    // function declared between the detached start and cleanup carries
    // `expect(...)` in its body but is not invoked at the declaration
    // site. The walker must not treat the body as an observation on the
    // straight-line path — the FunctionDeclaration's parent is a
    // BlockStatement, not a CallExpression callee, so descent is pruned.
    it("should allow serve start --detach when a stored named function with expect is invoked after cleanup", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";
import { killPid } from "./helpers/daemon";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    function later() { expect(true).toBe(true); }
    const pid = readPidFromFile();
    onTestFinished(() => killPid(pid));
    later();
  });
});
`);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-before-observation
    // Cycle-6 reviewer probe (unrelated fetch URL between detached start
    // and cleanup): a `fetch("https://example.com/...")` between the
    // detached start and `onTestFinished` is not a daemon observation.
    // The cycle-5 fix made every bare `fetch(...)` count as an observation,
    // which produced a false positive on unrelated network calls. The
    // observation gate must filter on URL — only fetches to a loopback
    // host+port URL count as daemon observations.
    it("should allow serve start --detach when an unrelated fetch URL precedes cleanup", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";
import { killPid } from "./helpers/daemon";

describe("test suite", () => {
  it("should start daemon", () => {
    const result = runKspec("serve start --detach --port 3456");
    fetch("https://example.com/health");
    onTestFinished(() => killPid(result.pid));
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-before-observation
    // Cycle-6 reviewer probe (unrelated WebSocket URL between detached
    // start and cleanup): same shape as the unrelated-fetch probe — a
    // `new WebSocket("wss://example.com/...")` is not a daemon
    // observation, so it must not block recognition of a later in-flow
    // cleanup registration.
    it("should allow serve start --detach when an unrelated WebSocket URL precedes cleanup", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";
import { killPid } from "./helpers/daemon";

describe("test suite", () => {
  it("should start daemon", () => {
    const result = runKspec("serve start --detach --port 3456");
    const ws = new WebSocket("wss://example.com/feed");
    onTestFinished(() => killPid(result.pid));
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-before-observation
    // Cycle-7 negative control: an identifier whose tracked binding
    // RHS is an unrelated URL (not a loopback host+port) must NOT be
    // recognised as a daemon observation by the broadened binding
    // tracker. The broadening only adds `127.0.0.1:` and `[::1]:` to
    // the observed-host set; arbitrary remote hosts must still be
    // ignored by the cleanup-timing gate.
    it("should allow serve start --detach when an identifier-bound unrelated URL precedes cleanup", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";
import { killPid } from "./helpers/daemon";

describe("test suite", () => {
  it("should start daemon", () => {
    const result = runKspec("serve start --detach --port 3456");
    const url = "https://example.com/health";
    fetch(url);
    onTestFinished(() => killPid(result.pid));
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-cleanup-registration-is-test-scoped
    // The accepted per-test cleanup boundary: a vitest `onTestFinished`
    // callback whose terminating cleanup is bound to a concrete pid
    // owned by the just-started daemon BEFORE any later observation
    // can fail. This is the primary shape the spec credits as scoped
    // cleanup, alongside same-flow `try/finally`.
    it("should allow serve start --detach with onTestFinished terminating cleanup at the per-test boundary", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => process.kill(pid, "SIGTERM"));
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-cleanup-registration-is-test-scoped
    // Same-flow `try/finally` is the other accepted per-test cleanup
    // boundary: the finalizer runs whether the try block returns
    // normally or throws, and the captured pid is concretely bound
    // BEFORE the try block opens so the kill owns the daemon at the
    // implicit registration site.
    it("should allow serve start --detach in try/finally whose finalizer kills the concrete pid", () => {
      const result = runOxlint(`
import { describe, it, expect } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    try {
      expect(true).toBe(true);
    } finally {
      process.kill(pid, "SIGTERM");
    }
  });
});
`);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-cleanup-registration-is-test-scoped
    // Mixed case: a per-test `onTestFinished` boundary AND a
    // supplemental `process.on("exit", ...)` fallback. The
    // `onTestFinished` cleanup is what credits the guardrail — the
    // process-lifecycle handler is a defence-in-depth safety net for
    // crashes or hard exits, never the primary cleanup. After the
    // fix-cycle work in @task-fix-guardrail-cleanup-boundary-classification
    // removes `process.on(...)` from the registration set, this mixed
    // case must still be accepted because the per-test boundary alone
    // satisfies the contract.
    it("should allow serve start --detach when onTestFinished is paired with a process.on(\"exit\", ...) fallback", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => process.kill(pid, "SIGTERM"));
    process.on("exit", () => killPid(pid));
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
      // The captured pid is concretely bound BEFORE the try block opens,
      // so the finalizer's process.kill(pid, "SIGTERM") owns the just-
      // started daemon at the moment control crosses the try keyword
      // (the implicit registration site for direct-finalizer cleanup).
      // The earlier shape relied on an undeclared `pid` free identifier,
      // which the cycle-7 ownership leg correctly rejects (the closure
      // cannot own a daemon handle when the binding does not exist).
      // (@daemon-test-guardrail-precision
      // ac-detached-cleanup-bound-before-observation)
      const result = runOxlint(`
import { describe, it, expect } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    try {
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

    // Cleanup-effect semantics: accepted-shape companions to the cleanup
    // -effect adversarial probes in "positive cases (should flag)" above.
    // Each probe pairs a terminating signal or an origin-trusted helper
    // with a detached daemon start and asserts the guardrail does not
    // fire — proving the implementation cannot satisfy the rejected
    // cases by simply banning all `process.kill`, `.kill`, or helper-name
    // cleanup shapes.

    // AC: @daemon-test-guardrail-precision ac-cleanup-operation-terminates-daemon
    // `process.kill(pid)` (no signal) — Node treats a missing signal as
    // SIGTERM, which is the canonical daemon termination signal. The
    // cleanup actually stops the daemon, so the rule must not fire.
    it("should allow serve start --detach when cleanup is process.kill(pid) (no signal, defaults to SIGTERM)", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => process.kill(pid));
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-cleanup-operation-terminates-daemon
    // Explicit SIGTERM is the canonical graceful daemon termination.
    it("should allow serve start --detach when cleanup is process.kill(pid, 'SIGTERM')", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => process.kill(pid, "SIGTERM"));
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-cleanup-operation-terminates-daemon
    // SIGKILL is the unconditional termination signal — receivers cannot
    // mask it. It does terminate the daemon and must be accepted.
    it("should allow serve start --detach when cleanup is process.kill(pid, 'SIGKILL')", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => process.kill(pid, "SIGKILL"));
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-cleanup-operation-terminates-daemon
    // `child.kill()` (no signal) — Node's ChildProcess.kill default is
    // SIGTERM, which is terminating. The child-handle cleanup branch now
    // accepts the no-arg form symmetric with `process.kill(pid)` so a
    // terminating-by-default cleanup is not rejected as missing.
    it("should allow serve start --detach when child.kill() (no signal, defaults to SIGTERM) is registered as cleanup", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";
import { spawn } from "child_process";

describe("test suite", () => {
  it("should start daemon", () => {
    const child = spawn("kspec", ["serve", "start", "--detach", "--port", "3456"]);
    onTestFinished(() => child.kill());
    expect(child.pid).toBeDefined();
  });
});
`);
      expectOxlintRanCleanly(result);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-cleanup-operation-terminates-daemon
    // Explicit SIGTERM on the child handle — already accepted today but
    // documented here as the positive companion to the `child.kill('SIGUSR1')`
    // rejected case so future readers can compare shapes side by side.
    it("should allow serve start --detach when child.kill('SIGTERM') is registered as cleanup", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";
import { spawn } from "child_process";

describe("test suite", () => {
  it("should start daemon", () => {
    const child = spawn("kspec", ["serve", "start", "--detach", "--port", "3456"]);
    onTestFinished(() => child.kill("SIGTERM"));
    expect(child.pid).toBeDefined();
  });
});
`);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // Approved-helper accepted case (origin via import path): `killPid`
    // imported from the shared daemon-fixture helper has a trusted body
    // and must continue to satisfy cleanup. The companion local-no-op
    // probe in "positive cases" rejects an identically-named LOCAL
    // helper, so the implementation cannot fix the false negative by
    // banning the name outright.
    it("should allow serve start --detach when cleanup calls killPid imported from the shared daemon helper", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";
import { killPid } from "./helpers/daemon";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => killPid(pid));
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // Approved-helper accepted case (origin via inspectable body): a
    // local helper whose body invokes a trusted terminating primitive
    // (`process.kill(pid, "SIGTERM")`) must be accepted. The body proves
    // the helper actually stops the daemon — the implementation that
    // rejects local no-op helpers by name alone must still accept
    // helpers whose body contains a terminating call.
    it("should allow serve start --detach when cleanup calls a local killPid helper whose body invokes process.kill SIGTERM", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

function killPid(pid: number): void {
  process.kill(pid, "SIGTERM");
}

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => killPid(pid));
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-cleanup-operation-terminates-daemon
    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // Cycle-4 accepted companion: helper has a terminating default
    // (`function killPid(pid, signal = "SIGTERM")`) and the call site
    // OMITS the signal arg, so the parameter default applies at runtime
    // and the body invokes `process.kill(pid, "SIGTERM")`. This is the
    // canonical legitimate shape used throughout `tests/cli-serve.test.
    // ts`; the override-rejection that closes the cycle-3 blocker must
    // not regress the omitted-arg case.
    it("should allow serve start --detach when cleanup calls killPid omitting the signal so the helper's terminating default applies", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

function killPid(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  process.kill(pid, signal);
}

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => killPid(pid));
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-cleanup-operation-terminates-daemon
    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // Cycle-4 accepted companion: helper has a terminating default and
    // the call site supplies a terminating literal of its own. The
    // helper-body trusts the parameter (default is terminating); the
    // call-site validation also trusts because the literal at the
    // override position is in `TERMINATING_KILL_SIGNALS`. Both checks
    // agree the daemon is stopped, so cleanup is satisfied.
    it("should allow serve start --detach when cleanup calls killPid passing an explicit terminating signal", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

function killPid(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  process.kill(pid, signal);
}

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => killPid(pid, "SIGKILL"));
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-cleanup-operation-terminates-daemon
    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // Cycle-4 accepted companion: call site explicitly passes
    // `undefined`, which in Node `process.kill`/`ChildProcess.kill`
    // collapses to the SIGTERM default for both the call-site direct
    // path and the helper-body override-check path. The helper's body
    // parameter inherits its terminating default the same way the
    // omitted-arg case does.
    it("should allow serve start --detach when cleanup calls killPid passing explicit undefined for the signal", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

function killPid(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  process.kill(pid, signal);
}

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    onTestFinished(() => killPid(pid, undefined));
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-cleanup-helper-origin-is-trusted
    // Cycle-3 accepted companion (nested helper with terminating body):
    // a `function killPid(p) { process.kill(p, "SIGTERM"); }` declared
    // INSIDE the `it` callback must still be accepted. The scope-walking
    // lookup that catches the no-op shape cannot reject inspectable
    // helpers whose body proves termination — that would be a false
    // positive on legitimate per-test scoped cleanup definitions.
    it("should allow serve start --detach when cleanup calls a nested killPid helper whose body invokes process.kill SIGTERM", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    function killPid(p: number): void {
      process.kill(p, "SIGTERM");
    }
    onTestFinished(() => killPid(pid));
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-cleanup-operation-terminates-daemon
    // Receiver-check accepted companion: a local literal whose `kill`
    // method body actually invokes a terminating primitive
    // (`process.kill(pid, "SIGTERM")`) must be accepted. The receiver
    // check that rejects the no-op literal cannot reject this shape —
    // the body proves the cleanup terminates the daemon, mirroring the
    // helper-body acceptance for local helpers whose body contains a
    // terminating call.
    it("should allow serve start --detach when cleanup is a local literal whose kill body invokes process.kill SIGTERM", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = readPidFromFile();
    const handle = {
      pid,
      kill(signal: string) { process.kill(pid, "SIGTERM"); },
    };
    onTestFinished(() => handle.kill("SIGTERM"));
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    // AC: @daemon-test-guardrail-precision ac-cleanup-operation-terminates-daemon
    // Receiver-check accepted companion: when the receiver Identifier
    // is bound to a CallExpression initializer (`spawn(...)`), the
    // child-handle branch must continue to accept `child.kill(...)`
    // because the rule cannot prove the binding is a no-op literal.
    // The receiver check fires only on ObjectExpression literal inits;
    // CallExpression inits fall through unchanged, preserving the
    // canonical legitimate cleanup shape.
    it("should allow serve start --detach when cleanup is child.kill on a binding initialized from spawn", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";
import { spawn } from "child_process";

describe("test suite", () => {
  it("should start daemon", () => {
    const child = spawn("kspec", ["serve", "start", "--detach", "--port", "3456"]);
    onTestFinished(() => child.kill("SIGTERM"));
    expect(child.pid).toBeDefined();
  });
});
`);
      expect(result.output).not.toContain("no-leaky-test-daemon");
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
