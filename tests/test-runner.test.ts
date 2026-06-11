import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestSubprocessEnv } from "./helpers/cli";

/** Strip ANSI escape codes from a string for clean assertions. */
function stripAnsi(str: string): string {
  // oxlint-disable-next-line no-control-regex -- matching ANSI CSI escape sequences requires the control char
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

const projectRoot = path.resolve(import.meta.dirname, "..");
const runnerScript = path.join(projectRoot, "scripts", "test.cjs");

/** Apply env overrides (undefined = unset), run fn, restore originals. */
function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    const value = overrides[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(saved)) {
      const value = saved[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

/**
 * Run the test runner script as a subprocess and capture output.
 * Uses --dry-run to avoid actually running vitest.
 */
function runTestRunner(
  args: string[] = [],
  env: Record<string, string> = {},
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("node", [runnerScript, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: buildTestSubprocessEnv(env),
    timeout: 60_000,
  });
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    status: result.status ?? 1,
  };
}

function writeBuiltProjectFixture(rootDir: string): void {
  for (const input of [
    "src/cli/commands/plan-import.ts",
    "packages/shared/src/index.ts",
    "packages/daemon/src/index.ts",
    "packages/web-ui/src/app.html",
    "packages/web-ui/static/favicon.png",
    "package.json",
    "tsconfig.json",
    "packages/shared/package.json",
    "packages/daemon/package.json",
    "packages/web-ui/package.json",
    "packages/web-ui/vite.config.ts",
    "packages/web-ui/svelte.config.js",
  ]) {
    const fullPath = path.join(rootDir, input);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, "");
  }

  for (const artifact of [
    "dist/cli/index.js",
    "packages/shared/dist/index.js",
    "dist/web-ui/index.html",
    "packages/web-ui/.svelte-kit/output/server/manifest-full.js",
    "dist/daemon/index.js",
    "dist/daemon/entity-cache.js",
  ]) {
    const fullPath = path.join(rootDir, artifact);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, "");
  }
}

function writeInstallablePackage(nodeModulesRoot: string, packageName: string): void {
  const packageDir = path.join(nodeModulesRoot, ...packageName.split("/"));
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify(
      {
        name: packageName,
        version: "1.0.0",
        main: "index.js",
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(path.join(packageDir, "index.js"), "module.exports = 'ok';\n");
}

// Import the shipped module — tests exercise this, not reimplemented logic
const runner = require("../scripts/test.cjs");

describe("test runner environment checks", () => {
  // AC: @test-suite-perf-reliability ac-5
  describe("prerequisite verification and auto-fix", () => {
    it("dry-run succeeds when environment is ready", () => {
      const result = runTestRunner(["--dry-run"]);
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("Environment check passed");
    });

    it("checkBuild passes for an isolated built project fixture", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kspec-test-runner-built-"));

      try {
        writeBuiltProjectFixture(tempDir);
        expect(runner.checkBuild(tempDir).ok).toBe(true);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("ensureEnvironment runs all hooks and returns fix count", () => {
      // Environment is already ready, so fixedCount should be 0
      const fixedCount = runner.ensureEnvironment();
      expect(fixedCount).toBe(0);
    });

    it("build hook respects SKIP_BUILD env var", () => {
      const buildHook = runner.preTestHooks.find((h: { name: string }) => h.name === "build");
      expect(buildHook).toBeDefined();
      expect(typeof buildHook.skip).toBe("function");

      const origVal = process.env.SKIP_BUILD;
      try {
        delete process.env.SKIP_BUILD;
        expect(buildHook.skip()).toBe(false);
        process.env.SKIP_BUILD = "1";
        expect(buildHook.skip()).toBe(true);
      } finally {
        if (origVal !== undefined) {
          process.env.SKIP_BUILD = origVal;
        } else {
          delete process.env.SKIP_BUILD;
        }
      }
    });
  });

  // AC: @test-suite-perf-reliability ac-5
  describe("auto-fix flow", () => {
    it("ensureEnvironment calls fix when check fails, then re-checks", () => {
      // Save original hooks and inject a simulated failing hook
      const originalHooks = [...runner.preTestHooks];
      let fixCalled = false;
      let checkCallCount = 0;

      // Clear hooks and add a test hook that fails first, then passes after fix
      runner.preTestHooks.length = 0;
      runner.preTestHooks.push({
        name: "test-hook",
        check: () => {
          checkCallCount++;
          if (!fixCalled) {
            return { ok: false, reason: "simulated missing prerequisite" };
          }
          return { ok: true };
        },
        fix: () => {
          fixCalled = true;
        },
      });

      try {
        const fixedCount = runner.ensureEnvironment();

        // Fix was called
        expect(fixCalled).toBe(true);
        // One issue fixed
        expect(fixedCount).toBe(1);
        // Check was called twice: initial check + re-check after fix
        expect(checkCallCount).toBe(2);
      } finally {
        // Restore original hooks
        runner.preTestHooks.length = 0;
        runner.preTestHooks.push(...originalHooks);
      }
    });

    describe("checkBuild missing-artifact detection (temp-dir isolated)", () => {
      let tempDir: string;

      beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kspec-test-runner-"));
      });

      afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
      });

      it("detects when dist/daemon/index.js is missing", () => {
        // Create all artifacts except dist/daemon/index.js
        for (const artifact of [
          "dist/cli/index.js",
          "packages/shared/dist/index.js",
          "dist/web-ui/index.html",
          "packages/web-ui/.svelte-kit/output/server/manifest-full.js",
        ]) {
          const fullPath = path.join(tempDir, artifact);
          fs.mkdirSync(path.dirname(fullPath), { recursive: true });
          fs.writeFileSync(fullPath, "");
        }

        const result = runner.checkBuild(tempDir);
        expect(result.ok).toBe(false);
        expect(result.reason).toContain("dist/daemon/index.js not found");
      });

      it("detects when dist/web-ui/index.html is missing", () => {
        for (const artifact of [
          "dist/cli/index.js",
          "packages/shared/dist/index.js",
          "packages/web-ui/.svelte-kit/output/server/manifest-full.js",
          "dist/daemon/index.js",
          "dist/daemon/entity-cache.js",
        ]) {
          const fullPath = path.join(tempDir, artifact);
          fs.mkdirSync(path.dirname(fullPath), { recursive: true });
          fs.writeFileSync(fullPath, "");
        }

        const result = runner.checkBuild(tempDir);
        expect(result.ok).toBe(false);
        expect(result.reason).toContain("dist/web-ui/index.html not found");
      });

      it("detects when dist/cli/index.js is missing", () => {
        for (const artifact of [
          "packages/shared/dist/index.js",
          "dist/web-ui/index.html",
          "packages/web-ui/.svelte-kit/output/server/manifest-full.js",
          "dist/daemon/index.js",
          "dist/daemon/entity-cache.js",
        ]) {
          const fullPath = path.join(tempDir, artifact);
          fs.mkdirSync(path.dirname(fullPath), { recursive: true });
          fs.writeFileSync(fullPath, "");
        }

        const result = runner.checkBuild(tempDir);
        expect(result.ok).toBe(false);
        expect(result.reason).toContain("dist/cli/index.js not found");
      });

      it("succeeds when all artifacts are present", () => {
        for (const artifact of [
          "dist/cli/index.js",
          "packages/shared/dist/index.js",
          "dist/web-ui/index.html",
          "packages/web-ui/.svelte-kit/output/server/manifest-full.js",
          "dist/daemon/index.js",
          "dist/daemon/entity-cache.js",
        ]) {
          const fullPath = path.join(tempDir, artifact);
          fs.mkdirSync(path.dirname(fullPath), { recursive: true });
          fs.writeFileSync(fullPath, "");
        }

        const result = runner.checkBuild(tempDir);
        expect(result.ok).toBe(true);
      });

      it("detects stale build artifacts when a source file is newer", async () => {
        for (const artifact of [
          "dist/cli/index.js",
          "packages/shared/dist/index.js",
          "dist/web-ui/index.html",
          "packages/web-ui/.svelte-kit/output/server/manifest-full.js",
          "dist/daemon/index.js",
          "dist/daemon/entity-cache.js",
        ]) {
          const fullPath = path.join(tempDir, artifact);
          fs.mkdirSync(path.dirname(fullPath), { recursive: true });
          fs.writeFileSync(fullPath, "");
        }

        await new Promise((resolve) => setTimeout(resolve, 20));

        const sourcePath = path.join(tempDir, "src", "cli", "commands", "plan-import.ts");
        fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
        fs.writeFileSync(sourcePath, "// newer than dist");

        const result = runner.checkBuild(tempDir);
        expect(result.ok).toBe(false);
        expect(result.reason).toContain("src");
        expect(result.reason).toContain("is newer than build artifacts");
      });

      it("detects empty temp dir with no artifacts", () => {
        const result = runner.checkBuild(tempDir);
        expect(result.ok).toBe(false);
        expect(result.reason).toContain("not found");
      });

      it("detects when the shared package build output is missing", () => {
        for (const artifact of [
          "dist/cli/index.js",
          "dist/web-ui/index.html",
          "packages/web-ui/.svelte-kit/output/server/manifest-full.js",
          "dist/daemon/index.ts",
          "dist/daemon/entity-cache.ts",
        ]) {
          const fullPath = path.join(tempDir, artifact);
          fs.mkdirSync(path.dirname(fullPath), { recursive: true });
          fs.writeFileSync(fullPath, "");
        }

        const result = runner.checkBuild(tempDir);
        expect(result.ok).toBe(false);
        expect(result.reason).toContain("packages/shared/dist/index.js not found");
      });

      it("detects when the SvelteKit server manifest is missing", () => {
        for (const artifact of [
          "dist/cli/index.js",
          "packages/shared/dist/index.js",
          "dist/web-ui/index.html",
          "dist/daemon/index.ts",
          "dist/daemon/entity-cache.ts",
        ]) {
          const fullPath = path.join(tempDir, artifact);
          fs.mkdirSync(path.dirname(fullPath), { recursive: true });
          fs.writeFileSync(fullPath, "");
        }

        const result = runner.checkBuild(tempDir);
        expect(result.ok).toBe(false);
        expect(result.reason).toContain(
          "packages/web-ui/.svelte-kit/output/server/manifest-full.js not found",
        );
      });
    });

    describe("checkDependencies missing detection (temp-dir isolated)", () => {
      let tempDir: string;

      beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kspec-test-runner-"));
      });

      afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
      });

      it("detects missing node_modules", () => {
        fs.writeFileSync(
          path.join(tempDir, "package.json"),
          JSON.stringify({ devDependencies: { vitest: "^4.0.0" } }),
        );
        fs.writeFileSync(path.join(tempDir, "package-lock.json"), "{}");
        const result = runner.checkDependencies(tempDir);
        expect(result.ok).toBe(false);
        expect(result.reason).toContain("node_modules/ not found");
      });

      it("detects missing vitest in node_modules", () => {
        fs.mkdirSync(path.join(tempDir, "node_modules"), { recursive: true });
        fs.writeFileSync(
          path.join(tempDir, "package.json"),
          JSON.stringify({ devDependencies: { vitest: "^4.0.0" } }),
        );
        fs.writeFileSync(path.join(tempDir, "package-lock.json"), "{}");
        const result = runner.checkDependencies(tempDir);
        expect(result.ok).toBe(false);
        expect(result.reason).toContain("vitest");
      });

      it("detects newly added direct dependencies that are missing from node_modules", () => {
        fs.mkdirSync(path.join(tempDir, "node_modules", "vitest"), { recursive: true });
        fs.writeFileSync(
          path.join(tempDir, "package.json"),
          JSON.stringify({
            dependencies: { croner: "^10.0.0" },
            devDependencies: { vitest: "^4.0.0" },
          }),
        );
        fs.writeFileSync(path.join(tempDir, "package-lock.json"), "{}");

        const result = runner.checkDependencies(tempDir);
        expect(result.ok).toBe(false);
        expect(result.reason).toContain("croner");
      });

      it("passes when node_modules and vitest exist", () => {
        fs.mkdirSync(path.join(tempDir, "node_modules", "vitest"), { recursive: true });
        fs.mkdirSync(path.join(tempDir, "node_modules", "croner"), { recursive: true });
        fs.writeFileSync(
          path.join(tempDir, "package.json"),
          JSON.stringify({
            dependencies: { croner: "^10.0.0" },
            devDependencies: { vitest: "^4.0.0" },
          }),
        );
        fs.writeFileSync(path.join(tempDir, "package-lock.json"), "{}");
        const result = runner.checkDependencies(tempDir);
        expect(result.ok).toBe(true);
      });

      it("accepts direct dependencies resolved from an ancestor node_modules", () => {
        const projectDir = path.join(tempDir, "project");
        const workspaceDir = path.join(projectDir, ".kspec-worktrees", "review");
        fs.mkdirSync(path.join(projectDir, "node_modules"), { recursive: true });
        fs.mkdirSync(workspaceDir, { recursive: true });
        writeInstallablePackage(path.join(projectDir, "node_modules"), "vitest");
        writeInstallablePackage(path.join(projectDir, "node_modules"), "croner");
        fs.writeFileSync(
          path.join(workspaceDir, "package.json"),
          JSON.stringify({
            dependencies: { croner: "^10.0.0" },
            devDependencies: { vitest: "^4.0.0" },
          }),
        );
        fs.writeFileSync(path.join(workspaceDir, "package-lock.json"), "{}");

        const result = runner.checkDependencies(workspaceDir);
        expect(result.ok).toBe(true);
      });

      it("rejects dependencies found only above the project root", () => {
        const projectDir = path.join(tempDir, "project");
        const workspaceDir = path.join(projectDir, ".kspec-worktrees", "review");
        fs.mkdirSync(path.join(tempDir, "node_modules"), { recursive: true });
        writeInstallablePackage(path.join(tempDir, "node_modules"), "vitest");
        writeInstallablePackage(path.join(tempDir, "node_modules"), "croner");
        fs.mkdirSync(workspaceDir, { recursive: true });
        fs.writeFileSync(
          path.join(workspaceDir, "package.json"),
          JSON.stringify({
            dependencies: { croner: "^10.0.0" },
            devDependencies: { vitest: "^4.0.0" },
          }),
        );
        fs.writeFileSync(path.join(workspaceDir, "package-lock.json"), "{}");

        const result = runner.checkDependencies(workspaceDir);
        expect(result.ok).toBe(false);
        expect(result.reason).toContain("node_modules/ not found");
      });
    });
  });

  // AC: @test-suite-perf-reliability ac-6
  describe("structured output and extensibility", () => {
    it("dry-run output goes to stderr, keeping stdout clean for piping", () => {
      const result = runTestRunner(["--dry-run"]);
      expect(result.stderr).toContain("[test-runner]");
      // stdout should be empty or minimal (no setup noise)
      expect(result.stdout.trim()).toBe("");
    });

    it("setup noise is suppressed — fix steps only emit runner-level status", () => {
      // Run dry-run and confirm all output is runner-prefixed, no raw npm noise
      const result = runTestRunner(["--dry-run"]);
      for (const line of result.stderr.split("\n").filter((l) => l.trim())) {
        expect(line).toContain("[test-runner]");
      }
    });

    it("passes vitest arguments through", () => {
      const result = runTestRunner(["--dry-run", "--shard=1/3"]);
      // dry-run exits before vitest, but args should be parsed without error
      expect(result.status).toBe(0);
    });

    it("shows pass/fail summary after test execution", () => {
      // Create a trivial temp test file inside the project so vitest's include pattern matches
      const tempTestFile = path.join(projectRoot, "tests", "_trivial-summary-check.test.ts");
      fs.writeFileSync(
        tempTestFile,
        `import { it, expect } from 'vitest';\nit('passes', () => { expect(1).toBe(1); });\n`,
      );

      try {
        const result = spawnSync(
          "node",
          [runnerScript, "--reporter=dot", "tests/_trivial-summary-check.test.ts"],
          {
            cwd: projectRoot,
            encoding: "utf8",
            env: buildTestSubprocessEnv({ SKIP_BUILD: "1" }),
            timeout: 30_000,
          },
        );

        // Must show a summary line — and specifically "Tests passed" for a passing run
        expect(result.stderr).toContain("[test-runner]");
        expect(result.stderr).toContain("Tests passed");
        expect(result.status).toBe(0);
      } finally {
        fs.unlinkSync(tempTestFile);
      }
    });

    it("verbose live run persists a log file in session cache", () => {
      const tempTestFile = path.join(projectRoot, "tests", "_trivial-verbose-check.test.ts");
      fs.writeFileSync(
        tempTestFile,
        `import { it, expect } from 'vitest';\nit('passes', () => { expect(1).toBe(1); });\n`,
      );

      // Use a unique session ID to isolate this test's cache
      const sessionId = `test-verbose-${Date.now()}`;
      const cacheDir = path.join(os.tmpdir(), "kspec-test-cache", sessionId);

      try {
        const result = spawnSync(
          "node",
          [runnerScript, "--fresh", "--verbose", "tests/_trivial-verbose-check.test.ts"],
          {
            cwd: projectRoot,
            encoding: "utf8",
            env: buildTestSubprocessEnv({ SKIP_BUILD: "1", KSPEC_SESSION_ID: sessionId }),
            timeout: 30_000,
          },
        );

        expect(result.status).toBe(0);
        expect(result.stderr).toContain("Tests passed");

        // A .log file must exist in the session cache
        const cacheFiles = fs.readdirSync(cacheDir);
        const logFiles = cacheFiles.filter((f) => f.endsWith(".log"));
        expect(logFiles.length).toBeGreaterThanOrEqual(1);

        // The log file should contain vitest verbose output
        const logContent = fs.readFileSync(path.join(cacheDir, logFiles[0]), "utf8");
        expect(logContent).toContain("passes");
      } finally {
        fs.unlinkSync(tempTestFile);
        fs.rmSync(cacheDir, { recursive: true, force: true });
      }
    });

    it("verbose cache hit streams full log instead of condensed output", () => {
      const tempTestFile = path.join(projectRoot, "tests", "_trivial-verbose-cache.test.ts");
      fs.writeFileSync(
        tempTestFile,
        `import { it, expect } from 'vitest';\nit('passes verbose cache', () => { expect(1).toBe(1); });\n`,
      );

      const sessionId = `test-verbose-cache-${Date.now()}`;
      const cacheDir = path.join(os.tmpdir(), "kspec-test-cache", sessionId);

      try {
        // First run: populate cache (condensed mode)
        const firstRun = spawnSync(
          "node",
          [runnerScript, "--fresh", "tests/_trivial-verbose-cache.test.ts"],
          {
            cwd: projectRoot,
            encoding: "utf8",
            env: buildTestSubprocessEnv({ SKIP_BUILD: "1", KSPEC_SESSION_ID: sessionId }),
            timeout: 30_000,
          },
        );
        expect(firstRun.status).toBe(0);

        // Second run: verbose with cached results
        const verboseRun = spawnSync(
          "node",
          [runnerScript, "--verbose", "tests/_trivial-verbose-cache.test.ts"],
          {
            cwd: projectRoot,
            encoding: "utf8",
            env: buildTestSubprocessEnv({ SKIP_BUILD: "1", KSPEC_SESSION_ID: sessionId }),
            timeout: 30_000,
          },
        );

        expect(verboseRun.status).toBe(0);
        expect(verboseRun.stderr).toContain("Using cached results");
        // Verbose cached hit must stream the full log, which contains individual test names
        expect(verboseRun.stdout).toContain("passes verbose cache");
      } finally {
        fs.unlinkSync(tempTestFile);
        fs.rmSync(cacheDir, { recursive: true, force: true });
      }
    });

    it("exposes preTestHooks and postTestHooks arrays for extensibility", () => {
      expect(runner.preTestHooks).toBeInstanceOf(Array);
      expect(runner.preTestHooks.length).toBeGreaterThanOrEqual(2);
      expect(runner.postTestHooks).toBeInstanceOf(Array);

      // Each hook has the required interface
      for (const hook of runner.preTestHooks) {
        expect(hook).toHaveProperty("name");
        expect(typeof hook.name).toBe("string");
        expect(typeof hook.check).toBe("function");
        expect(typeof hook.fix).toBe("function");
      }
    });
  });

  // Coverage: task-test-cache-env-key (test infrastructure — convention + task, no spec ACs)
  describe("cache key environment component", () => {
    describe("computeEnvCacheComponent", () => {
      it("includes allowlisted vars and ignores irrelevant environment churn", () => {
        const base = { CI: "true", TZ: "UTC" };
        const withChurn = { ...base, PWD: "/somewhere/else", SHLVL: "7", TERM: "xterm" };
        expect(runner.computeEnvCacheComponent(withChurn)).toBe(
          runner.computeEnvCacheComponent(base),
        );
      });

      it("includes KSPEC_-prefixed vars except KSPEC_SESSION_ID and KSPEC_TEST_PROGRESS", () => {
        const base = { KSPEC_NO_DAEMON: "1" };
        expect(
          runner.computeEnvCacheComponent({
            ...base,
            KSPEC_SESSION_ID: "session-a",
            KSPEC_TEST_PROGRESS: "0",
          }),
        ).toBe(runner.computeEnvCacheComponent(base));

        expect(runner.computeEnvCacheComponent({ ...base, KSPEC_SOME_FLAG: "on" })).not.toBe(
          runner.computeEnvCacheComponent(base),
        );
      });

      it("distinguishes unset from empty-string values", () => {
        expect(runner.computeEnvCacheComponent({ CI: "" })).not.toBe(
          runner.computeEnvCacheComponent({}),
        );
      });

      it("is deterministic regardless of env key insertion order", () => {
        const a = runner.computeEnvCacheComponent({ TZ: "UTC", CI: "true", NODE_ENV: "test" });
        const b = runner.computeEnvCacheComponent({ NODE_ENV: "test", CI: "true", TZ: "UTC" });
        expect(a).toBe(b);
      });

      it("keeps pair boundaries unambiguous for values containing separators", () => {
        expect(runner.computeEnvCacheComponent({ NODE_OPTIONS: "--a\nTZ=UTC" })).not.toBe(
          runner.computeEnvCacheComponent({ NODE_OPTIONS: "--a", TZ: "UTC" }),
        );
      });
    });

    describe("computeCacheKey env sensitivity", () => {
      it("produces a different key when a behavior-affecting var changes, stable otherwise", () => {
        withEnv({ CI: undefined, KSPEC_CACHE_KEY_PROBE: undefined }, () => {
          const baseline = runner.computeCacheKey([]);
          expect(baseline).not.toBeNull();

          // Same env → same key
          expect(runner.computeCacheKey([])).toBe(baseline);

          // CI set → different key
          withEnv({ CI: "true" }, () => {
            expect(runner.computeCacheKey([])).not.toBe(baseline);
          });

          // Arbitrary KSPEC_* var set → different key
          withEnv({ KSPEC_CACHE_KEY_PROBE: "1" }, () => {
            expect(runner.computeCacheKey([])).not.toBe(baseline);
          });

          // Back to baseline env → original key again (distinct keys coexist)
          expect(runner.computeCacheKey([])).toBe(baseline);
        });
      });

      it("excluded vars do not change the key", () => {
        const baseline = runner.computeCacheKey([]);
        expect(baseline).not.toBeNull();

        withEnv(
          {
            KSPEC_SESSION_ID: "some-other-session",
            KSPEC_TEST_PROGRESS: "0",
            KSPEC_BUILD_TEST_LOCK_HELD: "/tmp/some.lock",
            KSPEC_BUILD_TEST_LOCK_HELD_LABEL: "test",
          },
          () => {
            expect(runner.computeCacheKey([])).toBe(baseline);
          },
        );
      });
    });

    // Coverage: task-stabilize-upgrade-folder-storage-test (test infrastructure
    // — convention + task, no spec ACs). The cache key must hash every script
    // that shapes test runner behavior, or edits to them can be hidden by a
    // stale cached result.
    describe("cache key input paths", () => {
      function isCacheInput(file: string): boolean {
        return runner.TEST_INPUT_PATHS.some((entry: string) =>
          entry.endsWith("/") ? file.startsWith(entry) : file === entry,
        );
      }

      it("covers the runner, its requires, and the build scripts tests exercise", () => {
        const required = [
          "scripts/test.cjs",
          "scripts/test-progress-reporter.cjs",
          "scripts/dependency-health.cjs",
          "scripts/build-test-lock.cjs",
          "scripts/build.cjs",
          "scripts/build-daemon.cjs",
        ];
        expect(required.filter((file) => !isCacheInput(file))).toEqual([]);
      });

      it("invalidates the key when a file under scripts/ changes", () => {
        const baseline = runner.computeCacheKey([]);
        expect(baseline).not.toBeNull();

        // Untracked files in cache input paths are content-hashed, so an
        // added (or edited) script must produce a different key.
        const probe = path.join(projectRoot, "scripts", `_cache-key-probe-${process.pid}.cjs`);
        fs.writeFileSync(probe, "// cache key probe — safe to delete\n");
        try {
          expect(runner.computeCacheKey([])).not.toBe(baseline);
        } finally {
          fs.rmSync(probe, { force: true });
        }
        expect(runner.computeCacheKey([])).toBe(baseline);
      });
    });
  });

  // Coverage: test-runner-progress-output (no spec AC exists yet) ac-1
  // Coverage: test-runner-progress-output (no spec AC exists yet) ac-3
  // Coverage: test-runner-progress-output (no spec AC exists yet) ac-5
  // Coverage: test-runner-progress-output (no spec AC exists yet) ac-6
  describe("per-file progress output", () => {
    it("non-verbose mode prints one PASS line per completed test file with count and duration", () => {
      const tempTestFile = path.join(projectRoot, "tests", "_trivial-progress.test.ts");
      fs.rmSync(tempTestFile, { force: true });
      fs.writeFileSync(
        tempTestFile,
        `import { it, expect } from 'vitest';
it('alpha', () => { expect(1).toBe(1); });
it('beta', () => { expect(2).toBe(2); });
`,
      );

      const sessionId = `test-progress-${Date.now()}`;
      const cacheDir = path.join(os.tmpdir(), "kspec-test-cache", sessionId);

      try {
        const result = spawnSync(
          "node",
          [runnerScript, "--fresh", "tests/_trivial-progress.test.ts"],
          {
            cwd: projectRoot,
            encoding: "utf8",
            env: buildTestSubprocessEnv({ SKIP_BUILD: "1", KSPEC_SESSION_ID: sessionId }),
            timeout: 30_000,
          },
        );

        expect(result.status).toBe(0);

        const stderr = stripAnsi(result.stderr);
        // Must contain a PASS line for the test file
        const progressLines = stderr.split("\n").filter((l) => l.trim().startsWith("PASS"));
        expect(progressLines.length).toBe(1);

        const line = progressLines[0].trim();
        // Format: PASS tests/_trivial-progress.test.ts (2 tests, Xms)
        expect(line).toMatch(/^PASS\s+tests\/_trivial-progress\.test\.ts\s+\(/);
        expect(line).toContain("2 tests");
        // Duration present (ends with ms or s)
        expect(line).toMatch(/\d+m?s/);

        // Final summary still appears
        expect(stderr).toContain("Tests passed");
        expect(stderr).toContain("Test Suites:");
      } finally {
        fs.rmSync(tempTestFile, { force: true });
        fs.rmSync(cacheDir, { recursive: true, force: true });
      }
    });

    // Coverage: test-runner-progress-output (no spec AC exists yet) ac-1
    it("shows FAIL marker and failed count for failing test files", () => {
      const tempTestFile = path.join(projectRoot, "tests", "_trivial-fail-progress.test.ts");
      fs.rmSync(tempTestFile, { force: true });
      fs.writeFileSync(
        tempTestFile,
        `import { it, expect } from 'vitest';
it('passes', () => { expect(1).toBe(1); });
it('fails', () => { expect(1).toBe(2); });
`,
      );

      const sessionId = `test-fail-progress-${Date.now()}`;
      const cacheDir = path.join(os.tmpdir(), "kspec-test-cache", sessionId);

      try {
        const result = spawnSync(
          "node",
          [runnerScript, "--fresh", "tests/_trivial-fail-progress.test.ts"],
          {
            cwd: projectRoot,
            encoding: "utf8",
            env: buildTestSubprocessEnv({ SKIP_BUILD: "1", KSPEC_SESSION_ID: sessionId }),
            timeout: 30_000,
          },
        );

        expect(result.status).toBe(1);

        const stderr = stripAnsi(result.stderr);
        const progressLines = stderr.split("\n").filter((l) => l.trim().startsWith("FAIL"));
        // At least one FAIL line from the progress reporter (may also have FAIL in condensed output)
        expect(progressLines.length).toBeGreaterThanOrEqual(1);

        // The first FAIL line should be the progress line with count info
        const progressLine = progressLines.find((l) => l.includes("_trivial-fail-progress"));
        expect(progressLine).toBeDefined();
        expect(progressLine).toContain("1 failed");
        expect(progressLine).toContain("2 tests");
      } finally {
        fs.rmSync(tempTestFile, { force: true });
        fs.rmSync(cacheDir, { recursive: true, force: true });
      }
    });

    // Coverage: test-runner-progress-output (no spec AC exists yet) ac-2
    it("progress lines are suppressed in verbose mode", () => {
      const tempTestFile = path.join(projectRoot, "tests", "_trivial-verbose-progress.test.ts");
      fs.rmSync(tempTestFile, { force: true });
      fs.writeFileSync(
        tempTestFile,
        `import { it, expect } from 'vitest';\nit('passes', () => { expect(1).toBe(1); });\n`,
      );

      const sessionId = `test-verbose-progress-${Date.now()}`;
      const cacheDir = path.join(os.tmpdir(), "kspec-test-cache", sessionId);

      try {
        const result = spawnSync(
          "node",
          [runnerScript, "--fresh", "--verbose", "tests/_trivial-verbose-progress.test.ts"],
          {
            cwd: projectRoot,
            encoding: "utf8",
            env: buildTestSubprocessEnv({ SKIP_BUILD: "1", KSPEC_SESSION_ID: sessionId }),
            timeout: 30_000,
          },
        );

        expect(result.status).toBe(0);

        const stderr = stripAnsi(result.stderr);
        // In verbose mode, no progress lines (PASS/FAIL with file path and test count)
        const progressLines = stderr
          .split("\n")
          .filter((l) => l.trim().startsWith("PASS") && l.includes("test"));
        expect(progressLines.length).toBe(0);

        // But verbose output still appears on stdout
        expect(result.stdout).toContain("passes");
      } finally {
        fs.rmSync(tempTestFile, { force: true });
        fs.rmSync(cacheDir, { recursive: true, force: true });
      }
    });

    // Coverage: test-runner-progress-output (no spec AC exists yet) ac-4
    it("output volume is proportional to file count, not test count", () => {
      // Create a file with many tests — progress output should still be 1 line
      const tempTestFile = path.join(projectRoot, "tests", "_trivial-volume.test.ts");
      fs.rmSync(tempTestFile, { force: true });
      const tests = Array.from(
        { length: 20 },
        (_, i) => `it('test-${i}', () => { expect(${i}).toBe(${i}); });`,
      ).join("\n");
      fs.writeFileSync(tempTestFile, `import { it, expect } from 'vitest';\n${tests}\n`);

      const sessionId = `test-volume-${Date.now()}`;
      const cacheDir = path.join(os.tmpdir(), "kspec-test-cache", sessionId);

      try {
        const result = spawnSync(
          "node",
          [runnerScript, "--fresh", "tests/_trivial-volume.test.ts"],
          {
            cwd: projectRoot,
            encoding: "utf8",
            env: buildTestSubprocessEnv({ SKIP_BUILD: "1", KSPEC_SESSION_ID: sessionId }),
            timeout: 30_000,
          },
        );

        expect(result.status).toBe(0);

        const stderr = stripAnsi(result.stderr);
        // Exactly 1 progress PASS line despite 20 tests
        const progressLines = stderr.split("\n").filter((l) => l.trim().startsWith("PASS"));
        expect(progressLines.length).toBe(1);
        expect(progressLines[0]).toContain("20 tests");
      } finally {
        fs.rmSync(tempTestFile, { force: true });
        fs.rmSync(cacheDir, { recursive: true, force: true });
      }
    });

    // Coverage: test-runner-progress-output (no spec AC exists yet) ac-5
    it("final summary and exit code are unchanged with progress enabled", () => {
      const tempTestFile = path.join(projectRoot, "tests", "_trivial-summary-unchanged.test.ts");
      fs.rmSync(tempTestFile, { force: true });
      fs.writeFileSync(
        tempTestFile,
        `import { it, expect } from 'vitest';\nit('passes', () => { expect(1).toBe(1); });\n`,
      );

      const sessionId = `test-summary-unchanged-${Date.now()}`;
      const cacheDir = path.join(os.tmpdir(), "kspec-test-cache", sessionId);

      try {
        const result = spawnSync(
          "node",
          [runnerScript, "--fresh", "tests/_trivial-summary-unchanged.test.ts"],
          {
            cwd: projectRoot,
            encoding: "utf8",
            env: buildTestSubprocessEnv({ SKIP_BUILD: "1", KSPEC_SESSION_ID: sessionId }),
            timeout: 30_000,
          },
        );

        expect(result.status).toBe(0);

        const stderr = stripAnsi(result.stderr);
        // Final summary still present
        expect(stderr).toContain("Test Suites:");
        expect(stderr).toContain("Tests:");
        expect(stderr).toContain("Duration:");
        expect(stderr).toContain("Tests passed");
        // Log file reference still present
        expect(stderr).toContain("Full log:");
      } finally {
        fs.rmSync(tempTestFile, { force: true });
        fs.rmSync(cacheDir, { recursive: true, force: true });
      }
    });

    // Coverage: test-runner-progress-output (no spec AC exists yet) ac-5
    it("progress lines are not written to the log file", () => {
      const tempTestFile = path.join(projectRoot, "tests", "_trivial-log-clean.test.ts");
      fs.rmSync(tempTestFile, { force: true });
      fs.writeFileSync(
        tempTestFile,
        `import { it, expect } from 'vitest';\nit('passes', () => { expect(1).toBe(1); });\n`,
      );

      const sessionId = `test-log-clean-${Date.now()}`;
      const cacheDir = path.join(os.tmpdir(), "kspec-test-cache", sessionId);

      try {
        const result = spawnSync(
          "node",
          [runnerScript, "--fresh", "tests/_trivial-log-clean.test.ts"],
          {
            cwd: projectRoot,
            encoding: "utf8",
            env: buildTestSubprocessEnv({ SKIP_BUILD: "1", KSPEC_SESSION_ID: sessionId }),
            timeout: 30_000,
          },
        );

        expect(result.status).toBe(0);

        // Progress line should appear on stderr (terminal)
        const stderr = stripAnsi(result.stderr);
        const progressLines = stderr.split("\n").filter((l) => l.trim().startsWith("PASS"));
        expect(progressLines.length).toBe(1);

        // But the cached log file must NOT contain the progress line
        const cacheFiles = fs.readdirSync(cacheDir);
        const logFiles = cacheFiles.filter((f) => f.endsWith(".log"));
        expect(logFiles.length).toBeGreaterThanOrEqual(1);

        const logContent = stripAnsi(fs.readFileSync(path.join(cacheDir, logFiles[0]), "utf8"));
        // The log should not contain progress-style "PASS tests/..." lines
        const logProgressLines = logContent
          .split("\n")
          .filter((l) => l.trim().startsWith("PASS") && l.includes("_trivial-log-clean"));
        expect(logProgressLines.length).toBe(0);
      } finally {
        fs.rmSync(tempTestFile, { force: true });
        fs.rmSync(cacheDir, { recursive: true, force: true });
      }
    });

    // Coverage: test-runner-progress-output (no spec AC exists yet) ac-3
    it("progress output uses PASS/FAIL markers matching condensed output conventions", () => {
      const tempTestFile = path.join(projectRoot, "tests", "_trivial-markers.test.ts");
      fs.rmSync(tempTestFile, { force: true });
      fs.writeFileSync(
        tempTestFile,
        `import { it, expect } from 'vitest';\nit('passes', () => { expect(1).toBe(1); });\n`,
      );

      const sessionId = `test-markers-${Date.now()}`;
      const cacheDir = path.join(os.tmpdir(), "kspec-test-cache", sessionId);

      try {
        const result = spawnSync(
          "node",
          [runnerScript, "--fresh", "tests/_trivial-markers.test.ts"],
          {
            cwd: projectRoot,
            encoding: "utf8",
            env: buildTestSubprocessEnv({ SKIP_BUILD: "1", KSPEC_SESSION_ID: sessionId }),
            timeout: 30_000,
          },
        );

        expect(result.status).toBe(0);

        // Check raw stderr contains ANSI green for PASS marker
        // Green ANSI = \x1b[32m, Reset = \x1b[0m
        expect(result.stderr).toContain("\x1b[32mPASS\x1b[0m");
      } finally {
        fs.rmSync(tempTestFile, { force: true });
        fs.rmSync(cacheDir, { recursive: true, force: true });
      }
    });

    it("progress is suppressed when KSPEC_TEST_PROGRESS=0", () => {
      const tempTestFile = path.join(projectRoot, "tests", "_trivial-suppress.test.ts");
      fs.rmSync(tempTestFile, { force: true });
      fs.writeFileSync(
        tempTestFile,
        `import { it, expect } from 'vitest';\nit('passes', () => { expect(1).toBe(1); });\n`,
      );

      const sessionId = `test-suppress-${Date.now()}`;
      const cacheDir = path.join(os.tmpdir(), "kspec-test-cache", sessionId);

      try {
        const result = spawnSync(
          "node",
          [runnerScript, "--fresh", "tests/_trivial-suppress.test.ts"],
          {
            cwd: projectRoot,
            encoding: "utf8",
            env: buildTestSubprocessEnv({
              SKIP_BUILD: "1",
              KSPEC_SESSION_ID: sessionId,
              KSPEC_TEST_PROGRESS: "0",
            }),
            timeout: 30_000,
          },
        );

        expect(result.status).toBe(0);

        const stderr = stripAnsi(result.stderr);
        // No progress lines
        const progressLines = stderr
          .split("\n")
          .filter((l) => l.trim().startsWith("PASS") && l.includes("tests"));
        expect(progressLines.length).toBe(0);

        // Summary still appears
        expect(stderr).toContain("Tests passed");
      } finally {
        fs.rmSync(tempTestFile, { force: true });
        fs.rmSync(cacheDir, { recursive: true, force: true });
      }
    });
  });
});
