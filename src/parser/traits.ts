/**
 * Trait tracking and inheritance system.
 *
 * Provides efficient lookup of trait-type items and trait-spec relationships.
 * Follows the pattern of ReferenceIndex and AlignmentIndex - built once from
 * loaded items, queried efficiently.
 */

import type { LoadedSpecItem } from './yaml.js';
import type { ReferenceIndex } from './refs.js';
import type { AcceptanceCriterion } from '../schema/index.js';

// ============================================================
// TYPES
// ============================================================

/**
 * Information about a trait-type spec item
 */
export interface TraitInfo {
  ulid: string;
  slug: string;
  title: string;
  description?: string;
  acceptanceCriteria: AcceptanceCriterion[];
}

// ============================================================
// TRAIT INDEX
// ============================================================

/**
 * Index for tracking trait-type items and spec-trait relationships.
 * Build once when loading, then query efficiently.
 * AC: @trait-index ac-1, ac-2, ac-3
 */
export class TraitIndex {
  /** All trait-type items by ULID */
  private traits = new Map<string, TraitInfo>();

  /** trait ULID → spec ULIDs that implement it */
  private traitToSpecs = new Map<string, string[]>();

  /** spec ULID → trait ULIDs it implements */
  private specToTraits = new Map<string, string[]>();

  /**
   * Build index from loaded items
   * AC: @trait-index ac-1
   */
  constructor(items: LoadedSpecItem[], refIndex: ReferenceIndex) {
    // First pass: index all trait-type items
    for (const item of items) {
      if (item.type === 'trait') {
        const slug = item.slugs[0] || item._ulid;
        this.traits.set(item._ulid, {
          ulid: item._ulid,
          slug,
          title: item.title,
          description: item.description,
          acceptanceCriteria: item.acceptance_criteria || [],
        });
        this.traitToSpecs.set(item._ulid, []);
      }
    }

    // Second pass: index spec-trait relationships
    for (const item of items) {
      if (item.traits && item.traits.length > 0) {
        const specUlid = item._ulid;
        const traitUlids: string[] = [];

        for (const traitRef of item.traits) {
          const result = refIndex.resolve(traitRef);
          if (result.ok) {
            const traitUlid = result.ulid;
            traitUlids.push(traitUlid);

            // Add to trait → specs mapping
            const specs = this.traitToSpecs.get(traitUlid);
            if (specs) {
              specs.push(specUlid);
            }
          }
        }

        if (traitUlids.length > 0) {
          this.specToTraits.set(specUlid, traitUlids);
        }
      }
    }
  }

  /**
   * Get all traits implemented by a spec
   */
  getTraitsForSpec(specUlid: string): TraitInfo[] {
    const traitUlids = this.specToTraits.get(specUlid) || [];
    return traitUlids
      .map(ulid => this.traits.get(ulid))
      .filter((t): t is TraitInfo => t !== undefined);
  }

  /**
   * Get all specs that implement a trait
   * AC: @trait-index ac-3
   */
  getSpecsForTrait(traitUlid: string): string[] {
    return this.traitToSpecs.get(traitUlid) || [];
  }

  /**
   * Get all acceptance criteria inherited from implemented traits
   * AC: @trait-index ac-2
   */
  getInheritedAC(specUlid: string): Array<{ trait: TraitInfo; ac: AcceptanceCriterion }> {
    const traits = this.getTraitsForSpec(specUlid);
    const inherited: Array<{ trait: TraitInfo; ac: AcceptanceCriterion }> = [];

    for (const trait of traits) {
      for (const ac of trait.acceptanceCriteria) {
        inherited.push({ trait, ac });
      }
    }

    return inherited;
  }

  /**
   * Get all trait-type items
   */
  getAllTraits(): TraitInfo[] {
    return Array.from(this.traits.values());
  }

  /**
   * Get a specific trait by ULID
   */
  getTrait(traitUlid: string): TraitInfo | undefined {
    return this.traits.get(traitUlid);
  }

  /**
   * Get stats about traits
   */
  getStats(): {
    totalTraits: number;
    specsWithTraits: number;
    avgTraitsPerSpec: number;
  } {
    const specsWithTraits = this.specToTraits.size;
    const totalTraitRefs = Array.from(this.specToTraits.values()).reduce(
      (sum, traits) => sum + traits.length,
      0
    );

    return {
      totalTraits: this.traits.size,
      specsWithTraits,
      avgTraitsPerSpec: specsWithTraits > 0 ? totalTraitRefs / specsWithTraits : 0,
    };
  }
}
