import { defineConfig, defineProject } from "vitest/config";
import { cpus } from "node:os";

const baseExclude = [
  "**/node_modules/**",
  "**/dist/**",
  "**/.review/**",
  "**/.worktrees/**",
  "**/.kspec-worktrees/**",
  "**/tests/e2e/**",
];

// These integration suites perform real git worktree/shadow-lock/bootstrap I/O.
// They pass in isolation but can time out when competing with the rest of the
// full suite, so run them in a dedicated serial project after the default pool.
const heavySerialSuites = [
  "tests/dispatch-workspace-config.test.ts",
  "tests/dispatch-workspace-registry.test.ts",
  "tests/dispatch-workspace-cleanup.test.ts",
  "tests/canonical-task-workspace-contract.test.ts",
  "tests/dispatch-runtime-bootstrap-contract.test.ts",
  // CLI-heavy integration suites that spawn 100+ subprocesses each.
  // Under full-suite concurrency they exhaust process/fd limits and
  // crash with STACK_TRACE_ERROR or assertion failures.
  "tests/integration.test.ts",
  "tests/agent-dispatch-engine.test.ts",
  "tests/activity-display.test.ts",
  "tests/cli/session-note-limit.test.ts",
  "tests/cli/session-start-format.test.ts",
  "tests/cli/session-start-notes.test.ts",
  "tests/cli/session-start-activity-timeline.test.ts",
  "tests/meta.test.ts",
  // Rebuilds dist/daemon/ in-place via `npm run build:daemon`. Any other
  // suite that spawns dist/daemon/index.js concurrently can hit
  // ERR_MODULE_NOT_FOUND mid-rebuild, so this must run serially after the
  // default pool drains.
  "tests/daemon-build.test.ts",
  // Spawns ~15 real daemon child processes (Node + Bun) per file via the
  // shared daemon fixture. Under full-suite concurrency these races against
  // the default pool's CLI-subprocess fan-out cause the bun runtime parity
  // beforeEach to intermittently exceed the cache-readiness budget — the
  // failure surfaces as STACK_TRACE_ERROR from line 482 even though the
  // test passes deterministically in isolation. Run serially after the
  // default pool to remove cross-file contention.
  "tests/daemon-api/websocket-protocol.test.ts",
  // Spawns real daemon children via startTestDaemon, which serializes
  // dynamic-port startups on a global port-start lock held through each
  // holder's full readiness wait. In the default pool the lock queue behind
  // helpers/daemon.test.ts (whose contract tests deliberately hold the lock
  // through failing-readiness budgets) plus general CPU saturation can
  // exceed the 45s test timeout — the graceful-SIGTERM test then dies as an
  // opaque timeout even though the file passes deterministically in
  // isolation. Run serially after the default pool drains.
  "tests/daemon-last-exit.test.ts",
];

// On machines with many cores vitest spawns one worker per core by default.
// Each worker can trigger dozens of kspec CLI subprocesses, leading to resource
// exhaustion (fd limits, process table pressure) on repeated full-suite runs.
// Cap at 8 workers to keep subprocess fan-out manageable.
const defaultMaxWorkers = Math.min(cpus().length, 8);

export default defineConfig({
  test: {
    projects: [
      defineProject({
        test: {
          name: "default",
          globals: true,
          environment: "node",
          testTimeout: 45_000,
          maxWorkers: defaultMaxWorkers,
          globalSetup: "./tests/global-setup.ts",
          setupFiles: ["./tests/setup.ts"],
          exclude: [...baseExclude, ...heavySerialSuites],
          sequence: {
            groupOrder: 0,
          },
        },
      }),
      defineProject({
        test: {
          name: "heavy-serial",
          globals: true,
          environment: "node",
          testTimeout: 45_000,
          globalSetup: "./tests/global-setup.ts",
          setupFiles: ["./tests/setup.ts"],
          include: heavySerialSuites,
          exclude: baseExclude,
          fileParallelism: false,
          maxWorkers: 1,
          sequence: {
            groupOrder: 1,
          },
        },
      }),
    ],
  },
});
