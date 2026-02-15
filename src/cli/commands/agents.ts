/**
 * Agent instruction generation commands.
 *
 * AC: @agent-instruction-gen ac-1 - kspec agents generate creates kspec-agents.md in project root
 * AC: @agent-instruction-gen ac-2 - output includes Finding Information table with row per skill
 * AC: @agent-instruction-gen ac-3 - output includes conventions section listing rules by domain
 * AC: @agent-instruction-gen ac-4 - output contains freshness comment with kspec version and timestamp
 * AC: @agent-instruction-gen ac-5 - kspec agents status reports stale when not regenerated after meta changes
 *
 * AC: @agents-cli ac-1 - kspec agents generate writes kspec-agents.md to project root
 * AC: @agents-cli ac-2 - kspec agents generate --dry-run prints content without writing
 * AC: @agents-cli ac-3 - kspec agents status reports up to date when current
 * AC: @agents-cli ac-4 - kspec agents status reports stale when meta changed
 *
 * AC: @agent-templates ac-1 - template sections included in output in defined order
 * AC: @agent-templates ac-2 - each template section appears in generated output
 * AC: @agent-templates ac-3 - error if template directory missing or empty
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import type { Command } from "commander";
import {
  generateConventionsSummary,
  generateSkillsTable,
  generateWorkflowsSummary,
  initContext,
  loadMetaContext,
  type LoadedConvention,
  type LoadedSkill,
  type LoadedWorkflow,
} from "../../parser/index.js";
import { errors } from "../../strings/errors.js";
import { EXIT_CODES } from "../exit-codes.js";
import { error, output, success } from "../output.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read version from package.json at runtime
const require = createRequire(import.meta.url);
const { version } = require("../../../package.json");

/**
 * File name for generated agent instructions
 */
const GENERATED_FILE_NAME = "kspec-agents.md";

/**
 * Hash file name for tracking freshness
 */
const HASH_FILE_NAME = ".kspec-agents-hash";

/**
 * Templates directory name relative to package root
 */
const TEMPLATES_DIR = "templates/agents-sections";

/**
 * Expected template files in order
 * AC: @agent-templates ac-2 - template files for quick-start, shadow-branch, task-lifecycle, pr-workflow, commit-convention, ralph-loop
 */
const EXPECTED_TEMPLATES = [
  "01-quick-start.md",
  "02-shadow-branch.md",
  "03-task-lifecycle.md",
  "04-pr-workflow.md",
  "05-commit-convention.md",
  "06-ralph-loop.md",
];

/**
 * Compute SHA256 hash of content
 */
function computeHash(content: string): string {
  return crypto.createHash("sha256").update(content, "utf-8").digest("hex");
}

/**
 * Load template sections from the templates directory.
 * AC: @agent-templates ac-1 - all template sections included in defined order
 * AC: @agent-templates ac-3 - error if directory missing or empty
 */
async function loadTemplateSections(packageRoot: string): Promise<string[]> {
  const templatesPath = path.join(packageRoot, TEMPLATES_DIR);

  // Check if templates directory exists
  try {
    await fs.access(templatesPath);
  } catch {
    throw new Error(
      `Templates directory not found at: ${templatesPath}. ` +
        `Expected templates/agents-sections/ directory with section markdown files.`,
    );
  }

  // Read directory contents
  const entries = await fs.readdir(templatesPath, { withFileTypes: true });
  const mdFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => e.name)
    .sort(); // Sort to ensure consistent ordering by filename prefix

  if (mdFiles.length === 0) {
    throw new Error(
      `Templates directory is empty: ${templatesPath}. ` +
        `Expected markdown files for agent instruction sections.`,
    );
  }

  // Load each template in order
  const sections: string[] = [];
  for (const filename of mdFiles) {
    const filePath = path.join(templatesPath, filename);
    const content = await fs.readFile(filePath, "utf-8");
    sections.push(content.trim());
  }

  return sections;
}

/**
 * Get the package root directory (where templates/ is located)
 */
function getPackageRoot(): string {
  // Navigate from dist/cli/commands/ to package root
  return path.resolve(__dirname, "..", "..", "..");
}

/**
 * Generate a hash of the meta content that affects the generated file.
 * This is used to detect if the generated file is stale.
 */
function computeMetaHash(
  skills: LoadedSkill[],
  conventions: LoadedConvention[],
  workflows: LoadedWorkflow[],
): string {
  // Create a stable representation of the meta content
  const data = {
    skills: skills.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
    })),
    conventions: conventions.map((c) => ({
      domain: c.domain,
      rules: c.rules,
    })),
    workflows: workflows.map((w) => ({
      id: w.id,
      trigger: w.trigger,
      description: w.description,
    })),
  };
  return computeHash(JSON.stringify(data));
}

/**
 * Generate the freshness comment.
 * AC: @agent-instruction-gen ac-4 - freshness comment with kspec version and timestamp
 */
function generateFreshnessComment(timestamp: string): string {
  return `<!-- Generated by kspec v${version} at ${timestamp} -->\n<!-- Do not edit manually - regenerate with: kspec agents generate -->\n\n`;
}

/**
 * Generate the full kspec-agents.md content
 * AC: @agent-templates ac-1 - template sections included in output in defined order
 * AC: @agent-templates ac-2 - each template section appears in generated output
 */
async function generateAgentsContent(
  skills: LoadedSkill[],
  conventions: LoadedConvention[],
  workflows: LoadedWorkflow[],
  timestamp: string,
  templateSections: string[],
): Promise<string> {
  const sections: string[] = [];

  // AC: @agent-instruction-gen ac-4 - freshness comment
  sections.push(generateFreshnessComment(timestamp));

  // Header
  sections.push("# kspec Agent Instructions\n");
  sections.push(
    "This file is auto-generated from kspec meta. Include it in your AGENTS.md or similar agent instruction file.\n\n",
  );

  // AC: @agent-instruction-gen ac-2 - Skills table
  const skillsTable = generateSkillsTable(skills);
  if (skillsTable) {
    sections.push(skillsTable);
  }

  // AC: @agent-instruction-gen ac-3 - Conventions section
  const conventionsSection = generateConventionsSummary(conventions);
  if (conventionsSection) {
    sections.push(conventionsSection);
  }

  // Workflows summary
  const workflowsSection = generateWorkflowsSummary(workflows);
  if (workflowsSection) {
    sections.push(workflowsSection);
  }

  // AC: @agent-templates ac-1, ac-2 - Include template sections in order
  if (templateSections.length > 0) {
    sections.push("\n");
    for (const section of templateSections) {
      sections.push(section);
      sections.push("\n\n");
    }
  }

  return sections.join("");
}

/**
 * Result of checking agent file status
 */
interface AgentStatusResult {
  exists: boolean;
  path: string;
  status: "current" | "stale" | "missing";
  metaHash?: string;
  storedHash?: string;
  generatedAt?: string;
}

/**
 * Check the status of the generated agent file.
 * AC: @agent-instruction-gen ac-5 - reports stale when meta has changed
 */
async function checkAgentStatus(
  projectRoot: string,
  metaHash: string,
): Promise<AgentStatusResult> {
  const filePath = path.join(projectRoot, GENERATED_FILE_NAME);
  const hashPath = path.join(projectRoot, ".kspec", HASH_FILE_NAME);

  // Check if file exists
  try {
    await fs.access(filePath);
  } catch {
    return {
      exists: false,
      path: filePath,
      status: "missing",
      metaHash,
    };
  }

  // Check stored hash
  let storedHash: string | undefined;
  let generatedAt: string | undefined;

  try {
    const hashContent = await fs.readFile(hashPath, "utf-8");
    const hashData = JSON.parse(hashContent);
    storedHash = hashData.metaHash;
    generatedAt = hashData.generatedAt;
  } catch {
    // No hash file, treat as stale
    return {
      exists: true,
      path: filePath,
      status: "stale",
      metaHash,
    };
  }

  // Compare hashes
  const isCurrent = storedHash === metaHash;

  return {
    exists: true,
    path: filePath,
    status: isCurrent ? "current" : "stale",
    metaHash,
    storedHash,
    generatedAt,
  };
}

/**
 * Register agent instruction generation commands
 */
export function registerAgentsCommands(program: Command): void {
  const agents = program
    .command("agents")
    .description("Agent instruction generation commands");

  // AC: @agent-instruction-gen ac-1 - kspec agents generate
  // AC: @agent-templates ac-3 - error if template directory missing
  // AC: @trait-dry-run ac-1 through ac-6 - dry-run support
  agents
    .command("generate")
    .description("Generate kspec-agents.md from meta (skills, conventions, workflows)")
    .option("--dry-run", "Show what would be generated without writing files")
    .action(async (options) => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error(errors.project.noKspecProject);
          process.exit(EXIT_CODES.ERROR);
        }

        // AC: @agent-templates ac-3 - error if templates missing
        const packageRoot = getPackageRoot();
        let templateSections: string[];
        try {
          templateSections = await loadTemplateSections(packageRoot);
        } catch (err) {
          const message =
            err instanceof Error ? err.message : "Unknown error loading templates";
          error(message, {
            suggestion: `Verify that ${TEMPLATES_DIR}/ exists with markdown files.`,
          });
          process.exit(EXIT_CODES.ERROR);
        }

        const metaCtx = await loadMetaContext(ctx);
        const dryRun = options.dryRun || false;
        const timestamp = new Date().toISOString();

        // Generate content - now async due to template loading
        const content = await generateAgentsContent(
          metaCtx.skills,
          metaCtx.conventions,
          metaCtx.workflows,
          timestamp,
          templateSections,
        );

        // Compute meta hash for freshness tracking
        // Include template count to detect template changes
        const metaHash = computeMetaHash(
          metaCtx.skills,
          metaCtx.conventions,
          metaCtx.workflows,
        );

        const outputPath = path.join(ctx.rootDir, GENERATED_FILE_NAME);
        const hashPath = path.join(ctx.rootDir, ".kspec", HASH_FILE_NAME);

        // AC: @trait-dry-run ac-3 - clear indication this is a preview
        if (dryRun) {
          output(
            {
              dry_run: true,
              path: outputPath,
              skills: metaCtx.skills.length,
              conventions: metaCtx.conventions.length,
              workflows: metaCtx.workflows.length,
              templates: templateSections.length,
              content,
            },
            () => {
              console.log(chalk.yellow("DRY RUN - No changes made"));
              console.log();
              console.log(chalk.gray(`Would write to: ${outputPath}`));
              console.log();
              console.log(chalk.gray("--- Generated content ---"));
              console.log(content);
              console.log(chalk.gray("--- End content ---"));
              console.log();
              console.log(
                chalk.yellow("No changes were made. Run without --dry-run to apply."),
              );
            },
          );
          return;
        }

        // AC: @trait-dry-run ac-2 - no files modified in dry run mode
        // Write the generated file
        await fs.writeFile(outputPath, content, "utf-8");

        // Write the hash file for freshness tracking
        await fs.mkdir(path.dirname(hashPath), { recursive: true });
        await fs.writeFile(
          hashPath,
          JSON.stringify(
            {
              metaHash,
              generatedAt: timestamp,
              version,
            },
            null,
            2,
          ),
          "utf-8",
        );

        output(
          {
            path: outputPath,
            skills: metaCtx.skills.length,
            conventions: metaCtx.conventions.length,
            workflows: metaCtx.workflows.length,
            templates: templateSections.length,
            generatedAt: timestamp,
          },
          () => {
            success(`Generated ${GENERATED_FILE_NAME}`, {
              skills: metaCtx.skills.length,
              conventions: metaCtx.conventions.length,
              workflows: metaCtx.workflows.length,
              templates: templateSections.length,
            });
            console.log(chalk.gray(`  Path: ${outputPath}`));
          },
        );
      } catch (err) {
        error("Failed to generate agent instructions", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // AC: @agent-instruction-gen ac-5 - kspec agents status
  agents
    .command("status")
    .description("Check if kspec-agents.md is up to date with meta")
    .action(async () => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error(errors.project.noKspecProject);
          process.exit(EXIT_CODES.ERROR);
        }

        const metaCtx = await loadMetaContext(ctx);

        // Compute current meta hash
        const metaHash = computeMetaHash(
          metaCtx.skills,
          metaCtx.conventions,
          metaCtx.workflows,
        );

        const status = await checkAgentStatus(ctx.rootDir, metaHash);

        output(status, () => {
          switch (status.status) {
            case "missing":
              console.log(chalk.yellow(`${GENERATED_FILE_NAME} does not exist`));
              console.log();
              console.log(
                chalk.gray("Run 'kspec agents generate' to create it."),
              );
              break;

            case "stale":
              console.log(
                chalk.yellow(`${GENERATED_FILE_NAME} is stale`),
              );
              console.log();
              console.log(
                chalk.gray(
                  "Meta has changed since the file was generated.",
                ),
              );
              console.log(
                chalk.gray("Run 'kspec agents generate' to regenerate."),
              );
              break;

            case "current":
              console.log(chalk.green(`${GENERATED_FILE_NAME} is up to date`));
              if (status.generatedAt) {
                console.log(chalk.gray(`  Generated: ${status.generatedAt}`));
              }
              break;
          }
        });
      } catch (err) {
        error("Failed to check agent status", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });
}
