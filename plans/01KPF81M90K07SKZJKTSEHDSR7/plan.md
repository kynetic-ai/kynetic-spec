# User Documentation Foundation

## Specs

```yaml
# ─── Module ───

- title: User Documentation
  slug: user-documentation
  type: module
  description: |
    End-user-facing documentation for kspec: the reflective
    material a developer adopting kspec reads to understand
    what the system is, how to install and set it up, how to
    reason about their work in kspec's terms, and how to
    recover when something unexpected happens. The surface
    serves both a public audience learning about kspec and a
    user who has installed kspec and is running the web UI
    locally; both see the same content.

# ─── Structure ───

- title: Docs Top-Level Sections
  slug: docs-section-taxonomy
  type: decision
  parent: "@user-documentation"
  description: |
    The docs surface presents five top-level sections, no more
    and no fewer: Getting Started, Guides, Concepts,
    Troubleshooting, and Release Notes. Each section has a
    landing page and a set of child pages. Exhaustive
    enumerations of every command flag or schema field are
    explicitly absent and are left for a follow-up plan to
    produce from canonical sources.
  acceptance_criteria:
    - id: ac-1
      given: |
        A reader opens the docs surface
      when: |
        The reader consults the primary docs navigation
      then: |
        The five top-level sections shown are Getting Started,
        Guides, Concepts, Troubleshooting, and Release Notes,
        in that order
    - id: ac-2
      given: |
        A section has at least one page
      when: |
        The reader opens the section's landing page
      then: |
        The landing page summarises the section's purpose in
        one paragraph and links to each child page in reading
        order

- title: Docs Are Reachable From the Web UI and Work Offline
  slug: docs-reachability
  type: requirement
  parent: "@user-documentation"
  description: |
    A reader already in the web UI (public or locally served)
    reaches docs through the same primary navigation they use
    to reach any other app destination. The docs surface does
    not depend on the daemon at runtime: a reader who has
    installed kspec and is running the UI against their own
    project can read docs without internet access, and a
    reader on the public deployment sees the same content
    without any server-side help.
  acceptance_criteria:
    - id: ac-1
      given: |
        A reader is on any app route in the web UI
      when: |
        The reader looks at the primary navigation
      then: |
        A "Docs" entry is present and navigates to the docs
        landing page
    - id: ac-2
      given: |
        A reader is running the web UI against a local kspec
        daemon, disconnected from the internet
      when: |
        The reader navigates to the docs surface and reads a
        page
      then: |
        The page renders fully without any network request to
        a non-local host
    - id: ac-3
      given: |
        A reader visits the publicly deployed docs
      when: |
        The reader navigates between docs pages
      then: |
        Pages render without requiring a running kspec daemon
        and without server-side rendering

- title: Docs Navigation and Page Shape
  slug: docs-navigation-shape
  type: requirement
  parent: "@user-documentation"
  description: |
    Within the docs surface, a sidebar shows the current
    section's pages with the current page indicated, a table
    of contents for the current page shows its headings, and
    every heading carries an anchor that can be copied as a
    stable direct link.
  acceptance_criteria:
    - id: ac-1
      given: |
        A reader is on a docs page
      when: |
        The reader views the layout
      then: |
        A sidebar lists the pages of the current section, the
        current page is visually indicated, and a table of
        contents for the current page's headings is present
    - id: ac-2
      given: |
        A docs page has headings
      when: |
        The reader hovers or clicks a heading
      then: |
        The heading has a stable anchor that can be copied as a
        direct link to that section of the page

# ─── Content ───

- title: Getting Started Section
  slug: docs-getting-started-section
  type: requirement
  parent: "@user-documentation"
  description: |
    The Getting Started section walks a new reader from a
    machine with nothing installed to a working kspec project
    they have directed their agent through. It contains, at
    minimum, pages covering these stages, in this order:

    - Overview — what kspec is and who it is for
    - Installation — install via npm, supported Node versions,
      verifying the install
    - Initializing a Project — running init and setup, what
      gets created, what the reader should not edit by hand
    - Connecting Your Agent — agent setup for at least one
      supported agent family, and how to confirm the
      connection works
    - Your First Action — directing the agent through a first
      meaningful authoring step
    - Where to Go Next — pointers into Guides and Concepts

    The section may grow additional pages as kspec evolves
    without breaking this contract, provided the stages above
    are covered. Pages are linear: each ends with a "next"
    link to the following page.
  acceptance_criteria:
    - id: ac-1
      given: |
        The Getting Started section is published
      when: |
        A maintainer follows the section's pages in order in a
        clean environment
      then: |
        The pages cover install, project initialization, agent
        integration, and at least one authoring action, with
        the commands or procedure for each step shown on its
        page in a form that can be executed without consulting
        material outside Getting Started
    - id: ac-2
      given: |
        A Getting Started page other than the last is published
      when: |
        A reviewer reads the page
      then: |
        The page ends with a "next" link pointing to the
        subsequent page in the section's reading order
    - id: ac-3
      given: |
        The Initializing a Project page is published
      when: |
        A reviewer reads the page
      then: |
        The page names the shadow branch, identifies the
        project's shadow directory, names the health-check and
        repair commands, and instructs the reader not to edit
        shadow state by hand

- title: Concepts Section
  slug: docs-concepts-section
  type: requirement
  parent: "@user-documentation"
  description: |
    The Concepts section gives the reader durable mental
    models for kspec. It contains, at minimum, pages covering
    these concepts:

    - What kspec Is — the system's purpose and shape
    - Working With kspec Through an Agent — the mental model
      for directing an AI agent: how to frame requests, what
      the agent decides on its own, what it asks about, and
      how to read the shape of what it has done
    - Specs, Tasks, Plans, and Inbox — the decision matrix for
      what goes where
    - The Shadow Branch — what it is, why spec state is kept
      there, how it shows up in day-to-day use
    - Traits — what they are and how they compose acceptance
      criteria across specs
    - Reviews — the per-cycle review record model and how it
      gates work
    - Agents and Dispatch — how agents execute work and how
      dispatch assigns it
    - The Web UI and the Daemon — what each surface is for and
      when to use them

    Each page follows the same shape: what it is, why it
    exists, how it surfaces in use, and — where helpful —
    what alternatives were considered. The section may grow
    additional concept pages as kspec evolves without breaking
    this contract, provided the concepts above remain covered.
  acceptance_criteria:
    - id: ac-1
      given: |
        A reader opens the Concepts section
      when: |
        The reader consults the section landing page
      then: |
        The concept pages listed in the description are
        present and linked from the landing page
    - id: ac-2
      given: |
        A Concepts page is published
      when: |
        A reviewer reads the page
      then: |
        The page answers what the concept is, why it exists,
        and how the reader will encounter it in use, without
        enumerating command flags or schema fields that change
        per release
    - id: ac-3
      given: |
        A reader wants to decide whether a unit of work is a
        spec, task, plan, or inbox item
      when: |
        The reader consults the Specs, Tasks, Plans, and Inbox
        page
      then: |
        The page provides a decision rule for each of the four
        kinds that the reader can apply without reading
        further material

- title: Guides Section
  slug: docs-guides-section
  type: requirement
  parent: "@user-documentation"
  description: |
    The Guides section covers common end-user workflows as
    sequential procedures framed around the reader's goal. It
    contains, at minimum, guides covering these workflows:

    - Starting a New Project
    - Directing Your Agent Effectively
    - Importing and Approving a Plan
    - Authoring and Completing a Task
    - Reviewing an Agent's Work
    - Upgrading kspec to a New Version
    - Recovering From Shadow Branch Issues

    Each guide begins with the reader's goal, lists the
    prerequisites (including "completed Getting Started" where
    applicable), provides the sequence of steps, and ends
    with a verification the reader can perform to know the
    goal is accomplished. The section may grow additional
    guides as kspec evolves without breaking this contract,
    provided the workflows above remain covered.
  acceptance_criteria:
    - id: ac-1
      given: |
        A reader opens the Guides section
      when: |
        The reader consults the section landing page
      then: |
        The guides listed in the description are present and
        linked from the landing page
    - id: ac-2
      given: |
        A reader opens any guide
      when: |
        The reader reads the guide in order
      then: |
        The guide states the reader's goal, names its
        prerequisites, presents the steps in sequence, and
        ends with a verification the reader can perform to
        confirm the goal was met
    - id: ac-3
      given: |
        A guide names a kspec command
      when: |
        The reader wants the full flag list for that command
      then: |
        The guide points the reader to the command's help
        output rather than transcribing the flags inline

- title: Troubleshooting Section
  slug: docs-troubleshooting-section
  type: requirement
  parent: "@user-documentation"
  description: |
    The Troubleshooting section is an index of recovery
    procedures keyed by the symptom the reader observes — in
    their own output or in their agent's output. Entries grow
    as new failure modes emerge in the system; the section's
    initial coverage includes at minimum these symptoms:

    - Shadow branch is out of sync with remote
    - Shadow branch worktree is broken or missing
    - Daemon cannot bind to its port because the port is in use
    - "Cannot run kspec from inside the shadow directory" error
    - Upgrade reports a pre-plan state or partial scaffold
    - Agent dispatch refuses to assign a task
    - A review is blocking merge with an unresolved thread

    Each entry follows the shape: symptom → what this means →
    recovery procedure → commands to run by name → what a
    healthy outcome looks like. Entries link to the
    corresponding concept page where the underlying system is
    explained rather than re-explaining the primitive inline.
  acceptance_criteria:
    - id: ac-1
      given: |
        A Troubleshooting entry is published
      when: |
        A reviewer reads the entry's title and opening
      then: |
        The entry is titled and opened in terms of the symptom
        the reader observes in their own output or their
        agent's output, not in terms of the internal cause
        name, so the entry is findable by readers who cannot
        yet name what is wrong
    - id: ac-2
      given: |
        A reader reads a troubleshooting entry
      when: |
        The reader follows the recovery procedure
      then: |
        The entry describes the symptom, explains what the
        symptom means, states the recovery procedure in prose,
        names the commands to run, and describes what a
        healthy outcome looks like so the reader knows when
        recovery has succeeded
    - id: ac-3
      given: |
        A troubleshooting entry mentions a kspec primitive the
        reader may not know
      when: |
        The reader wants to understand the primitive
      then: |
        The entry links to the corresponding page in the
        Concepts section rather than re-explaining the
        primitive inline

- title: Release Notes Available in Docs Without Duplication
  slug: docs-release-notes-availability
  type: requirement
  parent: "@user-documentation"
  description: |
    The docs surface presents release notes as a single page so
    a reader can see what changed in the currently installed
    version and any prior released version without leaving the
    docs. The notes shown are always the same as the single
    source of truth already consumed by the CLI's release-notes
    command, so authoring release notes remains one action and
    the docs cannot drift from what the CLI shows.
  acceptance_criteria:
    - id: ac-1
      given: |
        A reader is on the docs surface
      when: |
        The reader navigates to the release notes page
      then: |
        The page presents release notes for the current version
        and an index of prior versions, with each version
        anchored so direct links to a version work
    - id: ac-2
      given: |
        The docs surface is built
      when: |
        A reviewer compares the rendered release-notes page
        against the canonical release notes source file used
        by the same build
      then: |
        The rendered content is equivalent to the source file
        and no second copy of release notes content exists
        elsewhere in the repository

- title: Docs Search
  slug: docs-search
  type: feature
  parent: "@user-documentation"
  description: |
    The docs surface has a search input that matches reader
    input against the full text of every docs page and returns
    direct links to matching pages. Search works identically
    on the public deployment and in the locally-served UI,
    runs entirely in the reader's browser, and requires no
    external service.
  acceptance_criteria:
    - id: ac-1
      given: |
        A reader is on any docs page
      when: |
        The reader opens the docs search input and submits a
        term that appears in a docs page
      then: |
        The page containing the term is returned as a search
        result with a link to that page
    - id: ac-2
      given: |
        A reader searches from within the locally-served UI
        with no internet connection
      when: |
        The reader submits a search query
      then: |
        Results are returned without any network request to a
        non-local host
    - id: ac-3
      given: |
        A reader searches on the public deployment
      when: |
        The reader submits a search query
      then: |
        The same set of matching pages is returned as would be
        returned from the locally-served UI against the same
        docs content

# ─── Boundary With Other Surfaces ───

- title: README Is a Concise Landing Page
  slug: readme-landing-page
  type: requirement
  parent: "@user-documentation"
  description: |
    The README is a concise landing page targeting a reader
    deciding whether to adopt kspec. It contains an overview
    paragraph, an install section, a first-steps pointer
    consisting of one or two commands plus a link to the docs
    surface, and a small set of cross-links into the docs
    sections. It does not embed guides, concept explanations,
    or reference content — those live in the docs surface and
    the README links to them.
  acceptance_criteria:
    - id: ac-1
      given: |
        The README is published
      when: |
        A reviewer reads the file end to end
      then: |
        The file contains at minimum sections covering
        overview, installation, first steps, and cross-links
        into the docs, and does not embed guides, concept
        explanations, or reference content
    - id: ac-2
      given: |
        The README is published
      when: |
        A reviewer looks for next-step links
      then: |
        Links are present into the docs sections sufficient to
        reach Getting Started, Concepts, and Guides in one
        click from the README

```

## Tasks

derive_from_specs: false

```yaml
- title: Set up docs rendering in the web UI
  slug: task-docs-rendering
  priority: 1
  tags: [docs, web-ui, infra]
  spec_ref: "@docs-reachability"
  description: |
    Wire the web UI to render Markdown docs content at a
    /docs/* route tree.

    Why: Docs are reached through the web UI per
    @docs-reachability; the rendering pipeline is the bridge
    from authored Markdown to rendered pages.

    What: Extend packages/web-ui with a [...slug] dynamic
    route under /docs that maps URL paths to Markdown files
    under the repository's top-level docs/ directory, rendered
    through the existing marked + Tailwind typography +
    highlight.js pipeline. Docs content is bundled into the
    static build so pages work in VITE_STATIC_MODE and in
    daemon mode without any API call. Adjust vite.config.ts
    (server.fs.allow) to permit reading from ../../docs.
    Rendering produces anchored headings and client-side
    routing for inter-page navigation.

    Covers: @docs-reachability ac-2, ac-3,
    @docs-navigation-shape ac-2.

- title: Establish docs section scaffolding at the repo root
  slug: task-docs-section-scaffolding
  priority: 1
  tags: [docs, content]
  spec_ref: "@docs-section-taxonomy"
  depends_on:
    - "@task-docs-rendering"
  description: |
    Create the top-level docs directory structure and the five
    section landing pages so navigation and routing land on
    valid content.

    What: Create docs/getting-started/, docs/guides/,
    docs/concepts/, docs/troubleshooting/, and
    docs/release-notes/ under the repository root. Each
    section gets an index.md that states the section's
    purpose and lists its child pages (initially a stub list).
    Add a documented exclusion rule so docs/history/ and
    other contributor-only files are not published to the
    rendered site.

    Covers: @docs-section-taxonomy ac-1, ac-2.

- title: Integrate docs into primary web UI navigation
  slug: task-docs-nav-integration
  priority: 2
  tags: [docs, web-ui]
  spec_ref: "@docs-reachability"
  depends_on:
    - "@task-docs-section-scaffolding"
  description: |
    Add a "Docs" entry to the web UI primary navigation and
    build the docs-specific layout with section sidebar and
    per-page table of contents.

    What: Add Docs to the existing nav component. Add the
    /docs layout component that renders a sidebar listing the
    current section's pages (current page indicated) and a
    table-of-contents column showing the current page's
    headings. Reuse the existing UI components and theming.

    Covers: @docs-reachability ac-1,
    @docs-navigation-shape ac-1.

- title: Author the Getting Started section
  slug: task-docs-getting-started-content
  priority: 2
  tags: [docs, content, getting-started]
  spec_ref: "@docs-getting-started-section"
  depends_on:
    - "@task-docs-section-scaffolding"
  description: |
    Author the six Getting Started pages (Overview,
    Installation, Initializing a Project, Connecting Your
    Agent, Your First Action, Where to Go Next) in order.

    What: Each page is a self-contained walkthrough ending
    with a "next" link. Verify the full sequence end to end
    against a clean environment before marking complete. The
    Initializing a Project page introduces the shadow branch
    well enough that the reader does not fear the shadow
    directory.

    Covers: @docs-getting-started-section ac-1 through ac-3.

- title: Author the Concepts section
  slug: task-docs-concepts-content
  priority: 2
  tags: [docs, content, concepts]
  spec_ref: "@docs-concepts-section"
  depends_on:
    - "@task-docs-section-scaffolding"
  description: |
    Author the eight Concepts pages listed in
    @docs-concepts-section.

    What: Each page follows the what / why / how it surfaces /
    alternatives-where-helpful shape. The Specs, Tasks, Plans,
    and Inbox page includes a decision rule per kind. The
    Working With kspec Through an Agent page gives durable
    rules of thumb for framing requests, reading agent output,
    and knowing when a change needs a spec update first.

    Covers: @docs-concepts-section ac-1 through ac-3.

- title: Author the Guides section
  slug: task-docs-guides-content
  priority: 2
  tags: [docs, content, guides]
  spec_ref: "@docs-guides-section"
  depends_on:
    - "@task-docs-section-scaffolding"
  description: |
    Author the seven guides listed in @docs-guides-section.

    What: Each guide begins with a goal statement, lists
    prerequisites, presents steps in sequence, and ends with a
    verification. Guides name commands and link to kspec
    <command> --help rather than transcribing flag lists.

    Covers: @docs-guides-section ac-1 through ac-3.

- title: Author the Troubleshooting section seed entries
  slug: task-docs-troubleshooting-content
  priority: 2
  tags: [docs, content, troubleshooting]
  spec_ref: "@docs-troubleshooting-section"
  depends_on:
    - "@task-docs-section-scaffolding"
    - "@task-docs-concepts-content"
  description: |
    Author the initial troubleshooting entries listed in
    @docs-troubleshooting-section.

    What: Each entry follows the shape symptom → what this
    means → recovery procedure → commands by name → healthy
    outcome, and links to the corresponding Concepts page
    rather than explaining the primitive inline.

    Covers: @docs-troubleshooting-section ac-1 through ac-3.

- title: Render release notes at /docs/release-notes from the canonical source
  slug: task-docs-release-notes-rendering
  priority: 2
  tags: [docs, web-ui, release-notes]
  spec_ref: "@docs-release-notes-availability"
  depends_on:
    - "@task-docs-rendering"
  description: |
    Wire /docs/release-notes to render the repository's
    top-level RELEASE_NOTES.md with stable version anchors,
    without duplicating the file.

    What: The route imports RELEASE_NOTES.md at build time and
    renders it through the shared Markdown pipeline. Version
    headings produce anchors of the form v<major>-<minor>-<
    patch>. The rendered output matches the output of kspec
    release-notes for the same content.

    Covers: @docs-release-notes-availability ac-1, ac-2.

- title: Add docs search
  slug: task-docs-search
  priority: 3
  tags: [docs, web-ui, search, infra]
  spec_ref: "@docs-search"
  depends_on:
    - "@task-docs-rendering"
    - "@task-docs-nav-integration"
    - "@task-docs-getting-started-content"
    - "@task-docs-concepts-content"
    - "@task-docs-guides-content"
    - "@task-docs-troubleshooting-content"
    - "@task-docs-release-notes-rendering"
  description: |
    Add a search input on the docs surface that returns pages
    matching a query, works in both public and local
    deployments, and runs entirely in the browser.

    What: Use a static, post-build indexing tool (Pagefind is
    the evaluated choice) scoped to the docs routes. The
    build produces a search index that ships with the static
    output. A search input in the docs layout loads the index
    lazily and shows matching pages as results.

    Covers: @docs-search ac-1 through ac-3.

- title: Trim README and repoint it at the docs surface
  slug: task-docs-readme-trim
  priority: 3
  tags: [docs, readme]
  spec_ref: "@readme-landing-page"
  depends_on:
    - "@task-docs-getting-started-content"
  description: |
    Rewrite the README to the shape declared in
    @readme-landing-page (overview, install, first steps, docs
    links) and move any long-form content that currently
    lives there into the appropriate docs section.

    Covers: @readme-landing-page ac-1, ac-2.

```

## Implementation Notes

**Why now.** kspec has grown a surface area that a new user
cannot discover from `--help` alone, and most users reach
kspec by directing an AI coding agent rather than by invoking
the CLI themselves. The project needs a single place a human
can go to learn what kspec is, install it, connect an agent,
and build enough of a mental model to ask their agent for the
right thing.

**Content structure.** Five top-level sections — Getting
Started, Guides, Concepts, Troubleshooting, Release Notes —
are the full taxonomy. The section shape comes from the
task-oriented split common to mature developer-tool CLIs and
is deliberately small: more sections invite overlap and decay.
Reference-style pages that enumerate every command flag or
schema field are intentionally out of scope for this plan and
belong to a follow-up that generates reference from canonical
sources.

**Implementation anchors.** The plan's specs describe
user-observable behaviour only; the following decisions
record how the team intends to realise that behaviour, but
they are implementation choices recorded here rather than
contractual requirements embedded in specs:

- **Content source location.** Documentation content is
  authored as Markdown under `docs/` at the repository root.
  The directory structure mirrors the URL structure so the
  file path predicts the rendered URL. The pre-existing
  `docs/history/` subtree is excluded from rendering via a
  documented exclusion rule so design history remains in the
  repo without leaking onto the site.
- **Rendering surface.** The existing `packages/web-ui`
  SvelteKit package is extended with a `[...slug]` dynamic
  route under `/docs` that reads Markdown from the repo's
  `docs/` directory at build time and renders pages through
  the package's existing `marked` + Tailwind typography +
  `highlight.js` pipeline. This reuses the production-grade
  static build, theming system, and `gh-pages-ui.yml` deploy
  workflow the project already maintains. No separate docs
  generator (VitePress, Docusaurus, Starlight) is introduced.
- **Local and public parity.** Because docs are bundled into
  the static SPA at build time, the same build shipped to the
  public GitHub Pages deployment is the build installed by
  npm consumers and served by `kspec serve`. The docs surface
  makes no daemon calls at runtime, so it works identically
  across both contexts and offline.
- **Search.** Pagefind is the evaluated choice: it indexes
  rendered HTML after the build, ships static JSON bundles,
  runs entirely in the browser, and adds no external
  dependency. A hosted service (Algolia DocSearch) was
  rejected because it would fail the offline-local
  requirement; ad-hoc client-side fuzzy search was rejected
  because it scales poorly past a few dozen pages.
- **Release notes.** The existing `RELEASE_NOTES.md` is the
  single source of truth already consumed by
  `kspec release-notes`. The `/docs/release-notes` page
  imports that file at build time and renders it through the
  same Markdown pipeline as other docs pages.

These are all implementation details: if the team later
switches the renderer, moves the source location, or replaces
the search tool, the specs remain valid because they describe
what the reader observes, not how it was produced.

**Maintainability bias.** Every authoring decision is filtered
through one question: will this content still be correct a
year from now without edits? Pages that answer yes — concept
explanations, onboarding shape, workflow procedures,
symptom-based troubleshooting — go into docs. Content that
answers no — flag enumerations, schema field lists, exact
command output — is not hand-transcribed; pages link to the
authoritative source. Contribution guidance and the
reflective/operational boundary between docs and agent
runtime instructions are external process concerns, out of
scope for this plan; they should be handled through the
project's normal contribution documentation rather than as
spec contracts.

**Enumeration convention for content specs.** Content-section
specs (Getting Started, Concepts, Guides, Troubleshooting)
name specific pages and entries to make the initial delivery
executable and prevent scope creep during authoring. These
enumerations are *minimums, not ceilings*: the specs are
satisfied as long as the listed content is present, and the
sections may grow additional pages over time without breaking
the contracts. Adding a new page within an existing section is
ordinary content evolution and does not require a spec
revision. In contrast, the top-level section taxonomy
(@docs-section-taxonomy) is deliberately frozen at exactly five
sections — adding a sixth top-level section is an
architectural change that *should* require a plan-level
decision and a spec revision rather than quiet content creep.
This is the line between evolutionary growth (safe) and
taxonomic change (deliberate).

**Agent-mediated users.** A common path users take to reach
kspec is by directing an AI coding agent in natural language.
The Concepts section includes a dedicated page — Working With
kspec Through an Agent — that gives the reader durable rules
for framing requests, knowing what the agent should decide
versus ask about, and reading the shape of what the agent has
done. The rest of the docs remain useful to users who invoke
the CLI directly; the agent-mediated framing is additive.

**Non-scope.** Auto-generated CLI and schema reference (a
follow-up plan will design that pipeline); docs localization;
multi-version docs builds; marketing content; embedded in-app
help beyond what the web UI already renders; contribution
guidance and the reflective/operational docs boundary (both
are external process concerns rather than specification
contracts). `RELEASE_NOTES.md` covers historical behaviour
without a separate versioned docs build.

**Order of operations.** Rendering and section scaffolding
come first because everything else depends on them. Navigation
integration follows so content has a visible home. Content
authoring (Getting Started, Concepts, Guides, Troubleshooting)
can proceed in parallel once scaffolding is in place;
Troubleshooting depends on Concepts so its entries can link
cleanly. Release notes rendering is independent. Docs search
depends on the page-producing work so the index covers all
content. The README trim depends on Getting Started so the
trimmed README can point at real landing pages.

**Evaluation.** Success is not a page count. Success is that
a developer who has never seen kspec before can install it,
connect an agent, and direct that agent through a meaningful
first action by following Getting Started; a contributor
adding a page knows where it goes and what style to follow;
and the docs are still correct a year later without a large
catch-up effort.
