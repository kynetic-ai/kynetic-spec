import { describe, it, expect } from 'vitest';
import {
  ReferenceIndex,
  validateRefs,
  type LoadedSpecItem,
} from '../src/parser/index.js';

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
