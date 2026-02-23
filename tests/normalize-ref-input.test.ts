import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizeRefInput } from '../src/schema/common';

describe('normalizeRefInput', () => {
  it('should add @ prefix to bare slugs', () => {
    expect(normalizeRefInput('my-task')).toBe('@my-task');
  });

  it('should preserve existing @ prefix', () => {
    expect(normalizeRefInput('@my-task')).toBe('@my-task');
  });

  it('should add @ prefix to bare ULIDs', () => {
    expect(normalizeRefInput('01JHNKAB')).toBe('@01JHNKAB');
  });

  it('should preserve @ prefix on ULIDs', () => {
    expect(normalizeRefInput('@01JHNKAB')).toBe('@01JHNKAB');
  });

  it('should handle full-length ULIDs', () => {
    const ulid = '01KJ4SM5NXME299C3KB4FG7J0A';
    expect(normalizeRefInput(ulid)).toBe(`@${ulid}`);
    expect(normalizeRefInput(`@${ulid}`)).toBe(`@${ulid}`);
  });

  it('should handle empty-ish strings gracefully', () => {
    // Edge case: single character
    expect(normalizeRefInput('a')).toBe('@a');
    // Already prefixed single char
    expect(normalizeRefInput('@a')).toBe('@a');
  });
});

describe('Static analysis: no inline ref normalization in CLI commands', () => {
  const cliDir = path.resolve(__dirname, '../src/cli/commands');
  const daemonRoutesDir = path.resolve(__dirname, '../packages/daemon/src/routes');

  // Pattern that matches inline ref normalization: x.startsWith("@") ? x : `@${x}`
  // Uses multiline matching to catch patterns split across lines
  // Catches both simple vars (ref) and dotted access (options.spec)
  const inlineNormalizationPattern = /\.startsWith\(["']@["']\)\s*\?\s*[\w.]+\s*:\s*`@\$\{/;
  // Multiline version for patterns split across lines (e.g., ternary on separate lines)
  const multilineNormalizationPattern = /\.startsWith\(["']@["']\)\s*\n\s*\?\s*[\w.]+\s*\n\s*:\s*`@\$\{/;

  function getTypeScriptFiles(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.ts'))
      .map(f => path.join(dir, f));
  }

  it('should not have inline ref normalization in CLI command files', () => {
    const files = getTypeScriptFiles(cliDir);
    const violations: string[] = [];

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      const basename = path.basename(file);

      // Check single-line patterns
      const lines = content.split('\n');
      lines.forEach((line, i) => {
        if (inlineNormalizationPattern.test(line)) {
          violations.push(`${basename}:${i + 1}: ${line.trim()}`);
        }
      });

      // Check multiline patterns (ternary split across lines)
      const multilineMatches = content.match(new RegExp(multilineNormalizationPattern.source, 'g'));
      if (multilineMatches) {
        for (const match of multilineMatches) {
          // Find the line number of the match
          const idx = content.indexOf(match);
          const lineNum = content.slice(0, idx).split('\n').length;
          violations.push(`${basename}:${lineNum}: ${match.split('\n').map(l => l.trim()).join(' ')}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('should not have inline ref normalization in daemon route files', () => {
    const files = getTypeScriptFiles(daemonRoutesDir);
    const violations: string[] = [];

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      const basename = path.basename(file);

      // Check single-line patterns
      const lines = content.split('\n');
      lines.forEach((line, i) => {
        if (inlineNormalizationPattern.test(line)) {
          violations.push(`${basename}:${i + 1}: ${line.trim()}`);
        }
      });

      // Check multiline patterns
      const multilineMatches = content.match(new RegExp(multilineNormalizationPattern.source, 'g'));
      if (multilineMatches) {
        for (const match of multilineMatches) {
          const idx = content.indexOf(match);
          const lineNum = content.slice(0, idx).split('\n').length;
          violations.push(`${basename}:${lineNum}: ${match.split('\n').map(l => l.trim()).join(' ')}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

describe('Integration: normalizeRefInput at CLI boundary', () => {
  // These tests verify that the function is used in the right places
  // by checking that the import exists in key CLI command files

  const expectedFiles = [
    'src/cli/commands/task.ts',
    'src/cli/commands/tasks.ts',
    'src/cli/commands/derive.ts',
    'src/cli/commands/plan-import.ts',
    'src/cli/commands/meta.ts',
    'src/cli/commands/log.ts',
    'src/cli/commands/triage.ts',
    'packages/daemon/src/routes/triage.ts',
  ];

  for (const file of expectedFiles) {
    it(`should import normalizeRefInput in ${path.basename(file)}`, () => {
      const filePath = path.resolve(__dirname, '..', file);
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('normalizeRefInput');
      expect(content).toMatch(/import\s*{[^}]*normalizeRefInput[^}]*}/);
    });
  }
});
