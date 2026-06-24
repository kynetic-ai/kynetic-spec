import type {
  CoverageItemStateSummary,
  CoverageStateChangedEventData,
  CoverageStateSnapshot,
  CoverageStateSummary,
  SpecItemChangedEventData,
} from "@kynetic-ai/shared";
import type { MutationEventDescriptor } from "../../mutation-pipeline.js";
import type { TestResultIngestionSummary } from "../../parser/index.js";

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].toSorted();
}

function bucketsForCriteria(
  item: CoverageItemStateSummary,
  acIds: readonly string[],
): Array<keyof CoverageStateSummary["counts"]> {
  const acSet = new Set(acIds);
  return uniqueSorted(
    item.criteria
      .filter((criterion) => acSet.has(criterion.ac_id))
      .map((criterion) => criterion.presentation),
  ) as Array<keyof CoverageStateSummary["counts"]>;
}

function allCriterionIds(item: CoverageItemStateSummary): string[] {
  return uniqueSorted(item.criteria.map((criterion) => criterion.ac_id));
}

export function buildCoverageStateChangedEventForIngestion(
  summary: TestResultIngestionSummary,
  model: CoverageStateSnapshot,
): CoverageStateChangedEventData {
  const acIdsByItemRef = new Map<string, Set<string>>();
  for (const mapping of summary.mapping.attributed) {
    const set = acIdsByItemRef.get(mapping.item_ref) ?? new Set<string>();
    set.add(mapping.ac_id);
    acIdsByItemRef.set(mapping.item_ref, set);
  }

  const affectedItems = summary.affected_item_refs.flatMap((itemRef) => {
    const item = model.items[itemRef] ?? model.items[itemRef.replace(/^@/, "")];
    if (!item) return [];
    const acIds = uniqueSorted(acIdsByItemRef.get(itemRef) ?? []);
    return [
      {
        item_ulid: item.item_ulid,
        item_ref: item.item_ref,
        ...(acIds.length > 0 ? { ac_ids: acIds } : {}),
        ...(acIds.length > 0 ? { buckets: bucketsForCriteria(item, acIds) } : {}),
      },
    ];
  });

  return {
    action: "changed",
    family: "coverage_state",
    run_id: summary.run_id,
    affected: {
      items: affectedItems,
    },
    refresh: {
      project_summary: true,
      item_detail: affectedItems.length > 0,
      criterion_detail: affectedItems.some((item) => (item.ac_ids?.length ?? 0) > 0),
      unmapped_results: summary.unmapped_count > 0 || summary.invalid_mapping_count > 0,
    },
    scope: affectedItems.length > 0 ? "precise" : "project",
    reason: "test_result_ingestion",
  };
}

export function buildCoverageStateChangedEventForSpecMutations(
  events: readonly MutationEventDescriptor[],
  model: CoverageStateSnapshot,
): CoverageStateChangedEventData | null {
  const itemUlids = uniqueSorted(
    events.flatMap((descriptor) => {
      if (descriptor.topic !== "items:updates" || descriptor.event !== "spec_item_changed") {
        return [];
      }
      const data = descriptor.data as Partial<SpecItemChangedEventData>;
      return typeof data.item_ulid === "string" && data.item_ulid.length > 0
        ? [data.item_ulid]
        : [];
    }),
  );

  if (itemUlids.length === 0) {
    return null;
  }

  let unresolvedItem = false;
  const affectedItems = itemUlids.map((itemUlid) => {
    const item = model.items[itemUlid];
    if (!item) {
      unresolvedItem = true;
      return { item_ulid: itemUlid };
    }

    const acIds = allCriterionIds(item);
    return {
      item_ulid: item.item_ulid,
      item_ref: item.item_ref,
      ...(acIds.length > 0 ? { ac_ids: acIds } : {}),
      ...(acIds.length > 0 ? { buckets: bucketsForCriteria(item, acIds) } : {}),
    };
  });

  return {
    action: "changed",
    family: "coverage_state",
    affected: {
      items: affectedItems,
    },
    refresh: {
      project_summary: true,
      item_detail: affectedItems.length > 0,
      criterion_detail: affectedItems.some((item) => (item.ac_ids?.length ?? 0) > 0),
      unmapped_results: true,
    },
    scope: unresolvedItem ? "project" : "precise",
    reason: "spec_mutation",
  };
}
