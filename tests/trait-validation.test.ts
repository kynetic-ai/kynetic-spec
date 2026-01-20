/**
 * Tests for trait type validation
 * AC: @trait-type ac-2, ac-3
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { validate } from '../src/parser/validate.js';
import { initContext } from '../src/parser/yaml.js';
import { writeYamlFilePreserveFormat } from '../src/parser/yaml.js';

describe('Trait validation', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kspec-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // AC: @trait-type ac-2
  it('should warn when trait item is missing acceptance criteria', async () => {
    // Setup minimal kspec structure (use spec/ not .kspec/ for simplicity)
    const specDir = path.join(tempDir, 'spec');
    const modulesDir = path.join(specDir, 'modules');
    await fs.mkdir(modulesDir, { recursive: true });

    // Create manifest
    const manifest = {
      project: {
        name: 'test-project',
      },
      includes: ['modules/traits.yaml'],
    };
    await writeYamlFilePreserveFormat(path.join(specDir, 'kynetic.yaml'), manifest);

    // Create trait without acceptance criteria
    const trait = {
      _ulid: '01KFCRVY8ERZEE2MNHEQXSG90T',
      slugs: ['test-trait'],
      title: 'Test Trait',
      type: 'trait',
      description: 'A test trait with no AC',
      status: { maturity: 'draft', implementation: 'not_started' },
    };
    await writeYamlFilePreserveFormat(path.join(modulesDir, 'traits.yaml'), trait);

    // Run validation
    const ctx = await initContext(tempDir);
    const result = await validate(ctx, { completeness: true });

    // Verify warning
    const acWarnings = result.completenessWarnings.filter(
      w => w.type === 'missing_acceptance_criteria' && w.itemRef.includes('test-trait')
    );
    expect(acWarnings).toHaveLength(1);
    expect(acWarnings[0].message).toContain('Trait');
    expect(acWarnings[0].message).toContain('has no acceptance criteria');
  });

  // AC: @trait-type ac-3
  it('should warn when trait item is missing description', async () => {
    // Setup minimal kspec structure
    const specDir = path.join(tempDir, 'spec');
    const modulesDir = path.join(specDir, 'modules');
    await fs.mkdir(modulesDir, { recursive: true });

    // Create manifest
    const manifest = {
      project: {
        name: 'test-project',
      },
      includes: ['modules/traits.yaml'],
    };
    await writeYamlFilePreserveFormat(path.join(specDir, 'kynetic.yaml'), manifest);

    // Create trait without description
    const trait = {
      _ulid: '01KFCRVY8MT49H8N6JW35NN2P3',
      slugs: ['test-trait-no-desc'],
      title: 'Test Trait No Description',
      type: 'trait',
      status: { maturity: 'draft', implementation: 'not_started' },
      acceptance_criteria: [
        {
          id: 'ac-1',
          given: 'test condition',
          when: 'test action',
          then: 'test result',
        },
      ],
    };
    await writeYamlFilePreserveFormat(path.join(modulesDir, 'traits.yaml'), trait);

    // Run validation
    const ctx = await initContext(tempDir);
    const result = await validate(ctx, { completeness: true });

    // Verify warning
    const descWarnings = result.completenessWarnings.filter(
      w => w.type === 'missing_description' && w.itemRef.includes('test-trait-no-desc')
    );
    expect(descWarnings).toHaveLength(1);
    expect(descWarnings[0].message).toContain('Trait');
    expect(descWarnings[0].message).toContain('has no description');
  });

  // AC: @trait-type ac-2 and ac-3 combined
  it('should emit both warnings when trait is missing AC and description', async () => {
    // Setup minimal kspec structure
    const specDir = path.join(tempDir, 'spec');
    const modulesDir = path.join(specDir, 'modules');
    await fs.mkdir(modulesDir, { recursive: true });

    // Create manifest
    const manifest = {
      project: {
        name: 'test-project',
      },
      includes: ['modules/traits.yaml'],
    };
    await writeYamlFilePreserveFormat(path.join(specDir, 'kynetic.yaml'), manifest);

    // Create incomplete trait
    const trait = {
      _ulid: '01KFCRVY8NPV114TGJJ5FHB4G8',
      slugs: ['incomplete-trait'],
      title: 'Incomplete Trait',
      type: 'trait',
      status: { maturity: 'draft', implementation: 'not_started' },
    };
    await writeYamlFilePreserveFormat(path.join(modulesDir, 'traits.yaml'), trait);

    // Run validation
    const ctx = await initContext(tempDir);
    const result = await validate(ctx, { completeness: true });

    // Verify both warnings
    const traitWarnings = result.completenessWarnings.filter(
      w => w.itemRef.includes('incomplete-trait')
    );
    expect(traitWarnings.length).toBeGreaterThanOrEqual(2);

    const hasAcWarning = traitWarnings.some(
      w => w.type === 'missing_acceptance_criteria' && w.message.includes('Trait')
    );
    const hasDescWarning = traitWarnings.some(
      w => w.type === 'missing_description' && w.message.includes('Trait')
    );

    expect(hasAcWarning).toBe(true);
    expect(hasDescWarning).toBe(true);
  });

  it('should not warn when trait has both AC and description', async () => {
    // Setup minimal kspec structure
    const specDir = path.join(tempDir, 'spec');
    const modulesDir = path.join(specDir, 'modules');
    await fs.mkdir(modulesDir, { recursive: true });

    // Create manifest
    const manifest = {
      project: {
        name: 'test-project',
      },
      includes: ['modules/traits.yaml'],
    };
    await writeYamlFilePreserveFormat(path.join(specDir, 'kynetic.yaml'), manifest);

    // Create complete trait
    const trait = {
      _ulid: '01KFCRVY8NH1TKTRKV65KS79ED',
      slugs: ['complete-trait'],
      title: 'Complete Trait',
      type: 'trait',
      description: 'A complete trait with both AC and description',
      status: { maturity: 'draft', implementation: 'not_started' },
      acceptance_criteria: [
        {
          id: 'ac-1',
          given: 'test condition',
          when: 'test action',
          then: 'test result',
        },
      ],
    };
    await writeYamlFilePreserveFormat(path.join(modulesDir, 'traits.yaml'), trait);

    // Run validation
    const ctx = await initContext(tempDir);
    const result = await validate(ctx, { completeness: true });

    // Verify no missing AC or description warnings for this trait
    // (May still have test coverage warning, which is okay)
    const traitWarnings = result.completenessWarnings.filter(
      w => w.itemRef.includes('complete-trait') &&
           (w.type === 'missing_acceptance_criteria' || w.type === 'missing_description')
    );
    expect(traitWarnings).toHaveLength(0);
  });
});
