---
name: codex
description: Use when the user asks to run Codex CLI (codex exec, codex resume) or wants Codex to review PRs, plans, or specs. Delegates to GPT-5.3-codex with preset reasoning modes.
---

# Codex Skill

Run OpenAI Codex CLI for code analysis, reviews, and automated editing. Defaults to `gpt-5.3-codex` with preset reasoning effort per mode.

## Quick Start

```bash
# PR review (posts inline comments to GitHub)
/codex review #123

# Plan review
/codex review-plan @plan-slug
/codex review-plan ./path/to/plan.md

# Spec review
/codex review-spec @spec-slug

# General task
/codex "refactor the parser module for clarity"

# Resume last session
/codex resume
/codex resume "follow-up prompt"
```

## Modes and Reasoning Presets

| Mode | Reasoning | Sandbox | Output |
|------|-----------|---------|--------|
| `review` (PR) | `high` | `danger-full-access` | Inline GitHub comments via `gh` + `/tmp` |
| `review-plan` | `high` | `danger-full-access` | Feedback file in `/tmp` |
| `review-spec` | `high` | `danger-full-access` | Feedback file in `/tmp` |
| general (default) | `medium` | `danger-full-access` | Feedback file in `/tmp` |
| general with edits | `medium` | `danger-full-access` | Direct file changes |

**Model:** `gpt-5.3-codex` unless the user specifies otherwise.

**Sandbox:** `danger-full-access` for all modes. Codex has full filesystem and network access — same trust level as Claude. This lets it use `gh` for GitHub API calls and `kspec` for spec/task operations directly.

Users can override reasoning (`-c model_reasoning_effort="xhigh"`) or model (`-m gpt-5.2`) explicitly.

## PR Review Mode

```
/codex review #123
/codex review @task-ref
```

### Resolving @task-ref to PR Number

When the user provides a `@task-ref` instead of a PR number:

```bash
# Check task for vcs_refs
kspec task get @task-ref --json | jq '.vcs_refs'

# Or search for PR by task trailer in body/commits
gh pr list --search "Task: @task-ref" --json number,url,title
```

If no PR is found, error: "No PR found for task @task-ref. Create a PR first with /pr."

### Flow

For straightforward diff review, prefer the native `codex exec review` subcommand:

```bash
codex exec \
  -m gpt-5.3-codex \
  -c model_reasoning_effort="high" \
  -s danger-full-access \
  --skip-git-repo-check \
  review \
  "$(cat <<'PROMPT'
Also check for:
- AC coverage: every spec AC should have test with `// AC: @spec-ref ac-N` annotation
- Spec alignment: implementation matches spec intent
- Test quality: no fluff tests, prefer E2E over unit

After reviewing, post your review to GitHub using `gh pr review <NUMBER>`.
For inline comments, write a JSON body to /tmp/codex-pr-review-body.json with this structure:
  {"event":"REQUEST_CHANGES","body":"summary","comments":[{"path":"src/file.ts","line":42,"body":"comment"}]}
Then post: gh api repos/{owner}/{repo}/pulls/<NUMBER>/reviews --method POST --input /tmp/codex-pr-review-body.json

Also write the full review to /tmp/codex-pr-<NUMBER>-review.md

Severity levels: MUST-FIX, SHOULD-FIX, SUGGESTION.
PROMPT
)"
```

For PR reviews that need additional context (task ref, spec ACs), use `codex exec` instead:

```bash
codex exec \
  -m gpt-5.3-codex \
  -c model_reasoning_effort="high" \
  -s danger-full-access \
  --skip-git-repo-check \
  "$(cat <<'PROMPT'
Review PR #123 in this repository.

1. Get the PR diff: `gh pr diff 123`
2. Get PR details: `gh pr view 123 --json title,body,files`
3. If the PR body contains a `Task: @task-ref` trailer, get the linked spec:
   `kspec task get @task-ref` and check acceptance criteria coverage
4. Review the code for:
   - Correctness and potential bugs
   - AC coverage: every spec AC should have test with `// AC: @spec-ref ac-N` annotation
   - Spec alignment: implementation matches spec intent, not just syntax
   - Test quality: no fluff tests, prefer E2E over unit
5. Write a review body JSON file to /tmp/codex-pr-review-body.json:
   {"event":"REQUEST_CHANGES","body":"summary","comments":[{"path":"file","line":N,"body":"comment"}]}
   Then post: gh api repos/{owner}/{repo}/pulls/123/reviews --method POST --input /tmp/codex-pr-review-body.json
6. Also write the full review to /tmp/codex-pr-123-review.md

If no Task trailer exists, proceed with pure code review (skip AC checks).

Severity levels: MUST-FIX, SHOULD-FIX, SUGGESTION.
PROMPT
)"
```

### AC Coverage Check

When a task ref is provided, Codex is instructed to verify:
- Every spec AC has test coverage via `// AC: @spec-ref ac-N` annotations
- Missing coverage is flagged as `MUST-FIX`
- Spec alignment: implementation matches spec intent, not just syntax

### Integration with /pr-review

For full quality-gate PR review (CI verification, merge decision), use `/pr-review @task-ref` instead. This skill focuses on **code-level review feedback** — use both together:

```
/codex review #123          # Codex posts inline code review
/pr-review @task-ref        # Full quality gate workflow (AC, CI, merge)
```

## Plan Review Mode

```
/codex review-plan @plan-slug
/codex review-plan ./path/to/plan.md
```

### What Codex Checks

Codex can read plans directly via `kspec plan get` or from a file path:

```bash
codex exec \
  -m gpt-5.3-codex \
  -c model_reasoning_effort="high" \
  -s danger-full-access \
  --skip-git-repo-check \
  "Review the plan. Get it with: kspec plan get @plan-slug (or read <path>). $(cat <<'PROMPT'
Evaluate against these criteria and write feedback to /tmp/codex-plan-review.md:

## Structure
- Has ## Specs section with YAML array?
- Has ## Tasks section with derive_from_specs line?
- Has ## Implementation Notes section?

## Spec Quality
- Every spec has `title` (required)
- Every spec has `acceptance_criteria` array (strongly recommended)
- Each AC has id, given, when, then fields
- AC `then` clauses are concrete and testable (not vague like "works correctly")
- AC are independently testable (not compound)
- `parent` references use @ prefix and point to valid specs
- `traits` reference valid trait names with @ prefix
- `type` is a valid item type (feature, requirement, constraint, decision)

## Completeness
- Implementation notes present for complex specs
- No obvious gaps in AC coverage (behaviors described but not covered by AC)
- Specs don't overlap or duplicate each other
- Dependencies between specs are explicit

## Red Flags
- Vague AC: "then: system behaves correctly"
- Untestable AC: "then: performance is acceptable"
- Over-granular AC: one AC per line of code
- Compound AC: "X and Y and Z" in single criterion
- Missing parent for nested items
- Trait applied to fewer than 3 specs

Format: Use ## headers for sections, bullet lists for issues.
Rate severity: MUST-FIX, SHOULD-FIX, SUGGESTION.
PROMPT
)"
```

### Output

Feedback is written to `/tmp/codex-plan-review.md`. After Codex completes:

```bash
# Show the user the output path
echo "Plan review written to /tmp/codex-plan-review.md"

# Optionally display summary
head -50 /tmp/codex-plan-review.md
```

## Spec Review Mode

```
/codex review-spec @spec-slug
/codex review-spec @module-slug    # Review entire module
```

### What Codex Checks

Codex can read specs directly via `kspec item get` and validate with `kspec validate`:

```bash
codex exec \
  -m gpt-5.3-codex \
  -c model_reasoning_effort="high" \
  -s danger-full-access \
  --skip-git-repo-check \
  "Review the spec. $(cat <<'PROMPT'
Get the spec with: kspec item get @spec-slug
For module-level review: kspec item list --module @module-slug to get all items, then kspec item get each one.
Also run kspec validate for structural issues.

Evaluate and write feedback to /tmp/codex-spec-review.md:

## Acceptance Criteria Quality
- Are all ACs concrete and independently testable?
- Do `then` clauses describe observable outcomes (not internal state)?
- Are ACs atomic (not compound "X and Y and Z")?
- Is coverage complete (all described behaviors have ACs)?
- Are there ACs that overlap or contradict each other?

## Structure
- Appropriate item type for content?
- Description clearly explains purpose?
- References (depends_on, implements, relates_to) are valid?
- Status fields consistent (maturity vs implementation)?

## Trait Usage
- Applied traits are appropriate (behavior applies to this spec)?
- Cross-cutting behaviors that appear 3+ times should use traits
- Trait ACs don't conflict with spec-specific ACs

## Testability
- Can each AC be validated with automated tests?
- Are preconditions (given) realistic and reproducible?
- Are actions (when) specific enough to implement?

Format: ## headers, bullet lists, severity ratings.
MUST-FIX | SHOULD-FIX | SUGGESTION
PROMPT
)"
```

### Output

Written to `/tmp/codex-spec-review.md`.

## General Mode

```
/codex "analyze the error handling patterns in src/cli/"
/codex "refactor parser module for clarity"
```

### Defaults

- **Model:** `gpt-5.3-codex`
- **Reasoning:** `medium`
- **Sandbox:** `danger-full-access`

### Command Assembly

```bash
codex exec \
  -m gpt-5.3-codex \
  -c model_reasoning_effort="medium" \
  -s danger-full-access \
  --skip-git-repo-check \
  "Your prompt here. Write output to /tmp/codex-output.md"
```

## Resuming Sessions

```bash
# Resume last session with new prompt (positional arg)
codex exec --skip-git-repo-check resume --last "follow-up prompt"

# Resume last session with prompt from stdin
echo "follow-up prompt" | codex exec --skip-git-repo-check resume --last -

# Resume with no additional prompt
codex exec --skip-git-repo-check resume --last
```

When resuming, config flags (`-c`, `-m`, `-s`) are accepted and override the original session's settings. All flags must go between `exec` and `resume`.

## Output Convention

All Codex output is written to `/tmp/codex-*` files:

| Mode | Output file |
|------|------------|
| PR review | `/tmp/codex-pr-{number}-review.md` |
| Plan review | `/tmp/codex-plan-review.md` |
| Spec review | `/tmp/codex-spec-review.md` |
| General | `/tmp/codex-output.md` |

After every Codex run:
1. Report the output file path to the user
2. Summarize key findings
3. For PR reviews, also post comments to GitHub via `gh`

## Error Handling

- If `codex exec` exits non-zero, report the error and ask the user how to proceed
- If output file is empty or missing, Codex may have hit a context or timeout issue — re-run without stderr suppression to diagnose
- For review modes, do NOT suppress stderr — review errors (auth failures, API issues) should be visible
- For general mode, append `2>/dev/null` to suppress thinking tokens unless debugging

### Preflight Checks

Before PR review, verify `gh` auth is working:

```bash
gh auth status
```

If auth fails, instruct the user to run `gh auth login` before retrying.

## Overrides

Users can override any preset:

```
/codex review #123 --model gpt-5.2 -c model_reasoning_effort="xhigh"
/codex "prompt" -c model_reasoning_effort="high"
```

Parse overrides from the user's message and map to CLI flags:
- `--model X` or `-m X` → `-m X`
- `--effort X` → `-c model_reasoning_effort="X"` (translate to config flag)

## Handling Complex Prompts

When prompts contain shell-unsafe characters (quotes, backticks, special characters, or multi-line content), use the **prompt-file pattern** instead of inline quoting:

```bash
# 1. Write prompt to temp file (use mktemp for safety)
PROMPT_FILE=$(mktemp /tmp/codex-prompt.XXXXXX)
cat > "$PROMPT_FILE" << 'EOF'
Review the code for:
- Edge cases with special chars like `$var` and "quoted" strings
- Multi-line logic that's hard to escape inline
- Patterns matching {curly} braces
EOF

# 2. Use $(cat file) to inject the prompt
codex exec \
  -m gpt-5.3-codex \
  -c model_reasoning_effort="medium" \
  -s danger-full-access \
  --skip-git-repo-check \
  "$(cat "$PROMPT_FILE")"

# 3. Clean up
rm -f "$PROMPT_FILE"
```

### When to Use This Pattern

| Prompt Content | Approach |
|----------------|----------|
| Simple one-liner | Inline quotes work fine |
| Contains `$`, backticks, quotes | Use prompt file |
| Multi-line with formatting | Use prompt file |
| Generated or dynamic content | Use prompt file |

### Why Prompt-File Over Heredocs?

Quoted heredocs (`<<'DELIM'...DELIM`) handle quotes, backticks, and `$` literally — they don't cause parsing failures. However, the prompt-file pattern offers practical advantages:

- **Delimiter collision**: If your prompt contains the delimiter string itself, heredocs fail
- **Mixed expansion**: When you need `$var` expanded in some places but literal in others, heredocs require awkward escaping
- **Debuggability**: You can `cat "$PROMPT_FILE"` to verify exact content before running
- **Reusability**: Same prompt file can be used across multiple commands

For simple prompts, heredocs work fine. Use prompt-files when prompts are complex, generated dynamically, or need inspection before use.

## Tips

- Always use `--skip-git-repo-check` — this project uses a shadow branch worktree that confuses Codex's git detection
- For large diffs, pipe through `head -2000` before giving to Codex to stay within context
- Codex has full access and can run `gh`, `kspec`, `npm`, etc. directly — instruct it to use these tools in your prompt
- Tell Codex to run `kspec` from the project root, not from inside `.kspec/` (same gotcha agents hit)
- Use `codex exec review` for straightforward diff reviews (has `--base`, `--commit`, `--uncommitted` flags built in)
- Do NOT use `--full-auto` — it forces `workspace-write` sandbox, overriding `danger-full-access`
