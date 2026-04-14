/**
 * Default project agents and conventions scaffold.
 *
 * Seeds meta items (agents, conventions) on first-run and provides
 * idempotent subsequent-run reporting. Consolidates all default
 * agent/convention creation into a single scaffold site.
 *
 * AC: @default-project-agents-and-conventions (all ACs)
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { KspecContext } from "../../parser/yaml.js";
import type { Agent, AgentDispatchRule, Convention } from "../../schema/meta.js";

function debugLog(message: string, detail?: unknown): void {
  if (process.env.KSPEC_DEBUG === "1") {
    if (detail) {
      console.error(`[DEBUG] setup-defaults: ${message}`, detail);
    } else {
      console.error(`[DEBUG] setup-defaults: ${message}`);
    }
  }
}

// ─── State File ──────────────────────────────────────────────────────────────

/**
 * Setup state file path inside .kspec/ (alongside .kspec-agents-hash).
 */
const SETUP_STATE_FILE = ".setup-state.json";

/**
 * Persistent state tracking for setup seeding operations.
 */
interface SetupState {
  /** Whether the default agents and conventions scaffold has completed */
  defaultsSeeded?: boolean;
  /** Timestamp of when defaults were first seeded */
  defaultsSeededAt?: string;
  /** The scaffold item identifiers that were created */
  scaffoldedItems?: ScaffoldedItemRecord[];
}

/**
 * Record of a scaffolded item for subsequent-run detection.
 */
interface ScaffoldedItemRecord {
  type: "agent" | "convention";
  /** The original scaffold identifier (agent id or convention domain) */
  id: string;
  /** The ULID assigned at creation time (enables rename detection for conventions) */
  _ulid?: string;
}

/**
 * Read the setup state file.
 */
async function readSetupState(specDir: string): Promise<SetupState> {
  const statePath = path.join(specDir, SETUP_STATE_FILE);
  try {
    const raw = await fs.readFile(statePath, "utf-8");
    return JSON.parse(raw) as SetupState;
  } catch {
    return {};
  }
}

/**
 * Write the setup state file.
 */
async function writeSetupState(specDir: string, state: SetupState): Promise<void> {
  const statePath = path.join(specDir, SETUP_STATE_FILE);
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

// ─── Scaffold Tag ────────────────────────────────────────────────────────────

/**
 * Reserved tag for scaffold-origin items.
 * Used to distinguish "user removed scaffold default" from "user renamed it".
 */
const SCAFFOLD_TAG = "scaffold-default";

// ─── Default Definitions ─────────────────────────────────────────────────────

/**
 * Default agent definitions.
 * Each has auto_approve: true for unconditional write authorization.
 *
 * AC: @default-project-agents-and-conventions ac-task-worker-agent
 * AC: @default-project-agents-and-conventions ac-pr-reviewer-agent
 * AC: @default-project-agents-and-conventions ac-primary-dev-agent
 * AC: @default-project-agents-and-conventions ac-plan-reviewer-agent
 * AC: @default-project-agents-and-conventions ac-plan-reviewer-agent-skills
 * AC: @default-project-agents-and-conventions ac-plan-reviewer-adapter-guidance
 * AC: @default-project-agents-and-conventions ac-all-defaults-write-authorized
 */
interface DefaultAgentDef {
  id: string;
  name: string;
  description: string;
  capabilities: string[];
  tools: string[];
  dispatch: AgentDispatchRule[];
  skills: string[];
  concurrency: { max_concurrent: number };
  auto_approve: true;
}

const DEFAULT_AGENTS: DefaultAgentDef[] = [
  {
    id: "task-worker",
    name: "Task Worker",
    description:
      "Autonomous task worker. Picks up automation-eligible ready and needs_work tasks.",
    capabilities: ["code", "test", "refactor"],
    tools: ["kspec", "git", "npm"],
    dispatch: [
      { on: "task.in_progress", filter: { automation: "eligible" as const } },
      { on: "task.ready", filter: { automation: "eligible" as const } },
      { on: "task.needs_work", filter: { automation: "eligible" as const } },
    ],
    skills: ["task-work"],
    concurrency: { max_concurrent: 1 },
    auto_approve: true,
  },
  {
    id: "pr-reviewer",
    name: "PR Reviewer",
    description:
      "Automated code reviewer. Reviews pending_review tasks and merges when quality gates pass.",
    capabilities: ["review"],
    tools: ["kspec", "git", "gh"],
    dispatch: [{ on: "task.pending_review" }],
    skills: ["pr-review"],
    concurrency: { max_concurrent: 1 },
    auto_approve: true,
  },
  {
    id: "primary-dev",
    name: "Primary Development Agent",
    description:
      "General-purpose development agent for code, testing, refactoring, and code review tasks.",
    capabilities: ["code", "test", "refactor", "review"],
    tools: ["kspec", "git", "npm"],
    dispatch: [],
    skills: ["task-work"],
    concurrency: { max_concurrent: 1 },
    auto_approve: true,
  },
  {
    id: "plan-reviewer",
    name: "Plan Reviewer",
    description: [
      "Reviews plans for quality, completeness, and spec alignment.",
      "Has review capability and plan-focused skills attached.",
      "",
      "Adapter guidance: This agent uses the default adapter configured",
      "for your project. If authentication fails with the default adapter,",
      "you can switch adapters using:",
      "  kspec meta set agents --update plan-reviewer --adapter <adapter-name>",
      "Run `kspec agent adapters` to list available adapters and their",
      "authentication requirements.",
    ].join("\n"),
    capabilities: ["review"],
    tools: ["kspec", "git"],
    dispatch: [],
    skills: ["review-plan", "writing-specs", "plan"],
    concurrency: { max_concurrent: 1 },
    auto_approve: true,
  },
];

/**
 * Default convention definitions.
 *
 * AC: @default-project-agents-and-conventions ac-commits-convention
 * AC: @default-project-agents-and-conventions ac-architecture-convention
 * AC: @default-project-agents-and-conventions ac-testing-convention
 */
interface DefaultConventionDef {
  domain: string;
  rules: string[];
}

const DEFAULT_CONVENTIONS: readonly DefaultConventionDef[] = [
  {
    domain: "commits",
    rules: [
      "Use conventional commit format (feat, fix, docs, refactor, test, chore)",
      "Reference task in commit body when applicable (Task: @task-slug)",
    ],
  },
  {
    domain: "architecture",
    rules: [
      "PLACEHOLDER: Replace this rule with your project's architectural constraints and patterns",
    ],
  },
  {
    domain: "testing",
    rules: [
      "PLACEHOLDER: Replace this rule with your project's testing expectations and coverage requirements",
    ],
  },
] as const;

// ─── Scaffold Result ─────────────────────────────────────────────────────────

export interface ScaffoldItemStatus {
  type: "agent" | "convention";
  id: string;
  status: "created" | "exists" | "removed" | "renamed" | "force-recreated";
}

export interface ScaffoldDefaultsResult {
  /** Whether the scaffold actually created or modified items */
  acted: boolean;
  /** Per-item status reports */
  items: ScaffoldItemStatus[];
  /** Whether this was a first-run */
  firstRun: boolean;
  /** Summary message for the setup step */
  message: string;
}

// ─── Core Logic ──────────────────────────────────────────────────────────────

/**
 * Scaffold default agents and conventions.
 *
 * - First run: creates all defaults, writes marker
 * - Subsequent run: reports itemized status, never recreates removed/renamed items
 * - Force run: re-seeds missing items only
 *
 * AC: @default-project-agents-and-conventions ac-first-run-marker-written
 * AC: @default-project-agents-and-conventions ac-removed-defaults-not-recreated
 * AC: @default-project-agents-and-conventions ac-renamed-defaults-preserved
 * AC: @default-project-agents-and-conventions ac-force-reseed
 */
export async function scaffoldDefaults(
  ctx: KspecContext,
  options: { dryRun?: boolean; force?: boolean } = {},
): Promise<ScaffoldDefaultsResult> {
  const { dryRun = false, force = false } = options;
  const { loadMetaContext, saveMetaItem } = await import("../../parser/meta.js");
  const { ulid } = await import("ulid");

  const items: ScaffoldItemStatus[] = [];

  try {
    if (!ctx.manifestPath) {
      return { acted: false, items, firstRun: false, message: "no manifest found" };
    }

    const state = await readSetupState(ctx.specDir);
    const meta = await loadMetaContext(ctx);

    // Build lookup sets for current meta items
    const existingAgentIds = new Set((meta.agents || []).map((a) => a.id));
    const existingConventionDomains = new Set((meta.conventions || []).map((c) => c.domain));

    // Build ULID lookups from state file for rename detection.
    // Map: original ID → ULID assigned at scaffold time.
    const scaffoldedItemUlids = new Map<string, string>();
    for (const rec of state.scaffoldedItems || []) {
      if (rec._ulid) {
        scaffoldedItemUlids.set(rec.id, rec._ulid);
      }
    }

    // Build reverse lookup: ULID → current agent (for rename detection)
    const agentsByUlid = new Map<string, { id: string }>();
    for (const agent of meta.agents || []) {
      if (agent._ulid) {
        agentsByUlid.set(agent._ulid, agent);
      }
    }

    // Build reverse lookup: ULID → current convention (for rename detection)
    const conventionsByUlid = new Map<string, { domain: string }>();
    for (const conv of meta.conventions || []) {
      const c = conv as { _ulid?: string; domain: string };
      if (c._ulid) {
        conventionsByUlid.set(c._ulid, c);
      }
    }

    const isFirstRun = !state.defaultsSeeded;

    if (isFirstRun || force) {
      // First-run or force mode: create items that don't exist
      let created = 0;
      // Track ULIDs we generate so we can persist them in the state file
      const newUlids = new Map<string, string>();

      // Create agents
      for (const def of DEFAULT_AGENTS) {
        if (existingAgentIds.has(def.id)) {
          items.push({ type: "agent", id: def.id, status: "exists" });
          continue;
        }

        // Force mode: check if this specific default was renamed (not deleted)
        if (force && !isFirstRun) {
          const originalUlid = scaffoldedItemUlids.get(def.id);
          if (originalUlid) {
            // Check if an agent with that ULID still exists under a different ID
            const renamedAgent = agentsByUlid.get(originalUlid);
            if (renamedAgent && renamedAgent.id !== def.id) {
              items.push({ type: "agent", id: def.id, status: "renamed" });
              continue;
            }
            // ULID exists in state but no agent has it → truly deleted; recreate
          }
          // No ULID in state (legacy state file) → treat missing as truly deleted; recreate
        }

        const itemUlid = ulid();
        if (!dryRun) {
          const agentData: Agent = {
            _ulid: itemUlid,
            id: def.id,
            name: def.name,
            description: def.description,
            capabilities: [...def.capabilities],
            tools: [...def.tools],
            conventions: [],
            dispatch: def.dispatch.map((r) => ({ ...r })),
            skills: [...def.skills],
            concurrency: { ...def.concurrency },
            auto_approve: def.auto_approve,
            tags: [SCAFFOLD_TAG],
          };
          await saveMetaItem(ctx, agentData, "agent");
        }
        newUlids.set(def.id, itemUlid);
        items.push({
          type: "agent",
          id: def.id,
          status: force && !isFirstRun ? "force-recreated" : "created",
        });
        created++;
      }

      // Create conventions
      for (const def of DEFAULT_CONVENTIONS) {
        if (existingConventionDomains.has(def.domain)) {
          items.push({ type: "convention", id: def.domain, status: "exists" });
          continue;
        }

        // Force mode: check if this convention was renamed via ULID tracking
        if (force && !isFirstRun) {
          const originalUlid = scaffoldedItemUlids.get(def.domain);
          if (originalUlid) {
            // We have a ULID from when this convention was first scaffolded.
            // Check if a convention with that ULID still exists under a different domain.
            const renamedConv = conventionsByUlid.get(originalUlid);
            if (renamedConv && renamedConv.domain !== def.domain) {
              items.push({ type: "convention", id: def.domain, status: "renamed" });
              continue;
            }
            // ULID exists in state but no convention has it → truly deleted; recreate
          }
          // No ULID in state (legacy state file) → treat missing as truly deleted; recreate
        }

        const itemUlid = ulid();
        if (!dryRun) {
          const conventionData: Convention = {
            _ulid: itemUlid,
            domain: def.domain,
            rules: [...def.rules],
            examples: [],
          };
          await saveMetaItem(ctx, conventionData, "convention");
        }
        newUlids.set(def.domain, itemUlid);
        items.push({
          type: "convention",
          id: def.domain,
          status: force && !isFirstRun ? "force-recreated" : "created",
        });
        created++;
      }

      // Write first-run marker (preserve existing ULIDs, add new ones)
      if (!dryRun) {
        // Merge existing state records with new/updated ones
        const existingRecords = new Map<string, ScaffoldedItemRecord>();
        for (const rec of state.scaffoldedItems || []) {
          existingRecords.set(rec.id, rec);
        }
        const scaffoldedItems: ScaffoldedItemRecord[] = [
          ...DEFAULT_AGENTS.map((a) => ({
            type: "agent" as const,
            id: a.id,
            _ulid: newUlids.get(a.id) || existingRecords.get(a.id)?._ulid,
          })),
          ...DEFAULT_CONVENTIONS.map((c) => ({
            type: "convention" as const,
            id: c.domain,
            _ulid: newUlids.get(c.domain) || existingRecords.get(c.domain)?._ulid,
          })),
        ];
        await writeSetupState(ctx.specDir, {
          ...state,
          defaultsSeeded: true,
          defaultsSeededAt: state.defaultsSeededAt || new Date().toISOString(),
          scaffoldedItems,
        });
      }

      const createdItems = items.filter((i) => i.status === "created" || i.status === "force-recreated");
      const existingItems = items.filter((i) => i.status === "exists");
      const renamedItems = items.filter((i) => i.status === "renamed");
      const parts: string[] = [];
      if (createdItems.length > 0) {
        parts.push(`created: ${createdItems.map((i) => i.id).join(", ")}`);
      }
      if (existingItems.length > 0) {
        parts.push(`already exist: ${existingItems.map((i) => i.id).join(", ")}`);
      }
      if (renamedItems.length > 0) {
        parts.push(`renamed by user: ${renamedItems.map((i) => i.id).join(", ")}`);
      }

      return {
        acted: created > 0,
        items,
        firstRun: isFirstRun,
        message: parts.join("; ") || "no items to scaffold",
      };
    }

    // ─── Subsequent run (marker present, no force) ─────────────────────────
    // AC: @default-project-agents-and-conventions ac-removed-defaults-not-recreated
    // AC: @default-project-agents-and-conventions ac-renamed-defaults-preserved

    // Check agents — use ULID-based tracking for per-item rename detection
    for (const def of DEFAULT_AGENTS) {
      if (existingAgentIds.has(def.id)) {
        items.push({ type: "agent", id: def.id, status: "exists" });
      } else {
        // Check if this agent was renamed via ULID tracking
        const originalUlid = scaffoldedItemUlids.get(def.id);
        if (originalUlid) {
          const renamedAgent = agentsByUlid.get(originalUlid);
          if (renamedAgent && renamedAgent.id !== def.id) {
            items.push({ type: "agent", id: def.id, status: "renamed" });
            continue;
          }
        }
        items.push({ type: "agent", id: def.id, status: "removed" });
      }
    }

    // Check conventions — use ULID tracking for rename detection
    for (const def of DEFAULT_CONVENTIONS) {
      if (existingConventionDomains.has(def.domain)) {
        items.push({ type: "convention", id: def.domain, status: "exists" });
      } else {
        // Check if this convention was renamed via ULID tracking
        const originalUlid = scaffoldedItemUlids.get(def.domain);
        if (originalUlid) {
          const renamedConv = conventionsByUlid.get(originalUlid);
          if (renamedConv && renamedConv.domain !== def.domain) {
            items.push({ type: "convention", id: def.domain, status: "renamed" });
            continue;
          }
        }
        items.push({ type: "convention", id: def.domain, status: "removed" });
      }
    }

    const existing = items.filter((i) => i.status === "exists");
    const removed = items.filter((i) => i.status === "removed");
    const renamed = items.filter((i) => i.status === "renamed");
    const parts: string[] = ["defaults already seeded"];
    if (existing.length > 0) {
      parts.push(`present: ${existing.map((i) => i.id).join(", ")}`);
    }
    if (removed.length > 0) {
      parts.push(`removed by user: ${removed.map((i) => i.id).join(", ")}`);
    }
    if (renamed.length > 0) {
      parts.push(`renamed by user: ${renamed.map((i) => i.id).join(", ")}`);
    }

    return {
      acted: false,
      items,
      firstRun: false,
      message: parts.join("; "),
    };
  } catch (err) {
    debugLog("scaffoldDefaults failed", err);
    return {
      acted: false,
      items,
      firstRun: false,
      message: `failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Get the list of default scaffold agent IDs (for testing).
 */
export function getDefaultAgentIds(): string[] {
  return DEFAULT_AGENTS.map((a) => a.id);
}

/**
 * Get the list of default scaffold convention domains (for testing).
 */
export function getDefaultConventionDomains(): string[] {
  return DEFAULT_CONVENTIONS.map((c) => c.domain);
}
