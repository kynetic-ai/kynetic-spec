import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTempFixtures, cleanupTempDir, kspecOutput as kspec, kspecJson } from './helpers/cli';

describe('Integration: task add --depends-on', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @task-add-depends-on ac-1
  it('should create task with dependencies when --depends-on provided', () => {
    // First create a dependency task
    const dep = kspecJson<{ task: { _ulid: string } }>(
      'task add --title "Dependency Task" --slug dep-task --json',
      tempDir
    );
    expect(dep.task._ulid).toBeDefined();

    // Create task with dependency
    const output = kspec(
      'task add --title "Main Task" --depends-on @dep-task --slug main-task',
      tempDir
    );
    expect(output).toContain('Created task');

    const task = kspecJson<{ depends_on: string[] }>(
      'task get @main-task',
      tempDir
    );

    expect(task.depends_on).toEqual(['@dep-task']);
  });

  // AC: @task-add-depends-on ac-1 - Multiple dependencies
  it('should create task with multiple dependencies', () => {
    // Create two dependency tasks
    kspec('task add --title "Dep 1" --slug dep-1', tempDir);
    kspec('task add --title "Dep 2" --slug dep-2', tempDir);

    // Create task with both dependencies
    const output = kspec(
      'task add --title "Multi Dep Task" --depends-on @dep-1 @dep-2 --slug multi-dep',
      tempDir
    );
    expect(output).toContain('Created task');

    const task = kspecJson<{ depends_on: string[] }>(
      'task get @multi-dep',
      tempDir
    );

    expect(task.depends_on).toHaveLength(2);
    expect(task.depends_on).toContain('@dep-1');
    expect(task.depends_on).toContain('@dep-2');
  });

  // AC: @task-add-depends-on ac-2
  it('should error when dependency reference is invalid', () => {
    // The command should fail, so we expect an error to be thrown
    expect(() => {
      kspec(
        'task add --title "Invalid Dep" --depends-on @nonexistent-task --slug invalid-dep',
        tempDir
      );
    }).toThrow(/not found/);
  });

  // AC: @task-add-depends-on ac-2 - Dependency must be a task
  it('should error when dependency reference is not a task', () => {
    // Use existing spec item from fixtures (@test-core is a module)
    // Try to use it as a dependency - should fail
    expect(() => {
      kspec(
        'task add --title "Wrong Ref Type" --depends-on @test-core --slug wrong-ref',
        tempDir
      );
    }).toThrow(/not a task/);
  });

  it('should create task without dependencies when --depends-on not provided', () => {
    const output = kspec(
      'task add --title "No Deps Task" --slug no-deps',
      tempDir
    );
    expect(output).toContain('Created task');

    const task = kspecJson<{ depends_on: string[] }>(
      'task get @no-deps',
      tempDir
    );

    expect(task.depends_on).toEqual([]);
  });

  it('should work with ULID references', () => {
    // Create a dependency task and get its ULID
    const dep = kspecJson<{ task: { _ulid: string } }>(
      'task add --title "Dep Task ULID" --json',
      tempDir
    );
    const depUlid = dep.task._ulid;

    // Create task using ULID reference
    const output = kspec(
      `task add --title "ULID Dep Task" --depends-on @${depUlid.slice(0, 8)} --slug ulid-dep`,
      tempDir
    );
    expect(output).toContain('Created task');

    const task = kspecJson<{ depends_on: string[] }>(
      'task get @ulid-dep',
      tempDir
    );

    // The dependency should be stored (as the reference that was passed)
    expect(task.depends_on).toHaveLength(1);
    expect(task.depends_on[0]).toContain(depUlid.slice(0, 8));
  });

  // AC: @rel-depends-on ac-1 - Auto-prefix @ on bare references
  it('should auto-prefix @ on bare slug references in task add', () => {
    kspec('task add --title "Dep Task" --slug dep-bare', tempDir);

    // Pass bare slug without @ prefix
    const output = kspec(
      'task add --title "Main Task" --depends-on dep-bare --slug main-bare',
      tempDir
    );
    expect(output).toContain('Created task');

    const task = kspecJson<{ depends_on: string[] }>(
      'task get @main-bare',
      tempDir
    );

    // Should be stored with @ prefix
    expect(task.depends_on).toEqual(['@dep-bare']);
  });

  // AC: @rel-depends-on ac-1 - Auto-prefix @ on bare ULID references
  it('should auto-prefix @ on bare ULID references in task add', () => {
    const dep = kspecJson<{ task: { _ulid: string } }>(
      'task add --title "Dep ULID Bare" --json',
      tempDir
    );
    const shortUlid = dep.task._ulid.slice(0, 8);

    const output = kspec(
      `task add --title "Main ULID Bare" --depends-on ${shortUlid} --slug main-ulid-bare`,
      tempDir
    );
    expect(output).toContain('Created task');

    const task = kspecJson<{ depends_on: string[] }>(
      'task get @main-ulid-bare',
      tempDir
    );

    // Should be stored with @ prefix
    expect(task.depends_on).toHaveLength(1);
    expect(task.depends_on[0]).toBe(`@${shortUlid}`);
  });
});
