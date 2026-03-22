/**
 * Active Session Registry tests.
 *
 * Tests for the runtime session registry that maps session identifiers
 * to handles supporting prompt delivery, state query, and close requests.
 *
 * Task: @task-session-registry
 * Spec: @active-session-registry
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  SessionRegistry,
  type SessionHandle,
  type SessionState,
} from "../src/agent-runtime/session-registry.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Create a mock SessionHandle for testing.
 * Simulates a session with controllable state.
 */
function createMockHandle(initialState: SessionState = "idle"): SessionHandle & {
  state: SessionState;
  prompts: string[];
  closeReason: string | undefined;
} {
  const mock = {
    state: initialState,
    prompts: [] as string[],
    closeReason: undefined as string | undefined,
    sendPrompt: vi.fn(async (prompt: string) => {
      if (mock.state === "closed") {
        throw new Error("Session is closed");
      }
      mock.prompts.push(prompt);
    }),
    getState: vi.fn(() => mock.state),
    requestClose: vi.fn((reason: string) => {
      mock.closeReason = reason;
      mock.state = "closed";
    }),
  };
  return mock;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("SessionRegistry", () => {
  let registry: SessionRegistry;

  beforeEach(() => {
    registry = new SessionRegistry();
  });

  // AC: @active-session-registry ac-1
  describe("register and retrieve", () => {
    // AC: @active-session-registry ac-1
    it("should map a session to a handle that supports prompt delivery", async () => {
      const handle = createMockHandle("idle");
      registry.register("session-1", handle);

      const retrieved = registry.get("session-1");
      expect(retrieved).toBeDefined();
      await retrieved!.sendPrompt("Hello, agent");
      expect(handle.prompts).toEqual(["Hello, agent"]);
    });

    // AC: @active-session-registry ac-1
    it("should map a session to a handle that supports state query", () => {
      const handle = createMockHandle("prompting");
      registry.register("session-2", handle);

      const retrieved = registry.get("session-2");
      expect(retrieved).toBeDefined();
      expect(retrieved!.getState()).toBe("prompting");
    });

    // AC: @active-session-registry ac-1
    it("should map a session to a handle that supports close requests", () => {
      const handle = createMockHandle("idle");
      registry.register("session-3", handle);

      const retrieved = registry.get("session-3");
      expect(retrieved).toBeDefined();
      retrieved!.requestClose("user requested");
      expect(handle.closeReason).toBe("user requested");
      expect(handle.getState()).toBe("closed");
    });

    it("should track registry size after registration", () => {
      expect(registry.size).toBe(0);
      registry.register("s1", createMockHandle());
      expect(registry.size).toBe(1);
      registry.register("s2", createMockHandle());
      expect(registry.size).toBe(2);
    });

    it("should replace an existing handle when registering with the same id", () => {
      const handle1 = createMockHandle("idle");
      const handle2 = createMockHandle("prompting");

      registry.register("session-x", handle1);
      registry.register("session-x", handle2);

      const retrieved = registry.get("session-x");
      expect(retrieved!.getState()).toBe("prompting");
      expect(registry.size).toBe(1);
    });
  });

  // AC: @active-session-registry ac-2
  describe("unregister", () => {
    // AC: @active-session-registry ac-2
    it("should remove a session and return true", () => {
      const handle = createMockHandle();
      registry.register("session-cleanup", handle);

      const removed = registry.unregister("session-cleanup");
      expect(removed).toBe(true);
    });

    // AC: @active-session-registry ac-2
    it("should make subsequent lookups return undefined after unregister", () => {
      const handle = createMockHandle();
      registry.register("session-gone", handle);

      registry.unregister("session-gone");
      expect(registry.get("session-gone")).toBeUndefined();
    });

    it("should return false when unregistering a non-existent session", () => {
      const removed = registry.unregister("does-not-exist");
      expect(removed).toBe(false);
    });

    it("should decrement size after unregister", () => {
      registry.register("s1", createMockHandle());
      registry.register("s2", createMockHandle());
      expect(registry.size).toBe(2);

      registry.unregister("s1");
      expect(registry.size).toBe(1);
    });
  });

  // AC: @active-session-registry ac-3
  describe("get (lookup)", () => {
    // AC: @active-session-registry ac-3
    it("should return a handle for an active session", () => {
      const handle = createMockHandle("idle");
      registry.register("active-session", handle);

      const result = registry.get("active-session");
      expect(result).toBe(handle);
    });

    // AC: @active-session-registry ac-3
    it("should return undefined for a closed (unregistered) session", () => {
      const handle = createMockHandle();
      registry.register("temp-session", handle);
      registry.unregister("temp-session");

      expect(registry.get("temp-session")).toBeUndefined();
    });

    // AC: @active-session-registry ac-3
    it("should return undefined for a session that was never registered", () => {
      expect(registry.get("never-existed")).toBeUndefined();
    });
  });

  // AC: @active-session-registry ac-4
  describe("closeAll (daemon shutdown)", () => {
    // AC: @active-session-registry ac-4
    it("should close all registered sessions with the given reason", () => {
      const handle1 = createMockHandle("idle");
      const handle2 = createMockHandle("prompting");
      const handle3 = createMockHandle("idle");

      registry.register("s1", handle1);
      registry.register("s2", handle2);
      registry.register("s3", handle3);

      registry.closeAll("daemon shutdown");

      expect(handle1.requestClose).toHaveBeenCalledWith("daemon shutdown");
      expect(handle2.requestClose).toHaveBeenCalledWith("daemon shutdown");
      expect(handle3.requestClose).toHaveBeenCalledWith("daemon shutdown");
    });

    // AC: @active-session-registry ac-4
    it("should clear the registry after closeAll", () => {
      registry.register("s1", createMockHandle());
      registry.register("s2", createMockHandle());

      registry.closeAll("shutdown");

      expect(registry.size).toBe(0);
      expect(registry.get("s1")).toBeUndefined();
      expect(registry.get("s2")).toBeUndefined();
      expect(registry.listActive()).toEqual([]);
    });

    // AC: @active-session-registry ac-4
    it("should continue closing remaining sessions even if one throws", () => {
      const throwingHandle: SessionHandle = {
        sendPrompt: vi.fn(async () => {}),
        getState: vi.fn(() => "idle" as SessionState),
        requestClose: vi.fn(() => {
          throw new Error("close failed");
        }),
      };
      const normalHandle = createMockHandle("idle");

      registry.register("s-bad", throwingHandle);
      registry.register("s-good", normalHandle);

      // Should not throw
      registry.closeAll("shutdown");

      expect(throwingHandle.requestClose).toHaveBeenCalledWith("shutdown");
      expect(normalHandle.requestClose).toHaveBeenCalledWith("shutdown");
      expect(registry.size).toBe(0);
    });

    it("should be a no-op on an empty registry", () => {
      // Should not throw
      registry.closeAll("shutdown");
      expect(registry.size).toBe(0);
    });
  });

  describe("listActive", () => {
    it("should return empty array when no sessions registered", () => {
      expect(registry.listActive()).toEqual([]);
    });

    it("should return all registered session identifiers", () => {
      registry.register("alpha", createMockHandle());
      registry.register("beta", createMockHandle());
      registry.register("gamma", createMockHandle());

      const active = registry.listActive();
      expect(active).toHaveLength(3);
      expect(active).toContain("alpha");
      expect(active).toContain("beta");
      expect(active).toContain("gamma");
    });

    it("should not include unregistered sessions", () => {
      registry.register("keep", createMockHandle());
      registry.register("remove", createMockHandle());
      registry.unregister("remove");

      expect(registry.listActive()).toEqual(["keep"]);
    });
  });
});
