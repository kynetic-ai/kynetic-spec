/**
 * Tests for daemon session sync manifest discovery.
 *
 * Verifies that findManifestInDir is exported and works correctly for
 * non-default manifest names, ensuring the daemon can discover manifests
 * via the discovery API.
 *
 * AC: @multi-directory-daemon ac-31
 * AC: @manifest-discovery ac-6
 *
 * Task: @fix-daemon-session-sync-hardcoded-manifest-path
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createTempDir, cleanupTempDir } from './helpers/cli';
import { findManifestInDir } from '../src/parser/yaml';

describe('Daemon session sync manifest discovery', () => {
  describe('findManifestInDir export', () => {
    // AC: @manifest-discovery ac-6
    it('should be exported from parser/yaml', () => {
      expect(typeof findManifestInDir).toBe('function');
    });
  });

  describe('findManifestInDir with non-default manifest names', () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await createTempDir();
    });

    afterEach(async () => {
      await cleanupTempDir(tempDir);
    });

    // AC: @manifest-discovery ac-6
    // AC: @multi-directory-daemon ac-31
    it('should discover slug-based manifest (not just kynetic.yaml)', async () => {
      // Create a slug-based manifest (e.g., be-kynetic.yaml) with valid kynetic version field
      const manifestName = 'be-kynetic.yaml';
      await fs.writeFile(
        path.join(tempDir, manifestName),
        'kynetic: "1.0"\nproject: Test\n',
      );

      const result = await findManifestInDir(tempDir);
      expect(result).toBe(path.join(tempDir, manifestName));
    });

    // AC: @manifest-discovery ac-1
    it('should prefer kynetic.yaml over slug-based manifests', async () => {
      // Create both default and slug-based manifests
      await fs.writeFile(
        path.join(tempDir, 'kynetic.yaml'),
        'kynetic: "1.0"\nproject: Default\n',
      );
      await fs.writeFile(
        path.join(tempDir, 'be-kynetic.yaml'),
        'kynetic: "1.0"\nproject: Slug\n',
      );

      const result = await findManifestInDir(tempDir);
      expect(result).toBe(path.join(tempDir, 'kynetic.yaml'));
    });

    // AC: @multi-directory-daemon ac-31
    it('should return null when no manifest exists (graceful skip)', async () => {
      const result = await findManifestInDir(tempDir);
      expect(result).toBeNull();
    });

    // AC: @manifest-discovery ac-2
    it('should discover kynetic.spec.yaml as backward-compatible name', async () => {
      await fs.writeFile(
        path.join(tempDir, 'kynetic.spec.yaml'),
        'kynetic: "1.0"\nproject: Test\n',
      );

      const result = await findManifestInDir(tempDir);
      expect(result).toBe(path.join(tempDir, 'kynetic.spec.yaml'));
    });
  });
});
