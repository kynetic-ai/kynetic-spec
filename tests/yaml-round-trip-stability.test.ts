import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createTempDir, cleanupTempDir, testUlid } from "./helpers/cli.js";
import {
  toYaml,
  parseYaml,
  writeYamlFile,
  readYamlFile,
  writeYamlFilePreserveFormat,
  initContext,
  saveTask,
  mutateTaskAtomically,
  loadAllTasks,
} from "../src/parser/yaml.js";
import type { LoadedTask } from "../src/parser/yaml.js";

/**
 * Round-trip stability tests for YAML serialization.
 *
 * Verifies that reading a YAML file and re-writing it without logical changes
 * produces identical output. This prevents noisy diffs in shadow branch history.
 */

let tempDir: string;

beforeEach(async () => {
  tempDir = await createTempDir("yaml-rt-");
});

afterEach(async () => {
  await cleanupTempDir(tempDir);
});

// AC: @yaml-serialization-invariants ac-3
describe("round-trip stability — toYaml", () => {
  it("round-trips a task with block scalar description", () => {
    const obj = {
      _ulid: testUlid("TASK", 1),
      slugs: ["task-with-description"],
      title: "Task with block scalar",
      type: "task",
      description:
        "This is a multi-line description.\nIt spans several lines.\n\nWith blank lines in between.",
      status: "pending",
      priority: 2,
      tags: ["test"],
      created_at: "2026-01-01T00:00:00.000Z",
      notes: [],
      todos: [],
    };
    const yaml1 = toYaml(obj);
    const parsed = parseYaml<typeof obj>(yaml1);
    const yaml2 = toYaml(parsed);
    expect(yaml2).toBe(yaml1);
  });

  it("round-trips records with null and undefined fields", () => {
    const obj = {
      _ulid: testUlid("TASK", 2),
      slugs: ["task-nulls"],
      title: "Task with nulls",
      type: "task",
      description: null,
      spec_ref: null,
      status: "pending",
      notes: [],
    };
    const yaml1 = toYaml(obj);
    const parsed = parseYaml<typeof obj>(yaml1);
    const yaml2 = toYaml(parsed);
    expect(yaml2).toBe(yaml1);
  });

  it("round-trips records with empty arrays and objects", () => {
    const obj = {
      _ulid: testUlid("TASK", 3),
      slugs: [],
      title: "Task empty collections",
      type: "task",
      status: "pending",
      depends_on: [],
      tags: [],
      notes: [],
      todos: [],
    };
    const yaml1 = toYaml(obj);
    const parsed = parseYaml<typeof obj>(yaml1);
    const yaml2 = toYaml(parsed);
    expect(yaml2).toBe(yaml1);
  });

  it("round-trips deeply nested spec items with acceptance criteria", () => {
    const obj = {
      _ulid: testUlid("SPEC", 1),
      slugs: ["deep-spec"],
      title: "Deeply nested spec",
      type: "module",
      description: "A module with nested features and requirements.",
      features: [
        {
          _ulid: testUlid("FEAT", 1),
          slugs: ["nested-feature"],
          title: "Nested Feature",
          type: "feature",
          description: "Feature with requirements.",
          requirements: [
            {
              _ulid: testUlid("REQ", 1),
              slugs: ["nested-req"],
              title: "Nested Requirement",
              type: "requirement",
              acceptance_criteria: [
                {
                  id: "ac-1",
                  given: "a precondition with special chars: colon, #hash, @ref",
                  when: "the action is performed",
                  then: "the expected result occurs",
                },
                {
                  id: "ac-2",
                  given: "a multi-line\nprecondition",
                  when: "action occurs",
                  then: "result is correct",
                },
              ],
              traits: ["@trait-json-output"],
            },
          ],
        },
      ],
    };
    const yaml1 = toYaml(obj);
    const parsed = parseYaml<typeof obj>(yaml1);
    const yaml2 = toYaml(parsed);
    expect(yaml2).toBe(yaml1);
  });

  it("round-trips review records stably", () => {
    const obj = {
      _ulid: testUlid("REVW", 1),
      slugs: ["review-test"],
      title: "Review record",
      type: "review",
      status: "open",
      disposition: null,
      created_at: "2026-01-15T10:00:00.000Z",
      notes: [
        {
          _ulid: testUlid("N0TE", 1),
          created_at: "2026-01-15T10:05:00.000Z",
          author: "@reviewer",
          content:
            "Found an issue with the implementation.\nNeeds to handle edge case.",
        },
      ],
    };
    const yaml1 = toYaml(obj);
    const parsed = parseYaml<typeof obj>(yaml1);
    const yaml2 = toYaml(parsed);
    expect(yaml2).toBe(yaml1);
  });

  it("round-trips strings with YAML-special characters", () => {
    const obj = {
      _ulid: testUlid("TASK", 4),
      slugs: ["special-chars"],
      title: "Task: with colon",
      type: "task",
      description: "Description with {braces}, [brackets], and 'quotes'",
      status: "pending",
      tags: ["tag:with:colons", "tag-normal"],
      notes: [
        {
          _ulid: testUlid("N0TE", 2),
          created_at: "2026-01-01T00:00:00.000Z",
          author: "@test",
          content: "Note with @ref and #hash and `backticks`",
        },
      ],
    };
    const yaml1 = toYaml(obj);
    const parsed = parseYaml<typeof obj>(yaml1);
    const yaml2 = toYaml(parsed);
    expect(yaml2).toBe(yaml1);
  });

  it("round-trips the whitespace-only line fix across multiple cycles", () => {
    // Regression test: yaml library bug causes whitespace-only lines to accumulate
    const obj = {
      _ulid: testUlid("TASK", 5),
      title: "Block scalar task",
      type: "task",
      description: "Line one.\n\nLine after blank.\n\nAnother section.",
      status: "pending",
    };
    // Multiple cycles — the bug causes growth on each cycle
    let yaml = toYaml(obj);
    for (let i = 0; i < 5; i++) {
      const parsed = parseYaml<typeof obj>(yaml);
      const next = toYaml(parsed);
      expect(next).toBe(yaml);
      yaml = next;
    }
  });
});

// AC: @yaml-serialization-invariants ac-3
describe("round-trip stability — file-level", () => {
  it("writeYamlFile then readYamlFile then writeYamlFile produces identical content", async () => {
    const filePath = path.join(tempDir, "round-trip.yaml");
    const data = {
      _ulid: testUlid("TASK", 10),
      slugs: ["file-rt"],
      title: "File round trip",
      type: "task",
      description: "Test file-level round trip.",
      status: "pending",
      priority: 2,
      tags: ["test"],
      created_at: "2026-01-01T00:00:00.000Z",
      notes: [],
      todos: [],
    };

    await writeYamlFile(filePath, data);
    const content1 = await fs.readFile(filePath, "utf-8");

    const loaded = await readYamlFile<typeof data>(filePath);
    await writeYamlFile(filePath, loaded);
    const content2 = await fs.readFile(filePath, "utf-8");

    expect(content2).toBe(content1);
  });

  it("writeYamlFilePreserveFormat round-trips identically", async () => {
    const filePath = path.join(tempDir, "preserve-rt.yaml");
    const data = {
      tasks: [
        {
          _ulid: testUlid("TASK", 11),
          slugs: ["preserve-1"],
          title: "First task",
          type: "task",
          status: "pending",
          notes: [],
        },
        {
          _ulid: testUlid("TASK", 12),
          slugs: ["preserve-2"],
          title: "Second task",
          type: "task",
          status: "completed",
          notes: [
            {
              _ulid: testUlid("N0TE", 10),
              created_at: "2026-02-01T00:00:00.000Z",
              author: "@agent",
              content: "Multi-line note.\n\nWith paragraphs.",
            },
          ],
        },
      ],
    };

    await writeYamlFilePreserveFormat(filePath, data);
    const content1 = await fs.readFile(filePath, "utf-8");

    const loaded = await readYamlFile<typeof data>(filePath);
    await writeYamlFilePreserveFormat(filePath, loaded);
    const content2 = await fs.readFile(filePath, "utf-8");

    expect(content2).toBe(content1);
  });

  it("round-trips a spec module file through file write/read cycles", async () => {
    const filePath = path.join(tempDir, "spec-module.yaml");
    const data = {
      _ulid: testUlid("M0DV", 1),
      slugs: ["test-module"],
      title: "Test Module",
      type: "module",
      description: "A module for testing round-trip stability.",
      features: [
        {
          _ulid: testUlid("FEAT", 10),
          slugs: ["test-feature"],
          title: "Test Feature",
          type: "feature",
          description: "A feature with acceptance criteria.",
          acceptance_criteria: [
            {
              id: "ac-1",
              given: "the system is initialized",
              when: "the feature is activated",
              then: "it behaves correctly",
            },
          ],
          traits: ["@trait-json-output"],
          requirements: [
            {
              _ulid: testUlid("REQ", 10),
              slugs: ["test-req"],
              title: "Test Requirement",
              type: "requirement",
              acceptance_criteria: [
                {
                  id: "ac-1",
                  given: "a specific condition",
                  when: "an action is taken",
                  then: "the requirement is met",
                },
              ],
            },
          ],
        },
      ],
    };

    await writeYamlFile(filePath, data);
    const content1 = await fs.readFile(filePath, "utf-8");

    // Multiple read-write cycles
    for (let i = 0; i < 3; i++) {
      const loaded = await readYamlFile<typeof data>(filePath);
      await writeYamlFile(filePath, loaded);
    }
    const contentFinal = await fs.readFile(filePath, "utf-8");

    expect(contentFinal).toBe(content1);
  });
});

// AC: @yaml-serialization-invariants ac-3
describe("round-trip stability — saveTask path", () => {
  /**
   * Helper: set up a minimal kspec context with a task file.
   */
  async function setupTaskContext(tasks: Record<string, unknown>[]) {
    // Write manifest
    const manifestPath = path.join(tempDir, "kynetic.yaml");
    await writeYamlFile(manifestPath, {
      name: "test-project",
      modules: [],
    });

    // Write task file with tasks: wrapper
    const taskFilePath = path.join(tempDir, "project.tasks.yaml");
    await writeYamlFile(taskFilePath, { tasks });

    // Get the content after initial canonical write
    const initialContent = await fs.readFile(taskFilePath, "utf-8");

    // Init context pointing at tempDir as specDir
    const ctx = await initContext(tempDir);

    return { ctx, taskFilePath, initialContent };
  }

  it("saveTask with no changes produces identical file", async () => {
    const taskData = {
      _ulid: testUlid("TASK", 20),
      slugs: ["no-change-task"],
      title: "No change task",
      type: "task",
      status: "pending",
      priority: 2,
      tags: ["test"],
      description: "This task should not change.",
      depends_on: [],
      notes: [],
      todos: [],
      created_at: "2026-01-01T00:00:00.000Z",
    };

    const { ctx, taskFilePath, initialContent } =
      await setupTaskContext([taskData]);

    // Load tasks and save the first one back with no modifications
    const loadedTasks = await loadAllTasks(ctx);
    expect(loadedTasks.length).toBe(1);

    await saveTask(ctx, loadedTasks[0]);
    const afterContent = await fs.readFile(taskFilePath, "utf-8");

    expect(afterContent).toBe(initialContent);
  });

  it("mutateTaskAtomically with identity function produces identical file", async () => {
    const taskData = {
      _ulid: testUlid("TASK", 21),
      slugs: ["identity-mutate"],
      title: "Identity mutation task",
      type: "task",
      status: "in_progress",
      priority: 1,
      tags: ["schema"],
      description: "A task for testing identity mutation stability.",
      depends_on: [],
      notes: [
        {
          _ulid: testUlid("N0TE", 20),
          created_at: "2026-01-15T00:00:00.000Z",
          author: "@agent",
          content: "Started working on this.",
        },
      ],
      todos: [
        {
          id: 1,
          text: "Step one",
          done: true,
          added_at: "2026-01-01T00:00:00.000Z",
        },
        {
          id: 2,
          text: "Step two",
          done: false,
          added_at: "2026-01-01T00:30:00.000Z",
        },
      ],
      created_at: "2026-01-01T00:00:00.000Z",
      started_at: "2026-01-15T00:00:00.000Z",
    };

    const { ctx, taskFilePath, initialContent } =
      await setupTaskContext([taskData]);

    const loadedTasks = await loadAllTasks(ctx);
    // Identity mutation: return the task unchanged
    await mutateTaskAtomically(ctx, loadedTasks[0], (t) => t);
    const afterContent = await fs.readFile(taskFilePath, "utf-8");

    expect(afterContent).toBe(initialContent);
  });

  it("saveTask preserves file stability across multiple tasks", async () => {
    const tasks = [
      {
        _ulid: testUlid("TASK", 30),
        slugs: ["multi-1"],
        title: "First of many",
        type: "task",
        status: "pending",
        priority: 2,
        tags: ["test"],
        description: "First task in multi-task file.",
        depends_on: [],
        notes: [],
        todos: [],
        created_at: "2026-01-01T00:00:00.000Z",
      },
      {
        _ulid: testUlid("TASK", 31),
        slugs: ["multi-2"],
        title: "Second of many",
        type: "task",
        status: "completed",
        priority: 3,
        tags: ["test"],
        description: "Second task in multi-task file.",
        depends_on: [],
        notes: [
          {
            _ulid: testUlid("N0TE", 30),
            created_at: "2026-01-02T00:00:00.000Z",
            author: "@agent",
            content: "Done.",
          },
        ],
        todos: [],
        created_at: "2026-01-01T00:00:00.000Z",
        completed_at: "2026-01-02T00:00:00.000Z",
      },
    ];

    const { ctx, taskFilePath, initialContent } =
      await setupTaskContext(tasks);

    // Load and save each task individually — file should not change
    const loadedTasks = await loadAllTasks(ctx);
    for (const task of loadedTasks) {
      await saveTask(ctx, task);
    }
    const afterContent = await fs.readFile(taskFilePath, "utf-8");

    expect(afterContent).toBe(initialContent);
  });
});
