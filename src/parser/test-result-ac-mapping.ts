import { AcIdSchema, RefSchema } from "../schema/common.js";
import type {
  NormalizedTestCase,
  TestResultCriterionRef,
  TestResultMappingSummary,
} from "../schema/test-result-runs.js";
import type { ReferenceIndex } from "./refs.js";
import type { LoadedSpecItem } from "./yaml.js";

type InvalidMappingReason = "malformed_ref" | "missing_item" | "missing_ac_id";

function displayRefForItem(item: LoadedSpecItem, refIndex: ReferenceIndex): string {
  if (item.slugs.length > 0) return `@${item.slugs[0]}`;
  return `@${refIndex.shortUlid(item._ulid)}`;
}

function invalidMapping(
  testCase: NormalizedTestCase,
  ref: TestResultCriterionRef,
  reason: InvalidMappingReason,
): TestResultMappingSummary["invalid"][number] {
  return {
    case_id: testCase.id,
    ...(ref.item_ref ? { item_ref: ref.item_ref } : {}),
    ...(ref.ac_id ? { ac_id: ref.ac_id } : {}),
    reason,
    display_name: testCase.display_name,
  };
}

function hasAcceptanceCriterion(item: LoadedSpecItem, acId: string): boolean {
  return (item.acceptance_criteria ?? []).some((criterion) => criterion.id === acId);
}

/**
 * Validate normalized case refs against the loaded spec corpus and derive the
 * persisted mapping report for a test run.
 */
export function mapTestResultCasesToAcceptanceCriteria(
  refIndex: ReferenceIndex,
  specItems: LoadedSpecItem[],
  cases: readonly NormalizedTestCase[],
): TestResultMappingSummary {
  const specItemsByUlid = new Map(specItems.map((item) => [item._ulid, item]));
  const mapping: TestResultMappingSummary = {
    attributed: [],
    unmapped: [],
    invalid: [],
  };

  for (const testCase of cases) {
    if (testCase.refs.length === 0) {
      mapping.unmapped.push({
        case_id: testCase.id,
        reason: "no_refs",
        display_name: testCase.display_name,
      });
      continue;
    }

    for (const ref of testCase.refs) {
      const itemRef = RefSchema.safeParse(ref.item_ref);
      const acId = AcIdSchema.safeParse(ref.ac_id);
      if (!itemRef.success || !acId.success) {
        mapping.invalid.push(invalidMapping(testCase, ref, "malformed_ref"));
        continue;
      }

      const resolved = refIndex.resolve(itemRef.data);
      const specItem = resolved.ok ? specItemsByUlid.get(resolved.ulid) : undefined;
      if (!specItem) {
        mapping.invalid.push(invalidMapping(testCase, ref, "missing_item"));
        continue;
      }

      if (!hasAcceptanceCriterion(specItem, acId.data)) {
        mapping.invalid.push(invalidMapping(testCase, ref, "missing_ac_id"));
        continue;
      }

      mapping.attributed.push({
        case_id: testCase.id,
        item_ulid: specItem._ulid,
        item_ref: displayRefForItem(specItem, refIndex),
        ac_id: acId.data,
        status: testCase.status,
      });
    }
  }

  return mapping;
}
