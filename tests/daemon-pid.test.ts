/**
 * Tests for PID File Management
 *
 * AC: @multi-directory-daemon ac-9, ac-10, ac-11
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PidFileManager } from '../packages/daemon/src/pid';
import { createTempDir, cleanupTempDir } from './helpers/cli';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

describe('PID File Management', () => {
  let tempConfigDir: string;

  beforeEach(async () => {
    tempConfigDir = await createTempDir();
  });

  afterEach(async () => {
    await cleanupTempDir(tempConfigDir);
  });

  // AC: @multi-directory-daemon ac-9
  it('should write current process PID to file', () => {
    const pidManager = new PidFileManager(tempConfigDir);

    pidManager.writePid();

    const pidFilePath = join(tempConfigDir, 'daemon.pid');
    expect(existsSync(pidFilePath)).toBe(true);

    const content = require('fs').readFileSync(pidFilePath, 'utf-8').trim();
    expect(content).toBe(process.pid.toString());
  });

  // AC: @multi-directory-daemon ac-9
  it('should read PID from file', () => {
    const pidManager = new PidFileManager(tempConfigDir);

    pidManager.writePid();
    const pid = pidManager.readPid();

    expect(pid).toBe(process.pid);
  });

  // AC: @multi-directory-daemon ac-9
  it('should return null when PID file does not exist', () => {
    const pidManager = new PidFileManager(tempConfigDir);

    const pid = pidManager.readPid();

    expect(pid).toBeNull();
  });

  // AC: @multi-directory-daemon ac-9
  it('should return null when PID file contains invalid content', () => {
    const pidManager = new PidFileManager(tempConfigDir);

    mkdirSync(tempConfigDir, { recursive: true });
    writeFileSync(join(tempConfigDir, 'daemon.pid'), 'not-a-number', 'utf-8');

    const pid = pidManager.readPid();

    expect(pid).toBeNull();
  });

  // AC: @multi-directory-daemon ac-11
  it('should remove PID file', () => {
    const pidManager = new PidFileManager(tempConfigDir);

    pidManager.writePid();
    expect(existsSync(join(tempConfigDir, 'daemon.pid'))).toBe(true);

    pidManager.remove();
    expect(existsSync(join(tempConfigDir, 'daemon.pid'))).toBe(false);
  });

  // AC: @multi-directory-daemon ac-11
  it('should not throw when removing non-existent PID file', () => {
    const pidManager = new PidFileManager(tempConfigDir);

    expect(() => pidManager.remove()).not.toThrow();
  });

  // AC: @multi-directory-daemon ac-10
  it('should detect running process', () => {
    const pidManager = new PidFileManager(tempConfigDir);

    // Current process should be running
    const isRunning = pidManager.isProcessRunning(process.pid);

    expect(isRunning).toBe(true);
  });

  // AC: @multi-directory-daemon ac-10
  it('should detect non-running process', () => {
    const pidManager = new PidFileManager(tempConfigDir);

    // Use a PID that's unlikely to exist (very high number)
    const isRunning = pidManager.isProcessRunning(999999);

    expect(isRunning).toBe(false);
  });

  // AC: @multi-directory-daemon ac-10
  it('should detect daemon running based on PID file', () => {
    const pidManager = new PidFileManager(tempConfigDir);

    pidManager.writePid();
    expect(pidManager.isDaemonRunning()).toBe(true);
  });

  // AC: @multi-directory-daemon ac-10
  it('should detect daemon not running when PID file absent', () => {
    const pidManager = new PidFileManager(tempConfigDir);

    expect(pidManager.isDaemonRunning()).toBe(false);
  });

  // AC: @multi-directory-daemon ac-10
  it('should detect daemon not running when PID file stale', () => {
    const pidManager = new PidFileManager(tempConfigDir);

    mkdirSync(tempConfigDir, { recursive: true });
    // Write a PID that doesn't exist
    writeFileSync(join(tempConfigDir, 'daemon.pid'), '999999', 'utf-8');

    expect(pidManager.isDaemonRunning()).toBe(false);
  });
});
