/**
 * Tests for Web UI Shared Types
 *
 * Verifies that web-ui types files re-export from @kynetic-ai/shared
 * instead of defining duplicate local types. Prevents type drift
 * between the shared package and web-ui.
 */

import { describe, it, expect } from 'vitest';
import { readFile, readdir } from 'fs/promises';
import { join } from 'path';

const TYPES_DIR = join(process.cwd(), 'packages/web-ui/src/lib/types');

describe('Web UI shared types', () => {
  it('types directory files should only re-export from @kynetic-ai/shared', async () => {
    const files = await readdir(TYPES_DIR);
    const tsFiles = files.filter(f => f.endsWith('.ts') && !f.endsWith('.d.ts'));

    for (const file of tsFiles) {
      const content = await readFile(join(TYPES_DIR, file), 'utf-8');

      // Should not define local interfaces
      const interfaceMatches = content.match(/^export interface /gm);
      expect(
        interfaceMatches,
        `${file} should not define local interfaces — import from @kynetic-ai/shared instead`
      ).toBeNull();

      // Should not define local type aliases (except re-exports)
      const typeDefMatches = content.match(/^export type \w+ =/gm);
      expect(
        typeDefMatches,
        `${file} should not define local type aliases — import from @kynetic-ai/shared instead`
      ).toBeNull();

      // Should re-export from shared
      expect(
        content,
        `${file} should re-export from @kynetic-ai/shared`
      ).toContain('@kynetic-ai/shared');
    }
  });

  it('triage types should re-export TriageRecord, TriageAction, TriageStatus', async () => {
    const content = await readFile(join(TYPES_DIR, 'triage.ts'), 'utf-8');
    expect(content).toContain('TriageRecord');
    expect(content).toContain('TriageAction');
    expect(content).toContain('TriageStatus');
    expect(content).toContain("from '@kynetic-ai/shared'");
  });

  it('snapshot types should re-export Convention and export types', async () => {
    const content = await readFile(join(TYPES_DIR, 'snapshot.ts'), 'utf-8');
    expect(content).toContain('Convention');
    expect(content).toContain('ExportedTask');
    expect(content).toContain('ExportedItem');
    expect(content).toContain('KspecSnapshot');
    expect(content).toContain("from '@kynetic-ai/shared'");
  });
});
