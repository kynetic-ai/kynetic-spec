/**
 * Tests for comma-separated tag syntax
 *
 * AC: @comma-tag-syntax ac-1 - Parse comma-separated tags
 * AC: @comma-tag-syntax ac-2 - Parse mixed comma and space-separated tags
 * AC: @comma-tag-syntax ac-3 - Preserve existing space-separated behavior
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseTagsArray } from "../src/cli/parse-utils.js";
import { cleanupTempDir, kspec, setupTempFixtures } from "./helpers/cli.js";

describe("parseTagsArray", () => {
  // AC: @comma-tag-syntax ac-1
  it("should parse comma-separated tags", () => {
    const result = parseTagsArray("cli,urgent");
    expect(result).toEqual(["cli", "urgent"]);
  });

  // AC: @comma-tag-syntax ac-2
  it("should parse mixed comma and space-separated tags", () => {
    const result = parseTagsArray(["cli,urgent", "api"]);
    expect(result).toEqual(["cli", "urgent", "api"]);
  });

  // AC: @comma-tag-syntax ac-3
  it("should preserve existing space-separated behavior", () => {
    const result = parseTagsArray(["cli", "urgent"]);
    expect(result).toEqual(["cli", "urgent"]);
  });

  it("should handle empty input", () => {
    expect(parseTagsArray(undefined)).toEqual([]);
    expect(parseTagsArray("")).toEqual([]);
    expect(parseTagsArray([])).toEqual([]);
  });

  it("should trim whitespace", () => {
    const result = parseTagsArray("cli , urgent , api");
    expect(result).toEqual(["cli", "urgent", "api"]);
  });

  it("should handle single tag", () => {
    const result = parseTagsArray("cli");
    expect(result).toEqual(["cli"]);
  });

  it("should filter out empty strings", () => {
    const result = parseTagsArray("cli,,urgent");
    expect(result).toEqual(["cli", "urgent"]);
  });
});

describe("CLI integration with comma-separated tags", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @comma-tag-syntax ac-1
  it("should accept comma-separated tags in task add", async () => {
    const result = kspec(
      'task add --title "Comma Test Task" --tag cli,urgent',
      tempDir,
    );

    expect(result.exitCode).toBe(0);

    // Verify tags were added by checking the specific task
    const getResult = kspec("tasks list --json", tempDir);
    const tasks = JSON.parse(getResult.stdout);
    const testTask = tasks.find((t: any) => t.title === "Comma Test Task");
    expect(testTask.tags).toEqual(expect.arrayContaining(["cli", "urgent"]));
  });

  // AC: @comma-tag-syntax ac-2
  it("should accept mixed comma and space-separated tags in task add", async () => {
    const result = kspec(
      'task add --title "Mixed Tags Test" --tag cli,urgent api',
      tempDir,
    );

    expect(result.exitCode).toBe(0);

    const getResult = kspec("tasks list --json", tempDir);
    const tasks = JSON.parse(getResult.stdout);
    const testTask = tasks.find((t: any) => t.title === "Mixed Tags Test");
    expect(testTask.tags).toEqual(
      expect.arrayContaining(["cli", "urgent", "api"]),
    );
  });

  // AC: @comma-tag-syntax ac-3
  it("should preserve existing --tag --tag behavior", async () => {
    const result = kspec(
      'task add --title "Separate Tags Test" --tag cli --tag urgent',
      tempDir,
    );

    expect(result.exitCode).toBe(0);

    const getResult = kspec("tasks list --json", tempDir);
    const tasks = JSON.parse(getResult.stdout);
    const testTask = tasks.find((t: any) => t.title === "Separate Tags Test");
    expect(testTask.tags).toEqual(expect.arrayContaining(["cli", "urgent"]));
  });
});
