import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { initContext, loadAllItems, loadAllTasks } from '../src/parser/index.js';
import type { RefIndexEntry, RefIndexResponse } from '../packages/shared/src/api.js';

const tempDirs: string[] = [];

/**
 * Build the ref index from loaded tasks and items.
 * Mirrors the logic in the /api/refs/index route handler.
 */
function buildRefIndex(
  tasks: Awaited<ReturnType<typeof loadAllTasks>>,
  items: Awaited<ReturnType<typeof loadAllItems>>,
): RefIndexResponse {
  const refs: Record<string, RefIndexEntry> = {};

  for (const task of tasks) {
    const entry: RefIndexEntry = {
      title: task.title,
      type: task.type || 'task',
      status: task.status,
    };
    refs[task._ulid] = entry;
    for (const slug of task.slugs) {
      refs[slug] = entry;
    }
  }

  for (const item of items) {
    const status =
      typeof item.status === 'string'
        ? item.status
        : item.status?.implementation;
    const entry: RefIndexEntry = {
      title: item.title,
      type: item.type || 'item',
      status,
    };
    refs[item._ulid] = entry;
    for (const slug of item.slugs) {
      refs[slug] = entry;
    }
  }

  return { refs };
}

async function createFixtureProject(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kspec-refs-index-'));
  tempDirs.push(tempDir);

  const kspecDir = path.join(tempDir, '.kspec');
  await fs.mkdir(path.join(kspecDir, 'modules'), { recursive: true });

  await fs.writeFile(
    path.join(kspecDir, 'kynetic.yaml'),
    `kynetic: "1.0"

project:
  name: "Ref Index Test"
  version: "0.1.0"
  status: draft

includes:
  - modules/core.yaml

tasks_file: project.tasks.yaml
`,
    'utf-8'
  );

  await fs.writeFile(
    path.join(kspecDir, 'modules', 'core.yaml'),
    `_ulid: 01KF1645CB2FQ3F2XTPYVZGCFS
slugs:
  - core-module
title: Core Module
type: module
description: Core test module

features:
  - _ulid: 01KF1645CBDJYHWBPYWRN3HYPJ
    slugs:
      - test-feature
    title: Test Feature
    type: feature
    status:
      maturity: draft
      implementation: in_progress
    description: A feature for testing
    acceptance_criteria:
      - id: ac-1
        given: test
        when: test
        then: test

  - _ulid: 01KF1645CBFGXE3AK5NY2DWZM4
    slugs:
      - api-trait
    title: API Trait
    type: trait
    description: Shared API behavior
    acceptance_criteria:
      - id: ac-1
        given: endpoint
        when: called
        then: returns JSON
`,
    'utf-8'
  );

  await fs.writeFile(
    path.join(kspecDir, 'project.tasks.yaml'),
    `tasks:
  - _ulid: 01KG0RR6CA45ZT43W2T6HJMVA1
    slugs:
      - task-implement-feature
    title: Implement the feature
    type: task
    status: in_progress
    priority: 2
    spec_ref: "@test-feature"
    notes: []
    todos: []
    created_at: "2026-01-01T00:00:00Z"
  - _ulid: 01KG0RR8CB8N4YGP991WD7XS9R
    slugs:
      - task-write-tests
    title: Write tests
    type: task
    status: pending
    priority: 3
    notes: []
    todos: []
    created_at: "2026-01-02T00:00:00Z"
`,
    'utf-8'
  );

  // Return .kspec dir for initContext (no git/shadow in test fixtures)
  return kspecDir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('GET /api/refs/index', () => {
  // AC: @ui-api-ref-resolution ac-4
  it('returns a map with title, type, and status for each ref', async () => {
    const projectRoot = await createFixtureProject();
    const ctx = await initContext(projectRoot);
    const tasks = await loadAllTasks(ctx);
    const items = await loadAllItems(ctx);
    const result = buildRefIndex(tasks, items);

    // Tasks are indexed by ULID and slug
    expect(result.refs['01KG0RR6CA45ZT43W2T6HJMVA1']).toEqual({
      title: 'Implement the feature',
      type: 'task',
      status: 'in_progress',
    });
    expect(result.refs['task-implement-feature']).toEqual({
      title: 'Implement the feature',
      type: 'task',
      status: 'in_progress',
    });

    // Second task
    expect(result.refs['01KG0RR8CB8N4YGP991WD7XS9R']).toEqual({
      title: 'Write tests',
      type: 'task',
      status: 'pending',
    });
    expect(result.refs['task-write-tests']).toEqual({
      title: 'Write tests',
      type: 'task',
      status: 'pending',
    });
  });

  // AC: @ui-api-ref-resolution ac-4
  it('includes spec items and traits with both ULID and slug keys', async () => {
    const projectRoot = await createFixtureProject();
    const ctx = await initContext(projectRoot);
    const tasks = await loadAllTasks(ctx);
    const items = await loadAllItems(ctx);

    const result = buildRefIndex(tasks, items);

    // Feature (spec item) — status comes from implementation field
    expect(result.refs['test-feature']).toEqual({
      title: 'Test Feature',
      type: 'feature',
      status: 'in_progress',
    });
    expect(result.refs['01KF1645CBDJYHWBPYWRN3HYPJ']).toEqual({
      title: 'Test Feature',
      type: 'feature',
      status: 'in_progress',
    });

    // Trait
    expect(result.refs['api-trait']).toEqual({
      title: 'API Trait',
      type: 'trait',
      status: undefined,
    });
    expect(result.refs['01KF1645CBFGXE3AK5NY2DWZM4']).toEqual({
      title: 'API Trait',
      type: 'trait',
      status: undefined,
    });

    // Module
    expect(result.refs['core-module']).toEqual({
      title: 'Core Module',
      type: 'module',
      status: undefined,
    });
  });

  // AC: @ui-api-ref-resolution ac-5
  it('payload is lightweight — only title, type, status per entry', async () => {
    const projectRoot = await createFixtureProject();
    const ctx = await initContext(projectRoot);
    const tasks = await loadAllTasks(ctx);
    const items = await loadAllItems(ctx);
    const result = buildRefIndex(tasks, items);

    // Verify no heavyweight fields are present
    for (const [, entry] of Object.entries(result.refs)) {
      const keys = Object.keys(entry);
      // Only title, type, and status should be present
      expect(keys.every((k) => ['title', 'type', 'status'].includes(k))).toBe(true);
      // No description, notes, acceptance_criteria, tags, etc.
      expect(entry).not.toHaveProperty('description');
      expect(entry).not.toHaveProperty('notes');
      expect(entry).not.toHaveProperty('acceptance_criteria');
      expect(entry).not.toHaveProperty('tags');
      expect(entry).not.toHaveProperty('slugs');
    }
  });

  // AC: @ui-api-ref-resolution ac-5
  it('payload is smaller than full entity lists', async () => {
    const projectRoot = await createFixtureProject();
    const ctx = await initContext(projectRoot);
    const tasks = await loadAllTasks(ctx);
    const items = await loadAllItems(ctx);
    const result = buildRefIndex(tasks, items);

    const refIndexSize = JSON.stringify(result).length;
    const fullDataSize = JSON.stringify({ tasks, items }).length;

    // Ref index should be significantly smaller than full entity data
    expect(refIndexSize).toBeLessThan(fullDataSize);
  });

  // AC: @trait-api-endpoint ac-1
  it('returns a valid JSON structure with refs map', async () => {
    const projectRoot = await createFixtureProject();
    const ctx = await initContext(projectRoot);
    const tasks = await loadAllTasks(ctx);
    const items = await loadAllItems(ctx);
    const result = buildRefIndex(tasks, items);

    expect(result).toHaveProperty('refs');
    expect(typeof result.refs).toBe('object');
    // Both ULIDs and slugs are included
    expect(Object.keys(result.refs).length).toBeGreaterThan(0);
  });

  // AC: @trait-api-endpoint ac-2 — N/A: This is a list/index endpoint, not a ref-lookup endpoint.
  // It returns ALL refs, so there's no concept of "invalid ref" / 404.

  // AC: @trait-api-endpoint ac-3 — N/A: This is a GET endpoint with no request body.

  // AC: @trait-api-endpoint ac-4 — N/A: This returns a complete map, not a paginated list.
  // The response shape is { refs: Record<string, RefIndexEntry> }, not a paginated wrapper.

  // AC: @trait-api-endpoint ac-5 — N/A: This is a read-only endpoint. No state mutation occurs.

  // AC: @trait-api-endpoint ac-6 — X-Request-Id header is handled by middleware, not by the route handler.

  it('handles empty project (no tasks or items)', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kspec-refs-empty-'));
    tempDirs.push(tempDir);

    const kspecDir = path.join(tempDir, '.kspec');
    await fs.mkdir(path.join(kspecDir, 'modules'), { recursive: true });

    await fs.writeFile(
      path.join(kspecDir, 'kynetic.yaml'),
      `kynetic: "1.0"
project:
  name: "Empty Project"
  version: "0.1.0"
  status: draft
tasks_file: project.tasks.yaml
`,
      'utf-8'
    );

    await fs.writeFile(
      path.join(kspecDir, 'project.tasks.yaml'),
      `tasks: []\n`,
      'utf-8'
    );

    const ctx = await initContext(kspecDir);
    const tasks = await loadAllTasks(ctx);
    const items = await loadAllItems(ctx);
    const result = buildRefIndex(tasks, items);

    expect(result.refs).toEqual({});
  });
});
