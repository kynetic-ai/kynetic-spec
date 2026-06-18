import { describe, expect, it, vi } from "vitest";

import {
  createMutationPipeline,
  type MutationCacheCapability,
  type MutationPubSubCapability,
} from "../src/mutation-pipeline.js";

// AC: @shared-mutation-pipeline ac-3 — N/A: REST/CLI event equivalence is owned by @task-command-path-typed-events.

interface StageRecorder {
  calls: string[];
  cache: MutationCacheCapability;
  pubsub: MutationPubSubCapability;
  commit: NonNullable<Parameters<typeof createMutationPipeline>[0]>["commit"];
}

function createStageRecorder(): StageRecorder {
  const calls: string[] = [];
  return {
    calls,
    cache: {
      async writeThrough(domain, hint) {
        calls.push(`cache:${domain}:${JSON.stringify(hint ?? null)}`);
      },
    },
    commit: async (_shadow, operation, ref, detail) => {
      calls.push(`commit:${operation}:${ref ?? ""}:${detail ?? ""}`);
      return true;
    },
    pubsub: {
      broadcast(topic, event, data, projectPath) {
        calls.push(`broadcast:${topic}:${event}:${data.ulid}:${projectPath}`);
      },
    },
  };
}

describe("shared mutation pipeline", () => {
  // AC: @shared-mutation-pipeline ac-1
  // AC: @shared-mutation-pipeline ac-2
  it("runs apply, shadow commit, cache write-through, then broadcast in order", async () => {
    const recorder = createStageRecorder();
    const pipeline = createMutationPipeline({
      shadow: null,
      cache: recorder.cache,
      pubsub: recorder.pubsub,
      projectPath: "/project",
      commit: recorder.commit,
    });

    const result = await pipeline.run({
      apply: async () => {
        recorder.calls.push("apply");
        return { ok: true };
      },
      commit: { operation: "task: start @task-one" },
      writeThrough: [{ domain: "tasks", hint: { ulid: "01TASK" } }],
      events: [{ topic: "tasks:updates", event: "task_updated", data: { ulid: "01TASK" } }],
    });

    expect(result).toEqual({ ok: true });
    expect(recorder.calls).toEqual([
      "apply",
      "commit:task: start @task-one::",
      'cache:tasks:{"ulid":"01TASK"}',
      "broadcast:tasks:updates:task_updated:01TASK:/project",
    ]);
  });

  // AC: @shared-mutation-pipeline ac-1
  // AC: @shared-mutation-pipeline ac-2
  it("derives commit, cache, and event descriptors from the applied mutation result", async () => {
    const recorder = createStageRecorder();
    const pipeline = createMutationPipeline({
      shadow: null,
      cache: recorder.cache,
      pubsub: recorder.pubsub,
      projectPath: "/project",
      commit: recorder.commit,
    });

    const mutationResult = await pipeline.run({
      apply: async () => {
        recorder.calls.push("apply-resource");
        return { reviewUlid: "01REVIEW", resourceId: "shot", action: "added" };
      },
      commit: (applied) => ({
        operation: "review-resource-add",
        ref: applied.reviewUlid,
        detail: `${applied.action} ${applied.resourceId}`,
      }),
      writeThrough: (applied) => [{ domain: "reviews", hint: { ulid: applied.reviewUlid } }],
      events: (applied) => [
        {
          topic: "reviews:updates",
          event: "resource_changed",
          data: { ulid: applied.reviewUlid, resource_id: applied.resourceId },
        },
      ],
    });

    expect(mutationResult).toEqual({
      reviewUlid: "01REVIEW",
      resourceId: "shot",
      action: "added",
    });
    expect(recorder.calls).toEqual([
      "apply-resource",
      "commit:review-resource-add:01REVIEW:added shot",
      'cache:reviews:{"ulid":"01REVIEW"}',
      "broadcast:reviews:updates:resource_changed:01REVIEW:/project",
    ]);
  });

  // AC: @shared-mutation-pipeline ac-4
  it("applies and commits a single mutation when cache and pubsub are unavailable", async () => {
    const calls: string[] = [];
    const pipeline = createMutationPipeline({
      shadow: null,
      commit: async (_shadow, operation) => {
        calls.push(`commit:${operation}`);
        return true;
      },
    });

    const result = await pipeline.run({
      apply: () => {
        calls.push("apply");
        return "changed";
      },
      commit: { operation: "inbox: add item 01INBOX" },
      writeThrough: [{ domain: "inbox" }],
      events: [{ topic: "inbox:updates", event: "inbox_item_created", data: { ulid: "01INBOX" } }],
    });

    expect(result).toBe("changed");
    expect(calls).toEqual(["apply", "commit:inbox: add item 01INBOX"]);
  });

  // AC: @shared-mutation-pipeline ac-5
  it("commits a daemon-served batch once before all post-batch events", async () => {
    const recorder = createStageRecorder();
    const pipeline = createMutationPipeline({
      shadow: null,
      cache: recorder.cache,
      pubsub: recorder.pubsub,
      projectPath: "/project",
      commit: recorder.commit,
    });

    const result = await pipeline.run({
      apply: () => {
        recorder.calls.push("apply-batch");
        return ["01A", "01B"];
      },
      commit: { operation: "triage: act 01TRIAGE" },
      writeThrough: [
        { domain: "triage", hint: { ulid: "01TRIAGE" } },
        { domain: "tasks", hint: { ulid: "01TASK" } },
        { domain: "inbox" },
      ],
      events: [
        { topic: "triage:updates", event: "triage_record_acted", data: { ulid: "01TRIAGE" } },
        { topic: "tasks:updates", event: "task_updated", data: { ulid: "01TASK" } },
      ],
    });

    expect(result).toEqual(["01A", "01B"]);
    expect(recorder.calls).toEqual([
      "apply-batch",
      "commit:triage: act 01TRIAGE::",
      'cache:triage:{"ulid":"01TRIAGE"}',
      'cache:tasks:{"ulid":"01TASK"}',
      "cache:inbox:null",
      "broadcast:triage:updates:triage_record_acted:01TRIAGE:/project",
      "broadcast:tasks:updates:task_updated:01TASK:/project",
    ]);
  });

  // AC: @shared-mutation-pipeline ac-7
  it("applies and commits an atomic batch when cache and pubsub are unavailable", async () => {
    const calls: string[] = [];
    const pipeline = createMutationPipeline({
      shadow: null,
      commit: async (_shadow, operation) => {
        calls.push(`commit:${operation}`);
        return true;
      },
    });

    const result = await pipeline.run({
      apply: () => {
        calls.push("apply-batch");
        return { batch: true };
      },
      commit: { operation: "batch mutation" },
      writeThrough: [{ domain: "tasks" }, { domain: "inbox" }],
      events: [
        { topic: "tasks:updates", event: "task_updated", data: { ulid: "01TASK" } },
        { topic: "inbox:updates", event: "inbox_item_deleted", data: { ulid: "01INBOX" } },
      ],
    });

    expect(result).toEqual({ batch: true });
    expect(calls).toEqual(["apply-batch", "commit:batch mutation"]);
  });

  // AC: @shared-mutation-pipeline ac-6
  it("preserves the underlying stage failure description", async () => {
    const pipeline = createMutationPipeline({
      shadow: null,
      cache: {
        async writeThrough() {
          throw new Error("cache reload failed for reviews");
        },
      },
      pubsub: {
        broadcast: vi.fn<MutationPubSubCapability["broadcast"]>(),
      },
      commit: async () => true,
    });

    await expect(
      pipeline.run({
        apply: () => ({ ok: true }),
        commit: { operation: "review-check", ref: "@review-one" },
        writeThrough: [{ domain: "reviews" }],
        events: [{ topic: "reviews:updates", event: "check_added", data: { ulid: "01REVIEW" } }],
      }),
    ).rejects.toThrow("cache reload failed for reviews");
  });
});
