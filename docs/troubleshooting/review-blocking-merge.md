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

Look for threads with kind "blocker" that are still open. For each unresolved thread, reply with what you did to address it, then resolve it:

```bash
kspec review reply @review-ref --thread <thread-id> --body "Fixed: description of what changed"
kspec review resolve @review-ref --thread <thread-id>
```

If the disposition is stale because new commits were pushed after the verdict, refresh the review's comparison context so the reviewer can re-evaluate against the current code:

```bash
kspec review refresh @review-ref --head <new-commit-hash>
```

This updates the review's subject to point at the new commits, creating a `subject_refreshed` event. The reviewer can then inspect the updated diff and issue a new verdict on the same review record.

## Verification

After resolving all threads, check the review disposition:

```bash
kspec review get @review-ref
```

A healthy outcome shows the disposition as "approved" with no unresolved blocker threads and all required checks passing. The merge gate should now allow the work to proceed.
