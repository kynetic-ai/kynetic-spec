---
name: ui-design
description: Pencil MCP reference and canvas conventions for designing kynetic-spec web UI
---
<!-- kspec-managed -->
# UI Design

Pencil MCP reference and canvas conventions for designing kynetic-spec web UI.

Design file: `design.pen` (project root)

## Pencil MCP Gotchas

- Variable names must NOT include `$` prefix — Pencil strips it silently
- Gradients CANNOT bind variable refs — they silently resolve to #000000; use raw values
- `batch_design` max ~25 operations per call — break larger changes into batches
- Always `get_screenshot` to validate after significant visual changes
- Use `find_empty_space_on_canvas` before placing new frames
- Use `get_guidelines(topic)` for domain-specific rules (topics: web-app, mobile-app, design-system, etc.)
- Use `get_style_guide_tags` + `get_style_guide` for design inspiration when starting new screens

## Workflow

1. `get_editor_state` — check what's open and selected
2. `open_document` — open design.pen (or 'new' for fresh file)
3. `get_guidelines(topic)` — load relevant design rules before starting
4. `snapshot_layout` — understand existing layout before inserting
5. `find_empty_space_on_canvas` — find placement for new frames
6. `batch_design` — create/update nodes
7. `get_screenshot` — validate visually
8. Iterate 6–7 until correct

## Canvas Organization

| Frame | Purpose | Location |
|-------|---------|----------|
| Design System | Tokens, palette, type scale, spacing | TBD |
| Components | Reusable component patterns | TBD |
| Pages | Full page compositions | TBD |

Locations updated as frames are placed.

## Component Inventory

*Populated as components are designed.*

| Component | Node ID | Key Descendants | Notes |
|-----------|---------|-----------------|-------|
| — | — | — | — |

## Pages to Design

Existing routes for reference:

- Dashboard (/) — counts, agent status, needs-attention
- Task list (/tasks) — filters, status, tags
- Task board (/tasks/board) — kanban
- Inbox (/inbox) — triage workflow
- Specs (/specs) — spec listing + detail
- Reviews (/reviews) — review records
- Agents (/agents) — agent status
- Sessions (/sessions) — session recordings
- Settings (/settings) — configuration
