/**
 * Integration tests for the format-version ceiling 409 contract across
 * daemon API routes.
 *
 * Each test mounts a project whose manifest declares a format version the
 * running tool does not support and asserts that routes respond with a
 * structured 409 carrying the same deterministic code as the CLI refusal
 * plus both version values, instead of escaping as a 500 — and that no
 * project data is modified.
 *
 * AC: @data-format-forward-compatibility ac-daemon-structured-error
 */

import { readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import type { Elysia } from "elysia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupTempDir,
  createTempDir,
  createTestApp,
  initGitRepo,
  makeRequest,
  setupInlineFixtures,
} from "./helpers.js";
import { readTestOutputSync } from "../helpers/cli.js";

const NEWER_FORMAT_MANIFEST = `kynetic: "9.9"
project:
  name: Test Project
  version: "0.1.0"
  status: draft
task_storage:
  format: split
includes:
  - modules/test.yaml
`;

const UNRECOGNIZED_FORMAT_MANIFEST = `kynetic: "mystery-format"
project:
  name: Test Project
  version: "0.1.0"
  status: draft
task_storage:
  format: split
includes:
  - modules/test.yaml
`;

interface FormatVersionConflictBody {
  error: string;
  message?: string;
  suggestion?: string;
  code?: string;
  declared_version?: string;
  max_supported_version?: string;
}

interface FileSnapshot {
  content: string;
  mtimeMs: number;
}

/** Snapshot project files (content + mtime), excluding git internals. */
function snapshotProjectFiles(dir: string): Map<string, FileSnapshot> {
  const snapshot = new Map<string, FileSnapshot>();
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      if (name === ".git" || name === ".test-home") continue;
      const fullPath = path.join(current, name);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (stat.isFile()) {
        // Test-generated fixture files, snapshotted to prove the structured
        // refusal modified nothing
        snapshot.set(path.relative(dir, fullPath), {
          content: readTestOutputSync(fullPath),
          mtimeMs: stat.mtimeMs,
        });
      }
    }
  };
  walk(dir);
  return snapshot;
}

let tempDir: string;
let app: Elysia;

beforeEach(async () => {
  tempDir = await createTempDir("kspec-daemon-api-format-version-conflict-");
  initGitRepo(tempDir);
  ({ app } = createTestApp());
});

afterEach(async () => {
  await cleanupTempDir(tempDir);
});

function request(urlPath: string, init?: RequestInit) {
  return makeRequest(app, tempDir, urlPath, init);
}

describe("Format version ceiling — newer-than-supported manifest", () => {
  beforeEach(() => {
    setupInlineFixtures(tempDir, { manifest: NEWER_FORMAT_MANIFEST });
  });

  // AC: @data-format-forward-compatibility ac-daemon-structured-error
  it("GET /api/tasks returns a structured 409 with the deterministic code and both versions", async () => {
    const before = snapshotProjectFiles(tempDir);

    const response = await request("/api/tasks");
    expect(response.status).toBe(409);
    const body = (await response.json()) as FormatVersionConflictBody;
    expect(body.error).toBe("format_version_incompatible");
    expect(body.code).toBe("format_version_newer_than_supported");
    expect(body.declared_version).toBe("9.9");
    expect(body.max_supported_version).toBe("1.2");
    expect(body.message).toContain('"9.9"');
    expect(body.message).toContain('"1.2"');
    expect(body.suggestion).toMatch(/upgrade/i);

    // No project data modified
    const after = snapshotProjectFiles(tempDir);
    expect(after).toEqual(before);
  });

  // AC: @data-format-forward-compatibility ac-daemon-structured-error
  it("GET /api/items returns the same structured 409", async () => {
    const response = await request("/api/items");
    expect(response.status).toBe(409);
    const body = (await response.json()) as FormatVersionConflictBody;
    expect(body.error).toBe("format_version_incompatible");
    expect(body.code).toBe("format_version_newer_than_supported");
    expect(body.declared_version).toBe("9.9");
    expect(body.max_supported_version).toBe("1.2");
  });

  // AC: @data-format-forward-compatibility ac-daemon-structured-error
  it("a mutating route refuses with the structured 409 and modifies nothing", async () => {
    const before = snapshotProjectFiles(tempDir);

    const response = await request("/api/inbox", {
      method: "POST",
      body: JSON.stringify({ text: "must not land" }),
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as FormatVersionConflictBody;
    expect(body.error).toBe("format_version_incompatible");
    expect(body.code).toBe("format_version_newer_than_supported");

    const after = snapshotProjectFiles(tempDir);
    expect(after).toEqual(before);
  });
});

describe("Format version ceiling — unrecognized manifest version", () => {
  beforeEach(() => {
    setupInlineFixtures(tempDir, { manifest: UNRECOGNIZED_FORMAT_MANIFEST });
  });

  // AC: @data-format-forward-compatibility ac-daemon-structured-error
  // AC: @data-format-forward-compatibility ac-unrecognized-version-refused
  it("GET /api/tasks returns a structured 409 naming the literal value", async () => {
    const response = await request("/api/tasks");
    expect(response.status).toBe(409);
    const body = (await response.json()) as FormatVersionConflictBody;
    expect(body.error).toBe("format_version_incompatible");
    expect(body.code).toBe("unrecognized_format_version");
    expect(body.declared_version).toBe("mystery-format");
    expect(body.message).toContain('"mystery-format"');
  });
});
