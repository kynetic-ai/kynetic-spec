/**
 * Active Session Registry
 *
 * Runtime registry of active sessions that allows actions to deliver prompts
 * to live sessions. Maps session identifiers to handles providing prompt
 * delivery, state query, and close request capabilities.
 *
 * The registry is volatile (daemon lifetime). It is owned by the dispatch
 * engine and shared with the action executor via dependency injection.
 *
 * AC: @active-session-registry ac-1 through ac-4
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * The possible states of a session in the registry.
 */
export type SessionState = "idle" | "prompting" | "closed";

/**
 * Minimal interface for interacting with a live session.
 *
 * Wraps the underlying ACP client without exposing it — sendPrompt()
 * calls the client internally. This keeps action execution decoupled
 * from session internals.
 *
 * AC: @active-session-registry ac-1
 */
export interface SessionHandle {
  /** Deliver a prompt to the session. Rejects if the session is closed. */
  sendPrompt(prompt: string): Promise<void>;
  /** Query the current session state. */
  getState(): SessionState;
  /** Request the session to close with the given reason. */
  requestClose(reason: string): void;
}

// ─── Registry ────────────────────────────────────────────────────────────────

/**
 * Registry of active sessions keyed by session identifier.
 *
 * Thread safety for prompt delivery comes from the prompt queue in the
 * session handle implementation (provided by the invocation runner).
 *
 * AC: @active-session-registry ac-1 through ac-4
 */
export class SessionRegistry {
  private readonly sessions = new Map<string, SessionHandle>();

  /**
   * Register a session handle for the given identifier.
   *
   * AC: @active-session-registry ac-1
   */
  register(id: string, handle: SessionHandle): void {
    this.sessions.set(id, handle);
  }

  /**
   * Remove a session from the registry.
   * After unregistering, get() returns undefined for this identifier.
   *
   * AC: @active-session-registry ac-2
   */
  unregister(id: string): boolean {
    return this.sessions.delete(id);
  }

  /**
   * Look up a session handle by identifier.
   * Returns the handle if the session is active, or undefined if it has
   * been closed or was never registered.
   *
   * AC: @active-session-registry ac-3
   */
  get(id: string): SessionHandle | undefined {
    return this.sessions.get(id);
  }

  /**
   * List all currently registered session identifiers.
   */
  listActive(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * Number of currently registered sessions.
   */
  get size(): number {
    return this.sessions.size;
  }

  /**
   * Close all registered sessions and clear the registry.
   * Used during daemon shutdown to ensure clean teardown.
   *
   * AC: @active-session-registry ac-4
   */
  closeAll(reason: string): void {
    for (const [id, handle] of this.sessions) {
      try {
        handle.requestClose(reason);
      } catch {
        // Best-effort close — don't let one failure prevent others
      }
    }
    this.sessions.clear();
  }
}
