import { defineConfig, defineProject } from "vitest/config";

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
const dispatchHeavySuites = [
  "tests/dispatch-workspace-config.test.ts",
  "tests/dispatch-workspace-registry.test.ts",
  "tests/dispatch-workspace-cleanup.test.ts",
  "tests/canonical-task-workspace-contract.test.ts",
  "tests/dispatch-runtime-bootstrap-contract.test.ts",
];

export default defineConfig({
  test: {
    projects: [
      defineProject({
        test: {
          name: "default",
          globals: true,
          environment: "node",
          testTimeout: 45_000,
          globalSetup: "./tests/global-setup.ts",
          setupFiles: ["./tests/setup.ts"],
          exclude: [...baseExclude, ...dispatchHeavySuites],
          sequence: {
            groupOrder: 0,
          },
        },
      }),
      defineProject({
        test: {
          name: "dispatch-heavy",
          globals: true,
          environment: "node",
          testTimeout: 30_000,
          globalSetup: "./tests/global-setup.ts",
          setupFiles: ["./tests/setup.ts"],
          include: dispatchHeavySuites,
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
