import * as fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

import {
  _resetCleanupRmForTesting,
  _setCleanupRmForTesting,
  cleanupTempDir,
  createTempDir,
} from "./helpers/cli.js";

describe("cleanupTempDir", () => {
  afterEach(() => {
    _resetCleanupRmForTesting();
  });

  it("retries transient ENOTEMPTY failures before succeeding", async () => {
    const tempDir = await createTempDir("kspec-cleanup-retry-");
    let attempts = 0;

    _setCleanupRmForTesting(async (target, options) => {
      if (target === tempDir && attempts < 2) {
        attempts += 1;
        const error = new Error("directory not empty") as NodeJS.ErrnoException;
        error.code = "ENOTEMPTY";
        throw error;
      }

      return fs.rm(target, options);
    });

    await cleanupTempDir(tempDir);

    expect(attempts).toBe(2);
    await expect(fs.stat(tempDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not hide persistent non-transient cleanup failures", async () => {
    const tempDir = await createTempDir("kspec-cleanup-fail-");
    let attempts = 0;

    _setCleanupRmForTesting(async (target, options) => {
      attempts += 1;
      if (target === tempDir) {
        const error = new Error("permission denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }

      return fs.rm(target, options);
    });

    await expect(cleanupTempDir(tempDir)).rejects.toMatchObject({ code: "EACCES" });
    expect(attempts).toBe(1);

    _resetCleanupRmForTesting();
    await fs.rm(tempDir, { recursive: true, force: true });
  });
});
