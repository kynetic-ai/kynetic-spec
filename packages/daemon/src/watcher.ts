/**
 * File watcher for .kspec directory
 *
 * AC Coverage:
 * - ac-4: Watch .kspec/*.yaml files and broadcast changes
 * - ac-5: Debounce rapid changes (500ms)
 * - ac-6: Handle YAML parse errors gracefully
 * - ac-7: Recovery with exponential backoff for directory access errors
 * - ac-8: Fallback to Chokidar if Bun fs.watch fails
 */

import { watch, type FSWatcher } from 'fs';
import { readFile } from 'fs/promises';
import { parse as parseYaml } from 'yaml';
import chokidar, { type FSWatcher as ChokidarWatcher } from 'chokidar';
import { join } from 'path';

export interface WatcherOptions {
  kspecDir: string;
  onFileChange: (file: string, content: string) => void;
  onError: (error: Error, file?: string) => void;
}

export interface WatcherEvent {
  type: 'change' | 'error';
  file: string;
  content?: string;
  error?: string;
}

/**
 * File watcher with debouncing and error handling
 */
export class KspecWatcher {
  private watcher: FSWatcher | ChokidarWatcher | null = null;
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private debounceMs = 500;
  private usingChokidar = false;
  private retryCount = 0;
  private maxRetries = 5;
  private baseBackoffMs = 1000;

  constructor(private options: WatcherOptions) {}

  /**
   * AC-4, AC-8: Start watching .kspec directory (with Chokidar fallback)
   */
  async start(): Promise<void> {
    try {
      // Try Bun's native fs.watch first
      await this.startBunWatcher();
    } catch (error) {
      console.warn('[watcher] Bun fs.watch failed, falling back to Chokidar', error);
      // AC-8: Fallback to Chokidar
      this.usingChokidar = true;
      await this.startChokidarWatcher();
    }
  }

  /**
   * Start Bun's native file watcher
   */
  private async startBunWatcher(): Promise<void> {
    const pattern = join(this.options.kspecDir, '*.yaml');

    this.watcher = watch(
      this.options.kspecDir,
      { recursive: true },
      (eventType, filename) => {
        if (!filename || !filename.endsWith('.yaml')) return;

        const fullPath = join(this.options.kspecDir, filename);
        this.handleFileChange(fullPath);
      }
    );

    console.log('[watcher] Watching .kspec directory with Bun fs.watch');
  }

  /**
   * AC-8: Start Chokidar watcher as fallback
   */
  private async startChokidarWatcher(): Promise<void> {
    this.watcher = chokidar.watch(join(this.options.kspecDir, '*.yaml'), {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50
      }
    });

    (this.watcher as ChokidarWatcher).on('change', (path: string) => {
      this.handleFileChange(path);
    });

    (this.watcher as ChokidarWatcher).on('error', (err: unknown) => {
      // AC-7: Recovery with exponential backoff
      this.handleWatcherError(err instanceof Error ? err : new Error(String(err)));
    });

    console.log('[watcher] Watching .kspec directory with Chokidar');
  }

  /**
   * AC-5: Debounce file changes (500ms)
   */
  private handleFileChange(filePath: string): void {
    // Clear existing timer for this file
    const existingTimer = this.debounceTimers.get(filePath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Set new debounced timer
    const timer = setTimeout(async () => {
      this.debounceTimers.delete(filePath);
      await this.processFileChange(filePath);
    }, this.debounceMs);

    this.debounceTimers.set(filePath, timer);
  }

  /**
   * AC-4, AC-6: Process file change and broadcast to clients
   */
  private async processFileChange(filePath: string): Promise<void> {
    try {
      const content = await readFile(filePath, 'utf-8');

      // AC-6: Validate YAML before broadcasting
      try {
        parseYaml(content);
        this.options.onFileChange(filePath, content);
        this.retryCount = 0; // Reset retry count on success
      } catch (parseError) {
        // AC-6: Log parse error and broadcast error event
        const error = new Error(`YAML parse error in ${filePath}: ${parseError}`);
        console.error('[watcher]', error.message);
        this.options.onError(error, filePath);
      }
    } catch (error) {
      // AC-7: Handle file read errors (directory inaccessible, etc.)
      console.error('[watcher] Error reading file:', error);
      this.handleWatcherError(error as Error);
    }
  }

  /**
   * AC-7: Handle watcher errors with exponential backoff
   */
  private async handleWatcherError(error: Error): Promise<void> {
    this.options.onError(error);

    if (this.retryCount >= this.maxRetries) {
      console.error('[watcher] Max retries reached, giving up');
      return;
    }

    this.retryCount++;
    const backoffMs = this.baseBackoffMs * Math.pow(2, this.retryCount - 1);

    console.log(`[watcher] Attempting recovery in ${backoffMs}ms (attempt ${this.retryCount}/${this.maxRetries})`);

    setTimeout(async () => {
      try {
        await this.stop();
        await this.start();
        console.log('[watcher] Recovery successful');
      } catch (retryError) {
        console.error('[watcher] Recovery failed:', retryError);
        // Will retry again if under max retries
        this.handleWatcherError(retryError as Error);
      }
    }, backoffMs);
  }

  /**
   * Stop watching
   */
  async stop(): Promise<void> {
    // Clear all debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    // Close watcher
    if (this.watcher) {
      if (this.usingChokidar) {
        await (this.watcher as ChokidarWatcher).close();
      } else {
        (this.watcher as FSWatcher).close();
      }
      this.watcher = null;
    }
  }
}
