/**
 * Unit tests for the persisted preference utility.
 *
 * These exercise the utility's observable behavior through its public
 * accessor against the in-memory backend (and a deliberately broken storage
 * for the degradation cases) — no source inspection.
 *
 * Covers @ui-preference-store ac-1..ac-6 and @client-preference-persistence
 * ac-1 (shared namespaced/versioned key format).
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  APP_PREFIX,
  definePreference,
  InMemoryBackend,
  LocalStorageBackend,
  type StorageLike,
} from "../../packages/web-ui/src/lib/preferences/index.js";

describe("definePreference", () => {
  // AC: @ui-preference-store ac-1
  it("returns the stored value when read back through a fresh accessor on the same backend", () => {
    const backend = new InMemoryBackend();
    const write = definePreference<string>({
      namespace: "sidebar",
      key: "width",
      version: 1,
      default: "narrow",
      validate: (v) => typeof v === "string",
      backend,
    });

    write.set("wide");

    // A reload is modeled by a second accessor over the same persistent store.
    const read = definePreference<string>({
      namespace: "sidebar",
      key: "width",
      version: 1,
      default: "narrow",
      validate: (v) => typeof v === "string",
      backend,
    });

    expect(read.get()).toBe("wide");
  });

  // AC: @ui-preference-store ac-1
  it("returns the declared default when nothing has been stored", () => {
    const pref = definePreference<number>({
      namespace: "palette",
      key: "recent-count",
      version: 1,
      default: 5,
      validate: (v) => typeof v === "number",
      backend: new InMemoryBackend(),
    });

    expect(pref.get()).toBe(5);
  });

  // AC: @ui-preference-store ac-2
  it("isolates same-named keys registered under different namespaces", () => {
    const backend = new InMemoryBackend();
    const a = definePreference<string>({
      namespace: "alpha",
      key: "collapsed",
      version: 1,
      default: "",
      validate: (v) => typeof v === "string",
      backend,
    });
    const b = definePreference<string>({
      namespace: "beta",
      key: "collapsed",
      version: 1,
      default: "",
      validate: (v) => typeof v === "string",
      backend,
    });

    a.set("alpha-value");
    b.set("beta-value");

    expect(a.get()).toBe("alpha-value");
    expect(b.get()).toBe("beta-value");
    // Neither overwrote the other.
    a.set("alpha-2");
    expect(b.get()).toBe("beta-value");
  });

  // AC: @ui-preference-store ac-3
  it("migrates an older-versioned stored value using the declared upgrade rule", () => {
    const backend = new InMemoryBackend();

    // Seed a v1 value directly behind the interface.
    const v1 = definePreference<{ name: string }>({
      namespace: "view",
      key: "layout",
      version: 1,
      default: { name: "default" },
      validate: (v) =>
        typeof v === "object" && v !== null && typeof (v as { name?: unknown }).name === "string",
      backend,
    });
    v1.set({ name: "grid" });

    // v2 renames `name` -> `mode` and declares an upgrade rule.
    const v2 = definePreference<{ mode: string }>({
      namespace: "view",
      key: "layout",
      version: 2,
      default: { mode: "default" },
      validate: (v) =>
        typeof v === "object" && v !== null && typeof (v as { mode?: unknown }).mode === "string",
      migrate: (stored, fromVersion) => {
        if (fromVersion === 1 && typeof (stored as { name?: unknown }).name === "string") {
          return { mode: (stored as { name: string }).name };
        }
        return undefined;
      },
      backend,
    });

    // Never returns the unmigrated v1 shape.
    expect(v2.get()).toEqual({ mode: "grid" });
  });

  // AC: @ui-preference-store ac-3
  it("returns the default for an older-versioned value when no upgrade rule applies", () => {
    const backend = new InMemoryBackend();
    const v1 = definePreference<string>({
      namespace: "tree",
      key: "expansion",
      version: 1,
      default: "v1-default",
      validate: (v) => typeof v === "string",
      backend,
    });
    v1.set("old-shape");

    // v2 declares no migrate rule for v1.
    const v2 = definePreference<string>({
      namespace: "tree",
      key: "expansion",
      version: 2,
      default: "v2-default",
      validate: (v) => typeof v === "string",
      backend,
    });

    expect(v2.get()).toBe("v2-default");
  });

  // AC: @ui-preference-store ac-3
  it("returns the default when a newer-versioned value is encountered (never the foreign shape)", () => {
    const backend = new InMemoryBackend();
    const future = definePreference<string>({
      namespace: "shell",
      key: "focus",
      version: 5,
      default: "future",
      validate: (v) => typeof v === "string",
      backend,
    });
    future.set("from-the-future");

    const current = definePreference<string>({
      namespace: "shell",
      key: "focus",
      version: 2,
      default: "current-default",
      validate: (v) => typeof v === "string",
      backend,
    });

    expect(current.get()).toBe("current-default");
  });

  // AC: @ui-preference-store ac-4
  it("returns the default when the stored value fails validation, never propagating it", () => {
    const backend = new InMemoryBackend();

    // A lenient writer persists a value the strict reader rejects.
    const lenient = definePreference<unknown>({
      namespace: "toggle",
      key: "compact",
      version: 1,
      default: false,
      backend,
    });
    lenient.set("not-a-boolean");

    const strict = definePreference<boolean>({
      namespace: "toggle",
      key: "compact",
      version: 1,
      default: false,
      validate: (v) => typeof v === "boolean",
      backend,
    });

    expect(strict.get()).toBe(false);
  });

  // AC: @ui-preference-store ac-4
  it("supports a Zod schema as the validation rule and falls back on mismatch", () => {
    const backend = new InMemoryBackend();
    const schema = z.object({ collapsed: z.boolean() });

    const pref = definePreference<{ collapsed: boolean }>({
      namespace: "sidebar",
      key: "state",
      version: 1,
      default: { collapsed: false },
      schema,
      backend,
    });

    pref.set({ collapsed: true });
    expect(pref.get()).toEqual({ collapsed: true });

    // Corrupt the stored value behind the interface using a parallel lenient pref.
    const lenient = definePreference<unknown>({
      namespace: "sidebar",
      key: "state",
      version: 1,
      default: null,
      backend,
    });
    lenient.set({ collapsed: "yes" });

    expect(pref.get()).toEqual({ collapsed: false });
  });

  // AC: @ui-preference-store ac-4
  it("returns the default when the stored string is not valid JSON", () => {
    const backend = new InMemoryBackend();
    // Write a raw non-JSON string under the preference's storage key.
    const pref = definePreference<string>({
      namespace: "junk",
      key: "value",
      version: 1,
      default: "fallback",
      validate: (v) => typeof v === "string",
      backend,
    });
    backend.set(pref.storageKey, "}{ not json");

    expect(pref.get()).toBe("fallback");
  });

  // AC: @ui-preference-store ac-5
  it("preserves observable read/write semantics across different backends", () => {
    function run(backend: InMemoryBackend): { initial: string; afterSet: string } {
      const pref = definePreference<string>({
        namespace: "agnostic",
        key: "value",
        version: 1,
        default: "default",
        validate: (v) => typeof v === "string",
        backend,
      });
      const initial = pref.get();
      pref.set("written");
      return { initial, afterSet: pref.get() };
    }

    const first = run(new InMemoryBackend());
    const second = run(new InMemoryBackend());

    // Same observable behavior regardless of which backend instance is used.
    expect(first).toEqual(second);
    expect(first).toEqual({ initial: "default", afterSet: "written" });
  });

  // AC: @ui-preference-store ac-5
  it("notifies subscribers on set and stops after unsubscribe", () => {
    const pref = definePreference<number>({
      namespace: "counter",
      key: "value",
      version: 1,
      default: 0,
      validate: (v) => typeof v === "number",
      backend: new InMemoryBackend(),
    });

    const seen: number[] = [];
    const unsubscribe = pref.subscribe((v) => seen.push(v));

    pref.set(1);
    pref.set(2);
    unsubscribe();
    pref.set(3);

    expect(seen).toEqual([1, 2]);
  });

  // AC: @client-preference-persistence ac-1
  it("records every stored value under the shared namespaced, versioned key format", () => {
    const backend = new InMemoryBackend();
    const pref = definePreference<string>({
      namespace: "nav",
      key: "focus-collapse",
      version: 3,
      default: "",
      validate: (v) => typeof v === "string",
      backend,
    });

    expect(pref.storageKey).toBe(`${APP_PREFIX}:nav:focus-collapse`);

    pref.set("collapsed");
    const raw = backend.get(pref.storageKey);
    expect(raw).not.toBeNull();
    // The persisted record carries the schema version (the "versioned" format).
    expect(JSON.parse(raw as string)).toEqual({ v: 3, value: "collapsed" });
  });
});

/** A StorageLike whose writes always throw, simulating quota/unavailable storage. */
class ThrowingStorage implements StorageLike {
  getItem(): string | null {
    throw new Error("storage unavailable");
  }
  setItem(): void {
    throw new Error("quota exceeded");
  }
  removeItem(): void {
    throw new Error("storage unavailable");
  }
}

/** A StorageLike that works until a quota threshold, then throws on set. */
class QuotaStorage implements StorageLike {
  private readonly store = new Map<string, string>();
  private writes = 0;
  constructor(private readonly limit: number) {}
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.writes += 1;
    if (this.writes > this.limit) throw new Error("quota exceeded");
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
}

describe("LocalStorageBackend degradation", () => {
  // AC: @ui-preference-store ac-6
  it("operates in session-scoped in-memory mode when persistent storage is unavailable", () => {
    const backend = new LocalStorageBackend(null);
    expect(backend.isDegraded).toBe(true);

    const pref = definePreference<string>({
      namespace: "degraded",
      key: "value",
      version: 1,
      default: "default",
      validate: (v) => typeof v === "string",
      backend,
    });

    // Interface remains functional: writes and reads still round-trip in memory.
    pref.set("written");
    expect(pref.get()).toBe("written");
  });

  // AC: @ui-preference-store ac-6
  it("degrades to in-memory when a probed storage throws on every write", () => {
    const backend = new LocalStorageBackend(new ThrowingStorage());
    const pref = definePreference<string>({
      namespace: "throwing",
      key: "value",
      version: 1,
      default: "default",
      validate: (v) => typeof v === "string",
      backend,
    });

    pref.set("kept-in-memory");
    expect(pref.get()).toBe("kept-in-memory");
  });

  // AC: @ui-preference-store ac-6
  it("falls back per-write on a quota error while keeping the interface functional", () => {
    // Limit of 1 successful write: the first set persists, the second throws.
    const backend = new LocalStorageBackend(new QuotaStorage(1));
    const a = definePreference<string>({
      namespace: "quota",
      key: "a",
      version: 1,
      default: "",
      validate: (v) => typeof v === "string",
      backend,
    });
    const b = definePreference<string>({
      namespace: "quota",
      key: "b",
      version: 1,
      default: "",
      validate: (v) => typeof v === "string",
      backend,
    });

    a.set("persisted");
    expect(backend.isDegraded).toBe(false);

    // This write exceeds quota and degrades the backend per-write.
    b.set("memory-only");
    expect(backend.isDegraded).toBe(true);

    // Both values remain readable; the interface stayed functional.
    expect(a.get()).toBe("persisted");
    expect(b.get()).toBe("memory-only");
  });
});
