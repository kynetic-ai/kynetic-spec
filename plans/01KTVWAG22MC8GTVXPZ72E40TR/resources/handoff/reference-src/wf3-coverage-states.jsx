// Coverage state semantics — visual breakout.
//
// Six per-AC states the system must distinguish. Stale + Drifted are the new
// (and trickier) ones — they require comparing timestamps between spec text
// edits, code edits, and the most recent test-annotation edit.
//
// Three artboards:
//   ① LEGEND        — six state cards, each shows pill, glyph, definition,
//                      signal that produces it, and a sample AC row.
//   ② TRUTH TABLE   — decision tree for: given (annotation?, test result?,
//                      spec edited since?, code edited since?) → which state.
//   ③ SAMPLE LIST   — twelve ACs in mixed states so the visual hierarchy
//                      reads at a glance.
//   ④ ALT           — collapsed five-state model where Stale + Drifted merge
//                      into a single "Needs re-verification" — easier rollup
//                      and probably what we ship if the timestamp logic gets
//                      hairy.

// === Tokens =====================================================
// Centralized state visual treatment used here and re-exported for the
// spec-workspace and validate views to consume.
const COV_STATES = {
  covered: {
    label: "Covered", glyph: "●",
    fg: "var(--green)", bg: "var(--green-soft)", dot: "var(--green)",
    desc: "Has annotated test(s) and they pass.",
    signal: "annotated && pass",
  },
  failing: {
    label: "Failing", glyph: "✗",
    fg: "var(--red)", bg: "var(--red-soft)", dot: "var(--red)",
    desc: "Has annotated test(s) but the suite fails.",
    signal: "annotated && fail",
  },
  notyet: {
    label: "Not yet", glyph: "○",
    fg: "var(--muted)", bg: "var(--line-soft)", dot: "var(--muted)",
    desc: "AC is defined but no test annotation references it.",
    signal: "!annotated",
  },
  na: {
    label: "N/A", glyph: "⊘",
    fg: "#9c998f", bg: "transparent", dot: "#bcb9b0",
    desc: "Explicitly marked not-applicable (used for trait ACs that don't apply to this spec).",
    signal: "marked-na",
  },
  stale: {
    label: "Stale", glyph: "⟳",
    fg: "var(--accent)", bg: "var(--accent-soft)", dot: "var(--accent)",
    desc: "Test exists but the spec text has changed since the annotation was written.",
    signal: "annotated && spec.edited_at > test.annotated_at",
  },
  drifted: {
    label: "Drifted", glyph: "⤳",
    fg: "var(--accent)", bg: "var(--accent-soft)", dot: "var(--accent)",
    desc: "Test exists but the covering code has changed since the annotation was written.",
    signal: "annotated && code.edited_at > test.annotated_at",
  },
};

// Pill — small status chip used inline on AC rows.
function StatePill({ state, hideLabel }) {
  const s = COV_STATES[state];
  if (!s) return null;
  return (
    <span className="mono" style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      fontSize: 10, padding: "1px 7px", borderRadius: 2,
      background: s.bg, color: s.fg,
      whiteSpace: "nowrap",
      border: state === "na" ? "1px dashed var(--line)" : "none",
    }}>
      <span style={{ fontSize: 9 }}>{s.glyph}</span>
      {!hideLabel && s.label}
    </span>
  );
}

// Dot — smallest indicator (e.g. left of an AC id).
function StateDot({ state, size = 8 }) {
  const s = COV_STATES[state];
  return <span style={{ width: size, height: size, borderRadius: size / 2, background: s.dot, flexShrink: 0, display: "inline-block" }} />;
}

// Compact AC row that the legend uses for "looks like" examples and that
// the spec workspace + validate view reuse for the real lists.
function AcStateRow({ id, name, state, caption, dim, narrow }) {
  const s = COV_STATES[state];
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10,
      padding: "8px 12px", border: "1px solid var(--line)",
      borderRadius: 4, background: state === "stale" || state === "drifted" ? "#fdfaf5" : "#fff",
      borderLeft: `3px solid ${s.dot}`,
      opacity: state === "na" ? 0.55 : 1,
      marginBottom: 2,
    }}>
      <span className="mono" style={{ fontSize: 10, fontWeight: 600, color: s.fg, minWidth: narrow ? 28 : 36 }}>{id}</span>
      <span style={{ flex: 1, fontSize: 12.5, color: "var(--ink)", textDecoration: state === "na" ? "line-through" : "none", textDecorationColor: "var(--muted)" }}>{name}</span>
      {caption && <span className="mono" style={{ fontSize: 10, color: "var(--muted)" }}>{caption}</span>}
      <StatePill state={state} />
    </div>
  );
}

// === ARTBOARD 1 · LEGEND ========================================
function CoverageLegend() {
  const order = ["covered", "failing", "notyet", "na", "stale", "drifted"];
  return (
    <div className="ui" style={{ padding: 32, background: "var(--paper)", width: 1200, minHeight: 760 }}>
      <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em" }}>Coverage states</h2>
      <p style={{ margin: "6px 0 24px", fontSize: 13, color: "var(--muted)", maxWidth: 720, lineHeight: 1.5 }}>
        Every acceptance criterion lives in one of six states. The first four are clean — they fall out of the annotation+test result. Stale and Drifted require timestamp comparison and represent "the system worked, then something moved underneath it."
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14 }}>
        {order.map(k => <StateCard key={k} k={k} />)}
      </div>
      <div style={{ marginTop: 28, padding: 18, border: "1px dashed var(--line)", borderRadius: 6, background: "#fff" }}>
        <div className="mono" style={{ fontSize: 10, color: "var(--muted)", letterSpacing: "0.18em", marginBottom: 6 }}>OPEN QUESTIONS</div>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.7, color: "#2a2a2a" }}>
          <li>Stale and Drifted can both apply to the same AC. Show both pills, or pick the more recent and suppress the other?</li>
          <li>What counts as a relevant code edit? The whole annotated test file, or only lines inside the test body? (Probably: any edit inside the test function.)</li>
          <li>N/A — does it live in the spec source (e.g. <code>ac-3: na</code>) or as a separate ignore-list? Spec-source is more discoverable; ignore-list survives spec rewrites.</li>
          <li>If a Stale AC's tests still pass, is it "Covered (stale)" or just "Stale"? Currently: Stale overrides because the test was written against a different intent — passing is not meaningful.</li>
        </ul>
      </div>
    </div>
  );
}

function StateCard({ k }) {
  const s = COV_STATES[k];
  return (
    <div style={{
      background: "#fff", border: "1px solid var(--line)", borderRadius: 6,
      padding: "16px 18px", display: "flex", flexDirection: "column", gap: 10,
      borderTop: `3px solid ${s.dot}`,
    }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <span style={{ fontSize: 22, color: s.fg, lineHeight: 1, fontFamily: "'JetBrains Mono', monospace" }}>{s.glyph}</span>
        <span style={{ fontSize: 16, fontWeight: 700, letterSpacing: "-0.01em" }}>{s.label}</span>
        <div style={{ flex: 1 }} />
        <StatePill state={k} />
      </div>
      <div style={{ fontSize: 12.5, lineHeight: 1.5, color: "#2a2a2a", minHeight: 54 }}>{s.desc}</div>
      <div>
        <div className="mono" style={{ fontSize: 9, color: "var(--muted)", letterSpacing: "0.18em", marginBottom: 4 }}>SIGNAL</div>
        <code style={{ fontSize: 11, background: "#f6f4ee", padding: "2px 6px", borderRadius: 3, color: "#2a2a2a" }}>{s.signal}</code>
      </div>
      <div>
        <div className="mono" style={{ fontSize: 9, color: "var(--muted)", letterSpacing: "0.18em", marginBottom: 4 }}>EXAMPLE</div>
        <AcStateRow id={`AC-${k === "covered" ? 1 : k === "failing" ? 2 : k === "notyet" ? 3 : k === "na" ? 4 : k === "stale" ? 5 : 6}`}
          name={
            k === "covered" ? "YAML under ## Specs renders as embedded spec cards" :
            k === "failing" ? "Embedded card click navigates to source" :
            k === "notyet"  ? "Loading skeleton during batch fetch" :
            k === "na"      ? "Markdown-rendering trait — N/A for this server-only spec" :
            k === "stale"   ? "Unparseable YAML falls back to code block" :
                              "Error state when batch fetch fails"
          }
          state={k}
          caption={
            k === "failing" ? "1 of 2 tests fail" :
            k === "stale"   ? "spec edited 3d ago" :
            k === "drifted" ? "code edited 5d ago" : null
          }
        />
      </div>
    </div>
  );
}

// === ARTBOARD 2 · TRUTH TABLE ===================================
function CoverageTruthTable() {
  // Each row: annotation present, test result, spec edited since annotation,
  // code edited since annotation, marked-na — and the resulting state.
  const rows = [
    { na: "✗", ann: "✓", res: "pass", spec: "no",  code: "no",  state: "covered" },
    { na: "✗", ann: "✓", res: "fail", spec: "—",   code: "—",   state: "failing" },
    { na: "✗", ann: "✗", res: "—",    spec: "—",   code: "—",   state: "notyet" },
    { na: "✓", ann: "—", res: "—",    spec: "—",   code: "—",   state: "na" },
    { na: "✗", ann: "✓", res: "pass", spec: "yes", code: "no",  state: "stale" },
    { na: "✗", ann: "✓", res: "pass", spec: "no",  code: "yes", state: "drifted" },
    { na: "✗", ann: "✓", res: "pass", spec: "yes", code: "yes", state: "stale+drifted" },
    { na: "✗", ann: "✓", res: "fail", spec: "yes", code: "—",   state: "failing" },
  ];
  const headers = ["marked N/A", "annotated", "tests", "spec edited since", "code edited since", "→ state"];
  return (
    <div className="ui" style={{ padding: 32, background: "var(--paper)", width: 1080, minHeight: 720 }}>
      <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em" }}>Decision logic</h2>
      <p style={{ margin: "6px 0 22px", fontSize: 13, color: "var(--muted)", maxWidth: 700, lineHeight: 1.5 }}>
        N/A is evaluated first (explicit override beats everything). Failing dominates over staleness — if the test is red, fix that before worrying about whether the annotation is current. The bottom row is the awkward case worth deciding now.
      </p>
      <div style={{ background: "#fff", border: "1px solid var(--line)", borderRadius: 6, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1.4fr 1.4fr 1.6fr", background: "#f6f4ee", borderBottom: "1px solid var(--line)" }}>
          {headers.map(h => (
            <div key={h} className="mono" style={{ padding: "10px 14px", fontSize: 10, color: "var(--muted)", letterSpacing: "0.15em" }}>{h.toUpperCase()}</div>
          ))}
        </div>
        {rows.map((r, i) => (
          <div key={i} style={{
            display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1.4fr 1.4fr 1.6fr",
            borderBottom: i < rows.length - 1 ? "1px solid var(--line-soft)" : "none",
            background: r.state === "stale+drifted" ? "#fdfaf5" : "#fff",
          }}>
            <Cell>{r.na}</Cell>
            <Cell>{r.ann}</Cell>
            <Cell mono>{r.res}</Cell>
            <Cell mono>{r.spec}</Cell>
            <Cell mono>{r.code}</Cell>
            <Cell>
              {r.state === "stale+drifted"
                ? <span style={{ display: "inline-flex", gap: 4 }}><StatePill state="stale" /><StatePill state="drifted" /></span>
                : <StatePill state={r.state} />}
            </Cell>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 22, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <Note title="Stale" body={<span>The <em>spec text</em> changed after the test was annotated. The test still references the AC by id, but the AC's wording (and possibly intent) has moved. Re-read the test against the current spec.</span>} />
        <Note title="Drifted" body={<span>The <em>code under test</em> changed after the test was annotated. The spec hasn't moved, but the implementation has — the test may still pass against drift that no longer reflects the AC's claim.</span>} />
      </div>
    </div>
  );
}

function Cell({ children, mono }) {
  return <div className={mono ? "mono" : ""} style={{ padding: "10px 14px", fontSize: 12.5, display: "flex", alignItems: "center", color: "var(--ink)" }}>{children}</div>;
}
function Note({ title, body }) {
  return (
    <div style={{ padding: "12px 14px", background: "#fdfaf5", border: "1px solid var(--accent-soft)", borderRadius: 4 }}>
      <div className="mono" style={{ fontSize: 10, color: "var(--accent)", letterSpacing: "0.15em", marginBottom: 4 }}>{title.toUpperCase()}</div>
      <div style={{ fontSize: 12.5, lineHeight: 1.55, color: "#2a2a2a" }}>{body}</div>
    </div>
  );
}

// === ARTBOARD 3 · SAMPLE LIST ====================================
function CoverageSampleList() {
  return (
    <div className="ui" style={{ padding: 32, background: "var(--paper)", width: 1080, minHeight: 760 }}>
      <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em" }}>Mixed-state list</h2>
      <p style={{ margin: "6px 0 22px", fontSize: 13, color: "var(--muted)", maxWidth: 700, lineHeight: 1.5 }}>
        Twelve ACs from a single requirement, mid-development. The point is to read the row treatment at a glance: greens recede, reds + ambers pull the eye.
      </p>
      <div style={{ background: "#fff", border: "1px solid var(--line)", borderRadius: 6, padding: "16px 18px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, paddingBottom: 10, borderBottom: "1px solid var(--line-soft)" }}>
          <SpecKindPill kind="requirement" />
          <span style={{ fontWeight: 600, fontSize: 14 }}>Plan Content Embedded Views</span>
          <div style={{ flex: 1 }} />
          <CovStateBar counts={{ covered: 3, failing: 1, notyet: 4, na: 1, stale: 2, drifted: 1 }} total={12} />
        </div>
        <AcStateRow id="AC-1"  state="covered" name="YAML under ## Specs renders as embedded spec cards" />
        <AcStateRow id="AC-2"  state="covered" name="YAML under ## Tasks renders as embedded task cards" />
        <AcStateRow id="AC-3"  state="failing" name="Embedded card click navigates to source" caption="2 of 3 tests fail" />
        <AcStateRow id="AC-4"  state="stale"   name="Unparseable YAML falls back to code block" caption="spec edited 3d ago" />
        <AcStateRow id="AC-5"  state="notyet"  name="Loading skeleton during batch fetch" />
        <AcStateRow id="AC-6"  state="drifted" name="Error state when batch fetch fails" caption="code edited 5d ago" />
        <AcStateRow id="AC-7"  state="covered" name="Expanded embedded card shows AC count" />
        <AcStateRow id="AC-8"  state="notyet"  name="Non-YAML markdown renders normally" />
        <AcStateRow id="AC-9"  state="stale"   name="derive_from_specs flag mixes with task list" caption="spec edited 1d ago" />
        <AcStateRow id="AC-10" state="notyet"  name="Embedded card respects dark mode tokens" />
        <AcStateRow id="AC-11" state="notyet"  name="Empty ## Specs block renders nothing" />
        <AcStateRow id="AC-12" state="na"      name="ARIA live-region for batch fetch — trait does not apply (read-only view)" />
      </div>
      <div style={{ marginTop: 18, fontSize: 12, color: "var(--muted)", lineHeight: 1.6, maxWidth: 720 }}>
        Sort order tested above: covered → failing → stale → drifted → notyet → na. Failing reads loudest (red bar + red pill); ambers cluster for "needs re-verification"; greys at the bottom for "nothing to do yet."
      </div>
    </div>
  );
}

// Multi-segment coverage bar — used on requirement/feature/module rollups so
// the breakdown by state is visible without expanding.
function CovStateBar({ counts, total, width = 220 }) {
  const order = ["covered", "failing", "stale", "drifted", "notyet", "na"];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <div style={{ width, height: 8, display: "flex", borderRadius: 4, overflow: "hidden", background: "var(--line-soft)" }}>
        {order.map(k => {
          const n = counts[k] || 0;
          if (n === 0) return null;
          return <div key={k} title={`${COV_STATES[k].label}: ${n}`} style={{ width: `${(n / total) * 100}%`, background: COV_STATES[k].dot, opacity: k === "na" ? 0.5 : 1 }} />;
        })}
      </div>
      <span className="mono" style={{ fontSize: 11, color: "var(--muted)", whiteSpace: "nowrap" }}>{counts.covered}/{total - (counts.na || 0)} covered</span>
    </div>
  );
}

// === ARTBOARD 4 · ALTERNATIVE FIVE-STATE MODEL ==================
function CoverageFiveStateAlt() {
  return (
    <div className="ui" style={{ padding: 32, background: "var(--paper)", width: 1080, minHeight: 720 }}>
      <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em" }}>Alt · five-state model</h2>
      <p style={{ margin: "6px 0 24px", fontSize: 13, color: "var(--muted)", maxWidth: 720, lineHeight: 1.5 }}>
        Collapse Stale + Drifted into a single <em>Re-verify</em>. We lose the ability to point at <em>why</em> the AC needs review (was it the spec or the code?) but every rollup becomes much cleaner and there's no ambiguity when both flags fire.
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 22 }}>
        <div>
          <div className="mono" style={{ fontSize: 10, color: "var(--muted)", letterSpacing: "0.18em", marginBottom: 8 }}>FIVE STATES</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <StateRowSimple state="covered" />
            <StateRowSimple state="failing" />
            <StateRowSimple state="notyet" />
            <StateRowReverify />
            <StateRowSimple state="na" />
          </div>
          <div style={{ marginTop: 14, fontSize: 12.5, color: "#2a2a2a", lineHeight: 1.55 }}>
            <strong>Pro.</strong> Simpler rollup. One amber bucket means "your attention is needed here," regardless of cause. Easier to filter on in Validate.
          </div>
          <div style={{ marginTop: 6, fontSize: 12.5, color: "#2a2a2a", lineHeight: 1.55 }}>
            <strong>Con.</strong> When opening the AC you still need to surface why it's flagged. So we're just hiding the distinction from the list, not eliminating it.
          </div>
        </div>
        <div>
          <div className="mono" style={{ fontSize: 10, color: "var(--muted)", letterSpacing: "0.18em", marginBottom: 8 }}>SAME LIST — REROLLED</div>
          <div style={{ background: "#fff", border: "1px solid var(--line)", borderRadius: 6, padding: "12px 14px" }}>
            <AcStateRow id="AC-1"  state="covered" name="YAML under ## Specs renders as embedded spec cards" />
            <AcStateRow id="AC-3"  state="failing" name="Embedded card click navigates to source" caption="2 of 3 fail" />
            <ReverifyRow id="AC-4"  name="Unparseable YAML falls back to code block" cause="spec" />
            <ReverifyRow id="AC-6"  name="Error state when batch fetch fails" cause="code" />
            <ReverifyRow id="AC-9"  name="derive_from_specs flag mixes with task list" cause="spec" />
            <AcStateRow id="AC-5"  state="notyet"  name="Loading skeleton during batch fetch" />
            <AcStateRow id="AC-8"  state="notyet"  name="Non-YAML markdown renders normally" />
            <AcStateRow id="AC-12" state="na"      name="ARIA live-region for batch fetch" />
          </div>
          <div style={{ marginTop: 12, fontSize: 11.5, color: "var(--muted)", lineHeight: 1.5 }}>
            <strong>Recommendation:</strong> ship the five-state model in the UI; keep stale/drifted as a sub-classification surfaced on the AC's own page and as a filter facet. Get the simpler rollup without losing the information.
          </div>
        </div>
      </div>
    </div>
  );
}

function StateRowSimple({ state }) {
  const s = COV_STATES[state];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: "#fff", border: "1px solid var(--line)", borderRadius: 4 }}>
      <span style={{ fontSize: 16, color: s.fg, fontFamily: "'JetBrains Mono', monospace", width: 18, textAlign: "center" }}>{s.glyph}</span>
      <span style={{ fontWeight: 600, fontSize: 13 }}>{s.label}</span>
      <span style={{ flex: 1, fontSize: 12, color: "var(--muted)" }}>{s.desc}</span>
      <StatePill state={state} />
    </div>
  );
}
function StateRowReverify() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: "#fdfaf5", border: "1px solid var(--accent-soft)", borderRadius: 4 }}>
      <span style={{ fontSize: 16, color: "var(--accent)", fontFamily: "'JetBrains Mono', monospace", width: 18, textAlign: "center" }}>⟳</span>
      <span style={{ fontWeight: 600, fontSize: 13 }}>Re-verify</span>
      <span style={{ flex: 1, fontSize: 12, color: "var(--muted)" }}>Spec or code has changed since the test was annotated.</span>
      <span className="mono" style={{ fontSize: 10, padding: "1px 7px", background: "var(--accent-soft)", color: "var(--accent)", borderRadius: 2 }}>⟳ Re-verify</span>
    </div>
  );
}
function ReverifyRow({ id, name, cause }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10,
      padding: "8px 12px", border: "1px solid var(--line)",
      borderRadius: 4, background: "#fdfaf5",
      borderLeft: `3px solid var(--accent)`,
      marginBottom: 2,
    }}>
      <span className="mono" style={{ fontSize: 10, fontWeight: 600, color: "var(--accent)", minWidth: 36 }}>{id}</span>
      <span style={{ flex: 1, fontSize: 12.5, color: "var(--ink)" }}>{name}</span>
      <span className="mono" style={{ fontSize: 10, color: "var(--muted)" }}>{cause === "spec" ? "spec moved" : "code moved"}</span>
      <span className="mono" style={{ fontSize: 10, padding: "1px 7px", background: "var(--accent-soft)", color: "var(--accent)", borderRadius: 2 }}>⟳ Re-verify</span>
    </div>
  );
}

Object.assign(window, {
  COV_STATES, StatePill, StateDot, AcStateRow, CovStateBar,
  CoverageLegend, CoverageTruthTable, CoverageSampleList, CoverageFiveStateAlt,
});
