import { describe, expect, it, vi } from "vitest";
import {
  createServerApp,
  stopManagedServer,
  type DaemonRuntime,
} from "../dist/daemon/server.js";

describe("daemon runtime adapter wiring", () => {
  // AC: @daemon-runtime-adapter ac-http-parity
  it.each([
    ["node", true],
    ["bun", false],
  ] as const)("applies the Elysia node adapter only for %s runtime", async (runtime, usesAdapter) => {
    const app = await createServerApp(runtime as DaemonRuntime);

    expect(Boolean((app.config as { adapter?: unknown }).adapter)).toBe(usesAdapter);
  });
});

describe("daemon runtime-aware shutdown", () => {
  // AC: @daemon-runtime-adapter ac-graceful-shutdown
  it("prefers stop() when the runtime server exposes it", async () => {
    const stop = vi.fn(async () => undefined);
    const close = vi.fn();

    await stopManagedServer({ stop, close });

    expect(stop).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
  });

  // AC: @daemon-runtime-adapter ac-graceful-shutdown
  it("falls back to close() when stop() is unavailable", async () => {
    const close = vi.fn((callback: (error?: Error | null) => void) => callback(null));

    await stopManagedServer({ close });

    expect(close).toHaveBeenCalledTimes(1);
  });
});
