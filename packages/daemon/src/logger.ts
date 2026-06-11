/**
 * Daemon file logger with deterministic size-based rotation.
 *
 * Captures everything the daemon writes via console.log/warn/error into a
 * durable log file (default ~/.config/kspec/daemon.log) so detached runs
 * leave the same diagnostic trail as foreground runs. The tee is installed
 * by ./logger-install.js, which MUST be the first import in the daemon
 * entry point — see installDaemonConsoleTee for the ordering contract with
 * the command-route console interception.
 *
 * AC: @daemon-log-capture ac-detached-output-captured
 * AC: @daemon-log-capture ac-foreground-tee
 * AC: @daemon-log-capture ac-log-line-timestamps
 * AC: @daemon-log-capture ac-bounded-rotation
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { format } from "node:util";
import { DEFAULT_DAEMON_LOG_MAX_SIZE_BYTES } from "./pid.js";

export type DaemonLogLevel = "log" | "warn" | "error";

export interface DaemonLogWriterOptions {
  /** Absolute path to the active log file. */
  logPath: string;
  /** Maximum active-file size in bytes before rotation (default: 5 MiB). */
  maxSizeBytes?: number;
}

/**
 * Append-only log file writer with rotate-before-append semantics.
 *
 * When an append would push the active file past the size limit, the active
 * file is renamed to `<logPath>.1` (replacing any prior rotated generation)
 * and the line begins a fresh active file. Exactly one rotated generation is
 * retained, so total retained size is bounded at twice the limit plus at
 * most one captured line. Writes never throw — logging must never crash the
 * daemon.
 */
export class DaemonLogWriter {
  private readonly logPath: string;
  private readonly rotatedPath: string;
  private maxSizeBytes: number;
  private currentSizeBytes: number | null = null;
  private dirEnsured = false;

  constructor(options: DaemonLogWriterOptions) {
    this.logPath = options.logPath;
    this.rotatedPath = `${options.logPath}.1`;
    this.maxSizeBytes = options.maxSizeBytes ?? DEFAULT_DAEMON_LOG_MAX_SIZE_BYTES;
  }

  getLogPath(): string {
    return this.logPath;
  }

  getMaxSizeBytes(): number {
    return this.maxSizeBytes;
  }

  /** Apply a configured size limit once startup configuration is parsed. */
  setMaxSizeBytes(bytes: number): void {
    if (Number.isFinite(bytes) && Number.isInteger(bytes) && bytes > 0) {
      this.maxSizeBytes = bytes;
    }
  }

  /**
   * Append captured output to the log file, one timestamped line per
   * emitted line. Multi-line text gets a timestamp on every line.
   *
   * AC: @daemon-log-capture ac-log-line-timestamps
   */
  writeLine(level: DaemonLogLevel, text: string): void {
    try {
      const timestamp = new Date().toISOString();
      const stamped = text
        .replace(/\n$/, "")
        .split("\n")
        .map((line) => `${timestamp} [${level}] ${line}`)
        .join("\n");
      const entry = `${stamped}\n`;
      const entryBytes = Buffer.byteLength(entry, "utf8");

      if (!this.dirEnsured) {
        mkdirSync(dirname(this.logPath), { recursive: true });
        this.dirEnsured = true;
      }

      if (this.currentSizeBytes === null) {
        this.currentSizeBytes = existsSync(this.logPath) ? statSync(this.logPath).size : 0;
      }

      // AC: @daemon-log-capture ac-bounded-rotation — rotate BEFORE the
      // append that would cross the limit so the new line begins a fresh
      // active file. renameSync replaces any existing rotated generation,
      // so exactly one prior generation is retained.
      if (this.currentSizeBytes > 0 && this.currentSizeBytes + entryBytes > this.maxSizeBytes) {
        if (existsSync(this.logPath)) {
          renameSync(this.logPath, this.rotatedPath);
        }
        this.currentSizeBytes = 0;
      }

      appendFileSync(this.logPath, entry, "utf8");
      this.currentSizeBytes += entryBytes;
    } catch {
      // Logging must never crash or destabilize the daemon. Swallow file
      // system errors (e.g. unwritable directory) and keep terminal output
      // flowing through the untouched console passthrough.
    }
  }
}

let activeWriter: DaemonLogWriter | null = null;
let teeInstalled = false;

/** Render console arguments exactly as console.log would print them. */
function formatConsoleArgs(args: unknown[]): string {
  return format(...args);
}

/**
 * Replace console.log/warn/error with versions that tee into the given
 * writer and then call through to the functions that were installed at the
 * moment of the call to this function.
 *
 * Ordering contract: routes/command.ts captures the then-current console
 * functions as its "originals" at module load and permanently replaces them
 * with AsyncLocalStorage-routed interceptors. This tee must therefore be
 * installed BEFORE routes/command.ts evaluates (logger-install.js is the
 * first import of the daemon entry point), so the interceptors capture the
 * tee'd functions as their originals. Result: daemon-side output flows
 * interceptor → tee → file + terminal, while output emitted during a
 * command capture is swallowed by the capture store and never reaches the
 * tee — no double-logging of command output.
 *
 * AC: @daemon-log-capture ac-detached-output-captured
 * AC: @daemon-log-capture ac-foreground-tee
 */
export function installDaemonConsoleTee(writer: DaemonLogWriter): void {
  activeWriter = writer;
  if (teeInstalled) {
    return;
  }
  teeInstalled = true;

  const passthrough = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  console.log = (...args: unknown[]) => {
    activeWriter?.writeLine("log", formatConsoleArgs(args));
    passthrough.log(...args);
  };
  console.warn = (...args: unknown[]) => {
    activeWriter?.writeLine("warn", formatConsoleArgs(args));
    passthrough.warn(...args);
  };
  console.error = (...args: unknown[]) => {
    activeWriter?.writeLine("error", formatConsoleArgs(args));
    passthrough.error(...args);
  };
}

/**
 * Apply startup configuration to the installed tee's writer. The tee
 * installs with built-in defaults at module load; the daemon entry point
 * calls this once command-line configuration has been parsed.
 */
export function configureDaemonLogWriter(options: { maxSizeBytes?: number }): void {
  if (options.maxSizeBytes !== undefined) {
    activeWriter?.setMaxSizeBytes(options.maxSizeBytes);
  }
}
