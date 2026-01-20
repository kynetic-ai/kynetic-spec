/**
 * Tests for TraitIndex
 */

import { describe, it, expect } from 'vitest';
import { TraitIndex } from '../../src/parser/traits.js';
import { ReferenceIndex } from '../../src/parser/refs.js';
import type { LoadedSpecItem, LoadedTask } from '../../src/parser/yaml.js';

describe('TraitIndex', () => {
  // AC: @trait-index ac-1
  describe('indexing trait-type items', () => {
    it('should index all trait-type items by ULID and slug', () => {
      const items: LoadedSpecItem[] = [
        {
          _ulid: '01TRAIT001',
          slugs: ['trait-one'],
          title: 'Trait One',
          description: 'First trait',
          type: 'trait',
          acceptance_criteria: [
            { id: 'ac-1', given: 'g1', when: 'w1', then: 't1' },
          ],
          depends_on: [],
          implements: [],
          relates_to: [],
          tests: [],
          traits: [],
          status: { maturity: 'draft' },
        },
        {
          _ulid: '01TRAIT002',
          slugs: ['trait-two'],
          title: 'Trait Two',
          type: 'trait',
          acceptance_criteria: [
            { id: 'ac-1', given: 'g2', when: 'w2', then: 't2' },
            { id: 'ac-2', given: 'g3', when: 'w3', then: 't3' },
          ],
          depends_on: [],
          implements: [],
          relates_to: [],
          tests: [],
          traits: [],
          status: { maturity: 'draft' },
        },
        {
          _ulid: '01SPEC001',
          slugs: ['spec-one'],
          title: 'Spec One',
          type: 'feature',
          depends_on: [],
          implements: [],
          relates_to: [],
          tests: [],
          traits: [],
          status: { maturity: 'draft' },
        },
      ];

      const tasks: LoadedTask[] = [];
      const refIndex = new ReferenceIndex(tasks, items);
      const traitIndex = new TraitIndex(items, refIndex);

      // Should index both traits
      const allTraits = traitIndex.getAllTraits();
      expect(allTraits).toHaveLength(2);

      // Should be accessible by ULID
      const trait1 = traitIndex.getTrait('01TRAIT001');
      expect(trait1).toBeDefined();
      expect(trait1?.ulid).toBe('01TRAIT001');
      expect(trait1?.slug).toBe('trait-one');
      expect(trait1?.title).toBe('Trait One');
      expect(trait1?.description).toBe('First trait');
      expect(trait1?.acceptanceCriteria).toHaveLength(1);

      const trait2 = traitIndex.getTrait('01TRAIT002');
      expect(trait2).toBeDefined();
      expect(trait2?.ulid).toBe('01TRAIT002');
      expect(trait2?.acceptanceCriteria).toHaveLength(2);

      // Non-trait items should not be indexed
      expect(traitIndex.getTrait('01SPEC001')).toBeUndefined();
    });

    it('should handle items with no acceptance criteria', () => {
      const items: LoadedSpecItem[] = [
        {
          _ulid: '01TRAIT001',
          slugs: ['trait-minimal'],
          title: 'Minimal Trait',
          type: 'trait',
          depends_on: [],
          implements: [],
          relates_to: [],
          tests: [],
          traits: [],
          status: { maturity: 'draft' },
        },
      ];

      const refIndex = new ReferenceIndex([], items);
      const traitIndex = new TraitIndex(items, refIndex);

      const trait = traitIndex.getTrait('01TRAIT001');
      expect(trait).toBeDefined();
      expect(trait?.acceptanceCriteria).toEqual([]);
    });
  });

  // AC: @trait-index ac-2
  describe('getInheritedAC()', () => {
    it('should return all AC from all implemented traits', () => {
      const items: LoadedSpecItem[] = [
        {
          _ulid: '01TRAIT001',
          slugs: ['trait-one'],
          title: 'Trait One',
          type: 'trait',
          acceptance_criteria: [
            { id: 'ac-1', given: 'g1', when: 'w1', then: 't1' },
            { id: 'ac-2', given: 'g2', when: 'w2', then: 't2' },
          ],
          depends_on: [],
          implements: [],
          relates_to: [],
          tests: [],
          traits: [],
          status: { maturity: 'draft' },
        },
        {
          _ulid: '01TRAIT002',
          slugs: ['trait-two'],
          title: 'Trait Two',
          type: 'trait',
          acceptance_criteria: [
            { id: 'ac-1', given: 'g3', when: 'w3', then: 't3' },
          ],
          depends_on: [],
          implements: [],
          relates_to: [],
          tests: [],
          traits: [],
          status: { maturity: 'draft' },
        },
        {
          _ulid: '01SPEC001',
          slugs: ['spec-one'],
          title: 'Spec One',
          type: 'feature',
          traits: ['@trait-one', '@trait-two'],
          depends_on: [],
          implements: [],
          relates_to: [],
          tests: [],
          status: { maturity: 'draft' },
        },
      ];

      const refIndex = new ReferenceIndex([], items);
      const traitIndex = new TraitIndex(items, refIndex);

      const inherited = traitIndex.getInheritedAC('01SPEC001');

      // Should have 3 total ACs (2 from trait-one, 1 from trait-two)
      expect(inherited).toHaveLength(3);

      // Verify structure
      expect(inherited[0]).toHaveProperty('trait');
      expect(inherited[0]).toHaveProperty('ac');
      expect(inherited[0].trait.ulid).toBe('01TRAIT001');
      expect(inherited[0].ac.id).toBe('ac-1');

      expect(inherited[1].trait.ulid).toBe('01TRAIT001');
      expect(inherited[1].ac.id).toBe('ac-2');

      expect(inherited[2].trait.ulid).toBe('01TRAIT002');
      expect(inherited[2].ac.id).toBe('ac-1');
    });

    it('should return empty array for spec with no traits', () => {
      const items: LoadedSpecItem[] = [
        {
          _ulid: '01SPEC001',
          slugs: ['spec-one'],
          title: 'Spec One',
          type: 'feature',
          depends_on: [],
          implements: [],
          relates_to: [],
          tests: [],
          traits: [],
          status: { maturity: 'draft' },
        },
      ];

      const refIndex = new ReferenceIndex([], items);
      const traitIndex = new TraitIndex(items, refIndex);

      const inherited = traitIndex.getInheritedAC('01SPEC001');
      expect(inherited).toEqual([]);
    });

    it('should return empty array for non-existent spec', () => {
      const items: LoadedSpecItem[] = [];
      const refIndex = new ReferenceIndex([], items);
      const traitIndex = new TraitIndex(items, refIndex);

      const inherited = traitIndex.getInheritedAC('01NOTEXIST');
      expect(inherited).toEqual([]);
    });

    it('should handle trait with no acceptance criteria', () => {
      const items: LoadedSpecItem[] = [
        {
          _ulid: '01TRAIT001',
          slugs: ['trait-one'],
          title: 'Trait One',
          type: 'trait',
          depends_on: [],
          implements: [],
          relates_to: [],
          tests: [],
          traits: [],
          status: { maturity: 'draft' },
        },
        {
          _ulid: '01SPEC001',
          slugs: ['spec-one'],
          title: 'Spec One',
          type: 'feature',
          traits: ['@trait-one'],
          depends_on: [],
          implements: [],
          relates_to: [],
          tests: [],
          status: { maturity: 'draft' },
        },
      ];

      const refIndex = new ReferenceIndex([], items);
      const traitIndex = new TraitIndex(items, refIndex);

      const inherited = traitIndex.getInheritedAC('01SPEC001');
      expect(inherited).toEqual([]);
    });
  });

  // AC: @trait-index ac-3
  describe('getSpecsForTrait()', () => {
    it('should return all specs that implement a trait', () => {
      const items: LoadedSpecItem[] = [
        {
          _ulid: '01TRAIT001',
          slugs: ['trait-one'],
          title: 'Trait One',
          type: 'trait',
          depends_on: [],
          implements: [],
          relates_to: [],
          tests: [],
          traits: [],
          status: { maturity: 'draft' },
        },
        {
          _ulid: '01SPEC001',
          slugs: ['spec-one'],
          title: 'Spec One',
          type: 'feature',
          traits: ['@trait-one'],
          depends_on: [],
          implements: [],
          relates_to: [],
          tests: [],
          status: { maturity: 'draft' },
        },
        {
          _ulid: '01SPEC002',
          slugs: ['spec-two'],
          title: 'Spec Two',
          type: 'feature',
          traits: ['@trait-one'],
          depends_on: [],
          implements: [],
          relates_to: [],
          tests: [],
          status: { maturity: 'draft' },
        },
        {
          _ulid: '01SPEC003',
          slugs: ['spec-three'],
          title: 'Spec Three',
          type: 'feature',
          depends_on: [],
          implements: [],
          relates_to: [],
          tests: [],
          traits: [],
          status: { maturity: 'draft' },
        },
      ];

      const refIndex = new ReferenceIndex([], items);
      const traitIndex = new TraitIndex(items, refIndex);

      const specs = traitIndex.getSpecsForTrait('01TRAIT001');

      expect(specs).toHaveLength(2);
      expect(specs).toContain('01SPEC001');
      expect(specs).toContain('01SPEC002');
      expect(specs).not.toContain('01SPEC003');
    });

    it('should return empty array for trait with no implementing specs', () => {
      const items: LoadedSpecItem[] = [
        {
          _ulid: '01TRAIT001',
          slugs: ['trait-one'],
          title: 'Trait One',
          type: 'trait',
          depends_on: [],
          implements: [],
          relates_to: [],
          tests: [],
          traits: [],
          status: { maturity: 'draft' },
        },
      ];

      const refIndex = new ReferenceIndex([], items);
      const traitIndex = new TraitIndex(items, refIndex);

      const specs = traitIndex.getSpecsForTrait('01TRAIT001');
      expect(specs).toEqual([]);
    });

    it('should return empty array for non-existent trait', () => {
      const items: LoadedSpecItem[] = [];
      const refIndex = new ReferenceIndex([], items);
      const traitIndex = new TraitIndex(items, refIndex);

      const specs = traitIndex.getSpecsForTrait('01NOTEXIST');
      expect(specs).toEqual([]);
    });
  });

  describe('getTraitsForSpec()', () => {
    it('should return traits implemented by a spec', () => {
      const items: LoadedSpecItem[] = [
        {
          _ulid: '01TRAIT001',
          slugs: ['trait-one'],
          title: 'Trait One',
          type: 'trait',
          depends_on: [],
          implements: [],
          relates_to: [],
          tests: [],
          traits: [],
          status: { maturity: 'draft' },
        },
        {
          _ulid: '01TRAIT002',
          slugs: ['trait-two'],
          title: 'Trait Two',
          type: 'trait',
          depends_on: [],
          implements: [],
          relates_to: [],
          tests: [],
          traits: [],
          status: { maturity: 'draft' },
        },
        {
          _ulid: '01SPEC001',
          slugs: ['spec-one'],
          title: 'Spec One',
          type: 'feature',
          traits: ['@trait-one', '@trait-two'],
          depends_on: [],
          implements: [],
          relates_to: [],
          tests: [],
          status: { maturity: 'draft' },
        },
      ];

      const refIndex = new ReferenceIndex([], items);
      const traitIndex = new TraitIndex(items, refIndex);

      const traits = traitIndex.getTraitsForSpec('01SPEC001');

      expect(traits).toHaveLength(2);
      expect(traits[0].ulid).toBe('01TRAIT001');
      expect(traits[1].ulid).toBe('01TRAIT002');
    });

    it('should return empty array for spec with no traits', () => {
      const items: LoadedSpecItem[] = [
        {
          _ulid: '01SPEC001',
          slugs: ['spec-one'],
          title: 'Spec One',
          type: 'feature',
          depends_on: [],
          implements: [],
          relates_to: [],
          tests: [],
          traits: [],
          status: { maturity: 'draft' },
        },
      ];

      const refIndex = new ReferenceIndex([], items);
      const traitIndex = new TraitIndex(items, refIndex);

      const traits = traitIndex.getTraitsForSpec('01SPEC001');
      expect(traits).toEqual([]);
    });

    it('should handle invalid trait references gracefully', () => {
      const items: LoadedSpecItem[] = [
        {
          _ulid: '01SPEC001',
          slugs: ['spec-one'],
          title: 'Spec One',
          type: 'feature',
          traits: ['@nonexistent'],
          depends_on: [],
          implements: [],
          relates_to: [],
          tests: [],
          status: { maturity: 'draft' },
        },
      ];

      const refIndex = new ReferenceIndex([], items);
      const traitIndex = new TraitIndex(items, refIndex);

      const traits = traitIndex.getTraitsForSpec('01SPEC001');
      expect(traits).toEqual([]);
    });
  });

  describe('getStats()', () => {
    it('should return accurate stats', () => {
      const items: LoadedSpecItem[] = [
        {
          _ulid: '01TRAIT001',
          slugs: ['trait-one'],
          title: 'Trait One',
          type: 'trait',
          depends_on: [],
          implements: [],
          relates_to: [],
          tests: [],
          traits: [],
          status: { maturity: 'draft' },
        },
        {
          _ulid: '01TRAIT002',
          slugs: ['trait-two'],
          title: 'Trait Two',
          type: 'trait',
          depends_on: [],
          implements: [],
          relates_to: [],
          tests: [],
          traits: [],
          status: { maturity: 'draft' },
        },
        {
          _ulid: '01SPEC001',
          slugs: ['spec-one'],
          title: 'Spec One',
          type: 'feature',
          traits: ['@trait-one', '@trait-two'],
          depends_on: [],
          implements: [],
          relates_to: [],
          tests: [],
          status: { maturity: 'draft' },
        },
        {
          _ulid: '01SPEC002',
          slugs: ['spec-two'],
          title: 'Spec Two',
          type: 'feature',
          traits: ['@trait-one'],
          depends_on: [],
          implements: [],
          relates_to: [],
          tests: [],
          status: { maturity: 'draft' },
        },
        {
          _ulid: '01SPEC003',
          slugs: ['spec-three'],
          title: 'Spec Three',
          type: 'feature',
          depends_on: [],
          implements: [],
          relates_to: [],
          tests: [],
          traits: [],
          status: { maturity: 'draft' },
        },
      ];

      const refIndex = new ReferenceIndex([], items);
      const traitIndex = new TraitIndex(items, refIndex);

      const stats = traitIndex.getStats();

      expect(stats.totalTraits).toBe(2);
      expect(stats.specsWithTraits).toBe(2); // spec-one and spec-two
      expect(stats.avgTraitsPerSpec).toBe(1.5); // (2 + 1) / 2
    });

    it('should handle zero traits gracefully', () => {
      const items: LoadedSpecItem[] = [
        {
          _ulid: '01SPEC001',
          slugs: ['spec-one'],
          title: 'Spec One',
          type: 'feature',
          depends_on: [],
          implements: [],
          relates_to: [],
          tests: [],
          traits: [],
          status: { maturity: 'draft' },
        },
      ];

      const refIndex = new ReferenceIndex([], items);
      const traitIndex = new TraitIndex(items, refIndex);

      const stats = traitIndex.getStats();

      expect(stats.totalTraits).toBe(0);
      expect(stats.specsWithTraits).toBe(0);
      expect(stats.avgTraitsPerSpec).toBe(0);
    });
  });

  describe('edge cases', () => {
    it('should handle empty items array', () => {
      const items: LoadedSpecItem[] = [];
      const refIndex = new ReferenceIndex([], items);
      const traitIndex = new TraitIndex(items, refIndex);

      expect(traitIndex.getAllTraits()).toEqual([]);
      expect(traitIndex.getStats().totalTraits).toBe(0);
    });

    it('should use ULID as slug if no slugs defined', () => {
      const items: LoadedSpecItem[] = [
        {
          _ulid: '01TRAIT001',
          slugs: [],
          title: 'Trait One',
          type: 'trait',
          depends_on: [],
          implements: [],
          relates_to: [],
          tests: [],
          traits: [],
          status: { maturity: 'draft' },
        },
      ];

      const refIndex = new ReferenceIndex([], items);
      const traitIndex = new TraitIndex(items, refIndex);

      const trait = traitIndex.getTrait('01TRAIT001');
      expect(trait?.slug).toBe('01TRAIT001');
    });

    it('should handle spec implementing same trait multiple times', () => {
      const items: LoadedSpecItem[] = [
        {
          _ulid: '01TRAIT001',
          slugs: ['trait-one'],
          title: 'Trait One',
          type: 'trait',
          acceptance_criteria: [
            { id: 'ac-1', given: 'g1', when: 'w1', then: 't1' },
          ],
          depends_on: [],
          implements: [],
          relates_to: [],
          tests: [],
          traits: [],
          status: { maturity: 'draft' },
        },
        {
          _ulid: '01SPEC001',
          slugs: ['spec-one'],
          title: 'Spec One',
          type: 'feature',
          // Duplicate reference (shouldn't happen in practice, but test robustness)
          traits: ['@trait-one', '@trait-one'],
          depends_on: [],
          implements: [],
          relates_to: [],
          tests: [],
          status: { maturity: 'draft' },
        },
      ];

      const refIndex = new ReferenceIndex([], items);
      const traitIndex = new TraitIndex(items, refIndex);

      // Should still work, just with duplicates
      const traits = traitIndex.getTraitsForSpec('01SPEC001');
      expect(traits.length).toBeGreaterThanOrEqual(1);

      const specs = traitIndex.getSpecsForTrait('01TRAIT001');
      expect(specs).toContain('01SPEC001');
    });
  });
});
