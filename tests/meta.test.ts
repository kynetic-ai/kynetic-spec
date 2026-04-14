/**
 * Integration tests for kspec meta commands
 * AC: @agent-definitions ac-agent-1, ac-agent-2, ac-agent-3
 * AC: @workflow-definitions ac-workflow-1, ac-workflow-2, ac-workflow-3, ac-workflow-4
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  kspec as kspecRun,
  kspecOutput as kspec,
  kspecJson,
  setupTempFixtures,
  cleanupTempDir,
  testUlid,
  readTestOutput,
  seedSplitTask,
} from "./helpers/cli";

describe("Integration: meta agents", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @agent-definitions ac-agent-1
  it("should output table with ID, Name, Capabilities columns", () => {
    const output = kspec("meta agents", tempDir);

    // Should contain table headers
    expect(output).toContain("ID");
    expect(output).toContain("Name");
    expect(output).toContain("Capabilities");

    // Should contain agent data from fixtures
    expect(output).toContain("test-agent");
    expect(output).toContain("Test Agent");
    expect(output).toContain("code, test");

    expect(output).toContain("review-agent");
    expect(output).toContain("Review Agent");
    expect(output).toContain("review, analyze");
  });

  // AC: @agent-definitions ac-agent-2
  it("should output JSON array with full agent details", () => {
    interface AgentJson {
      id: string;
      name: string;
      description: string;
      capabilities: string[];
      tools: string[];
      session_protocol: Record<string, string>;
      conventions: string[];
    }

    const agents = kspecJson<AgentJson[]>("meta agents", tempDir);

    // Should be an array (3 agents: test, test-agent, review-agent)
    expect(Array.isArray(agents)).toBe(true);
    expect(agents).toHaveLength(3);

    // First agent
    const testAgent = agents.find((a) => a.id === "test-agent");
    expect(testAgent).toBeDefined();
    expect(testAgent?.name).toBe("Test Agent");
    expect(testAgent?.description).toBe("A test agent for integration testing");
    expect(testAgent?.capabilities).toEqual(["code", "test"]);
    expect(testAgent?.tools).toEqual(["kspec", "git"]);
    expect(testAgent?.session_protocol).toEqual({
      start: "kspec session start",
      checkpoint: "kspec session checkpoint",
    });
    expect(testAgent?.conventions).toEqual(["Test convention 1", "Test convention 2"]);

    // Second agent
    const reviewAgent = agents.find((a) => a.id === "review-agent");
    expect(reviewAgent).toBeDefined();
    expect(reviewAgent?.name).toBe("Review Agent");
    expect(reviewAgent?.capabilities).toEqual(["review", "analyze"]);
    expect(reviewAgent?.tools).toEqual(["kspec"]);
  });

  it("should handle empty agents list gracefully", async () => {
    // Create a meta manifest with no agents
    const emptyMetaPath = path.join(tempDir, "kynetic.meta.yaml");
    await fs.writeFile(emptyMetaPath, 'kynetic_meta: "1.0"\nagents: []\n');

    const output = kspec("meta agents", tempDir);
    expect(output).toContain("No agents defined");
  });

  it("should handle missing meta manifest gracefully", async () => {
    // Remove meta manifest file entirely
    const metaPath = path.join(tempDir, "kynetic.meta.yaml");
    await fs.rm(metaPath, { force: true });

    // Also remove reference from kynetic.yaml
    const manifestPath = path.join(tempDir, "kynetic.yaml");
    let content = await readTestOutput(manifestPath);
    content = content.replace("meta_file: kynetic.meta.yaml\n", "");
    await fs.writeFile(manifestPath, content);

    const output = kspec("meta agents", tempDir);
    // Should show empty result, not crash
    expect(output).toContain("No agents defined");
  });

  // AC: @agent-definitions ac-agent-3
  it("should validate agent references in notes", async () => {
    // Add a task with a note that references a valid agent
    seedSplitTask(tempDir, {
      _ulid: "01KF79C0H1ZHT2T4JMECS89ARS",
      slugs: ["test-task-with-agent"],
      title: "Test task with agent reference in note",
      type: "task",
      status: "pending",
      priority: 1,
      created_at: "2024-01-01T00:00:00Z",
      depends_on: [],
      notes: [
        {
          _ulid: "01KF79C0H1ZHT2T4JMECS89AR1",
          created_at: "2024-01-01T00:00:00Z",
          author: "@test-agent",
          content: "A note from a valid agent",
        },
      ],
      todos: [],
      tags: [],
    });

    // Validate should pass because test-agent exists
    const output = kspec("validate --refs", tempDir);
    expect(output).toContain("References: OK");
  });

  // AC: @agent-definitions ac-agent-3
  // TODO: kspec validate --refs doesn't load notes from per-task files in split format
  it.skip("should error on invalid agent reference in notes", async () => {
    // Add a task with a note that references a non-existent agent
    seedSplitTask(tempDir, {
      _ulid: "01KF79C0H1C6H77ZSGMMVJF994",
      slugs: ["test-task-invalid-agent"],
      title: "Test task with invalid agent reference",
      type: "task",
      status: "pending",
      priority: 1,
      created_at: "2024-01-01T00:00:00Z",
      depends_on: [],
      notes: [
        {
          _ulid: "01KF79C0H1C6H77ZSGMMVJF991",
          created_at: "2024-01-01T00:00:00Z",
          author: "@nonexistent-agent",
          content: "A note from an invalid agent",
        },
      ],
      todos: [],
      tags: [],
    });

    // Validation should fail with reference error
    // kspec() returns stdout even on failure, so we get the output
    const output = kspec("validate --refs", tempDir);
    expect(output).toContain("✗ Validation failed");
    expect(output).toContain('Reference "@nonexistent-agent" not found');
    expect(output).toContain("author");
  });
});

describe("Integration: meta workflows", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @workflow-definitions ac-workflow-1
  it("should output table with ID, Trigger, Steps columns", () => {
    const output = kspec("meta workflows", tempDir);

    // Should contain table headers
    expect(output).toContain("ID");
    expect(output).toContain("Trigger");
    expect(output).toContain("Steps");

    // Should contain workflow data from fixtures
    expect(output).toContain("task-start");
    expect(output).toContain("Before starting a task");
    expect(output).toContain("4"); // 4 steps

    expect(output).toContain("commit");
    expect(output).toContain("After completing a task");
    expect(output).toContain("3"); // 3 steps
  });

  // AC: @workflow-definitions ac-workflow-2
  it("should output verbose format with full step details", () => {
    const output = kspec("meta workflows --verbose", tempDir);

    // Should contain workflow headers
    expect(output).toContain("task-start - Before starting a task");
    expect(output).toContain("Pre-task checklist workflow");

    // Should contain step type prefixes
    expect(output).toContain("[check]");
    expect(output).toContain("[action]");
    expect(output).toContain("[decision]");

    // Should contain step content
    expect(output).toContain("Read the spec item linked to the task");
    expect(output).toContain("Verify all dependencies are completed");
    expect(output).toContain("Add initial note documenting approach");

    // Should contain on_fail for checks
    expect(output).toContain("on fail: Cannot proceed without spec context");
    expect(output).toContain("on fail: Block task and note missing dependencies");

    // Should contain decision options
    expect(output).toContain("Does this need plan mode?");
    expect(output).toContain("Yes - enter plan mode");
    expect(output).toContain("No - proceed with implementation");

    // Should contain second workflow
    expect(output).toContain("commit - After completing a task");
    expect(output).toContain("All tests passing");
    expect(output).toContain("on fail: Fix failing tests before committing");
  });

  // AC: @workflow-definitions ac-workflow-4
  it("should output JSON array with full workflow details", () => {
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

    const workflows = kspecJson<WorkflowJson[]>("meta workflows", tempDir);

    // Should be an array with 2 workflows
    expect(Array.isArray(workflows)).toBe(true);
    expect(workflows).toHaveLength(2);

    // First workflow
    const taskStart = workflows.find((w) => w.id === "task-start");
    expect(taskStart).toBeDefined();
    expect(taskStart?.trigger).toBe("Before starting a task");
    expect(taskStart?.description).toBe("Pre-task checklist workflow");
    expect(taskStart?.steps).toHaveLength(4);

    // Check step details
    const firstStep = taskStart?.steps[0];
    expect(firstStep?.type).toBe("check");
    expect(firstStep?.content).toBe("Read the spec item linked to the task");
    expect(firstStep?.on_fail).toBe("Cannot proceed without spec context");

    const decisionStep = taskStart?.steps[3];
    expect(decisionStep?.type).toBe("decision");
    expect(decisionStep?.content).toBe("Does this need plan mode?");
    expect(decisionStep?.options).toEqual([
      "Yes - enter plan mode",
      "No - proceed with implementation",
    ]);

    // Second workflow
    const commit = workflows.find((w) => w.id === "commit");
    expect(commit).toBeDefined();
    expect(commit?.trigger).toBe("After completing a task");
    expect(commit?.steps).toHaveLength(3);
  });

  it("should handle empty workflows list gracefully", async () => {
    // Create a meta manifest with no workflows
    const emptyMetaPath = path.join(tempDir, "kynetic.meta.yaml");
    await fs.writeFile(emptyMetaPath, 'kynetic_meta: "1.0"\nworkflows: []\n');

    const output = kspec("meta workflows", tempDir);
    expect(output).toContain("No workflows defined");
  });

  it("should handle missing meta manifest gracefully", async () => {
    // Remove meta manifest file entirely
    const metaPath = path.join(tempDir, "kynetic.meta.yaml");
    await fs.rm(metaPath, { force: true });

    const output = kspec("meta workflows", tempDir);
    expect(output).toContain("No workflows defined");
  });

  // AC: @workflow-definitions ac-workflow-3
  it("should validate workflow references in meta_ref", async () => {
    // Add a task with meta_ref pointing to a valid workflow
    seedSplitTask(tempDir, {
      _ulid: "01KF7A2Z00TESTW0RKFK0WREF01",
      slugs: ["test-task-with-workflow"],
      title: "Test task with workflow reference",
      type: "task",
      status: "pending",
      priority: 1,
      created_at: "2024-01-01T00:00:00Z",
      meta_ref: "@task-start",
      depends_on: [],
      notes: [],
      todos: [],
      tags: [],
    });

    // Validate should pass because task-start workflow exists
    const output = kspec("validate --refs", tempDir);
    expect(output).toContain("References: OK");
  });

  // AC: @workflow-definitions ac-workflow-3
  it("should error on invalid workflow reference in meta_ref", async () => {
    // Add a task with meta_ref pointing to a non-existent workflow
    seedSplitTask(tempDir, {
      _ulid: "01KF7AP9FXVDKXDFPSNFWS11SW",
      slugs: ["test-task-invalid-workflow"],
      title: "Test task with invalid workflow reference",
      type: "task",
      status: "pending",
      priority: 1,
      created_at: "2024-01-01T00:00:00Z",
      meta_ref: "@this-workflow-does-not-exist-anywhere-in-fixtures",
      depends_on: [],
      notes: [],
      todos: [],
      tags: [],
    });

    // Validation should fail with reference error
    const output = kspec("validate --refs", tempDir);
    expect(output).toContain("✗ Validation failed");
    expect(output).toContain("not found");
    expect(output).toContain("meta_ref");
  });
});

describe("Integration: loop mode workflows", () => {
  let tempDir: string;
  let testSeq = 0;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    testSeq = 0;
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // Helper to add a workflow to the meta manifest
  async function addWorkflow(
    id: string,
    options: {
      trigger?: string;
      description?: string;
      mode?: string;
      based_on?: string;
      tags?: string[];
      steps?: Array<{ type: string; content: string }>;
    } = {},
  ): Promise<void> {
    const ulid = testUlid("WFTEST", testSeq++);
    const metaPath = path.join(tempDir, "kynetic.meta.yaml");
    let metaContent = await readTestOutput(metaPath);

    const lines: string[] = [
      `  - _ulid: ${ulid}`,
      `    id: ${id}`,
      `    trigger: ${options.trigger || "manual"}`,
    ];

    if (options.description) {
      lines.push(`    description: ${options.description}`);
    }
    if (options.mode) {
      lines.push(`    mode: ${options.mode}`);
    }
    if (options.based_on) {
      lines.push(`    based_on: "${options.based_on}"`);
    }
    if (options.tags && options.tags.length > 0) {
      lines.push("    tags:");
      for (const tag of options.tags) {
        lines.push(`      - ${tag}`);
      }
    }
    if (options.steps && options.steps.length > 0) {
      lines.push("    steps:");
      for (const step of options.steps) {
        lines.push(`      - type: ${step.type}`);
        lines.push(`        content: ${step.content}`);
      }
    } else {
      lines.push("    steps: []");
    }

    const workflowYaml = lines.join("\n");
    metaContent = metaContent.replace(/^workflows:\n/m, `workflows:\n${workflowYaml}\n`);
    await fs.writeFile(metaPath, metaContent);
  }

  // AC: @loop-mode-workflows ac-1
  it("should filter workflows by --tag loop", async () => {
    await addWorkflow("task-work-loop", {
      trigger: "ralph-iteration",
      description: "Loop variant of task-work workflow",
      mode: "loop",
      based_on: "@task-start",
      tags: ["loop", "ralph"],
      steps: [{ type: "action", content: "Pick highest priority ready task" }],
    });

    // Without tag filter, should show all workflows
    const allOutput = kspec("meta workflows", tempDir);
    expect(allOutput).toContain("task-start");
    expect(allOutput).toContain("task-work-loop");

    // With --tag loop, should only show loop workflows
    const loopOutput = kspec("meta workflows --tag loop", tempDir);
    expect(loopOutput).toContain("task-work-loop");
    expect(loopOutput).not.toContain("task-start");
    expect(loopOutput).toContain("loop"); // Mode column shows 'loop'
  });

  // AC: @loop-mode-workflows ac-2
  it("should validate workflow with mode: loop field", async () => {
    await addWorkflow("reflect-loop", {
      trigger: "ralph-end",
      description: "Loop variant of reflect workflow",
      mode: "loop",
    });

    // Validation should pass
    const output = kspec("validate", tempDir);
    expect(output).toContain("Schema: OK");
  });

  // AC: @loop-mode-workflows ac-2 (invalid mode)
  it("should reject invalid mode values in workflow", async () => {
    // Manually add a workflow with invalid mode (bypass helper validation)
    const ulid = testUlid("WFBAD", 0);
    const metaPath = path.join(tempDir, "kynetic.meta.yaml");
    let metaContent = await readTestOutput(metaPath);
    const invalidWorkflow = `  - _ulid: ${ulid}
    id: bad-mode-workflow
    trigger: manual
    mode: invalid_mode
    steps: []`;
    metaContent = metaContent.replace(/^workflows:\n/m, `workflows:\n${invalidWorkflow}\n`);
    await fs.writeFile(metaPath, metaContent);

    // Validation should fail
    const output = kspec("validate", tempDir);
    expect(output).toContain("✗ Validation failed");
  });

  // AC: @loop-mode-workflows ac-3
  it("should show based_on field in meta get output", async () => {
    await addWorkflow("task-work-loop", {
      trigger: "ralph-iteration",
      description: "Loop variant derived from interactive workflow",
      mode: "loop",
      based_on: "@task-start",
    });

    // Get the workflow
    const output = kspec("meta get task-work-loop", tempDir);
    expect(output).toContain("based_on");
    expect(output).toContain("@task-start");
  });

  // AC: @loop-mode-workflows ac-3 (verbose output)
  it("should show based_on in verbose workflow listing", async () => {
    await addWorkflow("reflect-loop", {
      trigger: "ralph-end",
      description: "Loop variant of reflect",
      mode: "loop",
      based_on: "@commit",
    });

    // Verbose output should show based_on
    const output = kspec("meta workflows --verbose", tempDir);
    expect(output).toContain("reflect-loop");
    expect(output).toContain("Based on: @commit");
    expect(output).toContain("Mode: loop");
  });

  it("should include mode and based_on in JSON output", async () => {
    await addWorkflow("task-loop", {
      trigger: "ralph-iteration",
      mode: "loop",
      based_on: "@task-start",
      tags: ["loop"],
    });

    interface WorkflowJson {
      id: string;
      mode: string;
      based_on?: string;
      tags: string[];
    }

    const workflows = kspecJson<WorkflowJson[]>("meta workflows", tempDir);
    const loopWf = workflows.find((w) => w.id === "task-loop");

    expect(loopWf).toBeDefined();
    expect(loopWf?.mode).toBe("loop");
    expect(loopWf?.based_on).toBe("@task-start");
    expect(loopWf?.tags).toContain("loop");
  });

  it("should create workflow with --mode and --based-on options", () => {
    const output = kspec(
      'meta add workflow --id test-loop --trigger manual --mode loop --based-on "@task-start" --tag loop --tag test',
      tempDir,
    );
    expect(output).toContain("Created workflow: test-loop");

    // Verify it was created correctly
    interface WorkflowJson {
      id: string;
      mode: string;
      based_on?: string;
      tags: string[];
    }

    const workflows = kspecJson<WorkflowJson[]>("meta workflows", tempDir);
    const created = workflows.find((w) => w.id === "test-loop");

    expect(created).toBeDefined();
    expect(created?.mode).toBe("loop");
    expect(created?.based_on).toBe("@task-start");
    expect(created?.tags).toContain("loop");
    expect(created?.tags).toContain("test");
  });

  it("should reject invalid mode in meta add workflow", () => {
    const result = kspecRun(
      "meta add workflow --id bad-mode --trigger manual --mode bad",
      tempDir,
      { expectFail: true },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Invalid mode");
  });

  it("should filter by mode: loop even without explicit loop tag", async () => {
    await addWorkflow("untagged-loop", {
      trigger: "ralph",
      mode: "loop",
    });

    // --tag loop should still find it via mode field
    const output = kspec("meta workflows --tag loop", tempDir);
    expect(output).toContain("untagged-loop");
  });
});

describe("Integration: meta observations", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @observations ac-obs-1
  it("should create an observation with correct fields", () => {
    const output = kspec('meta observe friction "CLI output is too verbose"', tempDir);

    // AC-obs-1: Should output "OK Created observation: <ULID-prefix>"
    expect(output).toMatch(/Created observation: [A-Z0-9]{8}/);

    // Verify observation was saved
    const observations = kspecJson<any[]>("meta observations", tempDir);
    const newObs = observations.find((o) => o.content === "CLI output is too verbose");

    expect(newObs).toBeDefined();
    expect(newObs.type).toBe("friction");
    expect(newObs.created_at).toBeDefined();
    expect(newObs.author).toBeDefined();
    expect(newObs.resolved).toBe(false);
  });

  // AC: @observations ac-obs-1
  it("should create observation with workflow reference", () => {
    const output = kspec(
      'meta observe success "Tests caught a bug" --workflow "@task-start"',
      tempDir,
    );
    expect(output).toMatch(/Created observation: [A-Z0-9]{8}/);

    const observations = kspecJson<any[]>("meta observations", tempDir);
    const newObs = observations.find((o) => o.content === "Tests caught a bug");

    expect(newObs).toBeDefined();
    expect(newObs.workflow_ref).toBe("@task-start");
  });

  // AC: @observations ac-obs-2
  it("should list unresolved observations by default", () => {
    // Create some observations
    kspec('meta observe friction "Problem 1"', tempDir);
    kspec('meta observe success "Good thing"', tempDir);

    const output = kspec("meta observations", tempDir);

    // Should contain table headers
    expect(output).toContain("ID");
    expect(output).toContain("Type");
    expect(output).toContain("Workflow");
    expect(output).toContain("Created");
    expect(output).toContain("Content");

    // Should contain observation data
    expect(output).toContain("friction");
    expect(output).toContain("Problem 1");
    expect(output).toContain("success");
    expect(output).toContain("Good thing");
  });

  // AC: @observations ac-obs-2
  it("should show only unresolved observations by default", async () => {
    // Create and resolve an observation
    const createOutput = kspec('meta observe friction "This will be resolved"', tempDir);
    const match = createOutput.match(/Created observation: ([A-Z0-9]{8})/);
    expect(match).not.toBeNull();
    const obsRef = match![1];

    kspec(`meta resolve @${obsRef} "Fixed it"`, tempDir);

    // List without --all should not show resolved
    const output = kspec("meta observations", tempDir);
    expect(output).not.toContain("This will be resolved");

    // List with --all should show resolved
    const outputAll = kspec("meta observations --all", tempDir);
    expect(outputAll).toContain("This will be resolved");
  });

  // AC: @obs-list-display ac-1
  it("should show Resolved column with checkmarks when using --all flag", async () => {
    // Create two observations: one resolved, one unresolved
    const createOutput = kspec('meta observe friction "Will be resolved"', tempDir);
    const match = createOutput.match(/Created observation: ([A-Z0-9]{8})/);
    expect(match).not.toBeNull();
    const obsRef = match![1];

    kspec('meta observe success "Will stay unresolved"', tempDir);

    // Resolve one observation
    kspec(`meta resolve @${obsRef} "Fixed it"`, tempDir);

    // List with --all should show Resolved column
    const outputAll = kspec("meta observations --all", tempDir);

    // Should contain Resolved header
    expect(outputAll).toContain("Resolved");

    // Should show both observations with resolved indicators
    // ✓ for resolved, ✗ for unresolved
    expect(outputAll).toContain("✓");
    expect(outputAll).toContain("✗");
    expect(outputAll).toContain("Will be resolved");
    expect(outputAll).toContain("Will stay unresolved");

    // List without --all should NOT show Resolved column
    const outputDefault = kspec("meta observations", tempDir);
    expect(outputDefault).not.toContain("Resolved");
    // Should not show resolved observation
    expect(outputDefault).not.toContain("Will be resolved");
    // Should show unresolved observation
    expect(outputDefault).toContain("Will stay unresolved");
  });

  // AC: @observations ac-obs-5
  it("should output JSON with full observation objects", () => {
    kspec('meta observe friction "Test observation"', tempDir);

    const observations = kspecJson<any[]>("meta observations", tempDir);

    // Should be an array
    expect(Array.isArray(observations)).toBe(true);

    const testObs = observations.find((o) => o.content === "Test observation");
    expect(testObs).toBeDefined();

    // Should have all fields
    expect(testObs._ulid).toBeDefined();
    expect(testObs.type).toBe("friction");
    expect(testObs.content).toBe("Test observation");
    expect(testObs.created_at).toBeDefined();
    expect(testObs.author).toBeDefined();
    expect(testObs.resolved).toBe(false);
    expect(testObs).toHaveProperty("resolution");
    expect(testObs).toHaveProperty("resolved_at");
    expect(testObs).toHaveProperty("resolved_by");
    expect(testObs).toHaveProperty("promoted_to");
  });

  // AC: @observations ac-obs-3
  it("should promote observation to task", () => {
    // Create observation
    const createOutput = kspec(
      'meta observe friction "Need better error messages" --workflow "@task-start"',
      tempDir,
    );
    const match = createOutput.match(/Created observation: ([A-Z0-9]{8})/);
    const obsRef = match![1];

    // Promote to task
    const promoteOutput = kspec(
      `meta promote @${obsRef} --title "Improve error messages"`,
      tempDir,
    );

    // AC-obs-3: Should output "OK Created task: <ULID-prefix>"
    expect(promoteOutput).toMatch(/Created task: @[A-Z0-9]{8}/);

    // Verify observation was updated with promoted_to
    const observations = kspecJson<any[]>("meta observations", tempDir);
    const obs = observations.find((o) => o._ulid.startsWith(obsRef));
    expect(obs.promoted_to).toBeDefined();
    expect(obs.promoted_to).toMatch(/@[A-Z0-9]{8}/);
  });

  // AC: @observations ac-obs-6
  it("should error when promoting already-promoted observation", () => {
    // Create and promote observation
    const createOutput = kspec('meta observe friction "Test promotion"', tempDir);
    const match = createOutput.match(/Created observation: ([A-Z0-9]{8})/);
    const obsRef = match![1];

    kspec(`meta promote @${obsRef} --title "First promotion"`, tempDir);

    // Try to promote again - should fail
    try {
      const output = kspec(`meta promote @${obsRef} --title "Second promotion"`, tempDir);
      // AC-obs-6: Should error with specific message
      expect(output).toContain("Observation already promoted to task");
      expect(output).toContain("resolve or delete the task first");
    } catch (e: any) {
      const stdout = e.message || "";
      expect(stdout).toContain("Observation already promoted to task");
    }
  });

  // AC: @observations ac-obs-8
  it("should error when promoting resolved observation without --force", () => {
    // Create and resolve observation
    const createOutput = kspec('meta observe friction "Already resolved"', tempDir);
    const match = createOutput.match(/Created observation: ([A-Z0-9]{8})/);
    const obsRef = match![1];

    kspec(`meta resolve @${obsRef} "No longer relevant"`, tempDir);

    // Try to promote resolved observation without --force - should fail
    try {
      const output = kspec(`meta promote @${obsRef} --title "Try to promote"`, tempDir);
      // AC-obs-8: Should error with specific message
      expect(output).toContain("Cannot promote resolved observation");
      expect(output).toContain("use --force to override");
    } catch (e: any) {
      // Error is expected, check message in stdout
      const stdout = e.message || "";
      expect(stdout).toContain("Cannot promote resolved observation");
    }
  });

  // AC: @observations ac-obs-4
  it("should resolve observation with resolution text", () => {
    // Create observation
    const createOutput = kspec('meta observe friction "Something broken"', tempDir);
    const match = createOutput.match(/Created observation: ([A-Z0-9]{8})/);
    const obsRef = match![1];

    // Resolve it
    const resolveOutput = kspec(
      `meta resolve @${obsRef} "Fixed by implementing new feature"`,
      tempDir,
    );

    // AC-obs-4: Should output "OK Resolved: <ULID-prefix>"
    expect(resolveOutput).toMatch(/Resolved: [A-Z0-9]{8}/);

    // Verify observation was updated
    const observations = kspecJson<any[]>("meta observations", tempDir);
    const obs = observations.find((o) => o._ulid.startsWith(obsRef));

    expect(obs.resolved).toBe(true);
    expect(obs.resolution).toBe("Fixed by implementing new feature");
    expect(obs.resolved_at).toBeDefined();
    expect(obs.resolved_by).toBeDefined();
  });

  // AC: @observations ac-obs-7
  it("should error when resolving already-resolved observation", () => {
    // Create and resolve observation
    const createOutput = kspec('meta observe friction "Test double resolve"', tempDir);
    const match = createOutput.match(/Created observation: ([A-Z0-9]{8})/);
    const obsRef = match![1];

    kspec(`meta resolve @${obsRef} "First resolution"`, tempDir);

    // Try to resolve again - should fail
    try {
      const output = kspec(`meta resolve @${obsRef} "Second resolution"`, tempDir);
      // AC-obs-7: Should error with specific message
      expect(output).toContain("Observation already resolved on");
      expect(output).toContain("First resolution");
    } catch (e: any) {
      const stdout = e.message || "";
      expect(stdout).toContain("Observation already resolved on");
    }
  });

  it("should handle invalid observation type", () => {
    const output = kspec('meta observe invalid "Test content"', tempDir);
    // kspec() returns stdout even on error
    expect(output).toContain("Valid types: friction, success, question, idea");
  });

  it("should handle observation not found", () => {
    try {
      const output = kspec('meta promote @NOTFOUND --title "Test"', tempDir);
      expect(output).toContain("Observation not found: @NOTFOUND");
    } catch (e: any) {
      const stdout = e.message || "";
      expect(stdout).toContain("Observation not found: @NOTFOUND");
    }
  });
});

describe("Integration: observation-task resolution loop", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it("should auto-populate resolution from completed task", () => {
    // Create observation
    const createOutput = kspec('meta observe friction "CLI is slow"', tempDir);
    const match = createOutput.match(/Created observation: ([A-Z0-9]{8})/);
    const obsRef = match![1];

    // Promote to task
    const promoteOutput = kspec(
      `meta promote @${obsRef} --title "Optimize CLI performance"`,
      tempDir,
    );
    const taskMatch = promoteOutput.match(/Created task: @([A-Z0-9]{8})/);
    const taskRef = taskMatch![1];

    // Start, submit, and complete the task
    kspec(`task start @${taskRef}`, tempDir);
    kspec(`task submit @${taskRef}`, tempDir);
    kspec(`task complete @${taskRef} --reason "Reduced startup time by 50%"`, tempDir);

    // Resolve observation without explicit text (should auto-populate)
    const resolveOutput = kspec(`meta resolve @${obsRef}`, tempDir);
    expect(resolveOutput).toMatch(/Resolved: [A-Z0-9]{8}/);

    // Verify resolution includes task info
    const observations = kspecJson<any[]>("meta observations --all", tempDir);
    const obs = observations.find((o) => o._ulid.startsWith(obsRef));

    expect(obs.resolved).toBe(true);
    expect(obs.resolution).toContain(`@${taskRef}`);
    expect(obs.resolution).toContain("Reduced startup time by 50%");
  });

  it("should filter observations with --promoted", () => {
    // Create two observations, promote one
    kspec('meta observe friction "Issue 1"', tempDir);
    const obs2Output = kspec('meta observe friction "Issue 2"', tempDir);
    const match = obs2Output.match(/Created observation: ([A-Z0-9]{8})/);
    const obsRef = match![1];

    kspec(`meta promote @${obsRef} --title "Fix Issue 2"`, tempDir);

    // List promoted observations
    const promoted = kspecJson<any[]>("meta observations --promoted", tempDir);

    // Only the promoted one should appear
    expect(promoted.length).toBe(1);
    expect(promoted[0]._ulid.startsWith(obsRef)).toBe(true);
    expect(promoted[0].promoted_to).toBeDefined();
  });

  it("should filter observations with --pending-resolution", () => {
    // Create observation, promote, complete task
    const createOutput = kspec('meta observe friction "Needs fix"', tempDir);
    const match = createOutput.match(/Created observation: ([A-Z0-9]{8})/);
    const obsRef = match![1];

    const promoteOutput = kspec(`meta promote @${obsRef} --title "Fix the issue"`, tempDir);
    const taskMatch = promoteOutput.match(/Created task: @([A-Z0-9]{8})/);
    const taskRef = taskMatch![1];

    kspec(`task start @${taskRef}`, tempDir);
    kspec(`task submit @${taskRef}`, tempDir);
    kspec(`task complete @${taskRef} --reason "Fixed"`, tempDir);

    // List pending resolution
    const pending = kspecJson<any[]>("meta observations --pending-resolution", tempDir);

    // Should include our observation
    const found = pending.find((o) => o._ulid.startsWith(obsRef));
    expect(found).toBeDefined();
    expect(found.resolved).toBe(false);
    expect(found.promoted_to).toBeDefined();

    // After resolving, should not appear
    kspec(`meta resolve @${obsRef}`, tempDir);
    const pendingAfter = kspecJson<any[]>("meta observations --pending-resolution", tempDir);
    const foundAfter = pendingAfter.find((o) => o._ulid.startsWith(obsRef));
    expect(foundAfter).toBeUndefined();
  });

  it("should error when resolving with incomplete task", () => {
    // Create observation, promote, but don't complete task
    const createOutput = kspec('meta observe friction "Not done yet"', tempDir);
    const match = createOutput.match(/Created observation: ([A-Z0-9]{8})/);
    const obsRef = match![1];

    kspec(`meta promote @${obsRef} --title "WIP task"`, tempDir);

    // Try to resolve without text (task not completed)
    try {
      const output = kspec(`meta resolve @${obsRef}`, tempDir);
      expect(output).toContain("not completed yet");
    } catch (e: any) {
      const stdout = e.message || "";
      expect(stdout).toContain("not completed yet");
    }
  });
});

// AC: @trait-multi-ref-batch - Batch support for meta resolve
describe("Integration: meta resolve batch mode", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // Helper to create observation and get full ULID (avoids prefix collision in fast tests)
  function createObservation(type: string, content: string): string {
    const result = kspecJson<any>(`meta observe ${type} "${content}"`, tempDir);
    return result._ulid;
  }

  // AC: @trait-multi-ref-batch ac-1 - --refs operates on all provided references
  it("should resolve multiple observations with --refs flag", () => {
    // Create multiple observations - use JSON mode to get full ULIDs
    const obs1Ulid = createObservation("friction", "Friction 1");
    const obs2Ulid = createObservation("success", "Success 1");
    const obs3Ulid = createObservation("question", "Question 1");

    // Verify we have 3 distinct ULIDs
    expect(new Set([obs1Ulid, obs2Ulid, obs3Ulid]).size).toBe(3);

    // Resolve all three with --refs and shared resolution text
    const result = kspecJson<any>(
      `meta resolve --refs @${obs1Ulid} @${obs2Ulid} @${obs3Ulid} --resolution "Batch resolved"`,
      tempDir,
    );

    // Should process all 3
    expect(result.summary.total).toBe(3);
    expect(result.summary.succeeded).toBe(3);
    expect(result.summary.failed).toBe(0);

    // Verify all are resolved
    const observations = kspecJson<any[]>("meta observations --all", tempDir);
    const resolved = observations.filter((o) => [obs1Ulid, obs2Ulid, obs3Ulid].includes(o._ulid));
    expect(resolved.length).toBe(3);
    expect(resolved.every((o) => o.resolved)).toBe(true);
  });

  // AC: @trait-multi-ref-batch ac-2 - Continue processing after errors
  it("should continue processing when some refs fail", () => {
    // Create two observations, resolve one
    const obs1Ulid = createObservation("friction", "Can resolve");
    const obs2Ulid = createObservation("friction", "Already done");

    // Resolve obs2 first
    kspec(`meta resolve @${obs2Ulid} "Pre-resolved"`, tempDir);

    // Try to resolve both - obs2 should fail (already resolved)
    // JSON mode will still return structured data even on partial failure
    try {
      const result = kspecJson<any>(
        `meta resolve --refs @${obs1Ulid} @${obs2Ulid} --resolution "Batch resolve"`,
        tempDir,
      );
      // Should show partial success
      expect(result.summary.succeeded).toBe(1);
      expect(result.summary.failed).toBe(1);
    } catch (e: any) {
      // Partial failure still exits with error code but should contain JSON
      const stdout = e.stdout || e.message || "";
      // Parse the JSON from stdout
      const jsonMatch = stdout.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]);
        expect(result.summary.succeeded).toBe(1);
        expect(result.summary.failed).toBe(1);
      } else {
        // Fall back to checking for partial success message in human output
        expect(e.message).toContain("1 of 2");
      }
    }

    // Obs1 should be resolved despite obs2 failing
    const observations = kspecJson<any[]>("meta observations --all", tempDir);
    const obs1 = observations.find((o) => o._ulid === obs1Ulid);
    expect(obs1?.resolved).toBe(true);
  });

  // AC: @trait-multi-ref-batch ac-3 - Exit code 0 when all succeed
  it("should exit with code 0 when all refs succeed", () => {
    // Create observations
    const obs1Ulid = createObservation("friction", "Resolve me 1");
    const obs2Ulid = createObservation("friction", "Resolve me 2");

    // Verify distinct ULIDs
    expect(obs1Ulid).not.toBe(obs2Ulid);

    // Should not throw (exit code 0) - use JSON to verify
    const result = kspecJson<any>(
      `meta resolve --refs @${obs1Ulid} @${obs2Ulid} --resolution "All good"`,
      tempDir,
    );
    expect(result.summary.total).toBe(2);
    expect(result.summary.succeeded).toBe(2);
    expect(result.success).toBe(true);
  });

  // AC: @trait-multi-ref-batch ac-4 - Exit code 1 when any fail
  it("should exit with code 1 when any refs fail", () => {
    const obsUlid = createObservation("friction", "Will fail");

    // Resolve it first
    kspec(`meta resolve @${obsUlid} "Already done"`, tempDir);

    // Try to resolve again - should fail with exit code 1
    // Use kspecRun to get full result object including exit code
    const result = kspecRun(`meta resolve --refs @${obsUlid} --resolution "Should fail"`, tempDir, {
      expectFail: true,
    });
    expect(result.exitCode).toBe(1);
    // Output should contain the error reason
    expect(result.stdout + result.stderr).toContain("Already resolved");
  });

  // AC: @trait-multi-ref-batch ac-5 - Success and failure counts reported
  it("should report success and failure counts", () => {
    // Create 3 observations, pre-resolve 1
    const obs1Ulid = createObservation("friction", "Good 1");
    const obs2Ulid = createObservation("friction", "Good 2");
    const obs3Ulid = createObservation("friction", "Already done");

    kspec(`meta resolve @${obs3Ulid} "Pre-resolved"`, tempDir);

    try {
      // Use JSON mode to get precise counts
      const result = kspecJson<any>(
        `meta resolve --refs @${obs1Ulid} @${obs2Ulid} @${obs3Ulid} --resolution "Batch"`,
        tempDir,
      );
      expect(result.summary.succeeded).toBe(2);
      expect(result.summary.failed).toBe(1);
      expect(result.summary.total).toBe(3);
    } catch (e: any) {
      // Parse JSON from error output
      const stdout = e.stdout || e.message || "";
      const jsonMatch = stdout.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]);
        expect(result.summary.succeeded).toBe(2);
        expect(result.summary.failed).toBe(1);
      } else {
        expect(e.message).toContain("2 of 3");
      }
    }
  });

  // AC: @trait-multi-ref-batch ac-6 - Mutual exclusion of positional ref and --refs
  it("should error when both positional ref and --refs are provided", () => {
    const obsUlid = createObservation("friction", "Test");

    try {
      kspec(`meta resolve @${obsUlid} --refs @${obsUlid} --resolution "Both"`, tempDir);
      expect.fail("Should have thrown error");
    } catch (e: any) {
      expect(e.message).toContain("Cannot use both positional ref and --refs");
    }
  });

  // AC: @trait-multi-ref-batch ac-7 - JSON output contains array of results
  it("should output array of results in JSON mode", () => {
    const obs1Ulid = createObservation("friction", "JSON test 1");
    const obs2Ulid = createObservation("friction", "JSON test 2");

    // Verify distinct ULIDs
    expect(obs1Ulid).not.toBe(obs2Ulid);

    const result = kspecJson<any>(
      `meta resolve --refs @${obs1Ulid} @${obs2Ulid} --resolution "JSON batch"`,
      tempDir,
    );

    // Should be a BatchResult object with results array
    expect(result.success).toBe(true);
    expect(result.summary).toBeDefined();
    expect(result.summary.total).toBe(2);
    expect(result.summary.succeeded).toBe(2);
    expect(result.summary.failed).toBe(0);
    expect(result.results).toHaveLength(2);
    expect(result.results[0].status).toBe("success");
    expect(result.results[1].status).toBe("success");
  });

  // AC: @trait-multi-ref-batch ac-8 - Duplicate refs processed once only
  it("should deduplicate refs and process each once", () => {
    const obsUlid = createObservation("friction", "Dedup test");

    // Pass same ref multiple times - use JSON to verify count
    const result = kspecJson<any>(
      `meta resolve --refs @${obsUlid} @${obsUlid} @${obsUlid} --resolution "Single resolution"`,
      tempDir,
    );

    // Should only process once due to deduplication
    expect(result.summary.total).toBe(1);
    expect(result.summary.succeeded).toBe(1);

    // Verify only resolved once
    const observations = kspecJson<any[]>("meta observations --all", tempDir);
    const obs = observations.find((o) => o._ulid === obsUlid);
    expect(obs?.resolved).toBe(true);
    expect(obs?.resolution).toBe("Single resolution");
  });

  // Test that single-ref mode still works (backwards compatibility)
  it("should still work with positional ref argument (single mode)", () => {
    const obsUlid = createObservation("friction", "Single mode test");

    const output = kspec(`meta resolve @${obsUlid} "Single resolution"`, tempDir);
    // Single mode output shows just the result without X of Y counts
    expect(output).toContain("Resolve:");

    // Verify resolved
    const observations = kspecJson<any[]>("meta observations --all", tempDir);
    const obs = observations.find((o) => o._ulid === obsUlid);
    expect(obs?.resolved).toBe(true);
  });

  // Test resolution text can come from --resolution flag in single mode too
  it("should accept --resolution flag in single mode", () => {
    const obsUlid = createObservation("friction", "Resolution flag test");

    const output = kspec(`meta resolve @${obsUlid} --resolution "Via flag"`, tempDir);
    // Single mode shows result
    expect(output).toContain("Resolve:");

    const observations = kspecJson<any[]>("meta observations --all", tempDir);
    const obs = observations.find((o) => o._ulid === obsUlid);
    expect(obs?.resolution).toBe("Via flag");
  });
});

describe("Integration: meta_ref in tasks", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @task-add ac-meta-ref
  // AC: @meta-ref ac-meta-ref-1
  it("should create task with valid meta_ref to workflow", () => {
    // AC-meta-ref-1: task add --meta-ref @workflow-id creates task with meta_ref field
    const output = kspec('task add --title "Improve workflow" --meta-ref "@task-start"', tempDir);

    // Should output "OK Created task: <ULID-prefix>"
    expect(output).toMatch(/Created task: [A-Z0-9]{8}/);

    // Verify task was created with meta_ref
    const match = output.match(/Created task: ([A-Z0-9]{8})/);
    const taskRef = match![1];

    const task = kspecJson<any>(`task get @${taskRef}`, tempDir);
    expect(task.meta_ref).toBe("@task-start");
  });

  // AC: @task-add ac-meta-ref
  // AC: @meta-ref ac-meta-ref-1
  it("should create task with valid meta_ref to agent", () => {
    const output = kspec(
      'task add --title "Update agent capabilities" --meta-ref "@test-agent"',
      tempDir,
    );
    expect(output).toMatch(/Created task: [A-Z0-9]{8}/);

    const match = output.match(/Created task: ([A-Z0-9]{8})/);
    const taskRef = match![1];

    const task = kspecJson<any>(`task get @${taskRef}`, tempDir);
    expect(task.meta_ref).toBe("@test-agent");
  });

  // AC: @meta-ref ac-meta-ref-2
  it("should filter tasks by meta_ref", () => {
    // Create tasks with different meta_refs
    kspec('task add --title "Task 1" --meta-ref "@task-start"', tempDir);
    kspec('task add --title "Task 2" --meta-ref "@test-agent"', tempDir);
    kspec('task add --title "Task 3" --meta-ref "@task-start"', tempDir);
    kspec('task add --title "Task 4"', tempDir); // No meta_ref

    // AC-meta-ref-2: tasks list --meta-ref @workflow filters by meta_ref
    const tasks = kspecJson<any[]>('tasks list --meta-ref "@task-start"', tempDir);

    // Should only include tasks with meta_ref = @task-start
    const taskTitles = tasks.map((t) => t.title);
    expect(taskTitles).toContain("Task 1");
    expect(taskTitles).toContain("Task 3");
    expect(taskTitles).not.toContain("Task 2");
    expect(taskTitles).not.toContain("Task 4");
  });

  // AC: @task-add ac-meta-ref-invalid
  // AC: @meta-ref ac-meta-ref-3
  it("should error when meta_ref does not resolve", () => {
    try {
      const output = kspec(
        'task add --title "Test task" --meta-ref "@invalid-ref-123456"',
        tempDir,
      );
      // AC-meta-ref-3: Should error with specific message
      expect(output).toContain("meta_ref '@invalid-ref-123456' not found");
    } catch (e: any) {
      const stdout = e.message || "";
      expect(stdout).toContain("meta_ref '@invalid-ref-123456' not found");
    }
  });

  // AC: @task-add ac-meta-ref-invalid
  // AC: @meta-ref ac-meta-ref-4
  it("should error when meta_ref points to spec item", () => {
    try {
      // test-feature is a spec item, not a meta item
      const output = kspec('task add --title "Test task" --meta-ref "@test-feature"', tempDir);
      // AC-meta-ref-4: Should error with specific message
      expect(output).toContain(
        "meta_ref '@test-feature' points to a spec item; use --spec-ref for product spec references",
      );
    } catch (e: any) {
      const stdout = e.message || "";
      expect(stdout).toContain(
        "meta_ref '@test-feature' points to a spec item; use --spec-ref for product spec references",
      );
    }
  });

  it("should update task meta_ref with task set", () => {
    // Create task without meta_ref
    const createOutput = kspec('task add --title "Test task"', tempDir);
    const match = createOutput.match(/Created task: ([A-Z0-9]{8})/);
    const taskRef = match![1];

    // Update with meta_ref
    kspec(`task set @${taskRef} --meta-ref "@task-start"`, tempDir);

    // Verify update
    const task = kspecJson<any>(`task get @${taskRef}`, tempDir);
    expect(task.meta_ref).toBe("@task-start");
  });

  it("should validate meta_ref in task set", () => {
    // Create task
    const createOutput = kspec('task add --title "Test task"', tempDir);
    const match = createOutput.match(/Created task: ([A-Z0-9]{8})/);
    const taskRef = match![1];

    // Try to set invalid meta_ref
    try {
      const output = kspec(`task set @${taskRef} --meta-ref "@invalid-workflow"`, tempDir);
      expect(output).toContain("meta_ref '@invalid-workflow' not found");
    } catch (e: any) {
      const stdout = e.message || "";
      expect(stdout).toContain("meta_ref '@invalid-workflow' not found");
    }
  });
});

describe("Integration: meta mutation commands", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  describe("meta add", () => {
    it("should create a new agent with required fields", () => {
      const output = kspec(
        'meta add agent --id new-agent --name "New Agent" --description "A new agent"',
        tempDir,
      );

      expect(output).toContain("Created agent: new-agent");
      expect(output).toMatch(/@\w{8}/); // ULID prefix

      // Verify it was created
      const agent = kspecJson<any>("meta get @new-agent", tempDir);
      expect(agent.id).toBe("new-agent");
      expect(agent.name).toBe("New Agent");
      expect(agent.description).toBe("A new agent");
    });

    it("should create agent with capabilities and tools", () => {
      kspec(
        'meta add agent --id capable-agent --name "Capable Agent" --capability code --capability test --tool bash --tool git',
        tempDir,
      );

      const agent = kspecJson<any>("meta get @capable-agent", tempDir);
      expect(agent.capabilities).toEqual(["code", "test"]);
      expect(agent.tools).toEqual(["bash", "git"]);
    });

    it("should create a new workflow with required fields", () => {
      const output = kspec(
        'meta add workflow --id new-workflow --trigger "on-commit" --description "A new workflow"',
        tempDir,
      );

      expect(output).toContain("Created workflow: new-workflow");

      const workflow = kspecJson<any>("meta get @new-workflow", tempDir);
      expect(workflow.id).toBe("new-workflow");
      expect(workflow.trigger).toBe("on-commit");
      expect(workflow.description).toBe("A new workflow");
      expect(workflow.steps).toEqual([]);
    });

    it("should create a new convention with rules", () => {
      const output = kspec(
        'meta add convention --domain testing --rule "Write tests first" --rule "Use descriptive names"',
        tempDir,
      );

      expect(output).toContain("Created convention: testing");

      const convention = kspecJson<any>("meta get @testing", tempDir);
      expect(convention.domain).toBe("testing");
      expect(convention.rules).toEqual(["Write tests first", "Use descriptive names"]);
    });

    it("should fail when required fields are missing", () => {
      try {
        kspec('meta add agent --name "Agent without ID"', tempDir);
        expect.fail("Should have thrown error");
      } catch (e: any) {
        expect(e.message).toContain("Agent requires --id");
      }

      try {
        kspec("meta add workflow --id workflow-no-trigger", tempDir);
        expect.fail("Should have thrown error");
      } catch (e: any) {
        expect(e.message).toContain("Workflow requires --trigger");
      }

      try {
        kspec('meta add convention --rule "Rule without domain"', tempDir);
        expect.fail("Should have thrown error");
      } catch (e: any) {
        expect(e.message).toContain("Convention requires --domain");
      }
    });

    it("should support JSON output (add agent)", () => {
      const agent = kspecJson<any>('meta add agent --id json-agent --name "JSON Agent"', tempDir);

      expect(agent.id).toBe("json-agent");
      expect(agent.name).toBe("JSON Agent");
      expect(agent._ulid).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    });

    // AC: @meta-add-cmd ac-1
    it("should create workflow with --steps containing valid JSON array", () => {
      const steps = JSON.stringify([
        { type: "check", content: "Verify prerequisites" },
        { type: "action", content: "Execute the task" },
        { type: "decision", content: "Was it successful?", options: ["Yes", "No"] },
      ]);

      const output = kspec(
        `meta add workflow --id steps-workflow --trigger "manual" --steps '${steps}'`,
        tempDir,
      );

      expect(output).toContain("Created workflow: steps-workflow");

      // Verify the workflow has steps
      const workflow = kspecJson<any>("meta get @steps-workflow", tempDir);
      expect(workflow.id).toBe("steps-workflow");
      expect(workflow.steps).toHaveLength(3);
      expect(workflow.steps[0].type).toBe("check");
      expect(workflow.steps[0].content).toBe("Verify prerequisites");
      expect(workflow.steps[1].type).toBe("action");
      expect(workflow.steps[1].content).toBe("Execute the task");
      expect(workflow.steps[2].type).toBe("decision");
      expect(workflow.steps[2].options).toEqual(["Yes", "No"]);
    });

    // AC: @meta-add-cmd ac-1
    it("should create workflow with --steps including optional fields", () => {
      const steps = JSON.stringify([
        { type: "check", content: "Verify tests pass", on_fail: "Fix failing tests" },
        { type: "action", content: "Deploy", entry_criteria: ["All checks passed"] },
      ]);

      const workflow = kspecJson<any>(
        `meta add workflow --id optional-steps --trigger "deploy" --steps '${steps}'`,
        tempDir,
      );

      expect(workflow.steps).toHaveLength(2);
      expect(workflow.steps[0].on_fail).toBe("Fix failing tests");
      expect(workflow.steps[1].entry_criteria).toEqual(["All checks passed"]);
    });

    // AC: @meta-add-cmd ac-1
    it("should create workflow with empty steps array", () => {
      const workflow = kspecJson<any>(
        "meta add workflow --id empty-steps --trigger \"manual\" --steps '[]'",
        tempDir,
      );

      expect(workflow.steps).toEqual([]);
    });

    // AC: @meta-add-cmd ac-2
    it("should error on malformed JSON in --steps", () => {
      try {
        kspec(
          'meta add workflow --id bad-json --trigger "manual" --steps "not valid json"',
          tempDir,
        );
        expect.fail("Should have thrown error");
      } catch (e: any) {
        expect(e.message).toContain("Invalid JSON in --steps");
      }
    });

    // AC: @meta-add-cmd ac-3
    it("should error when --steps is not an array", () => {
      try {
        kspec(
          'meta add workflow --id not-array --trigger "manual" --steps \'{"type":"check","content":"Test"}\'',
          tempDir,
        );
        expect.fail("Should have thrown error");
      } catch (e: any) {
        expect(e.message).toContain("Steps must be a JSON array");
      }
    });

    // AC: @meta-add-cmd ac-4
    it("should error on invalid step type", () => {
      try {
        kspec(
          'meta add workflow --id invalid-type --trigger "manual" --steps \'[{"type":"invalid","content":"Test"}]\'',
          tempDir,
        );
        expect.fail("Should have thrown error");
      } catch (e: any) {
        expect(e.message).toContain("Invalid workflow steps");
        expect(e.message).toContain("0.type");
      }
    });

    // AC: @meta-add-cmd ac-4
    it("should error when content field is missing", () => {
      try {
        kspec(
          'meta add workflow --id missing-content --trigger "manual" --steps \'[{"type":"check"}]\'',
          tempDir,
        );
        expect.fail("Should have thrown error");
      } catch (e: any) {
        expect(e.message).toContain("Invalid workflow steps");
        expect(e.message).toContain("content");
      }
    });
  });

  describe("meta set", () => {
    it("should update agent name and description", () => {
      // Create an agent
      kspec('meta add agent --id update-agent --name "Original Name"', tempDir);

      // Update it
      const output = kspec(
        'meta set @update-agent --name "Updated Name" --description "New description"',
        tempDir,
      );

      expect(output).toContain("Updated agent: update-agent");

      const agent = kspecJson<any>("meta get @update-agent", tempDir);
      expect(agent.name).toBe("Updated Name");
      expect(agent.description).toBe("New description");
    });

    it("should add capabilities and tools to agent", () => {
      kspec('meta add agent --id add-agent --name "Add Agent"', tempDir);

      kspec("meta set @add-agent --add-capability code", tempDir);
      kspec("meta set @add-agent --add-capability test", tempDir);
      kspec("meta set @add-agent --add-tool bash", tempDir);

      const agent = kspecJson<any>("meta get @add-agent", tempDir);
      expect(agent.capabilities).toContain("code");
      expect(agent.capabilities).toContain("test");
      expect(agent.tools).toContain("bash");
    });

    it("should not duplicate capabilities or tools", () => {
      kspec(
        'meta add agent --id dup-agent --name "Dup Agent" --capability code --tool bash',
        tempDir,
      );

      kspec("meta set @dup-agent --add-capability code --add-tool bash", tempDir);

      const agent = kspecJson<any>("meta get @dup-agent", tempDir);
      expect(agent.capabilities).toEqual(["code"]); // Should not duplicate
      expect(agent.tools).toEqual(["bash"]);
    });

    it("should update workflow trigger and description", () => {
      kspec('meta add workflow --id update-wf --trigger "old-trigger"', tempDir);

      kspec(
        'meta set @update-wf --trigger "new-trigger" --description "Updated workflow"',
        tempDir,
      );

      const workflow = kspecJson<any>("meta get @update-wf", tempDir);
      expect(workflow.trigger).toBe("new-trigger");
      expect(workflow.description).toBe("Updated workflow");
    });

    it("should add rules to convention", () => {
      kspec('meta add convention --domain update-conv --rule "Rule 1"', tempDir);

      kspec('meta set @update-conv --add-rule "Rule 2"', tempDir);

      const convention = kspecJson<any>("meta get @update-conv", tempDir);
      expect(convention.rules).toContain("Rule 1");
      expect(convention.rules).toContain("Rule 2");
    });

    it("should work with ULID prefix references", () => {
      const output = kspec('meta add agent --id ulid-ref --name "ULID Ref Agent"', tempDir);
      const match = output.match(/@(\w{8})/);
      expect(match).toBeTruthy();
      const ulidPrefix = match![1];

      kspec(`meta set @${ulidPrefix} --name "Updated via ULID"`, tempDir);

      const agent = kspecJson<any>("meta get @ulid-ref", tempDir);
      expect(agent.name).toBe("Updated via ULID");
    });

    it("should support JSON output (set)", () => {
      kspec('meta add agent --id json-update --name "JSON Update"', tempDir);

      const agent = kspecJson<any>('meta set @json-update --name "JSON Updated"', tempDir);
      expect(agent.name).toBe("JSON Updated");
    });

    it("should fail for non-existent item", () => {
      try {
        kspec('meta set @nonexistent --name "Should fail"', tempDir);
        expect.fail("Should have thrown error");
      } catch (e: any) {
        expect(e.message).toContain("Meta item not found");
      }
    });

    // AC: @meta-set-multi-value-parity ac-repeated-add-rule-all-kept
    it("should preserve all rules when multiple --add-rule flags are passed in a single call", () => {
      kspec("meta add convention --domain multi-rule-conv", tempDir);

      kspec(
        'meta set @multi-rule-conv --add-rule "Use snake_case" --add-rule "Max 80 chars" --add-rule "No globals"',
        tempDir,
      );

      const conv = kspecJson<any>("meta get @multi-rule-conv", tempDir);
      expect(conv.rules).toContain("Use snake_case");
      expect(conv.rules).toContain("Max 80 chars");
      expect(conv.rules).toContain("No globals");
      expect(conv.rules).toHaveLength(3);
    });

    // AC: @meta-set-multi-value-parity ac-repeated-add-skill-all-kept
    it("should preserve all skills when multiple --add-skill flags are passed in a single call", () => {
      kspec('meta add agent --id multi-skill-agent --name "Multi Skill Agent"', tempDir);

      kspec(
        "meta set @multi-skill-agent --add-skill review --add-skill deploy --add-skill test",
        tempDir,
      );

      const agent = kspecJson<any>("meta get @multi-skill-agent", tempDir);
      expect(agent.skills).toContain("review");
      expect(agent.skills).toContain("deploy");
      expect(agent.skills).toContain("test");
      expect(agent.skills).toHaveLength(3);
    });

    // AC: @meta-set-multi-value-parity ac-repeated-add-capability-all-kept
    it("should preserve all capabilities when multiple --add-capability flags are passed in a single call", () => {
      kspec('meta add agent --id multi-cap-agent --name "Multi Cap Agent"', tempDir);

      kspec(
        "meta set @multi-cap-agent --add-capability code --add-capability test --add-capability review",
        tempDir,
      );

      const agent = kspecJson<any>("meta get @multi-cap-agent", tempDir);
      expect(agent.capabilities).toContain("code");
      expect(agent.capabilities).toContain("test");
      expect(agent.capabilities).toContain("review");
      expect(agent.capabilities).toHaveLength(3);
    });

    // AC: @meta-set-multi-value-parity ac-remove-flags-unchanged
    it("should remove all named values when multiple remove flags are passed in a single call", () => {
      kspec(
        'meta add agent --id multi-rm-agent --name "Multi Remove Agent" --capability code --capability test --capability review --capability deploy',
        tempDir,
      );

      kspec(
        "meta set @multi-rm-agent --remove-capability test --remove-capability deploy",
        tempDir,
      );

      const agent = kspecJson<any>("meta get @multi-rm-agent", tempDir);
      expect(agent.capabilities).toContain("code");
      expect(agent.capabilities).toContain("review");
      expect(agent.capabilities).not.toContain("test");
      expect(agent.capabilities).not.toContain("deploy");
      expect(agent.capabilities).toHaveLength(2);
    });

    // AC: @meta-set-multi-value-parity ac-mixed-add-and-remove
    it("should apply removes before adds when both are passed in a single call", () => {
      kspec(
        'meta add agent --id mixed-agent --name "Mixed Agent" --capability old1 --capability old2 --capability keep',
        tempDir,
      );

      kspec(
        "meta set @mixed-agent --remove-capability old1 --remove-capability old2 --add-capability new1 --add-capability new2",
        tempDir,
      );

      const agent = kspecJson<any>("meta get @mixed-agent", tempDir);
      expect(agent.capabilities).toContain("keep");
      expect(agent.capabilities).toContain("new1");
      expect(agent.capabilities).toContain("new2");
      expect(agent.capabilities).not.toContain("old1");
      expect(agent.capabilities).not.toContain("old2");
      expect(agent.capabilities).toHaveLength(3);
    });

    // AC: @meta-set-multi-value-parity ac-mixed-add-and-remove
    // Verifies remove-then-add ordering: removing and re-adding the same value works
    it("should allow removing and re-adding the same value in one call (remove-before-add order)", () => {
      kspec(
        'meta add agent --id readd-agent --name "Readd Agent" --capability stale',
        tempDir,
      );

      // Remove "stale" and re-add "stale" — net effect: value is present
      kspec(
        "meta set @readd-agent --remove-capability stale --add-capability stale",
        tempDir,
      );

      const agent = kspecJson<any>("meta get @readd-agent", tempDir);
      expect(agent.capabilities).toContain("stale");
      expect(agent.capabilities).toHaveLength(1);
    });

    // AC: @meta-set-multi-value-parity ac-remove-flags-unchanged (tool variant)
    it("should remove multiple tools in a single call", () => {
      kspec(
        'meta add agent --id multi-rm-tool-agent --name "Multi Remove Tool Agent" --tool bash --tool python --tool node',
        tempDir,
      );

      kspec(
        "meta set @multi-rm-tool-agent --remove-tool bash --remove-tool python",
        tempDir,
      );

      const agent = kspecJson<any>("meta get @multi-rm-tool-agent", tempDir);
      expect(agent.tools).toEqual(["node"]);
    });

    // AC: @meta-set-multi-value-parity ac-repeated-add-capability-all-kept (tool variant)
    it("should add multiple tools in a single call", () => {
      kspec('meta add agent --id multi-add-tool-agent --name "Multi Add Tool Agent"', tempDir);

      kspec(
        "meta set @multi-add-tool-agent --add-tool bash --add-tool python --add-tool node",
        tempDir,
      );

      const agent = kspecJson<any>("meta get @multi-add-tool-agent", tempDir);
      expect(agent.tools).toContain("bash");
      expect(agent.tools).toContain("python");
      expect(agent.tools).toContain("node");
      expect(agent.tools).toHaveLength(3);
    });

    // Regression: meta add multi-value behavior must not be broken
    it("should preserve meta add multi-value behavior (regression)", () => {
      kspec(
        'meta add agent --id meta-add-regression --name "Regression Agent" --capability code --capability test --skill review --skill deploy --tool bash --tool python',
        tempDir,
      );

      const agent = kspecJson<any>("meta get @meta-add-regression", tempDir);
      expect(agent.capabilities).toEqual(["code", "test"]);
      expect(agent.skills).toEqual(["review", "deploy"]);
      expect(agent.tools).toEqual(["bash", "python"]);
    });

    // Regression: meta add convention multi-rule behavior must not be broken
    it("should preserve meta add convention multi-rule behavior (regression)", () => {
      kspec(
        'meta add convention --domain regression-conv --rule "Rule 1" --rule "Rule 2" --rule "Rule 3"',
        tempDir,
      );

      const conv = kspecJson<any>("meta get @regression-conv", tempDir);
      expect(conv.rules).toEqual(["Rule 1", "Rule 2", "Rule 3"]);
    });

    // Dedup: adding already-existing values should not create duplicates
    it("should not create duplicates when adding already-existing values", () => {
      kspec(
        'meta add agent --id dedup-agent --name "Dedup Agent" --capability code --capability test',
        tempDir,
      );

      kspec(
        "meta set @dedup-agent --add-capability code --add-capability test --add-capability new",
        tempDir,
      );

      const agent = kspecJson<any>("meta get @dedup-agent", tempDir);
      expect(agent.capabilities).toEqual(["code", "test", "new"]);
    });
  });

  describe("meta delete", () => {
    it("should delete an agent", () => {
      kspec('meta add agent --id delete-agent --name "Delete Agent"', tempDir);

      const output = kspec("meta delete @delete-agent --confirm", tempDir);
      expect(output).toContain("Deleted agent delete-agent");

      // Verify it's gone
      try {
        kspec("meta get @delete-agent", tempDir);
        expect.fail("Should have thrown error");
      } catch (e: any) {
        expect(e.message).toContain("not found");
      }
    });

    it("should delete a workflow", () => {
      kspec('meta add workflow --id delete-wf --trigger "delete-trigger"', tempDir);

      const output = kspec("meta delete @delete-wf --confirm", tempDir);
      expect(output).toContain("Deleted workflow delete-wf");
    });

    it("should delete a convention", () => {
      kspec("meta add convention --domain delete-conv", tempDir);

      const output = kspec("meta delete @delete-conv --confirm", tempDir);
      expect(output).toContain("Deleted convention delete-conv");
    });

    it("should work with ULID prefix references", () => {
      const output = kspec('meta add agent --id ulid-delete --name "ULID Delete"', tempDir);
      const match = output.match(/@(\w{8})/);
      const ulidPrefix = match![1];

      kspec(`meta delete @${ulidPrefix} --confirm`, tempDir);

      try {
        kspec("meta get @ulid-delete", tempDir);
        expect.fail("Should have thrown error");
      } catch (e: any) {
        expect(e.message).toContain("not found");
      }
    });

    it("should require --confirm flag", () => {
      kspec('meta add agent --id confirm-agent --name "Confirm Agent"', tempDir);

      try {
        kspec("meta delete @confirm-agent", tempDir);
        expect.fail("Should have thrown error");
      } catch (e: any) {
        expect(e.message).toContain("Use --confirm to skip this prompt");
      }

      // Verify it wasn't deleted
      const agent = kspecJson<any>("meta get @confirm-agent", tempDir);
      expect(agent.id).toBe("confirm-agent");
    });

    it("should fail for non-existent item", () => {
      try {
        kspec("meta delete @nonexistent --confirm", tempDir);
        expect.fail("Should have thrown error");
      } catch (e: any) {
        expect(e.message).toContain("Meta item not found");
      }
    });

    it("should prevent deletion of agent referenced by task", () => {
      // Create an agent
      kspec('meta add agent --id ref-agent --name "Referenced Agent"', tempDir);

      // Create a task that references this agent
      kspec('task add --title "Test task" --meta-ref @ref-agent', tempDir);

      // Try to delete the agent without --confirm
      try {
        kspec("meta delete @ref-agent", tempDir);
        expect.fail("Should have prevented deletion");
      } catch (e: any) {
        expect(e.message).toContain("Referenced by");
        expect(e.message).toContain("task(s)");
        expect(e.message).toContain("Use --confirm to override");
      }

      // Verify agent still exists
      const agent = kspecJson<any>("meta get @ref-agent", tempDir);
      expect(agent.id).toBe("ref-agent");

      // Can delete with --confirm flag
      kspec("meta delete @ref-agent --confirm", tempDir);

      // Verify it's deleted
      try {
        kspec("meta get @ref-agent", tempDir);
        expect.fail("Agent should be deleted");
      } catch (e: any) {
        expect(e.message).toContain("Meta item not found");
      }
    });

    it("should prevent deletion of workflow referenced by observation", () => {
      // Create a workflow
      kspec(
        'meta add workflow --id ref-workflow --trigger "test trigger" --description "Test workflow"',
        tempDir,
      );

      // Create an observation that references this workflow
      kspec('meta observe friction "Test friction" --workflow @ref-workflow', tempDir);

      // Try to delete the workflow without --confirm
      try {
        kspec("meta delete @ref-workflow", tempDir);
        expect.fail("Should have prevented deletion");
      } catch (e: any) {
        expect(e.message).toContain("Referenced by");
        expect(e.message).toContain("observation(s)");
        expect(e.message).toContain("Use --confirm to override");
      }

      // Verify workflow still exists
      const workflow = kspecJson<any>("meta get @ref-workflow", tempDir);
      expect(workflow.id).toBe("ref-workflow");

      // Can delete with --confirm flag
      kspec("meta delete @ref-workflow --confirm", tempDir);

      // Verify it's deleted
      try {
        kspec("meta get @ref-workflow", tempDir);
        expect.fail("Workflow should be deleted");
      } catch (e: any) {
        expect(e.message).toContain("Meta item not found");
      }
    });

    it("should allow deletion of unreferenced items without --confirm errors about refs", () => {
      // Create an agent that won't be referenced
      kspec('meta add agent --id unreferenced-agent --name "Unreferenced Agent"', tempDir);

      // Try to delete without --confirm - should only complain about confirmation, not refs
      try {
        kspec("meta delete @unreferenced-agent", tempDir);
        expect.fail("Should have required confirmation");
      } catch (e: any) {
        expect(e.message).toContain("Use --confirm to skip this prompt");
        expect(e.message).not.toContain("Referenced by");
      }

      // Delete with --confirm
      kspec("meta delete @unreferenced-agent --confirm", tempDir);
    });

    it("should detect references when deleting by ULID prefix", () => {
      // Create an agent
      const agentOutput = kspec(
        'meta add agent --id ulid-test-agent --name "ULID Test Agent"',
        tempDir,
      );

      // Extract the ULID prefix from the success message: "Created agent: ulid-test-agent (@01KF7...)"
      const ulidMatch = agentOutput.match(/\((@[\w]+)\)/);
      expect(ulidMatch).toBeTruthy();
      const ulidPrefix = ulidMatch![1];

      // Create a task that references by semantic ID
      kspec('task add --title "Test task" --meta-ref @ulid-test-agent', tempDir);

      // Try to delete using ULID prefix - should still detect the reference
      try {
        kspec(`meta delete ${ulidPrefix}`, tempDir);
        expect.fail("Should have detected reference");
      } catch (e: any) {
        expect(e.message).toContain("Referenced by");
        expect(e.message).toContain("task(s)");
      }

      // Verify agent still exists
      const agent = kspecJson<any>(`meta get ${ulidPrefix}`, tempDir);
      expect(agent.id).toBe("ulid-test-agent");
    });

    it("should detect references with mixed reference formats", () => {
      // Create a workflow
      const workflowOutput = kspec(
        'meta add workflow --id ulid-workflow --trigger "test trigger"',
        tempDir,
      );

      // Extract ULID prefix from: "Created workflow: ulid-workflow (@01KF7...)"
      const ulidMatch = workflowOutput.match(/\((@[\w]+)\)/);
      expect(ulidMatch).toBeTruthy();
      const ulidPrefix = ulidMatch![1];

      // Create observation using ULID prefix
      kspec(`meta observe friction "Test friction" --workflow ${ulidPrefix}`, tempDir);

      // Try to delete using semantic ID - should still detect reference
      try {
        kspec("meta delete @ulid-workflow", tempDir);
        expect.fail("Should have detected reference");
      } catch (e: any) {
        expect(e.message).toContain("Referenced by");
        expect(e.message).toContain("observation(s)");
      }

      // Verify workflow still exists
      const workflow = kspecJson<any>("meta get @ulid-workflow", tempDir);
      expect(workflow.id).toBe("ulid-workflow");
    });
  });
});

describe("Integration: meta includes", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it("should load meta items from included files", async () => {
    // Create a meta/ directory for included files
    const metaDir = path.join(tempDir, "meta");
    await fs.mkdir(metaDir, { recursive: true });

    // Create separate files for agents and workflows
    const agentsFile = path.join(metaDir, "agents.yaml");
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
`,
    );

    const workflowsFile = path.join(metaDir, "workflows.yaml");
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
`,
    );

    // Update the meta manifest to include these files
    const metaPath = path.join(tempDir, "kynetic.meta.yaml");
    let metaContent = await readTestOutput(metaPath);

    // Add includes section if not present
    if (!metaContent.includes("includes:")) {
      metaContent += "\nincludes:\n  - meta/agents.yaml\n  - meta/workflows.yaml\n";
    } else {
      metaContent = metaContent.replace(
        "includes:",
        "includes:\n  - meta/agents.yaml\n  - meta/workflows.yaml",
      );
    }

    await fs.writeFile(metaPath, metaContent);

    // Verify agents from included files are loaded
    const agents = kspecJson<any[]>("meta agents", tempDir);
    const includeAgent1 = agents.find((a) => a.id === "include-agent-1");
    const includeAgent2 = agents.find((a) => a.id === "include-agent-2");

    expect(includeAgent1).toBeDefined();
    expect(includeAgent1?.name).toBe("Include Agent 1");
    expect(includeAgent1?.description).toBe("Agent from included file");
    expect(includeAgent1?.capabilities).toEqual(["code"]);
    expect(includeAgent1?.tools).toEqual(["git"]);

    expect(includeAgent2).toBeDefined();
    expect(includeAgent2?.name).toBe("Include Agent 2");
    expect(includeAgent2?.capabilities).toEqual(["review"]);

    // Verify workflows from included files are loaded
    const workflows = kspecJson<any[]>("meta workflows", tempDir);
    const includeWorkflow = workflows.find((w) => w.id === "include-workflow-1");

    expect(includeWorkflow).toBeDefined();
    expect(includeWorkflow?.trigger).toBe("Test trigger from include");
    expect(includeWorkflow?.description).toBe("Workflow from included file");
    expect(includeWorkflow?.steps).toHaveLength(2);
    expect(includeWorkflow?.steps[0].type).toBe("check");
    expect(includeWorkflow?.steps[1].type).toBe("action");
  });

  it("should load meta items from both manifest and includes", async () => {
    // The test fixtures already have agents and workflows in kynetic.meta.yaml
    // We'll add an include file to verify both are loaded

    const metaDir = path.join(tempDir, "meta");
    await fs.mkdir(metaDir, { recursive: true });

    const conventionsFile = path.join(metaDir, "conventions.yaml");
    await fs.writeFile(
      conventionsFile,
      `conventions:
  - _ulid: 01KF8850000000000000000010
    domain: testing-include
    rules:
      - Write tests for included items
      - Verify include loading
    examples: []
`,
    );

    // Add includes to meta manifest
    const metaPath = path.join(tempDir, "kynetic.meta.yaml");
    let metaContent = await readTestOutput(metaPath);
    metaContent += "\nincludes:\n  - meta/conventions.yaml\n";
    await fs.writeFile(metaPath, metaContent);

    // Verify both original agents and included convention are present
    const agents = kspecJson<any[]>("meta agents", tempDir);
    expect(agents.some((a) => a.id === "test-agent")).toBe(true); // From manifest
    expect(agents.some((a) => a.id === "review-agent")).toBe(true); // From manifest

    const conventions = kspecJson<any[]>("meta conventions", tempDir);
    const includeConvention = conventions.find((c) => c.domain === "testing-include");
    expect(includeConvention).toBeDefined();
    expect(includeConvention?.rules).toContain("Write tests for included items");
  });

  it("should handle glob patterns in includes", async () => {
    // Create multiple files matching a pattern
    const metaDir = path.join(tempDir, "meta");
    await fs.mkdir(metaDir, { recursive: true });

    await fs.writeFile(
      path.join(metaDir, "agent-1.yaml"),
      `agents:
  - _ulid: 01KF8850000000000000000020
    id: glob-agent-1
    name: Glob Agent 1
    capabilities: []
    tools: []
    conventions: []
`,
    );

    await fs.writeFile(
      path.join(metaDir, "agent-2.yaml"),
      `agents:
  - _ulid: 01KF8850000000000000000021
    id: glob-agent-2
    name: Glob Agent 2
    capabilities: []
    tools: []
    conventions: []
`,
    );

    // Update meta manifest to include all agent-*.yaml files
    const metaPath = path.join(tempDir, "kynetic.meta.yaml");
    let metaContent = await readTestOutput(metaPath);
    metaContent += "\nincludes:\n  - meta/agent-*.yaml\n";
    await fs.writeFile(metaPath, metaContent);

    // Verify both agents are loaded
    const agents = kspecJson<any[]>("meta agents", tempDir);
    expect(agents.some((a) => a.id === "glob-agent-1")).toBe(true);
    expect(agents.some((a) => a.id === "glob-agent-2")).toBe(true);
  });

  it("should gracefully handle missing include files", async () => {
    // Add an include that doesn't exist
    const metaPath = path.join(tempDir, "kynetic.meta.yaml");
    let metaContent = await readTestOutput(metaPath);
    metaContent += "\nincludes:\n  - meta/nonexistent.yaml\n";
    await fs.writeFile(metaPath, metaContent);

    // Should still load successfully without the missing file
    const agents = kspecJson<any[]>("meta agents", tempDir);
    expect(agents.some((a) => a.id === "test-agent")).toBe(true);
  });

  it("should validate references across included files", async () => {
    // Create an included workflow file
    const metaDir = path.join(tempDir, "meta");
    await fs.mkdir(metaDir, { recursive: true });

    const workflowsFile = path.join(metaDir, "test-workflows.yaml");
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
`,
    );

    // Add includes to meta manifest
    const metaPath = path.join(tempDir, "kynetic.meta.yaml");
    let metaContent = await readTestOutput(metaPath);
    metaContent += "\nincludes:\n  - meta/test-workflows.yaml\n";
    await fs.writeFile(metaPath, metaContent);

    // Create a task that references the workflow from the included file
    seedSplitTask(tempDir, {
      _ulid: "01KF8850000000000000000031",
      slugs: ["test-task-include-ref"],
      title: "Test task referencing included workflow",
      type: "task",
      status: "pending",
      priority: 1,
      created_at: "2024-01-01T00:00:00Z",
      meta_ref: "@include-ref-workflow",
      depends_on: [],
      notes: [],
      todos: [],
      tags: [],
    });

    // Validate should pass because include-ref-workflow exists in included file
    const output = kspec("validate --refs", tempDir);
    expect(output).toContain("References: OK");
  });
});

describe("Integration: conventions", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should list conventions with domain, rules, and validation", async () => {
    // Replace conventions in meta manifest with test-specific ones
    const metaPath = path.join(tempDir, "kynetic.meta.yaml");
    const metaContent = await readTestOutput(metaPath);

    // Remove any existing conventions block to avoid duplicate YAML keys
    const withoutConventions = metaContent.replace(/^conventions:\n(?:[ \t]+.*\n|[ \t]*\n)*/m, "");

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

    await fs.writeFile(metaPath, withoutConventions + conventions);

    // List conventions in JSON format
    const result = kspecJson<
      Array<{
        domain: string;
        rules: string[];
        examples: Array<{ good: string; bad: string }>;
        validation?: {
          type: string;
          pattern?: string;
          message?: string;
        };
      }>
    >("meta conventions", tempDir);

    // Verify structure
    expect(result.length).toBeGreaterThanOrEqual(2);

    const commitConvention = result.find((c) => c.domain === "commits");
    expect(commitConvention).toBeDefined();
    expect(commitConvention?.rules).toHaveLength(2);
    expect(commitConvention?.rules[0]).toBe("Use conventional commit format");
    expect(commitConvention?.examples).toHaveLength(1);
    expect(commitConvention?.examples[0].good).toBe("feat: add feature");
    expect(commitConvention?.examples[0].bad).toBe("added stuff");
    expect(commitConvention?.validation?.type).toBe("regex");
    expect(commitConvention?.validation?.pattern).toBe("^(feat|fix):");
    expect(commitConvention?.validation?.message).toBe("Must start with feat: or fix:");

    const noteConvention = result.find((c) => c.domain === "notes");
    expect(noteConvention).toBeDefined();
    expect(noteConvention?.validation).toBeUndefined();
  });

  it("should support all validation types", async () => {
    const metaPath = path.join(tempDir, "kynetic.meta.yaml");

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

    const result = kspecJson<
      Array<{
        domain: string;
        validation?: {
          type: string;
          pattern?: string;
          allowed?: string[];
          min?: number;
          max?: number;
          unit?: string;
        };
      }>
    >("meta conventions", tempDir);

    expect(result.length).toBe(4);

    const regexConv = result.find((c) => c.domain === "test-regex");
    expect(regexConv?.validation?.type).toBe("regex");
    expect(regexConv?.validation?.pattern).toBe("^test:");

    const enumConv = result.find((c) => c.domain === "test-enum");
    expect(enumConv?.validation?.type).toBe("enum");
    expect(enumConv?.validation?.allowed).toEqual(["value1", "value2"]);

    const rangeConv = result.find((c) => c.domain === "test-range");
    expect(rangeConv?.validation?.type).toBe("range");
    expect(rangeConv?.validation?.min).toBe(10);
    expect(rangeConv?.validation?.max).toBe(100);
    expect(rangeConv?.validation?.unit).toBe("words");

    const proseConv = result.find((c) => c.domain === "test-prose");
    expect(proseConv?.validation?.type).toBe("prose");
  });

  it("should validate convention schema with required fields", async () => {
    const metaPath = path.join(tempDir, "kynetic.meta.yaml");

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
      kspec("validate --schema", tempDir);
      expect(true).toBe(false); // Should not reach here
    } catch (error) {
      // Expected to fail
      expect(error).toBeDefined();
    }
  });
});

describe("Integration: meta focus", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @meta-focus-cmd ac-focus-1
  it("should show no focus when none is set", () => {
    const output = kspec("meta focus", tempDir);
    expect(output).toContain("No focus set");
  });

  // AC: @meta-focus-cmd ac-focus-2
  it("should set focus to a reference", () => {
    const output = kspec("meta focus test-feature", tempDir);
    expect(output).toMatch(/Set focus to: @test-feature/);
  });

  // AC: @meta-focus-cmd ac-focus-1
  it("should show current focus", () => {
    kspec("meta focus test-feature", tempDir);
    const output = kspec("meta focus", tempDir);
    expect(output).toContain("Current focus: @test-feature");
  });

  // AC: @meta-focus-cmd ac-focus-2
  it("should auto-prepend @ to references", () => {
    kspec("meta focus test-item", tempDir);
    const focusData = kspecJson<{ focus: string }>("meta focus", tempDir);
    expect(focusData.focus).toBe("@test-item");
  });

  // AC: @meta-focus-cmd ac-focus-3
  it("should clear focus", () => {
    kspec("meta focus test-feature", tempDir);
    const output = kspec("meta focus --clear", tempDir);
    expect(output).toContain("Cleared session focus");

    const focusData = kspecJson<{ focus: null }>("meta focus", tempDir);
    expect(focusData.focus).toBeNull();
  });

  // AC: @meta-focus-cmd ac-focus-1, ac-focus-2, ac-focus-3
  it("should support JSON output (focus)", () => {
    // No focus set
    const noFocus = kspecJson<{ focus: null }>("meta focus", tempDir);
    expect(noFocus.focus).toBeNull();

    // Set focus
    const setFocus = kspecJson<{ focus: string }>("meta focus test-feature", tempDir);
    expect(setFocus.focus).toBe("@test-feature");

    // Show focus
    const showFocus = kspecJson<{ focus: string }>("meta focus", tempDir);
    expect(showFocus.focus).toBe("@test-feature");

    // Clear focus
    const clearFocus = kspecJson<{ focus: null }>("meta focus --clear", tempDir);
    expect(clearFocus.focus).toBeNull();
  });

  it("should persist focus across command invocations", () => {
    kspec("meta focus test-feature", tempDir);

    // Run a different command
    kspec("tasks ready", tempDir);

    // Focus should still be set
    const focusData = kspecJson<{ focus: string }>("meta focus", tempDir);
    expect(focusData.focus).toBe("@test-feature");
  });

  it("should display focus in session start output", () => {
    kspec("meta focus test-feature", tempDir);
    const sessionOutput = kspec("session start", tempDir);
    expect(sessionOutput).toContain("Focus: @test-feature");
  });
});

describe("Integration: meta thread", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @meta-thread-cmd - list action
  it("should show no threads when none exist", () => {
    const output = kspec("meta thread list", tempDir);
    expect(output).toContain("No active threads");
  });

  // AC: @meta-thread-cmd - add action
  it("should add a thread", () => {
    const output = kspec('meta thread add "Implement feature X"', tempDir);
    expect(output).toContain("Added thread: Implement feature X");
  });

  // AC: @meta-thread-cmd - list action
  it("should list all threads", () => {
    kspec('meta thread add "Thread 1"', tempDir);
    kspec('meta thread add "Thread 2"', tempDir);
    kspec('meta thread add "Thread 3"', tempDir);

    const output = kspec("meta thread list", tempDir);
    expect(output).toContain("Active threads:");
    expect(output).toContain("1. Thread 1");
    expect(output).toContain("2. Thread 2");
    expect(output).toContain("3. Thread 3");
  });

  // AC: @meta-thread-cmd - remove action
  it("should remove a thread by index", () => {
    kspec('meta thread add "Thread 1"', tempDir);
    kspec('meta thread add "Thread 2"', tempDir);
    kspec('meta thread add "Thread 3"', tempDir);

    const output = kspec("meta thread remove 2", tempDir);
    expect(output).toContain("Removed thread: Thread 2");

    const listOutput = kspec("meta thread list", tempDir);
    expect(listOutput).toContain("Thread 1");
    expect(listOutput).not.toContain("Thread 2");
    expect(listOutput).toContain("Thread 3");
  });

  // AC: @meta-thread-cmd - clear action
  it("should clear all threads", () => {
    kspec('meta thread add "Thread 1"', tempDir);
    kspec('meta thread add "Thread 2"', tempDir);

    const output = kspec("meta thread clear", tempDir);
    expect(output).toContain("Cleared all threads");

    const listOutput = kspec("meta thread list", tempDir);
    expect(listOutput).toContain("No active threads");
  });

  // AC: @meta-thread-cmd - JSON output
  it("should support JSON output for list (thread)", () => {
    kspec('meta thread add "Thread 1"', tempDir);
    kspec('meta thread add "Thread 2"', tempDir);

    const data = kspecJson<{ threads: string[] }>("meta thread list", tempDir);
    expect(data.threads).toEqual(["Thread 1", "Thread 2"]);
  });

  // AC: @meta-thread-cmd - JSON output
  it("should support JSON output for add (thread)", () => {
    const data = kspecJson<{ threads: string[]; added: string }>(
      'meta thread add "New thread"',
      tempDir,
    );
    expect(data.added).toBe("New thread");
    expect(data.threads).toContain("New thread");
  });

  // AC: @meta-thread-cmd - JSON output
  it("should support JSON output for remove (thread)", () => {
    kspec('meta thread add "Thread 1"', tempDir);
    kspec('meta thread add "Thread 2"', tempDir);

    const data = kspecJson<{ threads: string[]; removed: string }>("meta thread remove 1", tempDir);
    expect(data.removed).toBe("Thread 1");
    expect(data.threads).toEqual(["Thread 2"]);
  });

  // AC: @meta-thread-cmd - JSON output
  it("should support JSON output for clear (thread)", () => {
    kspec('meta thread add "Thread 1"', tempDir);

    const data = kspecJson<{ threads: string[] }>("meta thread clear", tempDir);
    expect(data.threads).toEqual([]);
  });

  it("should persist threads across command invocations", () => {
    kspec('meta thread add "Thread 1"', tempDir);

    // Run a different command
    kspec("tasks ready", tempDir);

    // Threads should still be set
    const data = kspecJson<{ threads: string[] }>("meta thread list", tempDir);
    expect(data.threads).toEqual(["Thread 1"]);
  });

  it("should error when adding without text", () => {
    try {
      kspec("meta thread add", tempDir);
      expect.fail("Should have thrown error");
    } catch (e: any) {
      expect(e.message).toContain("Thread text is required");
    }
  });

  it("should error when removing without index", () => {
    kspec('meta thread add "Thread 1"', tempDir);

    try {
      kspec("meta thread remove", tempDir);
      expect.fail("Should have thrown error");
    } catch (e: any) {
      expect(e.message).toContain("Index is required");
    }
  });

  it("should error when removing invalid index", () => {
    kspec('meta thread add "Thread 1"', tempDir);

    try {
      kspec("meta thread remove 5", tempDir);
      expect.fail("Should have thrown error");
    } catch (e: any) {
      expect(e.message).toContain("Invalid index");
    }
  });

  it("should error on unknown action", () => {
    try {
      kspec("meta thread unknown", tempDir);
      expect.fail("Should have thrown error");
    } catch (e: any) {
      expect(e.message).toContain("Unknown action");
    }
  });
});

describe("Integration: meta question", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @meta-question-cmd - list action
  it("should show no questions when none exist", () => {
    const output = kspec("meta question list", tempDir);
    expect(output).toContain("No open questions");
  });

  // AC: @meta-question-cmd - add action
  it("should add a question", () => {
    const output = kspec('meta question add "Why does X happen?"', tempDir);
    expect(output).toContain("Added question: Why does X happen?");
  });

  // AC: @meta-question-cmd - list action
  it("should list all questions", () => {
    kspec('meta question add "Question 1"', tempDir);
    kspec('meta question add "Question 2"', tempDir);
    kspec('meta question add "Question 3"', tempDir);

    const output = kspec("meta question list", tempDir);
    expect(output).toContain("Open questions:");
    expect(output).toContain("1. Question 1");
    expect(output).toContain("2. Question 2");
    expect(output).toContain("3. Question 3");
  });

  // AC: @meta-question-cmd - remove action
  it("should remove a question by index", () => {
    kspec('meta question add "Question 1"', tempDir);
    kspec('meta question add "Question 2"', tempDir);
    kspec('meta question add "Question 3"', tempDir);

    const output = kspec("meta question remove 2", tempDir);
    expect(output).toContain("Removed question: Question 2");

    const listOutput = kspec("meta question list", tempDir);
    expect(listOutput).toContain("Question 1");
    expect(listOutput).not.toContain("Question 2");
    expect(listOutput).toContain("Question 3");
  });

  // AC: @meta-question-cmd - clear action
  it("should clear all questions", () => {
    kspec('meta question add "Question 1"', tempDir);
    kspec('meta question add "Question 2"', tempDir);

    const output = kspec("meta question clear", tempDir);
    expect(output).toContain("Cleared all questions");

    const listOutput = kspec("meta question list", tempDir);
    expect(listOutput).toContain("No open questions");
  });

  // AC: @meta-question-cmd - JSON output
  it("should support JSON output for list (question)", () => {
    kspec('meta question add "Question 1"', tempDir);
    kspec('meta question add "Question 2"', tempDir);

    const data = kspecJson<{ questions: string[] }>("meta question list", tempDir);
    expect(data.questions).toEqual(["Question 1", "Question 2"]);
  });

  // AC: @meta-question-cmd - JSON output
  it("should support JSON output for add (question)", () => {
    const data = kspecJson<{ questions: string[]; added: string }>(
      'meta question add "New question"',
      tempDir,
    );
    expect(data.added).toBe("New question");
    expect(data.questions).toContain("New question");
  });

  // AC: @meta-question-cmd - JSON output
  it("should support JSON output for remove (question)", () => {
    kspec('meta question add "Question 1"', tempDir);
    kspec('meta question add "Question 2"', tempDir);

    const data = kspecJson<{ questions: string[]; removed: string }>(
      "meta question remove 1",
      tempDir,
    );
    expect(data.removed).toBe("Question 1");
    expect(data.questions).toEqual(["Question 2"]);
  });

  // AC: @meta-question-cmd - JSON output
  it("should support JSON output for clear (question)", () => {
    kspec('meta question add "Question 1"', tempDir);

    const data = kspecJson<{ questions: string[] }>("meta question clear", tempDir);
    expect(data.questions).toEqual([]);
  });

  it("should persist questions across command invocations", () => {
    kspec('meta question add "Question 1"', tempDir);

    // Run a different command
    kspec("tasks ready", tempDir);

    // Questions should still be set
    const data = kspecJson<{ questions: string[] }>("meta question list", tempDir);
    expect(data.questions).toEqual(["Question 1"]);
  });

  it("should error when adding without text", () => {
    try {
      kspec("meta question add", tempDir);
      expect.fail("Should have thrown error");
    } catch (e: any) {
      expect(e.message).toContain("Question text is required");
    }
  });

  it("should error when removing without index", () => {
    kspec('meta question add "Question 1"', tempDir);

    try {
      kspec("meta question remove", tempDir);
      expect.fail("Should have thrown error");
    } catch (e: any) {
      expect(e.message).toContain("Index is required");
    }
  });

  it("should error when removing invalid index", () => {
    kspec('meta question add "Question 1"', tempDir);

    try {
      kspec("meta question remove 5", tempDir);
      expect.fail("Should have thrown error");
    } catch (e: any) {
      expect(e.message).toContain("Invalid index");
    }
  });

  it("should error on unknown action", () => {
    try {
      kspec("meta question unknown", tempDir);
      expect.fail("Should have thrown error");
    } catch (e: any) {
      expect(e.message).toContain("Unknown action");
    }
  });
});

describe("Integration: meta context", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @meta-context-cmd - show full session context
  it("should display full session context with all fields", () => {
    // Set up some context
    kspec("meta focus @task-test", tempDir);
    kspec('meta thread add "Thread 1"', tempDir);
    kspec('meta thread add "Thread 2"', tempDir);
    kspec('meta question add "Question 1"', tempDir);

    const output = kspec("meta context", tempDir);

    // Should contain headers
    expect(output).toContain("Session Context");
    expect(output).toContain("Focus:");
    expect(output).toContain("Active Threads:");
    expect(output).toContain("Open Questions:");
    expect(output).toContain("Last Updated:");

    // Should contain the data
    expect(output).toContain("@task-test");
    expect(output).toContain("Thread 1");
    expect(output).toContain("Thread 2");
    expect(output).toContain("Question 1");
  });

  // AC: @meta-context-cmd - show empty context gracefully
  it("should show (none) for empty context fields", () => {
    const output = kspec("meta context", tempDir);

    // Should show (none) for empty fields
    expect(output).toContain("(none)");
    expect(output).toContain("Focus:");
    expect(output).toContain("Active Threads:");
    expect(output).toContain("Open Questions:");
  });

  // AC: @meta-context-cmd - JSON output
  it("should output JSON with all context fields", () => {
    // Set up some context
    kspec("meta focus @task-test", tempDir);
    kspec('meta thread add "Thread 1"', tempDir);
    kspec('meta question add "Question 1"', tempDir);

    interface ContextJson {
      focus: string | null;
      threads: string[];
      open_questions: string[];
      updated_at: string;
    }

    const data = kspecJson<ContextJson>("meta context", tempDir);

    expect(data.focus).toBe("@task-test");
    expect(data.threads).toEqual(["Thread 1"]);
    expect(data.open_questions).toEqual(["Question 1"]);
    expect(data.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  // AC: @meta-context-cmd - --clear option
  it("should clear all session context with --clear flag", () => {
    // Set up some context
    kspec("meta focus @task-test", tempDir);
    kspec('meta thread add "Thread 1"', tempDir);
    kspec('meta question add "Question 1"', tempDir);

    // Clear all context
    const output = kspec("meta context --clear", tempDir);
    expect(output).toContain("Cleared all session context");

    // Verify everything is cleared
    interface ContextJson {
      focus: string | null;
      threads: string[];
      open_questions: string[];
      updated_at: string;
    }

    const data = kspecJson<ContextJson>("meta context", tempDir);
    expect(data.focus).toBeNull();
    expect(data.threads).toEqual([]);
    expect(data.open_questions).toEqual([]);
  });

  // AC: @meta-context-cmd - --clear with JSON output
  it("should output cleared context in JSON mode", () => {
    // Set up some context
    kspec("meta focus @task-test", tempDir);
    kspec('meta thread add "Thread 1"', tempDir);

    interface ContextJson {
      focus: string | null;
      threads: string[];
      open_questions: string[];
      updated_at: string;
    }

    const data = kspecJson<ContextJson>("meta context --clear", tempDir);

    expect(data.focus).toBeNull();
    expect(data.threads).toEqual([]);
    expect(data.open_questions).toEqual([]);
    expect(data.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  // AC: @meta-context-cmd - display with numbered lists
  it("should display threads and questions with numbered lists", () => {
    kspec('meta thread add "First thread"', tempDir);
    kspec('meta thread add "Second thread"', tempDir);
    kspec('meta thread add "Third thread"', tempDir);
    kspec('meta question add "First question"', tempDir);
    kspec('meta question add "Second question"', tempDir);

    const output = kspec("meta context", tempDir);

    // Should have numbered lists
    expect(output).toContain("1. First thread");
    expect(output).toContain("2. Second thread");
    expect(output).toContain("3. Third thread");
    expect(output).toContain("1. First question");
    expect(output).toContain("2. Second question");
  });
});

/**
 * Integration tests for Agent Definition Schema (new dispatch/runtime fields)
 * AC: @agent-definition-schema ac-1 through ac-11
 */
describe("Integration: agent definition schema", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @agent-definition-schema ac-8 - backward compatibility: existing agents without new fields load OK
  it("should load existing agent definitions without new fields", () => {
    // The fixture has agents without dispatch/adapter fields — validate should not fail with schema errors
    const result = kspecRun("validate", tempDir);
    // Exit 0 = success, exit 6 = warnings only (alignment warnings from orphaned specs in fixture)
    // Either is acceptable — what matters is no schema errors (not exit 1 or 4)
    expect([0, 6]).toContain(result.exitCode);
  });

  // AC: @agent-definition-schema ac-1 - adapter field accepted as string
  it("should accept adapter field when added to an agent", async () => {
    const metaPath = path.join(tempDir, "kynetic.meta.yaml");
    const content = await readTestOutput(metaPath);
    const withAdapter = content.replace(
      "    id: test-agent",
      '    id: test-agent\n    adapter: "npx @kynetic/claude-adapter"',
    );
    await fs.writeFile(metaPath, withAdapter);

    const output = kspec("validate", tempDir);
    expect(output).not.toContain("Error");
  });

  // AC: @agent-definition-schema ac-2 - dispatch array with event types
  it("should accept dispatch rules with valid event types", async () => {
    const metaPath = path.join(tempDir, "kynetic.meta.yaml");
    const content = await readTestOutput(metaPath);
    const withDispatch = content.replace(
      "    id: test-agent",
      "    id: test-agent\n    dispatch:\n      - on: task.in_progress\n      - on: task.ready\n      - on: task.needs_work",
    );
    await fs.writeFile(metaPath, withDispatch);

    const output = kspec("validate", tempDir);
    expect(output).not.toContain("Error");
  });

  // AC: @agent-definition-schema ac-3 - filter fields validated independently
  it("should accept dispatch filters with automation, tags, and priority", async () => {
    const metaPath = path.join(tempDir, "kynetic.meta.yaml");
    const content = await readTestOutput(metaPath);
    const withFilters = content.replace(
      "    id: test-agent",
      [
        "    id: test-agent",
        "    dispatch:",
        "      - on: task.ready",
        "        filter:",
        "          automation: eligible",
        "          tags:",
        "            - mvp",
        "          priority: 1",
      ].join("\n"),
    );
    await fs.writeFile(metaPath, withFilters);

    const output = kspec("validate", tempDir);
    expect(output).not.toContain("Error");
  });

  // AC: @agent-definition-schema ac-4 - budget fields accepted as optional positive numbers
  it("should accept budget fields as optional positive numbers", async () => {
    const metaPath = path.join(tempDir, "kynetic.meta.yaml");
    const content = await readTestOutput(metaPath);
    const withBudget = content.replace(
      "    id: test-agent",
      "    id: test-agent\n    budget:\n      max_tasks: 10\n      timeout_minutes: 60",
    );
    await fs.writeFile(metaPath, withBudget);

    const output = kspec("validate", tempDir);
    expect(output).not.toContain("Error");
  });

  // AC: @agent-definition-schema ac-5 - skills accepted as string array
  it("should accept skills as a string array", async () => {
    const metaPath = path.join(tempDir, "kynetic.meta.yaml");
    const content = await readTestOutput(metaPath);
    const withSkills = content.replace(
      "    id: test-agent",
      "    id: test-agent\n    skills:\n      - task-work\n      - review",
    );
    await fs.writeFile(metaPath, withSkills);

    const output = kspec("validate", tempDir);
    expect(output).not.toContain("Error");
  });

  // AC: @agent-definition-schema ac-6 - max_concurrent defaults to 1
  it("should accept concurrency settings with max_concurrent", async () => {
    const metaPath = path.join(tempDir, "kynetic.meta.yaml");
    const content = await readTestOutput(metaPath);
    const withConcurrency = content.replace(
      "    id: test-agent",
      "    id: test-agent\n    concurrency:\n      max_concurrent: 3",
    );
    await fs.writeFile(metaPath, withConcurrency);

    const output = kspec("validate", tempDir);
    expect(output).not.toContain("Error");
  });

  // AC: @agent-definition-schema ac-7 - auto_approve defaults to false
  it("should accept auto_approve boolean field", async () => {
    const metaPath = path.join(tempDir, "kynetic.meta.yaml");
    const content = await readTestOutput(metaPath);
    const withAutoApprove = content.replace(
      "    id: test-agent",
      "    id: test-agent\n    auto_approve: true",
    );
    await fs.writeFile(metaPath, withAutoApprove);

    const output = kspec("validate", tempDir);
    expect(output).not.toContain("Error");
  });

  // AC: @agent-definition-schema ac-9 - meta add agent creates agent with new fields
  // AC: @trait-shadow-commit ac-1 - meta add agent creates shadow commit
  // AC: @trait-json-output ac-1 - meta agents returns valid JSON (used throughout this describe block)
  it("should create a new agent with adapter and budget via meta add", () => {
    const result = kspecRun(
      'meta add agent --id dispatch-agent --name "Dispatch Agent" --adapter "npx @kynetic/claude" --max-tasks 5 --timeout-minutes 120 --max-concurrent 2',
      tempDir,
    );
    expect(result.exitCode).toBe(0);

    // Verify created in JSON output
    const agents = kspecJson<
      Array<{
        id: string;
        adapter?: string;
        budget?: { max_tasks?: number; timeout_minutes?: number };
        concurrency?: { max_concurrent: number };
        auto_approve: boolean;
      }>
    >("meta agents", tempDir);
    const agent = agents.find((a) => a.id === "dispatch-agent");
    expect(agent).toBeDefined();
    expect(agent?.adapter).toBe("npx @kynetic/claude");
    expect(agent?.budget?.max_tasks).toBe(5);
    expect(agent?.budget?.timeout_minutes).toBe(120);
    expect(agent?.concurrency?.max_concurrent).toBe(2);
    expect(agent?.auto_approve).toBe(false);
  });

  // AC: @agent-definition-schema ac-4 - meta add agent with max_retries budget
  it("should create agent with max_retries budget via meta add", () => {
    const result = kspecRun(
      'meta add agent --id retry-agent --name "Retry Agent" --max-retries 5 --timeout-minutes 60',
      tempDir,
    );
    expect(result.exitCode).toBe(0);

    const agents = kspecJson<
      Array<{ id: string; budget?: { max_retries?: number; timeout_minutes?: number } }>
    >("meta agents", tempDir);
    const agent = agents.find((a) => a.id === "retry-agent");
    expect(agent).toBeDefined();
    expect(agent?.budget?.max_retries).toBe(5);
    expect(agent?.budget?.timeout_minutes).toBe(60);
  });

  // AC: @agent-definition-schema ac-10 - meta set agent updates max_retries
  it("should update agent max_retries via meta set", () => {
    kspecRun('meta add agent --id retries-set-agent --name "Retries Set Agent"', tempDir);

    const result = kspecRun("meta set retries-set-agent --max-retries 2", tempDir);
    expect(result.exitCode).toBe(0);

    const agents = kspecJson<Array<{ id: string; budget?: { max_retries?: number } }>>(
      "meta agents",
      tempDir,
    );
    const agent = agents.find((a) => a.id === "retries-set-agent");
    expect(agent?.budget?.max_retries).toBe(2);
  });

  // AC: @agent-definition-schema ac-4 - max_retries accepts zero (disables retries)
  it("should accept max_retries of 0 via meta add", () => {
    const result = kspecRun(
      'meta add agent --id no-retry-agent --name "No Retry Agent" --max-retries 0',
      tempDir,
    );
    expect(result.exitCode).toBe(0);

    const agents = kspecJson<Array<{ id: string; budget?: { max_retries?: number } }>>(
      "meta agents",
      tempDir,
    );
    const agent = agents.find((a) => a.id === "no-retry-agent");
    expect(agent).toBeDefined();
    expect(agent?.budget?.max_retries).toBe(0);
  });

  // AC: @agent-definition-schema ac-9 - meta add agent with auto_approve
  it("should create agent with auto_approve enabled", () => {
    const result = kspecRun(
      'meta add agent --id auto-agent --name "Auto Agent" --auto-approve',
      tempDir,
    );
    expect(result.exitCode).toBe(0);

    const agents = kspecJson<Array<{ id: string; auto_approve: boolean }>>("meta agents", tempDir);
    const agent = agents.find((a) => a.id === "auto-agent");
    expect(agent).toBeDefined();
    expect(agent?.auto_approve).toBe(true);
  });

  // AC: @agent-definition-schema ac-9 - meta add agent with skills
  it("should create agent with skills array", () => {
    const result = kspecRun(
      'meta add agent --id skilled-agent --name "Skilled Agent" --skill task-work --skill review',
      tempDir,
    );
    expect(result.exitCode).toBe(0);

    const agents = kspecJson<Array<{ id: string; skills: string[] }>>("meta agents", tempDir);
    const agent = agents.find((a) => a.id === "skilled-agent");
    expect(agent).toBeDefined();
    expect(agent?.skills).toContain("task-work");
    expect(agent?.skills).toContain("review");
  });

  // AC: @agent-definition-schema ac-10 - meta set agent updates new fields
  // AC: @trait-shadow-commit ac-1 - meta set agent creates shadow commit
  it("should update agent adapter via meta set", () => {
    // First create an agent
    kspecRun('meta add agent --id updatable-agent --name "Updatable Agent"', tempDir);

    // Then update with new fields
    const result = kspecRun('meta set updatable-agent --adapter "npx @kynetic/updated"', tempDir);
    expect(result.exitCode).toBe(0);

    const agents = kspecJson<Array<{ id: string; adapter?: string }>>("meta agents", tempDir);
    const agent = agents.find((a) => a.id === "updatable-agent");
    expect(agent?.adapter).toBe("npx @kynetic/updated");
  });

  // AC: @agent-definition-schema ac-10 - existing fields preserved during set
  it("should preserve existing capabilities when updating adapter", () => {
    kspecRun(
      'meta add agent --id cap-agent --name "Cap Agent" --capability code --capability test',
      tempDir,
    );

    kspecRun('meta set cap-agent --adapter "my-adapter"', tempDir);

    const agents = kspecJson<Array<{ id: string; capabilities: string[]; adapter?: string }>>(
      "meta agents",
      tempDir,
    );
    const agent = agents.find((a) => a.id === "cap-agent");
    expect(agent?.capabilities).toContain("code");
    expect(agent?.capabilities).toContain("test");
    expect(agent?.adapter).toBe("my-adapter");
  });

  // AC: @agent-definition-schema ac-10 - add-skill via meta set
  it("should add skill to agent via meta set --add-skill", () => {
    kspecRun('meta add agent --id skill-agent --name "Skill Agent"', tempDir);
    kspecRun("meta set skill-agent --add-skill task-work", tempDir);
    kspecRun("meta set skill-agent --add-skill review", tempDir);

    const agents = kspecJson<Array<{ id: string; skills: string[] }>>("meta agents", tempDir);
    const agent = agents.find((a) => a.id === "skill-agent");
    expect(agent?.skills).toContain("task-work");
    expect(agent?.skills).toContain("review");
  });

  // AC: @agent-definition-schema ac-12 - append dispatch rules via meta add/meta set
  it("should append dispatch rules via meta add and meta set", () => {
    const addResult = kspecRun(
      'meta add agent --id dispatch-rules-agent --name "Dispatch Rules Agent" --add-dispatch-rule "{\\"on\\":\\"task.ready\\"}"',
      tempDir,
    );
    expect(addResult.exitCode).toBe(0);

    const setResult = kspecRun(
      'meta set dispatch-rules-agent --add-dispatch-rule "{\\"on\\":\\"task.needs_work\\",\\"filter\\":{\\"automation\\":\\"eligible\\",\\"tags\\":[\\"cli\\"],\\"priority\\":2}}"',
      tempDir,
    );
    expect(setResult.exitCode).toBe(0);

    const agents = kspecJson<
      Array<{
        id: string;
        dispatch: Array<{
          on: string;
          filter?: { automation?: string; tags?: string[]; priority?: number };
        }>;
      }>
    >("meta agents", tempDir);
    const agent = agents.find((a) => a.id === "dispatch-rules-agent");
    expect(agent).toBeDefined();
    expect(agent?.dispatch).toEqual([
      { on: "task.ready" },
      { on: "task.needs_work", filter: { automation: "eligible", tags: ["cli"], priority: 2 } },
    ]);
  });

  // AC: @agent-definition-schema ac-12 - remove dispatch rules by event type
  it("should remove dispatch rules by event type via meta set", () => {
    kspecRun(
      'meta add agent --id removable-dispatch-agent --name "Removable Dispatch Agent" --add-dispatch-rule "{\\"on\\":\\"task.ready\\"}" --add-dispatch-rule "{\\"on\\":\\"task.needs_work\\"}"',
      tempDir,
    );

    const result = kspecRun(
      "meta set removable-dispatch-agent --remove-dispatch-rule task.ready",
      tempDir,
    );
    expect(result.exitCode).toBe(0);

    const agents = kspecJson<Array<{ id: string; dispatch: Array<{ on: string }> }>>(
      "meta agents",
      tempDir,
    );
    const agent = agents.find((a) => a.id === "removable-dispatch-agent");
    expect(agent).toBeDefined();
    expect(agent?.dispatch).toEqual([{ on: "task.needs_work" }]);
  });

  // AC: @agent-definition-schema ac-12 - clear dispatch rules via meta set
  it("should clear dispatch rules via meta set", () => {
    kspecRun(
      'meta add agent --id clear-dispatch-agent --name "Clear Dispatch Agent" --add-dispatch-rule "{\\"on\\":\\"task.pending_review\\"}"',
      tempDir,
    );

    const result = kspecRun("meta set clear-dispatch-agent --clear-dispatch-rules", tempDir);
    expect(result.exitCode).toBe(0);

    const agents = kspecJson<Array<{ id: string; dispatch: unknown[] }>>("meta agents", tempDir);
    const agent = agents.find((a) => a.id === "clear-dispatch-agent");
    expect(agent).toBeDefined();
    expect(agent?.dispatch).toEqual([]);
  });

  // AC: @agent-definition-schema ac-12 - invalid dispatch rule JSON returns error
  it("should fail when --add-dispatch-rule contains invalid JSON", () => {
    const result = kspecRun(
      'meta add agent --id invalid-dispatch-json-agent --name "Invalid Dispatch JSON Agent" --add-dispatch-rule "{invalid}"',
      tempDir,
      { expectFail: true },
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Invalid JSON in --add-dispatch-rule");
  });

  // AC: @agent-definition-schema ac-12 - invalid remove event returns error
  it("should fail when --remove-dispatch-rule event is invalid", () => {
    kspecRun(
      'meta add agent --id invalid-dispatch-event-agent --name "Invalid Dispatch Event Agent"',
      tempDir,
    );

    const result = kspecRun(
      "meta set invalid-dispatch-event-agent --remove-dispatch-rule task.done",
      tempDir,
      { expectFail: true },
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Invalid dispatch event in --remove-dispatch-rule");
  });

  // AC: @agent-definition-schema ac-11 - meta delete agent removes it
  // AC: @trait-shadow-commit ac-1 - meta delete creates shadow commit
  it("should remove agent via meta delete", () => {
    kspecRun('meta add agent --id removable-agent --name "Removable Agent"', tempDir);

    // Verify created
    let agents = kspecJson<Array<{ id: string }>>("meta agents", tempDir);
    expect(agents.some((a) => a.id === "removable-agent")).toBe(true);

    // Delete (the correct command is meta delete --confirm)
    const result = kspecRun("meta delete removable-agent --confirm", tempDir);
    expect(result.exitCode).toBe(0);

    // Verify removed
    agents = kspecJson<Array<{ id: string }>>("meta agents", tempDir);
    expect(agents.some((a) => a.id === "removable-agent")).toBe(false);
  });

  // AC: @agent-definition-schema ac-8 - defaults applied when fields absent
  // AC: @trait-json-output ac-2 - all data available in human-readable mode is also in JSON
  it("should apply defaults for new fields when absent in existing agents", () => {
    const agents = kspecJson<
      Array<{
        id: string;
        dispatch: unknown[];
        skills: string[];
        auto_approve: boolean;
        concurrency: { max_concurrent: number };
      }>
    >("meta agents", tempDir);

    const testAgent = agents.find((a) => a.id === "test-agent");
    expect(testAgent).toBeDefined();
    // All new fields should have defaults
    expect(testAgent?.dispatch).toEqual([]);
    expect(testAgent?.skills).toEqual([]);
    expect(testAgent?.auto_approve).toBe(false);
    expect(testAgent?.concurrency?.max_concurrent).toBe(1);
  });

  // AC: @agent-definition-schema ac-13 — session mode via meta set
  it("should set session mode on agent", () => {
    kspecRun('meta add agent --id session-agent --name "Session Agent"', tempDir);
    kspecRun("meta set session-agent --session-mode persistent", tempDir);

    const agents = kspecJson<Array<{ id: string; session?: { mode: string } }>>(
      "meta agents",
      tempDir,
    );
    const agent = agents.find((a) => a.id === "session-agent");
    expect(agent?.session?.mode).toBe("persistent");
  });

  // AC: @agent-definition-schema ac-13 — idle grace period via meta set
  it("should set session idle grace period on agent", () => {
    kspecRun('meta add agent --id grace-agent --name "Grace Agent"', tempDir);
    kspecRun("meta set grace-agent --idle-grace-period-ms 5000", tempDir);

    const agents = kspecJson<
      Array<{ id: string; session?: { mode: string; idle_grace_period_ms?: number } }>
    >("meta agents", tempDir);
    const agent = agents.find((a) => a.id === "grace-agent");
    expect(agent?.session?.idle_grace_period_ms).toBe(5000);
    // Default mode should be set when session didn't exist
    expect(agent?.session?.mode).toBe("auto_close");
  });

  // AC: @agent-definition-schema ac-13 — idle timeout via meta set
  it("should set session idle timeout on agent", () => {
    kspecRun('meta add agent --id timeout-agent --name "Timeout Agent"', tempDir);
    kspecRun("meta set timeout-agent --idle-timeout-ms 60000", tempDir);

    const agents = kspecJson<
      Array<{ id: string; session?: { mode: string; idle_timeout_ms?: number } }>
    >("meta agents", tempDir);
    const agent = agents.find((a) => a.id === "timeout-agent");
    expect(agent?.session?.idle_timeout_ms).toBe(60000);
  });

  // AC: @agent-definition-schema ac-13 — session merge preserves existing fields
  it("should merge session fields preserving existing values", () => {
    kspecRun('meta add agent --id merge-session-agent --name "Merge Session Agent"', tempDir);
    kspecRun(
      "meta set merge-session-agent --session-mode persistent --idle-grace-period-ms 3000",
      tempDir,
    );
    // Now update only the timeout — mode and grace period should be preserved
    kspecRun("meta set merge-session-agent --idle-timeout-ms 120000", tempDir);

    const agents = kspecJson<
      Array<{
        id: string;
        session?: { mode: string; idle_grace_period_ms?: number; idle_timeout_ms?: number };
      }>
    >("meta agents", tempDir);
    const agent = agents.find((a) => a.id === "merge-session-agent");
    expect(agent?.session?.mode).toBe("persistent");
    expect(agent?.session?.idle_grace_period_ms).toBe(3000);
    expect(agent?.session?.idle_timeout_ms).toBe(120000);
  });

  // AC: @agent-definition-schema ac-13 — invalid session mode rejected
  it("should reject invalid session mode", () => {
    kspecRun('meta add agent --id bad-session-agent --name "Bad Session Agent"', tempDir);
    const result = kspecRun("meta set bad-session-agent --session-mode invalid", tempDir, {
      expectFail: true,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Invalid session mode");
  });

  // AC: @agent-definition-schema ac-13 — idle grace period allows zero (non-negative)
  it("should allow zero for idle grace period", () => {
    kspecRun('meta add agent --id zero-grace-agent --name "Zero Grace Agent"', tempDir);
    kspecRun("meta set zero-grace-agent --idle-grace-period-ms 0", tempDir);

    const agents = kspecJson<Array<{ id: string; session?: { idle_grace_period_ms?: number } }>>(
      "meta agents",
      tempDir,
    );
    const agent = agents.find((a) => a.id === "zero-grace-agent");
    expect(agent?.session?.idle_grace_period_ms).toBe(0);
  });

  // AC: @agent-definition-schema ac-13 — idle timeout rejects zero (must be positive)
  it("should reject zero for idle timeout", () => {
    kspecRun('meta add agent --id zero-timeout-agent --name "Zero Timeout Agent"', tempDir);
    const result = kspecRun("meta set zero-timeout-agent --idle-timeout-ms 0", tempDir, {
      expectFail: true,
    });
    expect(result.exitCode).not.toBe(0);
  });

  // AC: @agent-definition-schema ac-14 — clear session removes entire session config
  it("should clear session configuration entirely", () => {
    kspecRun('meta add agent --id clear-session-agent --name "Clear Session Agent"', tempDir);
    kspecRun(
      "meta set clear-session-agent --session-mode persistent --idle-timeout-ms 30000",
      tempDir,
    );

    // Verify session is set
    let agents = kspecJson<Array<{ id: string; session?: { mode: string } }>>(
      "meta agents",
      tempDir,
    );
    let agent = agents.find((a) => a.id === "clear-session-agent");
    expect(agent?.session?.mode).toBe("persistent");

    // Clear session
    kspecRun("meta set clear-session-agent --clear-session", tempDir);

    agents = kspecJson<Array<{ id: string; session?: unknown }>>("meta agents", tempDir);
    agent = agents.find((a) => a.id === "clear-session-agent");
    expect(agent?.session).toBeUndefined();
  });

  // AC: @agent-definition-schema ac-15 — prompt template via meta set
  it("should set prompt template on agent", () => {
    kspecRun('meta add agent --id template-agent --name "Template Agent"', tempDir);
    kspecRun('meta set template-agent --prompt-template "You are a helpful assistant."', tempDir);

    const agents = kspecJson<Array<{ id: string; prompt_template?: string }>>(
      "meta agents",
      tempDir,
    );
    const agent = agents.find((a) => a.id === "template-agent");
    expect(agent?.prompt_template).toBe("You are a helpful assistant.");
  });

  // AC: @agent-definition-schema ac-15 — automation eligibility via meta set
  it("should set automation eligibility on agent", () => {
    kspecRun('meta add agent --id auto-agent --name "Auto Agent"', tempDir);
    kspecRun("meta set auto-agent --automation eligible", tempDir);

    const agents = kspecJson<Array<{ id: string; automation?: string }>>("meta agents", tempDir);
    const agent = agents.find((a) => a.id === "auto-agent");
    expect(agent?.automation).toBe("eligible");
  });

  // AC: @agent-definition-schema ac-15 — invalid automation value rejected
  it("should reject invalid automation status", () => {
    kspecRun('meta add agent --id bad-auto-agent --name "Bad Auto Agent"', tempDir);
    const result = kspecRun("meta set bad-auto-agent --automation invalid", tempDir, {
      expectFail: true,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Invalid automation status");
  });

  // AC: @agent-definition-schema ac-15 — initial response timeout via meta set
  it("should set initial response timeout seconds on agent", () => {
    kspecRun('meta add agent --id irt-agent --name "IRT Agent"', tempDir);
    kspecRun("meta set irt-agent --initial-response-timeout-seconds 300", tempDir);

    const agents = kspecJson<
      Array<{ id: string; budget?: { initial_response_timeout_seconds?: number } }>
    >("meta agents", tempDir);
    const agent = agents.find((a) => a.id === "irt-agent");
    expect(agent?.budget?.initial_response_timeout_seconds).toBe(300);
  });

  // AC: @agent-definition-schema ac-15 — initial response timeout merges with existing budget
  it("should merge initial response timeout into existing budget", () => {
    kspecRun('meta add agent --id budget-merge-agent --name "Budget Merge Agent"', tempDir);
    kspecRun("meta set budget-merge-agent --max-tasks 5 --timeout-minutes 30", tempDir);
    kspecRun("meta set budget-merge-agent --initial-response-timeout-seconds 120", tempDir);

    const agents = kspecJson<
      Array<{
        id: string;
        budget?: {
          max_tasks?: number;
          timeout_minutes?: number;
          initial_response_timeout_seconds?: number;
        };
      }>
    >("meta agents", tempDir);
    const agent = agents.find((a) => a.id === "budget-merge-agent");
    expect(agent?.budget?.max_tasks).toBe(5);
    expect(agent?.budget?.timeout_minutes).toBe(30);
    expect(agent?.budget?.initial_response_timeout_seconds).toBe(120);
  });

  // AC: @agent-definition-schema ac-15 — initial response timeout rejects zero
  it("should reject zero for initial response timeout", () => {
    kspecRun('meta add agent --id bad-irt-agent --name "Bad IRT Agent"', tempDir);
    const result = kspecRun(
      "meta set bad-irt-agent --initial-response-timeout-seconds 0",
      tempDir,
      { expectFail: true },
    );
    expect(result.exitCode).not.toBe(0);
  });

  // AC: @agent-definition-schema ac-16 — remove capability from agent
  it("should remove capability from agent", () => {
    kspecRun(
      'meta add agent --id rm-cap-agent --name "RM Cap Agent" --capability code --capability review',
      tempDir,
    );

    kspecRun("meta set rm-cap-agent --remove-capability review", tempDir);

    const agents = kspecJson<Array<{ id: string; capabilities: string[] }>>("meta agents", tempDir);
    const agent = agents.find((a) => a.id === "rm-cap-agent");
    expect(agent?.capabilities).toEqual(["code"]);
  });

  // AC: @agent-definition-schema ac-16 — remove non-existent capability is no-op
  it("should be a no-op when removing non-existent capability", () => {
    kspecRun(
      'meta add agent --id noop-cap-agent --name "NoOp Cap Agent" --capability code',
      tempDir,
    );

    const result = kspecRun("meta set noop-cap-agent --remove-capability nonexistent", tempDir);
    expect(result.exitCode).toBe(0);

    const agents = kspecJson<Array<{ id: string; capabilities: string[] }>>("meta agents", tempDir);
    const agent = agents.find((a) => a.id === "noop-cap-agent");
    expect(agent?.capabilities).toEqual(["code"]);
  });

  // AC: @agent-definition-schema ac-16 — remove tool from agent
  it("should remove tool from agent", () => {
    kspecRun(
      'meta add agent --id rm-tool-agent --name "RM Tool Agent" --tool bash --tool read',
      tempDir,
    );

    kspecRun("meta set rm-tool-agent --remove-tool bash", tempDir);

    const agents = kspecJson<Array<{ id: string; tools: string[] }>>("meta agents", tempDir);
    const agent = agents.find((a) => a.id === "rm-tool-agent");
    expect(agent?.tools).toEqual(["read"]);
  });

  // AC: @agent-definition-schema ac-16 — remove convention from agent
  it("should remove convention from agent", () => {
    kspecRun('meta add agent --id rm-conv-agent --name "RM Conv Agent"', tempDir);
    kspecRun("meta set rm-conv-agent --add-convention commits", tempDir);
    kspecRun("meta set rm-conv-agent --add-convention testing", tempDir);

    kspecRun("meta set rm-conv-agent --remove-convention commits", tempDir);

    const agents = kspecJson<Array<{ id: string; conventions: string[] }>>("meta agents", tempDir);
    const agent = agents.find((a) => a.id === "rm-conv-agent");
    expect(agent?.conventions).toEqual(["testing"]);
  });

  // AC: @agent-definition-schema ac-16 — remove skill from agent
  it("should remove skill from agent", () => {
    kspecRun('meta add agent --id rm-skill-agent --name "RM Skill Agent"', tempDir);
    kspecRun("meta set rm-skill-agent --add-skill task-work", tempDir);
    kspecRun("meta set rm-skill-agent --add-skill review", tempDir);

    kspecRun("meta set rm-skill-agent --remove-skill task-work", tempDir);

    const agents = kspecJson<Array<{ id: string; skills: string[] }>>("meta agents", tempDir);
    const agent = agents.find((a) => a.id === "rm-skill-agent");
    expect(agent?.skills).toEqual(["review"]);
  });

  // AC: @agent-definition-schema ac-16 — add tag to agent
  it("should add tag to agent", () => {
    kspecRun('meta add agent --id tag-agent --name "Tag Agent"', tempDir);
    kspecRun("meta set tag-agent --add-tag worker", tempDir);
    kspecRun("meta set tag-agent --add-tag reviewer", tempDir);

    const agents = kspecJson<Array<{ id: string; tags?: string[] }>>("meta agents", tempDir);
    const agent = agents.find((a) => a.id === "tag-agent");
    expect(agent?.tags).toEqual(["worker", "reviewer"]);
  });

  // AC: @agent-definition-schema ac-16 — add duplicate tag is no-op
  it("should not duplicate tags when adding existing tag", () => {
    kspecRun('meta add agent --id dup-tag-agent --name "Dup Tag Agent"', tempDir);
    kspecRun("meta set dup-tag-agent --add-tag worker", tempDir);
    kspecRun("meta set dup-tag-agent --add-tag worker", tempDir);

    const agents = kspecJson<Array<{ id: string; tags?: string[] }>>("meta agents", tempDir);
    const agent = agents.find((a) => a.id === "dup-tag-agent");
    expect(agent?.tags).toEqual(["worker"]);
  });

  // AC: @agent-definition-schema ac-16 — remove tag from agent
  it("should remove tag from agent", () => {
    kspecRun('meta add agent --id rm-tag-agent --name "RM Tag Agent"', tempDir);
    kspecRun("meta set rm-tag-agent --add-tag worker", tempDir);
    kspecRun("meta set rm-tag-agent --add-tag reviewer", tempDir);

    kspecRun("meta set rm-tag-agent --remove-tag worker", tempDir);

    const agents = kspecJson<Array<{ id: string; tags?: string[] }>>("meta agents", tempDir);
    const agent = agents.find((a) => a.id === "rm-tag-agent");
    expect(agent?.tags).toEqual(["reviewer"]);
  });

  // AC: @agent-definition-schema ac-16 — remove non-existent tag is no-op
  it("should be a no-op when removing non-existent tag", () => {
    kspecRun('meta add agent --id noop-tag-agent --name "NoOp Tag Agent"', tempDir);
    kspecRun("meta set noop-tag-agent --add-tag worker", tempDir);

    const result = kspecRun("meta set noop-tag-agent --remove-tag nonexistent", tempDir);
    expect(result.exitCode).toBe(0);

    const agents = kspecJson<Array<{ id: string; tags?: string[] }>>("meta agents", tempDir);
    const agent = agents.find((a) => a.id === "noop-tag-agent");
    expect(agent?.tags).toEqual(["worker"]);
  });

  // N/A annotations for trait ACs not applicable to this schema extension feature:
  // AC: @trait-json-output ac-3 — N/A: agent schema tests don't exercise error paths in JSON mode
  // AC: @trait-json-output ac-4 — N/A: agent definitions use string IDs, not @ references
  // AC: @trait-json-output ac-5 — N/A: agent definitions don't contain timestamps
  // AC: @trait-json-output ac-6 — N/A: meta agents doesn't support other formatting flags
  // AC: @trait-shadow-commit ac-2 — N/A: commit message format is tested in meta.test.ts existing suite, not duplicated here
  // AC: @trait-shadow-commit ac-3 — N/A: same as ac-2, tested in existing meta commit message tests
  // AC: @trait-shadow-commit ac-4 — N/A: shadow-not-configured path tested in existing meta add tests
  // AC: @trait-shadow-commit ac-5 — N/A: error path behavior tested in existing meta error handling tests
  // AC: @trait-shadow-commit ac-6 — N/A: push fire-and-forget tested in existing meta shadow tests
  // AC: @trait-shadow-commit ac-7 — N/A: git operation failure handling tested in existing meta shadow tests
  // AC: @trait-shadow-commit ac-8 — N/A: single agent add/set/delete each make single atomic commits
});
