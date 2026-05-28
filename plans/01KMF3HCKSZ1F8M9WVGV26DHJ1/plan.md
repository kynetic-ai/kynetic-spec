# Delete Static Analysis Tests and Replace with Behavioral Coverage

## Specs

```yaml
[]
```

## Tasks

derive_from_specs: false

```yaml
[]
```

## Spec Cleanup

Investigation revealed that several specs referenced by the original plan tasks are no longer
worth testing or need structural changes. These are the remaining deliverables of this plan:

### Remove @ui-design-system
The spec's ACs are implementation-specific (exact token counts, Tailwind @theme inline extensions,
specific utility class names). A UX-focused redesign is underway that will produce new,
behaviorally-testable specs. Remove this spec rather than writing tests for a contract that
will be replaced.

### Remove @api-input-type-safety ac-4
ac-1 through ac-3 have behavioral tests in tests/daemon-api-input-validation.test.ts. ac-4
("type constraints are derived from the canonical schema definition") is an implementation
detail — users cannot observe whether validation comes from a shared schema vs hand-coded
checks. The behavioral outcomes are already covered by ac-1 through ac-3.

### Remove @package-distribution
This spec covers stable build/packaging infrastructure (npm pack includes templates, plugin
system files). The plugin system (ac-5, ac-6) is being deprecated. The remaining ACs (ac-1
through ac-4) describe build pipeline behavior that is enforced by CI and unlikely to regress
without immediate visibility. Remove the spec.

### Fold @prose-typography-setup into @trait-markdown-rendering
@prose-typography-setup has 2 ACs about Tailwind typography plugin being active. This is a
prerequisite for @trait-markdown-rendering ac-1 which already requires "Tailwind prose typography
styling" on GFM elements. The standalone spec is redundant — fold any unique coverage into the
trait and remove the standalone spec.

### Remove @trait-markdown-rendering ac-5
ac-5 requires dark-mode-compatible color schemes (prose-invert, dark highlight theme). Dark mode
is not implemented in the app. Remove this AC — it can be re-added when dark mode is built.

### Defer @gh-pages-export ac-24
The settings page (ac-24: static mode rendering) will change with the upcoming redesign.
Writing tests now would be throwaway. @daemon-server ac-16 (bun compile) already has a
behavioral test in tests/daemon-executable.test.ts — that was a false gap in the original plan.

## Completed Work

The deletion task was completed as part of the oxlint/oxfmt migration (PR #905,
@task-format-and-fix-violations). Here is what was done:

### Files deleted entirely (100% static analysis):
- tests/web-ui-tanstack-query.test.ts (1060 lines, 160 tests)
- tests/web-ui-settings.test.ts (337 lines, 57 tests)
- tests/web-ui-app-shell.test.ts (304 lines, 43 tests)
- tests/web-ui-structured-content-viewer.test.ts (315 lines, 41 tests)
- tests/web-ui-workflows.test.ts (174 lines, 27 tests)
- tests/package-distribution.test.ts (171 lines, 13 tests)
- tests/web-ui-design-system.test.ts (255 lines, 18 tests)
- packages/web-ui/tests/prose-typography.test.ts (68 lines, 2 tests)
- tests/lint/no-static-analysis.test.ts — superseded by oxlint custom rule

### Files with static portions removed, behavioral tests preserved:
- tests/web-ui-session-stream.test.ts: removed ~15 static tests (CSS class matching,
  file existence, source string assertions), kept ~117 behavioral tests (event parsing,
  streaming markdown, sanitization, auto-scroll, incremental block updates)
- tests/daemon-executable.test.ts: removed 2 of 3 tests, kept compilation test
- tests/daemon-api-input-validation.test.ts: removed 1 of 5 tests, kept 4 behavioral

### Files deleted and replaced:
- tests/ralph-replacement.test.ts → renamed to tests/setup-builtin-agents.test.ts,
  removed 3 ralph migration error tests (ralph is fully replaced) and 1 static template
  test, kept 6 behavioral tests (agent creation, dispatch rules, idempotency, session
  checkpoint)

### Enforcement:
- Custom oxlint rule `no-source-scanning/no-source-file-reads` (tools/eslint-rules/no-source-scanning.js)
  now catches static analysis patterns at lint time. The old tests/lint/no-static-analysis.test.ts
  is deleted and superseded.

### Behavioral coverage audit (2026-03-24):
Audited all 16 ACs across @trait-markdown-rendering and @streaming-markdown-component.
Result: 10 PASS, 6 PARTIAL, 0 FAIL. Every AC has at least one behavioral test. PARTIALs
are edge-case depth issues (limited malformed input variants, size thresholds, visual
style assertions in unit tests) — not worth dedicated tasks.

## Implementation Notes

This plan addresses the systemic static analysis test problem identified during audit. The project
had ~500 test cases across 12 files (5,840 lines) that read source .ts/.svelte files and asserted
on string patterns instead of testing behavior. These tests were evading the existing lint
through variable indirection chains, non-src/ paths, and scanning outside the tests/ directory.

The skill-level guidance banning source-scanning tests was merged in PR #904. The oxlint custom
rule provides automated enforcement at lint time.

### Post-investigation revision (2026-03-24)

The original plan listed 6 behavioral replacement tasks covering ~30 ACs. Investigation found:
- **Task 1 (markdown rendering):** 19 AC annotations already exist in kept behavioral tests.
  Audit completed: 10 PASS, 6 PARTIAL, 0 FAIL. No task needed.
- **Task 2 (design system):** Spec is implementation-specific, redesign incoming. Removed.
- **Task 3 (API input safety):** Only ac-4 was uncovered; it's an implementation detail. Removed.
- **Task 4 (package distribution):** Spec covers stable infra + deprecated plugin system. Removed.
- **Task 5 (prose typography):** Redundant with @trait-markdown-rendering ac-1. Fold into trait.
- **Task 6 (remaining):** ac-16 was a false gap (test exists). ac-24 deferred for redesign.
- **ac-5 (dark mode):** Not implemented in app. Remove from trait.

Net: 6 tasks → 0 tasks + 6 spec cleanup items (executed directly as plan completion).
