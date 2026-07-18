# A Review Is Blocking Merge With an Unresolved Thread

You try to merge approved work and the merge gate rejects it, citing an unresolved thread in the review record. Alternatively, the review disposition shows "changes requested" even though you believe all feedback has been addressed.

## What This Means

kspec's [review system](../concepts/reviews.md) gates merges on three conditions: the review disposition must be "approved," all required checks must pass, and all blocker threads must be resolved. If any blocker thread remains open — even if a verdict of "approve" has been given — the merge gate will not open.

A thread stays unresolved until it is explicitly marked as resolved. Addressing the feedback in code does not automatically close the thread. The reviewer (or the author, if appropriate) must resolve it through the review interface.

This can also happen when the review's subject version is stale. If the author pushed new commits after the reviewer's verdict, the verdict applies to the old version and may no longer count toward the current disposition.

## How to Fix It

Find the review record for your task:

```bash
kspec review for-task @your-task
```

Read the full review to identify unresolved threads:

```bash
kspec review get @review-ref
```

Look for threads with kind "blocker" that are still open. If the feedback is already addressed in the reviewed version and no code change is needed, reply with the evidence and resolve the thread:

```bash
kspec review reply @review-ref --thread <thread-id> --body "Fixed: description of what changed"
kspec review resolve @review-ref --thread <thread-id>
```

If addressing the feedback requires code changes, or newer commits made the reviewed version stale, the reviewer records a `request_changes` verdict. That moves the task from `pending_review` to `needs_work`. Start the fix cycle, make and commit the changes, then reply to and resolve every addressed thread:

```bash
kspec task start @your-task
kspec review reply @review-ref --thread <thread-id> --body "Fixed: description of what changed"
kspec review resolve @review-ref --thread <thread-id>
kspec task submit @your-task
```

`kspec task submit` is valid after `kspec task start` has moved the `needs_work` task back to `in_progress`. Submission returns it to `pending_review`; the reviewer then creates a fresh review record for the new round, preserving the previous review in the history. Do not run `kspec task submit` while the task is already in `pending_review`.

## Verification

After resolving all threads, check the review disposition:

```bash
kspec review get @review-ref
```

A healthy outcome shows the disposition as "approved" with no unresolved blocker threads and all required checks passing. The merge gate should now allow the work to proceed.
