/**
 * Session context storage tests.
 *
 * Tests for .kspec-session storage - ephemeral session state separate from meta manifest.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  loadSessionContext,
  saveSessionContext,
  getSessionContextPath,
} from '../src/parser/meta.js';
import type { KspecContext } from '../src/parser/yaml.js';
import type { SessionContext } from '../src/schema/meta.js';

describe('Session context storage', () => {
  let testDir: string;
  let ctx: KspecContext;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kspec-context-test-'));
    ctx = {
      specDir: path.join(testDir, '.kspec'),
      manifestPath: path.join(testDir, '.kspec', 'kynetic.yaml'),
    };
    await fs.mkdir(ctx.specDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true });
  });

  describe('getSessionContextPath', () => {
    it('should return .kspec-session path', () => {
      const contextPath = getSessionContextPath(ctx);
      expect(contextPath).toBe(path.join(ctx.specDir, '.kspec-session'));
    });
  });

  describe('loadSessionContext', () => {
    it('should return empty context when file does not exist', async () => {
      const context = await loadSessionContext(ctx);

      expect(context.focus).toBeNull();
      expect(context.threads).toEqual([]);
      expect(context.open_questions).toEqual([]);
      expect(context.updated_at).toBeDefined();
    });

    it('should load valid context from file', async () => {
      // Write a valid context file
      const contextPath = getSessionContextPath(ctx);
      const testContext: SessionContext = {
        focus: '@test-task',
        threads: ['thread-1', 'thread-2'],
        open_questions: ['Q: How does this work?'],
        updated_at: '2026-01-18T10:00:00.000Z',
      };

      await fs.writeFile(contextPath, JSON.stringify(testContext), 'utf-8');

      const loaded = await loadSessionContext(ctx);

      expect(loaded.focus).toBe('@test-task');
      expect(loaded.threads).toEqual(['thread-1', 'thread-2']);
      expect(loaded.open_questions).toEqual(['Q: How does this work?']);
      expect(loaded.updated_at).toBe('2026-01-18T10:00:00.000Z');
    });

    it('should return empty context when file contains invalid data', async () => {
      const contextPath = getSessionContextPath(ctx);
      await fs.writeFile(contextPath, 'not valid yaml or json', 'utf-8');

      const context = await loadSessionContext(ctx);

      expect(context.focus).toBeNull();
      expect(context.threads).toEqual([]);
      expect(context.open_questions).toEqual([]);
      expect(context.updated_at).toBeDefined();
    });

    it('should validate context schema', async () => {
      const contextPath = getSessionContextPath(ctx);
      // Invalid: missing required field updated_at
      const invalidContext = {
        focus: '@test',
        threads: [],
      };

      await fs.writeFile(contextPath, JSON.stringify(invalidContext), 'utf-8');

      const context = await loadSessionContext(ctx);

      // Should return empty context due to validation failure
      expect(context.focus).toBeNull();
      expect(context.threads).toEqual([]);
      expect(context.updated_at).toBeDefined();
    });

    it('should handle empty file gracefully', async () => {
      const contextPath = getSessionContextPath(ctx);
      await fs.writeFile(contextPath, '', 'utf-8');

      const context = await loadSessionContext(ctx);

      expect(context.focus).toBeNull();
      expect(context.threads).toEqual([]);
      expect(context.updated_at).toBeDefined();
    });
  });

  describe('saveSessionContext', () => {
    it('should save context to .kspec-session file', async () => {
      const testContext: SessionContext = {
        focus: '@my-task',
        threads: ['thread-a', 'thread-b'],
        open_questions: ['Q: Test question?'],
        updated_at: '2026-01-18T10:00:00.000Z',
      };

      await saveSessionContext(ctx, testContext);

      const contextPath = getSessionContextPath(ctx);
      const exists = await fs
        .access(contextPath)
        .then(() => true)
        .catch(() => false);

      expect(exists).toBe(true);

      // Verify content can be reloaded
      const loaded = await loadSessionContext(ctx);
      expect(loaded.focus).toBe('@my-task');
      expect(loaded.threads).toEqual(['thread-a', 'thread-b']);
      expect(loaded.open_questions).toEqual(['Q: Test question?']);
    });

    it('should update timestamp when saving', async () => {
      const testContext: SessionContext = {
        focus: null,
        threads: [],
        open_questions: [],
        updated_at: '2020-01-01T00:00:00.000Z',
      };

      const beforeSave = new Date().toISOString();
      await saveSessionContext(ctx, testContext);
      const afterSave = new Date().toISOString();

      const loaded = await loadSessionContext(ctx);

      // Timestamp should be updated to current time
      expect(loaded.updated_at).not.toBe('2020-01-01T00:00:00.000Z');
      expect(loaded.updated_at >= beforeSave).toBe(true);
      expect(loaded.updated_at <= afterSave).toBe(true);
    });

    it('should overwrite existing context', async () => {
      const context1: SessionContext = {
        focus: '@task-1',
        threads: ['old-thread'],
        open_questions: [],
        updated_at: '2026-01-18T10:00:00.000Z',
      };

      await saveSessionContext(ctx, context1);

      const context2: SessionContext = {
        focus: '@task-2',
        threads: ['new-thread'],
        open_questions: ['New question?'],
        updated_at: '2026-01-18T11:00:00.000Z',
      };

      await saveSessionContext(ctx, context2);

      const loaded = await loadSessionContext(ctx);

      expect(loaded.focus).toBe('@task-2');
      expect(loaded.threads).toEqual(['new-thread']);
      expect(loaded.open_questions).toEqual(['New question?']);
    });

    it('should save empty context', async () => {
      const emptyContext: SessionContext = {
        focus: null,
        threads: [],
        open_questions: [],
        updated_at: new Date().toISOString(),
      };

      await saveSessionContext(ctx, emptyContext);

      const loaded = await loadSessionContext(ctx);

      expect(loaded.focus).toBeNull();
      expect(loaded.threads).toEqual([]);
      expect(loaded.open_questions).toEqual([]);
    });
  });

  describe('Context lifecycle', () => {
    it('should be separate from meta manifest', async () => {
      const metaPath = path.join(ctx.specDir, 'kynetic.meta.yaml');
      const contextPath = getSessionContextPath(ctx);

      // Create meta manifest
      await fs.writeFile(metaPath, 'kynetic_meta: "1.0"\n', 'utf-8');

      // Save context
      const context: SessionContext = {
        focus: '@test',
        threads: [],
        open_questions: [],
        updated_at: new Date().toISOString(),
      };
      await saveSessionContext(ctx, context);

      // Both files should exist independently
      const metaExists = await fs
        .access(metaPath)
        .then(() => true)
        .catch(() => false);
      const contextExists = await fs
        .access(contextPath)
        .then(() => true)
        .catch(() => false);

      expect(metaExists).toBe(true);
      expect(contextExists).toBe(true);
      expect(metaPath).not.toBe(contextPath);
    });

    it('should be deletable without affecting meta manifest', async () => {
      const metaPath = path.join(ctx.specDir, 'kynetic.meta.yaml');
      const contextPath = getSessionContextPath(ctx);

      // Create both files
      await fs.writeFile(metaPath, 'kynetic_meta: "1.0"\n', 'utf-8');
      await saveSessionContext(ctx, {
        focus: '@test',
        threads: [],
        open_questions: [],
        updated_at: new Date().toISOString(),
      });

      // Delete context
      await fs.unlink(contextPath);

      // Meta should still exist
      const metaExists = await fs
        .access(metaPath)
        .then(() => true)
        .catch(() => false);

      expect(metaExists).toBe(true);

      // loadSessionContext should return empty context
      const context = await loadSessionContext(ctx);
      expect(context.focus).toBeNull();
    });
  });
});
