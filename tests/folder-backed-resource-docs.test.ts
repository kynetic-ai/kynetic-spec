/**
 * Verifies that the folder-backed resource documentation describes the
 * concrete CLI/API/storage interfaces and the upgrade compatibility gate
 * that @folder-backed-resource-documentation-1 requires.
 *
 * The docs are the artifact under test: each `expect` runs `readTestOutputSync`
 * against the published markdown file and asserts the rendered surface (link
 * text, command names, API routes, manifest fields) that a reader would see.
 * No source code is scanned; only the user-visible docs.
 */

import { describe, it, expect } from "vitest";
import { join, dirname, resolve } from "node:path";
import { readTestOutputSync } from "./helpers/cli";

const projectRoot = resolve(dirname(__dirname));
const docs = (...segments: string[]) =>
  readTestOutputSync(join(projectRoot, "docs", ...segments));

describe("@folder-backed-resource-documentation-1 ac-resource-docs-name-exact-interfaces", () => {
  // AC: @folder-backed-resource-documentation-1 ac-resource-docs-name-exact-interfaces
  it("names the exact plan and review resource CLI commands", () => {
    const guide = docs("guides", "working-with-local-resources.md");
    for (const command of [
      "kspec plan resource add",
      "kspec plan resource list",
      "kspec plan resource get",
      "kspec plan resource remove",
      "kspec review resource add",
      "kspec review resource list",
      "kspec review resource get",
      "kspec review resource remove",
    ]) {
      expect(guide, `working-with-local-resources.md must name "${command}"`).toContain(command);
    }
  });

  // AC: @folder-backed-resource-documentation-1 ac-resource-docs-name-exact-interfaces
  it("documents `kspec plan derive --materialize-resources` behavior with the exact destination layout and id prefix", () => {
    const guide = docs("guides", "working-with-local-resources.md");
    expect(guide).toContain("kspec plan derive @plan-my-feature --materialize-resources");
    expect(guide).toContain(
      ".kspec/tasks/<task-ulid>/resources/plan/<plan-ulid>/<relative-path>",
    );
    expect(guide).toContain("plan-<original-resource-id>");

    const concept = docs("concepts", "local-resources.md");
    expect(concept).toContain("--materialize-resources");
    expect(concept).toContain(
      ".kspec/tasks/<task-ulid>/resources/plan/<plan-ulid>/<relative-path>",
    );
    expect(concept).toContain("plan-<original-resource-id>");
  });

  // AC: @folder-backed-resource-documentation-1 ac-resource-docs-name-exact-interfaces
  it("names the exact plan and review resource API routes", () => {
    const guide = docs("guides", "working-with-local-resources.md");
    for (const route of [
      "/api/plans/:ref/resources",
      "/api/plans/:ref/resources/:resourceId",
      "/api/plans/:ref/resources/:resourceId/bytes",
      "/api/reviews/:ref/resources",
      "/api/reviews/:ref/resources/:resourceId",
      "/api/reviews/:ref/resources/:resourceId/bytes",
    ]) {
      expect(guide, `working-with-local-resources.md must name "${route}"`).toContain(route);
    }
  });

  // AC: @folder-backed-resource-documentation-1 ac-resource-docs-name-exact-interfaces
  it("documents the X-Kspec-Resource-Sha256 response header on the /bytes route", () => {
    const guide = docs("guides", "working-with-local-resources.md");
    expect(guide).toContain("X-Kspec-Resource-Sha256");
  });

  // AC: @folder-backed-resource-documentation-1 ac-resource-docs-name-exact-interfaces
  it("documents the multipart POST upload field shape with the exact replace coercion rules", () => {
    const guide = docs("guides", "working-with-local-resources.md");
    expect(guide).toContain("multipart/form-data");
    for (const field of ["file", "id", "path", "label", "description", "content_type", "replace"]) {
      expect(guide, `multipart field "${field}" must be documented`).toContain(field);
    }
    expect(guide).toContain('"true"');
    expect(guide).toContain('"1"');
    expect(guide).toContain('"false"');
    expect(guide).toContain('"0"');
    expect(guide).toContain("invalid_replace_value");
  });

  // AC: @folder-backed-resource-documentation-1 ac-resource-docs-name-exact-interfaces
  it("names every ResourceMetadata field and the resources.yaml manifest shape", () => {
    const concept = docs("concepts", "local-resources.md");
    expect(concept).toContain("resources.yaml");
    for (const field of [
      "`id`",
      "`label`",
      "`path`",
      "`content_type`",
      "`bytes`",
      "`sha256`",
      "`git_commit`",
      "`git_path`",
      "`description`",
    ]) {
      expect(concept, `ResourceMetadata field ${field} must be named`).toContain(field);
    }
  });

  // AC: @folder-backed-resource-documentation-1 ac-resource-docs-name-exact-interfaces
  it("documents the resource id pattern and the ./resources/<rel> authoring reference form", () => {
    const concept = docs("concepts", "local-resources.md");
    expect(concept).toContain("[a-z0-9][a-z0-9._-]{0,127}");
    expect(concept).toContain("./resources/");
  });

  // AC: @folder-backed-resource-documentation-1 ac-resource-docs-name-exact-interfaces
  it("documents the static-export path layout for plan and review resources", () => {
    const concept = docs("concepts", "local-resources.md");
    expect(concept).toContain("assets/resources/plan/<plan-ulid>/<relative-path>");
    expect(concept).toContain("assets/resources/review/<review-ulid>/<relative-path>");
  });

  // AC: @folder-backed-resource-documentation-1 ac-resource-docs-name-exact-interfaces
  it("documents the folder-backed plan and review on-disk layouts", () => {
    const concept = docs("concepts", "local-resources.md");
    expect(concept).toContain(".kspec/plans/<plan-ulid>/");
    expect(concept).toContain(".kspec/reviews/<review-ulid>/");
    expect(concept).toContain("plan.md");
    expect(concept).toContain("plan.yaml");
    expect(concept).toContain("review.yaml");
    expect(concept).toContain(".kspec/project.plans.yaml");
    expect(concept).toContain(".kspec/project.reviews.yaml");
  });
});

describe("@folder-backed-resource-documentation-1 ac-upgrade-docs-explain-compatibility-gate", () => {
  // AC: @folder-backed-resource-documentation-1 ac-upgrade-docs-explain-compatibility-gate
  it("explains the kynetic 1.2 manifest fields", () => {
    const upgrade = docs("guides", "upgrading-kspec.md");
    expect(upgrade).toContain('kynetic: "1.2"');
    for (const field of [
      "plan_storage:",
      "review_storage:",
      "resource_storage:",
      "task_storage:",
      "format: folder",
      "format: entity_scoped",
      "format: split",
    ]) {
      expect(upgrade, `upgrading-kspec.md must explain "${field}"`).toContain(field);
    }
  });

  // AC: @folder-backed-resource-documentation-1 ac-upgrade-docs-explain-compatibility-gate
  it("documents the `kspec upgrade` migration path including dry-run preview", () => {
    const upgrade = docs("guides", "upgrading-kspec.md");
    expect(upgrade).toContain("kspec upgrade");
    expect(upgrade).toContain("kspec upgrade --dry-run");
  });

  // AC: @folder-backed-resource-documentation-1 ac-upgrade-docs-explain-compatibility-gate
  it("documents previous-shadow-commit rollback guidance", () => {
    const upgrade = docs("guides", "upgrading-kspec.md");
    expect(upgrade).toContain("Shadow HEAD (pre-upgrade rollback ref)");
    expect(upgrade).toContain("previous shadow commit");
    expect(upgrade).toContain("git reset --hard");
  });

  // AC: @folder-backed-resource-documentation-1 ac-upgrade-docs-explain-compatibility-gate
  it("documents `entity_storage_incompatible` recovery in dedicated troubleshooting", () => {
    const troubleshoot = docs("troubleshooting", "entity-storage-incompatible.md");
    expect(troubleshoot).toContain("entity_storage_incompatible");
    for (const code of [
      "legacy_plan_storage_removed",
      "legacy_review_storage_removed",
      "missing_plan_folder_storage",
      "missing_review_folder_storage",
      "partial_entity_storage_layout",
    ]) {
      expect(troubleshoot, `troubleshooting must explain code "${code}"`).toContain(code);
    }
    expect(troubleshoot).toContain("kspec upgrade --dry-run");
    expect(troubleshoot).toContain("kspec upgrade");
  });

  // AC: @folder-backed-resource-documentation-1 ac-upgrade-docs-explain-compatibility-gate
  it("documents stale-index and resource-drift troubleshooting paths", () => {
    const drift = docs("troubleshooting", "plan-or-review-index-drift.md");
    expect(drift).toContain("kspec plan rebuild-index");
    expect(drift).toContain("kspec review rebuild-index");
    expect(drift).toContain("--repair");
    expect(drift).toContain("--force");
    expect(drift).toContain("--dry-run");
    // Drift on derived task resource refs is also covered here.
    expect(drift).toContain("TaskResourceRef");
    expect(drift).toContain("sha256");
  });

  // AC: @folder-backed-resource-documentation-1 ac-upgrade-docs-explain-compatibility-gate
  it("surfaces the new troubleshooting pages from the troubleshooting index", () => {
    const index = docs("troubleshooting", "index.md");
    expect(index).toContain("./entity-storage-incompatible.md");
    expect(index).toContain("./plan-or-review-index-drift.md");
  });

  // AC: @folder-backed-resource-documentation-1 ac-upgrade-docs-explain-compatibility-gate
  it("surfaces the new local-resources concept and guide from their section indexes", () => {
    const conceptsIndex = docs("concepts", "index.md");
    expect(conceptsIndex).toContain("./local-resources.md");
    const guidesIndex = docs("guides", "index.md");
    expect(guidesIndex).toContain("./working-with-local-resources.md");
  });
});
