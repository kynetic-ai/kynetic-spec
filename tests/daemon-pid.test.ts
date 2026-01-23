/**
 * Tests for PID File Management
 *
 * AC: @daemon-server ac-9, ac-10
 */

import { describe, it, expect, afterEach } from 'vitest';
import { PidFileManager } from '../packages/daemon/src/pid';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';

describe('PID File Management', () => {
  const testDir = join(process.cwd(), '.test-daemon-pid');

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  // AC: @daemon-server ac-9
  it('should write current process PID to file', () => {
    mkdirSync(testDir, { recursive: true });
    const pidManager = new PidFileManager(testDir);

    pidManager.write();

    const pidFilePath = join(testDir, '.daemon.pid');
    expect(existsSync(pidFilePath)).toBe(true);

    const content = require('fs').readFileSync(pidFilePath, 'utf-8').trim();
    expect(content).toBe(process.pid.toString());
  });

  // AC: @daemon-server ac-9
  it('should read PID from file', () => {
    mkdirSync(testDir, { recursive: true });
    const pidManager = new PidFileManager(testDir);

    pidManager.write();
    const pid = pidManager.read();

    expect(pid).toBe(process.pid);
  });

  // AC: @daemon-server ac-9
  it('should return null when PID file does not exist', () => {
    mkdirSync(testDir, { recursive: true });
    const pidManager = new PidFileManager(testDir);

    const pid = pidManager.read();

    expect(pid).toBeNull();
  });

  // AC: @daemon-server ac-9
  it('should return null when PID file contains invalid content', () => {
    mkdirSync(testDir, { recursive: true });
    const pidManager = new PidFileManager(testDir);

    writeFileSync(join(testDir, '.daemon.pid'), 'not-a-number', 'utf-8');

    const pid = pidManager.read();

    expect(pid).toBeNull();
  });

  // AC: @daemon-server ac-10
  it('should remove PID file', () => {
    mkdirSync(testDir, { recursive: true });
    const pidManager = new PidFileManager(testDir);

    pidManager.write();
    expect(existsSync(join(testDir, '.daemon.pid'))).toBe(true);

    pidManager.remove();
    expect(existsSync(join(testDir, '.daemon.pid'))).toBe(false);
  });

  // AC: @daemon-server ac-10
  it('should not throw when removing non-existent PID file', () => {
    mkdirSync(testDir, { recursive: true });
    const pidManager = new PidFileManager(testDir);

    expect(() => pidManager.remove()).not.toThrow();
  });

  // AC: @daemon-server ac-9
  it('should detect running process', () => {
    const pidManager = new PidFileManager(testDir);

    // Current process should be running
    const isRunning = pidManager.isProcessRunning(process.pid);

    expect(isRunning).toBe(true);
  });

  // AC: @daemon-server ac-10
  it('should detect non-running process', () => {
    const pidManager = new PidFileManager(testDir);

    // Use a PID that's unlikely to exist (very high number)
    const isRunning = pidManager.isProcessRunning(999999);

    expect(isRunning).toBe(false);
  });

  // AC: @daemon-server ac-9
  it('should detect daemon running based on PID file', () => {
    mkdirSync(testDir, { recursive: true });
    const pidManager = new PidFileManager(testDir);

    pidManager.write();
    expect(pidManager.isDaemonRunning()).toBe(true);
  });

  // AC: @daemon-server ac-10
  it('should detect daemon not running when PID file absent', () => {
    mkdirSync(testDir, { recursive: true });
    const pidManager = new PidFileManager(testDir);

    expect(pidManager.isDaemonRunning()).toBe(false);
  });

  // AC: @daemon-server ac-10
  it('should detect daemon not running when PID file stale', () => {
    mkdirSync(testDir, { recursive: true });
    const pidManager = new PidFileManager(testDir);

    // Write a PID that doesn't exist
    writeFileSync(join(testDir, '.daemon.pid'), '999999', 'utf-8');

    expect(pidManager.isDaemonRunning()).toBe(false);
  });
});
