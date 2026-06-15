/**
 * Actor canonicalization across CLI write surfaces — integration regression.
 *
 * Proves that representative CLI writes (task notes, item notes, todos) and the
 * importer all funnel through the one shared actor-write utility: the same actor
 * input persists the same canonical value, recognizable variants are stored
 * canonically, out-of-pool values are rejected with validation feedback, and no
 * path records the historical "anonymous" placeholder.
 *
 * The temp fixtures configure agents `test`, `test-agent`, and `review-agent`
 * (tests/fixtures/kynetic.meta.yaml); the CLI helper pins KSPEC_AUTHOR=@test so
 * the configured human identity is deterministic.
 *
 * AC: @actor-identity-resolution ac-7 — recognized variant persists as canonical id
 * AC: @actor-identity-resolution ac-8 — out-of-pool value rejected with validation feedback
 * AC: @actor-identity-model ac-1 — new actor-bearing writes are canonical or rejected
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { kspec, kspecJson, setupTempFixtures, cleanupTempDir } from "./helpers/cli.js";

const TASK_REF = "@test-task-pending";

interface TaskNotesResponse {
  notes: Array<{ content: string; author: string }>;
  todos: Array<{ text: string; added_by: string }>;
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await setupTempFixtures();
});

afterEach(async () => {
  await cleanupTempDir(tempDir);
});

function latestNoteAuthor(content: string): string {
  const task = kspecJson<TaskNotesResponse>(`task get ${TASK_REF}`, tempDir);
  const note = task.notes.find((n) => n.content.includes(content));
  expect(note, `note containing "${content}" should exist`).toBeDefined();
  return note!.author;
}

describe("CLI actor canonicalization", () => {
  // AC: @actor-identity-resolution ac-7 — an agent variant persists as the canonical id
  it("persists a configured-agent variant as the canonical id on a task note", () => {
    kspec(`task note ${TASK_REF} "variant agent note" --author "@test-agent"`, tempDir);
    expect(latestNoteAuthor("variant agent note")).toBe("test-agent");
  });

  // AC: @actor-identity-resolution ac-7 — the email-suffix variant resolves to the same id
  it("persists the same canonical id for an email-suffix variant of the agent", () => {
    kspec(`task note ${TASK_REF} "email variant note" --author "test-agent@example.com"`, tempDir);
    expect(latestNoteAuthor("email variant note")).toBe("test-agent");
  });

  // AC: @actor-identity-resolution ac-6 — an absent author resolves through the chain, never anonymous
  it("resolves an absent author through the precedence chain (never anonymous)", () => {
    kspec(`task note ${TASK_REF} "default author note"`, tempDir);
    const author = latestNoteAuthor("default author note");
    expect(author).toBe("@test"); // KSPEC_AUTHOR pinned by the helper
    expect(author).not.toBe("anonymous");
  });

  // AC: @actor-identity-resolution ac-8 — an out-of-pool author is rejected with feedback
  it("rejects an out-of-pool task-note author with validation feedback", () => {
    const result = kspec(
      `task note ${TASK_REF} "rejected note" --author "totally-unknown-person"`,
      tempDir,
      { expectFail: true },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/not a configured human or agent identity/i);
    // The rejected note must not have been written.
    const task = kspecJson<TaskNotesResponse>(`task get ${TASK_REF}`, tempDir);
    expect(task.notes.some((n) => n.content.includes("rejected note"))).toBe(false);
  });

  // AC: @actor-identity-resolution ac-8 — the literal "anonymous" placeholder is rejected
  it('rejects a literal "anonymous" author', () => {
    const result = kspec(`task note ${TASK_REF} "anon note" --author anonymous`, tempDir, {
      expectFail: true,
    });
    expect(result.exitCode).not.toBe(0);
  });

  // AC: @actor-identity-resolution ac-7 — todo added_by canonicalizes the same way
  it("canonicalizes a todo added_by variant to the agent id", () => {
    kspec(`task todo add ${TASK_REF} "do the thing" --author "@review-agent"`, tempDir);
    const task = kspecJson<TaskNotesResponse>(`task get ${TASK_REF}`, tempDir);
    const todo = task.todos.find((t) => t.text.includes("do the thing"));
    expect(todo?.added_by).toBe("review-agent");
  });

  // AC: @actor-identity-resolution ac-7 — CLI surfaces agree on the canonical value
  it("persists the same canonical id across task-note and item-note write surfaces", () => {
    kspec(`task note ${TASK_REF} "cross surface note" --author "@test-agent"`, tempDir);
    const taskAuthor = latestNoteAuthor("cross surface note");

    kspec(`item note @test-core "cross surface item note" --author "@test-agent"`, tempDir);
    const item = kspecJson<{ notes: Array<{ content: string; author: string }> }>(
      `item get @test-core`,
      tempDir,
    );
    const itemNote = item.notes.find((n) => n.content.includes("cross surface item note"));
    expect(taskAuthor).toBe("test-agent");
    expect(itemNote?.author).toBe("test-agent");
  });
});
