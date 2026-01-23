/**
 * Tests for daemon auto-start configuration
 * Task: @01KFMMZK
 * Spec: @daemon-server (implicit auto-start behavior)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTempDir, cleanupTempDir, initGitRepo } from './helpers/cli';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { stringify } from 'yaml';
import { initContext } from '../src/parser/yaml';

describe('Daemon Auto-Start Configuration', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    await initGitRepo(tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: Daemon config schema accepts auto_start and port
  it('should parse daemon config from kynetic.yaml with defaults', async () => {
    const kyneticYaml = stringify({
      kynetic: '1.0',
      project: {
        name: 'Test Project',
      },
      daemon: {
        auto_start: true,
        port: 3456,
      },
    });

    await writeFile(join(tempDir, 'kynetic.yaml'), kyneticYaml);

    const context = await initContext(tempDir);
    expect(context.manifest).toBeTruthy();
    expect(context.manifest?.daemon).toEqual({
      auto_start: true,
      port: 3456,
    });
  });

  // AC: Daemon config is optional
  it('should handle missing daemon config gracefully', async () => {
    const kyneticYaml = stringify({
      kynetic: '1.0',
      project: {
        name: 'Test Project',
      },
    });

    await writeFile(join(tempDir, 'kynetic.yaml'), kyneticYaml);

    const context = await initContext(tempDir);
    expect(context.manifest).toBeTruthy();
    expect(context.manifest?.daemon).toBeUndefined();
  });

  // AC: auto_start defaults to true when daemon section exists but auto_start is not specified
  it('should use default auto_start=true when not specified', async () => {
    const kyneticYaml = stringify({
      kynetic: '1.0',
      project: {
        name: 'Test Project',
      },
      daemon: {
        port: 4000,
      },
    });

    await writeFile(join(tempDir, 'kynetic.yaml'), kyneticYaml);

    const context = await initContext(tempDir);
    expect(context.manifest?.daemon?.auto_start).toBe(true);
  });

  // AC: port defaults to 3456 when not specified
  it('should use default port=3456 when not specified', async () => {
    const kyneticYaml = stringify({
      kynetic: '1.0',
      project: {
        name: 'Test Project',
      },
      daemon: {
        auto_start: false,
      },
    });

    await writeFile(join(tempDir, 'kynetic.yaml'), kyneticYaml);

    const context = await initContext(tempDir);
    expect(context.manifest?.daemon?.port).toBe(3456);
  });

  // AC: auto_start can be disabled
  it('should allow disabling auto_start', async () => {
    const kyneticYaml = stringify({
      kynetic: '1.0',
      project: {
        name: 'Test Project',
      },
      daemon: {
        auto_start: false,
        port: 3456,
      },
    });

    await writeFile(join(tempDir, 'kynetic.yaml'), kyneticYaml);

    const context = await initContext(tempDir);
    expect(context.manifest?.daemon?.auto_start).toBe(false);
  });

  // AC: port validation rejects invalid values
  it('should reject invalid port numbers', async () => {
    const invalidPorts = [0, -1, 65536, 100000];

    for (const invalidPort of invalidPorts) {
      const kyneticYaml = stringify({
        kynetic: '1.0',
        project: {
          name: 'Test Project',
        },
        daemon: {
          auto_start: true,
          port: invalidPort,
        },
      });

      await writeFile(join(tempDir, 'kynetic.yaml'), kyneticYaml);

      // initContext will fail to parse invalid manifest
      const context = await initContext(tempDir);
      // Invalid manifest should be caught during parsing
      // The manifest will be null if parsing fails
      expect(context.manifest).toBeNull();
    }
  });

  // AC: port accepts valid range (1-65535)
  it('should accept valid port numbers in range 1-65535', async () => {
    const validPorts = [1, 80, 3456, 8080, 65535];

    for (const validPort of validPorts) {
      const kyneticYaml = stringify({
        kynetic: '1.0',
        project: {
          name: 'Test Project',
        },
        daemon: {
          auto_start: true,
          port: validPort,
        },
      });

      await writeFile(join(tempDir, 'kynetic.yaml'), kyneticYaml);

      const context = await initContext(tempDir);
      expect(context.manifest?.daemon?.port).toBe(validPort);
    }
  });
});
