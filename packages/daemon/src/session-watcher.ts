/**
 * File watcher for .kspec-sessions directory.
 *
 * Watches session metadata and event files so the daemon can broadcast
 * source-agnostic session freshness notifications to WebSocket clients.
 */

import { existsSync, readdirSync, type Stats } from "fs";
import { watch as chokidarWatch, type FSWatcher as ChokidarWatcher } from "chokidar";
import { extname, join, relative, sep } from "path";

export interface SessionWatcherOptions {
  sessionsDir: string;
  onSessionChange: (file: string) => void;
  onError: (error: Error, file?: string) => void;
}

export class SessionWatcher {
  private watcher: ChokidarWatcher | null = null;
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private debounceMs = 250;
  private retryCount = 0;
  private maxRetries = 5;
  private baseBackoffMs = 1000;
  private stopped = false;
  private recoveryTimer: NodeJS.Timeout | null = null;
  private bootstrapPollTimer: NodeJS.Timeout | null = null;

  constructor(private options: SessionWatcherOptions) {}

  async start(): Promise<void> {
    this.stopped = false;

    if (!existsSync(this.options.sessionsDir)) {
      this.scheduleBootstrapPoll();
      return;
    }

    await this.startChokidarWatcher();
  }

  private scheduleBootstrapPoll(): void {
    if (this.bootstrapPollTimer) {
      return;
    }

    this.bootstrapPollTimer = setInterval(() => {
      void this.promoteBootstrapPoll();
    }, this.debounceMs);
    if (typeof this.bootstrapPollTimer === "object" && "unref" in this.bootstrapPollTimer) {
      this.bootstrapPollTimer.unref();
    }

  }

  private async startChokidarWatcher(): Promise<void> {
    this.watcher = chokidarWatch(this.options.sessionsDir, {
      ignoreInitial: true,
      ignored: (filePath: string, stats?: Stats) => this.shouldIgnorePath(filePath, stats),
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50,
      },
    });

    this.watcher
      .on("add", (file: string) => this.handleFileChange(file))
      .on("change", (file: string) => this.handleFileChange(file))
      .on("unlink", (file: string) => this.handleFileChange(file))
      .on("addDir", (file: string) => this.handleFileChange(file))
      .on("unlinkDir", (file: string) => this.handleFileChange(file))
      .on("error", (error: unknown) => {
        void this.handleWatcherError(error instanceof Error ? error : new Error(String(error)));
      });

    await new Promise<void>((resolve) => {
      this.watcher?.once("ready", () => resolve());
    });

  }

  private async promoteBootstrapPoll(): Promise<void> {
    if (this.stopped || !existsSync(this.options.sessionsDir)) {
      return;
    }

    if (this.bootstrapPollTimer) {
      clearInterval(this.bootstrapPollTimer);
      this.bootstrapPollTimer = null;
    }

    await this.start();
    for (const entry of readdirSync(this.options.sessionsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        this.handleFileChange(join(this.options.sessionsDir, entry.name));
      }
    }
  }

  private handleFileChange(filePath: string): void {
    const debounceKey = this.getDebounceKey(filePath);
    const existingTimer = this.debounceTimers.get(debounceKey);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(debounceKey);
      this.options.onSessionChange(this.getBroadcastPath(filePath));
      this.retryCount = 0;
    }, this.debounceMs);

    this.debounceTimers.set(debounceKey, timer);
  }

  private getDebounceKey(filePath: string): string {
    const sessionRoot = this.getSessionRoot(filePath);
    return sessionRoot ?? filePath;
  }

  private getBroadcastPath(filePath: string): string {
    const sessionRoot = this.getSessionRoot(filePath);
    return sessionRoot ?? filePath;
  }

  private getSessionRoot(filePath: string): string | null {
    const relativePath = relative(this.options.sessionsDir, filePath);
    if (!relativePath || relativePath === "." || relativePath.startsWith("..")) {
      return null;
    }

    const [sessionId] = relativePath.split(sep).filter(Boolean);
    return sessionId ? join(this.options.sessionsDir, sessionId) : null;
  }

  private shouldIgnorePath(filePath: string, stats?: Stats): boolean {
    const relativePath = relative(this.options.sessionsDir, filePath);
    if (!relativePath || relativePath === "." || relativePath.startsWith("..")) {
      return false;
    }

    const segments = relativePath.split(sep).filter(Boolean);
    if (segments.includes("blobs")) {
      return true;
    }

    if (stats?.isDirectory()) {
      return false;
    }

    const extension = extname(segments.at(-1) ?? "").toLowerCase();
    if (!extension) {
      return false;
    }

    return extension !== ".yaml" && extension !== ".jsonl";
  }

  private async handleWatcherError(error: Error): Promise<void> {
    if (this.stopped) {
      return;
    }

    this.options.onError(error);

    const nodeError = error as NodeJS.ErrnoException;
    if (this.retryCount >= this.maxRetries) {
      if (nodeError.code === "ENOENT" && !existsSync(this.options.sessionsDir)) {
        await this.stop();
        return;
      }
      console.error("[session-watcher] Max retries reached, giving up");
      return;
    }

    this.retryCount++;
    const backoffMs = this.baseBackoffMs * Math.pow(2, this.retryCount - 1);

    this.recoveryTimer = setTimeout(async () => {
      this.recoveryTimer = null;
      try {
        if (this.stopped) return;
        await this.stop();
        this.stopped = false;
        await this.start();
      } catch (retryError) {
        console.error("[session-watcher] Recovery failed:", retryError);
        await this.handleWatcherError(retryError as Error);
      }
    }, backoffMs);
    if (typeof this.recoveryTimer === "object" && "unref" in this.recoveryTimer) {
      this.recoveryTimer.unref();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }

    if (this.bootstrapPollTimer) {
      clearInterval(this.bootstrapPollTimer);
      this.bootstrapPollTimer = null;
    }

    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }
}
