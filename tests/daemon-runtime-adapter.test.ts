import { describe, expect, it, vi } from "vitest";
import {
  createServerApp,
  logHeartbeatDegradationWarning,
  shouldEnableHeartbeat,
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

  // AC: @daemon-runtime-adapter ac-heartbeat-degradation
  it("enables heartbeat only for bun runtime", () => {
    expect(shouldEnableHeartbeat("bun")).toBe(true);
    expect(shouldEnableHeartbeat("node")).toBe(false);
  });

  // AC: @daemon-runtime-adapter ac-heartbeat-degradation
  it("logs the heartbeat degradation warning only for node runtime", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    logHeartbeatDegradationWarning("node");
    logHeartbeatDegradationWarning("bun");

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      "[daemon] Running on node: WebSocket heartbeat ping/pong is unavailable. Dead connection detection is disabled.",
    );
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
