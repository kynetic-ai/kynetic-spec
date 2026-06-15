/**
 * Platform detection for chord resolution.
 *
 * Detection prefers `navigator.platform` (still the most reliable signal for
 * macOS and overridable in tests) and falls back to the user-agent string.
 * Outside a browser (SSR / unit tests) the platform defaults to "other".
 */

import type { Platform } from "./types.js";

/** Detect the current platform from the browser environment. */
export function detectPlatform(): Platform {
  if (typeof navigator === "undefined") {
    return "other";
  }
  const haystack = `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`.toLowerCase();
  return /mac|iphone|ipad|ipod/.test(haystack) ? "mac" : "other";
}
