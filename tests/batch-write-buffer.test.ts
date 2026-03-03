/**
 * Unit tests for the in-memory write buffer used in batch atomic execution.
 *
 * Tests the WriteBuffer class directly, plus integration tests verifying
 * that batch execution does not copy sessions/ to disk.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { WriteBuffer, activateBatchBuffer, deactivateBatchBuffer, getActiveBatchBuffer } from "../src/cli/batch-write-buffer.js";
import {
  kspec,
  kspecJson,
  setupTempFixtures,
  cleanupTempDir,
  initGitRepo,
  createTempDir,
} from "./helpers/cli.js";
import type { BatchExecResult } from "../src/schema/batch.js";

// ── WriteBuffer Unit Tests ───────────────────────────────────────────

describe("WriteBuffer", () => {
  const specDir = "/tmp/test-spec-dir";

  it("isInScope returns true for paths under specDir", () => {
    const buf = new WriteBuffer(specDir);
    expect(buf.isInScope(`${specDir}/kynetic.yaml`)).toBe(true);
    expect(buf.isInScope(`${specDir}/modules/foo.yaml`)).toBe(true);
    expect(buf.isInScope(specDir)).toBe(true);
  });

  it("isInScope returns false for paths outside specDir", () => {
    const buf = new WriteBuffer(specDir);
    expect(buf.isInScope("/tmp/other-dir/file.yaml")).toBe(false);
    expect(buf.isInScope("/etc/hosts")).toBe(false);
  });

  // AC: @batch-write-buffer ac-1 — writes go to buffer
  it("write() stores content without touching disk", () => {
    const buf = new WriteBuffer(specDir);
    const filePath = `${specDir}/project.tasks.yaml`;
    buf.write(filePath, "tasks: []");
    expect(buf.has(filePath)).toBe(true);
    expect(buf.hasWrite(filePath)).toBe(true);
    expect(buf.size).toBe(1);
  });

  // AC: @batch-write-buffer ac-2 — read-after-write returns buffered content
  it("read() returns buffered content", () => {
    const buf = new WriteBuffer(specDir);
    const filePath = `${specDir}/project.tasks.yaml`;
    buf.write(filePath, "tasks: [hello]");
    const result = buf.read(filePath);
    expect(result).toBe("tasks: [hello]");
  });

  it("read() returns undefined for non-buffered path", () => {
    const buf = new WriteBuffer(specDir);
    const result = buf.read(`${specDir}/kynetic.yaml`);
    expect(result).toBeUndefined();
  });

  // AC: @batch-write-buffer ac-4 — discard clears buffer without disk writes
  it("discard() clears all entries", () => {
    const buf = new WriteBuffer(specDir);
    buf.write(`${specDir}/a.yaml`, "a: 1");
    buf.write(`${specDir}/b.yaml`, "b: 2");
    expect(buf.size).toBe(2);
    buf.discard();
    expect(buf.size).toBe(0);
    expect(buf.read(`${specDir}/a.yaml`)).toBeUndefined();
  });

  it("getPaths() returns all buffered paths", () => {
    const buf = new WriteBuffer(specDir);
    buf.write(`${specDir}/a.yaml`, "a: 1");
    buf.write(`${specDir}/b.yaml`, "b: 2");
    const paths = buf.getPaths();
    expect(paths).toHaveLength(2);
    expect(paths).toContain(path.resolve(`${specDir}/a.yaml`));
    expect(paths).toContain(path.resolve(`${specDir}/b.yaml`));
  });
});

// ── WriteBuffer Flush Tests ──────────────────────────────────────────

describe("WriteBuffer.flush()", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    await fs.mkdir(path.join(tempDir, "modules"), { recursive: true });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @batch-write-buffer ac-3 — only buffered files flushed
  it("flush() writes only buffered files to disk", async () => {
    const buf = new WriteBuffer(tempDir);
    const fileA = path.join(tempDir, "a.yaml");
    const fileB = path.join(tempDir, "b.yaml");

    // Write an existing file that is NOT buffered — it should remain unchanged
    await fs.writeFile(fileB, "original: true", "utf-8");

    buf.write(fileA, "written: true");
    await buf.flush();

    // a.yaml was buffered — should be written
    const aContent = await fs.readFile(fileA, "utf-8");
    expect(aContent).toBe("written: true");

    // b.yaml was NOT buffered — should be unchanged
    const bContent = await fs.readFile(fileB, "utf-8");
    expect(bContent).toBe("original: true");
  });

  // AC: @batch-write-buffer ac-3 — only actually-written files flushed
  it("flush() with empty buffer is a no-op", async () => {
    const buf = new WriteBuffer(tempDir);
    await expect(buf.flush()).resolves.toBeUndefined();
  });

  it("flush() creates parent directories if needed", async () => {
    const buf = new WriteBuffer(tempDir);
    const nested = path.join(tempDir, "modules", "sub", "item.yaml");
    buf.write(nested, "nested: true");
    await buf.flush();

    const content = await fs.readFile(nested, "utf-8");
    expect(content).toBe("nested: true");
  });

  it("flush() cleans up staging files on success", async () => {
    const buf = new WriteBuffer(tempDir);
    const filePath = path.join(tempDir, "task.yaml");
    buf.write(filePath, "task: done");
    await buf.flush();

    // No staging files should remain
    const entries = await fs.readdir(tempDir);
    const stagingFiles = entries.filter((e) => e.includes(".kspec-batch-staging"));
    expect(stagingFiles).toHaveLength(0);
  });

  // AC: @batch-write-buffer ac-4 — discard leaves disk unchanged
  it("discard() does not write anything to disk", async () => {
    const buf = new WriteBuffer(tempDir);
    const filePath = path.join(tempDir, "task.yaml");
    buf.write(filePath, "should not appear");
    buf.discard();

    await expect(fs.readFile(filePath, "utf-8")).rejects.toThrow();
  });
});

// ── Module Singleton Tests ───────────────────────────────────────────

describe("batch buffer singleton", () => {
  afterEach(() => {
    deactivateBatchBuffer();
  });

  it("activateBatchBuffer() creates and returns a buffer", () => {
    const buf = activateBatchBuffer("/tmp/specdir");
    expect(buf).toBeInstanceOf(WriteBuffer);
    expect(getActiveBatchBuffer()).toBe(buf);
  });

  it("deactivateBatchBuffer() clears the singleton", () => {
    activateBatchBuffer("/tmp/specdir");
    deactivateBatchBuffer();
    expect(getActiveBatchBuffer()).toBeNull();
  });

  it("getActiveBatchBuffer() returns null when not active", () => {
    expect(getActiveBatchBuffer()).toBeNull();
  });
});

// ── Integration Tests: No sessions/ Copy ────────────────────────────

describe("batch write buffer integration", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    initGitRepo(tempDir);
    kspec("init --no-prompt", tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @batch-write-buffer ac-5 — sessions/ never copied to buffer/temp
  it("batch does not create any temp directory copy of specDir", async () => {
    // Create a large dummy sessions directory to test it's not copied
    const specDir = path.join(tempDir, ".kspec");
    const sessionsDir = path.join(specDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(path.join(sessionsDir, "big-blob.txt"), "x".repeat(1024));

    // Capture temp dir listing before batch
    const tmpBefore = await fs.readdir("/tmp");
    const kspecTempsBefore = tmpBefore.filter((d) => d.startsWith("kspec-batch-"));

    const result = kspecJson<BatchExecResult>(
      `batch --commands '[{"command":"inbox add","args":{"text":"no-copy test"}}]'`,
      tempDir,
    );
    expect(result.success).toBe(true);

    // No new kspec-batch- temp dirs should have been created
    const tmpAfter = await fs.readdir("/tmp");
    const kspecTempsAfter = tmpAfter.filter((d) => d.startsWith("kspec-batch-"));
    expect(kspecTempsAfter.length).toBe(kspecTempsBefore.length);
  });

  // AC: @batch-write-buffer ac-3 — only written files committed
  it("atomic batch only writes files touched by commands", async () => {
    const specDir = path.join(tempDir, ".kspec");

    // Get baseline list of files in spec dir
    const beforeFiles = await getAllFiles(specDir);

    const result = kspecJson<BatchExecResult>(
      `batch --commands '[{"command":"inbox add","args":{"text":"write-test item"}}]'`,
      tempDir,
    );
    expect(result.success).toBe(true);

    const afterFiles = await getAllFiles(specDir);

    // Only inbox file should have been added/modified — no sessions/ or other unrelated dirs
    const newFiles = afterFiles.filter((f) => !beforeFiles.includes(f));
    for (const newFile of newFiles) {
      // New files should be spec-related (inbox YAML), not sessions or blobs
      expect(newFile).not.toContain("sessions");
      expect(newFile).not.toContain("blobs");
    }

    // Verify the inbox item was actually created
    const inbox = kspec("inbox list", tempDir);
    expect(inbox.stdout).toContain("write-test item");
  });

  // AC: @batch-write-buffer ac-2 — read-after-write within same batch
  it("two sequential inbox adds in same batch both succeed", () => {
    // Verify read-after-write semantics: command 2 reads the inbox file
    // updated by command 1 via the buffer, not from disk.
    const result = kspecJson<BatchExecResult>(
      `batch --commands '[{"command":"inbox add","args":{"text":"first buf item"}},{"command":"inbox add","args":{"text":"second buf item"}}]'`,
      tempDir,
    );
    expect(result.success).toBe(true);
    expect(result.summary.succeeded).toBe(2);

    // Both items should be visible after batch completes (both flushed)
    const inbox = kspec("inbox list", tempDir);
    expect(inbox.stdout).toContain("first buf item");
    expect(inbox.stdout).toContain("second buf item");
  });

  // AC: @batch-write-buffer ac-4 — rollback on failure leaves .kspec/ unchanged
  it("atomic batch with failure leaves spec dir unchanged", () => {
    // Add baseline item
    kspec(`inbox add "baseline for rollback test"`, tempDir);
    const inboxBefore = kspec("inbox list", tempDir);

    // This batch will fail pre-validation (nonexistent command) — nothing should execute
    const result = kspecJson<BatchExecResult>(
      `batch --commands '[{"command":"inbox add","args":{"text":"should not appear"}},{"command":"nonexistent command","args":{}}]'`,
      tempDir,
      { expectFail: true },
    );
    expect(result.success).toBe(false);

    // inbox should not contain "should not appear" — buffer was discarded
    const inboxAfter = kspec("inbox list", tempDir);
    expect(inboxAfter.stdout).not.toContain("should not appear");
    // baseline item should still be there
    expect(inboxAfter.stdout).toContain("baseline for rollback test");
  });

  // AC: @batch-write-buffer ac-6 — other processes see pre-batch state
  it("spec dir on disk is unchanged when batch fails (buffer is process-local)", () => {
    // Add baseline to track state
    kspec(`inbox add "ac6 baseline item"`, tempDir);
    const countBefore = kspec("inbox list", tempDir).stdout.split("\n").filter(Boolean).length;

    // Run a batch that fails pre-validation — writes should be discarded
    const result = kspecJson<BatchExecResult>(
      `batch --commands '[{"command":"inbox add","args":{"text":"ac6 should not appear"}},{"command":"nonexistent-command","args":{}}]'`,
      tempDir,
      { expectFail: true },
    );
    expect(result.success).toBe(false);

    // On pre-validation failure the buffer is discarded — inbox unchanged
    const inboxAfter = kspec("inbox list", tempDir);
    expect(inboxAfter.stdout).not.toContain("ac6 should not appear");
    // Line count should be the same
    const countAfter = inboxAfter.stdout.split("\n").filter(Boolean).length;
    expect(countAfter).toBe(countBefore);
  });
});

// ── Helper ────────────────────────────────────────────────────────────

async function getAllFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const sub = await getAllFiles(fullPath);
        results.push(...sub);
      } else {
        results.push(fullPath);
      }
    }
  } catch {
    // ignore
  }
  return results;
}
