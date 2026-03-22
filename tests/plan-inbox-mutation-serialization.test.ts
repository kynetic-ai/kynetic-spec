import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  initContext,
  loadInboxItems,
  loadPlans,
  mutateInboxItemAtomically,
  mutatePlanAtomically,
} from "../src/parser/index.js";
import {
  cleanupTempDir,
  CLI_PATH,
  kspec,
  setupTempFixtures,
  testUlid,
} from "./helpers/cli.js";

function runKspecAsync(
  args: string,
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const cleanEnv = { ...process.env };
    const dispatchEnvVars = [
      "KSPEC_RALPH_SESSION",
      "KSPEC_SESSION_ID",
      "KSPEC_DISPATCH_CANONICAL_HEAD",
      "KSPEC_SHADOW_MUTATION_LOCK_FILE",
      "KSPEC_SHADOW_MUTATION_LOCK_TIMEOUT_MS",
    ];
    for (const key of dispatchEnvVars) {
      delete cleanEnv[key];
    }

    const child = spawn("/bin/sh", ["-c", `node ${CLI_PATH} ${args}`], {
      cwd,
      env: { ...cleanEnv, KSPEC_AUTHOR: "@test" },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString("utf-8");
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString("utf-8");
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({
        exitCode: exitCode ?? 1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}

describe("Plan/Inbox Mutation Serialization", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) {
      await cleanupTempDir(tempDir);
    }
  });

  it("preserves concurrent plan notes during plan set updates", async () => {
    // AC: @plan-crud ac-3 - plan set must not clobber concurrently appended notes.
    tempDir = await setupTempFixtures();
    kspec('plan add --title "Concurrent Plan" --content "base"', tempDir);

    const ctx = await initContext(tempDir);
    const plans = await loadPlans(ctx);
    const target = plans.find((plan) => plan.title === "Concurrent Plan");
    expect(target).toBeDefined();

    const note = {
      _ulid: testUlid("NOTE", 1),
      created_at: "2026-03-03T00:00:00.000Z",
      author: "@test",
      content: "concurrent note during plan set",
    };

    const targetRef = target!.slugs[0] ? `@${target!.slugs[0]}` : `@${target!._ulid}`;

    const [setResult] = await Promise.all([
      runKspecAsync(`plan set ${targetRef} --status approved`, tempDir),
      mutatePlanAtomically(ctx, target!, async (latestPlan) => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return {
          ...latestPlan,
          notes: [...latestPlan.notes, note],
        };
      }),
    ]);

    expect(setResult.exitCode).toBe(0);
    const refreshed = (await loadPlans(ctx)).find((plan) => plan._ulid === target!._ulid);
    expect(refreshed?.status).toBe("approved");
    expect(refreshed?.notes.some((entry) => entry.content === note.content)).toBe(
      true,
    );
  });

  it("preserves concurrent inbox tag updates during inbox set --content", async () => {
    // AC: @inbox-set ac-1 - content updates must not clobber concurrent tag changes.
    tempDir = await setupTempFixtures();
    kspec('inbox add "Concurrent inbox item"', tempDir);

    const ctx = await initContext(tempDir);
    const items = await loadInboxItems(ctx);
    const target = items.find((item) => item.text === "Concurrent inbox item");
    expect(target).toBeDefined();

    const targetRef = `@${target!._ulid.slice(0, 8)}`;
    const [setResult] = await Promise.all([
      runKspecAsync(
        `inbox set ${targetRef} --content "Updated inbox content"`,
        tempDir,
      ),
      mutateInboxItemAtomically(ctx, target!, async (latestItem) => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return {
          ...latestItem,
          tags: [...latestItem.tags, "concurrent"],
        };
      }),
    ]);

    expect(setResult.exitCode).toBe(0);
    const refreshed = (await loadInboxItems(ctx)).find(
      (item) => item._ulid === target!._ulid,
    );
    expect(refreshed?.text).toBe("Updated inbox content");
    expect(refreshed?.tags).toContain("concurrent");
  });
});
