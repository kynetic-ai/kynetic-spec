/**
 * Verifies that the resource documentation describes the live UI routing,
 * task-markdown resolution, drift status semantics, browser project context,
 * and the end-to-end temp-project verification steps that
 * @resource-docs-ui-task-markdown-behavior requires.
 *
 * The docs are the artifact under test: each `expect` runs `readTestOutputSync`
 * against the published markdown (concept page, guide, and release notes) and
 * asserts the rendered surface a reader would see. No source code is scanned;
 * only the user-visible docs.
 */

import { describe, it, expect } from "vitest";
import { join, dirname, resolve } from "node:path";
import { readTestOutputSync } from "./helpers/cli";

const projectRoot = resolve(dirname(__dirname));
const docs = (...segments: string[]) => readTestOutputSync(join(projectRoot, "docs", ...segments));
const releaseNotes = () => readTestOutputSync(join(projectRoot, "RELEASE_NOTES.md"));

describe("@resource-docs-ui-task-markdown-behavior ac-docs-name-task-resource-markdown", () => {
  // AC: @resource-docs-ui-task-markdown-behavior ac-docs-name-task-resource-markdown
  it("concept page explains task-description ./resources/<rel> resolution for plan-owned and task-owned copies", () => {
    const concept = docs("concepts", "local-resources.md");
    expect(concept).toContain("./resources/<relative-path>");
    // Both ownership cases are named for the reader.
    expect(concept).toContain("Plan-owned references");
    expect(concept).toContain("Task-owned copies");
    expect(concept).toContain('owner_type: "plan"');
    expect(concept).toContain('owner_type: "task"');
    // The task-scoped resolution contract is documented.
    expect(concept).toContain("resolved_resources");
    expect(concept).toContain("resources_base_url");
    expect(concept).toContain("/api/tasks/:ref/resources/:resourceId/bytes");
  });

  // AC: @resource-docs-ui-task-markdown-behavior ac-docs-name-task-resource-markdown
  it("guide names the task resource routes, projection fields, and base-url contract", () => {
    const guide = docs("guides", "working-with-local-resources.md");
    for (const route of [
      "/api/tasks/:ref/resources",
      "/api/tasks/:ref/resources/:resourceId",
      "/api/tasks/:ref/resources/:resourceId/bytes",
    ]) {
      expect(guide, `guide must name task route "${route}"`).toContain(route);
    }
    expect(guide).toContain("resolved_resources");
    expect(guide).toContain("resources_base_url");
    expect(guide).toContain("/api/tasks/<task-ulid>/resources");
    // States how the two ownership cases are produced and resolved.
    expect(guide).toContain("plan-owned references");
    expect(guide).toContain("task-owned copies");
    expect(guide).toContain("kspec plan derive --materialize-resources");
  });

  // AC: @resource-docs-ui-task-markdown-behavior ac-docs-name-task-resource-markdown
  it("release notes describe task-markdown resolution without claiming a task resource upload command", () => {
    const notes = releaseNotes();
    expect(notes).toContain("./resources/<relative-path>");
    expect(notes).toContain("resolved_resources");
    expect(notes).toContain("resources_base_url");
    expect(notes).toContain("GET /api/tasks/:ref/resources[/:id[/bytes]]");
    // Must not advertise an unsupported task resource upload command.
    expect(notes).toContain("there is no task resource upload");
    expect(notes).not.toContain("kspec task resource add");
  });
});

describe("@resource-docs-ui-task-markdown-behavior ac-docs-name-task-resource-drift", () => {
  // AC: @resource-docs-ui-task-markdown-behavior ac-docs-name-task-resource-drift
  it("concept page states drift/missing/unresolved are status, not silent replacement bytes", () => {
    const concept = docs("concepts", "local-resources.md");
    for (const status of ["present", "drift", "missing", "unresolved"]) {
      expect(concept, `concept must name status "${status}"`).toContain(`\`${status}\``);
    }
    expect(concept).toContain("instead of silently serving replacement bytes");
    expect(concept).toContain("refuses to stream bytes that differ from the hash recorded");
  });

  // AC: @resource-docs-ui-task-markdown-behavior ac-docs-name-task-resource-drift
  it("guide states drifted/missing/unresolved task resources surface status messages, not substitute bytes", () => {
    const guide = docs("guides", "working-with-local-resources.md");
    expect(guide).toContain("`present`, `drift`, `missing`, or `unresolved`");
    expect(guide).toContain("refuses to stream replacement bytes that differ from the hash");
    expect(guide).toContain("never a silent substitution");
  });
});

describe("@resource-docs-ui-task-markdown-behavior ac-docs-name-browser-project-context", () => {
  // AC: @resource-docs-ui-task-markdown-behavior ac-docs-name-browser-project-context
  it("guide states browser image/link URLs need URL-level kspec_dir because element fetches cannot send X-Kspec-Dir", () => {
    const guide = docs("guides", "working-with-local-resources.md");
    expect(guide).toContain("kspec_dir");
    expect(guide).toContain("X-Kspec-Dir");
    expect(guide).toContain("cannot send `X-Kspec-Dir`");
    expect(guide).toContain("multi-project");
    // The rewritten URL shape carries the query parameter.
    expect(guide).toContain("?kspec_dir=");
  });
});

describe("@resource-docs-ui-task-markdown-behavior ac-docs-name-temp-project-e2e-steps", () => {
  // AC: @resource-docs-ui-task-markdown-behavior ac-docs-name-temp-project-e2e-steps
  it("guide provides temp-project steps that exercise CLI storage, daemon bytes routes, live UI, browser routing, and export without restarting the daemon", () => {
    const guide = docs("guides", "working-with-local-resources.md");
    // CLI storage + both ownership cases (default refs and a materialized copy in a separate project).
    expect(guide).toContain("kspec plan import plans/feature.md");
    expect(guide).toContain("kspec plan derive @plan-sign-in-feature");
    expect(guide).toContain("kspec plan derive @plan-sign-in-feature --materialize-resources");
    expect(guide).toContain("kspec task get @task-build-sign-in");
    // Daemon started once and explicitly not restarted/stopped.
    expect(guide).toContain("kspec serve start");
    expect(guide).toContain("without restarting or stopping the daemon");
    expect(guide).toContain("do not stop or restart");
    // Daemon bytes routes for task resources, including selected-project routing via kspec_dir.
    expect(guide).toContain("/api/tasks/@task-build-sign-in/resources/ux-mockup/bytes");
    expect(guide).toContain("?kspec_dir=$MAT_DIR");
    expect(guide).toContain("X-Kspec-Resource-Sha256");
    // Live UI image/link rendering and selected-project browser URL routing.
    expect(guide).toContain("task detail modal");
    expect(guide).toContain("project switcher");
    // Static export asset existence for plan and task resources.
    expect(guide).toContain(
      "kspec export --format json --output /tmp/export-default/snapshot.json",
    );
    expect(guide).toContain("/tmp/export-default/assets/resources/task/");
    expect(guide).toContain("/tmp/export-default/assets/resources/plan/");
    expect(guide).toContain("/tmp/export-materialized/assets/resources/task/");
  });
});
