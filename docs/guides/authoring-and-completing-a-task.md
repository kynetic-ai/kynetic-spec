# Authoring and Completing a Task

This guide covers the full task lifecycle: creating a task, working it, annotating acceptance criteria, and closing the loop. By the end, you will have completed a task with traceable commits and AC coverage.

## Prerequisites

- Completed the [Getting Started](../getting-started/index.md) section
- At least one spec with acceptance criteria in your project

## Steps

### 1. Create or find a task

If a task already exists, find it:

```bash
kspec tasks ready
```

If you need to create one from a spec:

```bash
kspec derive @your-spec
```

This creates a task linked to the spec's acceptance criteria. Check the task details:

```bash
kspec task get @task-your-spec
```

For all task creation options, run `kspec task add --help`.

### 2. Start the task

Move the task into active work:

```bash
kspec task start @task-your-spec
```

### 3. Create a branch

Create a deterministic branch for the task:

```bash
kspec task branch @task-your-spec
```

This creates or resumes a branch named after the task. Reviewers and automated agents can find it consistently.

### 4. Read the acceptance criteria

Before writing any code, read every AC on the spec:

```bash
kspec item get @your-spec
```

For each AC, identify what code to write, what edge cases to consider, and what tests to create. Record your approach:

```bash
kspec task note @task-your-spec \
  "Approach: implementing AC-1 with existing auth helper, AC-2 needs new validation logic."
```

### 5. Write tests first

For each acceptance criterion, create an annotated test:

```javascript
// AC: @your-spec ac-1
it('should redirect to dashboard after valid login', () => {
  // test implementation
});
```

The `AC:` annotation links the test to the criterion it proves. Write test skeletons before implementing production code — this ensures coverage is driven by the spec.

### 6. Implement the feature

Write the code to make your tests pass. Add notes when you make significant decisions:

```bash
kspec task note @task-your-spec \
  "Used exponential backoff for retry logic. Max 3 retries based on API rate limits."
```

### 7. Commit with trailers

Commit your changes with task and spec trailers:

```bash
git add src/ tests/
git commit -m "feat: add user login flow

Task: @task-your-spec
Spec: @your-spec"
```

The `Task:` and `Spec:` trailers let kspec trace commits back to the governing spec.

### 8. Verify AC coverage

Before submitting, confirm each AC has a test:

```bash
kspec validate
```

This reports any uncovered acceptance criteria.

### 9. Submit for review

When the work is complete:

```bash
kspec task submit @task-your-spec
```

This moves the task to `pending_review`. A reviewer will evaluate the work against the acceptance criteria.

### 10. Complete after merge

After the review approves the work and it is merged:

```bash
kspec task complete @task-your-spec \
  --reason "Merged. Implemented login flow with AC coverage."
```

The task is now complete with a traceable reason.

## Verification

Run the following to confirm the task lifecycle is complete:

```bash
kspec task get @task-your-spec
```

The output should show `Status: completed` with your completion reason. You can also trace the work:

```bash
kspec log @task-your-spec
```

This shows all commits linked to the task through trailers.
