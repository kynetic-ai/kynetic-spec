import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  ReferenceIndex,
  validateRefs,
  type LoadedSpecItem,
} from '../src/parser/index.js';
import { kspec, createTempDir, initGitRepo } from './helpers/cli.js';
import { writeYamlFilePreserveFormat } from '../src/parser/yaml.js';
import { ulid } from 'ulid';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

describe('Traits field validation', () => {
  // AC: @traits-field ac-1
  it('should validate traits field contains valid refs to trait-type items', () => {
    const items: LoadedSpecItem[] = [
      {
        _ulid: '01TRAIT100000000000000000',
        slugs: ['my-trait'],
        title: 'My Trait',
        type: 'trait',
        tags: [],
        depends_on: [],
        implements: [],
        relates_to: [],
        tests: [],
        acceptance_criteria: [
          {
            id: 'ac-1',
            given: 'context',
            when: 'action',
            then: 'result',
          },
        ],
        description: 'A test trait',
        _sourceFile: 'spec/traits.yaml',
      },
      {
        _ulid: '01SPEC1000000000000000000',
        slugs: ['my-spec'],
        title: 'My Spec',
        type: 'requirement',
        tags: [],
        depends_on: [],
        implements: [],
        relates_to: [],
        tests: [],
        traits: ['@my-trait'], // Valid trait reference
        _sourceFile: 'spec/features.yaml',
      },
    ];

    const index = new ReferenceIndex([], items);
    const result = validateRefs(index, [], items);

    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  // AC: @traits-field ac-2
  it('should report error when traits ref is invalid (does not exist)', () => {
    const items: LoadedSpecItem[] = [
      {
        _ulid: '01SPEC1000000000000000000',
        slugs: ['my-spec'],
        title: 'My Spec',
        type: 'requirement',
        tags: [],
        depends_on: [],
        implements: [],
        relates_to: [],
        tests: [],
        traits: ['@nonexistent-trait'],
        _sourceFile: 'spec/features.yaml',
      },
    ];

    const index = new ReferenceIndex([], items);
    const result = validateRefs(index, [], items);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].ref).toBe('@nonexistent-trait');
    expect(result.errors[0].field).toBe('traits');
    expect(result.errors[0].error).toBe('not_found');
    expect(result.errors[0].message).toContain('not found');
  });

  // AC: @traits-field ac-3
  it('should report error when traits ref points to non-trait item', () => {
    const items: LoadedSpecItem[] = [
      {
        _ulid: '01FEAT1000000000000000000',
        slugs: ['my-feature'],
        title: 'My Feature',
        type: 'feature',
        tags: [],
        depends_on: [],
        implements: [],
        relates_to: [],
        tests: [],
        _sourceFile: 'spec/features.yaml',
      },
      {
        _ulid: '01SPEC1000000000000000000',
        slugs: ['my-spec'],
        title: 'My Spec',
        type: 'requirement',
        tags: [],
        depends_on: [],
        implements: [],
        relates_to: [],
        tests: [],
        traits: ['@my-feature'], // Points to feature, not trait
        _sourceFile: 'spec/requirements.yaml',
      },
    ];

    const index = new ReferenceIndex([], items);
    const result = validateRefs(index, [], items);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].ref).toBe('@my-feature');
    expect(result.errors[0].field).toBe('traits');
    expect(result.errors[0].message).toContain('non-trait');
    expect(result.errors[0].message).toContain('feature');
  });

  // AC: @traits-field ac-4
  it('should allow spec without traits field (defaults to empty array)', () => {
    const items: LoadedSpecItem[] = [
      {
        _ulid: '01SPEC1000000000000000000',
        slugs: ['my-spec'],
        title: 'My Spec',
        type: 'requirement',
        tags: [],
        depends_on: [],
        implements: [],
        relates_to: [],
        tests: [],
        // No traits field - should default to empty array
        _sourceFile: 'spec/features.yaml',
      },
    ];

    const index = new ReferenceIndex([], items);
    const result = validateRefs(index, [], items);

    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  // AC: @traits-field ac-5
  it('should warn when spec has same trait listed twice', () => {
    const items: LoadedSpecItem[] = [
      {
        _ulid: '01TRAIT100000000000000000',
        slugs: ['my-trait'],
        title: 'My Trait',
        type: 'trait',
        tags: [],
        depends_on: [],
        implements: [],
        relates_to: [],
        tests: [],
        acceptance_criteria: [
          {
            id: 'ac-1',
            given: 'context',
            when: 'action',
            then: 'result',
          },
        ],
        description: 'A test trait',
        _sourceFile: 'spec/traits.yaml',
      },
      {
        _ulid: '01SPEC1000000000000000000',
        slugs: ['my-spec'],
        title: 'My Spec',
        type: 'requirement',
        tags: [],
        depends_on: [],
        implements: [],
        relates_to: [],
        tests: [],
        traits: ['@my-trait', '@my-trait'], // Duplicate
        _sourceFile: 'spec/features.yaml',
      },
    ];

    const index = new ReferenceIndex([], items);
    const result = validateRefs(index, [], items);

    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].ref).toBe('@my-trait');
    expect(result.warnings[0].field).toBe('traits');
    expect(result.warnings[0].message).toContain('Duplicate');
  });

  it('should handle multiple valid traits on same spec', () => {
    const items: LoadedSpecItem[] = [
      {
        _ulid: '01TRAIT100000000000000000',
        slugs: ['trait-a'],
        title: 'Trait A',
        type: 'trait',
        tags: [],
        depends_on: [],
        implements: [],
        relates_to: [],
        tests: [],
        acceptance_criteria: [
          {
            id: 'ac-1',
            given: 'context',
            when: 'action',
            then: 'result',
          },
        ],
        description: 'First trait',
        _sourceFile: 'spec/traits.yaml',
      },
      {
        _ulid: '01TRAIT200000000000000000',
        slugs: ['trait-b'],
        title: 'Trait B',
        type: 'trait',
        tags: [],
        depends_on: [],
        implements: [],
        relates_to: [],
        tests: [],
        acceptance_criteria: [
          {
            id: 'ac-1',
            given: 'context',
            when: 'action',
            then: 'result',
          },
        ],
        description: 'Second trait',
        _sourceFile: 'spec/traits.yaml',
      },
      {
        _ulid: '01SPEC1000000000000000000',
        slugs: ['my-spec'],
        title: 'My Spec',
        type: 'requirement',
        tags: [],
        depends_on: [],
        implements: [],
        relates_to: [],
        tests: [],
        traits: ['@trait-a', '@trait-b'], // Multiple different traits
        _sourceFile: 'spec/features.yaml',
      },
    ];

    const index = new ReferenceIndex([], items);
    const result = validateRefs(index, [], items);

    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });
});

describe('Traits field E2E validation (CLI)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir('kspec-traits-e2e-');
    initGitRepo(tempDir);

    // Create minimal kspec structure
    const specDir = path.join(tempDir, 'spec');
    const modulesDir = path.join(specDir, 'modules');
    await fs.mkdir(modulesDir, { recursive: true });

    // Create manifest
    const manifest = {
      project: { name: 'test-project' },
      includes: ['modules/traits.yaml', 'modules/features.yaml'],
    };
    await writeYamlFilePreserveFormat(path.join(specDir, 'kynetic.yaml'), manifest);

    // Create valid trait
    const trait = {
      _ulid: ulid(),
      slugs: ['my-trait'],
      title: 'My Trait',
      type: 'trait',
      description: 'A test trait',
      status: { maturity: 'draft', implementation: 'not_started' },
      acceptance_criteria: [
        {
          id: 'ac-1',
          given: 'context',
          when: 'action',
          then: 'result',
        },
      ],
    };
    await writeYamlFilePreserveFormat(path.join(modulesDir, 'traits.yaml'), trait);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // AC: @traits-field ac-1 (E2E)
  it('should pass validation when spec has valid trait reference', async () => {
    // Create spec with valid trait ref
    const spec = {
      _ulid: ulid(),
      slugs: ['my-spec'],
      title: 'My Spec',
      type: 'requirement',
      traits: ['@my-trait'],
      status: { maturity: 'draft', implementation: 'not_started' },
    };
    await writeYamlFilePreserveFormat(
      path.join(tempDir, 'spec', 'modules', 'features.yaml'),
      spec
    );

    const result = kspec('validate --refs', tempDir);
    expect(result.stdout).toContain('References: OK');
  });

  // AC: @traits-field ac-2 (E2E)
  it('should report error when trait reference does not exist', async () => {
    // Create spec with invalid trait ref
    const spec = {
      _ulid: ulid(),
      slugs: ['my-spec'],
      title: 'My Spec',
      type: 'requirement',
      traits: ['@nonexistent-trait'],
      status: { maturity: 'draft', implementation: 'not_started' },
    };
    await writeYamlFilePreserveFormat(
      path.join(tempDir, 'spec', 'modules', 'features.yaml'),
      spec
    );

    const result = kspec('validate --refs', tempDir, { expectFail: true });
    const output = result.stderr || result.stdout;
    expect(output).toContain('@nonexistent-trait');
    expect(output).toContain('not found');
    expect(result.exitCode).toBe(1);
  });

  // AC: @traits-field ac-3 (E2E)
  it('should report error when trait reference points to non-trait item', async () => {
    // Create a module with a feature and a spec
    const module = {
      _ulid: ulid(),
      slugs: ['test-module'],
      title: 'Test Module',
      type: 'module',
      status: { maturity: 'draft', implementation: 'not_started' },
      features: [
        {
          _ulid: ulid(),
          slugs: ['my-feature'],
          title: 'My Feature',
          type: 'feature',
          status: { maturity: 'draft', implementation: 'not_started' },
        },
      ],
      requirements: [
        {
          _ulid: ulid(),
          slugs: ['my-spec'],
          title: 'My Spec',
          type: 'requirement',
          traits: ['@my-feature'], // Points to feature, not trait
          status: { maturity: 'draft', implementation: 'not_started' },
        },
      ],
    };
    await writeYamlFilePreserveFormat(
      path.join(tempDir, 'spec', 'modules', 'features.yaml'),
      module
    );

    const result = kspec('validate --refs', tempDir, { expectFail: true });
    const output = result.stderr || result.stdout;
    expect(output).toContain('@my-feature');
    expect(output).toContain('non-trait');
    expect(result.exitCode).toBe(1);
  });

  // AC: @traits-field ac-4 (E2E)
  it('should pass validation when spec has no traits field', async () => {
    // Create spec without traits field
    const spec = {
      _ulid: ulid(),
      slugs: ['my-spec'],
      title: 'My Spec',
      type: 'requirement',
      status: { maturity: 'draft', implementation: 'not_started' },
    };
    await writeYamlFilePreserveFormat(
      path.join(tempDir, 'spec', 'modules', 'features.yaml'),
      spec
    );

    const result = kspec('validate --refs', tempDir);
    expect(result.stdout).toContain('References: OK');
  });

  // AC: @traits-field ac-5 (E2E)
  it('should warn when spec has duplicate trait references', async () => {
    // Create spec with duplicate trait refs
    const spec = {
      _ulid: ulid(),
      slugs: ['my-spec'],
      title: 'My Spec',
      type: 'requirement',
      traits: ['@my-trait', '@my-trait'], // Duplicate
      status: { maturity: 'draft', implementation: 'not_started' },
    };
    await writeYamlFilePreserveFormat(
      path.join(tempDir, 'spec', 'modules', 'features.yaml'),
      spec
    );

    const result = kspec('validate --refs', tempDir);
    expect(result.stdout).toContain('Duplicate');
    expect(result.stdout).toContain('@my-trait');
  });
});
