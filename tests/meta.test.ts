/**
 * Integration tests for kspec meta commands
 * AC: @agent-definitions ac-agent-1, ac-agent-2, ac-agent-3
 * AC: @workflow-definitions ac-workflow-1, ac-workflow-2, ac-workflow-3, ac-workflow-4
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { kspec as kspecRun, kspecOutput as kspec, kspecJson, setupTempFixtures, cleanupTempDir } from './helpers/cli';

describe('Integration: meta agents', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @agent-definitions ac-agent-1
  it('should output table with ID, Name, Capabilities columns', () => {
    const output = kspec('meta agents', tempDir);

    // Should contain table headers
    expect(output).toContain('ID');
    expect(output).toContain('Name');
    expect(output).toContain('Capabilities');

    // Should contain agent data from fixtures
    expect(output).toContain('test-agent');
    expect(output).toContain('Test Agent');
    expect(output).toContain('code, test');

    expect(output).toContain('review-agent');
    expect(output).toContain('Review Agent');
    expect(output).toContain('review, analyze');
  });

  // AC: @agent-definitions ac-agent-2
  it('should output JSON array with full agent details', () => {
    interface AgentJson {
      id: string;
      name: string;
      description: string;
      capabilities: string[];
      tools: string[];
      session_protocol: Record<string, string>;
      conventions: string[];
    }

    const agents = kspecJson<AgentJson[]>('meta agents', tempDir);

    // Should be an array (3 agents: test, test-agent, review-agent)
    expect(Array.isArray(agents)).toBe(true);
    expect(agents).toHaveLength(3);

    // First agent
    const testAgent = agents.find(a => a.id === 'test-agent');
    expect(testAgent).toBeDefined();
    expect(testAgent?.name).toBe('Test Agent');
    expect(testAgent?.description).toBe('A test agent for integration testing');
    expect(testAgent?.capabilities).toEqual(['code', 'test']);
    expect(testAgent?.tools).toEqual(['kspec', 'git']);
    expect(testAgent?.session_protocol).toEqual({
      start: 'kspec session start',
      checkpoint: 'kspec session checkpoint',
    });
    expect(testAgent?.conventions).toEqual([
      'Test convention 1',
      'Test convention 2',
    ]);

    // Second agent
    const reviewAgent = agents.find(a => a.id === 'review-agent');
    expect(reviewAgent).toBeDefined();
    expect(reviewAgent?.name).toBe('Review Agent');
    expect(reviewAgent?.capabilities).toEqual(['review', 'analyze']);
    expect(reviewAgent?.tools).toEqual(['kspec']);
  });

  it('should handle empty agents list gracefully', async () => {
    // Create a meta manifest with no agents
    const emptyMetaPath = path.join(tempDir, 'kynetic.meta.yaml');
    await fs.writeFile(emptyMetaPath, 'kynetic_meta: "1.0"\nagents: []\n');

    const output = kspec('meta agents', tempDir);
    expect(output).toContain('No agents defined');
  });

  it('should handle missing meta manifest gracefully', async () => {
    // Remove meta manifest file entirely
    const metaPath = path.join(tempDir, 'kynetic.meta.yaml');
    await fs.rm(metaPath, { force: true });

    // Also remove reference from kynetic.yaml
    const manifestPath = path.join(tempDir, 'kynetic.yaml');
    let content = await fs.readFile(manifestPath, 'utf-8');
    content = content.replace('meta_file: kynetic.meta.yaml\n', '');
    await fs.writeFile(manifestPath, content);

    const output = kspec('meta agents', tempDir);
    // Should show empty result, not crash
    expect(output).toContain('No agents defined');
  });

  // AC: @agent-definitions ac-agent-3
  it('should validate agent references in notes', async () => {
    // Add a task with a note that references a valid agent
    const tasksPath = path.join(tempDir, 'project.tasks.yaml');
    let tasksContent = await fs.readFile(tasksPath, 'utf-8');

    // Add a task with a note containing a valid agent reference
    const newTask = `
  - _ulid: 01KF79C0H1ZHT2T4JMECS89ARS
    title: Test task with agent reference in note
    status: pending
    priority: 1
    created_at: "2024-01-01T00:00:00Z"
    slugs:
      - test-task-with-agent
    depends_on: []
    notes:
      - _ulid: 01KF79C0H1ZHT2T4JMECS89AR1
        created_at: "2024-01-01T00:00:00Z"
        author: "@test-agent"
        content: A note from a valid agent
    todos: []
    blocked_by: []
    tags: []
`;
    tasksContent = tasksContent.replace('tasks:', `tasks:${newTask}`);
    await fs.writeFile(tasksPath, tasksContent);

    // Validate should pass because test-agent exists
    const output = kspec('validate --refs', tempDir);
    expect(output).toContain('References: OK');
  });

  // AC: @agent-definitions ac-agent-3
  it('should error on invalid agent reference in notes', async () => {
    // Add a task with a note that references a non-existent agent
    const tasksPath = path.join(tempDir, 'project.tasks.yaml');
    let tasksContent = await fs.readFile(tasksPath, 'utf-8');

    const newTask = `
  - _ulid: 01KF79C0H1C6H77ZSGMMVJF994
    title: Test task with invalid agent reference
    status: pending
    priority: 1
    created_at: "2024-01-01T00:00:00Z"
    slugs:
      - test-task-invalid-agent
    depends_on: []
    notes:
      - _ulid: 01KF79C0H1C6H77ZSGMMVJF991
        created_at: "2024-01-01T00:00:00Z"
        author: "@nonexistent-agent"
        content: A note from an invalid agent
    todos: []
    blocked_by: []
    tags: []
`;
    tasksContent = tasksContent.replace('tasks:', `tasks:${newTask}`);
    await fs.writeFile(tasksPath, tasksContent);

    // Validation should fail with reference error
    // kspec() returns stdout even on failure, so we get the output
    const output = kspec('validate --refs', tempDir);
    expect(output).toContain('✗ Validation failed');
    expect(output).toContain('Reference "@nonexistent-agent" not found');
    expect(output).toContain('author');
  });
});

describe('Integration: meta workflows', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @workflow-definitions ac-workflow-1
  it('should output table with ID, Trigger, Steps columns', () => {
    const output = kspec('meta workflows', tempDir);

    // Should contain table headers
    expect(output).toContain('ID');
    expect(output).toContain('Trigger');
    expect(output).toContain('Steps');

    // Should contain workflow data from fixtures
    expect(output).toContain('task-start');
    expect(output).toContain('Before starting a task');
    expect(output).toContain('4'); // 4 steps

    expect(output).toContain('commit');
    expect(output).toContain('After completing a task');
    expect(output).toContain('3'); // 3 steps
  });

  // AC: @workflow-definitions ac-workflow-2
  it('should output verbose format with full step details', () => {
    const output = kspec('meta workflows --verbose', tempDir);

    // Should contain workflow headers
    expect(output).toContain('task-start - Before starting a task');
    expect(output).toContain('Pre-task checklist workflow');

    // Should contain step type prefixes
    expect(output).toContain('[check]');
    expect(output).toContain('[action]');
    expect(output).toContain('[decision]');

    // Should contain step content
    expect(output).toContain('Read the spec item linked to the task');
    expect(output).toContain('Verify all dependencies are completed');
    expect(output).toContain('Add initial note documenting approach');

    // Should contain on_fail for checks
    expect(output).toContain('on fail: Cannot proceed without spec context');
    expect(output).toContain('on fail: Block task and note missing dependencies');

    // Should contain decision options
    expect(output).toContain('Does this need plan mode?');
    expect(output).toContain('Yes - enter plan mode');
    expect(output).toContain('No - proceed with implementation');

    // Should contain second workflow
    expect(output).toContain('commit - After completing a task');
    expect(output).toContain('All tests passing');
    expect(output).toContain('on fail: Fix failing tests before committing');
  });

  // AC: @workflow-definitions ac-workflow-4
  it('should output JSON array with full workflow details', () => {
    interface WorkflowJson {
      id: string;
      trigger: string;
      description: string;
      steps: Array<{
        type: string;
        content: string;
        on_fail?: string;
        options?: string[];
      }>;
    }

    const workflows = kspecJson<WorkflowJson[]>('meta workflows', tempDir);

    // Should be an array with 2 workflows
    expect(Array.isArray(workflows)).toBe(true);
    expect(workflows).toHaveLength(2);

    // First workflow
    const taskStart = workflows.find(w => w.id === 'task-start');
    expect(taskStart).toBeDefined();
    expect(taskStart?.trigger).toBe('Before starting a task');
    expect(taskStart?.description).toBe('Pre-task checklist workflow');
    expect(taskStart?.steps).toHaveLength(4);

    // Check step details
    const firstStep = taskStart?.steps[0];
    expect(firstStep?.type).toBe('check');
    expect(firstStep?.content).toBe('Read the spec item linked to the task');
    expect(firstStep?.on_fail).toBe('Cannot proceed without spec context');

    const decisionStep = taskStart?.steps[3];
    expect(decisionStep?.type).toBe('decision');
    expect(decisionStep?.content).toBe('Does this need plan mode?');
    expect(decisionStep?.options).toEqual([
      'Yes - enter plan mode',
      'No - proceed with implementation',
    ]);

    // Second workflow
    const commit = workflows.find(w => w.id === 'commit');
    expect(commit).toBeDefined();
    expect(commit?.trigger).toBe('After completing a task');
    expect(commit?.steps).toHaveLength(3);
  });

  it('should handle empty workflows list gracefully', async () => {
    // Create a meta manifest with no workflows
    const emptyMetaPath = path.join(tempDir, 'kynetic.meta.yaml');
    await fs.writeFile(emptyMetaPath, 'kynetic_meta: "1.0"\nworkflows: []\n');

    const output = kspec('meta workflows', tempDir);
    expect(output).toContain('No workflows defined');
  });

  it('should handle missing meta manifest gracefully', async () => {
    // Remove meta manifest file entirely
    const metaPath = path.join(tempDir, 'kynetic.meta.yaml');
    await fs.rm(metaPath, { force: true });

    const output = kspec('meta workflows', tempDir);
    expect(output).toContain('No workflows defined');
  });

  // AC: @workflow-definitions ac-workflow-3
  it('should validate workflow references in meta_ref', async () => {
    // Add a task with meta_ref pointing to a valid workflow
    const tasksPath = path.join(tempDir, 'project.tasks.yaml');
    let tasksContent = await fs.readFile(tasksPath, 'utf-8');

    const newTask = `
  - _ulid: 01KF7A2Z00TESTWORKFLOWREF01
    title: Test task with workflow reference
    status: pending
    priority: 1
    created_at: "2024-01-01T00:00:00Z"
    meta_ref: "@task-start"
    slugs:
      - test-task-with-workflow
    depends_on: []
    notes: []
    todos: []
    blocked_by: []
    tags: []
`;
    tasksContent = tasksContent.replace('tasks:', `tasks:${newTask}`);
    await fs.writeFile(tasksPath, tasksContent);

    // Validate should pass because task-start workflow exists
    const output = kspec('validate --refs', tempDir);
    expect(output).toContain('References: OK');
  });

  // AC: @workflow-definitions ac-workflow-3
  it('should error on invalid workflow reference in meta_ref', async () => {
    // Add a task with meta_ref pointing to a non-existent workflow
    const tasksPath = path.join(tempDir, 'project.tasks.yaml');
    let tasksContent = await fs.readFile(tasksPath, 'utf-8');

    const newTask = `
  - _ulid: 01KF7AP9FXVDKXDFPSNFWS11SW
    title: Test task with invalid workflow reference
    status: pending
    priority: 1
    created_at: "2024-01-01T00:00:00Z"
    meta_ref: "@this-workflow-does-not-exist-anywhere-in-fixtures"
    slugs:
      - test-task-invalid-workflow
    depends_on: []
    notes: []
    todos: []
    blocked_by: []
    tags: []
`;
    // Append to end of file instead of replacing 'tasks:'
    tasksContent = tasksContent.trimEnd() + newTask + '\n';
    await fs.writeFile(tasksPath, tasksContent);

    // Validation should fail with reference error
    const output = kspec('validate --refs', tempDir);
    expect(output).toContain('✗ Validation failed');
    expect(output).toContain('not found');
    expect(output).toContain('meta_ref');
  });
});

describe('Integration: meta observations', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @observations ac-obs-1
  it('should create an observation with correct fields', () => {
    const output = kspec('meta observe friction "CLI output is too verbose"', tempDir);

    // AC-obs-1: Should output "OK Created observation: <ULID-prefix>"
    expect(output).toMatch(/Created observation: [A-Z0-9]{8}/);

    // Verify observation was saved
    const observations = kspecJson<any[]>('meta observations', tempDir);
    const newObs = observations.find(o => o.content === 'CLI output is too verbose');

    expect(newObs).toBeDefined();
    expect(newObs.type).toBe('friction');
    expect(newObs.created_at).toBeDefined();
    expect(newObs.author).toBeDefined();
    expect(newObs.resolved).toBe(false);
  });

  // AC: @observations ac-obs-1
  it('should create observation with workflow reference', () => {
    const output = kspec('meta observe success "Tests caught a bug" --workflow "@task-start"', tempDir);
    expect(output).toMatch(/Created observation: [A-Z0-9]{8}/);

    const observations = kspecJson<any[]>('meta observations', tempDir);
    const newObs = observations.find(o => o.content === 'Tests caught a bug');

    expect(newObs).toBeDefined();
    expect(newObs.workflow_ref).toBe('@task-start');
  });

  // AC: @observations ac-obs-2
  it('should list unresolved observations by default', () => {
    // Create some observations
    kspec('meta observe friction "Problem 1"', tempDir);
    kspec('meta observe success "Good thing"', tempDir);

    const output = kspec('meta observations', tempDir);

    // Should contain table headers
    expect(output).toContain('ID');
    expect(output).toContain('Type');
    expect(output).toContain('Workflow');
    expect(output).toContain('Created');
    expect(output).toContain('Content');

    // Should contain observation data
    expect(output).toContain('friction');
    expect(output).toContain('Problem 1');
    expect(output).toContain('success');
    expect(output).toContain('Good thing');
  });

  // AC: @observations ac-obs-2
  it('should show only unresolved observations by default', async () => {
    // Create and resolve an observation
    const createOutput = kspec('meta observe friction "This will be resolved"', tempDir);
    const match = createOutput.match(/Created observation: ([A-Z0-9]{8})/);
    expect(match).not.toBeNull();
    const obsRef = match![1];

    kspec(`meta resolve @${obsRef} "Fixed it"`, tempDir);

    // List without --all should not show resolved
    const output = kspec('meta observations', tempDir);
    expect(output).not.toContain('This will be resolved');

    // List with --all should show resolved
    const outputAll = kspec('meta observations --all', tempDir);
    expect(outputAll).toContain('This will be resolved');
  });

  // AC: @observations ac-obs-5
  it('should output JSON with full observation objects', () => {
    kspec('meta observe friction "Test observation"', tempDir);

    const observations = kspecJson<any[]>('meta observations', tempDir);

    // Should be an array
    expect(Array.isArray(observations)).toBe(true);

    const testObs = observations.find(o => o.content === 'Test observation');
    expect(testObs).toBeDefined();

    // Should have all fields
    expect(testObs._ulid).toBeDefined();
    expect(testObs.type).toBe('friction');
    expect(testObs.content).toBe('Test observation');
    expect(testObs.created_at).toBeDefined();
    expect(testObs.author).toBeDefined();
    expect(testObs.resolved).toBe(false);
    expect(testObs).toHaveProperty('resolution');
    expect(testObs).toHaveProperty('resolved_at');
    expect(testObs).toHaveProperty('resolved_by');
    expect(testObs).toHaveProperty('promoted_to');
  });

  // AC: @observations ac-obs-3
  it('should promote observation to task', () => {
    // Create observation
    const createOutput = kspec('meta observe friction "Need better error messages" --workflow "@task-start"', tempDir);
    const match = createOutput.match(/Created observation: ([A-Z0-9]{8})/);
    const obsRef = match![1];

    // Promote to task
    const promoteOutput = kspec(`meta promote @${obsRef} --title "Improve error messages"`, tempDir);

    // AC-obs-3: Should output "OK Created task: <ULID-prefix>"
    expect(promoteOutput).toMatch(/Created task: @[A-Z0-9]{8}/);

    // Verify observation was updated with promoted_to
    const observations = kspecJson<any[]>('meta observations', tempDir);
    const obs = observations.find(o => o._ulid.startsWith(obsRef));
    expect(obs.promoted_to).toBeDefined();
    expect(obs.promoted_to).toMatch(/@[A-Z0-9]{8}/);
  });

  // AC: @observations ac-obs-6
  it('should error when promoting already-promoted observation', () => {
    // Create and promote observation
    const createOutput = kspec('meta observe friction "Test promotion"', tempDir);
    const match = createOutput.match(/Created observation: ([A-Z0-9]{8})/);
    const obsRef = match![1];

    kspec(`meta promote @${obsRef} --title "First promotion"`, tempDir);

    // Try to promote again - should fail
    try {
      const output = kspec(`meta promote @${obsRef} --title "Second promotion"`, tempDir);
      // AC-obs-6: Should error with specific message
      expect(output).toContain('Observation already promoted to task');
      expect(output).toContain('resolve or delete the task first');
    } catch (e: any) {
      const stdout = e.message || '';
      expect(stdout).toContain('Observation already promoted to task');
    }
  });

  // AC: @observations ac-obs-8
  it('should error when promoting resolved observation without --force', () => {
    // Create and resolve observation
    const createOutput = kspec('meta observe friction "Already resolved"', tempDir);
    const match = createOutput.match(/Created observation: ([A-Z0-9]{8})/);
    const obsRef = match![1];

    kspec(`meta resolve @${obsRef} "No longer relevant"`, tempDir);

    // Try to promote resolved observation without --force - should fail
    try {
      const output = kspec(`meta promote @${obsRef} --title "Try to promote"`, tempDir);
      // AC-obs-8: Should error with specific message
      expect(output).toContain('Cannot promote resolved observation');
      expect(output).toContain('use --force to override');
    } catch (e: any) {
      // Error is expected, check message in stdout
      const stdout = e.message || '';
      expect(stdout).toContain('Cannot promote resolved observation');
    }
  });

  // AC: @observations ac-obs-4
  it('should resolve observation with resolution text', () => {
    // Create observation
    const createOutput = kspec('meta observe friction "Something broken"', tempDir);
    const match = createOutput.match(/Created observation: ([A-Z0-9]{8})/);
    const obsRef = match![1];

    // Resolve it
    const resolveOutput = kspec(`meta resolve @${obsRef} "Fixed by implementing new feature"`, tempDir);

    // AC-obs-4: Should output "OK Resolved: <ULID-prefix>"
    expect(resolveOutput).toMatch(/Resolved: [A-Z0-9]{8}/);

    // Verify observation was updated
    const observations = kspecJson<any[]>('meta observations', tempDir);
    const obs = observations.find(o => o._ulid.startsWith(obsRef));

    expect(obs.resolved).toBe(true);
    expect(obs.resolution).toBe('Fixed by implementing new feature');
    expect(obs.resolved_at).toBeDefined();
    expect(obs.resolved_by).toBeDefined();
  });

  // AC: @observations ac-obs-7
  it('should error when resolving already-resolved observation', () => {
    // Create and resolve observation
    const createOutput = kspec('meta observe friction "Test double resolve"', tempDir);
    const match = createOutput.match(/Created observation: ([A-Z0-9]{8})/);
    const obsRef = match![1];

    kspec(`meta resolve @${obsRef} "First resolution"`, tempDir);

    // Try to resolve again - should fail
    try {
      const output = kspec(`meta resolve @${obsRef} "Second resolution"`, tempDir);
      // AC-obs-7: Should error with specific message
      expect(output).toContain('Observation already resolved on');
      expect(output).toContain('First resolution');
    } catch (e: any) {
      const stdout = e.message || '';
      expect(stdout).toContain('Observation already resolved on');
    }
  });

  it('should handle invalid observation type', () => {
    const output = kspec('meta observe invalid "Test content"', tempDir);
    // kspec() returns stdout even on error
    expect(output).toContain('Valid types: friction, success, question, idea');
  });

  it('should handle observation not found', () => {
    try {
      const output = kspec('meta promote @NOTFOUND --title "Test"', tempDir);
      expect(output).toContain('Observation not found: @NOTFOUND');
    } catch (e: any) {
      const stdout = e.message || '';
      expect(stdout).toContain('Observation not found: @NOTFOUND');
    }
  });
});

describe('Integration: observation-task resolution loop', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('should auto-populate resolution from completed task', () => {
    // Create observation
    const createOutput = kspec('meta observe friction "CLI is slow"', tempDir);
    const match = createOutput.match(/Created observation: ([A-Z0-9]{8})/);
    const obsRef = match![1];

    // Promote to task
    const promoteOutput = kspec(`meta promote @${obsRef} --title "Optimize CLI performance"`, tempDir);
    const taskMatch = promoteOutput.match(/Created task: @([A-Z0-9]{8})/);
    const taskRef = taskMatch![1];

    // Start and complete the task
    kspec(`task start @${taskRef}`, tempDir);
    kspec(`task complete @${taskRef} --reason "Reduced startup time by 50%"`, tempDir);

    // Resolve observation without explicit text (should auto-populate)
    const resolveOutput = kspec(`meta resolve @${obsRef}`, tempDir);
    expect(resolveOutput).toMatch(/Resolved: [A-Z0-9]{8}/);

    // Verify resolution includes task info
    const observations = kspecJson<any[]>('meta observations --all', tempDir);
    const obs = observations.find(o => o._ulid.startsWith(obsRef));

    expect(obs.resolved).toBe(true);
    expect(obs.resolution).toContain(`@${taskRef}`);
    expect(obs.resolution).toContain('Reduced startup time by 50%');
  });

  it('should filter observations with --promoted', () => {
    // Create two observations, promote one
    kspec('meta observe friction "Issue 1"', tempDir);
    const obs2Output = kspec('meta observe friction "Issue 2"', tempDir);
    const match = obs2Output.match(/Created observation: ([A-Z0-9]{8})/);
    const obsRef = match![1];

    kspec(`meta promote @${obsRef} --title "Fix Issue 2"`, tempDir);

    // List promoted observations
    const promoted = kspecJson<any[]>('meta observations --promoted', tempDir);

    // Only the promoted one should appear
    expect(promoted.length).toBe(1);
    expect(promoted[0]._ulid.startsWith(obsRef)).toBe(true);
    expect(promoted[0].promoted_to).toBeDefined();
  });

  it('should filter observations with --pending-resolution', () => {
    // Create observation, promote, complete task
    const createOutput = kspec('meta observe friction "Needs fix"', tempDir);
    const match = createOutput.match(/Created observation: ([A-Z0-9]{8})/);
    const obsRef = match![1];

    const promoteOutput = kspec(`meta promote @${obsRef} --title "Fix the issue"`, tempDir);
    const taskMatch = promoteOutput.match(/Created task: @([A-Z0-9]{8})/);
    const taskRef = taskMatch![1];

    kspec(`task start @${taskRef}`, tempDir);
    kspec(`task complete @${taskRef} --reason "Fixed"`, tempDir);

    // List pending resolution
    const pending = kspecJson<any[]>('meta observations --pending-resolution', tempDir);

    // Should include our observation
    const found = pending.find(o => o._ulid.startsWith(obsRef));
    expect(found).toBeDefined();
    expect(found.resolved).toBe(false);
    expect(found.promoted_to).toBeDefined();

    // After resolving, should not appear
    kspec(`meta resolve @${obsRef}`, tempDir);
    const pendingAfter = kspecJson<any[]>('meta observations --pending-resolution', tempDir);
    const foundAfter = pendingAfter.find(o => o._ulid.startsWith(obsRef));
    expect(foundAfter).toBeUndefined();
  });

  it('should error when resolving with incomplete task', () => {
    // Create observation, promote, but don't complete task
    const createOutput = kspec('meta observe friction "Not done yet"', tempDir);
    const match = createOutput.match(/Created observation: ([A-Z0-9]{8})/);
    const obsRef = match![1];

    kspec(`meta promote @${obsRef} --title "WIP task"`, tempDir);

    // Try to resolve without text (task not completed)
    try {
      const output = kspec(`meta resolve @${obsRef}`, tempDir);
      expect(output).toContain('not completed yet');
    } catch (e: any) {
      const stdout = e.message || '';
      expect(stdout).toContain('not completed yet');
    }
  });
});

describe('Integration: meta_ref in tasks', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @meta-ref ac-meta-ref-1
  it('should create task with valid meta_ref to workflow', () => {
    // AC-meta-ref-1: task add --meta-ref @workflow-id creates task with meta_ref field
    const output = kspec('task add --title "Improve workflow" --meta-ref "@task-start"', tempDir);

    // Should output "OK Created task: <ULID-prefix>"
    expect(output).toMatch(/Created task: [A-Z0-9]{8}/);

    // Verify task was created with meta_ref
    const match = output.match(/Created task: ([A-Z0-9]{8})/);
    const taskRef = match![1];

    const task = kspecJson<any>(`task get @${taskRef}`, tempDir);
    expect(task.meta_ref).toBe('@task-start');
  });

  // AC: @meta-ref ac-meta-ref-1
  it('should create task with valid meta_ref to agent', () => {
    const output = kspec('task add --title "Update agent capabilities" --meta-ref "@test-agent"', tempDir);
    expect(output).toMatch(/Created task: [A-Z0-9]{8}/);

    const match = output.match(/Created task: ([A-Z0-9]{8})/);
    const taskRef = match![1];

    const task = kspecJson<any>(`task get @${taskRef}`, tempDir);
    expect(task.meta_ref).toBe('@test-agent');
  });

  // AC: @meta-ref ac-meta-ref-2
  it('should filter tasks by meta_ref', () => {
    // Create tasks with different meta_refs
    kspec('task add --title "Task 1" --meta-ref "@task-start"', tempDir);
    kspec('task add --title "Task 2" --meta-ref "@test-agent"', tempDir);
    kspec('task add --title "Task 3" --meta-ref "@task-start"', tempDir);
    kspec('task add --title "Task 4"', tempDir); // No meta_ref

    // AC-meta-ref-2: tasks list --meta-ref @workflow filters by meta_ref
    const tasks = kspecJson<any[]>('tasks list --meta-ref "@task-start"', tempDir);

    // Should only include tasks with meta_ref = @task-start
    const taskTitles = tasks.map(t => t.title);
    expect(taskTitles).toContain('Task 1');
    expect(taskTitles).toContain('Task 3');
    expect(taskTitles).not.toContain('Task 2');
    expect(taskTitles).not.toContain('Task 4');
  });

  // AC: @meta-ref ac-meta-ref-3
  it('should error when meta_ref does not resolve', () => {
    try {
      const output = kspec('task add --title "Test task" --meta-ref "@invalid-ref-123456"', tempDir);
      // AC-meta-ref-3: Should error with specific message
      expect(output).toContain("meta_ref '@invalid-ref-123456' not found");
    } catch (e: any) {
      const stdout = e.message || '';
      expect(stdout).toContain("meta_ref '@invalid-ref-123456' not found");
    }
  });

  // AC: @meta-ref ac-meta-ref-4
  it('should error when meta_ref points to spec item', () => {
    try {
      // test-feature is a spec item, not a meta item
      const output = kspec('task add --title "Test task" --meta-ref "@test-feature"', tempDir);
      // AC-meta-ref-4: Should error with specific message
      expect(output).toContain("meta_ref '@test-feature' points to a spec item; use --spec-ref for product spec references");
    } catch (e: any) {
      const stdout = e.message || '';
      expect(stdout).toContain("meta_ref '@test-feature' points to a spec item; use --spec-ref for product spec references");
    }
  });

  it('should update task meta_ref with task set', () => {
    // Create task without meta_ref
    const createOutput = kspec('task add --title "Test task"', tempDir);
    const match = createOutput.match(/Created task: ([A-Z0-9]{8})/);
    const taskRef = match![1];

    // Update with meta_ref
    kspec(`task set @${taskRef} --meta-ref "@task-start"`, tempDir);

    // Verify update
    const task = kspecJson<any>(`task get @${taskRef}`, tempDir);
    expect(task.meta_ref).toBe('@task-start');
  });

  it('should validate meta_ref in task set', () => {
    // Create task
    const createOutput = kspec('task add --title "Test task"', tempDir);
    const match = createOutput.match(/Created task: ([A-Z0-9]{8})/);
    const taskRef = match![1];

    // Try to set invalid meta_ref
    try {
      const output = kspec(`task set @${taskRef} --meta-ref "@invalid-workflow"`, tempDir);
      expect(output).toContain("meta_ref '@invalid-workflow' not found");
    } catch (e: any) {
      const stdout = e.message || '';
      expect(stdout).toContain("meta_ref '@invalid-workflow' not found");
    }
  });
});

describe('Integration: meta mutation commands', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  describe('meta add', () => {
    it('should create a new agent with required fields', () => {
      const output = kspec(
        'meta add agent --id new-agent --name "New Agent" --description "A new agent"',
        tempDir
      );

      expect(output).toContain('Created agent: new-agent');
      expect(output).toMatch(/@\w{8}/); // ULID prefix

      // Verify it was created
      const agent = kspecJson<any>('meta get @new-agent', tempDir);
      expect(agent.id).toBe('new-agent');
      expect(agent.name).toBe('New Agent');
      expect(agent.description).toBe('A new agent');
    });

    it('should create agent with capabilities and tools', () => {
      kspec(
        'meta add agent --id capable-agent --name "Capable Agent" --capability code --capability test --tool bash --tool git',
        tempDir
      );

      const agent = kspecJson<any>('meta get @capable-agent', tempDir);
      expect(agent.capabilities).toEqual(['code', 'test']);
      expect(agent.tools).toEqual(['bash', 'git']);
    });

    it('should create a new workflow with required fields', () => {
      const output = kspec(
        'meta add workflow --id new-workflow --trigger "on-commit" --description "A new workflow"',
        tempDir
      );

      expect(output).toContain('Created workflow: new-workflow');

      const workflow = kspecJson<any>('meta get @new-workflow', tempDir);
      expect(workflow.id).toBe('new-workflow');
      expect(workflow.trigger).toBe('on-commit');
      expect(workflow.description).toBe('A new workflow');
      expect(workflow.steps).toEqual([]);
    });

    it('should create a new convention with rules', () => {
      const output = kspec(
        'meta add convention --domain testing --rule "Write tests first" --rule "Use descriptive names"',
        tempDir
      );

      expect(output).toContain('Created convention: testing');

      const convention = kspecJson<any>('meta get @testing', tempDir);
      expect(convention.domain).toBe('testing');
      expect(convention.rules).toEqual(['Write tests first', 'Use descriptive names']);
    });

    it('should fail when required fields are missing', () => {
      try {
        kspec('meta add agent --name "Agent without ID"', tempDir);
        expect.fail('Should have thrown error');
      } catch (e: any) {
        expect(e.message).toContain('Agent requires --id');
      }

      try {
        kspec('meta add workflow --id workflow-no-trigger', tempDir);
        expect.fail('Should have thrown error');
      } catch (e: any) {
        expect(e.message).toContain('Workflow requires --trigger');
      }

      try {
        kspec('meta add convention --rule "Rule without domain"', tempDir);
        expect.fail('Should have thrown error');
      } catch (e: any) {
        expect(e.message).toContain('Convention requires --domain');
      }
    });

    it('should support JSON output', () => {
      const agent = kspecJson<any>(
        'meta add agent --id json-agent --name "JSON Agent"',
        tempDir
      );

      expect(agent.id).toBe('json-agent');
      expect(agent.name).toBe('JSON Agent');
      expect(agent._ulid).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    });
  });

  describe('meta set', () => {
    it('should update agent name and description', () => {
      // Create an agent
      kspec('meta add agent --id update-agent --name "Original Name"', tempDir);

      // Update it
      const output = kspec(
        'meta set @update-agent --name "Updated Name" --description "New description"',
        tempDir
      );

      expect(output).toContain('Updated agent: update-agent');

      const agent = kspecJson<any>('meta get @update-agent', tempDir);
      expect(agent.name).toBe('Updated Name');
      expect(agent.description).toBe('New description');
    });

    it('should add capabilities and tools to agent', () => {
      kspec('meta add agent --id add-agent --name "Add Agent"', tempDir);

      kspec('meta set @add-agent --add-capability code', tempDir);
      kspec('meta set @add-agent --add-capability test', tempDir);
      kspec('meta set @add-agent --add-tool bash', tempDir);

      const agent = kspecJson<any>('meta get @add-agent', tempDir);
      expect(agent.capabilities).toContain('code');
      expect(agent.capabilities).toContain('test');
      expect(agent.tools).toContain('bash');
    });

    it('should not duplicate capabilities or tools', () => {
      kspec(
        'meta add agent --id dup-agent --name "Dup Agent" --capability code --tool bash',
        tempDir
      );

      kspec('meta set @dup-agent --add-capability code --add-tool bash', tempDir);

      const agent = kspecJson<any>('meta get @dup-agent', tempDir);
      expect(agent.capabilities).toEqual(['code']); // Should not duplicate
      expect(agent.tools).toEqual(['bash']);
    });

    it('should update workflow trigger and description', () => {
      kspec('meta add workflow --id update-wf --trigger "old-trigger"', tempDir);

      kspec(
        'meta set @update-wf --trigger "new-trigger" --description "Updated workflow"',
        tempDir
      );

      const workflow = kspecJson<any>('meta get @update-wf', tempDir);
      expect(workflow.trigger).toBe('new-trigger');
      expect(workflow.description).toBe('Updated workflow');
    });

    it('should add rules to convention', () => {
      kspec('meta add convention --domain update-conv --rule "Rule 1"', tempDir);

      kspec('meta set @update-conv --add-rule "Rule 2"', tempDir);

      const convention = kspecJson<any>('meta get @update-conv', tempDir);
      expect(convention.rules).toContain('Rule 1');
      expect(convention.rules).toContain('Rule 2');
    });

    it('should work with ULID prefix references', () => {
      const output = kspec('meta add agent --id ulid-ref --name "ULID Ref Agent"', tempDir);
      const match = output.match(/@(\w{8})/);
      expect(match).toBeTruthy();
      const ulidPrefix = match![1];

      kspec(`meta set @${ulidPrefix} --name "Updated via ULID"`, tempDir);

      const agent = kspecJson<any>('meta get @ulid-ref', tempDir);
      expect(agent.name).toBe('Updated via ULID');
    });

    it('should support JSON output', () => {
      kspec('meta add agent --id json-update --name "JSON Update"', tempDir);

      const agent = kspecJson<any>('meta set @json-update --name "JSON Updated"', tempDir);
      expect(agent.name).toBe('JSON Updated');
    });

    it('should fail for non-existent item', () => {
      try {
        kspec('meta set @nonexistent --name "Should fail"', tempDir);
        expect.fail('Should have thrown error');
      } catch (e: any) {
        expect(e.message).toContain('Meta item not found');
      }
    });
  });

  describe('meta delete', () => {
    it('should delete an agent', () => {
      kspec('meta add agent --id delete-agent --name "Delete Agent"', tempDir);

      const output = kspec('meta delete @delete-agent --confirm', tempDir);
      expect(output).toContain('Deleted agent delete-agent');

      // Verify it's gone
      try {
        kspec('meta get @delete-agent', tempDir);
        expect.fail('Should have thrown error');
      } catch (e: any) {
        expect(e.message).toContain('not found');
      }
    });

    it('should delete a workflow', () => {
      kspec('meta add workflow --id delete-wf --trigger "delete-trigger"', tempDir);

      const output = kspec('meta delete @delete-wf --confirm', tempDir);
      expect(output).toContain('Deleted workflow delete-wf');
    });

    it('should delete a convention', () => {
      kspec('meta add convention --domain delete-conv', tempDir);

      const output = kspec('meta delete @delete-conv --confirm', tempDir);
      expect(output).toContain('Deleted convention delete-conv');
    });

    it('should work with ULID prefix references', () => {
      const output = kspec('meta add agent --id ulid-delete --name "ULID Delete"', tempDir);
      const match = output.match(/@(\w{8})/);
      const ulidPrefix = match![1];

      kspec(`meta delete @${ulidPrefix} --confirm`, tempDir);

      try {
        kspec('meta get @ulid-delete', tempDir);
        expect.fail('Should have thrown error');
      } catch (e: any) {
        expect(e.message).toContain('not found');
      }
    });

    it('should require --confirm flag', () => {
      kspec('meta add agent --id confirm-agent --name "Confirm Agent"', tempDir);

      try {
        kspec('meta delete @confirm-agent', tempDir);
        expect.fail('Should have thrown error');
      } catch (e: any) {
        expect(e.message).toContain('Use --confirm to skip this prompt');
      }

      // Verify it wasn't deleted
      const agent = kspecJson<any>('meta get @confirm-agent', tempDir);
      expect(agent.id).toBe('confirm-agent');
    });

    it('should fail for non-existent item', () => {
      try {
        kspec('meta delete @nonexistent --confirm', tempDir);
        expect.fail('Should have thrown error');
      } catch (e: any) {
        expect(e.message).toContain('Meta item not found');
      }
    });

    it('should prevent deletion of agent referenced by task', () => {
      // Create an agent
      kspec('meta add agent --id ref-agent --name "Referenced Agent"', tempDir);

      // Create a task that references this agent
      kspec('task add --title "Test task" --meta-ref @ref-agent', tempDir);

      // Try to delete the agent without --confirm
      try {
        kspec('meta delete @ref-agent', tempDir);
        expect.fail('Should have prevented deletion');
      } catch (e: any) {
        expect(e.message).toContain('Referenced by');
        expect(e.message).toContain('task(s)');
        expect(e.message).toContain('Use --confirm to override');
      }

      // Verify agent still exists
      const agent = kspecJson<any>('meta get @ref-agent', tempDir);
      expect(agent.id).toBe('ref-agent');

      // Can delete with --confirm flag
      kspec('meta delete @ref-agent --confirm', tempDir);

      // Verify it's deleted
      try {
        kspec('meta get @ref-agent', tempDir);
        expect.fail('Agent should be deleted');
      } catch (e: any) {
        expect(e.message).toContain('Meta item not found');
      }
    });

    it('should prevent deletion of workflow referenced by observation', () => {
      // Create a workflow
      kspec(
        'meta add workflow --id ref-workflow --trigger "test trigger" --description "Test workflow"',
        tempDir
      );

      // Create an observation that references this workflow
      kspec('meta observe friction "Test friction" --workflow @ref-workflow', tempDir);

      // Try to delete the workflow without --confirm
      try {
        kspec('meta delete @ref-workflow', tempDir);
        expect.fail('Should have prevented deletion');
      } catch (e: any) {
        expect(e.message).toContain('Referenced by');
        expect(e.message).toContain('observation(s)');
        expect(e.message).toContain('Use --confirm to override');
      }

      // Verify workflow still exists
      const workflow = kspecJson<any>('meta get @ref-workflow', tempDir);
      expect(workflow.id).toBe('ref-workflow');

      // Can delete with --confirm flag
      kspec('meta delete @ref-workflow --confirm', tempDir);

      // Verify it's deleted
      try {
        kspec('meta get @ref-workflow', tempDir);
        expect.fail('Workflow should be deleted');
      } catch (e: any) {
        expect(e.message).toContain('Meta item not found');
      }
    });

    it('should allow deletion of unreferenced items without --confirm errors about refs', () => {
      // Create an agent that won't be referenced
      kspec('meta add agent --id unreferenced-agent --name "Unreferenced Agent"', tempDir);

      // Try to delete without --confirm - should only complain about confirmation, not refs
      try {
        kspec('meta delete @unreferenced-agent', tempDir);
        expect.fail('Should have required confirmation');
      } catch (e: any) {
        expect(e.message).toContain('Use --confirm to skip this prompt');
        expect(e.message).not.toContain('Referenced by');
      }

      // Delete with --confirm
      kspec('meta delete @unreferenced-agent --confirm', tempDir);
    });

    it('should detect references when deleting by ULID prefix', () => {
      // Create an agent
      const agentOutput = kspec('meta add agent --id ulid-test-agent --name "ULID Test Agent"', tempDir);

      // Extract the ULID prefix from the success message: "Created agent: ulid-test-agent (@01KF7...)"
      const ulidMatch = agentOutput.match(/\((@[\w]+)\)/);
      expect(ulidMatch).toBeTruthy();
      const ulidPrefix = ulidMatch![1];

      // Create a task that references by semantic ID
      kspec('task add --title "Test task" --meta-ref @ulid-test-agent', tempDir);

      // Try to delete using ULID prefix - should still detect the reference
      try {
        kspec(`meta delete ${ulidPrefix}`, tempDir);
        expect.fail('Should have detected reference');
      } catch (e: any) {
        expect(e.message).toContain('Referenced by');
        expect(e.message).toContain('task(s)');
      }

      // Verify agent still exists
      const agent = kspecJson<any>(`meta get ${ulidPrefix}`, tempDir);
      expect(agent.id).toBe('ulid-test-agent');
    });

    it('should detect references with mixed reference formats', () => {
      // Create a workflow
      const workflowOutput = kspec(
        'meta add workflow --id ulid-workflow --trigger "test trigger"',
        tempDir
      );

      // Extract ULID prefix from: "Created workflow: ulid-workflow (@01KF7...)"
      const ulidMatch = workflowOutput.match(/\((@[\w]+)\)/);
      expect(ulidMatch).toBeTruthy();
      const ulidPrefix = ulidMatch![1];

      // Create observation using ULID prefix
      kspec(`meta observe friction "Test friction" --workflow ${ulidPrefix}`, tempDir);

      // Try to delete using semantic ID - should still detect reference
      try {
        kspec('meta delete @ulid-workflow', tempDir);
        expect.fail('Should have detected reference');
      } catch (e: any) {
        expect(e.message).toContain('Referenced by');
        expect(e.message).toContain('observation(s)');
      }

      // Verify workflow still exists
      const workflow = kspecJson<any>('meta get @ulid-workflow', tempDir);
      expect(workflow.id).toBe('ulid-workflow');
    });
  });
});

describe('Integration: meta includes', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('should load meta items from included files', async () => {
    // Create a meta/ directory for included files
    const metaDir = path.join(tempDir, 'meta');
    await fs.mkdir(metaDir, { recursive: true });

    // Create separate files for agents and workflows
    const agentsFile = path.join(metaDir, 'agents.yaml');
    await fs.writeFile(
      agentsFile,
      `agents:
  - _ulid: 01KF8850000000000000000001
    id: include-agent-1
    name: Include Agent 1
    description: Agent from included file
    capabilities:
      - code
    tools:
      - git
    conventions: []

  - _ulid: 01KF8850000000000000000002
    id: include-agent-2
    name: Include Agent 2
    description: Another agent from included file
    capabilities:
      - review
    tools:
      - kspec
    conventions: []
`
    );

    const workflowsFile = path.join(metaDir, 'workflows.yaml');
    await fs.writeFile(
      workflowsFile,
      `workflows:
  - _ulid: 01KF8850000000000000000003
    id: include-workflow-1
    trigger: "Test trigger from include"
    description: Workflow from included file
    steps:
      - type: check
        content: Check something
        on_fail: Do something else
      - type: action
        content: Take an action
`
    );

    // Update the meta manifest to include these files
    const metaPath = path.join(tempDir, 'kynetic.meta.yaml');
    let metaContent = await fs.readFile(metaPath, 'utf-8');

    // Add includes section if not present
    if (!metaContent.includes('includes:')) {
      metaContent += '\nincludes:\n  - meta/agents.yaml\n  - meta/workflows.yaml\n';
    } else {
      metaContent = metaContent.replace(
        'includes:',
        'includes:\n  - meta/agents.yaml\n  - meta/workflows.yaml'
      );
    }

    await fs.writeFile(metaPath, metaContent);

    // Verify agents from included files are loaded
    const agents = kspecJson<any[]>('meta agents', tempDir);
    const includeAgent1 = agents.find(a => a.id === 'include-agent-1');
    const includeAgent2 = agents.find(a => a.id === 'include-agent-2');

    expect(includeAgent1).toBeDefined();
    expect(includeAgent1?.name).toBe('Include Agent 1');
    expect(includeAgent1?.description).toBe('Agent from included file');
    expect(includeAgent1?.capabilities).toEqual(['code']);
    expect(includeAgent1?.tools).toEqual(['git']);

    expect(includeAgent2).toBeDefined();
    expect(includeAgent2?.name).toBe('Include Agent 2');
    expect(includeAgent2?.capabilities).toEqual(['review']);

    // Verify workflows from included files are loaded
    const workflows = kspecJson<any[]>('meta workflows', tempDir);
    const includeWorkflow = workflows.find(w => w.id === 'include-workflow-1');

    expect(includeWorkflow).toBeDefined();
    expect(includeWorkflow?.trigger).toBe('Test trigger from include');
    expect(includeWorkflow?.description).toBe('Workflow from included file');
    expect(includeWorkflow?.steps).toHaveLength(2);
    expect(includeWorkflow?.steps[0].type).toBe('check');
    expect(includeWorkflow?.steps[1].type).toBe('action');
  });

  it('should load meta items from both manifest and includes', async () => {
    // The test fixtures already have agents and workflows in kynetic.meta.yaml
    // We'll add an include file to verify both are loaded

    const metaDir = path.join(tempDir, 'meta');
    await fs.mkdir(metaDir, { recursive: true });

    const conventionsFile = path.join(metaDir, 'conventions.yaml');
    await fs.writeFile(
      conventionsFile,
      `conventions:
  - _ulid: 01KF8850000000000000000010
    domain: testing-include
    rules:
      - Write tests for included items
      - Verify include loading
    examples: []
`
    );

    // Add includes to meta manifest
    const metaPath = path.join(tempDir, 'kynetic.meta.yaml');
    let metaContent = await fs.readFile(metaPath, 'utf-8');
    metaContent += '\nincludes:\n  - meta/conventions.yaml\n';
    await fs.writeFile(metaPath, metaContent);

    // Verify both original agents and included convention are present
    const agents = kspecJson<any[]>('meta agents', tempDir);
    expect(agents.some(a => a.id === 'test-agent')).toBe(true); // From manifest
    expect(agents.some(a => a.id === 'review-agent')).toBe(true); // From manifest

    const conventions = kspecJson<any[]>('meta conventions', tempDir);
    const includeConvention = conventions.find(c => c.domain === 'testing-include');
    expect(includeConvention).toBeDefined();
    expect(includeConvention?.rules).toContain('Write tests for included items');
  });

  it('should handle glob patterns in includes', async () => {
    // Create multiple files matching a pattern
    const metaDir = path.join(tempDir, 'meta');
    await fs.mkdir(metaDir, { recursive: true });

    await fs.writeFile(
      path.join(metaDir, 'agent-1.yaml'),
      `agents:
  - _ulid: 01KF8850000000000000000020
    id: glob-agent-1
    name: Glob Agent 1
    capabilities: []
    tools: []
    conventions: []
`
    );

    await fs.writeFile(
      path.join(metaDir, 'agent-2.yaml'),
      `agents:
  - _ulid: 01KF8850000000000000000021
    id: glob-agent-2
    name: Glob Agent 2
    capabilities: []
    tools: []
    conventions: []
`
    );

    // Update meta manifest to include all agent-*.yaml files
    const metaPath = path.join(tempDir, 'kynetic.meta.yaml');
    let metaContent = await fs.readFile(metaPath, 'utf-8');
    metaContent += '\nincludes:\n  - meta/agent-*.yaml\n';
    await fs.writeFile(metaPath, metaContent);

    // Verify both agents are loaded
    const agents = kspecJson<any[]>('meta agents', tempDir);
    expect(agents.some(a => a.id === 'glob-agent-1')).toBe(true);
    expect(agents.some(a => a.id === 'glob-agent-2')).toBe(true);
  });

  it('should gracefully handle missing include files', async () => {
    // Add an include that doesn't exist
    const metaPath = path.join(tempDir, 'kynetic.meta.yaml');
    let metaContent = await fs.readFile(metaPath, 'utf-8');
    metaContent += '\nincludes:\n  - meta/nonexistent.yaml\n';
    await fs.writeFile(metaPath, metaContent);

    // Should still load successfully without the missing file
    const agents = kspecJson<any[]>('meta agents', tempDir);
    expect(agents.some(a => a.id === 'test-agent')).toBe(true);
  });

  it('should validate references across included files', async () => {
    // Create an included workflow file
    const metaDir = path.join(tempDir, 'meta');
    await fs.mkdir(metaDir, { recursive: true });

    const workflowsFile = path.join(metaDir, 'test-workflows.yaml');
    await fs.writeFile(
      workflowsFile,
      `workflows:
  - _ulid: 01KF8850000000000000000030
    id: include-ref-workflow
    trigger: "Test trigger"
    description: Workflow from include for reference test
    steps:
      - type: action
        content: Do something
`
    );

    // Add includes to meta manifest
    const metaPath = path.join(tempDir, 'kynetic.meta.yaml');
    let metaContent = await fs.readFile(metaPath, 'utf-8');
    metaContent += '\nincludes:\n  - meta/test-workflows.yaml\n';
    await fs.writeFile(metaPath, metaContent);

    // Create a task that references the workflow from the included file
    const tasksPath = path.join(tempDir, 'project.tasks.yaml');
    let tasksContent = await fs.readFile(tasksPath, 'utf-8');

    const newTask = `
  - _ulid: 01KF8850000000000000000031
    title: Test task referencing included workflow
    status: pending
    priority: 1
    created_at: "2024-01-01T00:00:00Z"
    meta_ref: "@include-ref-workflow"
    slugs:
      - test-task-include-ref
    depends_on: []
    notes: []
    todos: []
    blocked_by: []
    tags: []
`;
    tasksContent = tasksContent.replace('tasks:', `tasks:${newTask}`);
    await fs.writeFile(tasksPath, tasksContent);

    // Validate should pass because include-ref-workflow exists in included file
    const output = kspec('validate --refs', tempDir);
    expect(output).toContain('References: OK');
  });
});

// AC: @convention-schema
describe('Integration: conventions', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should list conventions with domain, rules, and validation', async () => {
    // Add test conventions to meta manifest
    const metaPath = path.join(tempDir, 'kynetic.meta.yaml');
    const metaContent = await fs.readFile(metaPath, 'utf-8');

    const conventions = `
conventions:
  - _ulid: 01KF8850000000000000000030
    domain: commits
    rules:
      - Use conventional commit format
      - Reference task in commit body
    examples:
      - good: "feat: add feature"
        bad: "added stuff"
    validation:
      type: regex
      pattern: "^(feat|fix):"
      message: "Must start with feat: or fix:"

  - _ulid: 01KF8850000000000000000031
    domain: notes
    rules:
      - Keep notes concise
      - Document decisions
    examples:
      - good: "Chose approach A because of constraint X"
        bad: "done"
`;

    await fs.writeFile(metaPath, metaContent + conventions);

    // List conventions in JSON format
    const result = kspecJson<Array<{
      domain: string;
      rules: string[];
      examples: Array<{ good: string; bad: string }>;
      validation?: {
        type: string;
        pattern?: string;
        message?: string;
      };
    }>>('meta conventions', tempDir);

    // Verify structure
    expect(result.length).toBeGreaterThanOrEqual(2);

    const commitConvention = result.find(c => c.domain === 'commits');
    expect(commitConvention).toBeDefined();
    expect(commitConvention?.rules).toHaveLength(2);
    expect(commitConvention?.rules[0]).toBe('Use conventional commit format');
    expect(commitConvention?.examples).toHaveLength(1);
    expect(commitConvention?.examples[0].good).toBe('feat: add feature');
    expect(commitConvention?.examples[0].bad).toBe('added stuff');
    expect(commitConvention?.validation?.type).toBe('regex');
    expect(commitConvention?.validation?.pattern).toBe('^(feat|fix):');
    expect(commitConvention?.validation?.message).toBe('Must start with feat: or fix:');

    const noteConvention = result.find(c => c.domain === 'notes');
    expect(noteConvention).toBeDefined();
    expect(noteConvention?.validation).toBeUndefined();
  });

  it('should support all validation types', async () => {
    const metaPath = path.join(tempDir, 'kynetic.meta.yaml');

    const conventions = `
kynetic_meta: "1.0"
conventions:
  - _ulid: 01KF8850000000000000000040
    domain: test-regex
    rules:
      - Rule 1
    validation:
      type: regex
      pattern: "^test:"
      message: "Must match pattern"

  - _ulid: 01KF8850000000000000000041
    domain: test-enum
    rules:
      - Rule 2
    validation:
      type: enum
      allowed:
        - value1
        - value2

  - _ulid: 01KF8850000000000000000042
    domain: test-range
    rules:
      - Rule 3
    validation:
      type: range
      min: 10
      max: 100
      unit: words

  - _ulid: 01KF8850000000000000000043
    domain: test-prose
    rules:
      - Rule 4
    validation:
      type: prose
`;

    await fs.writeFile(metaPath, conventions);

    const result = kspecJson<Array<{
      domain: string;
      validation?: {
        type: string;
        pattern?: string;
        allowed?: string[];
        min?: number;
        max?: number;
        unit?: string;
      };
    }>>('meta conventions', tempDir);

    expect(result.length).toBe(4);

    const regexConv = result.find(c => c.domain === 'test-regex');
    expect(regexConv?.validation?.type).toBe('regex');
    expect(regexConv?.validation?.pattern).toBe('^test:');

    const enumConv = result.find(c => c.domain === 'test-enum');
    expect(enumConv?.validation?.type).toBe('enum');
    expect(enumConv?.validation?.allowed).toEqual(['value1', 'value2']);

    const rangeConv = result.find(c => c.domain === 'test-range');
    expect(rangeConv?.validation?.type).toBe('range');
    expect(rangeConv?.validation?.min).toBe(10);
    expect(rangeConv?.validation?.max).toBe(100);
    expect(rangeConv?.validation?.unit).toBe('words');

    const proseConv = result.find(c => c.domain === 'test-prose');
    expect(proseConv?.validation?.type).toBe('prose');
  });

  it('should validate convention schema with required fields', async () => {
    const metaPath = path.join(tempDir, 'kynetic.meta.yaml');

    // Missing domain should fail
    const invalidConvention = `
kynetic_meta: "1.0"
conventions:
  - _ulid: 01KF8850000000000000000050
    rules:
      - Some rule
`;

    await fs.writeFile(metaPath, invalidConvention);

    // This should fail validation
    try {
      kspec('validate --schema', tempDir);
      expect(true).toBe(false); // Should not reach here
    } catch (error) {
      // Expected to fail
      expect(error).toBeDefined();
    }
  });
});

describe('Integration: meta focus', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @meta-focus-cmd ac-focus-1
  it('should show no focus when none is set', () => {
    const output = kspec('meta focus', tempDir);
    expect(output).toContain('No focus set');
  });

  // AC: @meta-focus-cmd ac-focus-2
  it('should set focus to a reference', () => {
    const output = kspec('meta focus test-feature', tempDir);
    expect(output).toMatch(/Set focus to: @test-feature/);
  });

  // AC: @meta-focus-cmd ac-focus-1
  it('should show current focus', () => {
    kspec('meta focus test-feature', tempDir);
    const output = kspec('meta focus', tempDir);
    expect(output).toContain('Current focus: @test-feature');
  });

  // AC: @meta-focus-cmd ac-focus-2
  it('should auto-prepend @ to references', () => {
    kspec('meta focus test-item', tempDir);
    const focusData = kspecJson<{ focus: string }>('meta focus', tempDir);
    expect(focusData.focus).toBe('@test-item');
  });

  // AC: @meta-focus-cmd ac-focus-3
  it('should clear focus', () => {
    kspec('meta focus test-feature', tempDir);
    const output = kspec('meta focus --clear', tempDir);
    expect(output).toContain('Cleared session focus');

    const focusData = kspecJson<{ focus: null }>('meta focus', tempDir);
    expect(focusData.focus).toBeNull();
  });

  // AC: @meta-focus-cmd ac-focus-1, ac-focus-2, ac-focus-3
  it('should support JSON output mode', () => {
    // No focus set
    const noFocus = kspecJson<{ focus: null }>('meta focus', tempDir);
    expect(noFocus.focus).toBeNull();

    // Set focus
    const setFocus = kspecJson<{ focus: string }>('meta focus test-feature', tempDir);
    expect(setFocus.focus).toBe('@test-feature');

    // Show focus
    const showFocus = kspecJson<{ focus: string }>('meta focus', tempDir);
    expect(showFocus.focus).toBe('@test-feature');

    // Clear focus
    const clearFocus = kspecJson<{ focus: null }>('meta focus --clear', tempDir);
    expect(clearFocus.focus).toBeNull();
  });

  it('should persist focus across command invocations', () => {
    kspec('meta focus test-feature', tempDir);

    // Run a different command
    kspec('tasks ready', tempDir);

    // Focus should still be set
    const focusData = kspecJson<{ focus: string }>('meta focus', tempDir);
    expect(focusData.focus).toBe('@test-feature');
  });

  it('should display focus in session start output', () => {
    kspec('meta focus test-feature', tempDir);
    const sessionOutput = kspec('session start', tempDir);
    expect(sessionOutput).toContain('Focus: @test-feature');
  });
});

describe('Integration: meta thread', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @meta-thread-cmd - list action
  it('should show no threads when none exist', () => {
    const output = kspec('meta thread list', tempDir);
    expect(output).toContain('No active threads');
  });

  // AC: @meta-thread-cmd - add action
  it('should add a thread', () => {
    const output = kspec('meta thread add "Implement feature X"', tempDir);
    expect(output).toContain('Added thread: Implement feature X');
  });

  // AC: @meta-thread-cmd - list action
  it('should list all threads', () => {
    kspec('meta thread add "Thread 1"', tempDir);
    kspec('meta thread add "Thread 2"', tempDir);
    kspec('meta thread add "Thread 3"', tempDir);

    const output = kspec('meta thread list', tempDir);
    expect(output).toContain('Active threads:');
    expect(output).toContain('1. Thread 1');
    expect(output).toContain('2. Thread 2');
    expect(output).toContain('3. Thread 3');
  });

  // AC: @meta-thread-cmd - remove action
  it('should remove a thread by index', () => {
    kspec('meta thread add "Thread 1"', tempDir);
    kspec('meta thread add "Thread 2"', tempDir);
    kspec('meta thread add "Thread 3"', tempDir);

    const output = kspec('meta thread remove 2', tempDir);
    expect(output).toContain('Removed thread: Thread 2');

    const listOutput = kspec('meta thread list', tempDir);
    expect(listOutput).toContain('Thread 1');
    expect(listOutput).not.toContain('Thread 2');
    expect(listOutput).toContain('Thread 3');
  });

  // AC: @meta-thread-cmd - clear action
  it('should clear all threads', () => {
    kspec('meta thread add "Thread 1"', tempDir);
    kspec('meta thread add "Thread 2"', tempDir);

    const output = kspec('meta thread clear', tempDir);
    expect(output).toContain('Cleared all threads');

    const listOutput = kspec('meta thread list', tempDir);
    expect(listOutput).toContain('No active threads');
  });

  // AC: @meta-thread-cmd - JSON output
  it('should support JSON output for list', () => {
    kspec('meta thread add "Thread 1"', tempDir);
    kspec('meta thread add "Thread 2"', tempDir);

    const data = kspecJson<{ threads: string[] }>('meta thread list', tempDir);
    expect(data.threads).toEqual(['Thread 1', 'Thread 2']);
  });

  // AC: @meta-thread-cmd - JSON output
  it('should support JSON output for add', () => {
    const data = kspecJson<{ threads: string[]; added: string }>(
      'meta thread add "New thread"',
      tempDir
    );
    expect(data.added).toBe('New thread');
    expect(data.threads).toContain('New thread');
  });

  // AC: @meta-thread-cmd - JSON output
  it('should support JSON output for remove', () => {
    kspec('meta thread add "Thread 1"', tempDir);
    kspec('meta thread add "Thread 2"', tempDir);

    const data = kspecJson<{ threads: string[]; removed: string }>(
      'meta thread remove 1',
      tempDir
    );
    expect(data.removed).toBe('Thread 1');
    expect(data.threads).toEqual(['Thread 2']);
  });

  // AC: @meta-thread-cmd - JSON output
  it('should support JSON output for clear', () => {
    kspec('meta thread add "Thread 1"', tempDir);

    const data = kspecJson<{ threads: string[] }>('meta thread clear', tempDir);
    expect(data.threads).toEqual([]);
  });

  it('should persist threads across command invocations', () => {
    kspec('meta thread add "Thread 1"', tempDir);

    // Run a different command
    kspec('tasks ready', tempDir);

    // Threads should still be set
    const data = kspecJson<{ threads: string[] }>('meta thread list', tempDir);
    expect(data.threads).toEqual(['Thread 1']);
  });

  it('should error when adding without text', () => {
    try {
      kspec('meta thread add', tempDir);
      expect.fail('Should have thrown error');
    } catch (e: any) {
      expect(e.message).toContain('Thread text is required');
    }
  });

  it('should error when removing without index', () => {
    kspec('meta thread add "Thread 1"', tempDir);

    try {
      kspec('meta thread remove', tempDir);
      expect.fail('Should have thrown error');
    } catch (e: any) {
      expect(e.message).toContain('Index is required');
    }
  });

  it('should error when removing invalid index', () => {
    kspec('meta thread add "Thread 1"', tempDir);

    try {
      kspec('meta thread remove 5', tempDir);
      expect.fail('Should have thrown error');
    } catch (e: any) {
      expect(e.message).toContain('Invalid index');
    }
  });

  it('should error on unknown action', () => {
    try {
      kspec('meta thread unknown', tempDir);
      expect.fail('Should have thrown error');
    } catch (e: any) {
      expect(e.message).toContain('Unknown action');
    }
  });
});

describe('Integration: meta question', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @meta-question-cmd - list action
  it('should show no questions when none exist', () => {
    const output = kspec('meta question list', tempDir);
    expect(output).toContain('No open questions');
  });

  // AC: @meta-question-cmd - add action
  it('should add a question', () => {
    const output = kspec('meta question add "Why does X happen?"', tempDir);
    expect(output).toContain('Added question: Why does X happen?');
  });

  // AC: @meta-question-cmd - list action
  it('should list all questions', () => {
    kspec('meta question add "Question 1"', tempDir);
    kspec('meta question add "Question 2"', tempDir);
    kspec('meta question add "Question 3"', tempDir);

    const output = kspec('meta question list', tempDir);
    expect(output).toContain('Open questions:');
    expect(output).toContain('1. Question 1');
    expect(output).toContain('2. Question 2');
    expect(output).toContain('3. Question 3');
  });

  // AC: @meta-question-cmd - remove action
  it('should remove a question by index', () => {
    kspec('meta question add "Question 1"', tempDir);
    kspec('meta question add "Question 2"', tempDir);
    kspec('meta question add "Question 3"', tempDir);

    const output = kspec('meta question remove 2', tempDir);
    expect(output).toContain('Removed question: Question 2');

    const listOutput = kspec('meta question list', tempDir);
    expect(listOutput).toContain('Question 1');
    expect(listOutput).not.toContain('Question 2');
    expect(listOutput).toContain('Question 3');
  });

  // AC: @meta-question-cmd - clear action
  it('should clear all questions', () => {
    kspec('meta question add "Question 1"', tempDir);
    kspec('meta question add "Question 2"', tempDir);

    const output = kspec('meta question clear', tempDir);
    expect(output).toContain('Cleared all questions');

    const listOutput = kspec('meta question list', tempDir);
    expect(listOutput).toContain('No open questions');
  });

  // AC: @meta-question-cmd - JSON output
  it('should support JSON output for list', () => {
    kspec('meta question add "Question 1"', tempDir);
    kspec('meta question add "Question 2"', tempDir);

    const data = kspecJson<{ questions: string[] }>('meta question list', tempDir);
    expect(data.questions).toEqual(['Question 1', 'Question 2']);
  });

  // AC: @meta-question-cmd - JSON output
  it('should support JSON output for add', () => {
    const data = kspecJson<{ questions: string[]; added: string }>(
      'meta question add "New question"',
      tempDir
    );
    expect(data.added).toBe('New question');
    expect(data.questions).toContain('New question');
  });

  // AC: @meta-question-cmd - JSON output
  it('should support JSON output for remove', () => {
    kspec('meta question add "Question 1"', tempDir);
    kspec('meta question add "Question 2"', tempDir);

    const data = kspecJson<{ questions: string[]; removed: string }>(
      'meta question remove 1',
      tempDir
    );
    expect(data.removed).toBe('Question 1');
    expect(data.questions).toEqual(['Question 2']);
  });

  // AC: @meta-question-cmd - JSON output
  it('should support JSON output for clear', () => {
    kspec('meta question add "Question 1"', tempDir);

    const data = kspecJson<{ questions: string[] }>('meta question clear', tempDir);
    expect(data.questions).toEqual([]);
  });

  it('should persist questions across command invocations', () => {
    kspec('meta question add "Question 1"', tempDir);

    // Run a different command
    kspec('tasks ready', tempDir);

    // Questions should still be set
    const data = kspecJson<{ questions: string[] }>('meta question list', tempDir);
    expect(data.questions).toEqual(['Question 1']);
  });

  it('should error when adding without text', () => {
    try {
      kspec('meta question add', tempDir);
      expect.fail('Should have thrown error');
    } catch (e: any) {
      expect(e.message).toContain('Question text is required');
    }
  });

  it('should error when removing without index', () => {
    kspec('meta question add "Question 1"', tempDir);

    try {
      kspec('meta question remove', tempDir);
      expect.fail('Should have thrown error');
    } catch (e: any) {
      expect(e.message).toContain('Index is required');
    }
  });

  it('should error when removing invalid index', () => {
    kspec('meta question add "Question 1"', tempDir);

    try {
      kspec('meta question remove 5', tempDir);
      expect.fail('Should have thrown error');
    } catch (e: any) {
      expect(e.message).toContain('Invalid index');
    }
  });

  it('should error on unknown action', () => {
    try {
      kspec('meta question unknown', tempDir);
      expect.fail('Should have thrown error');
    } catch (e: any) {
      expect(e.message).toContain('Unknown action');
    }
  });
});

describe('Integration: meta context', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @meta-context-cmd - show full session context
  it('should display full session context with all fields', () => {
    // Set up some context
    kspec('meta focus @task-test', tempDir);
    kspec('meta thread add "Thread 1"', tempDir);
    kspec('meta thread add "Thread 2"', tempDir);
    kspec('meta question add "Question 1"', tempDir);

    const output = kspec('meta context', tempDir);

    // Should contain headers
    expect(output).toContain('Session Context');
    expect(output).toContain('Focus:');
    expect(output).toContain('Active Threads:');
    expect(output).toContain('Open Questions:');
    expect(output).toContain('Last Updated:');

    // Should contain the data
    expect(output).toContain('@task-test');
    expect(output).toContain('Thread 1');
    expect(output).toContain('Thread 2');
    expect(output).toContain('Question 1');
  });

  // AC: @meta-context-cmd - show empty context gracefully
  it('should show (none) for empty context fields', () => {
    const output = kspec('meta context', tempDir);

    // Should show (none) for empty fields
    expect(output).toContain('(none)');
    expect(output).toContain('Focus:');
    expect(output).toContain('Active Threads:');
    expect(output).toContain('Open Questions:');
  });

  // AC: @meta-context-cmd - JSON output
  it('should output JSON with all context fields', () => {
    // Set up some context
    kspec('meta focus @task-test', tempDir);
    kspec('meta thread add "Thread 1"', tempDir);
    kspec('meta question add "Question 1"', tempDir);

    interface ContextJson {
      focus: string | null;
      threads: string[];
      open_questions: string[];
      updated_at: string;
    }

    const data = kspecJson<ContextJson>('meta context', tempDir);

    expect(data.focus).toBe('@task-test');
    expect(data.threads).toEqual(['Thread 1']);
    expect(data.open_questions).toEqual(['Question 1']);
    expect(data.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  // AC: @meta-context-cmd - --clear option
  it('should clear all session context with --clear flag', () => {
    // Set up some context
    kspec('meta focus @task-test', tempDir);
    kspec('meta thread add "Thread 1"', tempDir);
    kspec('meta question add "Question 1"', tempDir);

    // Clear all context
    const output = kspec('meta context --clear', tempDir);
    expect(output).toContain('Cleared all session context');

    // Verify everything is cleared
    interface ContextJson {
      focus: string | null;
      threads: string[];
      open_questions: string[];
      updated_at: string;
    }

    const data = kspecJson<ContextJson>('meta context', tempDir);
    expect(data.focus).toBeNull();
    expect(data.threads).toEqual([]);
    expect(data.open_questions).toEqual([]);
  });

  // AC: @meta-context-cmd - --clear with JSON output
  it('should output cleared context in JSON mode', () => {
    // Set up some context
    kspec('meta focus @task-test', tempDir);
    kspec('meta thread add "Thread 1"', tempDir);

    interface ContextJson {
      focus: string | null;
      threads: string[];
      open_questions: string[];
      updated_at: string;
    }

    const data = kspecJson<ContextJson>('meta context --clear', tempDir);

    expect(data.focus).toBeNull();
    expect(data.threads).toEqual([]);
    expect(data.open_questions).toEqual([]);
    expect(data.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  // AC: @meta-context-cmd - display with numbered lists
  it('should display threads and questions with numbered lists', () => {
    kspec('meta thread add "First thread"', tempDir);
    kspec('meta thread add "Second thread"', tempDir);
    kspec('meta thread add "Third thread"', tempDir);
    kspec('meta question add "First question"', tempDir);
    kspec('meta question add "Second question"', tempDir);

    const output = kspec('meta context', tempDir);

    // Should have numbered lists
    expect(output).toContain('1. First thread');
    expect(output).toContain('2. Second thread');
    expect(output).toContain('3. Third thread');
    expect(output).toContain('1. First question');
    expect(output).toContain('2. Second question');
  });
});
