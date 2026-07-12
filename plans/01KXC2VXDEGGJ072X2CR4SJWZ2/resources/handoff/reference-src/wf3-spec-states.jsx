// Spec workspace — integration of six coverage states into the unified
// page+tree model (section 07).
//
// What changes vs. section 07:
//   - Coverage rollup is now a multi-segment bar (covered/failing/stale/
//     drifted/notyet/na), not a single covered/total ratio. The bar reads
//     at every level of the tree.
//   - AC rows use the StatePill from the legend so the visual treatment
//     matches everywhere.
//   - A new filter chip strip lets you narrow by state.
//   - The requirement page surfaces a "needs re-verification" summary at
//     the top when any AC is stale or drifted — this is the entry point
//     to the Validate view (section 12) for that one requirement.
//   - The AC page for a Stale AC shows the spec diff inline so the user
//     can decide: update the test, or accept the new annotation snapshot.
//
// Three artboards:
//   ① REQUIREMENT — Plan Content Embedded Views, all six states present.
//   ② TREE        — module/feature rollups now multi-segment; one branch
//                    open showing rollups all the way down.
//   ③ STALE AC    — focused page for AC-4 (stale) with the spec-diff and
//                    re-verification actions.

// === Shared frame (same as section 07) ===========================
function StatesFrame({ children, crumbs }) {
  return (
    <div className="ui" style={{ width: 1240, height: 820, background: "var(--paper)", display: "grid", gridTemplateColumns: "272px 1fr", border: "1px solid var(--line)" }}>
      <SidebarV3 activePath="specs" />
      <div style={{ display: "flex", flexDirection: "column", overflow: "hidden", background: "#fff" }}>
        {crumbs && <Breadcrumb crumbs={crumbs} />}
        <div style={{ flex: 1, overflow: "auto", padding: "24px 56px 80px" }}>{children}</div>
      </div>
    </div>
  );
}

// === Reusable row component, updated to take a coverage-state breakdown
// for non-leaf rows (modules/features/requirements). Leaves take a single state.
function StatesRow({ kind, name, summary, counts, total, state, tags, dim, expanded, highlight, ac, caption }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 12,
      padding: "10px 14px", border: "1px solid var(--line)",
      background: expanded ? "#fbfaf6" : "#fff",
      borderRadius: 6, marginBottom: 2,
      boxShadow: expanded ? "inset 2px 0 0 0 var(--ink)" : "none",
      opacity: dim || state === "na" ? 0.55 : 1,
      cursor: "pointer",
      outline: highlight ? "2px solid var(--accent)" : "none",
      outlineOffset: highlight ? 1 : 0,
      borderLeft: state ? `3px solid ${COV_STATES[state].dot}` : undefined,
    }}>
      {ac
        ? <span className="mono" style={{ fontSize: 10, fontWeight: 600, color: state ? COV_STATES[state].fg : "var(--muted)", minWidth: 36 }}>{ac}</span>
        : <SpecKindPill kind={kind} />}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink)", textDecoration: state === "na" ? "line-through" : "none", textDecorationColor: "var(--muted)" }}>{name}</div>
        {summary && <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2, lineHeight: 1.45, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{summary}</div>}
      </div>
      {tags && <div style={{ display: "flex", gap: 4 }}>{tags.map(t => <TagChip key={t}>{t}</TagChip>)}</div>}
      {caption && <span className="mono" style={{ fontSize: 10, color: "var(--muted)" }}>{caption}</span>}
      {counts && <CovStateBar counts={counts} total={total} width={160} />}
      {state && <StatePill state={state} />}
    </div>
  );
}

function StatesChildGroup({ children }) {
  return (
    <div style={{ marginLeft: 2, paddingLeft: 18, borderLeft: "1px solid var(--line)", marginTop: 0, marginBottom: 2 }}>
      {children}
    </div>
  );
}

function StatesFilterStrip({ active = "all" }) {
  const chips = [
    { k: "all", label: "all", count: 12 },
    { k: "covered", label: "covered", count: 3 },
    { k: "failing", label: "failing", count: 1 },
    { k: "stale", label: "stale", count: 2 },
    { k: "drifted", label: "drifted", count: 1 },
    { k: "notyet", label: "not yet", count: 4 },
    { k: "na", label: "n/a", count: 1 },
  ];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
      <span className="mono" style={{ fontSize: 10, color: "var(--muted)", letterSpacing: "0.18em", marginRight: 4 }}>FILTER</span>
      {chips.map(c => {
        const isActive = c.k === active;
        const s = COV_STATES[c.k];
        return (
          <span key={c.k} className="mono" style={{
            display: "inline-flex", alignItems: "center", gap: 5,
            fontSize: 11, padding: "3px 9px", borderRadius: 3,
            border: `1px solid ${isActive ? "var(--ink)" : "var(--line)"}`,
            background: isActive ? "var(--ink)" : "transparent",
            color: isActive ? "#fff" : (s ? s.fg : "var(--muted)"),
            cursor: "pointer",
          }}>
            {s && c.k !== "all" && <span style={{ width: 6, height: 6, borderRadius: 3, background: isActive ? "#fff" : s.dot }} />}
            {c.label}
            <span style={{ opacity: 0.6 }}>{c.count}</span>
          </span>
        );
      })}
      <div style={{ flex: 1 }} />
      <span className="mono" style={{ fontSize: 11, color: "var(--accent)", display: "inline-flex", alignItems: "center", gap: 5 }}>
        ⟳ 3 need re-verification
        <span style={{ fontSize: 10, opacity: 0.7 }}>→ validate</span>
      </span>
    </div>
  );
}

// === ARTBOARD 1 · REQUIREMENT PAGE (six states present) ==========
function SpecStates_RequirementPage() {
  return (
    <StatesFrame crumbs={[
      { kind: "root", name: "Specs" },
      { kind: "module", name: "Web UI System" },
      { kind: "feature", name: "Web Dashboard" },
      { kind: "feature", name: "Plans View" },
      { kind: "requirement", name: "Plan Content Embedded Views" },
    ]}>
      <div style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <SpecKindPill kind="requirement" />
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em" }}>Plan Content Embedded Views</h1>
          <div style={{ display: "flex", gap: 4 }}><TagChip>plans</TagChip><TagChip>markdown</TagChip></div>
          <div style={{ flex: 1 }} />
          <CovStateBar counts={{ covered: 3, failing: 1, notyet: 4, na: 1, stale: 2, drifted: 1 }} total={12} width={180} />
        </div>
        <p style={{ fontSize: 13, lineHeight: 1.55, color: "#3a3a36", margin: 0, maxWidth: 760 }}>When viewing plan content in the UI, YAML code blocks containing spec and task definitions are detected and replaced with rich embedded cards that show the derived items' current state.</p>
      </div>

      {/* Re-verification banner — only appears when stale/drifted > 0 */}
      <div style={{
        display: "flex", alignItems: "center", gap: 12,
        padding: "10px 14px",
        background: "#fdfaf5", border: "1px solid var(--accent-soft)",
        borderRadius: 6, marginBottom: 14,
      }}>
        <span style={{ fontSize: 18, color: "var(--accent)", fontFamily: "'JetBrains Mono', monospace" }}>⟳</span>
        <div style={{ flex: 1, fontSize: 12.5, color: "#2a2a2a", lineHeight: 1.5 }}>
          <strong>3 ACs need re-verification.</strong> 2 stale (spec edited after the test was annotated) · 1 drifted (covering code edited after the test was annotated).
        </div>
        <span className="mono" style={{ fontSize: 11, padding: "4px 10px", border: "1px solid var(--accent)", color: "var(--accent)", borderRadius: 3, cursor: "pointer" }}>review in Validate →</span>
      </div>

      <StatesFilterStrip active="all" />

      <div className="mono" style={{ fontSize: 10, color: "var(--muted)", letterSpacing: "0.18em", margin: "8px 0 6px" }}>ACCEPTANCE CRITERIA · 12</div>
      <AcStateRow id="AC-1"  state="covered" name="YAML under ## Specs renders as embedded spec cards" />
      <AcStateRow id="AC-2"  state="covered" name="YAML under ## Tasks renders as embedded task cards" />
      <AcStateRow id="AC-3"  state="failing" name="Embedded card click navigates to source" caption="2 of 3 tests fail" />
      <AcStateRow id="AC-4"  state="stale"   name="Unparseable YAML falls back to code block" caption="spec edited 3d ago" />
      <AcStateRow id="AC-9"  state="stale"   name="derive_from_specs flag mixes with task list" caption="spec edited 1d ago" />
      <AcStateRow id="AC-6"  state="drifted" name="Error state when batch fetch fails" caption="code edited 5d ago" />
      <AcStateRow id="AC-7"  state="covered" name="Expanded embedded card shows AC count" />
      <AcStateRow id="AC-5"  state="notyet"  name="Loading skeleton during batch fetch" />
      <AcStateRow id="AC-8"  state="notyet"  name="Non-YAML markdown renders normally" />
      <AcStateRow id="AC-10" state="notyet"  name="Embedded card respects dark mode tokens" />
      <AcStateRow id="AC-11" state="notyet"  name="Empty ## Specs block renders nothing" />
      <AcStateRow id="AC-12" state="na"      name="ARIA live-region for batch fetch — trait does not apply (read-only view)" />
    </StatesFrame>
  );
}

// === ARTBOARD 2 · TREE w/ MULTI-SEGMENT ROLLUPS ==================
function SpecStates_TreeRollups() {
  return (
    <StatesFrame>
      <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, letterSpacing: "-0.02em" }}>Specs</h1>
      <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 4, marginBottom: 6 }}>4 modules · 41 features · 89 requirements · 312 acceptance criteria</div>

      {/* Project-level rollup */}
      <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 14px", background: "#fbfaf6", border: "1px solid var(--line)", borderRadius: 6, marginBottom: 18, marginTop: 14 }}>
        <span className="mono" style={{ fontSize: 10, color: "var(--muted)", letterSpacing: "0.18em" }}>WHOLE PROJECT</span>
        <CovStateBar counts={{ covered: 145, failing: 12, stale: 28, drifted: 9, notyet: 109, na: 9 }} total={312} width={260} />
        <div style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 11, color: "var(--accent)" }}>⟳ 37 need re-verification</span>
      </div>

      <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 10, fontStyle: "italic" }}>
        Each row's coverage bar is the rollup of every AC underneath it. Ambers (stale + drifted) read distinctly from greys (not yet) so &quot;needs work&quot; and &quot;not started&quot; are never confused.
      </div>

      <StatesRow kind="module" name="CLI Interface" summary="Command surface for the local developer workflow."
        counts={{ covered: 64, failing: 2, notyet: 8, stale: 3, drifted: 1, na: 0 }} total={78} />

      <StatesRow kind="module" name="Meta-Spec System" summary="Self-referential spec scaffold."
        counts={{ covered: 22, failing: 0, notyet: 7, stale: 1, drifted: 1, na: 0 }} total={31} />

      <StatesRow kind="module" name="Shadow Branch" summary="Hidden mirror branch for AI-driven edits."
        counts={{ covered: 18, failing: 0, notyet: 4, stale: 0, drifted: 2, na: 0 }} total={24} />

      <StatesRow kind="module" name="Web UI System" summary="Dashboard, daemon, REST/WS API, agent + session views."
        counts={{ covered: 41, failing: 10, notyet: 90, stale: 24, drifted: 5, na: 9 }} total={179}
        tags={["web", "ui"]} expanded />
      <StatesChildGroup>
        <StatesRow kind="feature" name="Daemon Server Mode" summary="Long-running daemon process; entity cache."
          counts={{ covered: 12, failing: 4, notyet: 18, stale: 3, drifted: 1, na: 0 }} total={38} />
        <StatesRow kind="feature" name="REST and WebSocket API Contract"
          counts={{ covered: 8, failing: 2, notyet: 10, stale: 1, drifted: 1, na: 0 }} total={22} />
        <StatesRow kind="feature" name="Web Dashboard" summary="Svelte SPA — sidebar nav, project views, planning workspace."
          counts={{ covered: 11, failing: 4, notyet: 30, stale: 14, drifted: 2, na: 3 }} total={64} expanded />
        <StatesChildGroup>
          <StatesRow kind="feature" name="Plans View" summary="Plans-list and plan-detail surface."
            counts={{ covered: 1, failing: 0, notyet: 5, stale: 2, drifted: 1, na: 0 }} total={9} expanded />
          <StatesChildGroup>
            <StatesRow kind="requirement" name="Plan Content Embedded Views" summary="YAML blocks render as embedded cards."
              counts={{ covered: 3, failing: 1, notyet: 4, stale: 2, drifted: 1, na: 1 }} total={12} highlight />
            <StatesRow kind="requirement" name="Plan Markdown Section Conventions" summary="Plans must have ## Specs and ## Tasks headings."
              counts={{ covered: 0, failing: 0, notyet: 3, stale: 0, drifted: 0, na: 0 }} total={3} />
          </StatesChildGroup>
          <StatesRow kind="feature" name="Task Board (Kanban)" summary="Backlog → Ready → In progress → Review → Done."
            counts={{ covered: 2, failing: 0, notyet: 4, stale: 1, drifted: 1, na: 0 }} total={8} />
          <StatesRow kind="feature" name="Session Stream View" summary="Transcript viewer for live and recent sessions."
            counts={{ covered: 0, failing: 0, notyet: 6, stale: 0, drifted: 0, na: 0 }} total={6} />
        </StatesChildGroup>
      </StatesChildGroup>
    </StatesFrame>
  );
}

// === ARTBOARD 3 · STALE AC PAGE w/ SPEC DIFF =====================
function SpecStates_StaleAcPage() {
  return (
    <StatesFrame crumbs={[
      { kind: "root", name: "Specs" },
      { kind: "module", name: "Web UI System" },
      { kind: "feature", name: "Web Dashboard" },
      { kind: "feature", name: "Plans View" },
      { kind: "requirement", name: "Plan Content Embedded Views" },
      { kind: "requirement", name: "AC-4" },
    ]}>
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <span className="mono" style={{ fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 3, background: "var(--accent-soft)", color: "var(--accent)" }}>AC-4</span>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em" }}>Unparseable YAML falls back to code block</h1>
          <div style={{ flex: 1 }} />
          <StatePill state="stale" />
        </div>
        <p style={{ fontSize: 12.5, color: "var(--muted)", margin: 0 }}>Acceptance criterion · child of Plan Content Embedded Views</p>
      </div>

      {/* Why stale */}
      <div style={{
        display: "flex", alignItems: "center", gap: 12,
        padding: "10px 14px", background: "#fdfaf5",
        border: "1px solid var(--accent-soft)", borderRadius: 6, marginBottom: 16,
      }}>
        <span style={{ fontSize: 16, color: "var(--accent)", fontFamily: "'JetBrains Mono', monospace" }}>⟳</span>
        <div style={{ flex: 1, fontSize: 12.5, color: "#2a2a2a", lineHeight: 1.5 }}>
          Spec text was edited <strong>3 days ago</strong> by <span className="mono">@kreed</span>. The annotated test (<code>test_unparseable_yaml_fallback</code>) was written against the previous wording on 13d ago. The test still passes — but it may not be testing what the AC now claims.
        </div>
      </div>

      <div className="mono" style={{ fontSize: 10, color: "var(--muted)", letterSpacing: "0.18em", margin: "0 0 6px" }}>SPEC DIFF · WHAT THE AC USED TO SAY vs NOW</div>
      <div style={{ border: "1px solid var(--line)", borderRadius: 6, overflow: "hidden", marginBottom: 18 }}>
        <DiffBlock label="GIVEN" was="content YAML block cannot be parsed" now="content YAML block cannot be parsed or slugs do not match derived references" />
        <DiffBlock label="WHEN"  was="the plan content is rendered" now="the plan content is rendered" same />
        <DiffBlock label="THEN"  was="the block renders as a normal code block with a warning icon" now="the block renders as a normal code block with a warning icon and a link to spec docs" />
      </div>

      <div className="mono" style={{ fontSize: 10, color: "var(--muted)", letterSpacing: "0.18em", margin: "0 0 6px" }}>ANNOTATED TEST</div>
      <div style={{ background: "#fff", border: "1px solid var(--line)", borderRadius: 6, padding: "10px 14px", marginBottom: 18 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12.5 }}>
          <code style={{ fontFamily: "'JetBrains Mono', monospace", color: "#2a2a2a" }}>web/src/lib/plans/embedded.test.ts:142</code>
          <span className="mono" style={{ fontSize: 10, padding: "1px 6px", background: "var(--green-soft)", color: "var(--green)", borderRadius: 2 }}>passing</span>
          <span className="mono" style={{ fontSize: 10, color: "var(--muted)" }}>last run 4h ago · 28ms</span>
          <div style={{ flex: 1 }} />
          <code style={{ fontSize: 11, color: "var(--muted)" }}>// @spec ac-4</code>
        </div>
      </div>

      <div className="mono" style={{ fontSize: 10, color: "var(--muted)", letterSpacing: "0.18em", margin: "0 0 6px" }}>RESOLVE</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
        <ResolveCard primary title="Update the test"
          body="Confirm test exercises new behavior (slug-mismatch path + warning-link). Re-annotate; freshness clock resets."
          cta="Dispatch task → @bash-coder" />
        <ResolveCard title="Mark verified as-is"
          body="If you've manually reviewed and the test still represents the spec's intent, stamp the annotation as re-verified at this commit."
          cta="✓ Accept current snapshot" />
        <ResolveCard title="Roll back the spec"
          body="If the spec edit wasn't intentional, revert it. The annotation goes back to fresh automatically."
          cta="↶ Revert spec edit" />
      </div>
    </StatesFrame>
  );
}

function DiffBlock({ label, was, now, same }) {
  return (
    <div style={{ borderBottom: "1px solid var(--line-soft)" }}>
      <div style={{ display: "grid", gridTemplateColumns: "70px 1fr", borderBottom: "1px dashed var(--line-soft)", background: same ? "#fafaf6" : "#fdf4ee" }}>
        <div className="mono" style={{ padding: "8px 12px", fontSize: 10, color: "var(--muted)", letterSpacing: "0.1em", borderRight: "1px solid var(--line-soft)" }}>
          {label} <span style={{ display: "block", fontSize: 9, color: same ? "var(--muted)" : "var(--accent)" }}>{same ? "unchanged" : "was"}</span>
        </div>
        <div style={{ padding: "8px 14px", fontSize: 12.5, lineHeight: 1.5, color: same ? "var(--muted)" : "#2a2a2a", textDecoration: same ? "none" : "line-through", textDecorationColor: "var(--accent)" }}>{was}</div>
      </div>
      {!same && (
        <div style={{ display: "grid", gridTemplateColumns: "70px 1fr", background: "#f4faf3" }}>
          <div className="mono" style={{ padding: "8px 12px", fontSize: 10, color: "var(--muted)", letterSpacing: "0.1em", borderRight: "1px solid var(--line-soft)" }}>
            <span style={{ display: "block", fontSize: 9, color: "var(--green)" }}>now</span>
          </div>
          <div style={{ padding: "8px 14px", fontSize: 12.5, lineHeight: 1.5, color: "#2a2a2a" }}>{now}</div>
        </div>
      )}
    </div>
  );
}

function ResolveCard({ title, body, cta, primary }) {
  return (
    <div style={{ padding: "12px 14px", border: `1px solid ${primary ? "var(--ink)" : "var(--line)"}`, borderRadius: 6, background: "#fff", display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontSize: 13, fontWeight: 600 }}>{title}</div>
      <div style={{ fontSize: 12, color: "#3a3a36", lineHeight: 1.5, flex: 1 }}>{body}</div>
      <span className="mono" style={{ fontSize: 11, padding: "5px 10px", textAlign: "center", borderRadius: 3, background: primary ? "var(--ink)" : "transparent", border: `1px solid ${primary ? "var(--ink)" : "var(--line)"}`, color: primary ? "#fff" : "var(--ink)", cursor: "pointer" }}>{cta}</span>
    </div>
  );
}

Object.assign(window, {
  SpecStates_RequirementPage, SpecStates_TreeRollups, SpecStates_StaleAcPage,
});
