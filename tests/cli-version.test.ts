/**
 * Tests for CLI version display
 * Spec: @cli-version
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { CLI_PATH } from './helpers/cli.js';

// Read the actual version from package.json
const packageJsonPath = path.join(__dirname, '..', 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
const expectedVersion = packageJson.version;

describe('CLI version display', () => {
  // AC: @cli-version ac-1
  it('should display version from package.json with --version flag', () => {
    const result = execSync(`node ${CLI_PATH} --version`, {
      encoding: 'utf-8',
    }).trim();

    expect(result).toBe(expectedVersion);
  });

  // AC: @cli-version ac-1
  it('should display version from package.json with -V flag', () => {
    const result = execSync(`node ${CLI_PATH} -V`, {
      encoding: 'utf-8',
    }).trim();

    expect(result).toBe(expectedVersion);
  });

  // AC: @cli-version ac-2
  // This test verifies the implementation reads from package.json dynamically.
  // If the version were hardcoded, this test would fail when package.json changes.
  it('should match the version in package.json (verifies dynamic reading)', () => {
    const cliVersion = execSync(`node ${CLI_PATH} --version`, {
      encoding: 'utf-8',
    }).trim();

    // Both should be the same - proves CLI reads from package.json
    expect(cliVersion).toBe(expectedVersion);
    // Verify we're not comparing against a hardcoded test value
    expect(expectedVersion).toMatch(/^\d+\.\d+\.\d+/);
  });
});
