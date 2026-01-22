import * as fs from "node:fs/promises";
import * as path from "node:path";
import yaml from "yaml";

/**
 * Skill file validation
 * Validates .claude/skills/SKILL.md files in subdirectories
 */

export interface SkillFrontmatter {
  name: string;
  description: string;
}

export interface SkillValidationError {
  file: string;
  line?: number;
  type:
    | "missing-frontmatter"
    | "invalid-frontmatter"
    | "missing-name"
    | "missing-description"
    | "empty-content"
    | "unescaped-pipe";
  message: string;
}

export interface SkillValidationResult {
  valid: boolean;
  errors: SkillValidationError[];
  filesChecked: number;
}

/**
 * Find all SKILL.md files in .claude/skills/
 */
export async function findSkillFiles(baseDir: string): Promise<string[]> {
  const skillsDir = path.join(baseDir, ".claude", "skills");

  try {
    await fs.access(skillsDir);
  } catch {
    return []; // .claude/skills doesn't exist
  }

  const entries = await fs.readdir(skillsDir, { withFileTypes: true });
  const skillFiles: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const skillFile = path.join(skillsDir, entry.name, "SKILL.md");
      try {
        await fs.access(skillFile);
        skillFiles.push(skillFile);
      } catch {
        // SKILL.md doesn't exist in this directory, skip
      }
    }
  }

  return skillFiles;
}

/**
 * Parse frontmatter from markdown file
 */
function parseFrontmatter(content: string): {
  frontmatter: SkillFrontmatter | null;
  errors: SkillValidationError[];
} {
  const errors: SkillValidationError[] = [];

  // Check for frontmatter delimiters
  if (!content.startsWith("---\n")) {
    return { frontmatter: null, errors };
  }

  const endDelimiter = content.indexOf("\n---\n", 4);
  if (endDelimiter === -1) {
    return { frontmatter: null, errors };
  }

  const frontmatterContent = content.slice(4, endDelimiter);

  try {
    const parsed = yaml.parse(frontmatterContent);
    return { frontmatter: parsed as SkillFrontmatter, errors };
  } catch (err) {
    return { frontmatter: null, errors };
  }
}

/**
 * Check for unescaped pipes in table rows
 * Tables should have pipes escaped when they appear in content
 */
function checkTablePipes(
  content: string,
  file: string,
): SkillValidationError[] {
  const errors: SkillValidationError[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Check if this looks like a table row (starts and ends with |)
    if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) {
      continue;
    }

    // Skip separator rows (only contains |, -, :, and whitespace)
    if (/^[\s|:\-]+$/.test(trimmed)) {
      continue;
    }

    // Check for unescaped pipes in cell content
    // Remove leading/trailing pipes and split
    const cells = trimmed
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim());

    // Check each cell for suspicious content that might indicate unescaped pipes
    for (const cell of cells) {
      // If a cell is empty and surrounded by non-empty cells, might be an unescaped pipe issue
      // This is a heuristic - it's hard to detect perfectly without parsing the table structure
      if (cell.length === 0) {
        // Check if there are many empty cells in this row
        const emptyCells = cells.filter((c) => c.length === 0).length;
        if (emptyCells > 1 && cells.length > 4) {
          errors.push({
            file,
            line: i + 1,
            type: "unescaped-pipe",
            message: `Possible unescaped pipe in table row (multiple empty cells detected)`,
          });
          break;
        }
      }
    }
  }

  return errors;
}

/**
 * Validate a single skill file
 */
export async function validateSkillFile(
  filePath: string,
): Promise<SkillValidationError[]> {
  const errors: SkillValidationError[] = [];
  const relativePath = filePath.includes(".claude/skills/")
    ? filePath.split(".claude/skills/")[1]
    : path.basename(filePath);

  try {
    const content = await fs.readFile(filePath, "utf-8");

    if (content.trim().length === 0) {
      errors.push({
        file: relativePath,
        type: "empty-content",
        message: "Skill file is empty",
      });
      return errors;
    }

    // Parse and validate frontmatter
    const { frontmatter, errors: fmErrors } = parseFrontmatter(content);
    errors.push(...fmErrors.map((e) => ({ ...e, file: relativePath })));

    // Check if frontmatter exists at all
    const hasFrontmatterDelimiters = content.startsWith("---\n");

    if (!hasFrontmatterDelimiters) {
      errors.push({
        file: relativePath,
        type: "missing-frontmatter",
        message: "Skill file must start with YAML frontmatter (---)",
      });
      return errors;
    }

    // Check required fields (frontmatter might be null if empty YAML)
    if (!frontmatter || !frontmatter.name || frontmatter.name.trim().length === 0) {
      errors.push({
        file: relativePath,
        type: "missing-name",
        message: "Frontmatter must include 'name' field",
      });
    }

    if (
      !frontmatter ||
      !frontmatter.description ||
      frontmatter.description.trim().length === 0
    ) {
      errors.push({
        file: relativePath,
        type: "missing-description",
        message: "Frontmatter must include 'description' field",
      });
    }

    // Check for table pipe issues
    const pipeErrors = checkTablePipes(content, relativePath);
    errors.push(...pipeErrors);
  } catch (err) {
    errors.push({
      file: relativePath,
      type: "invalid-frontmatter",
      message: `Failed to read or parse file: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  return errors;
}

/**
 * Validate all skill files
 */
export async function validateSkills(
  baseDir: string,
): Promise<SkillValidationResult> {
  const skillFiles = await findSkillFiles(baseDir);
  const allErrors: SkillValidationError[] = [];

  for (const file of skillFiles) {
    const errors = await validateSkillFile(file);
    allErrors.push(...errors);
  }

  return {
    valid: allErrors.length === 0,
    errors: allErrors,
    filesChecked: skillFiles.length,
  };
}
