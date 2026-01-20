/**
 * Tests for trait edge cases
 * AC: @trait-edge-cases
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { setupTempFixtures, kspecOutput as kspec, kspecJson } from './helpers/cli';

describe('trait edge cases', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  // AC: @trait-edge-cases ac-1
  it('should warn when trait has no acceptance criteria', async () => {
    // Create a trait without AC
    kspec('trait add "Test Trait" --slug test-trait', tempDir);

    // Run validation - use kspec helper without JSON parsing first
    const rawOutput = kspec('validate', tempDir);

    // Should contain completeness warning for missing AC
    expect(rawOutput).toContain('Completeness warnings');
    expect(rawOutput).toContain('Missing acceptance criteria');
    expect(rawOutput).toContain('@test-trait');
  });

  // AC: @trait-edge-cases ac-2
  it('should detect circular trait references', async () => {
    // Create two traits that reference each other
    // First create the traits
    kspec('trait add "Trait A" --slug trait-a', tempDir);
    kspec('trait add "Trait B" --slug trait-b', tempDir);

    // Manually edit kynetic.yaml to add circular references
    const manifestPath = path.join(tempDir, 'kynetic.yaml');
    const manifestContent = await fs.readFile(manifestPath, 'utf-8');

    // Add traits field to trait-a that references trait-b
    const updatedContent = manifestContent.replace(
      /(_ulid: \w+\s+slugs:\s+- trait-a\s+title: Trait A\s+type: trait)/,
      '$1\n  traits:\n    - "@trait-b"'
    ).replace(
      /(_ulid: \w+\s+slugs:\s+- trait-b\s+title: Trait B\s+type: trait)/,
      '$1\n  traits:\n    - "@trait-a"'
    );

    await fs.writeFile(manifestPath, updatedContent, 'utf-8');

    // Run validation
    const rawOutput = kspec('validate', tempDir);

    // Should detect cycle
    expect(rawOutput).toContain('Trait cycle errors');
    expect(rawOutput).toContain('Circular trait reference');
    expect(rawOutput).toContain('Validation failed');
  });

  // AC: @trait-edge-cases ac-3
  it('should report broken trait reference when trait is deleted', async () => {
    // Create a trait and a spec that implements it
    kspec('trait add "Test Trait" --slug test-trait', tempDir);
    // Add a module first, then add spec under it
    kspec('module add "Test Module" --slug test-module', tempDir);
    kspec('item add --under @test-module --title "Test Spec" --slug test-spec', tempDir);
    kspec('item trait add @test-spec @test-trait', tempDir);

    // Manually delete the trait from kynetic.yaml
    const manifestPath = path.join(tempDir, 'kynetic.yaml');
    let manifestContent = await fs.readFile(manifestPath, 'utf-8');

    // Remove the trait from traits array
    // Find the trait section and remove it
    const lines = manifestContent.split('\n');
    const traitStart = lines.findIndex(line => line.includes('title: Test Trait'));
    if (traitStart > 0) {
      // Find the start of this trait item (look backwards for the _ulid)
      let itemStart = traitStart;
      while (itemStart > 0 && !lines[itemStart].includes('_ulid:')) {
        itemStart--;
      }

      // Find the end (next item or end of traits array)
      let itemEnd = traitStart + 1;
      while (itemEnd < lines.length &&
             !lines[itemEnd].match(/^  - _ulid:/) &&
             !lines[itemEnd].match(/^[a-z]/)) {
        itemEnd++;
      }

      // Remove the trait item
      lines.splice(itemStart, itemEnd - itemStart);
      manifestContent = lines.join('\n');
      await fs.writeFile(manifestPath, manifestContent, 'utf-8');
    }

    // Run validation
    const rawOutput = kspec('validate', tempDir);

    // Should have reference error for broken trait reference
    expect(rawOutput).toContain('Reference errors');
    expect(rawOutput).toContain('@test-trait');
    expect(rawOutput).toContain('traits');
    expect(rawOutput).toContain('Validation failed');
  });

  // AC: @trait-edge-cases ac-4
  it('should show "No traits defined" message when list is empty', async () => {
    // Run trait list on fresh repo (no traits created yet)
    const output = kspec('trait list', tempDir);

    expect(output).toContain('No traits defined');
  });
});
