/**
 * Tests for workflow run foundation
 * Spec: @workflow-run-foundation
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { kspec, createTempDir, cleanupTempDir, initGitRepo } from './helpers/cli.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as YAML from 'yaml';
import { parseDocument } from 'yaml';

let tempDir: string;

beforeEach(async () => {
  tempDir = await createTempDir();

  // Initialize git repo (required for shadow operations)
  initGitRepo(tempDir);

  // Create .kspec directory structure
  const kspecDir = path.join(tempDir, '.kspec');
  await fs.mkdir(kspecDir, { recursive: true });

  // Create minimal root manifest
  await fs.writeFile(
    path.join(kspecDir, 'kynetic.yaml'),
    `kynetic: "1.0"
project: Test Project
`,
    'utf-8',
  );

  // Create workflows in meta manifest
  await fs.writeFile(
    path.join(kspecDir, 'kynetic.meta.yaml'),
    `kynetic_meta: "1.0"
workflows:
  - _ulid: 01TEST0000000000000000001
    id: test-workflow
    trigger: manual
    description: Test workflow for run tests
    steps:
      - type: check
        content: Verify prerequisites
      - type: action
        content: Execute main task
      - type: check
        content: Validate results

  - _ulid: 01TEST0000000000000000002
    id: another-workflow
    trigger: manual
    description: Another test workflow
    steps:
      - type: action
        content: Do something

agents:
  - _ulid: 01KF79QXTTX8KBRYK14NWV1KYK
    id: test
    name: Test Author
    description: Generic test author
    capabilities: []
    tools: []
    conventions: []
`,
    'utf-8',
  );

  // Create a test task for task linking tests
  await fs.writeFile(
    path.join(kspecDir, 'project.tasks.yaml'),
    `kynetic_tasks: "1.0"
tasks:
  - _ulid: 01TESTTASK000000000000001
    slugs:
      - test-task
    title: Test Task
    status: pending
    priority: 3
    created_at: "${new Date().toISOString()}"
`,
    'utf-8',
  );
});

afterEach(async () => {
  if (tempDir) {
    await cleanupTempDir(tempDir);
  }
});

// AC: @workflow-run-foundation ac-1
describe('workflow start', () => {
  it('should create a workflow run with correct initial state', async () => {
    const result = kspec('workflow start @test-workflow --json', tempDir);

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);

    expect(output).toHaveProperty('run_id');
    expect(output.workflow_ref).toBe('@01TEST0000000000000000001');
    expect(output.status).toBe('active');

    // Verify run was saved to file
    const runsPath = path.join(tempDir, '.kspec', 'kynetic.runs.yaml');
    const runsContent = await fs.readFile(runsPath, 'utf-8');
    const doc = parseDocument(runsContent);
    const runsData = doc.toJS() as { runs: any[] };

    expect(runsData.runs).toHaveLength(1);
    const run = runsData.runs[0];

    expect(run._ulid).toBe(output.run_id);
    expect(run.workflow_ref).toBe('@01TEST0000000000000000001');
    expect(run.status).toBe('active');
    expect(run.current_step).toBe(0);
    expect(run.total_steps).toBe(3);
    expect(run.started_at).toBeDefined();
    expect(run.step_results).toEqual([]);
    expect(run.initiated_by).toBe('@test');
  });

  it('should display human-readable output without --json', async () => {
    const result = kspec('workflow start @test-workflow', tempDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Started workflow run:');
    expect(result.stdout).toContain('Workflow: test-workflow');
    expect(result.stdout).toContain('Steps: 3');
  });

  it('should error if workflow does not exist', async () => {
    const result = kspec('workflow start @nonexistent --json', tempDir, { expectFail: true });

    expect(result.exitCode).toBe(3); // NOT_FOUND
    expect(result.stderr).toContain('Workflow not found');
  });
});

// AC: @workflow-run-foundation ac-6
describe('workflow start with task link', () => {
  it('should link run to task when --task is provided', async () => {
    const result = kspec('workflow start @test-workflow --task @test-task --json', tempDir);

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);

    // Verify output includes task reference
    const runsPath = path.join(tempDir, '.kspec', 'kynetic.runs.yaml');
    const runsContent = await fs.readFile(runsPath, 'utf-8');
    const doc = parseDocument(runsContent);
    const runsData = doc.toJS() as { runs: any[] };

    const run = runsData.runs[0];
    expect(run.task_ref).toBe('@01TESTTASK000000000000001');
  });

  it('should display task link in human output', async () => {
    const result = kspec('workflow start @test-workflow --task @test-task', tempDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Linked task: @01TESTTASK000000000000001');
  });

  it('should error if task does not exist', async () => {
    const result = kspec('workflow start @test-workflow --task @nonexistent', tempDir, { expectFail: true });

    expect(result.exitCode).toBe(3); // NOT_FOUND
    expect(result.stderr).toContain('Task not found');
  });
});

// AC: @workflow-run-foundation ac-2
describe('workflow runs list', () => {
  beforeEach(async () => {
    // Create multiple runs in different states
    kspec('workflow start @test-workflow --json', tempDir);
    kspec('workflow start @another-workflow --json', tempDir);

    // Abort one of them
    const runsPath = path.join(tempDir, '.kspec', 'kynetic.runs.yaml');
    const runsContent = await fs.readFile(runsPath, 'utf-8');
    const doc = parseDocument(runsContent);
    const runsData = doc.toJS() as { runs: any[] };

    // Manually complete one run for testing
    runsData.runs[1].status = 'completed';
    runsData.runs[1].completed_at = new Date().toISOString();

    const doc2 = parseDocument(await fs.readFile(runsPath, 'utf-8'));
    doc2.setIn(['runs', 1, 'status'], 'completed');
    doc2.setIn(['runs', 1, 'completed_at'], runsData.runs[1].completed_at);
    await fs.writeFile(runsPath, doc2.toString(), 'utf-8');
  });

  it('should list all runs with table output', async () => {
    const result = kspec('workflow runs', tempDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('test-workflow');
    expect(result.stdout).toContain('another-workflow');
    expect(result.stdout).toContain('active');
    expect(result.stdout).toContain('completed');
  });

  it('should output JSON with --json flag', async () => {
    const result = kspec('workflow runs --json', tempDir);

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);

    expect(output.runs).toHaveLength(2);
    expect(output.runs[0].status).toBe('active');
    expect(output.runs[1].status).toBe('completed');
  });

  it('should filter by --active flag', async () => {
    const result = kspec('workflow runs --active --json', tempDir);

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);

    expect(output.runs).toHaveLength(1);
    expect(output.runs[0].status).toBe('active');
  });

  it('should filter by --completed flag', async () => {
    const result = kspec('workflow runs --completed --json', tempDir);

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);

    expect(output.runs).toHaveLength(1);
    expect(output.runs[0].status).toBe('completed');
  });

  it('should filter by --workflow flag', async () => {
    const result = kspec('workflow runs --workflow @test-workflow --json', tempDir);

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);

    expect(output.runs).toHaveLength(1);
    expect(output.runs[0].workflow_ref).toBe('@01TEST0000000000000000001');
  });

  it('should show "No workflow runs found" when no runs exist', async () => {
    // Delete runs file
    const runsPath = path.join(tempDir, '.kspec', 'kynetic.runs.yaml');
    await fs.unlink(runsPath);

    const result = kspec('workflow runs', tempDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No workflow runs found');
  });
});

// AC: @workflow-run-foundation ac-4
describe('workflow show', () => {
  let runId: string;

  beforeEach(async () => {
    // Create a run
    const result = kspec('workflow start @test-workflow --task @test-task --json', tempDir);
    const output = JSON.parse(result.stdout);
    runId = output.run_id;
  });

  it('should display run details in human-readable format', async () => {
    const result = kspec(`workflow show @${runId}`, tempDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Workflow Run Details');
    expect(result.stdout).toContain('test-workflow');
    expect(result.stdout).toContain('active');
    expect(result.stdout).toContain('0/3');
    expect(result.stdout).toContain('Initiated by: @test');
    expect(result.stdout).toContain('Task: @01TESTTASK000000000000001');
  });

  it('should output run details in JSON format', async () => {
    const result = kspec(`workflow show @${runId} --json`, tempDir);

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);

    expect(output.run._ulid).toBe(runId);
    expect(output.run.workflow_ref).toBe('@01TEST0000000000000000001');
    expect(output.run.status).toBe('active');
    expect(output.run.current_step).toBe(0);
    expect(output.run.total_steps).toBe(3);
    expect(output.run.task_ref).toBe('@01TESTTASK000000000000001');
  });

  it('should work with ULID prefix', async () => {
    const shortRef = runId.slice(0, 8);
    const result = kspec(`workflow show @${shortRef}`, tempDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Workflow Run Details');
  });

  it('should error if run does not exist', async () => {
    const result = kspec('workflow show @01NONEXISTENT', tempDir, { expectFail: true });

    expect(result.exitCode).toBe(3); // NOT_FOUND
    expect(result.stderr).toContain('Workflow run not found');
  });
});

// AC: @workflow-run-foundation ac-3
describe('workflow abort', () => {
  let runId: string;

  beforeEach(async () => {
    const result = kspec('workflow start @test-workflow --json', tempDir);
    const output = JSON.parse(result.stdout);
    runId = output.run_id;
  });

  it('should abort an active run', async () => {
    const result = kspec(`workflow abort @${runId} --reason "Testing abort" --json`, tempDir);

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);

    expect(output.run_id).toBe(runId);
    expect(output.status).toBe('aborted');

    // Verify in file
    const runsPath = path.join(tempDir, '.kspec', 'kynetic.runs.yaml');
    const runsContent = await fs.readFile(runsPath, 'utf-8');
    const doc = parseDocument(runsContent);
    const runsData = doc.toJS() as { runs: any[] };

    const run = runsData.runs[0];
    expect(run.status).toBe('aborted');
    expect(run.abort_reason).toBe('Testing abort');
    expect(run.completed_at).toBeDefined();
  });

  it('should display abort confirmation in human output', async () => {
    const result = kspec(`workflow abort @${runId} --reason "Testing"`, tempDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Aborted workflow run:');
    expect(result.stdout).toContain('Reason: Testing');
  });

  it('should allow aborting without a reason', async () => {
    const result = kspec(`workflow abort @${runId} --json`, tempDir);

    expect(result.exitCode).toBe(0);

    // Verify in file
    const runsPath = path.join(tempDir, '.kspec', 'kynetic.runs.yaml');
    const runsContent = await fs.readFile(runsPath, 'utf-8');
    const doc = parseDocument(runsContent);
    const runsData = doc.toJS() as { runs: any[] };

    const run = runsData.runs[0];
    expect(run.status).toBe('aborted');
    expect(run.abort_reason).toBeUndefined();
  });
});

// AC: @workflow-run-foundation ac-5
describe('workflow abort validation', () => {
  it('should error when aborting a completed run', async () => {
    // Start and manually complete a run
    const startResult = kspec('workflow start @test-workflow --json', tempDir);
    const { run_id } = JSON.parse(startResult.stdout);

    const runsPath = path.join(tempDir, '.kspec', 'kynetic.runs.yaml');
    const runsContent = await fs.readFile(runsPath, 'utf-8');
    const doc = parseDocument(runsContent);
    const runsData = doc.toJS() as { runs: any[] };

    runsData.runs[0].status = 'completed';
    runsData.runs[0].completed_at = new Date().toISOString();

    const doc3 = parseDocument(await fs.readFile(runsPath, 'utf-8'));
    doc3.setIn(['runs', 0, 'status'], 'completed');
    doc3.setIn(['runs', 0, 'completed_at'], runsData.runs[0].completed_at);
    await fs.writeFile(runsPath, doc3.toString(), 'utf-8');

    // Try to abort
    const result = kspec(`workflow abort @${run_id}`, tempDir, { expectFail: true });

    expect(result.exitCode).toBe(4); // VALIDATION_FAILED
    expect(result.stderr).toContain('Cannot abort workflow run: already completed');
  });

  it('should error when aborting an already aborted run', async () => {
    // Start and abort a run
    const startResult = kspec('workflow start @test-workflow --json', tempDir);
    const { run_id } = JSON.parse(startResult.stdout);

    kspec(`workflow abort @${run_id}`, tempDir);

    // Try to abort again
    const result = kspec(`workflow abort @${run_id}`, tempDir, { expectFail: true });

    expect(result.exitCode).toBe(4); // VALIDATION_FAILED
    expect(result.stderr).toContain('Cannot abort workflow run: already aborted');
  });
});
