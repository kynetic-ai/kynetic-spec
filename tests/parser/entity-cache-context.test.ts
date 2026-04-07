import { describe, expect, it, vi } from "vitest";
import { getEntityCacheContext, runWithEntityCache } from "../../src/parser/yaml.js";

describe("entity cache async context", () => {
  // AC: @daemon-command-api ac-cache-context-propagation
  it("preserves entity cache context across async boundaries", async () => {
    const cacheAccessor = vi.fn(() => null);
    let contextBeforeAwait = getEntityCacheContext();
    let contextAfterAwait = getEntityCacheContext();

    await runWithEntityCache(
      async () => {
        contextBeforeAwait = getEntityCacheContext();
        await Promise.resolve();
        contextAfterAwait = getEntityCacheContext();
      },
      cacheAccessor,
      "/tmp/kspec-project",
    );

    expect(contextBeforeAwait).toEqual({
      cacheAccessor,
      projectPath: "/tmp/kspec-project",
    });
    expect(contextAfterAwait).toEqual({
      cacheAccessor,
      projectPath: "/tmp/kspec-project",
    });
  });

  // AC: @daemon-command-api ac-no-cache-outside-daemon
  it("returns undefined outside a cache-backed daemon execution context", () => {
    expect(getEntityCacheContext()).toBeUndefined();
  });
});
