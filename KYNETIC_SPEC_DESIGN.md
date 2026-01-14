# Kynetic Spec: Design Specification

**Version**: 0.1.0-draft
**Status**: Draft
**Last Updated**: 2025-01-14

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Vision and Goals](#vision-and-goals)
3. [Core Concepts](#core-concepts)
4. [Format Specification](#format-specification)
5. [Schema and Structure](#schema-and-structure)
6. [Versioning and Lifecycle](#versioning-and-lifecycle)
7. [Task System](#task-system)
8. [CLI Interface (kspec)](#cli-interface-kspec)
9. [Traceability](#traceability)
10. [Architecture](#architecture)
11. [Implementation Roadmap](#implementation-roadmap)
12. [Resolved Decisions](#resolved-decisions)

---

## Executive Summary

**Kynetic Spec** is a structured, living specification format designed for collaborative authoring between humans and AI agents. It serves as the **single source of truth** for project requirements, features, and architecture decisions.

**Key Properties**:
- Plain text, git-diffable format
- Agent-assisted authoring via conversational interaction
- Hybrid structure: fixed hierarchy at top levels, graph-based cross-references for relationships
- Extensible output generation (docs, tasks, issues, etc.) via plugins
- Scale-agnostic: simple for solo developers, capable for enterprise teams

**Recommended Format**: YAML with conventions + JSON Schema validation, with an optional JSON-LD processing layer for advanced graph operations.

---

## Vision and Goals

### Primary Vision

A specification system where you can:
1. Describe a feature idea conversationally to an agent
2. The agent helps structure it into the Kynetic Spec format
3. The spec evolves as the living source of truth
4. Tasks, documentation, and other artifacts derive from the spec
5. Changes flow through the spec, keeping everything synchronized

### Design Goals

| Goal | Description |
|------|-------------|
| **Source of Truth** | The spec is canonical; everything else derives from it |
| **Agent-Friendly** | Designed for AI agents to read, write, and reason about |
| **Human-Editable** | Readable and editable by humans when needed |
| **Git-Native** | Plain text, diffable, mergeable, branchable |
| **Progressive Complexity** | Simple by default, advanced features opt-in |
| **Extensible** | Plugin architecture for outputs; format handles diverse needs |

### Non-Goals (Explicitly Out of Scope)

- Real-time collaboration (use git branches instead)
- Visual editors (out of scope for v1; plain text first)
- Full semantic web integration (optional layer, not required)

---

## Core Concepts

### Spec Items

A **spec item** is the fundamental unit. Everything in the spec is an item with:

- **ID**: Stable, unique identifier (never reused, never changed)
- **Type**: What kind of thing it is (feature, requirement, constraint, etc.)
- **Content**: The substance (title, description, acceptance criteria, etc.)
- **Metadata**: Status, priority, timestamps, etc.
- **Relationships**: Links to other items (depends_on, relates_to, etc.)

### Hierarchy vs Graph

The spec uses a **hybrid model**:

```
[Fixed Hierarchy]              [Graph Relationships]
     Project                    ┌─────────────────┐
       │                        │   depends_on    │
   ┌───┴───┐                    │   implements    │
   │       │                    │   blocks        │
 Module  Module                 │   relates_to    │
   │                            │   tests         │
 ┌─┴─┐                          └────────┬────────┘
 │   │                                   │
Feature Feature ─────────────────────────┘
   │
Requirement
```

- **Hierarchy**: Provides organizational structure (Project > Module > Feature > Requirement)
- **Graph**: Enables cross-cutting relationships that don't fit hierarchy

### Item Types (Extensible)

| Type | Purpose | Example |
|------|---------|---------|
| `module` | High-level organizational unit | "Authentication", "API" |
| `feature` | User-facing capability | "User Login", "Data Export" |
| `requirement` | Specific requirement | "Passwords must be hashed with bcrypt" |
| `constraint` | Limitation or boundary | "Must support 10k concurrent users" |
| `decision` | Architectural decision (ADR-style) | "Use PostgreSQL for persistence" |
| `task` | Actionable work item (derived) | "Implement login endpoint" |

### Relationship Types

| Relationship | Semantics |
|--------------|-----------|
| `depends_on` | Must be completed/available before this item |
| `implements` | This item implements a higher-level item |
| `blocks` | This item blocks progress on another |
| `relates_to` | General association |
| `tests` | This item tests/validates another |
| `supersedes` | This item replaces an older item |

---

## Format Specification

### Recommended Format: YAML

Based on extensive research comparing YAML, JSON, XML, RDF/Turtle, JSON-LD, and custom DSLs, **YAML** is recommended for primary authoring due to:

1. **Human readability**: Clean, minimal syntax
2. **Agent compatibility**: LLMs extensively trained on YAML
3. **Comments**: Native support (critical for specs)
4. **Git diffs**: Line-based format produces clean diffs
5. **Ecosystem**: Mature tooling in all languages
6. **JSON Schema**: Validation without XML complexity

### YAML Conventions

To avoid YAML pitfalls:

1. **Use YAML 1.2 parsers** (not 1.1)
2. **Quote strings that might be misinterpreted**: `"NO"`, `"3.14"`, `"on"`
3. **Use literal blocks for multiline**: `|` for descriptions
4. **Enforce with linters**: yamllint in CI
5. **One item per file** for large specs (improves mergeability)

### File Structure Options

**Option A: Single File** (small projects)
```
project/
  kynetic.spec.yaml    # Everything in one file
```

**Option B: Directory Structure** (larger projects)
```
project/
  spec/
    kynetic.yaml       # Root manifest
    modules/
      auth.yaml        # Auth module items
      api.yaml         # API module items
    decisions/
      ADR-001.yaml     # Decision records
```

### Cross-Reference Syntax

References use a convention-based ID scheme:

```yaml
features:
  - id: auth-login
    title: User Login
    depends_on:
      - auth-session    # Reference by ID
      - user-model
    implements:
      - module:auth     # Prefixed reference (optional)
```

References are **validated** by the CLI/tooling, not by YAML itself.

---

## Schema and Structure

### Root Manifest

```yaml
# kynetic.yaml - Root manifest
kynetic: "1.0"                     # Spec format version
project:
  name: "My Project"
  version: "0.1.0"                 # Current spec version
  status: draft                    # draft | proposed | stable | deprecated

# Inline items (small projects)
modules:
  - id: auth
    title: Authentication
    features:
      - id: auth-login
        # ...

# Or external references (large projects)
includes:
  - modules/auth.yaml
  - modules/api.yaml
  - decisions/*.yaml
```

### Item Schema

```yaml
# Full item schema
_ulid: 01HQ3K5XJ8MPVB2XCJZ0KE9YWN  # Auto-generated canonical ID
slugs: [auth-login]                # Human-friendly aliases (agent-managed)
title: User Login                  # REQUIRED: Human-readable name
type: feature                      # Item type (default: inferred from context)

# Status and lifecycle
status:
  maturity: stable                 # draft | proposed | stable | deprecated
  implementation: in_progress      # not_started | in_progress | implemented | verified

# Classification
priority: high                     # high | medium | low (or numeric)
tags: [security, mvp]              # Freeform labels

# Content
description: |
  Allow users to authenticate using email/password
  or configured OAuth providers.

acceptance_criteria:
  - id: ac-1
    given: a registered user
    when: they enter valid credentials
    then: they are logged in and redirected to dashboard

# Relationships (graph edges) - use @ prefix for references
depends_on: ["@auth-session", "@user-model"]  # Slug references
implements: ["@01HQ3K"]                        # Short ULID reference
relates_to: ["@auth-logout"]
tests: []
supersedes: null

# Traceability (optional, tiered)
traceability:
  implementation:
    - path: src/auth/login.ts
      function: handleLogin
  tests:
    - path: tests/auth/login.test.ts
  commits: [abc123, def456]
  issues: ["#42"]

# Lifecycle metadata (mostly auto-populated)
created: 2025-01-10
created_by: "@developer"           # Optional, git has this
deprecated_in: null                # Spec version when deprecated
superseded_by: null                # ID of replacement
```

### JSON Schema Validation

A JSON Schema will be provided for validation:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://kynetic.dev/spec/v1/schema.json",
  "title": "Kynetic Spec Item",
  "type": "object",
  "required": ["id", "title"],
  "properties": {
    "id": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9-]*$"
    },
    "title": { "type": "string" },
    "status": { "$ref": "#/$defs/status" }
    // ...
  }
}
```

---

## Versioning and Lifecycle

### Versioning Strategy

**Layered approach leveraging git**:

| Layer | Mechanism | Purpose |
|-------|-----------|---------|
| History | Git commits | Who changed what, when |
| Baselines | Git tags | Named release points |
| Spec version | Semantic versioning | Communicate stability |
| Item UIDs | Stable IDs | Reference stability |

### Semantic Versioning for Specs

```
MAJOR.MINOR.PATCH

MAJOR: Breaking changes to spec structure or incompatible requirement changes
MINOR: New requirements added, non-breaking clarifications
PATCH: Typo fixes, editorial improvements
```

### Unique Identifiers (ULIDs + Slugs)

**Canonical ID (ULID)**:
- Auto-generated, time-sortable, globally unique
- Format: `01HQ3K5XJ8...` (26 characters, Crockford base32)
- Can be shortened for display: `01HQ3K` (like git short hashes)
- Never changes, never reused

**Slugs (Aliases)**:
- Human-friendly names that point to ULIDs
- Agent-generated based on content and context
- Multiple slugs can point to same item
- Can be added/changed without affecting references

**Example**:
```yaml
# Item with ULID and slugs
_ulid: 01HQ3K5XJ8MPVB2XCJZ0KE9YWN
slugs: [auth-login, user-authentication]
```

### Lifecycle States

**Spec-level**:
```
draft -> proposed -> stable -> deprecated -> archived
```

**Item-level**:
```yaml
status:
  maturity: draft | proposed | stable | deprecated
  implementation: not_started | in_progress | implemented | verified
```

### Baselines (Releases)

Use annotated git tags:

```bash
git tag -a spec-v1.0.0 -m "Release 1.0.0: Initial stable release"
```

Compare between versions:
```bash
git diff spec-v1.0.0..spec-v1.1.0 -- spec/
kspec diff --since spec-v1.0.0
```

### Deprecation Workflow

1. Mark item with `maturity: deprecated` and `deprecated_in: "1.3.0"`
2. Add `superseded_by: new-item-id` if there's a replacement
3. Keep deprecated items for 1-2 major versions
4. Move to `archived` status (not deleted, preserves traceability)
5. Generate deprecation notices in changelogs

---

## Task System

Tasks are first-class primitives in Kynetic Spec, enabling specs to naturally decompose into executable work.

### Design Principles

1. **Tasks are items**: Same ULID + slug ID system as spec items
2. **Hybrid typing**: Spec-derived tasks (features, requirements) vs free-form tasks (infra, bugs)
3. **State machine**: Some states are derived (blocked computed from dependencies)
4. **Explicit derivation**: Tasks created on-demand via `kspec derive`, not automatically
5. **Orchestration-agnostic**: No built-in WIP limits; external systems handle concurrency

### Task Types

| Type | Spec-linked | Description |
|------|-------------|-------------|
| `epic` | Usually | Groups related tasks, often derived from features |
| `task` | Often | Atomic unit of work |
| `bug` | Optional | Defect fix, may or may not relate to spec item |
| `spike` | Optional | Research/investigation, time-boxed |
| `infra` | No | Infrastructure, tooling, not spec-derived |

### Task States (State Machine)

```
                     ┌──────────────────────────────────┐
                     │                                  │
                     ▼                                  │
              ┌─────────────┐                          │
              │   pending   │◄─────────────────┐       │
              └──────┬──────┘                  │       │
                     │ start                   │       │
                     ▼                         │       │
              ┌─────────────┐            unblock│       │
              │ in_progress │──────────────────┤       │
              └──────┬──────┘                  │       │
                     │                         │       │
          ┌─────────┼─────────┐               │       │
          │         │         │               │       │
     complete     block    cancel             │       │
          │         │         │               │       │
          ▼         ▼         ▼               │       │
   ┌───────────┐ ┌─────────┐ ┌───────────┐   │       │
   │ completed │ │ blocked │─┘ │ cancelled │   │       │
   └───────────┘ └─────────┘   └───────────┘   │       │
                                               │       │
                                               │       │
   Note: "blocked" can also be auto-derived    │       │
   when depends_on items aren't completed ─────┘       │
   (computed state, not just manual)                   │
```

**Derived states**:
- `blocked`: Auto-set when `depends_on` tasks aren't completed
- `ready`: Computed view = `pending` + all deps met + no blockers

### Task Schema

**Key principle**: Tasks don't duplicate spec content - they reference it via `spec_ref` and add only execution metadata, work logs, and progress tracking.

```yaml
# Task item schema
_ulid: 01XYZ...                    # Auto-generated canonical ID
slugs: [impl-user-login]           # Human-friendly aliases
title: "Implement login endpoint"  # Brief title (details live in spec)
type: task                         # task | epic | bug | spike | infra

# Spec relationship - THE source of "what to build"
spec_ref: "@user-login"            # Reference to spec item (has full details)
derivation: auto                   # auto | manual

# State
status: pending                    # pending | in_progress | blocked | completed | cancelled
blocked_by: []                     # External blockers (manual, strings)
closed_reason: null                # Why completed/cancelled

# Dependencies
depends_on: ["@impl-session"]      # Must complete first (auto-blocks if not met)
context: ["@design-auth"]          # Tasks whose output is needed as input

# Work metadata
priority: 2                        # 1 (highest) to 5
complexity: 3                      # Relative sizing (fibonacci or 1-5)
tags: [auth, mvp]                  # Labels
assignee: null                     # Agent or human (optional)

# VCS References (minimal + extensible)
vcs_refs:
  - ref: "feat/user-login"         # Branch, tag, or commit
    type: branch                   # branch | tag | commit (optional)
  - ref: "abc123"
    type: commit

# Timestamps (auto-populated)
created_at: 2025-01-14T10:00:00Z
started_at: null
completed_at: null
```

### Work Log (Notes)

Notes are **append-only** entries that track progress, findings, and decisions during work. New entries can supersede old ones (for corrections) but history is preserved.

```yaml
# Notes array on a task
notes:
  - _ulid: 01NOTE1...              # Entry ID
    created_at: 2025-01-14T10:30:00Z
    author: "@agent-1"             # Who added this
    content: |
      Started investigating the auth flow.
      Found existing session middleware we can reuse.
    supersedes: null               # This is an original entry

  - _ulid: 01NOTE2...
    created_at: 2025-01-14T14:00:00Z
    author: "@agent-2"
    content: |
      Correction: The session middleware has a bug.
      Need to fix it first - adding blocker.
    supersedes: 01NOTE1...         # Updates/corrects earlier entry

  - _ulid: 01NOTE3...
    created_at: 2025-01-14T16:00:00Z
    author: "@agent-1"
    content: |
      Session middleware fixed in commit def456.
      Unblocking and continuing implementation.
```

**CLI**:
```bash
kspec task note <ref> "Found issue with middleware"
kspec task note <ref> --supersedes 01NOTE1 "Correction: ..."
kspec task notes <ref>             # Show notes log
```

### Todos (Emergent Subtasks)

Todos are **lightweight checklist items** that emerge during work. They start simple and can be **promoted to full subtasks** if they grow complex.

```yaml
# Todos array on a task
todos:
  - id: 1                          # Local ID (within task)
    text: "Set up JWT signing"
    done: false
    added_at: 2025-01-14T11:00:00Z
    added_by: "@agent-1"

  - id: 2
    text: "Write validation tests"
    done: true
    done_at: 2025-01-14T13:00:00Z
    added_at: 2025-01-14T11:00:00Z
    added_by: "@agent-1"

  - id: 3
    text: "Handle OAuth flow"
    done: false
    promoted_to: "@impl-oauth"     # Promoted to full subtask
    added_at: 2025-01-14T12:00:00Z
    added_by: "@agent-2"
```

**Promote pattern**: When a todo becomes complex, promote it to a full task:
```bash
kspec todo add <task-ref> "Handle OAuth flow"
kspec todo done <task-ref> 2
kspec todo promote <task-ref> 3    # Creates new task, links back
```

**CLI for agent handoff**:
```bash
# Agent 1 is done for now, leaves state for Agent 2
kspec task note @impl-login "Pausing here. JWT signing done, OAuth todo needs attention."
kspec todo add @impl-login "Review error handling"
kspec todo add @impl-login "Add rate limiting"

# Agent 2 picks up
kspec task notes @impl-login       # See where Agent 1 left off
kspec task todos @impl-login       # See remaining work
```

### Task Storage

**Auto-adaptive** (consistent with spec file structure):
- Start: Tasks alongside specs (`auth.tasks.yaml` next to `auth.yaml`)
- Grow: Separate `tasks/` directory when volume increases

```
# Small project
spec/
  auth.yaml
  auth.tasks.yaml

# Larger project
spec/
  modules/
    auth.yaml
tasks/
  backlog.yaml
  active.yaml
  archive/
    2025-01.yaml
```

### Task CLI Commands

```bash
# Query available work
kspec tasks ready                  # All tasks ready to work on (pending + deps met)
kspec tasks ready --json           # JSON output for agents
kspec tasks next                   # Highest-priority ready task

# Task lifecycle
kspec task start <ref>             # pending → in_progress
kspec task complete <ref> --reason "Done in commit abc"
kspec task block <ref> --reason "Waiting on API design"
kspec task unblock <ref>
kspec task cancel <ref> --reason "No longer needed"

# Task creation
kspec task add --title "Fix login bug" --type bug
kspec task add --title "Implement auth" --spec-ref "@user-login"

# Derivation (command-triggered)
kspec derive "@user-login"         # Derive tasks for spec item
kspec derive --all                 # Derive for all underivedspec items

# Queries
kspec tasks list --status in_progress
kspec tasks blocked                # Show all blocked tasks
kspec tasks graph --from <ref>     # Dependency visualization
```

### Spec-to-Task Relationship

```
Spec Items (stable)              Tasks (ephemeral)
────────────────────            ──────────────────
feature: User Login ──────────► epic: Implement User Login
  │                                 │
  ├── req: Valid credentials ─────► task: Implement validation
  │                                 │
  └── req: Session creation ──────► task: Implement session
                                    │
                                    └── depends_on: validation task
```

**Referential integrity**:
- `kspec validate --task-refs` checks all spec_refs resolve
- Orphaned tasks (spec deleted) flagged as warnings
- Tasks without spec_ref allowed for free-form types (infra, bugs)

---

## CLI Interface (kspec)

### Design Philosophy

Following the **git plumbing/porcelain model**:

- **Plumbing**: Low-level atomic primitives for scripts and agents
- **Porcelain**: High-level convenient commands for humans

### Command Structure

```
kspec <resource> <action> [args] [flags]
```

### Core Commands

#### Item Operations

```bash
# Create
kspec item add --type feature --title "User Login" --id auth-login

# Read
kspec item get auth-login
kspec item get auth-login --field status
kspec item list --type feature --status pending

# Update
kspec item set auth-login --field status.maturity --value stable
kspec item patch auth-login --data '{"priority": "high"}'

# Delete
kspec item delete auth-login --force
```

#### Link Operations

```bash
# Create relationship
kspec link create auth-login auth-session --type depends_on

# Query relationships
kspec link list --from auth-login
kspec link graph --from auth-login --depth 3

# Remove relationship
kspec link delete auth-login auth-session
```

#### Query Operations

```bash
# Structured queries
kspec item list --type feature --status pending --has-tag mvp

# Complex queries (jq-style)
kspec query '.items[] | select(.priority == "high") | .id'

# Aggregation
kspec count --type feature --group-by status
```

#### Validation

```bash
# Full validation
kspec validate

# Specific checks
kspec validate --schema      # Schema conformance
kspec validate --refs        # All references resolve
kspec validate --orphans     # Find unreferenced items

# In CI
kspec lint --strict
```

#### Diff and History

```bash
kspec diff --since HEAD~1
kspec diff --since spec-v1.0.0
kspec history auth-login
```

### Agent-Friendly Features

| Feature | Implementation |
|---------|----------------|
| **JSON output** | `--json` or `--output json` on all commands |
| **Idempotency** | `--if-not-exists`, `--if-changed` flags |
| **Non-interactive** | `--no-prompt` flag, `KSPEC_NO_PROMPT=1` env |
| **Dry-run** | `--dry-run` shows what would change |
| **Clear errors** | Structured JSON errors with codes and suggestions |
| **Semantic exit codes** | 0=success, 3=not found, 4=validation failed, etc. |

### Example Session

```bash
# Agent creates a new feature
$ kspec item add --type feature --id user-export \
    --title "Data Export" \
    --field "description=Allow users to export their data" \
    --json
{
  "success": true,
  "item": {"id": "user-export", "title": "Data Export", ...}
}

# Agent adds a dependency
$ kspec link create user-export user-model --type depends_on --json
{
  "success": true,
  "link": {"from": "user-export", "to": "user-model", "type": "depends_on"}
}

# Validate before commit
$ kspec validate --json
{
  "valid": true,
  "warnings": [],
  "errors": []
}
```

---

## Traceability

### Tiered Approach

Traceability is **opt-in and progressive** based on project needs:

#### Tier 1: Implicit (Default)

- No explicit links between spec and code
- Rely on naming conventions and structure
- Spec: `spec/auth/login.yaml` → Code: `src/auth/login.ts`
- Zero overhead

#### Tier 2: Convention-Based

- Stable IDs enable tracing
- Commit message convention: `Implements: auth-login`
- Test tagging: `@pytest.mark.spec("auth-login")`
- Optional: Generate traceability reports

```yaml
# Conventional commits
feat(auth): implement login endpoint

Implements: auth-login
Refs: #42
```

#### Tier 3: Formal Bidirectional

- Full traceability required (regulated industries)
- Spec items link to code locations
- Code annotations link back to spec
- CI validation enforces completeness

```yaml
# In spec
traceability:
  implementation:
    - path: src/auth/login.ts
      function: handleLogin
      lines: 45-78
  tests:
    - path: tests/auth/login.test.ts
  commits: [abc123]
```

```typescript
// In code
// @implements auth-login
export async function handleLogin(credentials: Credentials) {
  // ...
}
```

### Recommendation

**Start at Tier 1**, evolve to Tier 2 as specs stabilize, use Tier 3 only when compliance requires it. The format supports all tiers; the tooling makes each tier easy.

---

## Architecture

### Design Philosophy: Unix-Style Primitives

Kynetic Spec follows the **Unix philosophy**: do one thing well, compose with other tools.

Instead of a plugin architecture where plugins integrate INTO kspec:
```
kspec → [plugin system] → outputs  ❌
```

Kspec is a **clean primitive** that other tools consume:
```
kspec (library/CLI) → JSON/structured output → any tool  ✅
```

### Library-First Design

The core is a **TypeScript library** that can be consumed by:
- The `kspec` CLI (primary interface)
- Kynetic project integration
- Custom tooling
- CI/CD pipelines

```typescript
import { KyneticSpec, Item } from '@kynetic/spec';

const spec = await KyneticSpec.load('./spec');
const features = spec.items.filter(i => i.type === 'feature');
const json = spec.toJSON();
```

### Schema Definition: Zod

Schema is defined using **Zod** (TypeScript-native validation library):

```
Zod schemas (source of truth)
    ├── z.infer<> → TypeScript types (compile-time)
    ├── z.toJSONSchema() → JSON Schema (for docs, external validation)
    └── quicktype/agents → other language bindings (if needed)
```

**Why Zod**:
- Largest ecosystem in TypeScript validation space
- Native type inference (no separate type definitions)
- JSON Schema export in v4
- Excellent DX and framework integration

### Consuming Tools (Examples)

Tools that might consume the kspec library/output:

| Tool | Purpose | Integration |
|------|---------|-------------|
| `kspec-docs` | Generate markdown documentation | Library consumer |
| `kspec-github` | Sync to GitHub Issues | Library consumer |
| Kynetic | Task orchestration | Library integration |
| CI pipelines | Validation, reports | CLI JSON output |

Each tool is independent, maintained separately, and composes with kspec rather than being embedded in it.

### Git Hooks

Hooks are **declarative in config** + **opt-in installation**:

```yaml
# In spec manifest
hooks:
  commit-msg: validate-refs    # What hooks are wanted
  pre-commit: lint
```

```bash
# Developer opts in
kspec hooks install    # Reads config, sets up hooks
kspec hooks uninstall  # Removes hooks
```

CI can enforce the same checks without requiring hooks installed locally.

---

## Implementation Roadmap

### Phase 1: Foundation

- [ ] Finalize YAML schema and conventions
- [ ] Create JSON Schema for validation
- [ ] Implement core CLI (`kspec` command)
  - [ ] `item add/get/list/set/delete`
  - [ ] `validate`
  - [ ] `--json` output mode
- [ ] Basic documentation

### Phase 2: Relationships and Queries

- [ ] Implement `link` commands
- [ ] Cross-reference validation
- [ ] Query capabilities (filtering, graph traversal)
- [ ] `diff` command for comparing versions

### Phase 3: Agent Integration

- [ ] Optimize for agent usage patterns
- [ ] Add `--dry-run`, idempotent operations
- [ ] Improve error messages for agent consumption
- [ ] Create agent integration guide

### Phase 4: Plugins and Outputs

- [ ] Define plugin interface
- [ ] Implement `markdown-docs` plugin
- [ ] Implement `task-list` plugin
- [ ] Plugin discovery and loading

### Phase 5: Advanced Features

- [ ] Traceability tooling (Tier 2 and 3)
- [ ] GitHub/Linear issue sync plugins
- [ ] Visual dependency graphs
- [ ] Baseline comparison reports

---

## Resolved Decisions

The following decisions were made through collaborative exploration:

### Format and Structure

| Decision | Resolution |
|----------|------------|
| **File structure** | **Auto-adaptive**: Start as single file, CLI offers to split when spec grows (threshold: ~500 lines or 20+ items) |
| **ID system** | **ULID + Slugs**: ULID is canonical (shortenable like git hashes), slugs are agent-generated aliases |
| **Schema layer** | **Zod**: TypeScript-native, exports JSON Schema, largest ecosystem |
| **Runtime** | **TypeScript/Node**: Library-first design, CLI as one consumer |

### Architecture

| Decision | Resolution |
|----------|------------|
| **Plugin model** | **Inverted**: No plugin system. Kspec is a clean primitive; other tools consume it (Unix philosophy) |
| **Library design** | **Library-first**: Core is a TS library; CLI and Kynetic integration consume it |
| **Git hooks** | **Declarative config + opt-in install**: Manifest declares hooks, `kspec hooks install` sets them up |

### Traceability and Workflow

| Decision | Resolution |
|----------|------------|
| **Traceability** | **Opt-in enforcement**: Configurable in manifest, validated when enabled |
| **Issue sync** | **One-way default**: Spec is authoritative; sync tools can add bidirectionality |
| **Approval state** | **Optional metadata**: Fields exist but are optional; teams needing audit trails use them |

### Multi-Repository and Templates

| Decision | Resolution |
|----------|------------|
| **Multi-repo** | **Scaffold pattern**: One-time import, not live dependency. `kspec scaffold <url>` copies items |
| **Templates** | **Dual support**: Regular specs can be scaffolded; optional template format with markers for dynamic generation |

### Task System

| Decision | Resolution |
|----------|------------|
| **Task-spec relationship** | **Hybrid with types**: Spec-derived tasks follow stricter rules; free-form tasks (infra, bugs) are looser |
| **Data duplication** | **Reference, don't copy**: Tasks reference spec via `spec_ref`; don't duplicate spec content |
| **Task storage** | **Auto-adaptive**: Start alongside specs, separate `tasks/` directory when volume grows |
| **Task IDs** | **Same as specs**: ULID + slugs, unified ID system |
| **Task states** | **Standard 5-state + derived**: pending, in_progress, blocked, completed, cancelled. Blocked auto-computed from deps |
| **Concurrency** | **External constraint**: Kspec doesn't enforce WIP limits; orchestration layer handles that |
| **Task derivation** | **Command-triggered**: `kspec derive @feature` when explicitly requested, not automatic |
| **Notes/updates** | **Append-only with supersession**: Entries never deleted, but new entries can supersede old ones |
| **Todos** | **Promote pattern**: Start as lightweight checklist items, promote to full subtasks when complex |
| **VCS linking** | **Minimal + extensible**: Simple refs (branch/commit/tag), type optional, extend schema as needed |

### ID System Details

**Canonical ID**: ULID (Universally Unique Lexicographically Sortable Identifier)
- Time-sortable
- Can be shortened like git hashes: `01HQ3K5X...` → `01HQ3K`
- Never changes, never reused

**Slugs**: Human-friendly aliases
- Agent-generated based on content/context
- Multiple slugs can point to same ULID
- Can evolve over time

**Reference syntax**:
```yaml
depends_on:
  - "@01HQ3K"        # Short ULID reference
  - "@auth-login"    # Slug reference (resolved to ULID)
```

---

## Appendices

### A. Comparison with Alternatives

See [FORMAT_COMPARISON.md](./FORMAT_COMPARISON.md) for detailed format comparison.

### B. Research Sources

The design was informed by research into:
- Requirements management tools (IBM DOORS, Jama Connect, ReqIF)
- Documentation-as-code tools (OpenAPI, Cucumber/Gherkin, ADRs)
- CLI design patterns (kubectl, gh, terraform)
- Versioning practices (SemVer, git tagging, RFC lifecycle)
- Traceability standards (DO-178C, IEC 62304, ISO 26262)

### C. Glossary

| Term | Definition |
|------|------------|
| **Item** | The fundamental unit in a spec (feature, requirement, etc.) |
| **UID** | Unique identifier for an item (stable, never reused) |
| **Baseline** | A named snapshot of the spec at a point in time |
| **Traceability** | Links between spec items and implementation artifacts |
| **Plumbing** | Low-level CLI commands for scripting |
| **Porcelain** | High-level CLI commands for humans |

---

*This document is itself a Kynetic Spec artifact, demonstrating the format it describes.*
