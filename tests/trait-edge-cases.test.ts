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
    // Trait shows up as title in completeness warnings
    expect(rawOutput).toContain('Test Trait');
  });

  // AC: @trait-edge-cases ac-2
  it('should detect circular trait references', async () => {
    // Create two traits that reference each other
    // First create the traits
    kspec('trait add "Trait A" --slug trait-a', tempDir);
    kspec('trait add "Trait B" --slug trait-b', tempDir);

    // Use CLI to add trait references creating a cycle
    kspec('item trait add @trait-a @trait-b', tempDir);
    kspec('item trait add @trait-b @trait-a', tempDir);

    // Run validation
    const rawOutput = kspec('validate', tempDir);

    // Should detect cycle
    expect(rawOutput).toContain('Trait cycle errors');
    expect(rawOutput).toContain('Circular trait reference');
    expect(rawOutput).toContain('Validation failed');
  });

  // AC: @trait-edge-cases ac-3
  it('should report broken trait reference when trait is deleted', async () => {
    // Create a trait
    kspec('trait add "Test Trait" --slug test-trait', tempDir);

    // Create a feature with a trait reference in core.yaml
    const corePath = path.join(tempDir, 'modules/core.yaml');
    const yaml = require('yaml');
    const coreContent = await fs.readFile(corePath, 'utf-8');
    const doc = yaml.parseDocument(coreContent);

    // Add traits field to the first feature
    const features = doc.get('features');
    if (features && features.items && features.items.length > 0) {
      features.items[0].set('traits', ['@test-trait']);
    }
    await fs.writeFile(corePath, doc.toString(), 'utf-8');

    // Verify the trait reference works before deletion
    const beforeOutput = kspec('validate', tempDir);
    expect(beforeOutput).toContain('References: OK');

    // Delete the trait from manifest
    const manifestPath = path.join(tempDir, 'kynetic.yaml');
    const manifestContent = await fs.readFile(manifestPath, 'utf-8');
    const manifestDoc = yaml.parseDocument(manifestContent);
    manifestDoc.set('traits', []);
    await fs.writeFile(manifestPath, manifestDoc.toString(), 'utf-8');

    // Run validation - should now have reference error
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
