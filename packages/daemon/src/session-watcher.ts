/**
 * File watcher for .kspec-sessions directory.
 *
 * Watches session metadata and event files so the daemon can broadcast
 * source-agnostic session freshness notifications to WebSocket clients.
 */

import { existsSync, watch, type FSWatcher } from 'fs';
import chokidar, { type FSWatcher as ChokidarWatcher } from 'chokidar';
import { join, relative, sep } from 'path';

export interface SessionWatcherOptions {
	sessionsDir: string;
	onSessionChange: (file: string) => void;
	onError: (error: Error, file?: string) => void;
}

export class SessionWatcher {
	private watcher: FSWatcher | ChokidarWatcher | null = null;
	private debounceTimers = new Map<string, NodeJS.Timeout>();
	private debounceMs = 250;
	private usingChokidar = false;
	private retryCount = 0;
	private maxRetries = 5;
	private baseBackoffMs = 1000;
	private stopped = false;
	private recoveryTimer: NodeJS.Timeout | null = null;

	constructor(private options: SessionWatcherOptions) {}

	async start(): Promise<void> {
		if (!existsSync(this.options.sessionsDir)) {
			return;
		}

		this.stopped = false;
		try {
			await this.startBunWatcher();
		} catch (error) {
			console.warn('[session-watcher] Bun fs.watch failed, falling back to Chokidar', error);
			this.usingChokidar = true;
			await this.startChokidarWatcher();
		}
	}

	private async startBunWatcher(): Promise<void> {
		this.watcher = watch(this.options.sessionsDir, { recursive: true }, (_eventType, filename) => {
			if (!filename) return;
			this.handleFileChange(join(this.options.sessionsDir, filename));
		});
		(this.watcher as FSWatcher).on('error', (error) => {
			void this.handleWatcherError(error);
		});
		console.log('[session-watcher] Watching .kspec-sessions directory with Bun fs.watch');
	}

	private async startChokidarWatcher(): Promise<void> {
		this.watcher = chokidar.watch(join(this.options.sessionsDir, '**/*'), {
			ignoreInitial: true,
			awaitWriteFinish: {
				stabilityThreshold: 100,
				pollInterval: 50
			}
		});

		(this.watcher as ChokidarWatcher)
			.on('add', (file: string) => this.handleFileChange(file))
			.on('change', (file: string) => this.handleFileChange(file))
			.on('unlink', (file: string) => this.handleFileChange(file))
			.on('addDir', (file: string) => this.handleFileChange(file))
			.on('unlinkDir', (file: string) => this.handleFileChange(file))
			.on('error', (error: unknown) => {
				void this.handleWatcherError(error instanceof Error ? error : new Error(String(error)));
			});

		console.log('[session-watcher] Watching .kspec-sessions directory with Chokidar');
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
		if (!relativePath || relativePath === '.' || relativePath.startsWith('..')) {
			return null;
		}

		const [sessionId] = relativePath.split(sep).filter(Boolean);
		return sessionId ? join(this.options.sessionsDir, sessionId) : null;
	}

	private async handleWatcherError(error: Error): Promise<void> {
		if (this.stopped) {
			return;
		}

		this.options.onError(error);

		const nodeError = error as NodeJS.ErrnoException;
		if (this.retryCount >= this.maxRetries) {
			if (nodeError.code === 'ENOENT' && !existsSync(this.options.sessionsDir)) {
				await this.stop();
				return;
			}
			console.error('[session-watcher] Max retries reached, giving up');
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
				console.log('[session-watcher] Recovery successful');
			} catch (retryError) {
				console.error('[session-watcher] Recovery failed:', retryError);
				await this.handleWatcherError(retryError as Error);
			}
		}, backoffMs);
		if (typeof this.recoveryTimer === 'object' && 'unref' in this.recoveryTimer) {
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
