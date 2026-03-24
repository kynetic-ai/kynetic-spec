/**
 * Unit tests for session-utils timestamp formatting.
 *
 * AC: @ui-session-stream ac-4 — Session metadata in context panel
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  formatTimeline,
  formatAge,
  getTriggerLabel,
  isDispatchedSession,
} from "../src/lib/components/session/session-utils";

describe("formatTimeline", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows time only for today", () => {
    // Fix "now" to a known point so we can construct "today" dates
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T18:30:00.000Z"));

    const result = formatTimeline("2026-03-06T14:16:37.000Z");
    // Should contain the time portion (locale-dependent, but must include minutes and seconds)
    expect(result).toMatch(/\d{1,2}:\d{2}:\d{2}/);
    // Should NOT contain a month abbreviation (same day)
    expect(result).not.toMatch(/Mar/);
  });

  it("shows date and time for a different day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T18:30:00.000Z"));

    const result = formatTimeline("2026-03-05T10:16:37.000Z");
    // Should contain month and day
    expect(result).toMatch(/Mar/);
    expect(result).toMatch(/5/);
    // Should contain time
    expect(result).toMatch(/\d{1,2}:\d{2}:\d{2}/);
  });

  it("includes seconds for precise timing", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T18:30:00.000Z"));

    const result = formatTimeline("2026-03-06T14:05:42.000Z");
    expect(result).toMatch(/05:42/);
  });
});

describe("formatAge", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns just now for < 1 minute", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T18:30:00.000Z"));
    expect(formatAge("2026-03-06T18:29:45.000Z")).toBe("just now");
  });

  it("returns minutes for < 1 hour", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T18:30:00.000Z"));
    expect(formatAge("2026-03-06T18:05:00.000Z")).toBe("25m");
  });

  it("returns coarse hours (without minutes) for >= 1 hour", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T18:30:00.000Z"));
    // 4h 12m ago — formatAge only shows "4h" (coarse, used in list views)
    expect(formatAge("2026-03-06T14:18:00.000Z")).toBe("4h");
  });
});

describe("getTriggerLabel", () => {
  it("returns Manual Run for manual trigger", () => {
    expect(getTriggerLabel("manual")).toBe("Manual Run");
  });

  it("returns dispatched labels for task triggers", () => {
    expect(getTriggerLabel("task.ready")).toBe("Dispatched: Task Ready");
    expect(getTriggerLabel("task.in_progress")).toBe("Dispatched: In Progress");
    expect(getTriggerLabel("task.needs_work")).toBe("Dispatched: Fix Cycle");
    expect(getTriggerLabel("task.pending_review")).toBe("Dispatched: PR Review");
  });

  it("returns Legacy for legacy or undefined trigger", () => {
    expect(getTriggerLabel("legacy")).toBe("Legacy");
    expect(getTriggerLabel(undefined)).toBe("Legacy");
  });

  it("returns generic dispatched label for unknown triggers", () => {
    expect(getTriggerLabel("task.unknown")).toBe("Dispatched: task.unknown");
  });
});

describe("isDispatchedSession", () => {
  it("returns true for dispatched triggers", () => {
    expect(isDispatchedSession("task.ready")).toBe(true);
    expect(isDispatchedSession("task.in_progress")).toBe(true);
    expect(isDispatchedSession("task.needs_work")).toBe(true);
    expect(isDispatchedSession("task.pending_review")).toBe(true);
  });

  it("returns false for manual and legacy triggers", () => {
    expect(isDispatchedSession("manual")).toBe(false);
    expect(isDispatchedSession("legacy")).toBe(false);
    expect(isDispatchedSession(undefined)).toBe(false);
  });
});
