import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Elysia } from "elysia";
import type { ProjectContextManager } from "../../dist/daemon/project-context.js";
import {
  cleanupTempDir,
  createTempDir,
  createTestApp,
  initGitRepo,
  makeRequest,
  setupFixtures,
} from "./helpers.js";

let tempDir: string;
let app: Elysia;
let manager: ProjectContextManager;

beforeEach(async () => {
  tempDir = await createTempDir("kspec-daemon-api-helper-");
  initGitRepo(tempDir);
  setupFixtures(tempDir);
  ({ app, manager } = createTestApp());
});

afterEach(async () => {
  await cleanupTempDir(tempDir);
});

describe("daemon API test helper", () => {
  it("keeps project watchers disabled for app.handle integration tests", async () => {
    const response = await makeRequest(app, tempDir, "/api/meta/session");
    expect(response.status).toBe(200);

    const [project] = manager.listProjects();
    expect(project).toBeDefined();
    expect(project.path).toBe(tempDir);
    expect(project.watcherActive).toBe(false);
  });
});
