// Breadcrumb truncation variants for long ancestor paths.
// Six variants laid side-by-side as a single horizontal strip artboard.
// All keep the trail on a single line; ancestor middle is collapsed in different ways.
//
// Path used in every variant:
//   Specs › Web UI System › Web Dashboard › Plans View › Plan Content Embedded Views › AC-1
//   (root) (module)         (feature)       (sub-feat)   (requirement)                 (leaf)

function CrumbBar({ children, label, note, popover, width = 720 }) {
  return (
    <div style={{ marginBottom: 30 }}>
      <div className="mono" style={{ fontSize: 10, color: "var(--muted)", letterSpacing: "0.18em", marginBottom: 6 }}>{label}</div>
      <div style={{
        width,
        border: "1px solid var(--line)",
        borderRadius: 6,
        padding: "10px 14px",
        background: "#fff",
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontSize: 13,
        whiteSpace: "nowrap",
      }}>
        {children}
      </div>
      {popover && (
        <div style={{ marginTop: 6, marginLeft: 24 }}>
          <div style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            background: "#fff",
            border: "1px solid var(--line)",
            borderRadius: 6,
            padding: "8px 12px",
            boxShadow: "0 8px 24px -8px rgba(20,20,20,0.18)",
            fontSize: 13,
            whiteSpace: "nowrap",
          }}>
            {popover}
          </div>
        </div>
      )}
      {note && <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 8, lineHeight: 1.5, maxWidth: 760 }}>{note}</div>}
    </div>
  );
}

function EllipsisBare({ label = "…", count }) {
  return (
    <span style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 4,
      padding: "2px 7px",
      borderRadius: 3,
      background: "var(--line-soft)",
      color: "var(--muted)",
      cursor: "pointer",
      border: "1px solid var(--line)",
      fontSize: 12,
      fontWeight: 600,
    }}>{label}{count ? <span className="mono" style={{ fontSize: 10, opacity: 0.7 }}>{count}</span> : null}</span>
  );
}

function CB({ kind, name, current, dim }) {
  return (
    <span style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 5,
      padding: "2px 6px",
      borderRadius: 3,
      background: current ? "var(--accent-soft)" : "transparent",
      opacity: dim ? 0.55 : 1,
    }}>
      {kind && kind !== "root" && <SpecKindPill kind={kind} size="xs" />}
      <span style={{ fontWeight: current ? 600 : 400, color: current ? "var(--ink)" : "var(--muted)" }}>{name}</span>
    </span>
  );
}
function Sep() { return <span style={{ color: "var(--muted)", fontSize: 11 }}>›</span>; }

function Ellipsis({ label = "…", count, popover }) {
  return (
    <span style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
      <span style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 7px",
        borderRadius: 3,
        background: "var(--line-soft)",
        color: "var(--muted)",
        cursor: "pointer",
        border: "1px solid var(--line)",
        fontSize: 12,
        fontWeight: 600,
      }}>{label}{count ? <span className="mono" style={{ fontSize: 10, opacity: 0.7 }}>{count}</span> : null}</span>
      {popover && (
        <div style={{
          position: "absolute",
          top: "calc(100% + 6px)",
          left: 0,
          minWidth: 280,
          background: "#fff",
          border: "1px solid var(--line)",
          borderRadius: 6,
          padding: "8px 4px",
          boxShadow: "0 8px 24px -8px rgba(20,20,20,0.18)",
          zIndex: 10,
        }}>
          {popover}
        </div>
      )}
    </span>
  );
}

function PopRow({ kind, name }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      padding: "2px 6px", borderRadius: 3,
      cursor: "pointer",
    }}>
      {kind && kind !== "root" && <SpecKindPill kind={kind} size="xs" />}
      <span style={{ color: "var(--ink)", fontWeight: 400 }}>{name}</span>
    </span>
  );
}

function BreadcrumbVariants() {
  return (
    <div className="ui" style={{ width: 820, height: 1680, background: "#fff", padding: "26px 32px", overflow: "auto" }}>
      <div style={{ marginBottom: 18 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em" }}>Breadcrumb truncation — six options</h1>
        <p style={{ fontSize: 13, color: "var(--muted)", margin: "6px 0 0", maxWidth: 760, lineHeight: 1.5 }}>
          All six show the same path:
          <span className="mono" style={{ background: "var(--line-soft)", padding: "1px 6px", borderRadius: 2, marginLeft: 6, fontSize: 11.5 }}>Specs › Web UI System › Web Dashboard › Plans View › Plan Content Embedded Views › AC-1</span>
          . Goal is to keep the bar on one line at narrow widths while still letting users jump to any ancestor.
        </p>
      </div>

      {/* === A · Full path (control) ================================== */}
      <CrumbBar label="A · FULL PATH (CONTROL — wraps or scrolls at narrow widths)"
        note="Reference. Useful only when the bar has plenty of horizontal space.">
        <CB kind="root" name="Specs" />
        <Sep />
        <CB kind="module" name="Web UI System" />
        <Sep />
        <CB kind="feature" name="Web Dashboard" />
        <Sep />
        <CB kind="feature" name="Plans View" />
        <Sep />
        <CB kind="requirement" name="Plan Content Embedded Views" />
        <Sep />
        <CB kind="requirement" name="AC-1" current />
      </CrumbBar>

      {/* === B · Root + ellipsis + parent + current =================== */}
      <CrumbBar label="B · ROOT + ELLIPSIS + IMMEDIATE PARENT + CURRENT"
        popover={
          <>
            <PopRow kind="module" name="Web UI System" />
            <Sep />
            <PopRow kind="feature" name="Web Dashboard" />
            <Sep />
            <PopRow kind="feature" name="Plans View" />
          </>
        }
        note="Always shows the root anchor and the immediate parent. The ellipsis is a popover showing the full middle list inline, in the same › separated style as the bar. Compact and predictable.">
        <CB kind="root" name="Specs" />
        <Sep />
        <EllipsisBare count="3" />
        <Sep />
        <CB kind="requirement" name="Plan Content Embedded Views" />
        <Sep />
        <CB kind="requirement" name="AC-1" current />
      </CrumbBar>

      {/* === C · Ellipsis only at left, parent + current ============== */}
      <CrumbBar label="C · ELLIPSIS-ONLY (oldest ancestors collapsed without showing root)"
        popover={
          <>
            <PopRow kind="root" name="Specs" />
            <Sep />
            <PopRow kind="module" name="Web UI System" />
            <Sep />
            <PopRow kind="feature" name="Web Dashboard" />
            <Sep />
            <PopRow kind="feature" name="Plans View" />
          </>
        }
        note="Drops the root for compactness. The popover shows the entire ancestor chain inline, including the root.">
        <EllipsisBare count="4" />
        <Sep />
        <CB kind="requirement" name="Plan Content Embedded Views" />
        <Sep />
        <CB kind="requirement" name="AC-1" current />
      </CrumbBar>

      {/* === D · Per-segment shrink (truncate names) ================== */}
      <CrumbBar label="D · PER-SEGMENT TRUNCATION (no ellipsis at all — shrink each name)"
        note="Keeps every segment but truncates middle names with ellipses. Less abrupt than collapsing, but reading the trail at a glance is harder; relies on hover-to-reveal full name. Doesn't scale past ~6 levels.">
        <CB kind="root" name="Specs" />
        <Sep />
        <CB kind="module" name="Web UI Sys…" dim />
        <Sep />
        <CB kind="feature" name="Web Dash…" dim />
        <Sep />
        <CB kind="feature" name="Plans View" dim />
        <Sep />
        <CB kind="requirement" name="Plan Content E…" />
        <Sep />
        <CB kind="requirement" name="AC-1" current />
      </CrumbBar>

      {/* === E · Stack-style with popover for ALL ancestors =========== */}
      <CrumbBar label="E · ANCESTOR STACK — single ‹‹ button collapses everything except current"
        popover={
          <>
            <PopRow kind="root" name="Specs" />
            <Sep />
            <PopRow kind="module" name="Web UI System" />
            <Sep />
            <PopRow kind="feature" name="Web Dashboard" />
            <Sep />
            <PopRow kind="feature" name="Plans View" />
            <Sep />
            <PopRow kind="requirement" name="Plan Content Embedded Views" />
          </>
        }
        note="Most aggressive — only the current node + a stack icon. Click the stack to see the full path inline. Best when the title alone is enough context.">
        <EllipsisBare label="‹‹" count="5" />
        <Sep />
        <CB kind="requirement" name="AC-1" current />
      </CrumbBar>

      {/* === F · Smart middle — root + ellipsis + last 2 ============== */}
      <CrumbBar label="F · ROOT + ELLIPSIS + LAST TWO (recommended)"
        popover={
          <>
            <PopRow kind="module" name="Web UI System" />
            <Sep />
            <PopRow kind="feature" name="Web Dashboard" />
          </>
        }
        note="Recommended default. Shows root, ellipsis, last two ancestors, current. Popover renders the collapsed segments inline using the same › separated style as the bar — visually consistent, clickable left-to-right just like the trail.">
        <CB kind="root" name="Specs" />
        <Sep />
        <EllipsisBare count="2" />
        <Sep />
        <CB kind="feature" name="Plans View" />
        <Sep />
        <CB kind="requirement" name="Plan Content Embedded Views" />
        <Sep />
        <CB kind="requirement" name="AC-1" current />
      </CrumbBar>

      <div style={{ marginTop: 28, padding: "16px 18px", border: "1px dashed var(--line)", borderRadius: 6, fontSize: 12.5, lineHeight: 1.6, color: "#3a3a36", maxWidth: 880 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Suggested behavior</div>
        Use <strong>F</strong> as the default. It keeps the most useful context (root + parent + grandparent + current) and gracefully scales:
        <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
          <li>≤ 4 segments → show all (no ellipsis)</li>
          <li>5–6 segments → root + … + last 2 + current (variant F)</li>
          <li>7+ segments → root + … + last 1 + current (variant B)</li>
          <li>If the bar still overflows → switch to ‹‹ stack (variant E)</li>
        </ul>
        Hovering the ellipsis pops the omitted segments inline below the bar (no layout shift). The popover is keyboard-navigable (↑↓ + enter).
      </div>
    </div>
  );
}

Object.assign(window, { BreadcrumbVariants });
