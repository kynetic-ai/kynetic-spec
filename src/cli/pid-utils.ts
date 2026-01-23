/**
 * PID File Management for CLI
 *
 * Manages daemon process PID file for lifecycle control from the CLI.
 *
 * NOTE: This is a duplicate of packages/daemon/src/pid.ts to avoid cross-package imports.
 * TODO: Consider extracting to a shared @kynetic-ai/shared package when monorepo structure is established.
 * For now, both files must be kept in sync manually.
 *
 * AC: @cli-serve-commands ac-4, ac-5, ac-6
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';

export class PidFileManager {
  private pidFilePath: string;

  constructor(kspecDir: string) {
    this.pidFilePath = join(kspecDir, '.daemon.pid');
  }

  /**
   * Writes current process PID to .kspec/.daemon.pid
   */
  write(): void {
    writeFileSync(this.pidFilePath, process.pid.toString(), 'utf-8');
  }

  /**
   * Reads PID from .kspec/.daemon.pid
   * Returns null if file doesn't exist or is invalid
   */
  read(): number | null {
    if (!existsSync(this.pidFilePath)) {
      return null;
    }

    try {
      const content = readFileSync(this.pidFilePath, 'utf-8').trim();
      const pid = parseInt(content, 10);
      return isNaN(pid) ? null : pid;
    } catch {
      return null;
    }
  }

  /**
   * Removes PID file during graceful shutdown
   */
  remove(): void {
    if (existsSync(this.pidFilePath)) {
      unlinkSync(this.pidFilePath);
    }
  }

  /**
   * Checks if a process with given PID is running
   */
  isProcessRunning(pid: number): boolean {
    try {
      // Sending signal 0 checks if process exists without actually sending a signal
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Checks if daemon is currently running based on PID file
   */
  isDaemonRunning(): boolean {
    const pid = this.read();
    if (pid === null) {
      return false;
    }
    return this.isProcessRunning(pid);
  }
}
