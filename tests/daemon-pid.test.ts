/**
 * Tests for PID File Management
 *
 * AC: @daemon-server ac-9, ac-10
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PidFileManager } from '../packages/daemon/src/pid';
import { createTempDir, cleanupTempDir } from './helpers/cli';
import { writeFileSync, existsSync } from 'fs';
import { join } from 'path';

describe('PID File Management', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @daemon-server ac-9
  it('should write current process PID to file', () => {
    const pidManager = new PidFileManager(tempDir);

    pidManager.write();

    const pidFilePath = join(tempDir, '.daemon.pid');
    expect(existsSync(pidFilePath)).toBe(true);

    const content = require('fs').readFileSync(pidFilePath, 'utf-8').trim();
    expect(content).toBe(process.pid.toString());
  });

  // AC: @daemon-server ac-9
  it('should read PID from file', () => {
    const pidManager = new PidFileManager(tempDir);

    pidManager.write();
    const pid = pidManager.read();

    expect(pid).toBe(process.pid);
  });

  // AC: @daemon-server ac-9
  it('should return null when PID file does not exist', () => {
    const pidManager = new PidFileManager(tempDir);

    const pid = pidManager.read();

    expect(pid).toBeNull();
  });

  // AC: @daemon-server ac-9
  it('should return null when PID file contains invalid content', () => {
    const pidManager = new PidFileManager(tempDir);

    writeFileSync(join(tempDir, '.daemon.pid'), 'not-a-number', 'utf-8');

    const pid = pidManager.read();

    expect(pid).toBeNull();
  });

  // AC: @daemon-server ac-10
  it('should remove PID file', () => {
    const pidManager = new PidFileManager(tempDir);

    pidManager.write();
    expect(existsSync(join(tempDir, '.daemon.pid'))).toBe(true);

    pidManager.remove();
    expect(existsSync(join(tempDir, '.daemon.pid'))).toBe(false);
  });

  // AC: @daemon-server ac-10
  it('should not throw when removing non-existent PID file', () => {
    const pidManager = new PidFileManager(tempDir);

    expect(() => pidManager.remove()).not.toThrow();
  });

  // AC: @daemon-server ac-9
  it('should detect running process', () => {
    const pidManager = new PidFileManager(tempDir);

    // Current process should be running
    const isRunning = pidManager.isProcessRunning(process.pid);

    expect(isRunning).toBe(true);
  });

  // AC: @daemon-server ac-10
  it('should detect non-running process', () => {
    const pidManager = new PidFileManager(tempDir);

    // Use a PID that's unlikely to exist (very high number)
    const isRunning = pidManager.isProcessRunning(999999);

    expect(isRunning).toBe(false);
  });

  // AC: @daemon-server ac-9
  it('should detect daemon running based on PID file', () => {
    const pidManager = new PidFileManager(tempDir);

    pidManager.write();
    expect(pidManager.isDaemonRunning()).toBe(true);
  });

  // AC: @daemon-server ac-10
  it('should detect daemon not running when PID file absent', () => {
    const pidManager = new PidFileManager(tempDir);

    expect(pidManager.isDaemonRunning()).toBe(false);
  });

  // AC: @daemon-server ac-10
  it('should detect daemon not running when PID file stale', () => {
    const pidManager = new PidFileManager(tempDir);

    // Write a PID that doesn't exist
    writeFileSync(join(tempDir, '.daemon.pid'), '999999', 'utf-8');

    expect(pidManager.isDaemonRunning()).toBe(false);
  });
});
