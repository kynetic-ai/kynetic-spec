import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupTempDir,
  kspec as kspecRun,
  kspecOutput,
  setupTempFixtures,
} from "./helpers/cli.js";
import {
  AgentDispatchAutomationFilterSchema,
  AutomationStatusSchema,
  TaskEventPayloadSchema,
  TaskTypeSchema,
  matchesAutomationFilter,
} from "../src/schema/index.js";

describe("schema-derived type definitions", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @schema-derived-type-definitions ac-3
  it("renders CLI help text from canonical schema options", () => {
    const taskHelp = kspecOutput("task add --help", tempDir).replace(/\s+/g, " ");
    const agentHelp = kspecOutput("agent list --help", tempDir).replace(/\s+/g, " ");

    expect(taskHelp).toContain(
      `Task type (${TaskTypeSchema.options.join(", ")})`,
    );
    expect(taskHelp).toContain(
      `Automation eligibility (${AutomationStatusSchema.options.join(", ")})`,
    );
    expect(agentHelp).toContain(
      `Filter by automation status (${AgentDispatchAutomationFilterSchema.options.join("|")})`,
    );
  });

  // AC: @trait-type-safe-input ac-2
  it("reports valid alternatives for invalid automation CLI input", () => {
    const output = kspecRun(
      'task add --title "Bad automation" --automation invalid_status',
      tempDir,
      { expectFail: true },
    ).stderr.replace(/\s+/g, " ");

    expect(output).toContain("eligible");
    expect(output).toContain("needs_review");
    expect(output).toContain("manual_only");
  });

  // AC: @schema-derived-type-definitions ac-4
  // AC: @trait-type-safe-input ac-3
  it("derives automation-related schemas from canonical task automation states", () => {
    const projected = new Set(
      AutomationStatusSchema.options.map((status) =>
        status === "eligible" ? "eligible" : "ineligible",
      ),
    );

    expect(projected).toEqual(
      new Set(AgentDispatchAutomationFilterSchema.options),
    );
    expect(matchesAutomationFilter("eligible", "eligible")).toBe(true);
    expect(matchesAutomationFilter("manual_only", "ineligible")).toBe(true);
    expect(matchesAutomationFilter("needs_review", "eligible")).toBe(false);

    const payload = TaskEventPayloadSchema.safeParse({
      task_id: "01JTEST000000000000000000",
      task_ref: "@task-schema-derived-types",
      from_status: "pending",
      to_status: "in_progress",
      task_title: "Schema-derived types",
      tags: ["schema"],
      priority: 1,
      automation: "manual_only",
    });

    expect(payload.success).toBe(true);
  });
});
