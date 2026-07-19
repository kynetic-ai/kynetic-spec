export function agentStatusFixture(overrides: Record<string, unknown> = {}) {
  return {
    dispatch_enabled: false,
    active_invocations: [],
    queued_invocations: [],
    queue_depth: 0,
    agent_definitions: [],
    degraded: { active: false, reason: "", enteredAt: null },
    global_authority: "stopped",
    projection: "stopped",
    cleanup_state: { status: "idle", entries: [] },
    active_count: 0,
    held_count: 0,
    held_tasks: [],
    task_controls: [],
    degraded_targets: [],
    ...overrides,
  };
}
