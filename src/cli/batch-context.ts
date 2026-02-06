/**
 * Batch execution context — minimal leaf module with zero kspec imports.
 *
 * Provides the batch-mode flag, exit interceptor, and output capture
 * used by the batch execution engine. Kept dependency-free to avoid
 * circular imports.
 */

// ── Batch Mode Flag ──────────────────────────────────────────────────

let _batchMode = false;

/** Enable/disable batch mode. Only set during atomic batch execution. */
export function setBatchMode(enabled: boolean): void {
  _batchMode = enabled;
}

/** Check if we're inside a batch execution (atomic mode). */
export function isBatchMode(): boolean {
  return _batchMode;
}

// ── Exit Interceptor ─────────────────────────────────────────────────

/**
 * Thrown when process.exit() is called during batch dispatch.
 * Caught by the batch executor to record the exit code as a failure.
 */
export class BatchExitError extends Error {
  code: number;
  constructor(code: number) {
    super(`process.exit(${code}) called during batch execution`);
    this.name = "BatchExitError";
    this.code = code;
  }
}

let _originalExit: typeof process.exit | null = null;

/**
 * Override process.exit to throw BatchExitError instead.
 * Must be paired with uninstallExitInterceptor() in a finally block.
 */
export function installExitInterceptor(): void {
  if (_originalExit) return; // Already installed
  _originalExit = process.exit;
  process.exit = ((code?: number) => {
    throw new BatchExitError(code ?? 0);
  }) as typeof process.exit;
}

/** Restore the original process.exit. */
export function uninstallExitInterceptor(): void {
  if (_originalExit) {
    process.exit = _originalExit;
    _originalExit = null;
  }
}

// ── Output Capture ───────────────────────────────────────────────────

/**
 * Captures console.log/error/warn output during a single command dispatch.
 * Stores captured lines and restores originals on stop.
 */
export class OutputCapture {
  private _lines: string[] = [];
  private _origLog: typeof console.log | null = null;
  private _origError: typeof console.error | null = null;
  private _origWarn: typeof console.warn | null = null;

  /** Start capturing console output. */
  start(): void {
    this._lines = [];
    this._origLog = console.log;
    this._origError = console.error;
    this._origWarn = console.warn;

    const capture = (...args: unknown[]) => {
      this._lines.push(
        args
          .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
          .join(" "),
      );
    };

    console.log = capture;
    console.error = capture;
    console.warn = capture;
  }

  /** Stop capturing and restore console methods. */
  stop(): void {
    if (this._origLog) console.log = this._origLog;
    if (this._origError) console.error = this._origError;
    if (this._origWarn) console.warn = this._origWarn;
    this._origLog = null;
    this._origError = null;
    this._origWarn = null;
  }

  /** Get captured output as a single string. */
  getOutput(): string {
    return this._lines.join("\n");
  }
}
