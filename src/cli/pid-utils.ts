/**
 * PID File Management for CLI
 *
 * Manages daemon process PID and port files for lifecycle control from the CLI.
 * Uses global config directory (~/.config/kspec/) instead of per-project .kspec/
 *
 * NOTE: This is a duplicate of packages/daemon/src/pid.ts to avoid cross-package imports.
 * TODO: Consider extracting to a shared @kynetic-ai/shared package when monorepo structure is established.
 * For now, both files must be kept in sync manually.
 *
 * AC: @multi-directory-daemon ac-9, ac-9b, ac-9c, ac-10, ac-11, ac-13
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export class PidFileManager {
  private configDir: string;
  private pidFilePath: string;
  private portFilePath: string;

  constructor(configDir: string = join(homedir(), '.config', 'kspec')) {
    this.configDir = configDir;
    this.pidFilePath = join(configDir, 'daemon.pid');
    this.portFilePath = join(configDir, 'daemon.port');
  }

  /**
   * AC: @multi-directory-daemon ac-9b
   * Creates config directory with mode 0755 if it doesn't exist
   */
  private ensureConfigDir(): void {
    if (!existsSync(this.configDir)) {
      mkdirSync(this.configDir, { recursive: true, mode: 0o755 });
    }
  }

  /**
   * AC: @multi-directory-daemon ac-9
   * Writes current process PID to ~/.config/kspec/daemon.pid
   * Creates parent directory if it doesn't exist.
   */
  writePid(): void {
    this.ensureConfigDir();
    writeFileSync(this.pidFilePath, process.pid.toString(), 'utf-8');
  }

  /**
   * AC: @multi-directory-daemon ac-9
   * Writes daemon port to ~/.config/kspec/daemon.port
   * Creates parent directory if it doesn't exist.
   */
  writePort(port: number): void {
    this.ensureConfigDir();
    writeFileSync(this.portFilePath, port.toString(), 'utf-8');
  }

  /**
   * Reads PID from ~/.config/kspec/daemon.pid
   * Returns null if file doesn't exist or is invalid
   */
  readPid(): number | null {
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
   * AC: @multi-directory-daemon ac-9c, ac-13
   * Reads port from ~/.config/kspec/daemon.port
   * Throws error if file doesn't exist or contains invalid port
   */
  readPort(): number {
    if (!existsSync(this.portFilePath)) {
      throw new Error('Invalid daemon port file');
    }

    try {
      const content = readFileSync(this.portFilePath, 'utf-8').trim();
      const port = parseInt(content, 10);

      // AC: @multi-directory-daemon ac-9c - validate port content
      if (isNaN(port) || port < 1 || port > 65535) {
        throw new Error('Invalid daemon port file');
      }

      return port;
    } catch (err) {
      throw new Error('Invalid daemon port file');
    }
  }

  /**
   * AC: @multi-directory-daemon ac-11
   * Removes both PID and port files during graceful shutdown
   */
  remove(): void {
    if (existsSync(this.pidFilePath)) {
      unlinkSync(this.pidFilePath);
    }
    if (existsSync(this.portFilePath)) {
      unlinkSync(this.portFilePath);
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
   * AC: @multi-directory-daemon ac-10
   * Checks if daemon is currently running based on PID file
   */
  isDaemonRunning(): boolean {
    const pid = this.readPid();
    if (pid === null) {
      return false;
    }
    return this.isProcessRunning(pid);
  }

  /**
   * Backwards compatibility: read() method maps to readPid()
   * @deprecated Use readPid() instead
   */
  read(): number | null {
    return this.readPid();
  }

  /**
   * Backwards compatibility: write() method maps to writePid()
   * @deprecated Use writePid() instead
   */
  write(): void {
    this.writePid();
  }
}
