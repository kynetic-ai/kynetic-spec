import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  initContext,
  loadAllItems,
  ReferenceIndex,
  validate,
  type LoadedSpecItem,
} from '../src/parser/index.js';
import { writeYamlFilePreserveFormat } from '../src/parser/yaml.js';

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

const coreAcBackfillFixtureItems = [
  {
    _ulid: '01KKB8FCEPMCC7J05GV278WKGT',
    slugs: ['core-ac-backfill'],
    title: 'Core Primitives AC Backfill',
    type: 'requirement',
    description:
      'Add acceptance criteria to foundational spec items under @core that currently lack them.',
    status: { maturity: 'draft', implementation: 'in_progress' },
    acceptance_criteria: [
      {
        id: 'ac-coverage',
        given: 'All feature and requirement items under @core module',
        when: 'kspec validate --completeness runs',
        then: 'Zero "missing acceptance criteria" warnings for @core descendants',
      },
      {
        id: 'ac-testable',
        given: 'Each newly added AC',
        when: 'It is reviewed',
        then: 'It follows given/when/then format with concrete, observable outcomes',
      },
    ],
  },
  {
    _ulid: '01KEZCJPHZ0X9NQZMED44BM9MT',
    slugs: ['item-required-fields'],
    title: 'Required Item Fields',
    type: 'requirement',
    description:
      'Every item MUST have a canonical ULID and a user-provided title; all other fields are optional.',
    status: { maturity: 'draft', implementation: 'implemented' },
    acceptance_criteria: [
      {
        id: 'ac-1',
        given: 'a user creates a new spec item with only a title',
        when: 'the item is stored',
        then: 'the item has a generated ULID and preserves the provided title as required fields',
      },
    ],
  },
  {
    _ulid: '01KEZCJPHZ67B47NKNJZ8C1H3G',
    slugs: ['item-optional-fields'],
    title: 'Optional Item Fields',
    type: 'requirement',
    description:
      'Items MAY include optional metadata such as slugs, tags, descriptions, acceptance criteria, and relationships.',
    status: { maturity: 'draft', implementation: 'implemented' },
    acceptance_criteria: [
      {
        id: 'ac-1',
        given:
          'a spec item is created without optional metadata such as slugs, tags, description, or relationships',
        when: 'the item is retrieved or validated',
        then: 'the item remains valid and the omitted fields do not prevent storage',
      },
    ],
  },
  {
    _ulid: '01KEZCJPHZH6VQH44813GV3PTC',
    slugs: ['ulid-format'],
    title: 'ULID Format',
    type: 'requirement',
    description: 'ULIDs are 26-character strings in Crockford base32 encoding.',
    status: { maturity: 'draft', implementation: 'implemented' },
    acceptance_criteria: [
      {
        id: 'ac-1',
        given: 'the system generates a ULID for a new item',
        when: 'the identifier is inspected',
        then:
          'it is a 26-character Crockford base32 string with a 10-character time component followed by a 16-character random component',
      },
    ],
  },
  {
    _ulid: '01KEZCJPJ0MZSX946EF3ZPW9TA',
    slugs: ['ulid-immutability'],
    title: 'ULID Immutability',
    type: 'requirement',
    description:
      'Once assigned, a ULID is never changed or reused; replacement items receive new ULIDs.',
    status: { maturity: 'draft', implementation: 'implemented' },
    acceptance_criteria: [
      {
        id: 'ac-1',
        given: 'an existing item is updated, deprecated, or superseded',
        when: 'its metadata or relationships change',
        then: 'the original ULID remains unchanged and any replacement item receives a different ULID',
      },
    ],
  },
  {
    _ulid: '01KEZCJPJ0W8V4JZRYZFX56DX5',
    slugs: ['ulid-shortening'],
    title: 'ULID Shortening',
    type: 'requirement',
    description: 'Unique ULID prefixes can be displayed and resolved back to full ULIDs.',
    status: { maturity: 'draft', implementation: 'implemented' },
    acceptance_criteria: [
      {
        id: 'ac-1',
        given: 'an item has a full ULID',
        when: 'a unique shortened ULID prefix is used for display or as an @reference',
        then: 'the system resolves that prefix back to the same full ULID',
      },
    ],
  },
  {
    _ulid: '01KEZCJPJ05XAAVB7JK0G169DP',
    slugs: ['slug-format'],
    title: 'Slug Format',
    type: 'requirement',
    description: 'Slugs must be lowercase, alphanumeric, and may include hyphens.',
    status: { maturity: 'draft', implementation: 'implemented' },
    acceptance_criteria: [
      {
        id: 'ac-1',
        given: 'a user provides a slug containing uppercase letters, spaces, or underscores',
        when: 'the slug is validated during item creation or update',
        then:
          'the command rejects the slug because it does not match the lowercase hyphenated slug pattern',
      },
    ],
  },
  {
    _ulid: '01JHNKA0W3REFS100000000000',
    slugs: ['ref-syntax'],
    title: 'Reference Syntax',
    type: 'requirement',
    description: 'References use an @ prefix and are parsed distinctly from plain text.',
    status: { maturity: 'draft', implementation: 'implemented' },
    acceptance_criteria: [
      {
        id: 'ac-1',
        given: 'a relationship field contains @slug, @short-ulid, or @full-ulid values',
        when: 'the item is parsed or validated',
        then:
          'those values are recognized as references rather than plain text and are available for resolution',
      },
    ],
  },
  {
    _ulid: '01JHNKA0W4REFS200000000000',
    slugs: ['ref-validation'],
    title: 'Reference Validation',
    type: 'requirement',
    description: 'Reference validation resolves valid refs and reports unresolved ones.',
    status: { maturity: 'draft', implementation: 'implemented' },
    acceptance_criteria: [
      {
        id: 'ac-1',
        given: 'an item contains one valid reference and one unresolved @reference',
        when: 'kspec validate --refs runs',
        then:
          'the valid reference resolves successfully and the unresolved reference is reported as an error',
      },
    ],
  },
  {
    _ulid: '01KEZCJPJ1SMT5AJJ2Y6Z0S21K',
    slugs: ['relationship-types', 'item-links'],
    title: 'Relationship Types',
    type: 'feature',
    description:
      'Items link to each other via typed relationships that retain their semantics when inspected.',
    status: { maturity: 'draft', implementation: 'implemented' },
    acceptance_criteria: [
      {
        id: 'ac-1',
        given: 'an item links to other items using depends_on, implements, relates_to, tests, or supersedes',
        when: 'the item graph is inspected',
        then:
          'each link retains its relationship type so tools can distinguish prerequisite, realization, association, verification, and replacement semantics',
      },
    ],
  },
  {
    _ulid: '01KEZCJPJ2HC490BP03G39SX8R',
    slugs: ['rel-tests'],
    title: 'tests Relationship',
    type: 'requirement',
    description: 'A tests B means A validates or verifies B.',
    status: { maturity: 'draft', implementation: 'implemented' },
    acceptance_criteria: [
      {
        id: 'ac-1',
        given: 'item A declares a tests relationship to item B',
        when: 'verification traceability is viewed',
        then: 'item A is shown as evidence that validates item B',
      },
    ],
  },
  {
    _ulid: '01KEZCJPJ2ZJMV482PPMTCSZKN',
    slugs: ['rel-supersedes'],
    title: 'supersedes Relationship',
    type: 'requirement',
    description:
      'A supersedes B means A replaces B while B retains its original identity.',
    status: { maturity: 'draft', implementation: 'implemented' },
    acceptance_criteria: [
      {
        id: 'ac-1',
        given: 'item A supersedes item B',
        when: 'the superseded item is reviewed',
        then:
          'item B remains identifiable by its original ULID and the relationship points to item A as its replacement',
      },
    ],
  },
] as const;

interface ValidateWarning {
  type: string;
  itemRef?: string;
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

let completenessWarnings: ValidateWarning[] = [];
let refIndex: ReferenceIndex;
let fixtureRoot: string;

async function setupFixtureProject(rootDir: string): Promise<void> {
  const modulesDir = path.join(rootDir, 'modules');
  await fs.mkdir(modulesDir, { recursive: true });

  await writeYamlFilePreserveFormat(path.join(rootDir, 'kynetic.yaml'), {
    project: { name: 'core-ac-backfill-fixture' },
    includes: ['modules/core-ac-backfill.yaml'],
  });

  await writeYamlFilePreserveFormat(
    path.join(modulesDir, 'core-ac-backfill.yaml'),
    coreAcBackfillFixtureItems
  );
}

function getBackfilledItem(ref: (typeof backfilledCoreRefs)[number]): ItemJson {
  const resolved = refIndex.resolve(ref);
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) {
    throw new Error(`Expected ${ref} to resolve`);
  }

  return resolved.item as LoadedSpecItem as ItemJson;
}

describe('Core AC backfill regressions', () => {
  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kspec-core-ac-backfill-'));
    await setupFixtureProject(fixtureRoot);

    const ctx = await initContext(fixtureRoot);
    const [validationResult, items] = await Promise.all([
      validate(ctx, { completeness: true }),
      loadAllItems(ctx),
    ]);

    completenessWarnings = validationResult.completenessWarnings;
    refIndex = new ReferenceIndex([], items);
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  // AC: @core-ac-backfill ac-coverage
  it('keeps in-scope core refs free of missing acceptance criteria warnings', () => {
    const missingAcRefs = new Set(
      completenessWarnings
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
      const item = getBackfilledItem(ref);
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
