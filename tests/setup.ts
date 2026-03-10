/**
 * Vitest setup file — runs before each test file.
 *
 * Ensures globalThis.crypto exists in Node environments that lack it.
 */
import crypto from "node:crypto";

if (!globalThis.crypto) {
  // Node < 19 does not expose crypto on globalThis by default.
  // Assign the Node.js webcrypto implementation so tests using
  // crypto.randomUUID() or the WebSocket stack do not throw
  // ReferenceError: crypto is not defined.
  (globalThis as Record<string, unknown>).crypto = crypto.webcrypto;
}
