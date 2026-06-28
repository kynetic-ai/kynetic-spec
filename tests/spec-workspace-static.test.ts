import { describe, expect, it, vi } from "vitest";
import type { KspecSnapshot } from "../packages/shared/src/api.js";

const modeState = vi.hoisted(() => ({
  snapshot: null as KspecSnapshot | null,
}));

const modeMock = vi.hoisted(() => () => ({
  getSnapshot: () => modeState.snapshot,
  isStaticMode: () => true,
  assertWritable: (operation: string) => {
    throw new Error(`Cannot ${operation} in read-only mode.`);
  },
  ReadOnlyModeError: class ReadOnlyModeError extends Error {
    constructor(operation: string) {
      super(`Cannot ${operation} in read-only mode.`);
    }
  },
}));

vi.mock("$lib/stores/mode.svelte", modeMock);
vi.mock("../packages/web-ui/src/lib/stores/mode.svelte", modeMock);

import {
  fetchSpecWorkspaceCriterionStatic,
  fetchSpecWorkspaceNodeStatic,
  fetchSpecWorkspaceRootStatic,
} from "../packages/web-ui/src/lib/api-static.js";

const snapshot: KspecSnapshot = {
  version: "1.0.0",
  exported_at: "2026-06-28T09:30:00.000Z",
  project: { name: "Static Workspace" },
  items: [
    {
      _ulid: "01KW7000000000000000000001",
      slugs: ["static-module"],
      title: "Static Module",
      type: "module",
      status: { maturity: "draft", implementation: "in_progress" },
      tags: [],
      created_at: "2026-06-28T09:00:00.000Z",
      acceptance_criteria: [],
      traits: [],
      depends_on: [],
      ancestors: [{ ref: "01KW7000000000000000000001", title: "Static Module", kind: "module" }],
    },
    {
      _ulid: "01KW7000000000000000000002",
      slugs: ["static-requirement"],
      title: "Static Requirement",
      type: "requirement",
      status: { maturity: "draft", implementation: "in_progress" },
      tags: ["static"],
      parent: "01KW7000000000000000000001",
      created_at: "2026-06-28T09:01:00.000Z",
      description: "Static requirement detail",
      acceptance_criteria: [
        {
          id: "ac-static",
          given: "a static snapshot",
          when: "the workspace renders",
          then: "projection data is available",
        },
      ],
      traits: [],
      depends_on: [],
      ancestors: [
        { ref: "01KW7000000000000000000001", title: "Static Module", kind: "module" },
        { ref: "01KW7000000000000000000002", title: "Static Requirement", kind: "requirement" },
      ],
    },
  ],
  tasks: [
    {
      _ulid: "01KW7000000000000000000003",
      slugs: ["static-task"],
      title: "Static linked task",
      type: "task",
      status: "pending_review",
      priority: 1,
      spec_ref: "@static-requirement",
      tags: [],
      depends_on: [],
      created_at: "2026-06-28T09:02:00.000Z",
      notes_count: 0,
      todos_count: 0,
    },
  ],
  inbox: [],
  plans: [],
  reviews: [],
  triage: [],
  session: null,
  observations: [],
  agents: [],
  workflows: [],
  conventions: [],
  coverage_state: {
    summary: {
      counts: { covered: 0, failing: 0, not_yet: 1, re_verify: 0 },
      denominator: 1,
      latest_run_id: null,
      unmapped_result_count: 0,
      invalid_result_count: 0,
    },
    items: {
      "01KW7000000000000000000002": {
        item_ulid: "01KW7000000000000000000002",
        item_ref: "@static-requirement",
        item_title: "Static Requirement",
        counts: { covered: 0, failing: 0, not_yet: 1, re_verify: 0 },
        denominator: 1,
        latest_run_id: null,
        criteria: [
          {
            criterion_key: "01KW7000000000000000000002 ac-static",
            item_ulid: "01KW7000000000000000000002",
            item_ref: "@static-requirement",
            item_title: "Static Requirement",
            ac_id: "ac-static",
            state: "not_yet",
            presentation: "not_yet",
            explanation: {
              rule: "no_evidence",
              sourceEvidenceIds: [],
              latestRunId: null,
              secondaryReverifyCauses: [],
            },
            latest_run_evidence: [],
            freshness: { bootstrap: null, recorded: null, secondary_causes: [] },
            unmapped_result_references: [],
          },
        ],
        unmapped_result_references: [],
      },
    },
    criteria: {},
    unmapped_results: [],
  },
};

describe("spec workspace static projections", () => {
  // AC: @unified-spec-workspace-data-projection ac-static-readonly-projection
  // AC: @unified-spec-workspace-data-projection ac-bounded-root-projection
  it("serves bounded root and node projections from a static snapshot", () => {
    modeState.snapshot = snapshot;

    const root = fetchSpecWorkspaceRootStatic({ limit: 1 }).data;
    const node = fetchSpecWorkspaceNodeStatic("@static-requirement")?.data;

    expect(root).toMatchObject({
      kind: "root",
      corpus: { items: 2, acceptance_criteria: 1 },
      coverage_summary: snapshot.coverage_state?.summary,
      top_level_nodes: [expect.objectContaining({ ref: "@static-module", child_count: 1 })],
      pagination: { total: 1, limit: 1, offset: 0, has_more: false },
    });
    expect(node).toMatchObject({
      kind: "node",
      node: {
        ref: "@static-requirement",
        coverage_counts: { covered: 0, failing: 0, not_yet: 1, re_verify: 0 },
        linked_work_counts: { task: 1, session: 0, plan: 0, review: 0, observation: 0 },
      },
      linked_work: expect.arrayContaining([
        expect.objectContaining({
          kind: "session",
          unavailable: expect.objectContaining({ status: "unavailable" }),
        }),
      ]),
    });
  });

  // AC: @unified-spec-workspace-data-projection ac-ac-detail-projection
  // AC: @unified-spec-workspace-data-projection ac-static-readonly-projection
  it("serves criterion detail with static coverage evidence and unavailable dynamic classes", () => {
    modeState.snapshot = snapshot;

    const criterion = fetchSpecWorkspaceCriterionStatic("@static-requirement", "ac-static")?.data;

    expect(criterion).toMatchObject({
      kind: "criterion",
      parent: { ref: "@static-requirement" },
      criterion: {
        id: "ac-static",
        coverage: expect.objectContaining({ presentation: "not_yet" }),
      },
      evidence: { latest_run: [], unmapped_results: [], reverify_causes: [] },
    });
    expect(criterion?.linked_work).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "review",
          unavailable: expect.objectContaining({
            suggestion: expect.stringContaining("live daemon workspace"),
          }),
        }),
      ]),
    );
  });
});
