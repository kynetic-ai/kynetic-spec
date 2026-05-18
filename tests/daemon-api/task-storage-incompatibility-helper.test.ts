/**
 * Unit tests for the daemon route helper that maps deterministic task-storage
 * compatibility/migration errors into a structured 409 response.
 *
 * AC: @api-contract ac-task-storage-incompatibility-conflict-status
 * AC: @api-contract ac-task-storage-incompatibility-error-code
 * AC: @api-contract ac-task-storage-incompatibility-guidance
 * AC: @api-contract ac-task-storage-incompatibility-field-context
 * AC: @api-contract ac-task-storage-incompatibility-cache-domain-context
 * AC: @api-contract ac-task-storage-incompatibility-cache-state-context
 */

import { describe, expect, it } from "vitest";
import {
  TaskDataManagerError,
  TASK_STORAGE_LEGACY_REMOVED_CODE,
  TASK_STORAGE_SPLIT_UNMIGRATED_CODE,
} from "../../dist/parser/task-data-manager.js";
import {
  taskStorageIncompatibilityResponse,
  TASK_STORAGE_INCOMPATIBLE_ERROR_CODE,
  TASK_STORAGE_INCOMPATIBLE_STATUS,
} from "../../dist/daemon/routes/task-storage-error.js";

function legacyRemovedError(): TaskDataManagerError {
  return new TaskDataManagerError(
    'This project uses kynetic version "1.0" without split task storage. The monolithic task storage format has been removed.',
    {
      suggestion:
        'Run "kspec task migrate" to convert to per-task directory storage, then tasks will work normally.',
      field: "task_storage.format",
      code: TASK_STORAGE_LEGACY_REMOVED_CODE,
    },
  );
}

function splitUnmigratedError(): TaskDataManagerError {
  return new TaskDataManagerError(
    "Project task storage is configured for split format but project.tasks.yaml still contains unmigrated monolithic entries.",
    {
      suggestion:
        'Run "kspec task migrate" to complete the conversion, or restore a compatible task-storage state.',
      field: "task_storage.format",
      code: TASK_STORAGE_SPLIT_UNMIGRATED_CODE,
    },
  );
}

describe("taskStorageIncompatibilityResponse", () => {
  // AC: @api-contract ac-task-storage-incompatibility-conflict-status
  // AC: @api-contract ac-task-storage-incompatibility-error-code
  // AC: @api-contract ac-task-storage-incompatibility-guidance
  // AC: @api-contract ac-task-storage-incompatibility-field-context
  it("maps the legacy_task_storage_removed code to a structured 409", () => {
    const result = taskStorageIncompatibilityResponse(legacyRemovedError());

    expect(result).not.toBeNull();
    expect(result!.status).toBe(TASK_STORAGE_INCOMPATIBLE_STATUS);
    expect(result!.status).toBe(409);
    expect(result!.body.error).toBe(TASK_STORAGE_INCOMPATIBLE_ERROR_CODE);
    expect(result!.body.error).toBe("task_storage_incompatible");
    expect(result!.body.code).toBe(TASK_STORAGE_LEGACY_REMOVED_CODE);
    expect(result!.body.message).toContain("monolithic task storage format has been removed");
    expect(result!.body.suggestion).toContain("kspec task migrate");
    expect(result!.body.field).toBe("task_storage.format");
  });

  // AC: @api-contract ac-task-storage-incompatibility-error-code
  // AC: @api-contract ac-task-storage-incompatibility-guidance
  it("maps the split_task_storage_unmigrated code to a structured 409", () => {
    const result = taskStorageIncompatibilityResponse(splitUnmigratedError());

    expect(result).not.toBeNull();
    expect(result!.status).toBe(409);
    expect(result!.body.error).toBe("task_storage_incompatible");
    expect(result!.body.code).toBe(TASK_STORAGE_SPLIT_UNMIGRATED_CODE);
    expect(result!.body.suggestion).toBeTruthy();
    expect(result!.body.field).toBe("task_storage.format");
  });

  // AC: @api-contract ac-task-storage-incompatibility-cache-domain-context
  // AC: @api-contract ac-task-storage-incompatibility-cache-state-context
  it("defaults cache_domain to 'tasks' and reads cache_domain_state from the cache", () => {
    // Minimal stub matching the getDomainState contract the helper relies on.
    const cache = {
      getDomainState: (domain: string) => (domain === "tasks" ? "degraded" : "ready"),
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal cache stub for helper
    const result = taskStorageIncompatibilityResponse(legacyRemovedError(), { cache: cache as any });

    expect(result).not.toBeNull();
    expect(result!.body.cache_domain).toBe("tasks");
    expect(result!.body.cache_domain_state).toBe("degraded");
  });

  // AC: @api-contract ac-task-storage-incompatibility-cache-domain-context
  // AC: @api-contract ac-task-storage-incompatibility-cache-state-context
  it("honors an explicit cacheDomain and cacheDomainState override", () => {
    const result = taskStorageIncompatibilityResponse(legacyRemovedError(), {
      cacheDomain: "items",
      cacheDomainState: "loading",
    });

    expect(result).not.toBeNull();
    expect(result!.body.cache_domain).toBe("items");
    expect(result!.body.cache_domain_state).toBe("loading");
  });

  // AC: @api-contract ac-task-storage-incompatibility-cache-state-context
  it("omits cache_domain_state when neither cache nor explicit state is provided", () => {
    const result = taskStorageIncompatibilityResponse(legacyRemovedError());

    expect(result).not.toBeNull();
    expect(result!.body.cache_domain_state).toBeUndefined();
    expect(result!.body.cache_domain).toBe("tasks");
  });

  // AC: @api-contract ac-task-storage-incompatibility-not-not-found
  it("returns null for generic TaskDataManagerError without a deterministic code", () => {
    const genericNotFound = new TaskDataManagerError("Task not found: @some-ref", {
      suggestion: 'Check the reference with: kspec search "@some-ref" or kspec task list',
    });

    expect(taskStorageIncompatibilityResponse(genericNotFound)).toBeNull();
  });

  // AC: @api-contract ac-task-storage-incompatibility-not-not-found
  it("returns null for TaskDataManagerError with an unrelated code", () => {
    const unrelated = new TaskDataManagerError("Some other failure", {
      code: "some_other_code",
    });

    expect(taskStorageIncompatibilityResponse(unrelated)).toBeNull();
  });

  it("returns null for non-TaskDataManagerError values", () => {
    expect(taskStorageIncompatibilityResponse(new Error("boom"))).toBeNull();
    expect(taskStorageIncompatibilityResponse("nope")).toBeNull();
    expect(taskStorageIncompatibilityResponse(undefined)).toBeNull();
    expect(taskStorageIncompatibilityResponse(null)).toBeNull();
  });
});
