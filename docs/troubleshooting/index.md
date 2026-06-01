# Troubleshooting

The Troubleshooting section is an index of recovery procedures keyed by the symptom you observe in your own output or in your agent's output. Each entry describes the symptom, explains what it means, and walks you through the recovery steps.

- [Shadow Branch Is Out of Sync With Remote](./shadow-branch-out-of-sync.md) — local and remote shadow branches have diverged
- [Shadow Branch Worktree Is Broken or Missing](./shadow-branch-worktree-broken.md) — `.kspec/` directory is missing or disconnected
- [Daemon Cannot Start Because the Port Is Already in Use](./daemon-port-in-use.md) — port 3456 is occupied by another process
- ["Cannot Run kspec From Inside the Shadow Directory" Error](./cannot-run-from-inside-kspec.md) — your working directory is inside `.kspec/`
- [Upgrade Reports a Pre-Plan State or Partial Scaffold](./upgrade-pre-plan-state.md) — project needs newer configuration after a version upgrade
- [`entity_storage_incompatible`: Project Storage Format Mismatch](./entity-storage-incompatible.md) — plan, review, or resource command fails because the project is not on folder-backed storage
- [Plan or Review Index Has Drifted From Folder Contents](./plan-or-review-index-drift.md) — the project-wide index disagrees with the on-disk folders; rebuild it
- [Agent Dispatch Refuses to Assign a Task](./dispatch-refuses-to-assign.md) — a task is not being picked up by the dispatch engine
- [A Review Is Blocking Merge With an Unresolved Thread](./review-blocking-merge.md) — merge gate rejects work due to an open blocker thread
- [Runner Validation Failures](./runner-validation-failures.md) — diagnose `kspec agent runners validate` errors by `reason` code
