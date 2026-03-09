import { describe, it, expect, beforeEach } from "vitest";
import {
  setSyncMode,
  consumeSyncMode,
  _resetSyncModeForTesting,
} from "../src/cli/sync-mode.js";

describe("ShadowSyncMode", () => {
  beforeEach(() => {
    _resetSyncModeForTesting();
  });

  // AC: @shadow-lazy-read-sync ac-syncmode-propagation
  describe("setSyncMode + consumeSyncMode", () => {
    it("returns drift-check by default when setSyncMode was never called", () => {
      expect(consumeSyncMode()).toBe("drift-check");
    });

    it("returns the mode set by setSyncMode", () => {
      setSyncMode("always");
      expect(consumeSyncMode()).toBe("always");
    });

    it("returns skip when set to skip", () => {
      setSyncMode("skip");
      expect(consumeSyncMode()).toBe("skip");
    });

    it("returns drift-check when set to drift-check", () => {
      setSyncMode("drift-check");
      expect(consumeSyncMode()).toBe("drift-check");
    });
  });

  // AC: @shadow-lazy-read-sync ac-syncmode-consume-once
  describe("consume-once behavior", () => {
    it("returns skip on second consume within same command lifecycle", () => {
      setSyncMode("always");
      expect(consumeSyncMode()).toBe("always");
      expect(consumeSyncMode()).toBe("skip");
    });

    it("returns skip on third consume too", () => {
      setSyncMode("drift-check");
      expect(consumeSyncMode()).toBe("drift-check");
      expect(consumeSyncMode()).toBe("skip");
      expect(consumeSyncMode()).toBe("skip");
    });

    it("resets consume-once when setSyncMode is called again (new command)", () => {
      setSyncMode("always");
      expect(consumeSyncMode()).toBe("always");
      expect(consumeSyncMode()).toBe("skip");

      // New command lifecycle
      setSyncMode("drift-check");
      expect(consumeSyncMode()).toBe("drift-check");
      expect(consumeSyncMode()).toBe("skip");
    });

    it("non-Commander callers always get drift-check (never consumed)", () => {
      // Without any setSyncMode call, every consumeSyncMode returns drift-check
      expect(consumeSyncMode()).toBe("drift-check");
      expect(consumeSyncMode()).toBe("drift-check");
      expect(consumeSyncMode()).toBe("drift-check");
    });
  });

  describe("cross-command isolation", () => {
    it("does not bleed state between command lifecycles", () => {
      // Command 1: mutating → skip
      setSyncMode("skip");
      expect(consumeSyncMode()).toBe("skip");

      // Command 2: always sync
      setSyncMode("always");
      expect(consumeSyncMode()).toBe("always");
      expect(consumeSyncMode()).toBe("skip"); // consumed
    });
  });
});
