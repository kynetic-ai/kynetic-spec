// Reviews surfaces — round 3.
//
// A review (kspec_reviews) is a record of one review pass against a subject.
// The subject can be:
//   - plan (markdown plan body)        → handled by Planning view's reviews tab + inline threads
//   - task (a task with code changes)  → ReviewTaskCode (diff w/ line-anchored threads)
//   - code (raw base..head)            → ReviewCode (diff only, no task)
//   - spec (spec entity)               → ReviewSpec (body w/ AC-anchored threads)
//
// Common across all subjects: lifecycle (draft/open/closed), threads (kind + entries),
// verdicts (approve/request_changes), checks (vitest pass/fail, with evidence).
//
// This file exports:
//   ReviewsQueue           — landing page; flat list across all subjects
//   ReviewTaskCode         — task review (diff + threads)
//   ReviewCode             — raw code review (diff + threads, no task)
//   ReviewSpec             — spec review (AC-anchored)
//   ReviewHeader           — shared header (lifecycle, verdicts, checks)

// ============= REVIEWS QUEUE =========================================
function ReviewsQueue() {
  return (
    <div className="ui" style={{ width: 1240, height: 820, background: "var(--paper)",
        display: "grid", gridTemplateColumns: "272px 1fr", border: "1px solid var(--line)" }}>
      <SidebarV3 activePath="reviews" />
      <div style={{ display: "flex", flexDirection: "column", overflow: "hidden", background: "#fff" }}>
        <QueueHeader />
        <div style={{ flex: 1, overflow: "auto", padding: "20px 32px 60px" }}>
          <QueueFilters />
          <QGroup state="open" count={4} description="Awaiting verdict or with unresolved threads.">
            <QueueRow
              subject="plan" subjectRef="@plan-review-records-web-ui"
              title="Review cycle 2: Review Records Web UI plan"
              reviewer="plan-review-agent-r2" reviewerProvider="claude"
              rev={2} state="open"
              threadCounts={{ question: 1, nit: 11 }}
              checks={[{ name: "schema", status: "pass" }]}
              verdicts={[]}
              age="12m" awaiting
            />
            <QueueRow
              subject="task" subjectRef="@01KMR3-implement-reviews-web-ui"
              title="Review: implement reviews list page + detail route"
              reviewer="pr-reviewer@kspec.local" reviewerProvider="openai"
              rev={1} state="open"
              threadCounts={{ blocker: 2, question: 1, nit: 4 }}
              checks={[{ name: "vitest", status: "fail" }, { name: "typecheck", status: "pass" }]}
              verdicts={[{ decision: "request_changes", by: "pr-reviewer" }]}
              age="38m"
              highlight
            />
            <QueueRow
              subject="spec" subjectRef="@review-records-daemon-api"
              title="Spec review: daemon API surface for reviews"
              reviewer="spec-review-agent" reviewerProvider="claude"
              rev={3} state="open"
              threadCounts={{ blocker: 1, nit: 2 }}
              checks={[]}
              verdicts={[]}
              age="1h"
            />
            <QueueRow
              subject="code" subjectRef="abc123 → def456 · 8 files"
              title="Hotfix branch: refresh-token race condition"
              reviewer="@kreed" reviewerProvider={null}
              rev={1} state="open"
              threadCounts={{ question: 2 }}
              checks={[{ name: "vitest", status: "pass" }]}
              verdicts={[]}
              age="2h"
            />
          </QGroup>

          <QGroup state="draft" count={1} description="Created but not yet open for review.">
            <QueueRow
              subject="task" subjectRef="@01KKP-implement-review-cli-create-query"
              title="Test Review (auto-generated)"
              reviewer={null} reviewerProvider={null}
              rev={null} state="draft"
              threadCounts={{}} checks={[]} verdicts={[]}
              age="3h" dim
            />
          </QGroup>

          <QGroup state="closed" count={3} description="Resolved. Linked to subject's revision history.">
            <QueueRow
              subject="task" subjectRef="@01KKTHZ-rewrite-core-skills"
              title="Review cycle 2: rewrite core skills for review-driven architecture"
              reviewer="pr-reviewer@kspec.local" reviewerProvider="openai"
              rev={2} state="closed"
              threadCounts={{}} checks={[{ name: "vitest", status: "pass" }]}
              verdicts={[{ decision: "approve", by: "pr-reviewer" }]}
              age="2d ago" dim
            />
            <QueueRow
              subject="plan" subjectRef="@plan-review-records-web-ui"
              title="Review: Review Records Web UI plan"
              reviewer="plan-review-agent" reviewerProvider="claude"
              rev={1} state="closed"
              threadCounts={{ blocker: 5, question: 3, nit: 3 }}
              checks={[]}
              verdicts={[{ decision: "request_changes", by: "plan-review-agent" }]}
              age="1h ago" dim
            />
            <QueueRow
              subject="task" subjectRef="@01KKTHZ-rewrite-core-skills"
              title="Review: rewrite core skills for review-driven architecture"
              reviewer="pr-reviewer@kspec.local" reviewerProvider="openai"
              rev={1} state="closed"
              threadCounts={{ blocker: 2, resolved: 2 }}
              checks={[{ name: "vitest", status: "pass" }]}
              verdicts={[
                { decision: "request_changes", by: "pr-reviewer" },
                { decision: "approve", by: "pr-reviewer" },
              ]}
              age="2d ago" dim
            />
          </QGroup>
        </div>
      </div>
    </div>
  );
}

function QueueHeader() {
  return (
    <div style={{ padding: "16px 32px 0", borderBottom: "1px solid var(--line)" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 14 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em" }}>Reviews</h1>
        <span style={{ fontSize: 12.5, color: "var(--muted)" }}>8 records · 4 open · 3 awaiting your action</span>
        <div style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>last sync 12s ago</span>
      </div>
      <div style={{ display: "flex", gap: 4, marginBottom: -1 }}>
        <QTab label="All" count={8} active />
        <QTab label="By subject" />
        <QTab label="Mine" count={3} />
        <QTab label="By reviewer" />
        <div style={{ flex: 1 }} />
      </div>
    </div>
  );
}

function QTab({ label, count, active }) {
  return (
    <div style={{ padding: "8px 14px", fontSize: 13,
        fontWeight: active ? 600 : 400, color: active ? "var(--ink)" : "var(--muted)",
        borderBottom: active ? "2px solid var(--ink)" : "2px solid transparent",
        cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}>
      {label}
      {count != null && <span className="mono" style={{ fontSize: 10, padding: "1px 6px",
          borderRadius: 8, background: "var(--line-soft)", color: "var(--muted)",
          fontWeight: 400 }}>{count}</span>}
    </div>
  );
}

function QueueFilters() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
      <span className="mono" style={{ fontSize: 10, color: "var(--muted)",
          letterSpacing: "0.18em" }}>SUBJECT</span>
      <FPill active>all</FPill>
      <FPill><SubjectTypePill type="plan" inline />plan</FPill>
      <FPill><SubjectTypePill type="task" inline />task</FPill>
      <FPill><SubjectTypePill type="code" inline />code</FPill>
      <FPill><SubjectTypePill type="spec" inline />spec</FPill>
      <div style={{ flex: 1 }} />
      <span className="mono" style={{ fontSize: 10, color: "var(--muted)",
          letterSpacing: "0.18em" }}>GROUP</span>
      <FPill active>state</FPill>
      <FPill>subject</FPill>
      <FPill>reviewer</FPill>
    </div>
  );
}

function QGroup({ state, count, description, children }) {
  const lc = LIFECYCLE[state];
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, padding: "10px 4px 8px",
          borderBottom: "1px solid var(--line-soft)", marginBottom: 8 }}>
        <span style={{ fontSize: 15, fontWeight: 700 }}>{lc.label[0].toUpperCase() + lc.label.slice(1)}</span>
        <span className="mono" style={{ fontSize: 11, color: lc.c, fontWeight: 600 }}>{count}</span>
        <span style={{ fontSize: 12, color: "var(--muted)" }}>· {description}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>{children}</div>
    </div>
  );
}

function QueueRow({ subject, subjectRef, title, reviewer, reviewerProvider, rev, state,
                   threadCounts, checks, verdicts, age, awaiting, highlight, dim }) {
  const lc = LIFECYCLE[state];
  const verdict = verdicts && verdicts.length > 0 ? verdicts[verdicts.length - 1] : null;
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "70px 1fr 200px 240px 90px",
      alignItems: "center", gap: 14,
      padding: "12px 14px",
      border: highlight ? "1.5px solid var(--accent)" : "1px solid var(--line)",
      borderLeft: `3px solid ${lc.c}`,
      borderRadius: 4, background: "#fff",
      opacity: dim ? 0.65 : 1,
      cursor: "pointer",
    }}>
      <SubjectTypePill type={subject} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</div>
        <div className="mono" style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 2,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {subjectRef}{rev != null && ` · rev ${rev}`}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
        {reviewer ? (
          <>
            {reviewerProvider ? (
              <ProviderGlyph kind={reviewerProvider} size={12} color={lc.c} />
            ) : (
              <span style={{ width: 12, height: 12, borderRadius: 6, background: "var(--ink)",
                  color: "#fff", fontSize: 8, textAlign: "center", lineHeight: "12px",
                  fontWeight: 600, display: "inline-block" }}>U</span>
            )}
            <span className="mono">{reviewer}</span>
          </>
        ) : <span className="mono" style={{ color: "var(--muted)" }}>—</span>}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
        {Object.entries(threadCounts).map(([k, n]) => (
          k !== "resolved" && THREAD_KINDS[k] && <KindCount key={k} k={k} n={n} />
        ))}
        {checks && checks.map((c, i) => (
          <CheckPill key={i} {...c} />
        ))}
        {verdict && (
          <span className="mono" style={{ fontSize: 10, padding: "1px 6px",
              background: VERDICTS[verdict.decision].bg,
              color: VERDICTS[verdict.decision].c,
              borderRadius: 2, letterSpacing: "0.06em" }}>
            {verdict.decision === "approve" ? "✓ approved" : "↻ changes"}
          </span>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3 }}>
        {awaiting && <span className="mono" style={{ fontSize: 10, color: "var(--accent)",
            fontWeight: 600 }}>awaiting</span>}
        <span className="mono" style={{ fontSize: 10, color: "var(--muted)" }}>{age}</span>
      </div>
    </div>
  );
}

function SubjectTypePill({ type, inline }) {
  const map = {
    plan: { c: "#fff", bg: "var(--accent)" },
    task: { c: "#fff", bg: "#2f6fdc" },
    code: { c: "#fff", bg: "#444" },
    spec: { c: "#fff", bg: "#7a3a8a" },
  }[type] || { c: "#fff", bg: "#888" };
  return (
    <span className="mono" style={{
      display: "inline-block",
      background: map.bg, color: map.c,
      padding: inline ? "1px 5px" : "3px 8px",
      borderRadius: 3,
      fontSize: inline ? 9 : 10,
      letterSpacing: "0.08em",
      fontWeight: 600,
      marginRight: inline ? 4 : 0,
    }}>{type.toUpperCase()}</span>
  );
}

function CheckPill({ name, status }) {
  const m = status === "pass"
    ? { c: "var(--green)", bg: "var(--green-soft)", glyph: "✓" }
    : status === "fail"
    ? { c: "var(--red)", bg: "var(--red-soft)", glyph: "✗" }
    : { c: "var(--muted)", bg: "var(--line-soft)", glyph: "·" };
  return (
    <span className="mono" style={{ fontSize: 10, padding: "1px 6px",
        background: m.bg, color: m.c, borderRadius: 2,
        letterSpacing: "0.04em", display: "inline-flex", alignItems: "center", gap: 4 }}>
      <span>{m.glyph}</span>{name}
    </span>
  );
}

function FPill({ children, active }) {
  return (
    <span className="mono" style={{ fontSize: 11, padding: "3px 9px", borderRadius: 3,
        border: `1px solid ${active ? "var(--ink)" : "var(--line)"}`,
        background: active ? "var(--ink)" : "transparent",
        color: active ? "#fff" : "var(--muted)",
        cursor: "pointer", display: "inline-flex", alignItems: "center" }}>{children}</span>
  );
}

// ============= REVIEW HEADER (shared across all subjects) ============
function ReviewHeader({ subject, subjectRef, title, state, rev, reviewer, reviewerProvider,
                       opened, checks, verdicts, threadCount, resolvedCount, onTab, activeTab }) {
  const lc = LIFECYCLE[state];
  return (
    <div style={{ borderBottom: "1px solid var(--line)", background: "#fff" }}>
      <div style={{ padding: "12px 24px 8px", display: "flex", alignItems: "center", gap: 12 }}>
        <span className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>
          kynetic-spec / reviews /
        </span>
        <SubjectTypePill type={subject} />
        <span style={{ fontWeight: 700, fontSize: 15 }}>{title}</span>
        <div style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 10, padding: "2px 8px",
            color: lc.c, border: `1px solid ${lc.c}`, borderRadius: 3,
            letterSpacing: "0.08em" }}>{lc.label.toUpperCase()}</span>
      </div>

      <div style={{ padding: "0 24px 10px", display: "flex", alignItems: "center", gap: 16,
          fontSize: 11 }} className="mono">
        <span style={{ color: "var(--muted)" }}>{subjectRef} · rev {rev}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          {reviewerProvider ? (
            <ProviderGlyph kind={reviewerProvider} size={12} color="var(--ink)" />
          ) : (
            <span style={{ width: 12, height: 12, borderRadius: 6, background: "var(--ink)",
                color: "#fff", fontSize: 8, textAlign: "center", lineHeight: "12px",
                fontWeight: 600, display: "inline-block" }}>U</span>
          )}
          <span>{reviewer}</span>
        </div>
        <span style={{ color: "var(--muted)" }}>opened {opened}</span>
        <div style={{ flex: 1 }} />
        {checks && checks.map((c, i) => <CheckPill key={i} {...c} />)}
      </div>

      {/* Verdict / decision row */}
      <div style={{ padding: "10px 24px", borderTop: "1px solid var(--line-soft)",
          background: "var(--paper)", display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span className="mono" style={{ fontSize: 10, color: "var(--muted)",
              letterSpacing: "0.15em" }}>THREADS</span>
          <span className="mono" style={{ fontSize: 12, fontWeight: 600 }}>
            {resolvedCount}/{threadCount} resolved
          </span>
        </div>
        <div style={{ width: 1, height: 18, background: "var(--line)" }} />
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span className="mono" style={{ fontSize: 10, color: "var(--muted)",
              letterSpacing: "0.15em" }}>VERDICT</span>
          {verdicts && verdicts.length > 0 ? (
            <span className="mono" style={{ fontSize: 11, padding: "2px 8px",
                background: VERDICTS[verdicts[verdicts.length - 1].decision].bg,
                color: VERDICTS[verdicts[verdicts.length - 1].decision].c,
                borderRadius: 2, letterSpacing: "0.06em", fontWeight: 600 }}>
              {VERDICTS[verdicts[verdicts.length - 1].decision].label}
            </span>
          ) : (
            <span className="mono" style={{ fontSize: 11, color: "var(--accent)" }}>awaiting</span>
          )}
        </div>
        <div style={{ flex: 1 }} />
        {state === "open" && (
          <>
            <span className="mono" style={{ fontSize: 11, padding: "4px 10px",
                border: "1px solid var(--line)", color: "var(--muted)",
                borderRadius: 3, cursor: "pointer" }}>↻ re-request</span>
            <span className="mono" style={{ fontSize: 11, padding: "4px 10px",
                border: "1px solid var(--green)", color: "var(--green)",
                borderRadius: 3, cursor: "pointer" }}>✓ approve</span>
            <span className="mono" style={{ fontSize: 11, padding: "4px 10px",
                border: "1px solid var(--red)", color: "var(--red)",
                borderRadius: 3, cursor: "pointer" }}>↻ request changes</span>
          </>
        )}
      </div>
    </div>
  );
}

// ============= TASK / CODE REVIEW (diff + line-anchored threads) ====
function ReviewTaskCode() {
  return (
    <div className="ui" style={{ width: 1240, height: 820, background: "var(--paper)",
        display: "grid", gridTemplateColumns: "272px 1fr", border: "1px solid var(--line)" }}>
      <SidebarV3 activePath="reviews" />
      <div style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <ReviewHeader
          subject="task"
          subjectRef="@01KMR3-implement-reviews-web-ui"
          title="implement reviews list page + detail route"
          state="open" rev={1}
          reviewer="pr-reviewer@kspec.local" reviewerProvider="openai"
          opened="38m ago"
          checks={[{ name: "vitest", status: "fail" }, { name: "typecheck", status: "pass" }]}
          verdicts={[{ decision: "request_changes", by: "pr-reviewer" }]}
          threadCount={7} resolvedCount={0}
        />
        <div style={{ flex: 1, display: "grid", gridTemplateColumns: "240px 1fr 320px",
            overflow: "hidden" }}>
          <CodeFileTree />
          <CodeDiffView />
          <CodeThreadList />
        </div>
      </div>
    </div>
  );
}

// File tree with thread counts
function CodeFileTree() {
  const files = [
    { path: "web/src/routes/reviews/+page.svelte",      adds: 142, dels: 0,  threads: 2, kind: "blocker" },
    { path: "web/src/routes/reviews/[id]/+page.svelte", adds: 218, dels: 0,  threads: 3, kind: "blocker", active: true },
    { path: "web/src/lib/api/reviews.ts",               adds: 64,  dels: 0,  threads: 1, kind: "nit" },
    { path: "web/src/lib/components/ReviewCard.svelte", adds: 88,  dels: 0,  threads: 1, kind: "question" },
    { path: "web/src/lib/components/ThreadEntry.svelte", adds: 72, dels: 0,  threads: 0 },
    { path: "shared/src/types/reviews.ts",              adds: 41,  dels: 0,  threads: 0 },
    { path: "tests/web/reviews.test.ts",                adds: 0,   dels: 0,  threads: 0, failing: true },
  ];
  return (
    <div style={{ borderRight: "1px solid var(--line)", overflow: "auto",
        background: "#fff", padding: "8px 0" }}>
      <div style={{ padding: "4px 14px 8px", display: "flex", alignItems: "center" }}>
        <span className="mono" style={{ fontSize: 10, color: "var(--muted)",
            letterSpacing: "0.15em" }}>FILES · 7 changed</span>
        <div style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>+625 −0</span>
      </div>
      {files.map((f, i) => <FileRow key={i} {...f} />)}
    </div>
  );
}

function FileRow({ path, adds, dels, threads, kind, active, failing }) {
  const k = kind && THREAD_KINDS[kind];
  return (
    <div style={{
      padding: "6px 14px",
      background: active ? "var(--accent-soft)" : "transparent",
      borderLeft: active ? "2px solid var(--accent)" : "2px solid transparent",
      cursor: "pointer",
      display: "flex", alignItems: "center", gap: 6, fontSize: 11.5,
    }} className="mono">
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis",
          whiteSpace: "nowrap" }}>{path}</span>
      {failing && <span style={{ color: "var(--red)", fontSize: 10 }}>✗</span>}
      {threads > 0 && (
        <span style={{ fontSize: 10, padding: "1px 5px", background: k?.bg || "var(--line-soft)",
            color: k?.c || "var(--muted)", borderRadius: 2 }}>{threads}</span>
      )}
      <span style={{ fontSize: 10, color: "var(--green)" }}>+{adds}</span>
      {dels > 0 && <span style={{ fontSize: 10, color: "var(--red)" }}>−{dels}</span>}
    </div>
  );
}

// Diff view with inline threads
function CodeDiffView() {
  return (
    <div style={{ overflow: "auto", background: "#fafaf6",
        fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5, lineHeight: 1.55 }}>
      <div style={{ padding: "10px 16px", background: "#fff",
          borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center",
          gap: 10, position: "sticky", top: 0, zIndex: 5 }}>
        <span className="mono" style={{ fontSize: 11.5, fontWeight: 600 }}>
          web/src/routes/reviews/[id]/+page.svelte
        </span>
        <span className="mono" style={{ fontSize: 10, color: "var(--green)" }}>+218</span>
        <div style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 10, color: "var(--muted)" }}>view ▸ unified · split · raw</span>
      </div>

      <Hunk header="@@ -1,0 +1,40 @@  src/routes/reviews/[id]/+page.svelte (new file)" />

      <DiffLine n={1}  add line='<script lang="ts">' />
      <DiffLine n={2}  add line='  import { page } from "$app/stores";' />
      <DiffLine n={3}  add line='  import { reviewQuery } from "$lib/api/reviews";' />
      <DiffLine n={4}  add line='  import ReviewBody from "$lib/components/ReviewBody.svelte";' />
      <DiffLine n={5}  add line='' />
      <DiffLine n={6}  add line='  const id = $derived($page.params.id);' />
      <DiffLine n={7}  add line='  const review = $derived(reviewQuery(id));' />
      <DiffLine n={8}  add line='</script>' />
      <DiffLine n={9}  add line='' />
      <DiffLine n={10} add line='{#if $review.isPending}' />
      <DiffLine n={11} add line='  <p>Loading…</p>' anchored />
      <ThreadInline thread={{
        author: "pr-reviewer", provider: "openai", kind: "blocker",
        when: "32m",
        body: <>No loading skeleton — the parent <code>web-ui</code> module's loading-states trait says
          all data-bound routes must render a structural skeleton, not a text fallback. See
          <code> @trait-loading-states ac-2</code>.</>,
        anchor: "+page.svelte:11",
      }} />
      <DiffLine n={12} add line='{:else if $review.isError}' />
      <DiffLine n={13} add line='  <p>Error loading review</p>' anchored />
      <ThreadInline thread={{
        author: "pr-reviewer", provider: "openai", kind: "blocker",
        when: "32m",
        body: <>Error state must surface <code>review.error</code> with a retry control —
          <code> @trait-error-guidance ac-3</code>. Bare "Error loading review" gives the user nothing actionable.</>,
        anchor: "+page.svelte:13",
      }} />
      <DiffLine n={14} add line='{:else}' />
      <DiffLine n={15} add line='  {@const r = $review.data}' />
      <DiffLine n={16} add line='  <header class="review-header">' />
      <DiffLine n={17} add line='    <h1>{r.title}</h1>' />
      <DiffLine n={18} add line='    <span class="state">{r.lifecycle_state}</span>' />
      <DiffLine n={19} add line='  </header>' />
      <DiffLine n={20} add line='' />
      <DiffLine n={21} add line='  <!-- render subject-specific body -->' />
      <DiffLine n={22} add line='  <ReviewBody subject={r.subject} threads={r.threads} />' anchored />
      <ThreadInline thread={{
        author: "pr-reviewer", provider: "openai", kind: "question",
        when: "30m",
        body: <>How does <code>ReviewBody</code> dispatch on <code>subject.type</code>? Are the four
          subject renderers in one component or four? Plan ac-6 doesn't say.</>,
        anchor: "+page.svelte:22",
      }} />
      <DiffLine n={23} add line='' />
      <DiffLine n={24} add line='  <section class="verdicts">' />
      <DiffLine n={25} add line='    {#each r.verdicts as v}' />
      <DiffLine n={26} add line='      <VerdictRow {v} />' />
      <DiffLine n={27} add line='    {/each}' />
      <DiffLine n={28} add line='  </section>' />
      <DiffLine n={29} add line='{/if}' />

      <Hunk header="@@  src/routes/reviews/[id]/+page.svelte  …  (more)" />

      <DiffLine muted n={31} line='// 9 more lines below' />
    </div>
  );
}

function Hunk({ header }) {
  return (
    <div style={{ padding: "6px 18px", background: "#eee9dd",
        borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)",
        color: "#6b6b66", fontSize: 11 }}>{header}</div>
  );
}

function DiffLine({ n, add, rem, line, anchored, muted }) {
  const bg = add ? "#eef9ed" : rem ? "#fbeded" : (anchored ? "#fff7ea" : "transparent");
  const fg = add ? "#1f4a23" : rem ? "#7a2929" : "var(--ink)";
  const sym = add ? "+" : (rem ? "−" : " ");
  return (
    <div style={{ display: "grid", gridTemplateColumns: "48px 16px 1fr", background: bg,
        borderLeft: anchored ? "3px solid var(--accent)" : "3px solid transparent",
        opacity: muted ? 0.55 : 1 }}>
      <span style={{ textAlign: "right", padding: "0 10px", color: "var(--muted)",
          fontSize: 10.5 }}>{n}</span>
      <span style={{ color: fg, textAlign: "center" }}>{sym}</span>
      <span style={{ color: fg, padding: "0 8px", whiteSpace: "pre",
          overflow: "hidden", textOverflow: "ellipsis" }}>{line}</span>
    </div>
  );
}

function ThreadInline({ thread }) {
  const k = THREAD_KINDS[thread.kind];
  return (
    <div style={{ borderLeft: "3px solid var(--accent)", background: "#fff",
        margin: "0 18px 8px 64px", border: "1px solid var(--line)",
        borderLeftWidth: 3, borderLeftColor: k.c, borderRadius: "0 4px 4px 0" }}>
      <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--line-soft)",
          display: "flex", alignItems: "center", gap: 8 }}>
        <ProviderGlyph kind={thread.provider} size={14} color={k.c} />
        <span style={{ fontWeight: 600, fontSize: 12 }}>{thread.author}</span>
        <span className="mono" style={{ fontSize: 9, padding: "1px 6px", background: k.bg,
            color: k.c, borderRadius: 2, letterSpacing: "0.08em" }}>{k.label}</span>
        <span className="mono" style={{ fontSize: 10, color: "var(--muted)" }}>· {thread.anchor}</span>
        <div style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 10, color: "var(--muted)" }}>{thread.when}</span>
      </div>
      <div style={{ padding: "10px 12px", fontSize: 12.5, lineHeight: 1.5, fontFamily: "Inter, sans-serif", color: "var(--ink)" }}>
        {thread.body}
      </div>
      <div style={{ padding: "6px 12px", borderTop: "1px solid var(--line-soft)",
          display: "flex", alignItems: "center", gap: 8 }}>
        <span className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>↳ reply…</span>
        <div style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 10, padding: "2px 7px",
            border: "1px solid var(--line)", color: "var(--muted)",
            borderRadius: 3 }}>resolve</span>
      </div>
    </div>
  );
}

// Right-side thread list (jump-to-anchor)
function CodeThreadList() {
  return (
    <div style={{ borderLeft: "1px solid var(--line)", background: "#fff",
        overflow: "auto", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--line-soft)",
          display: "flex", alignItems: "center" }}>
        <span className="mono" style={{ fontSize: 10, color: "var(--muted)",
            letterSpacing: "0.15em" }}>THREADS · 7 total</span>
        <div style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 10, color: "var(--accent)" }}>0/7 resolved</span>
      </div>
      <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--line-soft)",
          display: "flex", gap: 4 }}>
        <FPill active>all 7</FPill>
        <FPill>blockers 2</FPill>
        <FPill>nits 4</FPill>
      </div>

      <ThreadJumpRow kind="blocker" anchor="+page.svelte:11"
        snippet="No loading skeleton — module's loading-states trait says…" active />
      <ThreadJumpRow kind="blocker" anchor="+page.svelte:13"
        snippet="Error state must surface review.error with a retry control…" />
      <ThreadJumpRow kind="question" anchor="+page.svelte:22"
        snippet="How does ReviewBody dispatch on subject.type?" />
      <ThreadJumpRow kind="blocker" anchor="+page.svelte:67"
        snippet="Thread anchor rendering doesn't escape HTML — XSS surface…" />
      <ThreadJumpRow kind="nit" anchor="reviews.ts:18"
        snippet="reviewQuery missing stale-time configuration." />
      <ThreadJumpRow kind="nit" anchor="ReviewCard.svelte:24"
        snippet="Subject-type colors should come from theme tokens." />
      <ThreadJumpRow kind="question" anchor="ReviewCard.svelte:44"
        snippet="Why is age formatted client-side instead of server?" />

      <div style={{ marginTop: "auto", padding: 12, borderTop: "1px solid var(--line-soft)",
          background: "var(--paper)" }}>
        <div className="mono" style={{ fontSize: 10, color: "var(--muted)",
            letterSpacing: "0.15em", marginBottom: 6 }}>CHECKS</div>
        <CheckRow name="vitest" status="fail" evidence="3 failures in tests/web/reviews.test.ts" />
        <CheckRow name="typecheck" status="pass" evidence="0 errors" />
        <CheckRow name="lint" status="pass" evidence="0 warnings" />
      </div>
    </div>
  );
}

function ThreadJumpRow({ kind, anchor, snippet, active }) {
  const k = THREAD_KINDS[kind];
  return (
    <div style={{
      padding: "10px 14px",
      borderBottom: "1px solid var(--line-soft)",
      borderLeft: `3px solid ${k.c}`,
      background: active ? "var(--accent-soft)" : "transparent",
      cursor: "pointer",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
        <span className="mono" style={{ fontSize: 9, padding: "1px 5px", background: k.bg,
            color: k.c, borderRadius: 2, letterSpacing: "0.08em" }}>{k.label}</span>
        <span className="mono" style={{ fontSize: 10, color: "var(--muted)", flex: 1,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{anchor}</span>
      </div>
      <div style={{ fontSize: 11.5, color: "#2a2a2a", lineHeight: 1.4,
          overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box",
          WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{snippet}</div>
    </div>
  );
}

function CheckRow({ name, status, evidence }) {
  const c = status === "pass" ? "var(--green)" : "var(--red)";
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 6, padding: "3px 0",
        fontSize: 11 }} className="mono">
      <span style={{ color: c, width: 12, textAlign: "center" }}>
        {status === "pass" ? "✓" : "✗"}
      </span>
      <span style={{ fontWeight: 600, color: c, minWidth: 64 }}>{name}</span>
      <span style={{ flex: 1, color: "var(--muted)" }}>{evidence}</span>
    </div>
  );
}

// ============= RAW CODE REVIEW =======================================
function ReviewCode() {
  return (
    <div className="ui" style={{ width: 1240, height: 820, background: "var(--paper)",
        display: "grid", gridTemplateColumns: "272px 1fr", border: "1px solid var(--line)" }}>
      <SidebarV3 activePath="reviews" />
      <div style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <ReviewHeader
          subject="code"
          subjectRef="abc123 → def456 · 8 files"
          title="Hotfix: refresh-token race condition"
          state="open" rev={1}
          reviewer="@kreed" reviewerProvider={null}
          opened="2h ago"
          checks={[{ name: "vitest", status: "pass" }]}
          verdicts={[]}
          threadCount={2} resolvedCount={0}
        />
        <div style={{ padding: "12px 24px 0", background: "#fff",
            borderBottom: "1px solid var(--line)", display: "flex", gap: 10, alignItems: "center" }}>
          <span className="mono" style={{ fontSize: 11, color: "var(--muted)",
              letterSpacing: "0.1em" }}>NO TASK</span>
          <span style={{ fontSize: 12, color: "var(--muted)" }}>
            This review covers a raw commit range with no task attached — a hotfix.
          </span>
          <div style={{ flex: 1 }} />
          <span className="mono" style={{ fontSize: 11, color: "var(--accent)", padding: "3px 8px",
              border: "1px solid var(--accent)", borderRadius: 3, cursor: "pointer",
              marginBottom: 8 }}>
            + attach to task
          </span>
        </div>
        <div style={{ flex: 1, display: "grid", gridTemplateColumns: "240px 1fr 320px",
            overflow: "hidden" }}>
          <CodeFileTreeForCode />
          <CodeDiffForCode />
          <CodeThreadListForCode />
        </div>
      </div>
    </div>
  );
}

function CodeFileTreeForCode() {
  const files = [
    { path: "src/lib/auth/refresh.ts",      adds: 6, dels: 3, threads: 1, kind: "question", active: true },
    { path: "src/lib/auth/middleware.ts",   adds: 4, dels: 1, threads: 0 },
    { path: "src/lib/auth/session.ts",      adds: 2, dels: 0, threads: 1, kind: "question" },
    { path: "tests/auth/refresh.test.ts",   adds: 18, dels: 0, threads: 0 },
  ];
  return (
    <div style={{ borderRight: "1px solid var(--line)", overflow: "auto",
        background: "#fff", padding: "8px 0" }}>
      <div style={{ padding: "4px 14px 8px", display: "flex", alignItems: "center" }}>
        <span className="mono" style={{ fontSize: 10, color: "var(--muted)",
            letterSpacing: "0.15em" }}>FILES · 4 changed</span>
        <div style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>+30 −4</span>
      </div>
      {files.map((f, i) => <FileRow key={i} {...f} />)}
    </div>
  );
}

function CodeDiffForCode() {
  return (
    <div style={{ overflow: "auto", background: "#fafaf6",
        fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5, lineHeight: 1.55 }}>
      <div style={{ padding: "10px 16px", background: "#fff",
          borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center",
          gap: 10, position: "sticky", top: 0, zIndex: 5 }}>
        <span className="mono" style={{ fontSize: 11.5, fontWeight: 600 }}>src/lib/auth/refresh.ts</span>
        <span className="mono" style={{ fontSize: 10, color: "var(--green)" }}>+6</span>
        <span className="mono" style={{ fontSize: 10, color: "var(--red)" }}>−3</span>
      </div>

      <Hunk header="@@ -42,11 +42,14 @@  refresh queue management" />
      <DiffLine n={42} line=' export class RefreshQueue {' />
      <DiffLine n={43} line='   private pending = new Map<string, Promise<Token>>();' />
      <DiffLine n={44} line='+  private refreshing = new Set<string>();' add />
      <DiffLine n={45} line='' />
      <DiffLine n={46} line='   async refresh(token: string): Promise<Token> {' />
      <DiffLine n={47} rem line='     if (this.pending.has(token)) {' />
      <DiffLine n={48} rem line='       return this.pending.get(token)!;' />
      <DiffLine n={49} rem line='     }' />
      <DiffLine n={50} add line='     // Double-check: pending OR currently-refreshing OR both' anchored />
      <ThreadInline thread={{
        author: "@kreed", provider: null, kind: "question",
        when: "1h",
        body: <>Why both a Map AND a Set? Couldn't the Map alone serve as "currently in flight"?
          What case does the Set catch that the Map doesn't?</>,
        anchor: "refresh.ts:50",
      }} />
      <DiffLine n={51} add line='     if (this.pending.has(token) || this.refreshing.has(token)) {' />
      <DiffLine n={52} add line='       return this.pending.get(token) ?? this.waitForCurrent(token);' />
      <DiffLine n={53} add line='     }' />
      <DiffLine n={54} line='     // …' />
    </div>
  );
}

function CodeThreadListForCode() {
  return (
    <div style={{ borderLeft: "1px solid var(--line)", background: "#fff",
        overflow: "auto", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--line-soft)" }}>
        <span className="mono" style={{ fontSize: 10, color: "var(--muted)",
            letterSpacing: "0.15em" }}>THREADS · 2</span>
      </div>
      <ThreadJumpRow kind="question" anchor="refresh.ts:50"
        snippet="Why both a Map AND a Set? What case does the Set catch?" active />
      <ThreadJumpRow kind="question" anchor="session.ts:118"
        snippet="The new session invalidation path runs synchronously — is that safe under load?" />
      <div style={{ marginTop: "auto", padding: 12, borderTop: "1px solid var(--line-soft)",
          background: "var(--paper)" }}>
        <div className="mono" style={{ fontSize: 10, color: "var(--muted)",
            letterSpacing: "0.15em", marginBottom: 6 }}>CHECKS</div>
        <CheckRow name="vitest" status="pass" evidence="all 5563 tests passed" />
      </div>
    </div>
  );
}

// ============= SPEC REVIEW (AC-anchored threads) =====================
function ReviewSpec() {
  return (
    <div className="ui" style={{ width: 1240, height: 820, background: "var(--paper)",
        display: "grid", gridTemplateColumns: "272px 1fr 320px", border: "1px solid var(--line)" }}>
      <SidebarV3 activePath="reviews" />
      <div style={{ display: "flex", flexDirection: "column", overflow: "hidden",
          borderRight: "1px solid var(--line)" }}>
        <ReviewHeader
          subject="spec"
          subjectRef="@review-records-daemon-api"
          title="Spec review: daemon API surface for reviews"
          state="open" rev={3}
          reviewer="spec-review-agent" reviewerProvider="claude"
          opened="1h ago"
          checks={[]}
          verdicts={[]}
          threadCount={3} resolvedCount={0}
        />
        <div style={{ flex: 1, overflow: "auto", padding: "26px 60px 80px",
            maxWidth: 820, margin: "0 auto" }}>
          <SpecReviewBody />
        </div>
      </div>
      <SpecReviewRightRail />
    </div>
  );
}

function SpecReviewBody() {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <SpecKindPill kind="requirement" />
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}>
          Review Records Daemon API
        </h1>
      </div>
      <div className="mono" style={{ fontSize: 11, color: "var(--muted)", marginBottom: 18 }}>
        rev 3 · proposed · parent <span style={{ color: "var(--ink)" }}>@daemon-server</span>
      </div>

      <SpecParaR>The daemon exposes REST endpoints and a WebSocket topic for reading and mutating
      review records. Each mutation is a separate endpoint mapping to a library function.</SpecParaR>

      <SpecHR>Acceptance criteria</SpecHR>

      <AcReviewCard id="ac-1" status="proposed"
        text="GET /api/reviews lists reviews with filters: status, disposition, subject-type, reviewer, linked task (via subject-ref or related-refs), and sort." />

      <AcReviewCard id="ac-2" status="proposed"
        text="GET /api/reviews/:id returns the full review record including threads, verdicts, and checks." />

      <AcReviewCard id="ac-3" status="proposed" highlighted
        text="POST /api/reviews/:id/threads creates a new thread with kind (blocker/question/nit) and initial entry. Optional anchor for code/spec subjects." />
      <AcThread
        kind="blocker"
        author="spec-review-agent" provider="claude" when="38m"
        body={<>Anchor schema isn't specified. For code subjects the anchor needs <code>path</code>,
          <code>line_start</code>, <code>line_end</code>, <code>side</code>, <code>commit</code>. For
          spec subjects it needs <code>spec_ref</code>, <code>ac_id</code>. For plan subjects it
          needs <code>section</code>, <code>offset_start</code>, <code>offset_end</code>. The AC
          says "optional anchor" without defining the union — implementers will guess.</>}
        suggestion={<>Add an <code>ac-3a</code> for the anchor schema, or a sibling
          <code> @anchor-shape</code> spec that all anchored mutations reference.</>}
      />

      <AcReviewCard id="ac-4" status="proposed"
        text="POST /api/reviews/:id/threads/:tid/replies appends an entry to an existing thread." />

      <AcReviewCard id="ac-5" status="proposed" highlighted
        text="PATCH /api/reviews/:id/threads/:tid/resolve marks the thread resolved. Returns 409 if already resolved." />
      <AcThread
        kind="question" author="spec-review-agent" provider="claude" when="34m"
        body={<>Should reopening a thread be the same endpoint with a different payload (<code>{`{ state: "open" }`}</code>),
          or a separate <code>POST .../reopen</code>? The lifecycle library does
          <code> reopenThreadAtomic</code> as a distinct call.</>}
      />

      <AcReviewCard id="ac-6" status="proposed"
        text="POST /api/reviews/:id/verdicts submits a decision (approve / request_changes / comment) with reviewer and optional summary." />

      <AcReviewCard id="ac-7" status="proposed"
        text="POST /api/reviews/:id/checks records a check result (name, status, runner, evidence)." />

      <AcReviewCard id="ac-8" status="proposed"
        text="POST /api/reviews/:id/lifecycle transitions the review (draft → open → closed). Returns 400 with valid next-states when the transition is invalid." />

      <AcReviewCard id="ac-9" status="proposed" highlighted
        text="A real-time update event is broadcast on the 'reviews:updates' topic when any mutation lands." />
      <AcThread
        kind="nit" author="spec-review-agent" provider="claude" when="22m"
        body={<>Event granularity is unspecified. Recommend per-event types
          (<code>review_created</code>, <code>thread_added</code>, <code>verdict_submitted</code>, …)
          so subscribers can react narrowly. A single <code>review_updated</code> forces every
          subscriber to refetch even when uninterested.</>}
      />

      <AcReviewCard id="ac-10" status="proposed"
        text="Invalid mutation payloads return 400 with actionable error messages (per @trait-error-guidance)." />
    </div>
  );
}

function AcReviewCard({ id, text, status, highlighted }) {
  return (
    <div style={{
      border: highlighted ? "1.5px solid var(--accent)" : "1px solid var(--line)",
      borderLeft: `3px solid var(--muted)`,
      borderRadius: 4, background: "#fff",
      padding: "10px 12px",
      marginTop: 8,
      display: "flex", alignItems: "flex-start", gap: 10,
    }}>
      <span className="mono" style={{ fontSize: 10, fontWeight: 600,
          color: "var(--muted)", paddingTop: 1 }}>{id.toUpperCase()}</span>
      <span style={{ flex: 1, fontSize: 12.5, lineHeight: 1.55, color: "var(--ink)" }}>{text}</span>
      <span className="mono" style={{ fontSize: 9, padding: "1px 6px",
          background: "var(--line-soft)", color: "var(--muted)", borderRadius: 2,
          letterSpacing: "0.08em" }}>{status.toUpperCase()}</span>
    </div>
  );
}

function AcThread({ kind, author, provider, when, body, suggestion }) {
  const k = THREAD_KINDS[kind];
  return (
    <div style={{ marginTop: 6, marginLeft: 32,
        borderLeft: `3px solid ${k.c}`, border: "1px solid var(--line)",
        borderLeftWidth: 3, borderLeftColor: k.c,
        background: "#fff", borderRadius: "0 4px 4px 0" }}>
      <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--line-soft)",
          display: "flex", alignItems: "center", gap: 8 }}>
        <ProviderGlyph kind={provider} size={14} color={k.c} />
        <span style={{ fontWeight: 600, fontSize: 12 }}>{author}</span>
        <span className="mono" style={{ fontSize: 9, padding: "1px 6px", background: k.bg,
            color: k.c, borderRadius: 2, letterSpacing: "0.08em" }}>{k.label}</span>
        <div style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 10, color: "var(--muted)" }}>{when}</span>
      </div>
      <div style={{ padding: "10px 12px", fontSize: 12.5, lineHeight: 1.5, color: "var(--ink)" }}>
        {body}
      </div>
      {suggestion && (
        <div style={{ padding: "8px 12px", borderTop: "1px dashed var(--line)",
            background: "var(--paper)", fontSize: 12, lineHeight: 1.5,
            color: "var(--ink)" }}>
          <span className="mono" style={{ fontSize: 9, color: "var(--accent)",
              letterSpacing: "0.1em", marginRight: 6 }}>SUGGESTION</span>
          {suggestion}
        </div>
      )}
      <div style={{ padding: "6px 12px", borderTop: "1px solid var(--line-soft)",
          display: "flex", alignItems: "center", gap: 8 }}>
        <span className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>↳ reply…</span>
        <div style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 10, padding: "2px 7px",
            border: "1px solid var(--accent)", color: "var(--accent)",
            borderRadius: 3 }}>↳ accept & open follow-up</span>
        <span className="mono" style={{ fontSize: 10, padding: "2px 7px",
            border: "1px solid var(--line)", color: "var(--muted)",
            borderRadius: 3 }}>resolve</span>
      </div>
    </div>
  );
}

function SpecReviewRightRail() {
  return (
    <div style={{ background: "#fff", overflow: "auto", padding: "16px 14px",
        display: "flex", flexDirection: "column", gap: 18 }}>
      <div>
        <div className="mono" style={{ fontSize: 10, color: "var(--muted)",
            letterSpacing: "0.15em", marginBottom: 6 }}>THREADS · 3 unresolved</div>
        <ThreadJumpCard kind="blocker" anchor="ac-3" snippet="Anchor schema isn't specified — code / spec / plan all need different shapes." />
        <ThreadJumpCard kind="question" anchor="ac-5" snippet="Should reopen be same endpoint or separate?" />
        <ThreadJumpCard kind="nit" anchor="ac-9" snippet="WS event granularity unspecified." />
      </div>

      <div>
        <div className="mono" style={{ fontSize: 10, color: "var(--muted)",
            letterSpacing: "0.15em", marginBottom: 6 }}>DERIVED FROM</div>
        <RefRow kind="plan" name="@plan-review-records-web-ui" detail="rev 2" />
      </div>

      <div>
        <div className="mono" style={{ fontSize: 10, color: "var(--muted)",
            letterSpacing: "0.15em", marginBottom: 6 }}>RELATED SPECS</div>
        <RefRow kind="spec" name="@review-records-web-ui" detail="sibling" />
        <RefRow kind="spec" name="@review-record-validation" detail="parent constraint" />
        <RefRow kind="spec" name="@trait-json-output" detail="inherited" />
        <RefRow kind="spec" name="@trait-error-guidance" detail="inherited" />
      </div>

      <div>
        <div className="mono" style={{ fontSize: 10, color: "var(--muted)",
            letterSpacing: "0.15em", marginBottom: 6 }}>HISTORY</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11 }} className="mono">
          <div>rev 3 · proposed · 1h ago · revised after spec-review-agent feedback</div>
          <div style={{ color: "var(--muted)" }}>rev 2 · proposed · 3h ago · split ac-3 mutations</div>
          <div style={{ color: "var(--muted)" }}>rev 1 · draft · 4h ago · initial</div>
        </div>
      </div>
    </div>
  );
}

function ThreadJumpCard({ kind, anchor, snippet }) {
  const k = THREAD_KINDS[kind];
  return (
    <div style={{ padding: "8px 10px", marginBottom: 4, borderLeft: `3px solid ${k.c}`,
        background: "#fff", border: "1px solid var(--line-soft)",
        borderLeftWidth: 3, borderLeftColor: k.c, borderRadius: "0 3px 3px 0",
        cursor: "pointer" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
        <span className="mono" style={{ fontSize: 9, padding: "1px 5px", background: k.bg,
            color: k.c, borderRadius: 2, letterSpacing: "0.08em" }}>{k.label}</span>
        <span className="mono" style={{ fontSize: 10, color: "var(--muted)" }}>{anchor}</span>
      </div>
      <div style={{ fontSize: 11.5, color: "#2a2a2a", lineHeight: 1.4 }}>{snippet}</div>
    </div>
  );
}

function RefRow({ kind, name, detail }) {
  const c = kind === "spec" ? "#7a3a8a" : kind === "plan" ? "var(--accent)" : "var(--ink)";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0",
        fontSize: 12 }}>
      <span className="mono" style={{ fontSize: 9, padding: "1px 5px", background: c,
          color: "#fff", borderRadius: 2, letterSpacing: "0.06em" }}>{kind.toUpperCase()}</span>
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis",
          whiteSpace: "nowrap" }} className="mono">{name}</span>
      <span className="mono" style={{ fontSize: 10, color: "var(--muted)" }}>{detail}</span>
    </div>
  );
}

function SpecParaR({ children }) { return <p style={{ fontSize: 13.5, lineHeight: 1.6, color: "#2a2a2a", margin: "0 0 8px" }}>{children}</p>; }
function SpecHR({ children }) { return <h3 style={{ fontSize: 14, fontWeight: 700, margin: "20px 0 6px", letterSpacing: "-0.01em" }}>{children}</h3>; }

Object.assign(window, {
  ReviewsQueue, ReviewTaskCode, ReviewCode, ReviewSpec,
  ReviewHeader, SubjectTypePill, CheckPill,
});
