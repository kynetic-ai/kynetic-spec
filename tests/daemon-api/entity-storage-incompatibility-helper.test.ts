/**
 * Unit tests for the daemon route helper that maps deterministic
 * entity-storage compatibility/migration errors to a structured 409 response.
 *
 * AC: @entity-folder-migration-and-compatibility-1 ac-daemon-returns-structured-conflict
 */

import { describe, expect, it } from "vitest";
import {
  EntityStorageCompatibilityError,
  LEGACY_PLAN_STORAGE_REMOVED_CODE,
  LEGACY_REVIEW_STORAGE_REMOVED_CODE,
  MISSING_PLAN_FOLDER_STORAGE_CODE,
  MISSING_REVIEW_FOLDER_STORAGE_CODE,
  PARTIAL_ENTITY_STORAGE_LAYOUT_CODE,
} from "../../dist/parser/entity-storage-compatibility.js";
import {
  ENTITY_STORAGE_INCOMPATIBLE_ERROR_CODE,
  ENTITY_STORAGE_INCOMPATIBLE_STATUS,
  entityStorageIncompatibilityResponse,
} from "../../dist/daemon/routes/entity-storage-error.js";

function planLegacyError(): EntityStorageCompatibilityError {
  return new EntityStorageCompatibilityError(
    'This project uses kynetic version "1.1" without folder-backed plan storage.',
    {
      code: LEGACY_PLAN_STORAGE_REMOVED_CODE,
      domain: "plans",
      suggestion: 'Run "kspec upgrade" to migrate this project.',
      field: "plan_storage.format",
    },
  );
}

function reviewLegacyError(): EntityStorageCompatibilityError {
  return new EntityStorageCompatibilityError(
    'This project uses kynetic version "1.1" without folder-backed review storage.',
    {
      code: LEGACY_REVIEW_STORAGE_REMOVED_CODE,
      domain: "reviews",
      suggestion: 'Run "kspec upgrade" to migrate this project.',
      field: "review_storage.format",
    },
  );
}

function missingPlanFolderError(): EntityStorageCompatibilityError {
  return new EntityStorageCompatibilityError(
    "Project declares kynetic >= 1.2 but plan_storage.format is not 'folder'.",
    {
      code: MISSING_PLAN_FOLDER_STORAGE_CODE,
      domain: "plans",
      suggestion: 'Run "kspec upgrade".',
      field: "plan_storage.format",
    },
  );
}

function partialPlanLayoutError(): EntityStorageCompatibilityError {
  return new EntityStorageCompatibilityError(
    "Project declares folder-backed plan storage but project.plans.yaml still contains monolithic plan records.",
    {
      code: PARTIAL_ENTITY_STORAGE_LAYOUT_CODE,
      domain: "plans",
      suggestion: 'Run "kspec upgrade".',
      field: "plan_storage.format",
    },
  );
}

describe("entityStorageIncompatibilityResponse", () => {
  // AC: @entity-folder-migration-and-compatibility-1 ac-daemon-returns-structured-conflict
  it("maps legacy_plan_storage_removed to 409 with top-level entity_storage_incompatible", () => {
    const result = entityStorageIncompatibilityResponse(planLegacyError());
    expect(result).not.toBeNull();
    expect(result!.status).toBe(ENTITY_STORAGE_INCOMPATIBLE_STATUS);
    expect(result!.status).toBe(409);
    expect(result!.body.error).toBe(ENTITY_STORAGE_INCOMPATIBLE_ERROR_CODE);
    expect(result!.body.error).toBe("entity_storage_incompatible");
    expect(result!.body.code).toBe(LEGACY_PLAN_STORAGE_REMOVED_CODE);
    expect(result!.body.field).toBe("plan_storage.format");
    expect(result!.body.suggestion).toMatch(/kspec upgrade/);
    expect(result!.body.cache_domain).toBe("plans");
    expect(result!.body.domain).toBe("plans");
  });

  it("maps legacy_review_storage_removed with reviews cache_domain", () => {
    const result = entityStorageIncompatibilityResponse(reviewLegacyError());
    expect(result).not.toBeNull();
    expect(result!.body.code).toBe(LEGACY_REVIEW_STORAGE_REMOVED_CODE);
    expect(result!.body.cache_domain).toBe("reviews");
    expect(result!.body.domain).toBe("reviews");
    expect(result!.body.field).toBe("review_storage.format");
  });

  it("maps missing_plan_folder_storage on 1.2 projects without folder declaration", () => {
    const result = entityStorageIncompatibilityResponse(missingPlanFolderError());
    expect(result!.body.code).toBe(MISSING_PLAN_FOLDER_STORAGE_CODE);
    expect(result!.body.domain).toBe("plans");
  });

  it("maps partial_entity_storage_layout to 409 with partial layout context", () => {
    const result = entityStorageIncompatibilityResponse(partialPlanLayoutError());
    expect(result!.body.code).toBe(PARTIAL_ENTITY_STORAGE_LAYOUT_CODE);
    expect(result!.body.domain).toBe("plans");
    expect(result!.body.message).toMatch(/partial|monolithic/i);
  });

  it("reads cache_domain_state from the provided cache for the error's cacheDomain", () => {
    const cache = {
      getDomainState: (domain: string) => (domain === "plans" ? "degraded" : "ready"),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
    const result = entityStorageIncompatibilityResponse(planLegacyError(), {
      cache: cache as any,
    });
    expect(result!.body.cache_domain).toBe("plans");
    expect(result!.body.cache_domain_state).toBe("degraded");
  });

  it("honors an explicit cacheDomain and cacheDomainState override", () => {
    const result = entityStorageIncompatibilityResponse(reviewLegacyError(), {
      cacheDomain: "items",
      cacheDomainState: "loading",
    });
    expect(result!.body.cache_domain).toBe("items");
    expect(result!.body.cache_domain_state).toBe("loading");
  });

  it("omits cache_domain_state when neither cache nor explicit state is provided", () => {
    const result = entityStorageIncompatibilityResponse(planLegacyError());
    expect(result!.body.cache_domain).toBe("plans");
    expect(result!.body.cache_domain_state).toBeUndefined();
  });

  it("returns null for generic errors and unknown deterministic codes", () => {
    expect(entityStorageIncompatibilityResponse(new Error("boom"))).toBeNull();
    expect(entityStorageIncompatibilityResponse("nope")).toBeNull();
    expect(entityStorageIncompatibilityResponse(undefined)).toBeNull();
    expect(entityStorageIncompatibilityResponse(null)).toBeNull();
    expect(
      entityStorageIncompatibilityResponse(
        new EntityStorageCompatibilityError("x", { code: "made_up", domain: "plans" }),
      ),
    ).toBeNull();
  });
});
