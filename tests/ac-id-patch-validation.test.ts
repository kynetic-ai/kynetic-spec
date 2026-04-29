/**
 * Tests for centralized AC ID validation across item patch surfaces.
 *
 * Covers:
 * - @acceptance-criterion-id-format ac-patch-rejects-invalid-id
 * - @item-patch ac-allow-unknown-rejects-invalid-ac-id
 * - @item-patch ac-bulk-dry-run-rejects-invalid-ac-id
 * - @item-patch ac-bulk-invalid-operation-not-written
 * - @item-patch ac-bulk-valid-operations-continue
 * - @item-patch ac-bulk-invalid-operation-fails-command
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { kspec, kspecJson, setupTempFixtures, cleanupTempDir } from "./helpers/cli.js";
import { validateSpecItemPatchData } from "../src/parser/yaml.js";
import {
  initContext,
  loadAllItems,
  updateSpecItem,
  readYamlFile,
  type LoadedSpecItem,
} from "../src/parser/index.js";

describe("AC ID patch validation", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    // Create test items for patching
    kspec(
      'item add --under @test-core --title "Patch Target A" --slug patch-target-a',
      tempDir,
    );
    kspec(
      'item add --under @test-core --title "Patch Target B" --slug patch-target-b',
      tempDir,
    );
    // Add a valid AC to target A for verification of preservation
    kspec(
      'item ac add @patch-target-a --id "ac-existing" --given "g" --when "w" --then "t"',
      tempDir,
    );
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // ─── Shared helper unit tests ──────────────────────────────────────

  describe("validateSpecItemPatchData helper", () => {
    it("returns null for valid patch data with valid AC IDs", () => {
      const result = validateSpecItemPatchData({
        acceptance_criteria: [
          { id: "ac-valid", given: "g", when: "w", then: "t" },
        ],
      });
      expect(result).toBeNull();
    });

    it("returns error string for invalid AC IDs in patch data", () => {
      const result = validateSpecItemPatchData({
        acceptance_criteria: [
          { id: "INVALID", given: "g", when: "w", then: "t" },
        ],
      });
      expect(result).not.toBeNull();
      expect(result).toContain("ac-prefixed kebab-case");
    });

    it("rejects unknown fields when allowUnknown is false", () => {
      const result = validateSpecItemPatchData(
        { custom_field: "value" },
        { allowUnknown: false },
      );
      expect(result).not.toBeNull();
    });

    it("allows unknown fields when allowUnknown is true", () => {
      const result = validateSpecItemPatchData(
        { custom_field: "value" },
        { allowUnknown: true },
      );
      expect(result).toBeNull();
    });

    it("still validates known fields when allowUnknown is true", () => {
      const result = validateSpecItemPatchData(
        {
          custom_field: "value",
          acceptance_criteria: [
            { id: "INVALID", given: "g", when: "w", then: "t" },
          ],
        },
        { allowUnknown: true },
      );
      expect(result).not.toBeNull();
      expect(result).toContain("ac-prefixed kebab-case");
    });

    // ─── Nested catalog AC ID validation ──────────────────────────────

    it("rejects invalid AC IDs in nested features", () => {
      const result = validateSpecItemPatchData(
        {
          features: [
            {
              _ulid: "01AAAAAAAAAAAAAAAAAAAATEST",
              title: "Nested Feature",
              acceptance_criteria: [
                { id: "BAD-ID", given: "g", when: "w", then: "t" },
              ],
            },
          ],
        },
        { allowUnknown: true },
      );
      expect(result).not.toBeNull();
      expect(result).toContain("ac-prefixed kebab-case");
      expect(result).toContain("features[0].acceptance_criteria[0].id");
    });

    it("rejects invalid AC IDs in nested requirements under features", () => {
      const result = validateSpecItemPatchData(
        {
          features: [
            {
              _ulid: "01AAAAAAAAAAAAAAAAAAAATEST",
              title: "Feature",
              requirements: [
                {
                  _ulid: "01BBBBBBBBBBBBBBBBBBBBBTEST",
                  title: "Requirement",
                  acceptance_criteria: [
                    { id: "INVALID-DEEP", given: "g", when: "w", then: "t" },
                  ],
                },
              ],
            },
          ],
        },
        { allowUnknown: true },
      );
      expect(result).not.toBeNull();
      expect(result).toContain("ac-prefixed kebab-case");
      expect(result).toContain("features[0].requirements[0].acceptance_criteria[0].id");
    });

    it("accepts valid AC IDs in nested catalog structures", () => {
      const result = validateSpecItemPatchData(
        {
          features: [
            {
              _ulid: "01AAAAAAAAAAAAAAAAAAAATEST",
              title: "Feature",
              acceptance_criteria: [
                { id: "ac-nested-valid", given: "g", when: "w", then: "t" },
              ],
            },
          ],
        },
        { allowUnknown: true },
      );
      expect(result).toBeNull();
    });

    it("rejects invalid AC IDs in nested catalog without allowUnknown", () => {
      const result = validateSpecItemPatchData({
        features: [
          {
            _ulid: "01AAAAAAAAAAAAAAAAAAAATEST",
            title: "Feature",
            acceptance_criteria: [
              { id: "BAD-ID", given: "g", when: "w", then: "t" },
            ],
          },
        ],
      });
      expect(result).not.toBeNull();
      // Should report both the unknown field error AND the nested AC ID error
      expect(result).toContain("ac-prefixed kebab-case");
    });
  });

  // ─── Single item patch: ac-patch-rejects-invalid-id ────────────────

  // AC: @acceptance-criterion-id-format ac-patch-rejects-invalid-id
  describe("single item patch rejects invalid AC IDs", () => {
    it("rejects invalid AC ID in real mode", () => {
      const data = JSON.stringify({
        acceptance_criteria: [
          { id: "INVALID-ID", given: "g", when: "w", then: "t" },
        ],
      });
      const result = kspec(
        `item patch @patch-target-a --data '${data}'`,
        tempDir,
        { expectFail: true },
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("ac-prefixed kebab-case");
    });

    it("rejects invalid AC ID in dry-run mode", () => {
      const data = JSON.stringify({
        acceptance_criteria: [
          { id: "bad_id", given: "g", when: "w", then: "t" },
        ],
      });
      const result = kspec(
        `item patch @patch-target-a --data '${data}' --dry-run`,
        tempDir,
        { expectFail: true },
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("ac-prefixed kebab-case");
    });

    it("does not mutate the item when AC ID is invalid", () => {
      const data = JSON.stringify({
        acceptance_criteria: [
          { id: "INVALID", given: "g", when: "w", then: "t" },
        ],
      });
      kspec(
        `item patch @patch-target-a --data '${data}'`,
        tempDir,
        { expectFail: true },
      );
      // Original AC should be preserved
      const item = kspecJson<{ acceptance_criteria: Array<{ id: string }> }>(
        "item get @patch-target-a",
        tempDir,
      );
      expect(item.acceptance_criteria).toHaveLength(1);
      expect(item.acceptance_criteria[0].id).toBe("ac-existing");
    });

    it("accepts valid AC IDs in patch", () => {
      const data = JSON.stringify({
        acceptance_criteria: [
          { id: "ac-new-valid", given: "g", when: "w", then: "t" },
        ],
      });
      const result = kspec(
        `item patch @patch-target-a --data '${data}'`,
        tempDir,
      );
      expect(result.exitCode).toBe(0);
      const item = kspecJson<{ acceptance_criteria: Array<{ id: string }> }>(
        "item get @patch-target-a",
        tempDir,
      );
      expect(item.acceptance_criteria[0].id).toBe("ac-new-valid");
    });
  });

  // ─── --allow-unknown: ac-allow-unknown-rejects-invalid-ac-id ───────

  // AC: @item-patch ac-allow-unknown-rejects-invalid-ac-id
  describe("--allow-unknown rejects invalid AC IDs for known fields", () => {
    it("rejects invalid AC ID even with --allow-unknown", () => {
      const data = JSON.stringify({
        acceptance_criteria: [
          { id: "INVALID", given: "g", when: "w", then: "t" },
        ],
        custom_extension: "allowed",
      });
      const result = kspec(
        `item patch @patch-target-a --data '${data}' --allow-unknown`,
        tempDir,
        { expectFail: true },
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("ac-prefixed kebab-case");
    });

    it("allows unknown fields with valid AC IDs under --allow-unknown", () => {
      const data = JSON.stringify({
        acceptance_criteria: [
          { id: "ac-valid-with-ext", given: "g", when: "w", then: "t" },
        ],
        custom_extension: "allowed",
      });
      const result = kspec(
        `item patch @patch-target-a --data '${data}' --allow-unknown`,
        tempDir,
      );
      expect(result.exitCode).toBe(0);
    });

    // AC: @item-patch ac-allow-unknown-rejects-invalid-ac-id
    it("rejects invalid AC ID in nested features even with --allow-unknown", () => {
      const data = JSON.stringify({
        features: [
          {
            _ulid: "01AAAAAAAAAAAAAAAAAAAATEST",
            title: "Nested Feature",
            acceptance_criteria: [
              { id: "BAD-ID", given: "g", when: "w", then: "t" },
            ],
          },
        ],
      });
      const result = kspec(
        `item patch @test-core --data '${data}' --allow-unknown`,
        tempDir,
        { expectFail: true },
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("ac-prefixed kebab-case");
    });

    // AC: @item-patch ac-allow-unknown-rejects-invalid-ac-id
    it("rejects invalid AC ID in deeply nested requirements with --allow-unknown", () => {
      const data = JSON.stringify({
        features: [
          {
            _ulid: "01AAAAAAAAAAAAAAAAAAAATEST",
            title: "Feature",
            requirements: [
              {
                _ulid: "01BBBBBBBBBBBBBBBBBBBBBTEST",
                title: "Requirement",
                acceptance_criteria: [
                  { id: "INVALID-DEEP", given: "g", when: "w", then: "t" },
                ],
              },
            ],
          },
        ],
      });
      const result = kspec(
        `item patch @test-core --data '${data}' --allow-unknown`,
        tempDir,
        { expectFail: true },
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("ac-prefixed kebab-case");
    });

    it("accepts valid AC IDs in nested features with --allow-unknown", () => {
      const data = JSON.stringify({
        features: [
          {
            _ulid: "01AAAAAAAAAAAAAAAAAAAATEST",
            title: "Nested Feature",
            acceptance_criteria: [
              { id: "ac-nested-valid", given: "g", when: "w", then: "t" },
            ],
          },
        ],
      });
      const result = kspec(
        `item patch @test-core --data '${data}' --allow-unknown`,
        tempDir,
      );
      expect(result.exitCode).toBe(0);
    });
  });

  // ─── Bulk dry-run: ac-bulk-dry-run-rejects-invalid-ac-id ───────────

  // AC: @item-patch ac-bulk-dry-run-rejects-invalid-ac-id
  describe("bulk --dry-run reports invalid AC ID as error", () => {
    it("reports invalid AC ID operation as error in dry-run", () => {
      const patches = JSON.stringify([
        {
          ref: "@patch-target-a",
          data: {
            acceptance_criteria: [
              { id: "INVALID", given: "g", when: "w", then: "t" },
            ],
          },
        },
      ]);
      const result = kspec(
        "item patch --bulk --dry-run",
        tempDir,
        { stdin: patches, expectFail: true },
      );
      expect(result.exitCode).not.toBe(0);
      // Should report as ERR, not OK/Would patch
      expect(result.stdout).toContain("ERR");
      expect(result.stdout).toContain("Invalid patch data");
    });

    it("reports invalid AC ID operation as failed in dry-run JSON output", () => {
      const patches = JSON.stringify([
        {
          ref: "@patch-target-a",
          data: {
            acceptance_criteria: [
              { id: "bad-FORMAT", given: "g", when: "w", then: "t" },
            ],
          },
        },
      ]);
      const result = kspec(
        "item patch --bulk --dry-run --json",
        tempDir,
        { stdin: patches, expectFail: true },
      );
      expect(result.exitCode).not.toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.summary.failed).toBe(1);
      expect(json.summary.updated).toBe(0);
      expect(json.results[0].status).toBe("error");
      expect(json.results[0].error).toContain("ac-prefixed kebab-case");
    });
  });

  // ─── Bulk write: ac-bulk-invalid-operation-not-written ─────────────

  // AC: @item-patch ac-bulk-invalid-operation-not-written
  describe("bulk mode does not write invalid operations", () => {
    it("does not persist invalid AC ID operation", () => {
      const patches = JSON.stringify([
        {
          ref: "@patch-target-a",
          data: {
            acceptance_criteria: [
              { id: "INVALID", given: "g", when: "w", then: "t" },
            ],
          },
        },
      ]);
      kspec(
        "item patch --bulk",
        tempDir,
        { stdin: patches, expectFail: true },
      );
      // Original AC should be preserved
      const item = kspecJson<{ acceptance_criteria: Array<{ id: string }> }>(
        "item get @patch-target-a",
        tempDir,
      );
      expect(item.acceptance_criteria).toHaveLength(1);
      expect(item.acceptance_criteria[0].id).toBe("ac-existing");
    });
  });

  // ─── Bulk write: ac-bulk-valid-operations-continue ─────────────────

  // AC: @item-patch ac-bulk-valid-operations-continue
  describe("bulk mode continues valid operations after invalid ones", () => {
    it("applies valid operation after invalid one without --fail-fast", () => {
      const patches = JSON.stringify([
        {
          ref: "@patch-target-a",
          data: {
            acceptance_criteria: [
              { id: "INVALID", given: "g", when: "w", then: "t" },
            ],
          },
        },
        {
          ref: "@patch-target-b",
          data: {
            title: "Updated Title B",
          },
        },
      ]);
      const result = kspec(
        "item patch --bulk --json",
        tempDir,
        { stdin: patches, expectFail: true },
      );
      const json = JSON.parse(result.stdout);
      expect(json.summary.failed).toBe(1);
      expect(json.summary.updated).toBe(1);
      expect(json.results[0].status).toBe("error");
      expect(json.results[1].status).toBe("updated");

      // Verify the valid operation was applied
      const itemB = kspecJson<{ title: string }>(
        "item get @patch-target-b",
        tempDir,
      );
      expect(itemB.title).toBe("Updated Title B");
    });

    it("skips valid operation after invalid one with --fail-fast", () => {
      const patches = JSON.stringify([
        {
          ref: "@patch-target-a",
          data: {
            acceptance_criteria: [
              { id: "INVALID", given: "g", when: "w", then: "t" },
            ],
          },
        },
        {
          ref: "@patch-target-b",
          data: {
            title: "Updated Title B",
          },
        },
      ]);
      const result = kspec(
        "item patch --bulk --fail-fast --json",
        tempDir,
        { stdin: patches, expectFail: true },
      );
      const json = JSON.parse(result.stdout);
      expect(json.summary.failed).toBe(1);
      expect(json.summary.skipped).toBe(1);
      expect(json.summary.updated).toBe(0);
      expect(json.results[0].status).toBe("error");
      expect(json.results[1].status).toBe("skipped");

      // Verify the second operation was NOT applied
      const itemB = kspecJson<{ title: string }>(
        "item get @patch-target-b",
        tempDir,
      );
      expect(itemB.title).toBe("Patch Target B");
    });
  });

  // ─── Bulk write: ac-bulk-invalid-operation-fails-command ───────────

  // AC: @item-patch ac-bulk-invalid-operation-fails-command
  describe("bulk mode exits nonzero when any operation has invalid data", () => {
    it("exits with failure status when one operation has invalid AC ID", () => {
      const patches = JSON.stringify([
        {
          ref: "@patch-target-b",
          data: { title: "Valid Update" },
        },
        {
          ref: "@patch-target-a",
          data: {
            acceptance_criteria: [
              { id: "NOT-VALID", given: "g", when: "w", then: "t" },
            ],
          },
        },
      ]);
      // Command should exit nonzero even though one operation succeeded
      const result = kspec(
        "item patch --bulk",
        tempDir,
        { stdin: patches, expectFail: true },
      );
      expect(result.exitCode).not.toBe(0);
    });
  });

  // ─── Parser-layer validation: updateSpecItem ───────────────────────

  // AC: @acceptance-criterion-id-format ac-patch-rejects-invalid-id
  describe("parser-layer updateSpecItem rejects invalid AC IDs", () => {
    function findItemBySlug(items: LoadedSpecItem[], slug: string): LoadedSpecItem {
      const found = items.find((item) => item.slugs.includes(slug));
      if (!found) throw new Error(`Missing fixture item: ${slug}`);
      return found;
    }

    it("rejects invalid acceptance_criteria IDs before writing", async () => {
      const ctx = await initContext(tempDir);
      const items = await loadAllItems(ctx);
      const target = findItemBySlug(items, "patch-target-b");

      // Capture file content before the call to verify no mutation
      const contentBefore = await readYamlFile<unknown>(target._sourceFile!);

      await expect(
        updateSpecItem(ctx, target, {
          acceptance_criteria: [
            { id: "parser-layer-INVALID", given: "g", when: "w", then: "t" },
          ],
        }),
      ).rejects.toThrow("ac-prefixed kebab-case");

      // Verify catalog was not mutated
      const contentAfter = await readYamlFile<unknown>(target._sourceFile!);
      expect(contentAfter).toEqual(contentBefore);
    });

    it("allows valid acceptance_criteria IDs through updateSpecItem", async () => {
      const ctx = await initContext(tempDir);
      const items = await loadAllItems(ctx);
      const target = findItemBySlug(items, "patch-target-b");

      const result = await updateSpecItem(ctx, target, {
        acceptance_criteria: [
          { id: "ac-valid-parser-layer", given: "g", when: "w", then: "t" },
        ],
      });

      expect(result.acceptance_criteria).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "ac-valid-parser-layer" }),
        ]),
      );
    });

    // AC: @acceptance-criterion-id-format ac-patch-rejects-invalid-id
    it("rejects invalid AC IDs in nested features via updateSpecItem", async () => {
      const ctx = await initContext(tempDir);
      const items = await loadAllItems(ctx);
      const target = findItemBySlug(items, "test-core");

      const contentBefore = await readYamlFile<unknown>(target._sourceFile!);

      // Features is not part of SpecItemInput (nested catalog field), so we
      // cast through unknown to simulate what happens when a caller passes
      // nested catalog data through the parser layer.
      const nestedPatch = {
        features: [
          {
            _ulid: "01AAAAAAAAAAAAAAAAAAAATEST",
            title: "Feature With Bad AC",
            acceptance_criteria: [
              { id: "BAD-NESTED-ID", given: "g", when: "w", then: "t" },
            ],
          },
        ],
      };
      await expect(
        updateSpecItem(ctx, target, nestedPatch as never),
      ).rejects.toThrow("ac-prefixed kebab-case");

      // Verify catalog was not mutated
      const contentAfter = await readYamlFile<unknown>(target._sourceFile!);
      expect(contentAfter).toEqual(contentBefore);
    });
  });

  // ─── Existing behavior preservation ────────────────────────────────

  describe("preserves existing valid behavior", () => {
    it("valid patches succeed in single mode", () => {
      const data = JSON.stringify({
        title: "Updated Title",
      });
      const result = kspec(
        `item patch @patch-target-a --data '${data}'`,
        tempDir,
      );
      expect(result.exitCode).toBe(0);
    });

    it("valid patches succeed in bulk mode", () => {
      const patches = JSON.stringify([
        { ref: "@patch-target-a", data: { title: "Bulk Updated A" } },
        { ref: "@patch-target-b", data: { title: "Bulk Updated B" } },
      ]);
      const result = kspec(
        "item patch --bulk --json",
        tempDir,
        { stdin: patches },
      );
      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.summary.updated).toBe(2);
      expect(json.summary.failed).toBe(0);
    });

    it("unknown fields accepted with --allow-unknown in single mode", () => {
      const data = JSON.stringify({
        custom_field: "value",
      });
      const result = kspec(
        `item patch @patch-target-a --data '${data}' --allow-unknown`,
        tempDir,
      );
      expect(result.exitCode).toBe(0);
    });

    it("AC removal via empty array succeeds", () => {
      const data = JSON.stringify({
        acceptance_criteria: [],
      });
      const result = kspec(
        `item patch @patch-target-a --data '${data}'`,
        tempDir,
      );
      expect(result.exitCode).toBe(0);
      const item = kspecJson<{ acceptance_criteria?: unknown[] }>(
        "item get @patch-target-a",
        tempDir,
      );
      expect(item.acceptance_criteria ?? []).toHaveLength(0);
    });
  });
});
