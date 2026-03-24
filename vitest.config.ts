import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 15_000,
    globalSetup: "./tests/global-setup.ts",
    setupFiles: ["./tests/setup.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.review/**",
      "**/.worktrees/**",
      "**/.kspec-worktrees/**",
      "**/packages/web-ui/tests/e2e/**",
    ],
  },
});
