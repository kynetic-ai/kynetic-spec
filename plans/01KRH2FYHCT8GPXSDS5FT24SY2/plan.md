# Dispatch Workspace Cleanup Classification Hardening

## Summary

Tighten the dispatch workspace cleanup contract after the in-flight cleanup audit found two cleanup classifications that were real policy decisions rather than implementation bugs:

1. Corrupt per-workspace metadata under the dispatch worktree root is cleanup-eligible when trusted registry/protection state is available and does not identify active, in-flight, or provisioning ownership. Future recovery should come from task/registry state, not from preserving corrupt artifact-local metadata indefinitely.
2. The configured dispatch worktree root is dispatch-owned storage. Unknown files or directories directly under that root are not treated as operator/user data; cleanup may remove them unless trusted protection state classifies them as active/in-flight/provisioning or registry unavailability requires fail-closed preservation.

This plan intentionally keeps the existing fail-closed registry behavior: if the registry or centralized protection state cannot be loaded or trusted, cleanup still blocks blind destructive deletion of dispatcher-managed artifacts.

## Specs

```yaml
[]
```

## Tasks

derive_from_specs: false

```yaml
- title: Clarify dispatch cleanup classification specs
  slug: task-clarify-dispatch-cleanup-classification-specs
  priority: 1
  tags: [spec-update, dispatch, workspace, cleanup]
  spec_ref: "@dispatch-workspace-cleanup-policy"
  description: |
    What:
    - Update existing specs to make the cleanup classification policy explicit.
    - Add the following acceptance criterion to @dispatch-workspace-cleanup-policy:

      AC id: ac-corrupt-metadata-cleanup-eligible
      Given: Registry state and centralized cleanup protection state are loaded and trusted, and cleanup finds a dispatcher-managed artifact under the configured dispatch worktree root whose per-workspace metadata is missing, unreadable, or unparseable.
      When: No non-closed registry record, active task ref, in-flight task ref, or provisioning ownership classifies that artifact as protected.
      Then: Cleanup may classify the artifact-local metadata as untrusted and remove the artifact as cleanup-eligible instead of preserving it for metadata recovery.

    - Add the following acceptance criterion to @dispatch-workspace-cleanup-policy:

      AC id: ac-dispatch-root-unknown-entries-owned
      Given: Registry state and centralized cleanup protection state are loaded and trusted, and cleanup finds an unknown file or directory directly under the configured dispatch worktree root.
      When: The entry is not equal to, contained by, or otherwise associated with a protected active, in-flight, provisioning, or non-closed workspace artifact.
      Then: Cleanup treats the entry as dispatch-owned garbage and may remove it instead of preserving it as user/operator data.

    - Add the following acceptance criterion to @dispatch-workspace-registry:

      AC id: ac-task-state-drives-recovery-after-untrusted-artifact-cleanup
      Given: Cleanup removes a dispatch artifact because its artifact-local metadata is untrusted and no trusted protection state classifies it as protected.
      When: A later dispatch reconciliation or scheduling cycle evaluates a non-terminal task that still needs work.
      Then: Recovery is driven from trusted task and registry state; the task can be requeued, reprovisioned, or marked stale with actionable recovery detail without relying on the removed corrupt artifact metadata.

    - Leave @dispatch-workspace-cleanup-policy and @dispatch-workspace-registry in implementation status in_progress with --no-cascade until the regression/evidence task proves the clarified behavior.
    - Do not weaken @dispatch-workspace-cleanup-policy ac-ambiguous-protection-blocks-blind-deletion: registry/protection load failures still fail closed. These new ACs only classify artifact-local corrupt metadata or unknown root entries after registry/protection state is trusted.

    Why:
    The in-flight cleanup audit found that current cleanup already removes corrupt per-workspace metadata and arbitrary entries under .kspec-worktrees. Jacob confirmed both behaviors are intended: corrupt artifact metadata should be cleaned and recovered from task state, and the dispatch worktree root is dispatch-owned storage.

    How:
    - Use kspec item ac add for the three ACs above.
    - Use kspec item set @dispatch-workspace-cleanup-policy --status in_progress --no-cascade and kspec item set @dispatch-workspace-registry --status in_progress --no-cascade unless the follow-up evidence task has already landed in the same change set.
    - Verify each AC appears on the intended existing spec with kspec item get.
    - Run kspec validate --refs --warnings-ok after the spec updates.

    Testing:
    - kspec item get @dispatch-workspace-cleanup-policy
    - kspec item get @dispatch-workspace-registry
    - kspec validate --refs --warnings-ok

    Covers: @dispatch-workspace-cleanup-policy ac-corrupt-metadata-cleanup-eligible, ac-dispatch-root-unknown-entries-owned; @dispatch-workspace-registry ac-task-state-drives-recovery-after-untrusted-artifact-cleanup

- title: Add cleanup classification regression coverage
  slug: task-add-cleanup-classification-regression-coverage
  priority: 1
  tags: [tests, dispatch, workspace, cleanup]
  spec_ref: "@dispatch-workspace-cleanup-policy"
  depends_on:
    - "@task-clarify-dispatch-cleanup-classification-specs"
  description: |
    What:
    - Add focused regression coverage in tests/dispatch-workspace-cleanup.test.ts for the clarified cleanup classifications.
    - Add a test proving a dispatch worktree with corrupt or unparseable .kspec-dispatch-workspace.json is removed when:
      - the workspace registry loads successfully;
      - no non-closed registry record protects the workspace;
      - no activeTaskRefs option protects the task; and
      - the artifact is under the configured dispatch worktree root.
    - Add a test proving an unknown file or directory directly under .kspec-worktrees is removed when registry/protection state is trusted and no protected workspace path contains or equals it.
    - Preserve or extend existing negative-control coverage proving registry/protection load failure still blocks blind deletion across destructive surfaces.
    - Preserve or extend existing positive protection coverage proving active, in-flight, provisioning, and non-closed registry-owned artifacts are not removed.
    - Add a recovery-path test in tests/agent-dispatch-engine.test.ts near the existing "reprovisions missing in_progress worker worktrees during dispatch bootstrap" coverage. The test must seed an automation-eligible non-terminal task, provision a dispatch workspace, corrupt or remove the artifact-local metadata/registry association enough for reconcileDispatchWorkspaceArtifacts to remove the artifact, then start DispatchEngine with a worker agent and a runInvocation/_spawnInvocation spy. Assert that the task remains dispatch-eligible, a fresh workspace is provisioned for the same task ref, and the task is not discarded solely because the corrupt artifact was cleaned.
    - If the current implementation does not satisfy the clarified ACs, update src/agent-runtime/workspace.ts and/or dispatch bootstrap recovery so classification distinguishes:
      - registry/protection state unavailable or untrusted => fail closed / preserve or block;
      - artifact-local metadata corrupt under trusted registry/protection state with no protected owner => cleanup-eligible;
      - unknown direct entries under the dispatch-owned worktree root with no protected owner => cleanup-eligible.
    - Once tests and implementation evidence pass, set @dispatch-workspace-cleanup-policy and @dispatch-workspace-registry implementation status to implemented only if no other direct pending tasks keep those specs reopened.

    Why:
    The audit probes showed the intended cleanup behavior exists but was not explicitly covered by spec-owned regression tests. The clarified policy should prevent future fixes from accidentally preserving corrupt metadata forever or treating dispatch-owned scratch entries as user data, while keeping the earlier in-flight protection fail-closed guarantees intact.

    How:
    - Reuse existing helpers in tests/dispatch-workspace-cleanup.test.ts such as seedRepo, provisionDispatchWorkspace, reconcileDispatchWorkspaceArtifacts, readRegistryWorkspaces, and activeTaskRefs options.
    - Keep test cases behavioral; do not add source-scanning tests.
    - Use deterministic temp repos and valid test ULIDs via testUlid/testUlids helpers.
    - When testing corrupt metadata, intentionally create or provision a workspace, remove or avoid the matching registry record, corrupt .kspec-dispatch-workspace.json, run reconcileDispatchWorkspaceArtifacts, and assert the workspace path no longer exists.
    - When testing unknown root entries, create a marker file and a marker directory directly under .kspec-worktrees, run reconcileDispatchWorkspaceArtifacts, and assert both are removed.
    - When testing task-state recovery after corrupt artifact cleanup, follow the existing dispatch bootstrap test pattern: create an automation-eligible non-terminal task and worker agent, remove the corrupt artifact through cleanup, start DispatchEngine, and assert the worker invocation/provisioning path still runs for the task ref.
    - Include explicit assertions that registry-load failure behavior remains fail-closed, either by extending the existing parse-failure test or adding a focused assertion in the same file.

    Testing:
    - npm test -- --fresh tests/dispatch-workspace-cleanup.test.ts
    - npm run typecheck
    - kspec validate --refs --warnings-ok
    - kspec validate --alignment --warnings-ok
    - kspec validate --completeness --warnings-ok

    Covers: @dispatch-workspace-cleanup-policy ac-corrupt-metadata-cleanup-eligible, ac-dispatch-root-unknown-entries-owned, ac-ambiguous-protection-blocks-blind-deletion, ac-active-inflight-provisioning-artifact-preserved, ac-protection-applies-to-every-destructive-surface; @dispatch-workspace-registry ac-task-state-drives-recovery-after-untrusted-artifact-cleanup, ac-partial-provisioning-classified-before-cleanup
```

## Implementation Notes

### Boundary decisions

- Registry/protection failure remains conservative. If cleanup cannot load trusted centralized state, it must not blindly delete dispatcher-managed artifacts.
- Corrupt or missing artifact-local metadata is different from registry/protection failure. Once trusted centralized state is available and no owner/protection classification exists, the artifact can be treated as untrusted local garbage.
- The dispatch worktree root is dispatch-owned. Operators should not place durable data directly under `.kspec-worktrees`; cleanup is allowed to remove unknown root entries that are not associated with protected workspace paths.
- Recovery after artifact cleanup comes from task and registry state. A non-terminal task that still needs work should be requeued, reprovisioned, or marked stale/actionable by normal dispatch reconciliation rather than depending on corrupt per-workspace metadata.

### Relationship to prior plans

This is a narrow follow-up to @plan-dispatch-workspace-in-flight-cleanup-protection. It does not replace the central protection helper, active/in-flight task-ref protection, or fail-closed registry behavior from that plan. It only clarifies the cleanup-eligible side of the classification boundary.

