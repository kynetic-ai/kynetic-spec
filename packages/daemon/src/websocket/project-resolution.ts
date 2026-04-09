/**
 * WebSocket Project Resolution
 *
 * Extracts and resolves the project path for a WebSocket connection request.
 * Used by the WebSocket beforeHandle hook in server.ts.
 *
 * Task: @01KKBD6KH5F5MVC5BXV2NQG474
 */

import type { ProjectContextManager } from "../project-context.js";

export interface ResolveWebSocketProjectOptions {
  request: Request;
  manager: ProjectContextManager;
  fallbackPath: string;
  onProjectRegistered?: (projectPath: string) => Promise<void>;
}

export interface ResolveWebSocketProjectResult {
  resolvedPath: string;
  wasRegistered: boolean;
}

/**
 * Resolves the project path for a WebSocket connection request.
 *
 * Extracts the project path from X-Kspec-Dir header or ?project= query param,
 * registers it if new, awaits watcher startup for newly-registered projects,
 * and fires onProjectRegistered after the watcher is confirmed running.
 *
 * AC: @multi-directory-daemon ac-21, ac-22, ac-23, ac-34, ac-35, ac-19
 */
export async function resolveWebSocketProject(
  options: ResolveWebSocketProjectOptions,
): Promise<ResolveWebSocketProjectResult> {
  const { request, manager, fallbackPath, onProjectRegistered } = options;

  // AC: @multi-directory-daemon ac-34 - Browser WebSocket API doesn't support custom headers,
  // so we also accept project path as query parameter
  const url = new URL(request.url, `http://${request.headers.get("host")}`);
  const projectPath =
    request.headers.get("X-Kspec-Dir") || url.searchParams.get("project") || undefined;

  if (!manager) {
    return { resolvedPath: fallbackPath, wasRegistered: false };
  }

  let projectContext;
  let wasRegistered = false;
  if (projectPath) {
    // Explicit project specified
    // AC: @multi-directory-daemon ac-4 - auto-register
    const result = manager.getOrRegisterProject(projectPath);
    projectContext = result.context;
    wasRegistered = result.wasRegistered;
    if (result.wasRegistered) {
      // AC: @multi-directory-daemon ac-35 - Watcher must be started before cached data is served
      // AC: @multi-directory-daemon ac-19 - Registration fails if watcher creation fails
      await manager.startWatcher(projectContext.path);

      // Start session sync only after watcher is confirmed running
      if (onProjectRegistered) {
        void onProjectRegistered(projectContext.path).catch((syncError) => {
          console.error(
            `[daemon] Failed to start session sync for WebSocket-registered ${projectContext.path}:`,
            syncError,
          );
        });
      }
    }
  } else {
    // AC: @multi-directory-daemon ac-22, ac-23 - Use default or reject
    try {
      projectContext = manager.getProject();
    } catch (err: unknown) {
      // AC: @multi-directory-daemon ac-23 - Reject when no default
      if (err instanceof Error && err.message.includes("No default project configured")) {
        throw new Error("No project specified", { cause: err });
      }
      throw err;
    }
  }

  return { resolvedPath: projectContext.path, wasRegistered };
}
