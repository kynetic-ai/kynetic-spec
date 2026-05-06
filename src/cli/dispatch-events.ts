/**
 * Shared CLI helper for emitting task state-change events to the daemon's
 * dispatch engine. Centralises the fire-and-forget POST to
 * `/api/agent/events` so every task transition site in the task command
 * (start, submit, complete, block, unblock, cancel, etc.) shares one URL
 * contract — the request goes to the metadata-advertised `api_url` returned
 * by `getRunningDaemonClient()`, never to a separately constructed URL.
 *
 * AC: @daemon-network-endpoint-contract ac-clients-use-metadata
 * AC: @trait-daemon-endpoint-consumer ac-uses-reported-endpoint
 * AC: @daemon-agent-dispatch ac-2, ac-7
 * AC: @agent-dispatch-engine ac-18
 */

import { getRunningDaemonClient } from "./daemon-client.js";

export interface DispatchEventInput {
  taskId: string;
  taskRef: string;
  fromStatus: string;
  toStatus: string;
  projectPath?: string;
}

/**
 * Post a task state change event to the daemon dispatch engine.
 * Fails silently — dispatch requires a running daemon; if absent, this is a no-op.
 *
 * AC: @agent-dispatch-engine ac-18 — Suppress self-triggering when running
 * inside a dispatched agent invocation. The file watcher will independently
 * detect the change, so the CLI event would be redundant and causes stale
 * queue entries to accumulate. NOTE: This relies on the daemon's file
 * watcher being active. If the watcher is temporarily down, dispatched
 * agents' task mutations won't produce dispatch events until the watcher
 * recovers and diffs the changed state.
 */
export async function postDispatchEvent(opts: DispatchEventInput): Promise<void> {
  if (process.env.KSPEC_SESSION_ID) return;

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  const endpoint = getRunningDaemonClient();
  if (!endpoint) return;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.projectPath) {
    headers["X-Kspec-Dir"] = opts.projectPath;
  }

  try {
    await fetch(`${endpoint.apiUrl}/api/agent/events`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        task_id: opts.taskId,
        task_ref: opts.taskRef,
        from_status: opts.fromStatus,
        to_status: opts.toStatus,
        timestamp: Date.now(),
      }),
      signal: AbortSignal.timeout(1000), // 1s timeout — fire-and-forget
    });
  } catch {
    // Silent fail — daemon unreachable or dispatch engine not running
  }
}
