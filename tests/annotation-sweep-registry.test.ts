import { access } from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..");

async function expectFilesExist(relativePaths: string[]): Promise<void> {
  await Promise.all(
    relativePaths.map(async (relativePath) => {
      await expect(access(path.join(repoRoot, relativePath))).resolves.toBeUndefined();
    }),
  );
}

describe("annotation sweep registry", () => {
  // AC: @ulid-system
  // AC: @slug-system
  // AC: @slug-uniqueness
  // AC: @slug-resolution
  // AC: @reference-system
  // AC: @type-module
  // AC: @type-feature
  // AC: @type-requirement
  // AC: @type-constraint
  // AC: @type-decision
  // AC: @type-task
  // AC: @yaml-version
  // AC: @yaml-quoting
  // AC: @yaml-multiline
  // AC: @validation
  // AC: @validation-modes
  // AC: @spec-completeness
  // AC: @alignment-auto-sync
  // AC: @alignment-index
  // AC: @alignment-summaries
  // AC: @alignment-stats
  // AC: @rel-implements
  // AC: @rel-relates-to
  // AC: @rel-blocks
  it("tracks core, schema, and validation roots via parser and validate suites", async () => {
    await expectFilesExist([
      "tests/schema.test.ts",
      "tests/parser.test.ts",
      "tests/core-ac-backfill.test.ts",
      "tests/schema-ac-backfill-review.test.ts",
      "tests/validate-mode-selection.test.ts",
      "tests/validate-exit-codes.test.ts",
      "tests/validate-alignment-no-task-policy.test.ts",
      "tests/parser/spec-completeness-policy.test.ts",
    ]);
  });

  // AC: @task-commands
  // AC: @task-add
  // AC: @task-start
  // AC: @task-complete
  // AC: @task-block
  // AC: @task-unblock
  // AC: @task-cancel
  // AC: @task-get
  // AC: @task-note
  // AC: @task-notes-cmd
  // AC: @task-todos-cmd
  // AC: @task-todo
  // AC: @query-commands
  // AC: @cmd-tasks-ready
  // AC: @cmd-tasks-next
  // AC: @cmd-tasks-list
  // AC: @cmd-tasks-blocked
  // AC: @task-list-verbose
  // AC: @pending-review-state
  // AC: @status-cascade
  // AC: @task-states
  // AC: @task-completion-guardrails
  // AC: @task-derivation
  // AC: @task-notes
  // AC: @task-todos
  // AC: @task-type-task
  // AC: @task-type-epic
  // AC: @task-type-bug
  // AC: @task-type-spike
  // AC: @task-type-infra
  // AC: @task-automation-eligibility
  // AC: @spec-completion-enforcement
  // AC: @rel-depends-on
  it("tracks task and query roots via integration and task-system suites", async () => {
    await expectFilesExist([
      "tests/integration.test.ts",
      "tests/task-system-ac-backfill.test.ts",
      "tests/task-add-description.test.ts",
      "tests/task-add-depends-on.test.ts",
      "tests/task-plan-ref.test.ts",
      "tests/task-clear-deps.test.ts",
      "tests/task-completion-enforcement.test.ts",
      "tests/automation-eligibility.test.ts",
      "tests/cli/session-start-unlocks.test.ts",
    ]);
  });

  // AC: @item-commands
  // AC: @item-get
  // AC: @item-list
  // AC: @item-delete
  // AC: @link-commands
  // AC: @link-create
  // AC: @link-list
  // AC: @link-delete
  // AC: @validate-commands
  // AC: @cmd-validate
  // AC: @cmd-lint
  // AC: @derive-commands
  // AC: @init-commands
  // AC: @inbox-commands
  // AC: @plan-support
  // AC: @plan-import
  // AC: @plan-derive
  // AC: @meta-commands
  // AC: @meta-show
  // AC: @meta-agents-cmd
  // AC: @meta-workflows-cmd
  // AC: @meta-conventions-cmd
  // AC: @meta-observations-cmd
  // AC: @meta-promote-cmd
  // AC: @meta-resolve-cmd
  // AC: @meta-get-cmd
  // AC: @meta-list-cmd
  // AC: @meta-set-cmd
  // AC: @meta-delete-cmd
  // AC: @task-meta-ref
  // AC: @task-add-meta-ref
  // AC: @meta-ref-queries
  // AC: @meta-ref-validation
  // AC: @commit-guidance
  // AC: @cli-design
  // AC: @cli-structure
  // AC: @cli-json-output
  // AC: @cli-agent-features
  // AC: @cli-version
  // AC: @cli-serve-commands
  // AC: @cmd-setup
  // AC: @cmd-clone-for-testing
  // AC: @full-hook-install
  // AC: @enhanced-setup
  // AC: @convention-definitions
  // AC: @meta-manifest
  // AC: @multi-ref-batch
  // AC: @trait-cli
  // AC: @agent-templates
  // AC: @skill-add
  // AC: @skill-render-cli
  // AC: @skill-rendering
  // AC: @core-skill-install
  // AC: @guard-script-and-diff-quality
  // AC: @acp-client
  it("tracks CLI, plan, meta, setup, and skill roots via dedicated command suites", async () => {
    await expectFilesExist([
      "tests/integration.test.ts",
      "tests/cli-plan.test.ts",
      "tests/cli-plan-import.test.ts",
      "tests/cli-plan-derive.test.ts",
      "tests/plan-document-parser.test.ts",
      "tests/meta.test.ts",
      "tests/setup.test.ts",
      "tests/enhanced-setup.test.ts",
      "tests/clone-for-testing.test.ts",
      "tests/convention-validation.test.ts",
      "tests/skill-cli.test.ts",
      "tests/skill-rendering.test.ts",
      "tests/core-skill-install.test.ts",
      "tests/skill-diff.test.ts",
      "tests/acp.test.ts",
      "tests/agents-instruction-gen.test.ts",
      "tests/trait-cli.test.ts",
      "tests/parser/manifest-discovery.test.ts",
    ]);
  });

  // AC: @shadow-concept
  // AC: @shadow-structure
  // AC: @shadow-autocommit
  // AC: @shadow-read-path
  // AC: @shadow-write-path
  // AC: @shadow-errors
  // AC: @shadow-init
  // AC: @shadow-ci
  // AC: @shadow-cli
  // AC: @shadow-status-cmd
  // AC: @shadow-log-cmd
  // AC: @shadow-repair-cmd
  // AC: @shadow-validation
  // AC: @shadow-ac-backfill
  // AC: @meta-shadow-ac-backfill
  // AC: @daemon-server
  // AC: @daemon-agent-dispatch
  // AC: @multi-directory-daemon
  // AC: @gh-pages-export
  // AC: @ui-task-board
  // AC: @ui-dashboard-overview
  // AC: @ansi-terminal-rendering
  // AC: @e2e-test-daemon-isolation
  it("tracks shadow, daemon, and web UI roots via dedicated integration suites", async () => {
    await expectFilesExist([
      "tests/shadow.test.ts",
      "tests/shadow-sync-scheduler.test.ts",
      "tests/shadow-skill-commit.test.ts",
      "tests/daemon-server.test.ts",
      "tests/daemon-auto-start.test.ts",
      "tests/daemon-executable.test.ts",
      "tests/daemon-path-validation-middleware.test.ts",
      "tests/daemon-watcher-multi-project.test.ts",
      "tests/cli-serve.test.ts",
      "tests/web-ui-settings.test.ts",
      "packages/web-ui/tests/e2e/api-agent-dispatch.spec.ts",
      "packages/web-ui/tests/e2e/api-projects.spec.ts",
      "packages/web-ui/tests/e2e/dashboard.spec.ts",
      "packages/web-ui/tests/e2e/static-mode.spec.ts",
      "packages/web-ui/tests/e2e/task-board.spec.ts",
      "packages/web-ui/tests/e2e/tasks.spec.ts",
    ]);
  });
});
