---
name: review-principles
description: Foundational code review principles — adversarial investigation,
  cognitive bias countermeasures, structured exploration, anti-rubber-stamping.
  Building block for pr-review and local-review.
---
<!-- kspec-managed -->
# Review Principles

Foundational code review principles that apply to all review contexts — PR review, local review, and spec-driven review. This skill encodes the cognitive discipline required for effective review, counteracting known biases that cause reviewers to miss real issues.

## Core Stance: Adversarial Investigation

**Worker claims are hypotheses, not facts.** When a PR description says "all tests pass," verify it. When a commit message says "fixed the type errors," check that they're actually fixed and not suppressed. When a worker says "this is a faithful port," diff against the reference. The worker is not lying — but they are biased toward believing their own work is correct. Your job is to independently verify.

**Read the code before the PR description.** Start by reading the diff itself — what changed, what was added, what was removed. Form your own understanding of what the PR does. Only then read the PR description and compare your understanding to the author's claims. This prevents anchoring bias, where the author's framing shapes what you look for and what you overlook.

**Treat every justification as something to verify.** When you see comments like "pre-existing issue," "out of scope," "will be addressed in follow-up," "this is the standard pattern," or "this matches the reference implementation" — these are claims that require evidence, not conclusions you should accept. Check each one.

**A clean review is a valid outcome.** Not every PR has bugs. If you investigate thoroughly and find nothing wrong, that is an acceptable result — document what you checked and approve. Do not invent findings to justify the time spent reviewing. The goal is accuracy, not a finding quota.

## Cognitive Biases to Counteract

### Satisfaction of Search
After finding the first issue in a PR, your detection rate for subsequent issues drops by 25-50%. This is a well-documented cognitive bias from radiology and proofreading research. **Finding one issue makes it MORE likely there are additional issues, not less.** After finding your first issue, deliberately increase your scrutiny for the remainder of the review.

### Complexity Bias
Simple-looking PRs (ports, renames, test rewrites, config changes) receive less scrutiny because they "look safe." In practice, these are where semantic bugs hide — a rename can break callers, a port can lose context, a test rewrite can reduce coverage while appearing to improve it. **Do not calibrate review depth to perceived complexity.** Every PR gets the same investigation depth.

### Anchoring on PR Description
Reviewers unconsciously frame their analysis around the author's stated intent. If the PR says "add feature X," reviewers look for whether X works — but not whether the PR also accidentally breaks Y, introduces Z, or silently changes the behavior of W. **Assess what the code actually does, not what the author says it does.**

### Decision Fatigue
On the Nth review in a session, reviewers default to approval. If you notice yourself thinking "this looks fine" without having verified anything specific, you are experiencing decision fatigue. **Every approval must be backed by specific evidence of verification** — files read, commands run, behavior confirmed.

## Structured Exploration Requirements

Before rendering any verdict, the reviewer MUST complete these steps. The first group is deterministic — run these as tool calls, not as reasoning:

### Deterministic Checks (run these, don't reason about them)
These are examples — use whatever tools work best (grep, git grep, Grep tool, ripgrep, etc.):
```bash
# 1. Resolve spec and ACs — do not manually read YAML
kspec item get @spec-ref                    # Own ACs + inherited trait ACs
kspec validate                              # Trait coverage warnings

# 2. Run the full test suite locally
npm test                                    # Or pnpm turbo test — verify actual output

# 3. Verify HEAD is current with base branch
git log --oneline main..HEAD               # What commits are in this PR
git merge-base --is-ancestor main HEAD     # Is it up to date

# 4. Check for AC annotations in test files (use any search tool)
grep -rn "// AC: @spec-ref" tests/ packages/   # Own AC coverage
grep -rn "// AC: @trait-" tests/ packages/     # Trait AC coverage
```

### Analytical Checks (these require reading and judgment)
1. **Read the diff** — every changed file, not just the ones that look interesting
2. **Read surrounding context** — unchanged files that interact with changed code
3. **Verify spec alignment** — for each AC, confirm the code satisfies the behavior described, not just that a test exists
4. **Verify at least one worker claim** — pick one claim from the PR description and independently confirm it is true
5. **Search across categories** — correctness, edge cases, error handling, security, test quality, integration

### Review Evidence Log
Every review must include a brief log of what was checked. If the review produces zero findings, this log is what proves the review was real:
```
Files read: <list>
Commands run: <list>
Claims verified: <which claim, how verified>
Categories searched: <which categories, any findings>
```
"No issues found" without this evidence is not an acceptable review.

## Finding Validation Process

Before emitting any finding, apply the **claim-disprove-emit** cycle:

1. **State the claim.** What exactly is wrong? Be specific: file, line, behavior.
2. **Try to disprove it.** Look for evidence that the code is actually correct — maybe there's a guard clause you missed, a test that covers the case, or a spec decision that justifies the approach. Check the code, the tests, and the spec.
3. **If disproved, drop it.** Do not emit findings you've already refuted. A dropped candidate is not a failure — it's the process working correctly.
4. **If still valid, assess severity and confidence.** Only findings that survive disproval get emitted.

This prevents hallucinated findings. The adversarial stance is toward the code, not toward producing a finding count.

## Finding Quality Standards

### Every Finding Must Be Structured
A finding without evidence is an opinion. Every finding must include:
- **Path and line** — exactly where the issue is
- **Claim** — what is wrong, stated precisely
- **Impact** — what breaks, what guarantee is lost, what spec/AC is violated
- **Evidence** — what you observed that proves the claim (test output, code path, spec text)
- **Counterevidence checked** — what you looked at to try to disprove the finding (and why it didn't disprove it)
- **Confidence** — high (verified empirically), medium (strong code-reading evidence), low (plausible but unverified)

Only high and medium confidence findings should be MUST-FIX. Low confidence findings should be SHOULD-FIX at most, with a note explaining what additional verification would resolve the uncertainty.

### Severity Must Be Justified
- **MUST-FIX**: Correctness, security, data integrity, spec violation, build breakage, coverage loss. The code is wrong or incomplete. Requires high or medium confidence.
- **SHOULD-FIX**: Likely correctness issue, missing boundary case, contract mismatch without immediate critical impact, debt that will cause real problems. The code works but is fragile or incomplete.
- **SUGGESTION**: Pure style, naming, comment formatting. Zero correctness implications. **If you are unsure whether something is a SUGGESTION or SHOULD-FIX, it is SHOULD-FIX.**

### Categories to Cover
A review should search across multiple concern areas. If a category was searched and nothing was found, note it briefly — this proves the search happened:
- **Correctness** — does the code do what the spec says?
- **Edge cases** — what happens with empty input, null, boundary values, concurrent access?
- **Error handling** — are error paths tested? Do errors propagate correctly?
- **Security** — input validation, authorization checks, data exposure
- **Test quality** — do tests prove the ACs or just touch code paths?
- **Integration** — does this change interact correctly with existing code?

## Spec-Driven Review

When reviewing against kspec acceptance criteria:

### AC Verification Matrix
For each AC, determine:
1. **Implementation** — which files/functions implement this criterion?
2. **Evidence** — does the code actually satisfy the AC, or does it approximate it?
3. **Test coverage** — is there a test that would fail if this AC were violated?
4. **Negative case** — what happens when this requirement is NOT met? Is that handled?

### Worker-Claimed Coverage vs Actual Coverage
When a test is annotated `// AC: @spec-ref ac-N`, verify:
- Does the test actually test what the AC describes, or does it test something adjacent?
- Would this test fail if the feature broke?
- Is the test at the right abstraction layer? (A parser test doesn't prove a CLI behavior)
- Does the test assert on the behavior the AC specifies, or on implementation details?

### Unstated Requirements
Specs often imply requirements they don't explicitly state. Check for:
- Error handling for invalid input (if the AC describes valid input behavior)
- Idempotency (if the operation could be retried)
- Concurrency safety (if multiple actors could interact)
- Audit trail (if the spec context involves state changes)

## Anti-Rubber-Stamping Checklist

Before approving any PR, verify you can answer YES to all of these:

- [ ] I read the diff before reading the PR description
- [ ] I ran the test suite locally (not just checked CI status)
- [ ] I verified at least one worker claim independently
- [ ] I checked for issues across multiple categories (correctness, tests, edge cases)
- [ ] I searched for additional issues after finding the first one (or after finding none)
- [ ] My review took long enough to have actually read the changed code
- [ ] Every approval checkbox is backed by specific evidence, not assumption

## Integration

This skill provides review principles. It is consumed by:
- **`/kspec:review`** — adds kspec-specific AC/trait coverage checks
- **`/local-review`** — adds project-specific quality gates for pre-PR review
- **`/pr-review`** — adds GitHub review posting, merge decisions, task lifecycle
