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
import { ulid } from 'ulid';

let tempDir: string;
let testWorkflowUlid: string;
let anotherWorkflowUlid: string;
let testTaskUlid: string;

beforeEach(async () => {
  tempDir = await createTempDir();

  // Generate valid ULIDs for test fixtures
  testWorkflowUlid = ulid();
  anotherWorkflowUlid = ulid();
  testTaskUlid = ulid();

  // Initialize git repo (required for shadow operations)
  initGitRepo(tempDir);

  // Create minimal root manifest (non-shadow mode: files in project root)
  await fs.writeFile(
    path.join(tempDir, 'kynetic.yaml'),
    `kynetic: "1.0"
project: Test Project
`,
    'utf-8',
  );

  // Create workflows in meta manifest (non-shadow mode: files in project root)
  await fs.writeFile(
    path.join(tempDir, 'kynetic.meta.yaml'),
    `kynetic_meta: "1.0"
workflows:
  - _ulid: ${testWorkflowUlid}
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

  - _ulid: ${anotherWorkflowUlid}
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

  // Create a test task for task linking tests (non-shadow mode: files in project root)
  await fs.writeFile(
    path.join(tempDir, 'project.tasks.yaml'),
    `kynetic_tasks: "1.0"
tasks:
  - _ulid: ${testTaskUlid}
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
    expect(output.workflow_ref).toBe(`@${testWorkflowUlid}`);
    expect(output.status).toBe('active');

    // Verify run was saved to file
    const runsPath = path.join(tempDir, 'kynetic.runs.yaml');
    const runsContent = await fs.readFile(runsPath, 'utf-8');
    const doc = parseDocument(runsContent);
    const runsData = doc.toJS() as { runs: any[] };

    expect(runsData.runs).toHaveLength(1);
    const run = runsData.runs[0];

    expect(run._ulid).toBe(output.run_id);
    expect(run.workflow_ref).toBe(`@${testWorkflowUlid}`);
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
    const runsPath = path.join(tempDir, 'kynetic.runs.yaml');
    const runsContent = await fs.readFile(runsPath, 'utf-8');
    const doc = parseDocument(runsContent);
    const runsData = doc.toJS() as { runs: any[] };

    const run = runsData.runs[0];
    expect(run.task_ref).toBe(`@${testTaskUlid}`);
  });

  it('should display task link in human output', async () => {
    const result = kspec('workflow start @test-workflow --task @test-task', tempDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Linked task: @${testTaskUlid}`);
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
    const runsPath = path.join(tempDir, 'kynetic.runs.yaml');
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
    expect(output.runs[0].workflow_ref).toBe(`@${testWorkflowUlid}`);
  });

  it('should show "No workflow runs found" when no runs exist', async () => {
    // Delete runs file
    const runsPath = path.join(tempDir, 'kynetic.runs.yaml');
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
    expect(result.stdout).toContain(`@${testTaskUlid}`);
  });

  it('should output run details in JSON format', async () => {
    const result = kspec(`workflow show @${runId} --json`, tempDir);

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);

    expect(output.run._ulid).toBe(runId);
    expect(output.run.workflow_ref).toBe(`@${testWorkflowUlid}`);
    expect(output.run.status).toBe('active');
    expect(output.run.current_step).toBe(0);
    expect(output.run.total_steps).toBe(3);
    expect(output.run.task_ref).toBe(`@${testTaskUlid}`);
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
    const runsPath = path.join(tempDir, 'kynetic.runs.yaml');
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
    const runsPath = path.join(tempDir, 'kynetic.runs.yaml');
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

    const runsPath = path.join(tempDir, 'kynetic.runs.yaml');
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

// AC: @workflow-step-navigation ac-1
describe('workflow next - basic step advancement', () => {
  let runId: string;

  beforeEach(async () => {
    const result = kspec('workflow start @test-workflow --json', tempDir);
    const output = JSON.parse(result.stdout);
    runId = output.run_id;
  });

  it('should complete current step and show next step', async () => {
    const result = kspec(`workflow next @${runId}`, tempDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Completed step 1/3: [check] Verify prerequisites');
    expect(result.stdout).toContain('Step 2/3: [action] Execute main task');

    // Verify step result was recorded
    const runsPath = path.join(tempDir, 'kynetic.runs.yaml');
    const runsContent = await fs.readFile(runsPath, 'utf-8');
    const doc = parseDocument(runsContent);
    const runsData = doc.toJS() as { runs: any[] };

    const run = runsData.runs[0];
    expect(run.current_step).toBe(1);
    expect(run.step_results).toHaveLength(1);
    expect(run.step_results[0].step_index).toBe(0);
    expect(run.step_results[0].status).toBe('completed');
    expect(run.step_results[0].started_at).toBeDefined();
    expect(run.step_results[0].completed_at).toBeDefined();
  });

  it('should work with --json output', async () => {
    const result = kspec(`workflow next @${runId} --json`, tempDir);

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);

    expect(output.run_id).toBe(runId);
    expect(output.current_step).toBe(1);
    expect(output.total_steps).toBe(3);
    expect(output.next_step).toEqual({
      type: 'action',
      content: 'Execute main task',
    });
  });

  it('should advance through multiple steps', async () => {
    // Step 0 -> 1
    kspec(`workflow next @${runId}`, tempDir);
    // Step 1 -> 2
    const result = kspec(`workflow next @${runId}`, tempDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Completed step 2/3: [action] Execute main task');
    expect(result.stdout).toContain('Step 3/3: [check] Validate results');

    const runsPath = path.join(tempDir, 'kynetic.runs.yaml');
    const runsContent = await fs.readFile(runsPath, 'utf-8');
    const doc = parseDocument(runsContent);
    const runsData = doc.toJS() as { runs: any[] };

    const run = runsData.runs[0];
    expect(run.current_step).toBe(2);
    expect(run.step_results).toHaveLength(2);
  });
});

// AC: @workflow-step-navigation ac-2
describe('workflow next - completing last step', () => {
  let runId: string;

  beforeEach(async () => {
    const result = kspec('workflow start @test-workflow --json', tempDir);
    const output = JSON.parse(result.stdout);
    runId = output.run_id;

    // Advance to last step
    kspec(`workflow next @${runId}`, tempDir);
    kspec(`workflow next @${runId}`, tempDir);
  });

  it('should complete the run when advancing from last step', async () => {
    const result = kspec(`workflow next @${runId}`, tempDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Completed step 3/3: [check] Validate results');
    expect(result.stdout).toContain('Workflow completed!');
    expect(result.stdout).toMatch(/Duration: \d+s/);
    expect(result.stdout).toContain('Steps completed: 3');
    expect(result.stdout).toContain('Steps skipped: 0');

    // Verify run is completed
    const runsPath = path.join(tempDir, 'kynetic.runs.yaml');
    const runsContent = await fs.readFile(runsPath, 'utf-8');
    const doc = parseDocument(runsContent);
    const runsData = doc.toJS() as { runs: any[] };

    const run = runsData.runs[0];
    expect(run.status).toBe('completed');
    expect(run.completed_at).toBeDefined();
    expect(run.step_results).toHaveLength(3);
  });

  it('should output summary in JSON mode', async () => {
    const result = kspec(`workflow next @${runId} --json`, tempDir);

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);

    expect(output.run_id).toBe(runId);
    expect(output.status).toBe('completed');
    expect(output.completed_at).toBeDefined();
    expect(output.total_duration_ms).toBeGreaterThan(0);
    expect(output.steps_completed).toBe(3);
    expect(output.steps_skipped).toBe(0);
  });

  it('should count skipped steps in summary', async () => {
    // Start a fresh run and skip some steps
    const startResult = kspec('workflow start @test-workflow --json', tempDir);
    const { run_id } = JSON.parse(startResult.stdout);

    kspec(`workflow next @${run_id} --skip`, tempDir);
    kspec(`workflow next @${run_id}`, tempDir);
    const result = kspec(`workflow next @${run_id} --skip`, tempDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Steps completed: 1');
    expect(result.stdout).toContain('Steps skipped: 2');
  });
});

// AC: @workflow-step-navigation ac-3
describe('workflow next - run reference inference', () => {
  it('should infer run when exactly one active run exists', async () => {
    const startResult = kspec('workflow start @test-workflow --json', tempDir);
    const { run_id } = JSON.parse(startResult.stdout);

    // Don't provide run reference
    const result = kspec('workflow next', tempDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Completed step 1/3');

    // Verify the correct run was advanced
    const runsPath = path.join(tempDir, 'kynetic.runs.yaml');
    const runsContent = await fs.readFile(runsPath, 'utf-8');
    const doc = parseDocument(runsContent);
    const runsData = doc.toJS() as { runs: any[] };

    const run = runsData.runs[0];
    expect(run._ulid).toBe(run_id);
    expect(run.current_step).toBe(1);
  });

  it('should work with JSON mode', async () => {
    kspec('workflow start @test-workflow --json', tempDir);

    const result = kspec('workflow next --json', tempDir);

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);

    expect(output.run_id).toBeDefined();
    expect(output.current_step).toBe(1);
  });
});

// AC: @workflow-step-navigation ac-4
describe('workflow next - multiple active runs error', () => {
  it('should error with list of runs when multiple active runs exist', async () => {
    const result1 = kspec('workflow start @test-workflow --json', tempDir);
    const result2 = kspec('workflow start @another-workflow --json', tempDir);

    const run1 = JSON.parse(result1.stdout);
    const run2 = JSON.parse(result2.stdout);

    const result = kspec('workflow next', tempDir, { expectFail: true });

    expect(result.exitCode).toBe(4); // VALIDATION_FAILED
    expect(result.stderr).toContain('Multiple active runs found');
    expect(result.stderr).toContain(run1.run_id.slice(0, 8).toUpperCase());
    expect(result.stderr).toContain(run2.run_id.slice(0, 8).toUpperCase());
  });
});

// AC: @workflow-step-navigation ac-5
describe('workflow next - no active runs error', () => {
  it('should error when no active runs exist', async () => {
    const result = kspec('workflow next', tempDir, { expectFail: true });

    expect(result.exitCode).toBe(3); // NOT_FOUND
    expect(result.stderr).toContain('No active workflow runs found');
    expect(result.stderr).toContain('kspec workflow start');
  });

  it('should error when only completed runs exist', async () => {
    // Start and complete a run
    const startResult = kspec('workflow start @test-workflow --json', tempDir);
    const { run_id } = JSON.parse(startResult.stdout);

    const runsPath = path.join(tempDir, 'kynetic.runs.yaml');
    const runsContent = await fs.readFile(runsPath, 'utf-8');
    const doc = parseDocument(runsContent);
    doc.setIn(['runs', 0, 'status'], 'completed');
    doc.setIn(['runs', 0, 'completed_at'], new Date().toISOString());
    await fs.writeFile(runsPath, doc.toString(), 'utf-8');

    const result = kspec('workflow next', tempDir, { expectFail: true });

    expect(result.exitCode).toBe(3); // NOT_FOUND
    expect(result.stderr).toContain('No active workflow runs found');
  });
});

// AC: @workflow-step-navigation ac-6
describe('workflow next - notes capture', () => {
  let runId: string;

  beforeEach(async () => {
    const result = kspec('workflow start @test-workflow --json', tempDir);
    const output = JSON.parse(result.stdout);
    runId = output.run_id;
  });

  it('should capture notes in step result', async () => {
    const result = kspec(`workflow next @${runId} --notes "Verified all prerequisites met"`, tempDir);

    expect(result.exitCode).toBe(0);

    // Verify notes were saved
    const runsPath = path.join(tempDir, 'kynetic.runs.yaml');
    const runsContent = await fs.readFile(runsPath, 'utf-8');
    const doc = parseDocument(runsContent);
    const runsData = doc.toJS() as { runs: any[] };

    const run = runsData.runs[0];
    expect(run.step_results[0].notes).toBe('Verified all prerequisites met');
  });

  it('should work with --skip and --notes together', async () => {
    const result = kspec(`workflow next @${runId} --skip --notes "Prerequisites not needed for this test"`, tempDir);

    expect(result.exitCode).toBe(0);

    const runsPath = path.join(tempDir, 'kynetic.runs.yaml');
    const runsContent = await fs.readFile(runsPath, 'utf-8');
    const doc = parseDocument(runsContent);
    const runsData = doc.toJS() as { runs: any[] };

    const run = runsData.runs[0];
    expect(run.step_results[0].status).toBe('skipped');
    expect(run.step_results[0].notes).toBe('Prerequisites not needed for this test');
  });

  it('should handle empty notes', async () => {
    const result = kspec(`workflow next @${runId}`, tempDir);

    expect(result.exitCode).toBe(0);

    const runsPath = path.join(tempDir, 'kynetic.runs.yaml');
    const runsContent = await fs.readFile(runsPath, 'utf-8');
    const doc = parseDocument(runsContent);
    const runsData = doc.toJS() as { runs: any[] };

    const run = runsData.runs[0];
    expect(run.step_results[0].notes).toBeUndefined();
  });
});

// AC: @trait-json-output (inherited)
describe('workflow next - JSON output trait', () => {
  let runId: string;

  beforeEach(async () => {
    const result = kspec('workflow start @test-workflow --json', tempDir);
    const output = JSON.parse(result.stdout);
    runId = output.run_id;
  });

  it('should output valid JSON with no ANSI codes', async () => {
    const result = kspec(`workflow next @${runId} --json`, tempDir);

    expect(result.exitCode).toBe(0);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    expect(result.stdout).not.toMatch(/\x1b\[/); // No ANSI codes
  });

  it('should include all data in JSON output', async () => {
    const result = kspec(`workflow next @${runId} --json`, tempDir);

    const output = JSON.parse(result.stdout);
    expect(output.run_id).toBeDefined();
    expect(output.current_step).toBeDefined();
    expect(output.total_steps).toBeDefined();
    expect(output.next_step).toBeDefined();
  });

  it('should return errors as JSON', async () => {
    const result = kspec(`workflow next @nonexistent --json`, tempDir, { expectFail: true });

    expect(result.exitCode).toBe(3);
    // Error messages go to stderr, not JSON output in this implementation
    expect(result.stderr).toContain('Workflow run not found');
  });

  it('should use @ prefix for references', async () => {
    const result = kspec(`workflow next @${runId} --json`, tempDir);

    const output = JSON.parse(result.stdout);
    expect(output.run_id).toMatch(/^[A-Z0-9]{26}$/); // ULID without @
  });

  it('should use ISO 8601 timestamps in completion summary', async () => {
    // Advance to last step
    kspec(`workflow next @${runId}`, tempDir);
    kspec(`workflow next @${runId}`, tempDir);

    const result = kspec(`workflow next @${runId} --json`, tempDir);

    const output = JSON.parse(result.stdout);
    expect(output.completed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

// AC: @trait-error-guidance (inherited)
describe('workflow next - error guidance trait', () => {
  it('should provide guidance for no active runs', async () => {
    const result = kspec('workflow next', tempDir, { expectFail: true });

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('No active workflow runs found');
    expect(result.stderr).toContain('kspec workflow start'); // Suggested action
  });

  it('should provide guidance for multiple active runs', async () => {
    kspec('workflow start @test-workflow --json', tempDir);
    kspec('workflow start @another-workflow --json', tempDir);

    const result = kspec('workflow next', tempDir, { expectFail: true });

    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain('Multiple active runs found');
    expect(result.stderr).toContain('kspec workflow next @'); // Shows how to specify
  });

  it('should indicate run not found', async () => {
    const result = kspec('workflow next @nonexistent', tempDir, { expectFail: true });

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('Workflow run not found');
    expect(result.stderr).toContain('nonexistent');
  });

  it('should indicate invalid state transition', async () => {
    const startResult = kspec('workflow start @test-workflow --json', tempDir);
    const { run_id } = JSON.parse(startResult.stdout);

    // Manually set run to completed
    const runsPath = path.join(tempDir, 'kynetic.runs.yaml');
    const runsContent = await fs.readFile(runsPath, 'utf-8');
    const doc = parseDocument(runsContent);
    doc.setIn(['runs', 0, 'status'], 'completed');
    await fs.writeFile(runsPath, doc.toString(), 'utf-8');

    const result = kspec(`workflow next @${run_id}`, tempDir, { expectFail: true });

    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain('Cannot advance workflow run');
    expect(result.stderr).toContain('completed'); // Current state
    expect(result.stderr).toContain('active'); // Expected state
  });
});

/**
 * Tests for workflow enforcement modes
 * Spec: @workflow-enforcement-modes
 */

// AC: @workflow-enforcement-modes ac-1
describe('entry criteria display and enforcement', () => {
  let strictWorkflowUlid: string;
  let advisoryWorkflowUlid: string;

  beforeEach(async () => {
    strictWorkflowUlid = ulid();
    advisoryWorkflowUlid = ulid();

    // Create workflows with entry criteria
    const metaPath = path.join(tempDir, 'kynetic.meta.yaml');
    const metaContent = await fs.readFile(metaPath, 'utf-8');
    const doc = parseDocument(metaContent);
    const metaData = doc.toJS() as any;

    metaData.workflows.push({
      _ulid: strictWorkflowUlid,
      id: 'strict-workflow',
      trigger: 'manual',
      enforcement: 'strict',
      steps: [
        { type: 'check', content: 'First step' },
        {
          type: 'action',
          content: 'Second step with entry criteria',
          entry_criteria: ['Prerequisite A is complete', 'Prerequisite B is verified'],
        },
        { type: 'check', content: 'Third step' },
      ],
    });

    metaData.workflows.push({
      _ulid: advisoryWorkflowUlid,
      id: 'advisory-workflow',
      trigger: 'manual',
      enforcement: 'advisory',
      steps: [
        { type: 'check', content: 'First step' },
        {
          type: 'action',
          content: 'Second step with entry criteria',
          entry_criteria: ['Advisory prerequisite A', 'Advisory prerequisite B'],
        },
        { type: 'check', content: 'Third step' },
      ],
    });

    await fs.writeFile(metaPath, YAML.stringify(metaData), 'utf-8');
  });

  it('should display entry criteria in strict mode and block without --confirm', async () => {
    // Start run
    const startResult = kspec(`workflow start @strict-workflow --json`, tempDir);
    expect(startResult.exitCode).toBe(0);
    const { run_id } = JSON.parse(startResult.stdout);

    // Try to advance without --confirm - should block
    const nextResult = kspec(`workflow next @${run_id}`, tempDir, { expectFail: true });

    expect(nextResult.exitCode).toBe(4); // VALIDATION_FAILED
    expect(nextResult.stdout).toContain('Step 2/3');
    expect(nextResult.stdout).toContain('Second step with entry criteria');
    expect(nextResult.stdout).toContain('Entry criteria:');
    expect(nextResult.stdout).toContain('Prerequisite A is complete');
    expect(nextResult.stdout).toContain('Prerequisite B is verified');
    expect(nextResult.stderr).toContain('Entry criteria not confirmed');
    expect(nextResult.stderr).toContain('--confirm');
  });

  it('should allow advance in strict mode with --confirm', async () => {
    // Start run
    const startResult = kspec(`workflow start @strict-workflow --json`, tempDir);
    expect(startResult.exitCode).toBe(0);
    const { run_id } = JSON.parse(startResult.stdout);

    // Advance with --confirm - should succeed
    const nextResult = kspec(`workflow next @${run_id} --confirm`, tempDir);

    expect(nextResult.exitCode).toBe(0);
    expect(nextResult.stdout).toContain('Completed step 1/3');
    expect(nextResult.stdout).toContain('Step 2/3');
  });

  it('should display entry criteria in advisory mode without blocking', async () => {
    // Start run
    const startResult = kspec(`workflow start @advisory-workflow --json`, tempDir);
    expect(startResult.exitCode).toBe(0);
    const { run_id } = JSON.parse(startResult.stdout);

    // Advance without --confirm - should succeed and show criteria
    const nextResult = kspec(`workflow next @${run_id}`, tempDir);

    expect(nextResult.exitCode).toBe(0);
    expect(nextResult.stdout).toContain('Step 2/3');
    expect(nextResult.stdout).toContain('Entry criteria:');
    expect(nextResult.stdout).toContain('Advisory prerequisite A');
    expect(nextResult.stdout).toContain('Advisory prerequisite B');
  });

  it('should not block in advisory mode without --confirm', async () => {
    // Start run
    const startResult = kspec(`workflow start @advisory-workflow --json`, tempDir);
    expect(startResult.exitCode).toBe(0);
    const { run_id } = JSON.parse(startResult.stdout);

    // Advance without --confirm - should complete successfully
    const nextResult = kspec(`workflow next @${run_id}`, tempDir);

    expect(nextResult.exitCode).toBe(0);
    expect(nextResult.stdout).toContain('Completed step 1/3');
  });
});

// AC: @workflow-enforcement-modes ac-2
describe('exit criteria display and enforcement', () => {
  let strictWorkflowUlid: string;
  let advisoryWorkflowUlid: string;

  beforeEach(async () => {
    strictWorkflowUlid = ulid();
    advisoryWorkflowUlid = ulid();

    // Create workflows with exit criteria
    const metaPath = path.join(tempDir, 'kynetic.meta.yaml');
    const metaContent = await fs.readFile(metaPath, 'utf-8');
    const doc = parseDocument(metaContent);
    const metaData = doc.toJS() as any;

    metaData.workflows.push({
      _ulid: strictWorkflowUlid,
      id: 'strict-exit-workflow',
      trigger: 'manual',
      enforcement: 'strict',
      steps: [
        {
          type: 'action',
          content: 'Step with exit criteria',
          exit_criteria: ['Output A is generated', 'Output B is validated'],
        },
        { type: 'check', content: 'Final step' },
      ],
    });

    metaData.workflows.push({
      _ulid: advisoryWorkflowUlid,
      id: 'advisory-exit-workflow',
      trigger: 'manual',
      enforcement: 'advisory',
      steps: [
        {
          type: 'action',
          content: 'Step with exit criteria',
          exit_criteria: ['Advisory output A', 'Advisory output B'],
        },
        { type: 'check', content: 'Final step' },
      ],
    });

    await fs.writeFile(metaPath, YAML.stringify(metaData), 'utf-8');
  });

  it('should display exit criteria in strict mode and block without --confirm', async () => {
    // Start run
    const startResult = kspec(`workflow start @strict-exit-workflow --json`, tempDir);
    expect(startResult.exitCode).toBe(0);
    const { run_id } = JSON.parse(startResult.stdout);

    // Try to advance without --confirm - should block
    const nextResult = kspec(`workflow next @${run_id}`, tempDir, { expectFail: true });

    expect(nextResult.exitCode).toBe(4); // VALIDATION_FAILED
    expect(nextResult.stdout).toContain('Completing step 1/2');
    expect(nextResult.stdout).toContain('Exit criteria:');
    expect(nextResult.stdout).toContain('Output A is generated');
    expect(nextResult.stdout).toContain('Output B is validated');
    expect(nextResult.stderr).toContain('Exit criteria not confirmed');
    expect(nextResult.stderr).toContain('--confirm');
  });

  it('should allow advance in strict mode with --confirm', async () => {
    // Start run
    const startResult = kspec(`workflow start @strict-exit-workflow --json`, tempDir);
    expect(startResult.exitCode).toBe(0);
    const { run_id } = JSON.parse(startResult.stdout);

    // Advance with --confirm - should succeed
    const nextResult = kspec(`workflow next @${run_id} --confirm`, tempDir);

    expect(nextResult.exitCode).toBe(0);
    expect(nextResult.stdout).toContain('Completed step 1/2');
  });

  it('should display exit criteria in advisory mode without blocking', async () => {
    // Start run
    const startResult = kspec(`workflow start @advisory-exit-workflow --json`, tempDir);
    expect(startResult.exitCode).toBe(0);
    const { run_id } = JSON.parse(startResult.stdout);

    // Advance without --confirm - should succeed and show criteria
    const nextResult = kspec(`workflow next @${run_id}`, tempDir);

    expect(nextResult.exitCode).toBe(0);
    expect(nextResult.stdout).toContain('Exit criteria:');
    expect(nextResult.stdout).toContain('Advisory output A');
    expect(nextResult.stdout).toContain('Advisory output B');
  });
});

// AC: @workflow-enforcement-modes ac-3
describe('strict mode enforcement', () => {
  let strictWorkflowUlid: string;

  beforeEach(async () => {
    strictWorkflowUlid = ulid();

    // Create strict workflow with both entry and exit criteria
    const metaPath = path.join(tempDir, 'kynetic.meta.yaml');
    const metaContent = await fs.readFile(metaPath, 'utf-8');
    const doc = parseDocument(metaContent);
    const metaData = doc.toJS() as any;

    metaData.workflows.push({
      _ulid: strictWorkflowUlid,
      id: 'strict-full-workflow',
      trigger: 'manual',
      enforcement: 'strict',
      steps: [
        {
          type: 'action',
          content: 'First step',
          exit_criteria: ['First output complete'],
        },
        {
          type: 'action',
          content: 'Second step',
          entry_criteria: ['First step verified'],
          exit_criteria: ['Second output complete'],
        },
        { type: 'check', content: 'Final step' },
      ],
    });

    await fs.writeFile(metaPath, YAML.stringify(metaData), 'utf-8');
  });

  it('should require --confirm to proceed with criteria', async () => {
    const startResult = kspec(`workflow start @strict-full-workflow --json`, tempDir);
    expect(startResult.exitCode).toBe(0);
    const { run_id } = JSON.parse(startResult.stdout);

    // Try without --confirm - should fail
    const failResult = kspec(`workflow next @${run_id}`, tempDir, { expectFail: true });
    expect(failResult.exitCode).toBe(4);
    expect(failResult.stderr).toContain('Exit criteria not confirmed');

    // Try with --confirm - should succeed
    const successResult = kspec(`workflow next @${run_id} --confirm`, tempDir);
    expect(successResult.exitCode).toBe(0);
  });

  it('should require --force to skip in strict mode', async () => {
    const startResult = kspec(`workflow start @strict-full-workflow --json`, tempDir);
    expect(startResult.exitCode).toBe(0);
    const { run_id } = JSON.parse(startResult.stdout);

    // Try --skip without --force - should fail
    const failResult = kspec(`workflow next @${run_id} --skip`, tempDir, { expectFail: true });
    expect(failResult.exitCode).toBe(4);
    expect(failResult.stderr).toContain('Cannot skip step in strict mode without --force');

    // Try --skip with --force - should succeed
    const successResult = kspec(`workflow next @${run_id} --skip --force`, tempDir);
    expect(successResult.exitCode).toBe(0);
  });

  it('should record confirmations in step_results', async () => {
    const startResult = kspec(`workflow start @strict-full-workflow --json`, tempDir);
    expect(startResult.exitCode).toBe(0);
    const { run_id } = JSON.parse(startResult.stdout);

    // Advance with --confirm
    const nextResult = kspec(`workflow next @${run_id} --confirm`, tempDir);
    expect(nextResult.exitCode).toBe(0);

    // Check that confirmation was recorded
    const runsPath = path.join(tempDir, 'kynetic.runs.yaml');
    const runsContent = await fs.readFile(runsPath, 'utf-8');
    const doc = parseDocument(runsContent);
    const runsData = doc.toJS() as { runs: any[] };

    const run = runsData.runs.find((r: any) => r._ulid === run_id);
    expect(run).toBeDefined();
    expect(run.step_results).toHaveLength(1);
    expect(run.step_results[0].exit_confirmed).toBe(true);
  });
});

// AC: @workflow-enforcement-modes ac-4
describe('advisory mode behavior', () => {
  let advisoryWorkflowUlid: string;

  beforeEach(async () => {
    advisoryWorkflowUlid = ulid();

    // Create advisory workflow (default or explicit)
    const metaPath = path.join(tempDir, 'kynetic.meta.yaml');
    const metaContent = await fs.readFile(metaPath, 'utf-8');
    const doc = parseDocument(metaContent);
    const metaData = doc.toJS() as any;

    metaData.workflows.push({
      _ulid: advisoryWorkflowUlid,
      id: 'advisory-full-workflow',
      trigger: 'manual',
      enforcement: 'advisory',
      steps: [
        {
          type: 'action',
          content: 'First step',
          exit_criteria: ['Advisory output'],
        },
        {
          type: 'action',
          content: 'Second step',
          entry_criteria: ['Advisory input'],
        },
      ],
    });

    await fs.writeFile(metaPath, YAML.stringify(metaData), 'utf-8');
  });

  it('should show criteria as guidance only', async () => {
    const startResult = kspec(`workflow start @advisory-full-workflow --json`, tempDir);
    expect(startResult.exitCode).toBe(0);
    const { run_id } = JSON.parse(startResult.stdout);

    // Advance without --confirm - should succeed
    const nextResult = kspec(`workflow next @${run_id}`, tempDir);
    expect(nextResult.exitCode).toBe(0);
    expect(nextResult.stdout).toContain('Exit criteria:');
    expect(nextResult.stdout).toContain('Advisory output');
  });

  it('should allow --skip without --force', async () => {
    const startResult = kspec(`workflow start @advisory-full-workflow --json`, tempDir);
    expect(startResult.exitCode).toBe(0);
    const { run_id } = JSON.parse(startResult.stdout);

    // Skip without --force - should succeed
    const skipResult = kspec(`workflow next @${run_id} --skip`, tempDir);
    expect(skipResult.exitCode).toBe(0);

    // Verify step was marked as skipped
    const runsPath = path.join(tempDir, 'kynetic.runs.yaml');
    const runsContent = await fs.readFile(runsPath, 'utf-8');
    const doc = parseDocument(runsContent);
    const runsData = doc.toJS() as { runs: any[] };

    const run = runsData.runs.find((r: any) => r._ulid === run_id);
    expect(run).toBeDefined();
    expect(run.step_results[0].status).toBe('skipped');
  });
});

// AC: @trait-json-output ac-1, ac-2, ac-3
describe('workflow next JSON output', () => {
  let testWorkflowUlidLocal: string;

  beforeEach(async () => {
    testWorkflowUlidLocal = ulid();

    // Create simple workflow for JSON testing
    const metaPath = path.join(tempDir, 'kynetic.meta.yaml');
    const metaContent = await fs.readFile(metaPath, 'utf-8');
    const doc = parseDocument(metaContent);
    const metaData = doc.toJS() as any;

    metaData.workflows.push({
      _ulid: testWorkflowUlidLocal,
      id: 'json-test-workflow',
      trigger: 'manual',
      steps: [
        { type: 'action', content: 'First step' },
        { type: 'action', content: 'Second step' },
      ],
    });

    await fs.writeFile(metaPath, YAML.stringify(metaData), 'utf-8');
  });

  it('should output valid JSON with no ANSI codes', async () => {
    const startResult = kspec(`workflow start @json-test-workflow --json`, tempDir);
    expect(startResult.exitCode).toBe(0);
    const { run_id } = JSON.parse(startResult.stdout);

    const nextResult = kspec(`workflow next @${run_id} --json`, tempDir);
    expect(nextResult.exitCode).toBe(0);

    // Should parse as valid JSON
    const output = JSON.parse(nextResult.stdout);
    expect(output).toBeDefined();

    // Should not contain ANSI escape codes
    expect(nextResult.stdout).not.toMatch(/\x1b\[/);
  });

  it('should include all data in JSON mode', async () => {
    const startResult = kspec(`workflow start @json-test-workflow --json`, tempDir);
    expect(startResult.exitCode).toBe(0);
    const { run_id } = JSON.parse(startResult.stdout);

    const nextResult = kspec(`workflow next @${run_id} --json`, tempDir);
    expect(nextResult.exitCode).toBe(0);

    const output = JSON.parse(nextResult.stdout);
    expect(output).toHaveProperty('run_id');
    expect(output).toHaveProperty('current_step');
    expect(output).toHaveProperty('total_steps');
    expect(output).toHaveProperty('next_step');
  });

  it('should return errors as JSON in JSON mode', async () => {
    const result = kspec(`workflow next @nonexistent --json`, tempDir, { expectFail: true });

    expect(result.exitCode).toBe(3); // NOT_FOUND
    // Error output is on stderr, not stdout in JSON mode
    expect(result.stderr).toContain('Workflow run not found');
  });
});
