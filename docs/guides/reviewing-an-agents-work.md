# Reviewing an Agent's Work

This guide covers how to review work that an AI agent has submitted. By the end, you will know how to create a review record, evaluate work against acceptance criteria, and provide actionable feedback that the agent can address.

## Prerequisites

- Completed the [Getting Started](../getting-started/index.md) section
- A task in the `pending_review` state (the agent has run `kspec task submit`)

## Steps

### 1. Find tasks awaiting review

List tasks that are ready for review:

```bash
kspec task list --status pending_review
```

Pick a task to review and read its details:

```bash
kspec task get @task-some-feature
```

The output shows the task's spec reference, notes from the agent, and current status.

### 2. Read the spec and acceptance criteria

Load the spec to understand what the work should accomplish:

```bash
kspec item get @some-feature
```

Read every acceptance criterion carefully. These are the objective measures you will evaluate against.

### 3. Create a review record

Start the review by creating a review record:

```bash
kspec review create @task-some-feature
```

This creates a review linked to the task and returns a review reference you will use for threads.

For all review options, run `kspec review create --help`.

### 4. Examine the implementation

Review the code changes the agent produced. Check the branch:

```bash
git log --oneline origin/dev..HEAD
git diff origin/dev
```

For each acceptance criterion, verify:

- **Is there a test annotated with `AC: @spec ac-N`?** Every AC should have at least one test.
- **Does the test actually prove the AC?** A test that passes regardless of the feature is not coverage.
- **Does the implementation satisfy the AC's "then" clause?** Read the AC literally.

### 5. Add review threads

For each finding, add a thread to the review. Threads have a severity:

```bash
kspec review thread @review-ref \
  --severity blocker \
  --body "AC-2 has no test coverage. The spec requires validation of expired tokens, but no test exercises this path."
```

Severity levels:

- **blocker** — Must be fixed before approval. Missing AC coverage, broken behavior, or security issues.
- **question** — Needs clarification. The reviewer is unsure whether the approach is correct.
- **nit** — Minor style or preference issue. Non-blocking.

For the full set of thread options, run `kspec review thread --help`.

### 6. Submit your verdict

After examining all ACs and adding threads, submit your verdict:

```bash
kspec review submit @review-ref --verdict approved
```

Or if changes are needed:

```bash
kspec review submit @review-ref --verdict needs_work
```

A `needs_work` verdict moves the task back so the agent can address your feedback. The agent reads your review threads and works through them in a fix cycle.

### 7. Verify the fix cycle

After the agent resubmits, review again. Check that:

- All blocker threads are resolved
- The agent replied to threads explaining what changed
- New changes did not introduce regressions

Create a new review record for each review cycle — do not reopen the previous one.

## Verification

After approving the work, confirm the task status:

```bash
kspec task get @task-some-feature
```

The task should be in `pending_review` with an approved review. The task can now be completed and the work merged:

```bash
kspec review for-task @task-some-feature
```

This lists all reviews for the task, showing the approval chain and any prior fix cycles.
