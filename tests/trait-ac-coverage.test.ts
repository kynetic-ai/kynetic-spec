/**
 * Tests for trait AC coverage validation
 * AC: @trait-validation ac-1, ac-2, ac-3, ac-4
 *
 * NOTE: These tests validate the coverage detection mechanism.
 * The fixture tests shown here (like "expect(true).toBe(true)")
 * are ONLY for validating the scanner - they are NOT examples
 * of good test quality. Production tests should meaningfully
 * validate the acceptance criteria they claim to cover.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { validate } from '../src/parser/validate.js';
import { initContext } from '../src/parser/yaml.js';
import { writeYamlFilePreserveFormat } from '../src/parser/yaml.js';

describe('Trait AC coverage validation', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kspec-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // AC: @trait-validation ac-1
  it('should warn when spec implementing trait has no test coverage for trait AC', async () => {
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

    // Create a trait with AC
    const trait = {
      _ulid: '01KFCRVY8ERZEE2MNHEQXSG90T',
      slugs: ['test-trait'],
      title: 'Test Trait',
      type: 'trait',
      description: 'A test trait with AC',
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

    // Create a spec implementing the trait
    const spec = {
      _ulid: '01KFCRVY8MT49H8N6JW35NN2P3',
      slugs: ['test-spec'],
      title: 'Test Spec',
      type: 'requirement',
      description: 'A spec implementing the trait',
      status: { maturity: 'draft', implementation: 'not_started' },
      traits: ['@test-trait'],
    };

    await writeYamlFilePreserveFormat(path.join(modulesDir, 'traits.yaml'), [trait, spec]);

    // Run validation (no tests directory = no coverage)
    const ctx = await initContext(tempDir);
    const result = await validate(ctx, { completeness: true });

    // Verify warning for missing trait AC coverage
    const coverageWarnings = result.completenessWarnings.filter(
      w =>
        w.type === 'missing_test_coverage' &&
        w.itemRef.includes('test-spec') &&
        w.message.includes('inherited trait AC')
    );
    expect(coverageWarnings).toHaveLength(1);
    expect(coverageWarnings[0].details).toContain('@test-trait ac-1');
  });

  // AC: @trait-validation ac-2
  it('should not warn when trait AC has test annotation', async () => {
    // Setup minimal kspec structure
    const specDir = path.join(tempDir, 'spec');
    const modulesDir = path.join(specDir, 'modules');
    const testsDir = path.join(tempDir, 'tests');
    await fs.mkdir(modulesDir, { recursive: true });
    await fs.mkdir(testsDir, { recursive: true });

    // Create manifest
    const manifest = {
      project: {
        name: 'test-project',
      },
      includes: ['modules/traits.yaml'],
    };
    await writeYamlFilePreserveFormat(path.join(specDir, 'kynetic.yaml'), manifest);

    // Create a trait with AC
    const trait = {
      _ulid: '01KFCRVY8ERZEE2MNHEQXSG90T',
      slugs: ['test-trait'],
      title: 'Test Trait',
      type: 'trait',
      description: 'A test trait with AC',
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

    // Create a spec implementing the trait
    const spec = {
      _ulid: '01KFCRVY8MT49H8N6JW35NN2P3',
      slugs: ['test-spec'],
      title: 'Test Spec',
      type: 'requirement',
      description: 'A spec implementing the trait',
      status: { maturity: 'draft', implementation: 'not_started' },
      traits: ['@test-trait'],
    };

    await writeYamlFilePreserveFormat(path.join(modulesDir, 'traits.yaml'), [trait, spec]);

    // Create a test file with trait AC annotation
    const testContent = `
import { describe, it, expect } from 'vitest';

describe('Test spec', () => {
  // AC: @test-trait ac-1
  it('should satisfy test condition when action taken', () => {
    // Given: test condition
    const condition = true;
    // When: test action
    const result = condition;
    // Then: test result
    expect(result).toBe(true);
  });
});
`;
    await fs.writeFile(path.join(testsDir, 'test-spec.test.ts'), testContent);

    // Run validation
    const ctx = await initContext(tempDir);
    const result = await validate(ctx, { completeness: true });

    // Verify no warning for trait AC coverage
    const coverageWarnings = result.completenessWarnings.filter(
      w =>
        w.type === 'missing_test_coverage' &&
        w.itemRef.includes('test-spec') &&
        w.message.includes('inherited trait AC')
    );
    expect(coverageWarnings).toHaveLength(0);
  });

  // AC: @trait-validation ac-3
  it('should include trait AC coverage in kspec validate without special flag', async () => {
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

    // Create a trait with AC
    const trait = {
      _ulid: '01KFCRVY8ERZEE2MNHEQXSG90T',
      slugs: ['test-trait'],
      title: 'Test Trait',
      type: 'trait',
      description: 'A test trait with AC',
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

    // Create a spec implementing the trait
    const spec = {
      _ulid: '01KFCRVY8MT49H8N6JW35NN2P3',
      slugs: ['test-spec'],
      title: 'Test Spec',
      type: 'requirement',
      description: 'A spec implementing the trait',
      status: { maturity: 'draft', implementation: 'not_started' },
      traits: ['@test-trait'],
    };

    await writeYamlFilePreserveFormat(path.join(modulesDir, 'traits.yaml'), [trait, spec]);

    // Run validation with default options (completeness enabled)
    const ctx = await initContext(tempDir);
    const result = await validate(ctx);

    // Verify trait AC coverage warning appears in default validation
    const coverageWarnings = result.completenessWarnings.filter(
      w =>
        w.type === 'missing_test_coverage' &&
        w.itemRef.includes('test-spec') &&
        w.message.includes('inherited trait AC')
    );
    expect(coverageWarnings.length).toBeGreaterThan(0);
  });

  // AC: @trait-validation ac-4
  it('should report error when spec references deleted trait', async () => {
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

    // Create a spec that references a non-existent trait
    const spec = {
      _ulid: '01KFCRVY8MT49H8N6JW35NN2P3',
      slugs: ['test-spec'],
      title: 'Test Spec',
      type: 'requirement',
      description: 'A spec referencing deleted trait',
      status: { maturity: 'draft', implementation: 'not_started' },
      traits: ['@deleted-trait'],
    };

    await writeYamlFilePreserveFormat(path.join(modulesDir, 'traits.yaml'), spec);

    // Run validation
    const ctx = await initContext(tempDir);
    const result = await validate(ctx, { refs: true });

    // Verify broken reference error
    const traitRefErrors = result.refErrors.filter(
      e => e.field === 'traits' && e.ref === '@deleted-trait'
    );
    expect(traitRefErrors).toHaveLength(1);
    expect(traitRefErrors[0].message).toContain('not found');
  });

  it('should handle multiple specs implementing same trait', async () => {
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

    // Create a trait with AC
    const trait = {
      _ulid: '01KFCRVY8ERZEE2MNHEQXSG90T',
      slugs: ['shared-trait'],
      title: 'Shared Trait',
      type: 'trait',
      description: 'A trait shared by multiple specs',
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

    // Create two specs implementing the trait
    const spec1 = {
      _ulid: '01KFCRVY8MT49H8N6JW35NN2P3',
      slugs: ['spec-one'],
      title: 'Spec One',
      type: 'requirement',
      description: 'First spec',
      status: { maturity: 'draft', implementation: 'not_started' },
      traits: ['@shared-trait'],
    };

    const spec2 = {
      _ulid: '01KFCRVY8NPV114TGJJ5FHB4G8',
      slugs: ['spec-two'],
      title: 'Spec Two',
      type: 'requirement',
      description: 'Second spec',
      status: { maturity: 'draft', implementation: 'not_started' },
      traits: ['@shared-trait'],
    };

    await writeYamlFilePreserveFormat(path.join(modulesDir, 'traits.yaml'), [
      trait,
      spec1,
      spec2,
    ]);

    // Run validation (no tests = both should warn)
    const ctx = await initContext(tempDir);
    const result = await validate(ctx, { completeness: true });

    // Verify both specs get warnings for missing trait AC coverage
    const spec1Warning = result.completenessWarnings.find(
      w =>
        w.type === 'missing_test_coverage' &&
        w.itemRef.includes('spec-one') &&
        w.message.includes('inherited trait AC')
    );
    const spec2Warning = result.completenessWarnings.find(
      w =>
        w.type === 'missing_test_coverage' &&
        w.itemRef.includes('spec-two') &&
        w.message.includes('inherited trait AC')
    );

    expect(spec1Warning).toBeDefined();
    expect(spec2Warning).toBeDefined();
  });

  it('should handle spec implementing multiple traits', async () => {
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

    // Create two traits with different ACs
    const trait1 = {
      _ulid: '01KFCRVY8ERZEE2MNHEQXSG90T',
      slugs: ['trait-one'],
      title: 'Trait One',
      type: 'trait',
      description: 'First trait',
      status: { maturity: 'draft', implementation: 'not_started' },
      acceptance_criteria: [
        {
          id: 'ac-1',
          given: 'trait1 condition',
          when: 'trait1 action',
          then: 'trait1 result',
        },
      ],
    };

    const trait2 = {
      _ulid: '01KFCRVY8MT49H8N6JW35NN2P3',
      slugs: ['trait-two'],
      title: 'Trait Two',
      type: 'trait',
      description: 'Second trait',
      status: { maturity: 'draft', implementation: 'not_started' },
      acceptance_criteria: [
        {
          id: 'ac-1',
          given: 'trait2 condition',
          when: 'trait2 action',
          then: 'trait2 result',
        },
      ],
    };

    // Create spec implementing both traits
    const spec = {
      _ulid: '01KFCRVY8NPV114TGJJ5FHB4G8',
      slugs: ['multi-trait-spec'],
      title: 'Multi Trait Spec',
      type: 'requirement',
      description: 'Spec implementing multiple traits',
      status: { maturity: 'draft', implementation: 'not_started' },
      traits: ['@trait-one', '@trait-two'],
    };

    await writeYamlFilePreserveFormat(path.join(modulesDir, 'traits.yaml'), [
      trait1,
      trait2,
      spec,
    ]);

    // Run validation (no tests = should warn about both trait ACs)
    const ctx = await initContext(tempDir);
    const result = await validate(ctx, { completeness: true });

    // Verify warning mentions both trait ACs
    const coverageWarnings = result.completenessWarnings.filter(
      w =>
        w.type === 'missing_test_coverage' &&
        w.itemRef.includes('multi-trait-spec') &&
        w.message.includes('inherited trait AC')
    );
    expect(coverageWarnings).toHaveLength(1);
    expect(coverageWarnings[0].details).toContain('@trait-one ac-1');
    expect(coverageWarnings[0].details).toContain('@trait-two ac-1');
  });
});
