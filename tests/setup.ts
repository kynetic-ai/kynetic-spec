/**
 * Vitest setup file — runs before each test file.
 *
 * Ensures globalThis.crypto exists in Node environments that lack it.
 * Isolates tests from the real ~/.claude/ plugin marketplace.
 */
import crypto from "node:crypto";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

if (!globalThis.crypto) {
  // Node < 19 does not expose crypto on globalThis by default.
  // Assign the Node.js webcrypto implementation so tests using
  // crypto.randomUUID() or the WebSocket stack do not throw
  // ReferenceError: crypto is not defined.
  (globalThis as Record<string, unknown>).crypto = crypto.webcrypto;
}

// Prevent tests that call `kspec setup` or `kspec skill install-core` from
// stomping the real ~/.claude/plugins/known_marketplaces.json. Tests that
// need their own isolation (e.g. claude-plugin-registry.test.ts) already
// set KSPEC_CLAUDE_HOME explicitly and will override this default.
if (!process.env.KSPEC_CLAUDE_HOME) {
  process.env.KSPEC_CLAUDE_HOME = mkdtempSync(join(tmpdir(), "kspec-test-claude-home-"));
}

if (!process.env.KSPEC_NO_DAEMON) {
  process.env.KSPEC_NO_DAEMON = "1";
}
