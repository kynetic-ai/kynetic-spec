import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { Elysia } from 'elysia';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initGitRepo, createTempDir, cleanupTempDir } from './helpers/cli.js';
import { projectContextMiddleware } from '../dist/daemon/middleware/project-context.ts';
import {
  createAgentDispatchRoutes,
  getDispatchEngine,
  resolveDispatchCwd,
} from '../dist/daemon/routes/agent-dispatch.ts';

async function setupProjectWithWorktree(prefix: string) {
  const rootDir = await createTempDir(prefix);
  const worktreeDir = `${rootDir}-worktree`;

  initGitRepo(rootDir);

  writeFileSync(
    join(rootDir, 'kynetic.yaml'),
    YAML.stringify({ kynetic: '1', project: { name: 'Test Project' } }),
  );
  writeFileSync(
    join(rootDir, 'kynetic.meta.yaml'),
    YAML.stringify({ kynetic_meta: '1.0', agents: [] }),
  );
  writeFileSync(join(rootDir, 'project.tasks.yaml'), YAML.stringify({ tasks: [] }));
  mkdirSync(join(rootDir, '.kspec'), { recursive: true });
  writeFileSync(join(rootDir, '.kspec', 'placeholder'), 'shadow');
  writeFileSync(join(rootDir, 'README.md'), '# test\n');

  execSync('git add .', { cwd: rootDir, stdio: 'pipe' });
  execSync('git commit -m init', { cwd: rootDir, stdio: 'pipe' });
  execSync(`git worktree add ${worktreeDir} -b test-worktree`, {
    cwd: rootDir,
    stdio: 'pipe',
  });

  return { rootDir, worktreeDir };
}

describe('Agent dispatch routes', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    const dirs = tempDirs.splice(0).sort((a, b) => b.length - a.length);
    for (const dir of dirs) {
      await cleanupTempDir(dir);
    }
  });

  // AC: @worktree-support ac-dispatch-cwd
  it('accepts a linked worktree cwd and stores it on the running dispatch engine', async () => {
    const { rootDir, worktreeDir } = await setupProjectWithWorktree('kspec-daemon-dispatch-route-');
    tempDirs.push(rootDir, worktreeDir);

    const { middleware } = projectContextMiddleware();
    const app = new Elysia().use(middleware).use(createAgentDispatchRoutes());

    const response = await app.handle(new Request('http://localhost/api/agent/dispatch/start', {
      method: 'POST',
      headers: {
        Host: 'localhost',
        'X-Kspec-Dir': rootDir,
        'X-Kspec-Cwd': worktreeDir,
      },
    }));

    expect(response.status).toBe(200);
    expect(getDispatchEngine(rootDir)?.getCwd()).toBe(worktreeDir);

    const stopResponse = await app.handle(new Request('http://localhost/api/agent/dispatch/stop', {
      method: 'POST',
      headers: {
        Host: 'localhost',
        'X-Kspec-Dir': rootDir,
      },
    }));
    expect(stopResponse.status).toBe(200);
  });

  // AC: @worktree-support ac-dispatch-conflict
  it('returns 409 when the same project already has a dispatch engine bound to another worktree cwd', async () => {
    const { rootDir, worktreeDir } = await setupProjectWithWorktree('kspec-daemon-dispatch-conflict-a-');
    tempDirs.push(rootDir, worktreeDir);
    const secondWorktreeDir = `${rootDir}-worktree-b`;
    tempDirs.push(secondWorktreeDir);
    execSync(`git worktree add ${secondWorktreeDir} -b test-worktree-b`, {
      cwd: rootDir,
      stdio: 'pipe',
    });

    const { middleware } = projectContextMiddleware();
    const app = new Elysia().use(middleware).use(createAgentDispatchRoutes());

    const first = await app.handle(new Request('http://localhost/api/agent/dispatch/start', {
      method: 'POST',
      headers: {
        Host: 'localhost',
        'X-Kspec-Dir': rootDir,
        'X-Kspec-Cwd': worktreeDir,
      },
    }));
    expect(first.status).toBe(200);

    const second = await app.handle(new Request('http://localhost/api/agent/dispatch/start', {
      method: 'POST',
      headers: {
        Host: 'localhost',
        'X-Kspec-Dir': rootDir,
        'X-Kspec-Cwd': secondWorktreeDir,
      },
    }));

    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({
      started: false,
      error: expect.stringContaining(worktreeDir),
    });

    const engine = getDispatchEngine(rootDir);
    expect(engine?.getCwd()).toBe(worktreeDir);
    if (engine) {
      await engine.stop();
    }
  });

  // AC: @worktree-support ac-dispatch-cwd
  it('rejects absolute cwd values from a different git project', async () => {
    const { rootDir, worktreeDir } = await setupProjectWithWorktree('kspec-daemon-dispatch-invalid-project-');
    tempDirs.push(rootDir, worktreeDir);
    const otherRepo = await createTempDir('kspec-daemon-dispatch-other-project-');
    tempDirs.push(otherRepo);
    initGitRepo(otherRepo);
    writeFileSync(join(otherRepo, 'README.md'), '# other\n');
    execSync('git add README.md && git commit -m init', { cwd: otherRepo, stdio: 'pipe' });

    const { middleware } = projectContextMiddleware();
    const app = new Elysia().use(middleware).use(createAgentDispatchRoutes());

    const response = await app.handle(new Request('http://localhost/api/agent/dispatch/start', {
      method: 'POST',
      headers: {
        Host: 'localhost',
        'X-Kspec-Dir': rootDir,
        'X-Kspec-Cwd': otherRepo,
      },
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      started: false,
      error: 'Dispatch cwd must belong to the same git project',
    });
  });

  // AC: @schema-derived-type-definitions ac-2
  // AC: @trait-type-safe-input ac-1
  it('rejects invalid task statuses at the API boundary', async () => {
    const { rootDir, worktreeDir } = await setupProjectWithWorktree('kspec-daemon-dispatch-invalid-status-');
    tempDirs.push(rootDir, worktreeDir);

    const { middleware } = projectContextMiddleware();
    const app = new Elysia().use(middleware).use(createAgentDispatchRoutes());

    await app.handle(new Request('http://localhost/api/agent/dispatch/start', {
      method: 'POST',
      headers: {
        Host: 'localhost',
        'X-Kspec-Dir': rootDir,
        'X-Kspec-Cwd': worktreeDir,
      },
    }));

    const response = await app.handle(new Request('http://localhost/api/agent/events', {
      method: 'POST',
      headers: {
        Host: 'localhost',
        'X-Kspec-Dir': rootDir,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        task_id: '01JXXXXXXXXXXXXXXXXXXXXXXXXX',
        from_status: 'invalid_status',
        to_status: 'pending',
        timestamp: Date.now(),
      }),
    }));

    expect(response.status).toBe(422);
  });
});

describe('resolveDispatchCwd', () => {
  // AC: @worktree-support ac-dispatch-cwd
  it('defaults to the project directory when no cwd header is provided', () => {
    expect(resolveDispatchCwd('/tmp/project', null)).toBe('/tmp/project');
  });

  // AC: @worktree-support ac-dispatch-cwd
  it('rejects relative cwd values', () => {
    expect(() => resolveDispatchCwd('/tmp/project', 'relative/path')).toThrow(
      'Dispatch cwd must be an absolute path',
    );
  });
});
