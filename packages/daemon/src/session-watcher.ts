/**
 * File watcher for .kspec-sessions directory.
 *
 * Watches session metadata and event files so the daemon can broadcast
 * source-agnostic session freshness notifications to WebSocket clients.
 */

import { existsSync, type Stats } from "fs";
import { readFile, readdir } from "fs/promises";
import { watch as chokidarWatch, type FSWatcher as ChokidarWatcher } from "chokidar";
import { basename, extname, join, relative, sep } from "path";
import YAML from "yaml";

export interface SessionWatcherOptions {
  sessionsDir: string;
  onSessionChange: (file: string) => void;
  onError: (error: Error, file?: string) => void;
}

export class SessionWatcher {
  private topLevelWatcher: ChokidarWatcher | null = null;
  private sessionWatchers = new Map<string, ChokidarWatcher>();
  private pendingSessionWatchers = new Map<string, Promise<SessionWatcherAttachResult>>();
  private sessionWatcherRetryTimers = new Map<string, NodeJS.Timeout>();
  private sessionWatcherRetryCounts = new Map<string, number>();
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private debounceMs = 250;
  private sessionWatcherRetryDelayMs = 200;
  private maxSessionWatcherRetries = 15;
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

    await this.startTopLevelWatcher();
    await this.watchExistingSessions();
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

  private async startTopLevelWatcher(): Promise<void> {
    this.topLevelWatcher = chokidarWatch(this.options.sessionsDir, {
      depth: 0,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50,
      },
    });

    this.topLevelWatcher
      .on("addDir", (file: string) => {
        void this.handleSessionDirAdded(file, true);
      })
      .on("unlinkDir", (file: string) => {
        void this.handleSessionDirRemoved(file);
      })
      .on("error", (error: unknown) => {
        void this.handleWatcherError(
          error instanceof Error ? error : new Error(String(error)),
          this.options.sessionsDir,
        );
      });

    await new Promise<void>((resolve) => {
      this.topLevelWatcher?.once("ready", () => resolve());
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
    await this.emitExistingSessions();
  }

  private async watchExistingSessions(): Promise<void> {
    const entries = await readdir(this.options.sessionsDir, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) =>
          this.handleSessionDirAdded(join(this.options.sessionsDir, entry.name), false),
        ),
    );
  }

  private async emitExistingSessions(): Promise<void> {
    const entries = await readdir(this.options.sessionsDir, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) =>
          this.handleSessionDirAdded(join(this.options.sessionsDir, entry.name), true),
        ),
    );
  }

  private async handleSessionDirAdded(
    sessionRoot: string,
    emitInitialChange: boolean,
  ): Promise<void> {
    if (this.stopped || sessionRoot === this.options.sessionsDir) {
      return;
    }

    if (!this.getSessionRoot(sessionRoot)) {
      return;
    }

    if (this.sessionWatchers.has(sessionRoot)) {
      this.clearSessionWatcherRetry(sessionRoot);
      if (emitInitialChange) {
        this.handleFileChange(sessionRoot);
      }
      return;
    }

    const existingStart = this.pendingSessionWatchers.get(sessionRoot);
    if (existingStart) {
      await existingStart;
      return;
    }

    const startPromise = this.ensureSessionWatcher(sessionRoot, emitInitialChange);
    this.pendingSessionWatchers.set(sessionRoot, startPromise);
    try {
      const result = await startPromise;
      if (result === "missing") {
        this.scheduleSessionWatcherRetry(sessionRoot, emitInitialChange);
        return;
      }

      this.clearSessionWatcherRetry(sessionRoot);
    } finally {
      this.pendingSessionWatchers.delete(sessionRoot);
    }
  }

  private async ensureSessionWatcher(
    sessionRoot: string,
    emitInitialChange: boolean,
  ): Promise<SessionWatcherAttachResult> {
    const status = await this.readSessionStatus(sessionRoot);
    if (status === null) {
      return "missing";
    }

    if (status !== "active" || this.stopped) {
      return "inactive";
    }

    if (this.sessionWatchers.has(sessionRoot)) {
      return "active";
    }

    const watcher = chokidarWatch(sessionRoot, {
      ignoreInitial: true,
      ignored: (filePath: string, stats?: Stats) => this.shouldIgnorePath(filePath, stats),
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50,
      },
    });

    watcher
      .on("add", (file: string) => {
        void this.handleSessionFileChange(sessionRoot, file);
      })
      .on("change", (file: string) => {
        void this.handleSessionFileChange(sessionRoot, file);
      })
      .on("unlink", (file: string) => {
        void this.handleSessionFileChange(sessionRoot, file);
      })
      .on("unlinkDir", (file: string) => {
        void this.handleSessionFileChange(sessionRoot, file);
      })
      .on("error", (error: unknown) => {
        void this.handleWatcherError(
          error instanceof Error ? error : new Error(String(error)),
          sessionRoot,
        );
      });

    await new Promise<void>((resolve) => {
      watcher.once("ready", () => resolve());
    });

    if (this.stopped) {
      await watcher.close();
      return "inactive";
    }

    this.sessionWatchers.set(sessionRoot, watcher);
    if (emitInitialChange) {
      this.handleFileChange(sessionRoot);
    }

    return "active";
  }

  private async handleSessionDirRemoved(sessionRoot: string): Promise<void> {
    if (sessionRoot === this.options.sessionsDir) {
      return;
    }

    this.clearSessionWatcherRetry(sessionRoot);
    await this.closeSessionWatcher(sessionRoot);
    this.handleFileChange(sessionRoot);
  }

  private async handleSessionFileChange(sessionRoot: string, filePath: string): Promise<void> {
    if (this.stopped) {
      return;
    }

    if (this.isSessionMetadataPath(filePath)) {
      const status = await this.readSessionStatus(sessionRoot, 1);
      if (status && status !== "active") {
        await this.closeSessionWatcher(sessionRoot);
        this.handleFileChange(sessionRoot);
        return;
      }
    }

    this.handleFileChange(filePath);
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

  private isSessionMetadataPath(filePath: string): boolean {
    return basename(filePath) === "session.yaml";
  }

  private async readSessionStatus(
    sessionRoot: string,
    remainingRetries = 0,
  ): Promise<string | null> {
    const metadataPath = join(sessionRoot, "session.yaml");

    try {
      const content = await readFile(metadataPath, "utf-8");
      const parsed = YAML.parse(content) as { status?: unknown } | null;
      return typeof parsed?.status === "string" ? parsed.status : null;
    } catch {
      if (remainingRetries <= 0 || this.stopped) {
        return null;
      }

      await this.delay(200);
      return this.readSessionStatus(sessionRoot, remainingRetries - 1);
    }
  }

  private async closeSessionWatcher(sessionRoot: string): Promise<void> {
    this.clearSessionWatcherRetry(sessionRoot);
    const watcher = this.sessionWatchers.get(sessionRoot);
    this.sessionWatchers.delete(sessionRoot);
    if (watcher) {
      await watcher.close();
    }
  }

  private scheduleSessionWatcherRetry(sessionRoot: string, emitInitialChange: boolean): void {
    if (
      this.stopped ||
      this.sessionWatchers.has(sessionRoot) ||
      this.sessionWatcherRetryTimers.has(sessionRoot)
    ) {
      return;
    }

    const retryCount = this.sessionWatcherRetryCounts.get(sessionRoot) ?? 0;
    if (retryCount >= this.maxSessionWatcherRetries) {
      this.sessionWatcherRetryCounts.delete(sessionRoot);
      return;
    }

    this.sessionWatcherRetryCounts.set(sessionRoot, retryCount + 1);

    const timer = setTimeout(() => {
      this.sessionWatcherRetryTimers.delete(sessionRoot);
      void this.handleSessionDirAdded(sessionRoot, emitInitialChange);
    }, this.sessionWatcherRetryDelayMs);

    if (typeof timer === "object" && "unref" in timer) {
      timer.unref();
    }

    this.sessionWatcherRetryTimers.set(sessionRoot, timer);
  }

  private clearSessionWatcherRetry(sessionRoot: string): void {
    const timer = this.sessionWatcherRetryTimers.get(sessionRoot);
    if (timer) {
      clearTimeout(timer);
      this.sessionWatcherRetryTimers.delete(sessionRoot);
    }

    this.sessionWatcherRetryCounts.delete(sessionRoot);
  }

  private async delay(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      if (typeof timer === "object" && "unref" in timer) {
        timer.unref();
      }
    });
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

  private async handleWatcherError(error: Error, file?: string): Promise<void> {
    if (this.stopped) {
      return;
    }

    this.options.onError(error, file);

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

    for (const timer of this.sessionWatcherRetryTimers.values()) {
      clearTimeout(timer);
    }
    this.sessionWatcherRetryTimers.clear();
    this.sessionWatcherRetryCounts.clear();

    await Promise.all(
      Array.from(this.sessionWatchers.keys(), (sessionRoot) =>
        this.closeSessionWatcher(sessionRoot),
      ),
    );
    this.pendingSessionWatchers.clear();

    if (this.topLevelWatcher) {
      await this.topLevelWatcher.close();
      this.topLevelWatcher = null;
    }
  }
}

type SessionWatcherAttachResult = "active" | "inactive" | "missing";
