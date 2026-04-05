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
import { z } from "zod";
import { wrapResponse, toCacheStatus } from "../dist/daemon/routes/response-envelope.js";
import {
  CacheStatusSchema,
  ApiResponseMetaSchema,
  ApiResponseSchema,
} from "../packages/shared/src/api.ts";

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
  it("returns loading status with empty data for warming cache", () => {
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
  it("returns ready status for populated cache", () => {
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
  it("treats degraded cache domain state as ready", () => {
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

// ─── Zod Runtime Schema Tests ─────────────────────────────────────────────
// These tests verify the runtime Zod schemas parse and validate correctly,
// ensuring downstream consumers have a parseable runtime contract.

describe("CacheStatusSchema", () => {
  // AC: @api-contract ac-cache-status-field
  it('accepts "ready" as a valid cache status', () => {
    expect(CacheStatusSchema.parse("ready")).toBe("ready");
  });

  // AC: @api-contract ac-cache-status-field
  it('accepts "loading" as a valid cache status', () => {
    expect(CacheStatusSchema.parse("loading")).toBe("loading");
  });

  // AC: @api-contract ac-cache-status-field
  it("rejects invalid cache status values", () => {
    expect(() => CacheStatusSchema.parse("degraded")).toThrow();
    expect(() => CacheStatusSchema.parse("unloaded")).toThrow();
    expect(() => CacheStatusSchema.parse("")).toThrow();
    expect(() => CacheStatusSchema.parse(42)).toThrow();
  });
});

describe("ApiResponseMetaSchema", () => {
  // AC: @api-contract ac-envelope
  it("parses meta with only cache_status", () => {
    const result = ApiResponseMetaSchema.parse({ cache_status: "ready" });
    expect(result).toEqual({ cache_status: "ready" });
  });

  // AC: @api-contract ac-envelope
  it("parses meta with pagination fields", () => {
    const result = ApiResponseMetaSchema.parse({
      cache_status: "loading",
      total: 100,
      offset: 20,
      limit: 10,
    });
    expect(result).toEqual({
      cache_status: "loading",
      total: 100,
      offset: 20,
      limit: 10,
    });
  });

  // AC: @api-contract ac-envelope
  it("allows omitting optional pagination fields", () => {
    const result = ApiResponseMetaSchema.parse({ cache_status: "ready" });
    expect(result.total).toBeUndefined();
    expect(result.offset).toBeUndefined();
    expect(result.limit).toBeUndefined();
  });

  // AC: @api-contract ac-envelope
  it("rejects meta without cache_status", () => {
    expect(() => ApiResponseMetaSchema.parse({})).toThrow();
    expect(() => ApiResponseMetaSchema.parse({ total: 10 })).toThrow();
  });

  // AC: @api-contract ac-cache-status-field
  it("rejects meta with invalid cache_status", () => {
    expect(() => ApiResponseMetaSchema.parse({ cache_status: "unknown" })).toThrow();
  });
});

describe("ApiResponseSchema", () => {
  // AC: @api-contract ac-envelope
  it("parses a response envelope with array data", () => {
    const schema = ApiResponseSchema(z.array(z.number()));
    const result = schema.parse({
      data: [1, 2, 3],
      meta: { cache_status: "ready" },
    });
    expect(result.data).toEqual([1, 2, 3]);
    expect(result.meta.cache_status).toBe("ready");
  });

  // AC: @api-contract ac-envelope
  it("parses a response envelope with object data", () => {
    const schema = ApiResponseSchema(z.object({ count: z.number() }));
    const result = schema.parse({
      data: { count: 42 },
      meta: { cache_status: "ready", total: 42 },
    });
    expect(result.data.count).toBe(42);
    expect(result.meta.total).toBe(42);
  });

  // AC: @api-contract ac-envelope
  it("rejects response missing data field", () => {
    const schema = ApiResponseSchema(z.array(z.string()));
    expect(() => schema.parse({ meta: { cache_status: "ready" } })).toThrow();
  });

  // AC: @api-contract ac-envelope
  it("rejects response missing meta field", () => {
    const schema = ApiResponseSchema(z.array(z.string()));
    expect(() => schema.parse({ data: [] })).toThrow();
  });

  // AC: @api-contract ac-envelope
  it("rejects response with wrong data type", () => {
    const schema = ApiResponseSchema(z.array(z.string()));
    expect(() => schema.parse({ data: "not-an-array", meta: { cache_status: "ready" } })).toThrow();
  });

  // AC: @api-contract ac-cache-status-field
  it("validates cache status within the envelope", () => {
    const schema = ApiResponseSchema(z.array(z.unknown()));
    expect(() => schema.parse({ data: [], meta: { cache_status: "invalid" } })).toThrow();
  });

  // AC: @api-contract ac-envelope
  // AC: @api-contract ac-cache-status-field
  it("validates wrapResponse output passes schema parsing", () => {
    const schema = ApiResponseSchema(z.array(z.string()));
    const wrapped = wrapResponse(["a", "b"], {
      total: 2,
      offset: 0,
      limit: 10,
      cacheDomainState: "ready",
    });
    const parsed = schema.parse(wrapped);
    expect(parsed).toEqual(wrapped);
  });

  // AC: @api-contract ac-cache-status-field
  it("validates wrapResponse loading output passes schema parsing", () => {
    const schema = ApiResponseSchema(z.array(z.string()));
    const wrapped = wrapResponse([] as string[], {
      total: 0,
      offset: 0,
      limit: 0,
      cacheDomainState: "loading",
    });
    const parsed = schema.parse(wrapped);
    expect(parsed.meta.cache_status).toBe("loading");
    expect(parsed.data).toEqual([]);
  });
});
