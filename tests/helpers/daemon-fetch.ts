/**
 * Bounded daemon fetch helper for test infrastructure.
 *
 * Every daemon-facing HTTP probe in test code must reach a bounded terminal
 * outcome: a real response, a typed network error, or an `AbortError` /
 * `TimeoutError` from the helper's internal abort signal. Without a client-
 * side timeout, a daemon that accepts the connection but never writes a
 * response leaves a bare `fetch(url)` waiting up to the OS TCP timeout
 * (~75 seconds on Linux) — far past the readiness budgets the call sites
 * intend, and well past the per-test budgets the suite runs under.
 *
 * The helper composes:
 *   - An internal `AbortSignal.timeout(timeoutMs)` so the request aborts
 *     within the caller's budget regardless of socket-level behavior.
 *   - The caller's optional `signal` so cleanup aborts (e.g.
 *     `onTestFinished(() => controller.abort())`) still take effect.
 *
 * Body reads inherit the same signal because Node's `fetch` propagates the
 * `Response.body` stream's abort to the request signal — a daemon that
 * stalls mid-body will still bound the consumer.
 *
 * AC: @daemon-test-teardown-boundedness ac-daemon-observations-are-bounded
 */

const DEFAULT_TIMEOUT_MS = 5_000;

export interface BoundedDaemonFetchOptions extends Omit<RequestInit, "signal"> {
  /**
   * Abort budget in ms. The internal `AbortSignal.timeout(timeoutMs)` fires
   * regardless of socket-level behavior, so an unresponsive endpoint can never
   * keep the consumer in flight past this budget. Defaults to 5000ms — high
   * enough to absorb a slow CI runner's TLS / DNS / startup latency, low
   * enough that a stalled daemon does not exhaust a test's outer budget.
   */
  timeoutMs?: number;
  /**
   * Caller-provided abort signal. Composed with the internal timeout signal
   * so either source aborts the request. Pass the signal from a cleanup
   * `AbortController` so a test that fails mid-request still tears down the
   * in-flight socket on `onTestFinished`.
   */
  signal?: AbortSignal | null;
}

/**
 * Bounded `fetch` replacement for daemon-facing test probes.
 *
 * Replace bare `await fetch(daemonUrl, ...)` call sites in test fixtures and
 * lifecycle tests with this helper so a stalled endpoint cannot exhaust the
 * caller's per-test budget. The helper is shaped as a drop-in `fetch`
 * substitute: it returns `Promise<Response>` so existing `.json()` /
 * `.text()` / `.ok` patterns work unchanged.
 */
export async function boundedDaemonFetch(
  url: string,
  options: BoundedDaemonFetchOptions = {},
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal: external, ...init } = options;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = external ? AbortSignal.any([timeoutSignal, external]) : timeoutSignal;
  return fetch(url, { ...init, signal });
}
