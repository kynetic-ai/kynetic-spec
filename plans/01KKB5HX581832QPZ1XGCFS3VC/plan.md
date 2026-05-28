# UI-Wide Markdown Rendering & Plan Embedded Views

## Specs

```yaml
- title: Markdown Rendering Trait
  slug: trait-markdown-rendering
  type: trait
  description: |
    Cross-cutting trait defining quality requirements for any UI component
    that renders user or agent-authored markdown content. Ensures consistent
    rendering, syntax highlighting, sanitization, and dark mode support
    across all markdown surfaces.
  acceptance_criteria:
    - id: ac-1
      given: |
        a component renders markdown content
      when: |
        the content includes GFM elements (headings, lists, tables, links,
        emphasis, strikethrough, task lists, blockquotes)
      then: |
        all GFM elements render with correct semantic HTML and Tailwind
        prose typography styling
    - id: ac-2
      given: |
        markdown content contains fenced code blocks with a language tag
      when: |
        the content is rendered
      then: |
        code blocks display with syntax highlighting for the specified
        language using highlight.js, with at least 15 common languages
        supported (bash, typescript, javascript, python, rust, go, json,
        yaml, sql, css, html, java, c, cpp, diff)
    - id: ac-3
      given: |
        markdown content contains inline code spans
      when: |
        the content is rendered
      then: |
        inline code renders with a visually distinct background and
        monospace font, distinguishable from surrounding prose
    - id: ac-4
      given: |
        markdown content contains any HTML including script tags,
        event handlers, or javascript: URLs
      when: |
        the content is rendered
      then: |
        all unsafe HTML is stripped via DOMPurify sanitization while
        preserving safe structural markup (p, strong, em, code, pre,
        lists, tables, blockquotes)
    - id: ac-5
      given: |
        the UI is in dark mode
      when: |
        markdown content is rendered
      then: |
        prose typography and syntax highlighting use dark-mode-compatible
        color schemes (prose-invert, dark highlight theme)
    - id: ac-6
      given: |
        markdown content contains external links (href starting with
        http://, https://, or //)
      when: |
        the content is rendered
      then: |
        external links include target="_blank" and rel="noopener noreferrer"
        attributes for security
    - id: ac-7
      given: |
        a component receives empty or undefined content
      when: |
        the markdown renderer is invoked
      then: |
        the component renders an empty container with no errors or
        console warnings
    - id: ac-8
      given: |
        markdown content contains malformed or unclosed syntax
        (e.g., unclosed code fences, broken table rows)
      when: |
        the content is rendered
      then: |
        the content renders gracefully with best-effort formatting
        and no runtime errors
    - id: ac-9
      given: |
        markdown content is very long (10,000+ lines or 500KB+)
      when: |
        the content is rendered
      then: |
        the component renders without blocking the main thread for
        more than 100ms and does not cause memory errors

- title: Prose Typography Setup
  slug: prose-typography-setup
  type: requirement
  parent: "@web-dashboard"
  description: |
    Install and configure @tailwindcss/typography (or equivalent Tailwind v4
    prose plugin) so that prose utility classes produce correct typography
    styling. Currently prose classes are used in MessageBlock and plans page
    but have no effect because the typography plugin is not installed.
  acceptance_criteria:
    - id: ac-1
      given: |
        a container element has class "prose prose-sm dark:prose-invert"
      when: |
        the page renders
      then: |
        headings, paragraphs, lists, blockquotes, code blocks, and tables
        display with appropriate sizing, spacing, and typography styles
    - id: ac-2
      given: |
        the typography plugin is configured
      when: |
        the web-ui builds
      then: |
        the prose styles are included in the CSS bundle and work correctly
        with the existing dark theme
  implementation_notes: |
    Check Tailwind v4 compatibility. Options:
    1. Install @tailwindcss/typography v4-compatible version
    2. Use Tailwind v4 built-in prose if available
    3. Write custom prose styles if neither works
    This is a prerequisite for all other markdown work — existing prose
    classes are currently no-ops.

- title: Streaming Markdown Component
  slug: streaming-markdown-component
  type: feature
  parent: "@ui-session-stream"
  traits:
    - trait-markdown-rendering
  description: |
    A shared Svelte component that renders markdown content with support for
    both streaming (incremental) and static rendering modes. Ported from
    kynetic-internal's StreamingMarkdown pattern, adapted for kspec's web UI.
    Uses streaming-markdown for incremental parsing during live output, with
    highlight.js syntax highlighting applied on finalization.
  acceptance_criteria:
    - id: ac-1
      given: |
        the component receives content that is actively streaming
        (isStreaming=true)
      when: |
        new content chunks arrive (content string grows)
      then: |
        the component incrementally renders the new content without
        re-rendering the entire output
    - id: ac-2
      given: |
        the component is rendering streaming content
      when: |
        content includes fenced code blocks
      then: |
        syntax highlighting is deferred until streaming ends
        (isStreaming transitions to false)
    - id: ac-3
      given: |
        streaming ends (isStreaming transitions from true to false)
      when: |
        the parser finalizes
      then: |
        the parser flushes remaining content and DOMPurify sanitization
        runs on the finalized HTML
    - id: ac-4
      given: |
        streaming has ended and sanitization is complete
      when: |
        code blocks exist in the rendered output
      then: |
        highlight.js syntax highlighting is applied to all code blocks
        with recognized language tags
    - id: ac-5
      given: |
        the component is used in static mode (isStreaming=false, content
        is complete)
      when: |
        content is provided
      then: |
        the full rendering pipeline runs immediately (parse, sanitize,
        highlight) without streaming behavior
    - id: ac-6
      given: |
        the component is rendering streaming content
      when: |
        the content updates rapidly (multiple chunks per frame)
      then: |
        DOM updates are batched via requestAnimationFrame so that at
        most one DOM write occurs per animation frame
    - id: ac-7
      given: |
        the streaming markdown component replaces the current plain text
        streaming view in SessionStream
      when: |
        a live session streams agent output
      then: |
        the streaming text area renders with markdown formatting and
        displays a blinking cursor element with the ds-streaming-cursor
        class and cursor-blink animation
  implementation_notes: |
    Port streaming-markdown + highlight.js pattern from kynetic-internal's
    packages/hub-ui/src/lib/components/chat/StreamingMarkdown.svelte.

    Proven versions from kynetic-internal:
    - streaming-markdown@^0.2.15
    - highlight.js@^11.11.1

    Key files to reference:
    - StreamingMarkdown.svelte (component with 3 $effect blocks)
    - highlight.ts (highlight.js wrapper with language subset)
    - sanitize.ts (DOMPurify config with custom element handling)
    - app.css lines 256-331 (syntax highlight theme)

    Adapt for kspec's needs:
    - Drop KaTeX/Mermaid support (not needed for kspec content)
    - Keep streaming-markdown parser, highlight.js, DOMPurify stack
    - Replace current renderMarkdown() utility with this component for
      streaming contexts; keep renderMarkdown() for simple static use
    - Add highlight.js CSS theme to web-ui app.css

    Bundle size strategy: Use highlight.js/lib/core with individual
    language imports (not the full highlight.js bundle). Register only
    the 15 target languages.

    CSS scoping: streaming-markdown uses direct DOM manipulation with
    :global() selectors. Scope highlight theme and streaming styles
    carefully to avoid conflicts with other component styles.

    SSR note: All SvelteKit pages in this project export ssr=false,
    so DOMPurify and highlight.js DOM dependencies are not a concern.

- title: Batch Item Fetch API
  slug: batch-item-fetch-api
  type: requirement
  parent: "@web-dashboard"
  traits:
    - trait-api-endpoint
  description: |
    A daemon API endpoint to fetch multiple spec items and/or tasks by
    reference in a single request. Required by plan embedded views to
    resolve derived_specs and derived_tasks into renderable summaries
    without N+1 individual API calls.
  acceptance_criteria:
    - id: ac-1
      given: |
        a POST request to /api/items/batch with a JSON body containing
        a "refs" array of item references (ULIDs or @slugs)
      when: |
        all references resolve to existing items
      then: |
        the response contains an "items" array with each item's summary
        (ulid, slugs, title, type, status, maturity, traits, ac_count)
    - id: ac-2
      given: |
        a POST request to /api/items/batch includes refs that do not
        resolve to any existing item
      when: |
        the request is processed
      then: |
        resolved items are returned normally and unresolved refs appear
        in a separate "unresolved" array in the response
    - id: ac-3
      given: |
        a POST request to /api/items/batch includes task refs
        (refs that resolve to tasks rather than spec items)
      when: |
        the request is processed
      then: |
        tasks are returned with task-specific summary fields
        (ulid, slugs, title, status, priority, spec_ref)
    - id: ac-4
      given: |
        a POST request to /api/items/batch has an empty refs array
      when: |
        the request is processed
      then: |
        the response contains an empty items array and empty
        unresolved array with no errors
    - id: ac-5
      given: |
        a POST request to /api/items/batch has more than 100 refs
      when: |
        the request is processed
      then: |
        the response is a 400 error with a descriptive message
        indicating the maximum batch size
  implementation_notes: |
    Add route to packages/daemon/src/routes/items.ts.
    Use existing initContext + item/task loading patterns.
    Resolve refs using the same logic as findItemByRef/findTaskByRef.

- title: Plan Content Embedded Views
  slug: plan-embedded-views
  type: feature
  parent: "@ui-plans-view"
  traits:
    - trait-markdown-rendering
  description: |
    When viewing plan content in the UI, YAML code blocks containing spec
    and task definitions are detected and replaced with rich embedded cards
    that show the derived items' current state. Each embedded card links to
    the source spec or task. Non-YAML markdown content renders normally.
  acceptance_criteria:
    - id: ac-1
      given: |
        a plan's content contains a ```yaml code block under a "## Specs"
        heading with spec definitions that match derived_specs references
      when: |
        the plan content is rendered
      then: |
        the YAML block is replaced with embedded spec cards showing each
        spec's title, type, status/maturity, trait list, and acceptance
        criteria count
    - id: ac-2
      given: |
        a plan's content contains a ```yaml code block under a "## Tasks"
        heading with task definitions or derive_from_specs directive
      when: |
        the plan content is rendered
      then: |
        the YAML block is replaced with embedded task cards showing each
        derived task's title, status, assignee, and priority
    - id: ac-3
      given: |
        an embedded spec or task card is displayed
      when: |
        the user clicks the card or its link
      then: |
        navigation occurs to the spec's detail view or task's detail view
        (using existing item/task navigation patterns)
    - id: ac-4
      given: |
        a plan references derived specs/tasks but the content YAML block
        cannot be parsed or the parsed slugs do not match any
        derived_specs/derived_tasks references
      when: |
        the plan content is rendered
      then: |
        the YAML block renders as a normal syntax-highlighted code block
        (graceful fallback)
    - id: ac-5
      given: |
        the batch item fetch for embedded cards is loading
      when: |
        the plan content is first expanded
      then: |
        the embedded card areas display skeleton/loading placeholders
        while data is fetched
    - id: ac-6
      given: |
        the batch item fetch for embedded cards fails
      when: |
        the plan content is rendered
      then: |
        the YAML blocks fall back to syntax-highlighted code block
        rendering and an error indicator is shown
    - id: ac-7
      given: |
        an embedded spec card is expanded or shown in detail
      when: |
        the spec has acceptance criteria
      then: |
        acceptance criteria display in a structured format showing
        given/when/then text with proper formatting
    - id: ac-8
      given: |
        the plan content contains non-YAML markdown sections
        (Implementation Notes, prose descriptions)
      when: |
        the plan content is rendered
      then: |
        those sections render as standard formatted markdown with full
        prose typography and code highlighting
  implementation_notes: |
    Depends on batch-item-fetch-api for resolving derived refs.

    The plan detail API already returns derived_specs and derived_tasks
    as string arrays. After fetching plan detail, use the batch API to
    resolve those refs into summary objects for the embedded cards.

    Parse plan content to identify YAML blocks by heading context,
    match against derived refs, and render embedded components.
    Account for YAML flow scalars (>) vs block scalars (|) in stored
    plan content which may affect heading detection.

- title: Markdown Adoption Across UI Surfaces
  slug: markdown-ui-adoption
  type: feature
  parent: "@web-dashboard"
  traits:
    - trait-markdown-rendering
  description: |
    Adopt the markdown rendering component across all UI surfaces that
    display user or agent-authored text content. Currently only plan
    content and agent messages use markdown rendering. Task descriptions,
    task notes, observations, workflow descriptions, spec descriptions,
    inbox items, and acceptance criteria text should all render markdown.
  acceptance_criteria:
    - id: ac-1
      given: |
        a task's description field contains markdown formatting
      when: |
        the task detail panel is displayed
      then: |
        the description renders as formatted markdown instead of plain text
    - id: ac-2
      given: |
        a task note contains markdown (code blocks, links, lists)
      when: |
        the note is displayed in the task detail panel
      then: |
        the note content renders as formatted markdown instead of
        whitespace-preserved plain text
    - id: ac-3
      given: |
        an observation's content or context contains markdown
      when: |
        the observation is displayed on the observations page
      then: |
        the content renders as formatted markdown
    - id: ac-4
      given: |
        a workflow's description contains markdown
      when: |
        the workflow is displayed on the workflows page
      then: |
        the description renders as formatted markdown instead of
        whitespace-preserved plain text
    - id: ac-5
      given: |
        a spec item's description contains markdown
      when: |
        the item detail panel is displayed
      then: |
        the description renders as formatted markdown
    - id: ac-6
      given: |
        acceptance criteria given/when/then text contains inline code
        or other markdown formatting
      when: |
        the AC detail is expanded or viewed
      then: |
        the text renders with inline markdown formatting preserved
    - id: ac-7
      given: |
        an inbox item's text contains markdown formatting
      when: |
        the inbox page or triage view displays the item
      then: |
        the item text renders as formatted markdown
  implementation_notes: |
    This is primarily a component swap task. For each surface:
    1. Import renderMarkdown or the StreamingMarkdown component
    2. Replace plain text / whitespace-pre-wrap rendering with
       {@html renderMarkdown(content)} wrapped in prose classes
    3. Ensure prose styling works in each component's layout context

    Priority order (most impactful first):
    - Task notes (heavily used, often contain code blocks)
    - Task descriptions
    - Spec descriptions
    - Observations
    - Workflow descriptions
    - Inbox items
    - AC text (inline formatting only)

    ThinkingBlock and ToolCallView are intentionally excluded — they
    render agent internals where monospace/pre is the correct format.
    SystemBlock is also excluded — it shows structured system events,
    not user-authored markdown content.

    Shared DOMPurify config: Both the static renderMarkdown() utility
    and the StreamingMarkdown component must use the same DOMPurify
    allowlist configuration. Extract to a shared sanitize.ts module.
```

## Tasks

derive_from_specs: true

```yaml
- title: Add markdown rendering trait to existing specs
  slug: task-add-markdown-trait
  priority: 1
  tags:
    - spec
    - web-ui
```

## Implementation Notes

### Architecture Decision: Streaming vs Static Rendering

Two rendering paths coexist:
1. **StreamingMarkdown component** — for live session output where content grows incrementally. Uses streaming-markdown npm package for parser, applies highlight.js post-stream.
2. **renderMarkdown() utility** — for static content (plan text, descriptions, notes). Uses marked + DOMPurify. Enhanced with highlight.js via marked's highlight option.

Both share: highlight.js setup (via shared highlight.ts), DOMPurify sanitization config (via shared sanitize.ts), syntax theme CSS.

### Port Strategy from kynetic-internal

Port selectively, not wholesale:
- **Keep:** streaming-markdown parser, highlight.js with language subset, DOMPurify sanitization, custom renderer with Tailwind classes, syntax highlight CSS theme
- **Drop:** KaTeX math rendering, Mermaid diagram support, custom element handling for equations
- **Adapt:** Effect lifecycle for Svelte 5 patterns already used in kspec web-ui, prose class configuration for kspec's dark theme

**Bundle size:** Use `highlight.js/lib/core` with individual language imports (`import javascript from 'highlight.js/lib/languages/javascript'`). Register only the 15 target languages. This keeps the highlight.js contribution under 50KB gzipped vs 200KB+ for the full bundle.

**DOMPurify unification:** The existing `renderMarkdown()` in `markdown.ts` uses an explicit ALLOWED_TAGS/ALLOWED_ATTR allowlist. The streaming path from kynetic-internal uses a slightly different config. Extract a shared `sanitize.ts` with a single canonical DOMPurify configuration used by both paths to avoid security inconsistencies.

### Prose Typography Prerequisite

The `@tailwindcss/typography` plugin (or Tailwind v4 equivalent) must be installed and configured FIRST. Currently, `prose` classes in MessageBlock.svelte and plans/+page.svelte are no-ops — they have no styling effect. This blocks all visual markdown improvements.

### Plan Embedded Views Architecture

Plan content is a markdown string with known structure (## Specs, ## Tasks headings with YAML blocks). Processing pipeline:
1. Parse markdown into sections by heading
2. Detect YAML code blocks after ## Specs and ## Tasks headings
3. Cross-reference parsed slugs against plan.derived_specs / plan.derived_tasks
4. Fetch resolved item summaries via batch API (POST /api/items/batch)
5. For matched items, render embedded card components instead of code blocks
6. For unmatched or unparseable YAML, fall back to syntax-highlighted code block
7. Render remaining markdown normally

### Dependency Order

1. **Prose typography setup** (prerequisite — fixes existing broken styling)
2. Trait definition (no code dependency)
3. Streaming markdown component + highlight.js + sanitization (foundation)
4. Session stream integration (highest visibility improvement)
5. Static markdown enhancement (add highlight.js to existing renderMarkdown)
6. UI surface adoption (task notes, descriptions, inbox, etc.)
7. Batch item fetch API (required by embedded views)
8. Plan embedded views (most complex, builds on everything above)
9. Trait attachment to existing specs (update @ui-session-stream, @ui-plans-view, @web-dashboard)
