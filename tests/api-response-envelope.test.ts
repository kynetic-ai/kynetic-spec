/**
 * Behavioral tests for the unified API response envelope.
 *
 * Tests the wrapResponse() helper and toCacheStatus() mapping to verify
 * the envelope contract defined by @api-contract ac-envelope and
 * ac-cache-status-field.
 *
 * AC: @api-contract ac-envelope
 * AC: @api-contract ac-cache-status-field
 */

import { describe, expect, it } from "vitest";
import { wrapResponse, toCacheStatus } from "../dist/daemon/routes/response-envelope.ts";

// ─── Trait AC Coverage ──────────────────────────────────────────────────────
// This task defines the envelope type and wrapper function only.
// Route handler migration and CLI commands are separate tasks.
//
// AC: @trait-json-output ac-1 — N/A: this task defines types, not a CLI command
// AC: @trait-json-output ac-2 — N/A: this task defines types, not a CLI command
// AC: @trait-json-output ac-3 — N/A: this task defines types, not a CLI command
// AC: @trait-json-output ac-4 — N/A: this task defines types, not a CLI command
// AC: @trait-json-output ac-5 — N/A: this task defines types, not a CLI command
// AC: @trait-json-output ac-6 — N/A: this task defines types, not a CLI command
// AC: @trait-filterable-list ac-1 — N/A: this task defines types, not a list command
// AC: @trait-filterable-list ac-2 — N/A: this task defines types, not a list command
// AC: @trait-filterable-list ac-3 — N/A: this task defines types, not a list command
// AC: @trait-filterable-list ac-4 — N/A: this task defines types, not a list command
// AC: @trait-filterable-list ac-5 — N/A: this task defines types, not a list command
// AC: @trait-filterable-list ac-6 — N/A: this task defines types, not a list command
// AC: @trait-filterable-list ac-7 — N/A: this task defines types, not a list command
// AC: @trait-filterable-list ac-8 — N/A: this task defines types, not a list command
// AC: @trait-error-guidance ac-1 — N/A: this task defines types, not error handling
// AC: @trait-error-guidance ac-2 — N/A: this task defines types, not error handling
// AC: @trait-error-guidance ac-3 — N/A: this task defines types, not error handling
// AC: @trait-error-guidance ac-4 — N/A: this task defines types, not error handling
// AC: @trait-error-guidance ac-5 — N/A: this task defines types, not error handling
// AC: @trait-error-guidance ac-6 — N/A: this task defines types, not error handling
// AC: @trait-api-endpoint ac-1 — N/A: route handler migration is @task-migrate-route-handlers-envelope
// AC: @trait-api-endpoint ac-2 — N/A: route handler migration is @task-migrate-route-handlers-envelope
// AC: @trait-api-endpoint ac-3 — N/A: route handler migration is @task-migrate-route-handlers-envelope
// AC: @trait-api-endpoint ac-4 — N/A: route handler migration is @task-migrate-route-handlers-envelope
// AC: @trait-api-endpoint ac-5 — N/A: route handler migration is @task-migrate-route-handlers-envelope
// AC: @trait-api-endpoint ac-6 — N/A: route handler migration is @task-migrate-route-handlers-envelope
// AC: @trait-websocket-protocol ac-1 — N/A: this task doesn't touch WebSocket protocol
// AC: @trait-websocket-protocol ac-2 — N/A: this task doesn't touch WebSocket protocol
// AC: @trait-websocket-protocol ac-3 — N/A: this task doesn't touch WebSocket protocol
// AC: @trait-websocket-protocol ac-4 — N/A: this task doesn't touch WebSocket protocol
// AC: @trait-websocket-protocol ac-5 — N/A: this task doesn't touch WebSocket protocol
// AC: @trait-websocket-protocol ac-6 — N/A: this task doesn't touch WebSocket protocol
// AC: @trait-websocket-protocol ac-7 — N/A: this task doesn't touch WebSocket protocol
// AC: @trait-websocket-protocol ac-8 — N/A: this task doesn't touch WebSocket protocol
// AC: @trait-task-readiness ac-status — N/A: this task doesn't touch task readiness logic
// AC: @trait-task-readiness ac-deps — N/A: this task doesn't touch task readiness logic
// AC: @trait-task-readiness ac-not-blocked — N/A: this task doesn't touch task readiness logic
// AC: @trait-task-readiness ac-composable — N/A: this task doesn't touch task readiness logic

describe("toCacheStatus", () => {
  // AC: @api-contract ac-cache-status-field
  it('maps "loading" domain state to "loading" cache status', () => {
    expect(toCacheStatus("loading")).toBe("loading");
  });

  // AC: @api-contract ac-cache-status-field
  it('maps "ready" domain state to "ready" cache status', () => {
    expect(toCacheStatus("ready")).toBe("ready");
  });

  // AC: @api-contract ac-cache-status-field
  it('maps "degraded" domain state to "ready" cache status', () => {
    expect(toCacheStatus("degraded")).toBe("ready");
  });

  // AC: @api-contract ac-cache-status-field
  it('maps "unloaded" domain state to "ready" cache status', () => {
    expect(toCacheStatus("unloaded")).toBe("ready");
  });

  // AC: @api-contract ac-cache-status-field
  it('maps undefined domain state to "ready" cache status', () => {
    expect(toCacheStatus(undefined)).toBe("ready");
  });
});

describe("wrapResponse", () => {
  // AC: @api-contract ac-envelope
  it("wraps array data with default ready status", () => {
    const result = wrapResponse([1, 2, 3]);

    expect(result).toEqual({
      data: [1, 2, 3],
      meta: { cache_status: "ready" },
    });
  });

  // AC: @api-contract ac-envelope
  it("wraps object data with default ready status", () => {
    const payload = { counts: { pending: 3, completed: 7 }, total: 10 };
    const result = wrapResponse(payload);

    expect(result).toEqual({
      data: payload,
      meta: { cache_status: "ready" },
    });
  });

  // AC: @api-contract ac-envelope
  it("includes pagination fields in meta when provided", () => {
    const items = ["a", "b"];
    const result = wrapResponse(items, { total: 10, offset: 2, limit: 2 });

    expect(result).toEqual({
      data: items,
      meta: { cache_status: "ready", total: 10, offset: 2, limit: 2 },
    });
  });

  // AC: @api-contract ac-envelope
  it("omits pagination fields from meta when not provided", () => {
    const result = wrapResponse({ value: 42 });

    expect(result.meta).toEqual({ cache_status: "ready" });
    expect(result.meta).not.toHaveProperty("total");
    expect(result.meta).not.toHaveProperty("offset");
    expect(result.meta).not.toHaveProperty("limit");
  });

  // AC: @api-contract ac-cache-status-field
  it('returns loading status with empty data for warming cache', () => {
    const result = wrapResponse([], {
      total: 0,
      offset: 0,
      limit: 0,
      cacheDomainState: "loading",
    });

    expect(result).toEqual({
      data: [],
      meta: { cache_status: "loading", total: 0, offset: 0, limit: 0 },
    });
  });

  // AC: @api-contract ac-cache-status-field
  it('returns ready status for populated cache', () => {
    const items = [{ id: "1", name: "task" }];
    const result = wrapResponse(items, {
      total: 1,
      offset: 0,
      limit: 10,
      cacheDomainState: "ready",
    });

    expect(result.meta.cache_status).toBe("ready");
    expect(result.data).toEqual(items);
  });

  // AC: @api-contract ac-cache-status-field
  it("distinguishes cache-warming empty from genuine empty", () => {
    const warmingResult = wrapResponse([], {
      total: 0,
      offset: 0,
      limit: 0,
      cacheDomainState: "loading",
    });
    const emptyResult = wrapResponse([], {
      total: 0,
      offset: 0,
      limit: 10,
      cacheDomainState: "ready",
    });

    // Both have empty data arrays
    expect(warmingResult.data).toEqual([]);
    expect(emptyResult.data).toEqual([]);

    // But differ in cache_status — this is the key distinguishing signal
    expect(warmingResult.meta.cache_status).toBe("loading");
    expect(emptyResult.meta.cache_status).toBe("ready");
  });

  // AC: @api-contract ac-envelope
  it('treats degraded cache domain state as ready', () => {
    const result = wrapResponse(["item"], { cacheDomainState: "degraded" });
    expect(result.meta.cache_status).toBe("ready");
  });

  // AC: @api-contract ac-envelope
  it("includes pagination with zero values correctly", () => {
    const result = wrapResponse([], {
      total: 0,
      offset: 0,
      limit: 0,
    });

    expect(result.meta.total).toBe(0);
    expect(result.meta.offset).toBe(0);
    expect(result.meta.limit).toBe(0);
  });
});
