import type { ProjectContextManager } from "./project-context.js";

interface WatcherHealthMonitorOptions {
  intervalMs?: number;
  logger?: Pick<Console, "error">;
}

export class WatcherHealthMonitor {
  private readonly intervalMs: number;
  private readonly logger: Pick<Console, "error">;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly projectManager: ProjectContextManager,
    options: WatcherHealthMonitorOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? 60_000;
    this.logger = options.logger ?? console;
  }

  start(): void {
    if (this.timer || this.intervalMs <= 0) return;

    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      for (const project of this.projectManager.listProjects()) {
        if (!project.watcherActive) continue;

        try {
          await this.projectManager.verifyWatcherHealth(project.path);
        } catch (error) {
          this.logger.error(
            `[watcher-health] Unexpected health check error for ${project.path}:`,
            error,
          );
        }
      }
    } finally {
      this.running = false;
    }
  }
}
