/**
 * Unit tests for the in-memory write buffer used in batch atomic execution.
 *
 * Tests the WriteBuffer class directly, plus integration tests verifying
 * that batch execution does not copy sessions/ to disk.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import {
  WriteBuffer,
  SyntheticDirent,
  accessBufferAware,
  getActiveBatchBuffer,
  readdirBufferAware,
  runWithBatchBuffer,
  writeFileBufferAware,
} from "../src/cli/batch-write-buffer.js";
import { copyCoreSkillFiles } from "../src/cli/commands/skill-install.js";
import { readFileBufferAware } from "../src/parser/yaml.js";
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

describe("WriteBuffer.listDir() and helper dirents", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    await fs.mkdir(path.join(tempDir, "existing-dir"), { recursive: true });
    await fs.writeFile(path.join(tempDir, "disk.yaml"), "disk: true", "utf-8");
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it("SyntheticDirent exposes file/directory shape", () => {
    const fileDirent = new SyntheticDirent("file.md", true);
    const folderDirent = new SyntheticDirent("docs", false);

    expect(fileDirent.name).toBe("file.md");
    expect(fileDirent.isFile()).toBe(true);
    expect(fileDirent.isDirectory()).toBe(false);
    expect(folderDirent.isFile()).toBe(false);
    expect(folderDirent.isDirectory()).toBe(true);
  });

  it("listDir() overlays buffered writes, deletions, and inferred directories", async () => {
    const buf = new WriteBuffer(tempDir);

    buf.write(path.join(tempDir, "new.yaml"), "new: true");
    buf.write(path.join(tempDir, "new-dir", "nested.yaml"), "nested: true");
    buf.delete(path.join(tempDir, "disk.yaml"));

    const entries = await buf.listDir(tempDir, { withFileTypes: true });
    const names = entries.map((e) => e.name);

    expect(names).toContain("new.yaml");
    expect(names).toContain("new-dir");
    expect(names).toContain("existing-dir");
    expect(names).not.toContain("disk.yaml");

    const newFile = entries.find((e) => e.name === "new.yaml");
    const inferredDir = entries.find((e) => e.name === "new-dir");
    expect(newFile?.isFile()).toBe(true);
    expect(inferredDir?.isDirectory()).toBe(true);
  });

  it("listDir() returns buffered entries even when directory is missing on disk", async () => {
    const buf = new WriteBuffer(tempDir);
    const missingDir = path.join(tempDir, "from-buffer-only");
    buf.write(path.join(missingDir, "child.yaml"), "x: 1");

    const plainEntries = await buf.listDir(missingDir);
    expect(plainEntries).toEqual(["child.yaml"]);

    const direntEntries = await buf.listDir(missingDir, { withFileTypes: true });
    expect(direntEntries).toHaveLength(1);
    expect(direntEntries[0].name).toBe("child.yaml");
    expect(direntEntries[0].isFile()).toBe(true);
  });

  it("listDir() throws ENOENT when directory is deleted in the overlay", async () => {
    const buf = new WriteBuffer(tempDir);
    const existingDir = path.join(tempDir, "existing-dir");
    buf.delete(existingDir);

    await expect(buf.listDir(existingDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("listDir() does not resurrect a deleted directory after buffered child writes", async () => {
    const buf = new WriteBuffer(tempDir);
    const deletedDir = path.join(tempDir, "deleted-dir");

    buf.write(path.join(deletedDir, "child.txt"), "hello");
    buf.delete(deletedDir);

    const entries = await buf.listDir(tempDir);
    expect(entries).not.toContain("deleted-dir");
  });
});

describe("buffer-aware fs helpers", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it("readdirBufferAware() returns buffered directory entries with file types", async () => {
    await runWithBatchBuffer(tempDir, async (buffer) => {
      const bufferedFile = path.join(tempDir, "docs", "note.md");
      buffer.write(bufferedFile, "# note\n");

      const entries = await readdirBufferAware(path.join(tempDir, "docs"), {
        withFileTypes: true,
      });
      expect(entries).toHaveLength(1);
      expect(entries[0].name).toBe("note.md");
      expect(entries[0].isFile()).toBe(true);
    });
  });

  it("accessBufferAware() checks buffered writes and deletions", async () => {
    await runWithBatchBuffer(tempDir, async (buffer) => {
      const filePath = path.join(tempDir, "buffered.txt");

      buffer.write(filePath, "buffered");
      await expect(accessBufferAware(filePath)).resolves.toBeUndefined();

      buffer.delete(filePath);
      await expect(accessBufferAware(filePath)).rejects.toMatchObject({ code: "ENOENT" });

      buffer.write(path.join(tempDir, "nested", "child.md"), "hello");
      await expect(accessBufferAware(path.join(tempDir, "nested"))).resolves.toBeUndefined();

      buffer.delete(path.join(tempDir, "gone"));
      await expect(accessBufferAware(path.join(tempDir, "gone", "child.md"))).rejects.toMatchObject(
        {
          code: "ENOENT",
        },
      );
    });
  });

  it("writeFileBufferAware()/readFileBufferAware() use active buffer", async () => {
    await runWithBatchBuffer(tempDir, async (buffer) => {
      const filePath = path.join(tempDir, "buffered.md");

      await writeFileBufferAware(filePath, "hello from buffer");
      await expect(fs.readFile(filePath, "utf-8")).rejects.toThrow();
      await expect(readFileBufferAware(filePath)).resolves.toBe("hello from buffer");

      buffer.delete(filePath);
      await expect(readFileBufferAware(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("copyCoreSkillFiles() is read-after-write consistent within one active buffer", async () => {
    const specDir = path.join(tempDir, ".kspec");
    const targetDir = path.join(specDir, "skills", "triage");
    await runWithBatchBuffer(specDir, async () => {
      const first = await copyCoreSkillFiles("triage", targetDir);
      const second = await copyCoreSkillFiles("triage", targetDir);

      expect(first.changed).toBe(true);
      expect(second.changed).toBe(false);
    });
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

  // AC: @batch-write-buffer ac-7 — flush failure: error reported, pre-batch state preserved
  it("flush() reports error and leaves no partial writes when staging write fails", async () => {
    const buf = new WriteBuffer(tempDir);

    // Pre-existing file that should remain unchanged
    const existingFile = path.join(tempDir, "existing.yaml");
    await fs.writeFile(existingFile, "original: true", "utf-8");

    // Buffer a write to a path whose parent is a FILE (not a dir) — mkdir will fail,
    // causing Phase 1 to throw. This exercises the "staging failed, nothing committed" path.
    const blockingFile = path.join(tempDir, "not-a-dir");
    await fs.writeFile(blockingFile, "i am a file, not a directory", "utf-8");
    const fileInsideBlocker = path.join(blockingFile, "nested.yaml");

    buf.write(fileInsideBlocker, "should not appear");

    // flush() should throw with "staging failed" message
    await expect(buf.flush()).rejects.toThrow("Batch flush staging failed");

    // existingFile should be completely unchanged
    const content = await fs.readFile(existingFile, "utf-8");
    expect(content).toBe("original: true");

    // No staging files should remain after cleanup
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

// ── Buffer Scoping Tests ─────────────────────────────────────────────

describe("batch buffer scoping", () => {
  // AC: @batch-write-buffer ac-1
  it("runWithBatchBuffer() makes buffer visible inside the callback", async () => {
    let bufferInsideScope: WriteBuffer | null = null;
    await runWithBatchBuffer("/tmp/specdir", async (buffer) => {
      bufferInsideScope = getActiveBatchBuffer();
      expect(bufferInsideScope).toBe(buffer);
      expect(buffer).toBeInstanceOf(WriteBuffer);
    });
  });

  // AC: @batch-write-buffer ac-9
  it("buffer is null outside runWithBatchBuffer scope", async () => {
    await runWithBatchBuffer("/tmp/specdir", async () => {
      // inside — buffer is visible
      expect(getActiveBatchBuffer()).not.toBeNull();
    });
    // outside — scope has exited, buffer is no longer visible
    expect(getActiveBatchBuffer()).toBeNull();
  });

  it("getActiveBatchBuffer() returns null when no buffer scope is active", () => {
    expect(getActiveBatchBuffer()).toBeNull();
  });

  // AC: @batch-write-buffer ac-9
  it("concurrent runWithBatchBuffer scopes are isolated", async () => {
    let bufferA: WriteBuffer | null = null;
    let bufferB: WriteBuffer | null = null;

    await Promise.all([
      runWithBatchBuffer("/tmp/scope-a", async (buffer) => {
        bufferA = buffer;
        // Yield to let the other scope start
        await new Promise((r) => setTimeout(r, 10));
        // Should still see our own buffer, not the other scope's
        expect(getActiveBatchBuffer()).toBe(buffer);
      }),
      runWithBatchBuffer("/tmp/scope-b", async (buffer) => {
        bufferB = buffer;
        await new Promise((r) => setTimeout(r, 10));
        expect(getActiveBatchBuffer()).toBe(buffer);
      }),
    ]);

    // Each scope got its own buffer instance
    expect(bufferA).not.toBeNull();
    expect(bufferB).not.toBeNull();
    expect(bufferA).not.toBe(bufferB);
    // Both scopes have exited
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

  // AC: @batch-write-buffer ac-2 — repeated item ac add in one batch preserves both writes
  // AC: @batch-write-buffer ac-8 — loadSpecFile must read buffered state, not stale fs.readFile disk state
  it("two item ac add commands against the same item keep both AC entries", () => {
    kspec(`module add --title "Batch Buffer Test Module" --slug batch-buffer-test-module`, tempDir);

    const result = kspecJson<BatchExecResult>(
      `batch --commands '[{"command":"item ac add","args":{"ref":"@batch-buffer-test-module","given":"first given","when":"first when","then":"first then"}},{"command":"item ac add","args":{"ref":"@batch-buffer-test-module","given":"second given","when":"second when","then":"second then"}}]'`,
      tempDir,
    );
    expect(result.success).toBe(true);
    expect(result.summary.succeeded).toBe(2);

    const item = kspec("item get @batch-buffer-test-module", tempDir);
    expect(item.stdout).toContain("first then");
    expect(item.stdout).toContain("second then");
  });

  // AC: @batch-write-buffer ac-1, ac-4 — supporting file writes rollback in atomic batch failures
  it("skill import supporting files do not persist when later batch command fails", async () => {
    const sourceDir = path.join(tempDir, "skill-import-source");
    const docsDir = path.join(sourceDir, "docs");
    const skillMdSource = path.join(sourceDir, "SKILL.md");
    await fs.mkdir(docsDir, { recursive: true });
    await fs.writeFile(skillMdSource, "# Rollback Skill\n\nUsed for rollback test.\n", "utf-8");
    await fs.writeFile(path.join(docsDir, "guide.md"), "guide text", "utf-8");

    const commands = [
      {
        command: "skill import",
        args: {
          file: skillMdSource,
          id: "rollback-skill",
          name: "Rollback Skill",
          description: "Rollback test skill",
          origin: "local",
        },
      },
      {
        command: "task start",
        args: {
          ref: "@does-not-exist-task",
        },
      },
    ];

    const result = kspecJson<BatchExecResult>(
      `batch --commands '${JSON.stringify(commands)}'`,
      tempDir,
      { expectFail: true },
    );
    expect(result.success).toBe(false);
    expect(result.summary.succeeded).toBe(1);
    expect(result.summary.failed).toBe(1);

    const importedSkillMd = path.join(tempDir, ".kspec", "skills", "rollback-skill", "SKILL.md");
    const importedDoc = path.join(
      tempDir,
      ".kspec",
      "skills",
      "rollback-skill",
      "docs",
      "guide.md",
    );
    await expect(fs.access(importedSkillMd)).rejects.toThrow();
    await expect(fs.access(importedDoc)).rejects.toThrow();

    const skills = kspec("skill list", tempDir);
    expect(skills.stdout).not.toContain("rollback-skill");
  });

  // AC: @batch-write-buffer ac-4 — rollback on failure leaves .kspec/ unchanged
  it("atomic batch with failure leaves spec dir unchanged", () => {
    // Add baseline item
    kspec(`inbox add "baseline for rollback test"`, tempDir);
    const _inboxBefore = kspec("inbox list", tempDir);

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
