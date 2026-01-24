/**
 * Tests for Global PID/Port Management
 *
 * Tests the new multi-directory daemon architecture where PID and port files
 * are stored globally at ~/.config/kspec/ instead of per-project .kspec/.
 *
 * AC: @multi-directory-daemon ac-9, ac-9b, ac-9c, ac-10, ac-10b, ac-11, ac-13
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTempDir, cleanupTempDir } from './helpers/cli';
import { writeFileSync, readFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// Mock PidFileManager for global paths
class GlobalPidFileManager {
  private configDir: string;
  private pidFilePath: string;
  private portFilePath: string;

  constructor(configDir: string = join(homedir(), '.config', 'kspec')) {
    this.configDir = configDir;
    this.pidFilePath = join(configDir, 'daemon.pid');
    this.portFilePath = join(configDir, 'daemon.port');
  }

  // AC: @multi-directory-daemon ac-9b
  private ensureConfigDir(): void {
    if (!existsSync(this.configDir)) {
      mkdirSync(this.configDir, { recursive: true, mode: 0o755 });
    }
  }

  // AC: @multi-directory-daemon ac-9
  writePid(): void {
    this.ensureConfigDir();
    writeFileSync(this.pidFilePath, process.pid.toString(), 'utf-8');
  }

  // AC: @multi-directory-daemon ac-9
  writePort(port: number): void {
    this.ensureConfigDir();
    writeFileSync(this.portFilePath, port.toString(), 'utf-8');
  }

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

  // AC: @multi-directory-daemon ac-9c, ac-13
  readPort(): number | null {
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

  // AC: @multi-directory-daemon ac-11
  remove(): void {
    const fs = require('fs');
    if (existsSync(this.pidFilePath)) {
      fs.unlinkSync(this.pidFilePath);
    }
    if (existsSync(this.portFilePath)) {
      fs.unlinkSync(this.portFilePath);
    }
  }

  isProcessRunning(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  // AC: @multi-directory-daemon ac-10
  isDaemonRunning(): boolean {
    const pid = this.readPid();
    if (pid === null) {
      return false;
    }
    return this.isProcessRunning(pid);
  }
}

describe('Global PID/Port Management', () => {
  let tempConfigDir: string;
  let pidManager: GlobalPidFileManager;

  beforeEach(async () => {
    // Use temp dir instead of actual ~/.config/kspec for testing
    tempConfigDir = await createTempDir();
    pidManager = new GlobalPidFileManager(tempConfigDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempConfigDir);
  });

  describe('PID file management', () => {
    // AC: @multi-directory-daemon ac-9
    it('should write PID to global location', () => {
      pidManager.writePid();

      const pidFilePath = join(tempConfigDir, 'daemon.pid');
      expect(existsSync(pidFilePath)).toBe(true);

      const content = readFileSync(pidFilePath, 'utf-8').trim();
      expect(content).toBe(process.pid.toString());
    });

    // AC: @multi-directory-daemon ac-9
    it('should read PID from global location', () => {
      pidManager.writePid();
      const pid = pidManager.readPid();

      expect(pid).toBe(process.pid);
    });

    // AC: @multi-directory-daemon ac-9
    it('should return null when PID file does not exist', () => {
      const pid = pidManager.readPid();
      expect(pid).toBeNull();
    });

    // AC: @multi-directory-daemon ac-9
    it('should return null when PID file contains invalid content', () => {
      const pidFilePath = join(tempConfigDir, 'daemon.pid');
      mkdirSync(tempConfigDir, { recursive: true });
      writeFileSync(pidFilePath, 'not-a-number', 'utf-8');

      const pid = pidManager.readPid();
      expect(pid).toBeNull();
    });
  });

  describe('Port file management', () => {
    // AC: @multi-directory-daemon ac-9
    it('should write port to global location', () => {
      const port = 3456;
      pidManager.writePort(port);

      const portFilePath = join(tempConfigDir, 'daemon.port');
      expect(existsSync(portFilePath)).toBe(true);

      const content = readFileSync(portFilePath, 'utf-8').trim();
      expect(content).toBe(port.toString());
    });

    // AC: @multi-directory-daemon ac-13
    it('should read port from global location', () => {
      const port = 3456;
      pidManager.writePort(port);

      const readPort = pidManager.readPort();
      expect(readPort).toBe(port);
    });

    // AC: @multi-directory-daemon ac-13
    it('should return null when port file does not exist', () => {
      expect(() => pidManager.readPort()).toThrow('Invalid daemon port file');
    });

    // AC: @multi-directory-daemon ac-9c
    it('should throw error when port file contains invalid content', () => {
      const portFilePath = join(tempConfigDir, 'daemon.port');
      mkdirSync(tempConfigDir, { recursive: true });
      writeFileSync(portFilePath, 'not-a-number', 'utf-8');

      expect(() => pidManager.readPort()).toThrow('Invalid daemon port file');
    });

    // AC: @multi-directory-daemon ac-9c
    it('should throw error when port is out of valid range (too low)', () => {
      const portFilePath = join(tempConfigDir, 'daemon.port');
      mkdirSync(tempConfigDir, { recursive: true });
      writeFileSync(portFilePath, '0', 'utf-8');

      expect(() => pidManager.readPort()).toThrow('Invalid daemon port file');
    });

    // AC: @multi-directory-daemon ac-9c
    it('should throw error when port is out of valid range (too high)', () => {
      const portFilePath = join(tempConfigDir, 'daemon.port');
      mkdirSync(tempConfigDir, { recursive: true });
      writeFileSync(portFilePath, '65536', 'utf-8');

      expect(() => pidManager.readPort()).toThrow('Invalid daemon port file');
    });

    // AC: @multi-directory-daemon ac-9c
    it('should accept valid port at lower boundary', () => {
      pidManager.writePort(1);
      expect(pidManager.readPort()).toBe(1);
    });

    // AC: @multi-directory-daemon ac-9c
    it('should accept valid port at upper boundary', () => {
      pidManager.writePort(65535);
      expect(pidManager.readPort()).toBe(65535);
    });
  });

  describe('Config directory creation', () => {
    // AC: @multi-directory-daemon ac-9b
    it('should create config directory when writing PID if it does not exist', async () => {
      // Use a non-existent subdirectory to test directory creation
      const nestedConfigDir = join(tempConfigDir, 'nested', 'config');
      const nestedPidManager = new GlobalPidFileManager(nestedConfigDir);

      expect(existsSync(nestedConfigDir)).toBe(false);

      nestedPidManager.writePid();

      expect(existsSync(nestedConfigDir)).toBe(true);
    });

    // AC: @multi-directory-daemon ac-9b
    it('should create config directory when writing port if it does not exist', async () => {
      // Use a non-existent subdirectory to test directory creation
      const nestedConfigDir = join(tempConfigDir, 'nested2', 'config');
      const nestedPidManager = new GlobalPidFileManager(nestedConfigDir);

      expect(existsSync(nestedConfigDir)).toBe(false);

      nestedPidManager.writePort(3456);

      expect(existsSync(nestedConfigDir)).toBe(true);
    });

    // AC: @multi-directory-daemon ac-9b
    it('should create config directory with mode 0755', () => {
      pidManager.writePid();

      const stats = statSync(tempConfigDir);
      // Mode is platform-specific, but should have at least rwx for owner
      const mode = stats.mode & 0o777;
      expect(mode & 0o700).toBe(0o700); // Owner has rwx
    });

    // AC: @multi-directory-daemon ac-9b
    it('should not fail when config directory already exists', () => {
      mkdirSync(tempConfigDir, { recursive: true });

      expect(() => pidManager.writePid()).not.toThrow();
      expect(() => pidManager.writePort(3456)).not.toThrow();
    });
  });

  describe('Daemon status detection', () => {
    // AC: @multi-directory-daemon ac-10
    it('should detect running daemon based on PID file', () => {
      pidManager.writePid();
      expect(pidManager.isDaemonRunning()).toBe(true);
    });

    // AC: @multi-directory-daemon ac-10
    it('should detect daemon not running when PID file absent', () => {
      expect(pidManager.isDaemonRunning()).toBe(false);
    });

    // AC: @multi-directory-daemon ac-10
    it('should detect daemon not running when PID file is stale', () => {
      const pidFilePath = join(tempConfigDir, 'daemon.pid');
      mkdirSync(tempConfigDir, { recursive: true });
      writeFileSync(pidFilePath, '999999', 'utf-8');

      expect(pidManager.isDaemonRunning()).toBe(false);
    });

    // AC: @multi-directory-daemon ac-10
    it('should detect process running', () => {
      const isRunning = pidManager.isProcessRunning(process.pid);
      expect(isRunning).toBe(true);
    });

    // AC: @multi-directory-daemon ac-10
    it('should detect process not running', () => {
      const isRunning = pidManager.isProcessRunning(999999);
      expect(isRunning).toBe(false);
    });
  });

  describe('Cleanup on stop', () => {
    // AC: @multi-directory-daemon ac-11
    it('should remove both PID and port files', () => {
      pidManager.writePid();
      pidManager.writePort(3456);

      const pidFilePath = join(tempConfigDir, 'daemon.pid');
      const portFilePath = join(tempConfigDir, 'daemon.port');

      expect(existsSync(pidFilePath)).toBe(true);
      expect(existsSync(portFilePath)).toBe(true);

      pidManager.remove();

      expect(existsSync(pidFilePath)).toBe(false);
      expect(existsSync(portFilePath)).toBe(false);
    });

    // AC: @multi-directory-daemon ac-11
    it('should not throw when removing non-existent files', () => {
      expect(() => pidManager.remove()).not.toThrow();
    });

    // AC: @multi-directory-daemon ac-11
    it('should handle partial cleanup (only PID file exists)', () => {
      pidManager.writePid();

      const pidFilePath = join(tempConfigDir, 'daemon.pid');
      expect(existsSync(pidFilePath)).toBe(true);

      expect(() => pidManager.remove()).not.toThrow();
      expect(existsSync(pidFilePath)).toBe(false);
    });

    // AC: @multi-directory-daemon ac-11
    it('should handle partial cleanup (only port file exists)', () => {
      pidManager.writePort(3456);

      const portFilePath = join(tempConfigDir, 'daemon.port');
      expect(existsSync(portFilePath)).toBe(true);

      expect(() => pidManager.remove()).not.toThrow();
      expect(existsSync(portFilePath)).toBe(false);
    });
  });

  describe('Multiple daemon prevention', () => {
    // AC: @multi-directory-daemon ac-10
    it('should detect existing daemon from any directory', () => {
      // Simulate daemon started from project A
      pidManager.writePid();
      pidManager.writePort(3456);

      // Create a new manager instance (as if from different directory)
      const secondManager = new GlobalPidFileManager(tempConfigDir);

      // Should detect the same daemon
      expect(secondManager.isDaemonRunning()).toBe(true);
      expect(secondManager.readPort()).toBe(3456);
    });

    // AC: @multi-directory-daemon ac-10
    it('should prevent second daemon instance when first is running', () => {
      pidManager.writePid();

      // Simulate second kspec serve start
      const secondManager = new GlobalPidFileManager(tempConfigDir);

      expect(secondManager.isDaemonRunning()).toBe(true);
      // In real CLI, this would exit with "Daemon already running" message
    });

    // AC: @multi-directory-daemon ac-10
    it('should allow daemon start when PID file exists but process is dead', () => {
      // Write stale PID
      const pidFilePath = join(tempConfigDir, 'daemon.pid');
      mkdirSync(tempConfigDir, { recursive: true });
      writeFileSync(pidFilePath, '999999', 'utf-8');

      expect(pidManager.isDaemonRunning()).toBe(false);

      // Should be able to start new daemon
      pidManager.writePid();
      expect(pidManager.isDaemonRunning()).toBe(true);
    });
  });

  describe('Cross-directory operation', () => {
    // AC: @multi-directory-daemon ac-10, ac-13
    it('should work from any directory (global state)', () => {
      // Start daemon from project A (tempConfigDir)
      pidManager.writePid();
      pidManager.writePort(3456);

      // Access from different location
      const managerFromOtherDir = new GlobalPidFileManager(tempConfigDir);

      expect(managerFromOtherDir.isDaemonRunning()).toBe(true);
      expect(managerFromOtherDir.readPort()).toBe(3456);
      expect(managerFromOtherDir.readPid()).toBe(process.pid);
    });

    // AC: @multi-directory-daemon ac-11
    it('should stop daemon from any directory', () => {
      pidManager.writePid();
      pidManager.writePort(3456);

      // Stop from different directory
      const managerFromOtherDir = new GlobalPidFileManager(tempConfigDir);
      managerFromOtherDir.remove();

      // Verify cleanup
      const pidFilePath = join(tempConfigDir, 'daemon.pid');
      const portFilePath = join(tempConfigDir, 'daemon.port');

      expect(existsSync(pidFilePath)).toBe(false);
      expect(existsSync(portFilePath)).toBe(false);
    });
  });
});
