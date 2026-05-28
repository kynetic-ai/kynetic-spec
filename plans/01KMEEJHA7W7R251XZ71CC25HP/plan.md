# UX Module and Design Decision Architecture

## Specs

```yaml
- title: UX Module
  slug: ux
  type: module
  description: |
    Top-level module governing user experience across all kspec surfaces.
    Parents the existing web-ui module and any future UX-related specs
    (design system, interaction patterns, information architecture).

    Design decisions flow from exploration (.pen file) into specs as they
    crystallize. The .pen file is the sketchpad; specs are the source of truth
    for what to build.

- title: Visual Design Language
  slug: visual-design-language
  type: feature
  parent: "@ux"
  description: |
    Cross-cutting visual decisions that define kspec's look and feel:
    color palette, typography, spacing rhythm, iconography style, and
    light/dark mode behavior. Evolves from design exploration in the
    .pen file. Supersedes the implementation-oriented ui-design-system
    spec with behavioral, experience-level language.
  acceptance_criteria:
    - id: ac-1
      given: |
        any page in the web UI
      when: |
        viewed in light mode and dark mode
      then: |
        both modes are visually coherent with consistent contrast ratios
        and no elements that feel like afterthoughts
    - id: ac-2
      given: |
        status indicators across all views (tasks, reviews, agents)
      when: |
        displayed to the user
      then: |
        each status is distinguishable by color and shape, not color alone

- title: Page Behavioral Contracts
  slug: page-contracts
  type: feature
  parent: "@ux"
  description: |
    Per-page specs defining what the user can see and do on each view.
    Not layout or visual treatment — those emerge from design exploration.
    Focused on: what data is shown, what actions are available, how
    navigation flows to and from the page.

    Individual page specs are children of this feature, created as
    pages are designed. This spec defines the pattern all page specs follow.
  acceptance_criteria:
    - id: ac-1
      given: |
        any page spec under this feature
      when: |
        the spec is written
      then: |
        it defines visible data, available actions, and navigation
        entry/exit points without prescribing layout or visual treatment
    - id: ac-2
      given: |
        a page with filtering or sorting
      when: |
        the user applies filters
      then: |
        filter state is reflected in the URL and survives page reload

- title: Interaction Pattern Traits
  slug: interaction-traits
  type: feature
  parent: "@ux"
  description: |
    Cross-cutting interaction behaviors expressed as traits that apply
    to multiple pages. Examples: empty state guidance, loading skeletons,
    confirmation for destructive actions, keyboard navigation.

    Individual traits are created as patterns emerge from design work.
    This spec defines the criteria for when something becomes a trait
    vs a per-page AC.
  acceptance_criteria:
    - id: ac-1
      given: |
        an interaction pattern appears on 3+ pages
      when: |
        the pattern is identified during design or review
      then: |
        it is extracted into a trait with its own ACs rather than
        duplicated across page specs
    - id: ac-2
      given: |
        a trait defines a cross-cutting interaction
      when: |
        a page spec implements that trait
      then: |
        the page spec does not restate the trait's ACs; it only
        adds page-specific variations if needed

- title: Project Pulse
  slug: project-pulse
  type: feature
  parent: "@ux"
  description: |
    A per-project attention signal visible in the sidebar and expandable
    into a deeper view. Surfaces what needs focus across the entire project
    at a glance — blocked tasks, pending reviews, inbox backlog, agent
    errors, stale work. Functions as project-level triage: not just
    counts, but a prioritized summary of where attention is needed.

    The sidebar shows a compact indicator (count or health signal).
    Clicking into it opens a project-scoped dashboard showing categorized
    attention items with the ability to dig into each area.
  acceptance_criteria:
    - id: ac-1
      given: |
        a project in the sidebar
      when: |
        the project has items needing attention
      then: |
        a compact indicator shows how many items need attention,
        distinguishable from general activity counts
    - id: ac-2
      given: |
        a project in the sidebar
      when: |
        the user expands or clicks the attention indicator
      then: |
        a view shows categorized attention items (blocked tasks,
        pending reviews, inbox items, agent errors) with the ability
        to navigate directly to each item
    - id: ac-3
      given: |
        a project with no items needing attention
      when: |
        displayed in the sidebar
      then: |
        the indicator is absent or visually minimal, not showing "0"

- title: Dispatch Status Indicator
  slug: dispatch-status-indicator
  type: feature
  parent: "@ux"
  description: |
    Visual indicator of dispatch engine state per project, shown in
    the sidebar project row. Communicates whether automated agents are
    actively working, idle and ready, offline, or in an error state.

    Four states:
    - Active (green): dispatch running, agents processing work
    - Idle (amber/teal): dispatch connected, no work queued
    - Offline (grey): dispatch not running or project not connected
    - Error (red): dispatch blocked or agent failures needing attention
  acceptance_criteria:
    - id: ac-1
      given: |
        a project row in the sidebar
      when: |
        the dispatch engine is actively processing tasks
      then: |
        a status indicator shows the active state
    - id: ac-2
      given: |
        a project row in the sidebar
      when: |
        dispatch states change (active, idle, offline, error)
      then: |
        the indicator updates in real time without page refresh
    - id: ac-3
      given: |
        dispatch is in an error state
      when: |
        the user sees the error indicator
      then: |
        hovering or clicking reveals what went wrong
```

## Tasks

derive_from_specs: true

```yaml
- title: Reparent web-ui module under ux
  slug: task-reparent-web-ui
  description: |
    Move the existing @web-ui module to be a child of the new @ux module.
    Verify all existing specs and tasks that reference @web-ui still resolve.
  priority: 2
  tags:
    - infra
    - spec

- title: Audit ui-design-system spec for behavioral language
  slug: task-audit-design-system-spec
  description: |
    Review @ui-design-system to determine if it should be superseded by
    @visual-design-language or updated in place. Current spec is
    implementation-oriented (token values, Tailwind mappings). Decide
    whether to keep it as implementation detail under the new behavioral
    spec or retire it.
  priority: 3
  tags:
    - spec
    - design
  spec_ref: "@visual-design-language"
```

## Implementation Notes

This plan captures architectural decisions about how design concerns fit into kspec's spec system. It is deliberately lightweight — the specs here are scaffolding that will grow as design work produces concrete decisions.

Key decisions:
1. UX is a top-level module, not nested under web-ui. Web-ui becomes a child of UX.
2. Design exploration happens in .pen files. Decisions crystallize into specs.
3. The ui-design skill stays operational (how to use Pencil). Design decisions live in specs.
4. Per-page behavioral contracts describe what users see and do, not layout/visuals.
5. Cross-cutting interaction patterns become traits when they appear on 3+ pages.
6. The existing @ui-design-system spec needs audit — it's implementation-oriented where the new approach is behavioral.

## Design Exploration Log (WIP)

Tracking design ideas explored in design.pen. These are not committed decisions —
they're directions being tested visually before becoming specs.

### Sidebar — Project-Level Navigation

The sidebar is the primary navigation surface. Projects are top-level items
(not hidden behind a dropdown). Each project expands to reveal its sections.

**Structure explored:**
- Logo/brand at top ("ordica")
- Project rows: chevron + color icon + name + status indicator (right-aligned)
- Expanded project shows grouped sections: AGENTS, WORK, SPECS, CONFIG
- Section headers are uppercase labels with chevrons, collapsible
- Nav items within sections: icon + label, optionally with badge counts
- Collapsed projects show just chevron + icon + name
- All chevrons align on a single vertical line; sub-item text aligns with section header text

**Visual treatment:**
- Dark neutral sidebar (#141414), no blue/purple cast
- Expanded project content area uses a slightly darker background (#1A1A1A) to denote depth
- Projects separated by shared 1px borders (#2A2A2A), flush with no gaps or rounded corners
- Deep amber accent (#B5682A) — warm, earthy, avoids purple

**Agent indicators:**
- Each agent shows a distinctive icon identifying its provider (e.g. sparkle for Claude, hexagon for OpenAI)
- Green dot for active/running, grey for idle — provider icon replaces generic status dots
- Agent section does not show a count; individual agent status is visible directly

### Status Chrome (Bottom of Sidebar)

Persistent bar pinned to sidebar bottom showing system health at a glance:
- Daemon connection status + port
- Dispatch engine status + active count
- Updates in real time

### Color Direction

- Primary accent: deep amber (#B5682A) — warm, grounded, not corporate
- Status greens for healthy/active, amber for idle/standby, grey for offline, red reserved for errors
- Avoid purple throughout
- Potential rebrand from kynetic-spec/kspec to "ordica" (by lepahc) — being tested in design

### Open Questions

- What exactly does the project-row number represent? Leaning toward "attention items
  needing focus" (project pulse) rather than task counts. Needs more exploration.
- Idle dispatch state color: amber vs teal vs dim green — not yet decided
- How does project pulse expand? Inline in sidebar, or navigates to a dashboard view?
- Section groupings (AGENTS, WORK, SPECS, CONFIG) — are these the right buckets?
