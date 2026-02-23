/**
 * Skill CLI commands - orchestrator module.
 *
 * This module registers all skill subcommands by delegating to focused modules:
 * - skill-crud.ts: list, add, get, set, delete, import
 * - skill-install.ts: install-core, update
 * - skill-diff.ts: render, status, diff, verify
 *
 * AC: @skill-module-split ac-1 - skill.ts split into focused modules
 * AC: @skill-module-split ac-3 - re-exports maintain backward API compatibility
 */

import type { Command } from "commander";
import { registerSkillCrudCommands } from "./skill-crud.js";
import { registerSkillInstallCommands } from "./skill-install.js";
import { registerSkillDiffCommands } from "./skill-diff.js";

/**
 * Register all skill commands
 */
export function registerSkillCommands(program: Command): void {
  const skill = program
    .command("skill")
    .description("Skill management commands");

  registerSkillCrudCommands(skill);
  registerSkillInstallCommands(skill);
  registerSkillDiffCommands(skill);
}

// ============================================================================
// Re-exports for backward API compatibility
// AC: @skill-module-split ac-3
// ============================================================================

// From skill-render.ts (via existing re-exports)
export {
  isKspecManagedSkill as isKspecManaged,
  KSPEC_MANAGED_MARKER,
  renderClaudeCodeSkill,
} from "../../parser/skill-render.js";

// From skill-diff.ts
export {
  getExpectedRenderedContent,
  generateUnifiedDiff,
} from "./skill-diff.js";

// From skill-install.ts
export {
  loadCoreSkillsManifest,
  loadCoreSkillContent,
  copyCoreSkillFiles,
  getKspecPackageVersion,
} from "./skill-install.js";
