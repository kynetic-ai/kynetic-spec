// Spec workspace — UNIFIED PAGE+TREE alternative.
// Every node (module, feature, sub-feature, requirement, AC) can:
//   - Expand inline to reveal its children as inset rows (same row component as section 06)
//   - Be opened on its own page via a hover-revealed "open" affordance on the right of the row
// On a node's page, that node's children render as the same expandable rows.
// So navigation feels identical at every depth. Children expanded inline before opening
// stay expanded on the page; back returns to the tree with state intact.
//
// Five artboards:
//   ① TREE w/ HOVER     — root tree; one row hovered shows the "open page" affordance
//   ② MODULE PAGE       — Web UI System page; metadata header + features as expandable rows
//   ③ FEATURE PAGE      — Web Dashboard; one sub-feature already expanded inline
//   ④ REQUIREMENT PAGE  — Plan Content Embedded Views; ACs as expandable children
//                          (one expanded showing given/when/then inline)
//   ⑤ AC PAGE           — AC-1 as a focused page; given/when/then body, linked sessions/obs

// === Shared row with hover-revealed open affordance ==============
function URow({ kind, name, summary, tags, count, status, expanded, highlight, dimmed, hovered, titleHovered, ac }) {
  // titleHovered: hovering the title specifically reveals the open-page icon next to it
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      gap: 12,
      padding: "10px 14px",
      border: "1px solid var(--line)",
      background: expanded ? "#fbfaf6" : (hovered ? "#fafaf6" : "#fff"),
      borderRadius: 6,
      marginBottom: 2,
      boxShadow: expanded ? "inset 2px 0 0 0 var(--ink)" : "none",
      opacity: dimmed ? 0.45 : 1,
      cursor: "pointer",
      outline: highlight ? "2px solid var(--accent)" : "none",
      outlineOffset: highlight ? 1 : 0,
      position: "relative",
    }}>
      {ac
        ? <span className="mono" style={{ fontSize: 10, fontWeight: 600, color: status === "good" ? "var(--green)" : "var(--muted)", minWidth: 32 }}>{ac}</span>
        : <SpecKindPill kind={kind} />}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 6, position: "relative" }}>
          <span style={{
            fontSize: 13.5,
            fontWeight: 600,
            color: "var(--ink)",
            textDecoration: titleHovered ? "underline" : "none",
            textDecorationColor: "var(--accent)",
            textUnderlineOffset: 3,
          }}>{name}</span>
          {titleHovered && (
            <span title="Open this node's page" style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 16, height: 16,
              borderRadius: 3,
              background: "var(--accent-soft)",
              color: "var(--accent)",
              fontSize: 10,
              fontWeight: 700,
              lineHeight: 1,
            }}>↗</span>
          )}
        </div>
        {summary && <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2, lineHeight: 1.45, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{summary}</div>}
      </div>
      {tags && <div style={{ display: "flex", gap: 4 }}>{tags.map(t => <TagChip key={t}>{t}</TagChip>)}</div>}
      {count && <span className="mono" style={{ fontSize: 11, color: "var(--muted)", minWidth: 44, textAlign: "right" }}>{count.covered}/{count.total}</span>}
      {status && <CovDotU status={status} />}
    </div>
  );
}

// AC row when expanded — body renders given/when/then directly underneath
function URowExpandedAc({ id, summary, given, when, then, coverage }) {
  const c = coverage === "covered" ? "var(--green)" : "var(--muted)";
  return (
    <div style={{
      border: "1px solid var(--line)",
      borderRadius: 6,
      marginBottom: 2,
      background: "#fbfaf6",
      boxShadow: "inset 2px 0 0 0 var(--ink)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px" }}>
        <span className="mono" style={{ fontSize: 10, fontWeight: 600, color: c, minWidth: 32 }}>{id}</span>
        <div style={{ flex: 1, fontSize: 13, color: "var(--ink)" }}>{summary}</div>
        <span className="mono" style={{ fontSize: 10, padding: "1px 6px", background: c === "var(--green)" ? "var(--green-soft)" : "var(--line-soft)", color: c, borderRadius: 2 }}>
          {coverage === "covered" ? "✓ Covered" : "— Not covered"}
        </span>
      </div>
      <div style={{ padding: "0 14px 12px", borderTop: "1px solid var(--line-soft)" }}>
        <div style={{ display: "grid", gridTemplateColumns: "60px 1fr", rowGap: 4, columnGap: 10, fontSize: 12.5, lineHeight: 1.5, paddingTop: 10 }}>
          <span className="mono" style={{ fontSize: 10, color: "var(--muted)", letterSpacing: "0.1em", paddingTop: 2 }}>GIVEN</span>
          <span style={{ color: "#2a2a2a" }}>{given}</span>
          <span className="mono" style={{ fontSize: 10, color: "var(--muted)", letterSpacing: "0.1em", paddingTop: 2 }}>WHEN</span>
          <span style={{ color: "#2a2a2a" }}>{when}</span>
          <span className="mono" style={{ fontSize: 10, color: "var(--muted)", letterSpacing: "0.1em", paddingTop: 2 }}>THEN</span>
          <span style={{ color: "#2a2a2a" }}>{then}</span>
        </div>
      </div>
    </div>
  );
}

function UChildGroup({ children }) {
  return (
    <div style={{ marginLeft: 2, paddingLeft: 18, borderLeft: "1px solid var(--line)", marginTop: 0, marginBottom: 2 }}>
      {children}
    </div>
  );
}

function CovDotU({ status }) {
  const c = status === "good" ? "var(--green)" : status === "partial" ? "#c9962f" : "var(--red)";
  return <span style={{ width: 8, height: 8, borderRadius: 4, background: c, flexShrink: 0 }} />;
}

function UFrame({ children, crumbs }) {
  return (
    <div className="ui" style={{ width: 1240, height: 820, background: "var(--paper)", display: "grid", gridTemplateColumns: "272px 1fr", border: "1px solid var(--line)" }}>
      <SidebarV3 activePath="specs" />
      <div style={{ display: "flex", flexDirection: "column", overflow: "hidden", background: "#fff" }}>
        {crumbs && <Breadcrumb crumbs={crumbs} />}
        <div style={{ flex: 1, overflow: "auto", padding: "26px 60px 80px" }}>{children}</div>
      </div>
    </div>
  );
}

// Page header used for any node's page — same shape regardless of node kind
function NodePageHeader({ kind, title, subtitle, coverage, tags, traits }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <SpecKindPill kind={kind} />
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, letterSpacing: "-0.02em" }}>{title}</h1>
        {tags && <div style={{ display: "flex", gap: 4 }}>{tags.map(t => <TagChip key={t}>{t}</TagChip>)}</div>}
        <div style={{ flex: 1 }} />
        {coverage && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <CovBarU covered={coverage.covered} total={coverage.total} />
            <span className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>{coverage.covered}/{coverage.total} covered</span>
          </div>
        )}
      </div>
      {subtitle && <p style={{ fontSize: 13.5, lineHeight: 1.55, color: "#3a3a36", margin: 0, maxWidth: 760 }}>{subtitle}</p>}
      {traits && <div style={{ marginTop: 10, display: "flex", gap: 6 }}>{traits.map(t => <TraitChip key={t}>{t}</TraitChip>)}</div>}
    </div>
  );
}

function CovBarU({ covered, total }) {
  const pct = total === 0 ? 0 : (covered / total) * 100;
  return (
    <div style={{ width: 120, height: 6, background: "var(--line-soft)", borderRadius: 3, overflow: "hidden" }}>
      <div style={{ width: `${pct}%`, height: "100%", background: pct > 70 ? "var(--green)" : pct > 30 ? "#c9962f" : "var(--red)" }} />
    </div>
  );
}

function USectionLabel({ children }) {
  return <div className="mono" style={{ fontSize: 10, color: "var(--muted)", letterSpacing: "0.18em", margin: "20px 0 6px" }}>{children}</div>;
}

// === STATE 1 · TREE w/ HOVER =====================================
function SpecUnified_Hover() {
  return (
    <UFrame>
      <h1 style={{ margin: 0, fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em" }}>Specs</h1>
      <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 4, marginBottom: 14 }}>4 modules · 41 features · 89 requirements · 312 acceptance criteria</div>
      <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 10, fontStyle: "italic" }}>Click anywhere on the row → expand inline. Hover the <em>title</em> specifically → reveals a <span style={{ fontStyle: "normal", display: "inline-flex", alignItems: "center", gap: 4 }}><span className="mono" style={{ padding: "0 4px", background: "var(--accent-soft)", color: "var(--accent)", borderRadius: 2, fontSize: 10, fontWeight: 700 }}>↗</span> open-page icon</span>; clicking the title (or its icon) navigates to that node's full page.</div>
      <URow kind="module" name="CLI Interface" summary="Command surface for the local developer workflow." count={{ covered: 64, total: 78 }} status="good" />
      <URow kind="module" name="Meta-Spec System" summary="Self-referential spec scaffold." count={{ covered: 22, total: 31 }} status="partial" />
      <URow kind="module" name="Shadow Branch" summary="Hidden mirror branch for AI-driven edits." count={{ covered: 18, total: 24 }} status="good" titleHovered />
      <URow kind="module" name="Web UI System" summary="Dashboard, daemon, REST/WS API, agent and session views." tags={["web", "ui"]} count={{ covered: 41, total: 179 }} status="partial" expanded />
      <UChildGroup>
        <URow kind="feature" name="Daemon Server Mode" summary="Long-running daemon process; entity cache, dispatches agents." tags={["server"]} count={{ covered: 12, total: 38 }} status="partial" />
        <URow kind="feature" name="REST and WebSocket API Contract" summary="Public API contract for the dashboard." tags={["api"]} count={{ covered: 8, total: 22 }} status="partial" />
        <URow kind="feature" name="Web Dashboard" summary="Svelte SPA — sidebar nav, project views, planning workspace." tags={["svelte"]} count={{ covered: 11, total: 64 }} status="partial" />
        <URow kind="feature" name="GitHub Pages Export" summary="Static export of dashboard." count={{ covered: 3, total: 9 }} status="partial" />
        <URow kind="feature" name="CLI Serve Commands" summary="`kspec serve` and `kspec daemon` entry points." count={{ covered: 4, total: 7 }} status="good" />
      </UChildGroup>
    </UFrame>
  );
}

// === STATE 2 · MODULE PAGE ======================================
function SpecUnified_ModulePage() {
  return (
    <UFrame crumbs={[
      { kind: "root", name: "Specs" },
      { kind: "module", name: "Web UI System" },
    ]}>
      <NodePageHeader kind="module" title="Web UI System"
        subtitle="The web-facing surface of kspec — daemon server, REST/WebSocket API, Svelte dashboard, agent and session views, validation visualizations."
        coverage={{ covered: 41, total: 179 }} tags={["web", "ui"]} />
      <USectionLabel>FEATURES · 6</USectionLabel>
      <URow kind="feature" name="Daemon Server Mode" summary="Long-running daemon process; entity cache, dispatches agents, streams events." tags={["server", "websocket"]} count={{ covered: 12, total: 38 }} status="partial" />
      <URow kind="feature" name="REST and WebSocket API Contract" summary="Public API contract for the dashboard." tags={["api"]} count={{ covered: 8, total: 22 }} status="partial" />
      <URow kind="feature" name="Web Dashboard" summary="Svelte SPA — sidebar nav, project views, planning workspace, spec/task/session surfaces." tags={["svelte", "ui"]} count={{ covered: 11, total: 64 }} status="partial" />
      <URow kind="feature" name="GitHub Pages Export" summary="Static export of dashboard for read-only public hosting." count={{ covered: 3, total: 9 }} status="partial" />
      <URow kind="feature" name="CLI Serve Commands" summary="`kspec serve` and `kspec daemon` entry points." count={{ covered: 4, total: 7 }} status="good" />
      <URow kind="feature" name="Multi-Directory Daemon Architecture" summary="One daemon process can manage multiple project roots." count={{ covered: 3, total: 12 }} status="partial" />
      <USectionLabel>CONSTRAINTS · 2</USectionLabel>
      <URow kind="constraint" name="No-build asset pipeline for npm distribution" summary="Static assets pre-built and committed; no build step on consumer install." />
      <URow kind="constraint" name="WS reconnect tolerant" summary="Frontend recovers gracefully from daemon restart." />
      <USectionLabel>LINKED WORK · 8 tasks · 14 sessions · 3 plans</USectionLabel>
      <div style={{ fontSize: 12, color: "var(--muted)", padding: "8px 12px", border: "1px dashed var(--line)", borderRadius: 4 }}>
        Linked work strip — same component as on requirement / AC pages.
      </div>
    </UFrame>
  );
}

// === STATE 3 · FEATURE PAGE — w/ one sub-feature expanded inline =
function SpecUnified_FeaturePage() {
  return (
    <UFrame crumbs={[
      { kind: "root", name: "Specs" },
      { kind: "module", name: "Web UI System" },
      { kind: "feature", name: "Web Dashboard" },
    ]}>
      <NodePageHeader kind="feature" title="Web Dashboard"
        subtitle="Svelte SPA — sidebar nav, project views, planning workspace, spec/task/session/inbox/validate surfaces."
        coverage={{ covered: 11, total: 64 }} tags={["svelte", "ui"]} />
      <USectionLabel>SUB-FEATURES · 10</USectionLabel>
      <URow kind="feature" name="Markdown Adoption Across UI Surfaces" summary="Plan / spec / task / observation bodies all render as proper markdown." count={{ covered: 1, total: 4 }} status="partial" />
      <URow kind="feature" name="App Shell and Navigation" summary="Top-level sidebar, project picker, route-aware breadcrumbs." count={{ covered: 0, total: 7 }} status="bad" />
      <URow kind="feature" name="Task Board (Kanban)" summary="Backlog → Ready → In progress → Review → Done columns; drag to move." count={{ covered: 2, total: 8 }} status="partial" />
      <URow kind="feature" name="Session Stream View" summary="Transcript viewer for live and recent agent sessions." count={{ covered: 0, total: 6 }} status="bad" />
      <URow kind="feature" name="Agent and Dispatch View" summary="Agent registry, dispatch settings, run history per agent." count={{ covered: 1, total: 5 }} status="partial" />

      <URow kind="feature" name="Plans View" summary="Plans-list and plan-detail surface; markdown body, embedded spec/task cards." count={{ covered: 1, total: 9 }} status="bad" expanded />
      <UChildGroup>
        <URow kind="requirement" name="Plan Content Embedded Views" summary="YAML blocks under ## Specs / ## Tasks render as embedded cards with derived item state." count={{ covered: 1, total: 9 }} status="partial" highlight />
        <URow kind="requirement" name="Plan Markdown Section Conventions" summary="Plans must have ## Specs and ## Tasks headings to be considered structured." count={{ covered: 0, total: 3 }} status="bad" />
      </UChildGroup>

      <URow kind="feature" name="Validation and Alignment View" summary="Visual diff of spec vs. coverage; uncovered AC surfacing." count={{ covered: 0, total: 5 }} status="bad" />
      <URow kind="feature" name="Dashboard Overview" summary="Project landing — recent activity, blockers, quick actions." count={{ covered: 0, total: 4 }} status="bad" />
      <URow kind="feature" name="Workflows View" summary="Workflow runs and history." count={{ covered: 0, total: 4 }} status="bad" />

      <USectionLabel>REQUIREMENTS · 3 cross-cutting</USectionLabel>
      <URow kind="requirement" name="Consistent Reference Display" summary="Spec/task/plan refs render the same chip everywhere." count={{ covered: 1, total: 2 }} status="partial" />
      <URow kind="requirement" name="ANSI Terminal Output Rendering" summary="Terminal-color sequences render with proper styling." count={{ covered: 1, total: 1 }} status="good" />
      <URow kind="requirement" name="UI Data Freshness and Caching" summary="Cached counts invalidate on WS events; no polling." count={{ covered: 0, total: 4 }} status="bad" />
    </UFrame>
  );
}

// === STATE 4 · REQUIREMENT PAGE — ACs as expandable children =====
function SpecUnified_RequirementPage() {
  return (
    <UFrame crumbs={[
      { kind: "root", name: "Specs" },
      { kind: "module", name: "Web UI System" },
      { kind: "feature", name: "Web Dashboard" },
      { kind: "feature", name: "Plans View" },
      { kind: "requirement", name: "Plan Content Embedded Views" },
    ]}>
      <NodePageHeader kind="requirement" title="Plan Content Embedded Views"
        subtitle="When viewing plan content in the UI, YAML code blocks containing spec and task definitions are detected and replaced with rich embedded cards that show the derived items' current state. Each embedded card links to the source spec or task. Non-YAML markdown content renders normally."
        coverage={{ covered: 1, total: 9 }} tags={["plans", "markdown"]}
        traits={["@trait-markdown-rendering"]} />
      <USectionLabel>ACCEPTANCE CRITERIA · 9 · 1 covered</USectionLabel>
      <URowExpandedAc id="AC-1" coverage="covered"
        summary="YAML under ## Specs renders as embedded spec cards"
        given="a plan's content contains a yaml code block under a ## Specs heading with spec definitions that match derived_specs references"
        when="the plan content is rendered"
        then="the YAML block is replaced with embedded spec cards showing each spec's title, type, status/maturity, trait list, and acceptance criteria count" />
      <URow ac="AC-2" name="YAML under ## Tasks renders as embedded task cards" summary="a plan's content contains a yaml code block under a ## Tasks heading" status="bad" />
      <URow ac="AC-3" name="Embedded card click navigates to source" summary="an embedded spec or task card is displayed" status="bad" />
      <URow ac="AC-4" name="Unparseable YAML falls back to code block" summary="content YAML block cannot be parsed or slugs do not match derived references" status="bad" />
      <URow ac="AC-5" name="Loading skeleton during batch fetch" summary="the batch item fetch for embedded cards is loading" status="bad" />
      <URow ac="AC-6" name="Error state when batch fetch fails" summary="the batch item fetch for embedded cards fails" status="bad" />
      <URow ac="AC-7" name="Expanded embedded card shows AC count" summary="an embedded spec card is expanded or shown in detail" status="bad" />
      <URow ac="AC-8" name="Non-YAML markdown renders normally" summary="the plan content contains non-YAML markdown sections" status="bad" />
      <URow ac="AC-9" name="derive_from_specs flag mixes with task list" summary="a plan's content contains a ## Tasks section where derive_from_specs: true appears alongside an adjacent yaml task list" status="bad" />
      <LinkedWorkOpen />
    </UFrame>
  );
}

// === STATE 5 · AC PAGE — leaf-of-leaves ==========================
function SpecUnified_AcPage() {
  return (
    <UFrame crumbs={[
      { kind: "root", name: "Specs" },
      { kind: "module", name: "Web UI System" },
      { kind: "feature", name: "Web Dashboard" },
      { kind: "feature", name: "Plans View" },
      { kind: "requirement", name: "Plan Content Embedded Views" },
      { kind: "requirement", name: "AC-1" },
    ]}>
      <div style={{ marginBottom: 18 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <span className="mono" style={{ fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 3, background: "var(--green-soft)", color: "var(--green)" }}>AC-1</span>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em" }}>YAML under ## Specs renders as embedded spec cards</h1>
          <div style={{ flex: 1 }} />
          <span className="mono" style={{ fontSize: 11, padding: "2px 8px", background: "var(--green-soft)", color: "var(--green)", borderRadius: 2 }}>✓ Covered</span>
        </div>
        <p style={{ fontSize: 13, color: "var(--muted)", margin: 0 }}>Acceptance criterion · child of Plan Content Embedded Views · last verified 2d ago by session 01KQ11ES4HFP</p>
      </div>
      <USectionLabel>SCENARIO</USectionLabel>
      <div style={{ border: "1px solid var(--line)", borderRadius: 6, padding: "14px 18px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "70px 1fr", rowGap: 10, columnGap: 14, fontSize: 13.5, lineHeight: 1.55 }}>
          <span className="mono" style={{ fontSize: 10, color: "var(--muted)", letterSpacing: "0.1em", paddingTop: 3 }}>GIVEN</span>
          <span style={{ color: "#2a2a2a" }}>a plan's content contains a yaml code block under a ## Specs heading with spec definitions that match derived_specs references</span>
          <span className="mono" style={{ fontSize: 10, color: "var(--muted)", letterSpacing: "0.1em", paddingTop: 3 }}>WHEN</span>
          <span style={{ color: "#2a2a2a" }}>the plan content is rendered</span>
          <span className="mono" style={{ fontSize: 10, color: "var(--muted)", letterSpacing: "0.1em", paddingTop: 3 }}>THEN</span>
          <span style={{ color: "#2a2a2a" }}>the YAML block is replaced with embedded spec cards showing each spec's title, type, status/maturity, trait list, and acceptance criteria count</span>
        </div>
      </div>
      <USectionLabel>COVERAGE EVIDENCE</USectionLabel>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <SmallRow icon="●" label="Session 01KQ11ES4HFP" detail="@codex-cloud · 4m 59s · validated AC-1 against fixture plan-iterative · 2d ago" />
        <SmallRow icon="✓" label="Task: Implement Plan Content Embedded Views" detail="completed · 4 sessions · 14 notes" />
      </div>
      <USectionLabel>SIBLINGS · 8 other ACs in this requirement</USectionLabel>
      <URow ac="AC-2" name="YAML under ## Tasks renders as embedded task cards" summary="a plan's content contains a yaml code block under a ## Tasks heading" status="bad" />
      <URow ac="AC-3" name="Embedded card click navigates to source" summary="an embedded spec or task card is displayed" status="bad" />
      <URow ac="AC-4" name="Unparseable YAML falls back to code block" summary="content YAML block cannot be parsed or slugs do not match derived references" status="bad" />
    </UFrame>
  );
}

Object.assign(window, {
  SpecUnified_Hover, SpecUnified_ModulePage, SpecUnified_FeaturePage,
  SpecUnified_RequirementPage, SpecUnified_AcPage,
});
