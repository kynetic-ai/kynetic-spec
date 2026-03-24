import { afterEach, describe, expect, it } from "vitest";
import {
  initContext,
  loadAllItems,
  readYamlFile,
  saveSpecItem,
  updateSpecItem,
  writeYamlFilePreserveFormat,
  type LoadedSpecItem,
} from "../src/parser/index.js";
import { cleanupTempDir, setupTempFixtures, testUlid } from "./helpers/cli.js";

function findItemBySlug(items: LoadedSpecItem[], slug: string): LoadedSpecItem {
  const found = items.find((item) => item.slugs.includes(slug));
  if (!found) {
    throw new Error(`Missing fixture item: ${slug}`);
  }
  return found;
}

describe("Spec Item Mutation Serialization", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) {
      await cleanupTempDir(tempDir);
    }
  });

  it("falls back to ULID lookup when the stored _path is stale", async () => {
    tempDir = await setupTempFixtures();
    const ctx = await initContext(tempDir);
    const target = findItemBySlug(await loadAllItems(ctx), "test-feature");

    expect(target._path).toBe("features[0]");
    expect(target._sourceFile).toBeDefined();

    const raw = await readYamlFile<unknown>(target._sourceFile!);
    const document = raw as { features?: unknown[] };
    expect(Array.isArray(document.features)).toBe(true);

    document.features!.unshift({
      _ulid: testUlid("NEWFEAT", 1),
      slugs: ["inserted-feature"],
      title: "Inserted Feature",
      type: "feature",
      description: "inserted concurrently",
      tags: [],
      depends_on: [],
      implements: [],
      relates_to: [],
      tests: [],
      traits: [],
      notes: [],
    });
    await writeYamlFilePreserveFormat(target._sourceFile!, raw);

    await updateSpecItem(ctx, target, {
      description: "updated through stale path safely",
    });

    const refreshedItems = await loadAllItems(ctx);
    const refreshedTarget = findItemBySlug(refreshedItems, "test-feature");
    const inserted = findItemBySlug(refreshedItems, "inserted-feature");

    expect(refreshedTarget.description).toBe("updated through stale path safely");
    expect(inserted.description).toBe("inserted concurrently");
  });

  it("saveSpecItem applies only patch fields and preserves concurrent edits", async () => {
    tempDir = await setupTempFixtures();
    const ctx = await initContext(tempDir);
    const target = findItemBySlug(await loadAllItems(ctx), "test-feature");

    const staleSnapshot: LoadedSpecItem = {
      ...target,
      tags: ["stale-tag"],
      description: "stale description",
    };

    await updateSpecItem(ctx, target, {
      tags: [...(target.tags || []), "concurrent-tag"],
      description: "fresh concurrent description",
    });

    await saveSpecItem(ctx, staleSnapshot, {
      title: "Patched Feature Title",
    });

    const refreshedTarget = findItemBySlug(await loadAllItems(ctx), "test-feature");
    expect(refreshedTarget.title).toBe("Patched Feature Title");
    expect(refreshedTarget.description).toBe("fresh concurrent description");
    expect(refreshedTarget.tags).toContain("concurrent-tag");
    expect(refreshedTarget.tags).not.toContain("stale-tag");
  });

  it("rejects full LoadedSpecItem payloads for updateSpecItem", async () => {
    tempDir = await setupTempFixtures();
    const ctx = await initContext(tempDir);
    const target = findItemBySlug(await loadAllItems(ctx), "test-feature");

    await expect(
      updateSpecItem(ctx, target, {
        ...(target as unknown as Record<string, unknown>),
      }),
    ).rejects.toThrow("patch object");
  });

  it("rejects empty saveSpecItem patches", async () => {
    tempDir = await setupTempFixtures();
    const ctx = await initContext(tempDir);
    const target = findItemBySlug(await loadAllItems(ctx), "test-feature");

    await expect(saveSpecItem(ctx, target, {})).rejects.toThrow(
      "Cannot save spec item without updates",
    );
  });
});
