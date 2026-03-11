import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { kspecJson } from './helpers/cli';

const projectRoot = path.resolve(__dirname, '..');
const backfilledCoreRefs = [
  '@item-required-fields',
  '@item-optional-fields',
  '@ulid-format',
  '@ulid-immutability',
  '@ulid-shortening',
  '@slug-format',
  '@ref-syntax',
  '@ref-validation',
  '@relationship-types',
  '@rel-tests',
  '@rel-supersedes',
] as const;

interface ValidateWarning {
  type: string;
  itemRef?: string;
}

interface ValidateResult {
  completenessWarnings: ValidateWarning[];
}

interface AcceptanceCriterion {
  id: string;
  given: string;
  when: string;
  then: string;
}

interface ItemJson {
  acceptance_criteria: AcceptanceCriterion[];
}

describe('Core AC backfill regressions', () => {
  // AC: @core-ac-backfill ac-coverage
  it('keeps in-scope core refs free of missing acceptance criteria warnings', () => {
    const result = kspecJson<ValidateResult>('validate --completeness', projectRoot);

    const missingAcRefs = new Set(
      result.completenessWarnings
        .filter((warning) => warning.type === 'missing_acceptance_criteria')
        .map((warning) => warning.itemRef)
        .filter((itemRef): itemRef is string => Boolean(itemRef))
    );

    for (const ref of backfilledCoreRefs) {
      expect(missingAcRefs.has(ref)).toBe(false);
    }
  });

  // AC: @core-ac-backfill ac-testable
  it('gives each backfilled core AC a concrete given/when/then assertion', () => {
    for (const ref of backfilledCoreRefs) {
      const item = kspecJson<ItemJson>(`item get ${ref}`, projectRoot);
      expect(item.acceptance_criteria.length).toBeGreaterThan(0);

      for (const ac of item.acceptance_criteria) {
        expect(ac.id).toMatch(/^ac-/);
        expect(ac.given.trim().length).toBeGreaterThan(10);
        expect(ac.when.trim().length).toBeGreaterThan(10);
        expect(ac.then.trim().length).toBeGreaterThan(10);
        expect(ac.given.toLowerCase()).not.toContain('works correctly');
        expect(ac.then.toLowerCase()).not.toContain('works correctly');
      }
    }
  });
});
