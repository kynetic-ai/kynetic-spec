import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  createPlan,
  createTask,
  extractItemsFromRaw,
  loadAllTasks,
  loadInboxItems,
  loadPlans,
  parseYaml,
  loadTriageRecords,
  toYaml,
  type KspecContext,
} from "../src/parser/index.js";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  testUlid,
} from "./helpers/cli.js";

function makeContext(specDir: string): KspecContext {
  const projectRoot = path.dirname(specDir);
  return {
    rootDir: projectRoot,
    projectRoot,
    specDir,
    sessionsDir: path.join(projectRoot, ".kspec-sessions"),
    manifestPath: null,
    manifest: null,
    shadow: { enabled: true },
  } as KspecContext;
}

async function seedMixedInvalidRecords(specDir: string): Promise<{
  taskId: string;
  itemId: string;
  inboxId: string;
  triageId: string;
  planId: string;
}> {
  const validTask = createTask({ title: "Valid task", slugs: ["valid-task"] });
  const invalidTask = { ...createTask({ title: "Broken task" }), status: "not-a-status" };

  const validItem = {
    _ulid: testUlid("SPCA"),
    title: "Valid item",
    slugs: ["valid-item"],
    type: "feature",
  };
  const invalidItem = {
    _ulid: testUlid("SPCX"),
    title: "Broken item",
    slugs: ["broken-item"],
    type: "not-a-type",
  };

  const validInbox = {
    _ulid: testUlid("INBX"),
    text: "Valid inbox idea",
    created_at: "2026-03-20T00:00:00.000Z",
  };
  const invalidInbox = {
    _ulid: testUlid("INXC"),
    text: 123,
    created_at: "2026-03-20T00:00:00.000Z",
  };

  const validTriage = {
    _ulid: testUlid("TRJG"),
    inbox_ref: validInbox._ulid,
    item_snapshot: "Valid inbox idea",
    status: "triaged",
    action: "promote",
    reasoning: "clear feature",
    decided_by: "@claude",
    created_at: "2026-03-20T00:00:00.000Z",
  };
  const invalidTriage = {
    _ulid: testUlid("TRJX"),
    inbox_ref: invalidInbox._ulid,
    item_snapshot: "Broken triage idea",
    status: "not-a-status",
    action: "promote",
    reasoning: "broken",
    decided_by: "@claude",
    created_at: "2026-03-20T00:00:00.000Z",
  };

  const validPlan = createPlan({ title: "Valid plan", slugs: ["valid-plan"] });
  const invalidPlan = { ...createPlan({ title: "Broken plan" }), status: "not-a-status" };

  await fs.writeFile(
    path.join(specDir, "project.tasks.yaml"),
    toYaml({ tasks: [validTask, invalidTask] }),
  );
  await fs.writeFile(
    path.join(specDir, "project.inbox.yaml"),
    toYaml({ inbox: [validInbox, invalidInbox] }),
  );
  await fs.writeFile(
    path.join(specDir, "project.triage.yaml"),
    toYaml({ kynetic_triage: "1.0", triage: [validTriage, invalidTriage] }),
  );
  await fs.writeFile(
    path.join(specDir, "project.plans.yaml"),
    toYaml({ kynetic_plans: "1.0", plans: [validPlan, invalidPlan] }),
  );
  await fs.writeFile(
    path.join(specDir, "modules.yaml"),
    toYaml({
      features: [validItem, invalidItem],
    }),
  );

  return {
    taskId: invalidTask._ulid,
    itemId: invalidItem._ulid,
    inboxId: invalidInbox._ulid,
    triageId: invalidTriage._ulid,
    planId: invalidPlan._ulid,
  };
}

describe("read-side validation warnings (@read-side-validation-warnings)", () => {
  let tempDir: string;
  let specDir: string;
  let ctx: KspecContext;

  beforeEach(async () => {
    tempDir = await createTempDir("read-side-validation-");
    specDir = path.join(tempDir, ".kspec");
    await fs.mkdir(specDir, { recursive: true });
    await initGitRepo(tempDir);
    ctx = makeContext(specDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  // AC: @trait-error-guidance ac-3 - N/A: read-side validation warnings do not handle missing refs.
  // AC: @trait-error-guidance ac-4 - N/A: read-side validation warnings do not handle state transitions.
  // AC: @trait-error-guidance ac-6 - N/A: parser loaders do not emit structured JSON-mode errors.

  // AC: @read-side-validation-warnings ac-1
  // AC: @trait-error-guidance ac-1
  // AC: @trait-error-guidance ac-2
  // AC: @trait-error-guidance ac-5
  it("warns on stderr with record ids, field failures, and a repair hint for invalid records", async () => {
    const ids = await seedMixedInvalidRecords(specDir);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await loadAllTasks(ctx);
    const rawItems = parseYaml<unknown>(await fs.readFile(path.join(specDir, "modules.yaml"), "utf-8"));
    extractItemsFromRaw(rawItems, "modules.yaml");
    await loadInboxItems(ctx);
    await loadTriageRecords(ctx);
    await loadPlans(ctx);

    const warnings = warnSpy.mock.calls.map(([message]) => String(message));
    expect(warnings).toHaveLength(5);

    expect(warnings.join("\n")).toContain(`task ${ids.taskId}`);
    expect(warnings.join("\n")).toContain(`spec item ${ids.itemId}`);
    expect(warnings.join("\n")).toContain(`inbox item ${ids.inboxId}`);
    expect(warnings.join("\n")).toContain(`triage record ${ids.triageId}`);
    expect(warnings.join("\n")).toContain(`plan ${ids.planId}`);
    expect(warnings.join("\n")).toContain("status=");
    expect(warnings.join("\n")).toContain("Suggested action: fix the invalid field in the YAML record and rerun the command.");
  });

  // AC: @read-side-validation-warnings ac-2
  it("returns valid records normally while warning only for invalid records", async () => {
    await seedMixedInvalidRecords(specDir);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const tasks = await loadAllTasks(ctx);
    const rawItems = parseYaml<unknown>(await fs.readFile(path.join(specDir, "modules.yaml"), "utf-8"));
    const items = extractItemsFromRaw(rawItems, "modules.yaml");
    const inbox = await loadInboxItems(ctx);
    const triage = await loadTriageRecords(ctx);
    const plans = await loadPlans(ctx);

    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe("Valid task");
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Valid item");
    expect(inbox).toHaveLength(1);
    expect(inbox[0].text).toBe("Valid inbox idea");
    expect(triage).toHaveLength(1);
    expect(triage[0].item_snapshot).toBe("Valid inbox idea");
    expect(plans).toHaveLength(1);
    expect(plans[0].title).toBe("Valid plan");
    expect(warnSpy).toHaveBeenCalledTimes(5);
  });

  // AC: @read-side-validation-warnings ac-3
  it("emits no warnings when all records are valid", async () => {
    const validTask = createTask({ title: "Valid task", slugs: ["valid-task"] });
    const validPlan = createPlan({ title: "Valid plan", slugs: ["valid-plan"] });
    const validInbox = {
      _ulid: testUlid("INBOX"),
      text: "Valid inbox idea",
      created_at: "2026-03-20T00:00:00.000Z",
    };

    await fs.writeFile(path.join(specDir, "project.tasks.yaml"), toYaml({ tasks: [validTask] }));
    await fs.writeFile(path.join(specDir, "project.inbox.yaml"), toYaml({ inbox: [validInbox] }));
    await fs.writeFile(
      path.join(specDir, "project.triage.yaml"),
      toYaml({
        kynetic_triage: "1.0",
        triage: [{
          _ulid: testUlid("TRJG"),
          inbox_ref: validInbox._ulid,
          item_snapshot: "Valid inbox idea",
          status: "triaged",
          action: "promote",
          reasoning: "clear feature",
          decided_by: "@claude",
          created_at: "2026-03-20T00:00:00.000Z",
        }],
      }),
    );
    await fs.writeFile(
      path.join(specDir, "project.plans.yaml"),
      toYaml({ kynetic_plans: "1.0", plans: [validPlan] }),
    );
    await fs.writeFile(
      path.join(specDir, "modules.yaml"),
      toYaml({
        features: [{
          _ulid: testUlid("SPCA"),
          title: "Valid item",
          slugs: ["valid-item"],
          type: "feature",
        }],
      }),
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await loadAllTasks(ctx);
    const rawItems = parseYaml<unknown>(await fs.readFile(path.join(specDir, "modules.yaml"), "utf-8"));
    extractItemsFromRaw(rawItems, "modules.yaml");
    await loadInboxItems(ctx);
    await loadTriageRecords(ctx);
    await loadPlans(ctx);

    expect(warnSpy).not.toHaveBeenCalled();
  });
});
