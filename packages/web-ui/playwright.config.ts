import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1, // Required: daemon uses fixed port 3456
  reporter: process.env.CI ? 'github' : 'html',
  timeout: 30_000,

  expect: {
    timeout: 10_000,
  },

  use: {
    // Connect directly to daemon which serves both API and UI
    baseURL: 'http://localhost:3456',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 10_000,
  },

  // No webServer - daemon is started by test fixture (test-base.ts)
  // The daemon serves both the API and the built web UI

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  outputDir: 'test-results',
});
