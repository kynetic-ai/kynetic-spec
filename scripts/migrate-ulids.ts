#!/usr/bin/env npx tsx
/**
 * Migration script to fix invalid ULIDs in spec files.
 *
 * ULIDs must be Crockford base32 (no I, L, O, U characters).
 * This script:
 * 1. Finds all invalid ULIDs in spec/ directory
 * 2. Generates valid replacement ULIDs
 * 3. Updates all references to those ULIDs
 * 4. Writes back the files
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ulid } from 'ulid';

// Crockford base32 pattern - excludes I, L, O, U
const VALID_ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
const INVALID_CHAR_PATTERN = /[ILOU]/i;

interface UlidMapping {
  old: string;
  new: string;
  file: string;
  context: string; // title or slug for debugging
}

async function findYamlFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await findYamlFiles(fullPath));
    } else if (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')) {
      files.push(fullPath);
    }
  }

  return files;
}

function isInvalidUlid(id: string): boolean {
  if (typeof id !== 'string' || id.length !== 26) return false;
  return INVALID_CHAR_PATTERN.test(id);
}

function findUlidsInContent(content: string, file: string): UlidMapping[] {
  const mappings: UlidMapping[] = [];

  // Match _ulid: followed by the ULID value (quoted or unquoted)
  const ulidRegex = /_ulid:\s*['"]?([0-9A-Z]{26})['"]?/gi;
  let match;

  while ((match = ulidRegex.exec(content)) !== null) {
    const oldUlid = match[1];
    if (isInvalidUlid(oldUlid)) {
      // Try to find context (title on nearby line)
      const lineStart = content.lastIndexOf('\n', match.index) + 1;
      const nextLines = content.slice(lineStart, lineStart + 500);
      const titleMatch = nextLines.match(/title:\s*['"]?([^'"\n]+)/);
      const slugMatch = nextLines.match(/slugs:\s*\[([^\]]+)\]/);

      const context = titleMatch?.[1] || slugMatch?.[1]?.split(',')[0]?.trim() || 'unknown';

      mappings.push({
        old: oldUlid,
        new: ulid(),
        file,
        context,
      });
    }
  }

  return mappings;
}

function applyMappings(content: string, mappings: UlidMapping[]): string {
  let result = content;

  for (const mapping of mappings) {
    // Replace full ULID occurrences
    const fullPattern = new RegExp(mapping.old, 'gi');
    result = result.replace(fullPattern, mapping.new);

    // Also check for short ULID references (8-char prefix is common)
    // Only replace if it's clearly a reference context (after @ or in depends_on, etc.)
    const shortOld = mapping.old.slice(0, 8);
    const shortNew = mapping.new.slice(0, 8);

    // Be careful: only replace short refs that are clearly references
    // Pattern: @SHORTULID or in array context ['@SHORTULID']
    const shortRefPattern = new RegExp(`(@${shortOld})(?![0-9A-Z])`, 'gi');
    result = result.replace(shortRefPattern, `@${shortNew}`);
  }

  return result;
}

async function main() {
  const specDir = path.join(process.cwd(), 'spec');

  console.log('Finding YAML files in spec/...');
  const files = await findYamlFiles(specDir);
  console.log(`Found ${files.length} YAML files\n`);

  // First pass: collect all invalid ULIDs
  const allMappings: UlidMapping[] = [];
  const contentCache = new Map<string, string>();

  for (const file of files) {
    const content = await fs.readFile(file, 'utf-8');
    contentCache.set(file, content);

    const mappings = findUlidsInContent(content, file);
    allMappings.push(...mappings);
  }

  if (allMappings.length === 0) {
    console.log('No invalid ULIDs found. All good!');
    return;
  }

  console.log(`Found ${allMappings.length} invalid ULIDs to migrate:\n`);

  // Group by file for display
  const byFile = new Map<string, UlidMapping[]>();
  for (const m of allMappings) {
    const existing = byFile.get(m.file) || [];
    existing.push(m);
    byFile.set(m.file, existing);
  }

  for (const [file, mappings] of byFile) {
    console.log(`${path.relative(process.cwd(), file)}:`);
    for (const m of mappings) {
      console.log(`  ${m.old} -> ${m.new} (${m.context})`);
    }
    console.log();
  }

  // Check for --dry-run flag
  if (process.argv.includes('--dry-run')) {
    console.log('Dry run mode - no files modified');
    return;
  }

  // Second pass: apply mappings to all files
  console.log('Applying migrations...\n');

  for (const file of files) {
    const original = contentCache.get(file)!;
    const updated = applyMappings(original, allMappings);

    if (original !== updated) {
      await fs.writeFile(file, updated, 'utf-8');
      console.log(`Updated: ${path.relative(process.cwd(), file)}`);
    }
  }

  console.log('\nMigration complete!');
  console.log('Run "npm test" to verify everything still works.');
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
