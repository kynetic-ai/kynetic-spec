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
    // Create a trait and a spec that implements it
    kspec('trait add "Test Trait" --slug test-trait', tempDir);

    // Create module and spec manually since CLI doesn't support module creation at root
    const modulePath = path.join(tempDir, 'modules/test.yaml');
    const moduleContent = `_ulid: 01TEST0000000000000000001
slugs:
  - test-module
title: Test Module
type: module
items:
  - _ulid: 01TEST0000000000000000002
    slugs:
      - test-spec
    title: Test Spec
    type: feature
    traits:
      - "@test-trait"
    status:
      maturity: draft
      implementation: not_started
`;
    await fs.writeFile(modulePath, moduleContent, 'utf-8');

    // Manually delete the trait from kynetic.yaml using yaml library
    const manifestPath = path.join(tempDir, 'kynetic.yaml');
    const yaml = require('yaml');
    const manifestContent = await fs.readFile(manifestPath, 'utf-8');
    const doc = yaml.parseDocument(manifestContent);

    // Remove the trait from traits array
    const traits = doc.get('traits');
    if (traits && traits.items) {
      const newTraits = traits.items.filter((trait: any) => {
        const slugs = trait.get('slugs');
        return !(slugs && slugs.items && slugs.items[0] === 'test-trait');
      });
      doc.set('traits', newTraits);
      await fs.writeFile(manifestPath, doc.toString(), 'utf-8');
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
