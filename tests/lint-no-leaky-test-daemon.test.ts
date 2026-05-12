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

    // AC: @daemon-test-guardrail-precision ac-detached-cleanup-before-observation
    // (negative case: defensive guard INSIDE a registered callback is
    // valid — the callback runs at the cleanup boundary regardless of
    // whether the test failed mid-flight, and the inner conditional
    // just protects against running kill on an unset pid.)
    it("should allow serve start --detach with a defensive guard inside the onTestFinished callback", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

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
