/**
 * Plan document parser for structured plan files.
 *
 * Parses markdown documents with embedded YAML blocks defining specs and tasks.
 * Supports topological ordering, error recovery, and dry-run mode.
 *
 * AC: @plan-import ac-11 - Parse ## Specs YAML blocks
 * AC: @plan-import ac-12 - Support derive_from_specs flag
 * AC: @plan-import ac-13 - Extract ## Implementation Notes
 */

import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { AcceptanceCriterionSchema } from "../schema/spec.js";
import { ItemTypeSchema } from "../schema/common.js";

/**
 * Spec definition from plan document
 */
export const PlanSpecSchema = z.object({
  title: z.string(),
  slug: z.string().optional(),
  type: ItemTypeSchema.optional(),
  parent: z.string().optional(),
  description: z.string().optional(),
  priority: z.number().int().min(1).max(5).optional(),
  acceptance_criteria: z.array(AcceptanceCriterionSchema).optional(),
  traits: z.array(z.string()).optional(),
  depends_on: z.array(z.string()).optional(),
  implementation_notes: z.string().min(1).optional(),
});

export type PlanSpec = z.infer<typeof PlanSpecSchema>;

/**
 * Manual task definition from plan document
 */
export const PlanTaskSchema = z.object({
  title: z.string(),
  slug: z.string().optional(),
  priority: z.number().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  spec_ref: z.string().optional(),
  depends_on: z.array(z.string()).optional(),
});

export type PlanTask = z.infer<typeof PlanTaskSchema>;

/**
 * Tasks section configuration
 */
export const TasksSectionSchema = z.object({
  derive_from_specs: z.boolean().optional(),
  additional_tasks: z.array(PlanTaskSchema).optional(),
});

export type TasksSection = z.infer<typeof TasksSectionSchema>;

/**
 * Parsed plan document structure
 */
export interface ParsedPlanDocument {
  title: string;
  content: string;
  specs: PlanSpec[];
  tasks: TasksSection;
  implementationNotes: string | null;
  errors: ParseError[];
}

/**
 * Parse error with context
 */
export interface ParseError {
  type: "yaml" | "validation" | "dependency" | "circular";
  message: string;
  line?: number;
  specIndex?: number;
  spec?: PlanSpec;
}

/**
 * Parse a plan document from markdown text.
 *
 * AC: @plan-import ac-11 - Extract and parse ## Specs YAML blocks
 * AC: @plan-import ac-12 - Parse Tasks section for derive_from_specs
 * AC: @plan-import ac-13 - Extract ## Implementation Notes section
 * AC: @plan-import ac-21 - Report YAML parse errors with line numbers
 */
export function parsePlanDocument(content: string): ParsedPlanDocument {
  const errors: ParseError[] = [];

  // Extract title from first heading
  const titleMatch = content.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : "Untitled Plan";

  // Extract ## Specs section
  const specs = extractSpecsSection(content, errors);

  // Extract ## Tasks section
  const tasks = extractTasksSection(content, errors);

  // Extract ## Implementation Notes section
  const implementationNotes = extractImplementationNotes(content);

  return {
    title,
    content,
    specs,
    tasks,
    implementationNotes,
    errors,
  };
}

/**
 * Extract and parse the ## Specs section.
 *
 * AC: @plan-import ac-11 - Parse YAML array of spec definitions
 * AC: @plan-import ac-21 - Handle YAML parse errors
 * AC: @plan-import ac-22 - Validate required fields
 */
function extractSpecsSection(content: string, errors: ParseError[]): PlanSpec[] {
  // Find ## Specs section
  const specsMatch = content.match(/##\s+Specs\s*\n([\s\S]*?)(?=\n##\s+\w|$)/);

  if (!specsMatch) {
    return [];
  }

  const specsContent = specsMatch[1];

  // Extract YAML code block
  const yamlMatch = specsContent.match(/```(?:yaml)?\s*\n([\s\S]*?)\n```/);

  if (!yamlMatch) {
    errors.push({
      type: "validation",
      message:
        "Specs section found but contains no YAML code block. Wrap specs in ```yaml ... ```",
    });
    return [];
  }

  const yamlContent = yamlMatch[1];

  // Parse YAML
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlContent);
  } catch (err) {
    const yamlError = err instanceof Error ? err.message : String(err);
    const diagnostics = detectYamlUnsafeValues(yamlContent);

    if (diagnostics.length > 0) {
      const hints = diagnostics
        .map(d => `  Line ${d.line}: ${d.field} value contains unquoted colon: "${d.value}"`)
        .join("\n");
      errors.push({
        type: "yaml",
        message:
          `Malformed YAML in Specs section: ${yamlError}\n\n` +
          `Hint: Found YAML-unsafe values (unquoted colons in text):\n${hints}\n` +
          `Fix: Use YAML block scalars (|) for values containing colons:\n` +
          `  then: |\n    User sees error: Invalid input`,
      });
    } else {
      errors.push({
        type: "yaml",
        message: `Malformed YAML in Specs section: ${yamlError}`,
      });
    }
    return [];
  }

  // Validate array
  if (!Array.isArray(parsed)) {
    errors.push({
      type: "validation",
      message: "Specs section must contain a YAML array",
    });
    return [];
  }

  // Validate each spec
  const specs: PlanSpec[] = [];

  for (let i = 0; i < parsed.length; i++) {
    const spec = parsed[i];

    // Validate required title field
    if (!spec || typeof spec !== "object" || !("title" in spec)) {
      errors.push({
        type: "validation",
        message: `Spec at index ${i} missing required field: title`,
        specIndex: i,
      });
      continue;
    }

    // Validate against schema
    const result = PlanSpecSchema.safeParse(spec);
    if (!result.success) {
      errors.push({
        type: "validation",
        message: `Spec at index ${i} validation failed: ${result.error.message}`,
        specIndex: i,
      });
      continue;
    }

    specs.push(result.data);
  }

  return specs;
}

/**
 * Extract and parse the ## Tasks section.
 *
 * AC: @plan-import ac-12 - Parse derive_from_specs flag
 * AC: @plan-import ac-27 - Parse additional_tasks array
 */
function extractTasksSection(content: string, errors: ParseError[]): TasksSection {
  // Find ## Tasks section
  const tasksMatch = content.match(/##\s+Tasks\s*\n([\s\S]*?)(?=\n##\s+\w|$)/);

  if (!tasksMatch) {
    return {};
  }

  const tasksContent = tasksMatch[1].trim();

  // Check for derive_from_specs flag
  const deriveMatch = tasksContent.match(/^derive_from_specs:\s*(true|false)/m);
  const deriveFromSpecs = deriveMatch ? deriveMatch[1] === "true" : undefined;

  // Extract YAML code block for additional tasks
  const yamlMatch = tasksContent.match(/```(?:yaml)?\s*\n([\s\S]*?)\n```/);

  let additionalTasks: PlanTask[] | undefined;

  if (yamlMatch) {
    const yamlContent = yamlMatch[1];

    try {
      const parsed = parseYaml(yamlContent);

      if (Array.isArray(parsed)) {
        additionalTasks = [];
        for (let i = 0; i < parsed.length; i++) {
          const result = PlanTaskSchema.safeParse(parsed[i]);
          if (!result.success) {
            errors.push({
              type: "validation",
              message: `Task at index ${i} validation failed: ${result.error.message}`,
            });
            continue;
          }
          additionalTasks.push(result.data);
        }
      }
    } catch (err) {
      const yamlError = err instanceof Error ? err.message : String(err);
      const diagnostics = detectYamlUnsafeValues(yamlContent);

      if (diagnostics.length > 0) {
        const hints = diagnostics
          .map(d => `  Line ${d.line}: ${d.field} value contains unquoted colon: "${d.value}"`)
          .join("\n");
        errors.push({
          type: "yaml",
          message:
            `Malformed YAML in Tasks section: ${yamlError}\n\n` +
            `Hint: Found YAML-unsafe values (unquoted colons in text):\n${hints}\n` +
            `Fix: Use YAML block scalars (|) for values containing colons:\n` +
            `  then: |\n    User sees error: Invalid input`,
        });
      } else {
        errors.push({
          type: "yaml",
          message: `Malformed YAML in Tasks section: ${yamlError}`,
        });
      }
    }
  }

  return {
    derive_from_specs: deriveFromSpecs,
    additional_tasks: additionalTasks,
  };
}

/**
 * Extract ## Implementation Notes section.
 *
 * AC: @plan-import ac-13 - Extract implementation notes as plain text
 */
function extractImplementationNotes(content: string): string | null {
  const notesMatch = content.match(/##\s+Implementation\s+Notes\s*\n([\s\S]*?)(?=\n##\s+\w|$)/);

  if (!notesMatch) {
    return null;
  }

  return notesMatch[1].trim();
}

/**
 * Sort specs in topological order (parents before children).
 *
 * AC: @plan-import ac-16 - Create specs in dependency order
 * AC: @plan-import ac-18 - Detect circular dependencies
 *
 * @returns Sorted specs or null if circular dependency detected
 */
export function topologicalSort(
  specs: PlanSpec[],
): { sorted: PlanSpec[]; error: ParseError | null } {
  // Build adjacency list
  const graph = new Map<string, string[]>();
  const specBySlug = new Map<string, PlanSpec>();

  for (const spec of specs) {
    const slug = spec.slug || slugify(spec.title);
    if (specBySlug.has(slug)) {
      return {
        sorted: [],
        error: {
          type: "validation",
          message: `Duplicate slug detected: "${slug}". Ensure each spec has a unique slug or title.`,
        },
      };
    }
    specBySlug.set(slug, spec);
    graph.set(slug, []);
  }

  // Add edges for parent dependencies
  for (const spec of specs) {
    const slug = spec.slug || slugify(spec.title);
    if (spec.parent) {
      const parentRef = spec.parent.startsWith("@") ? spec.parent.slice(1) : spec.parent;

      // Only add edge if parent is in this plan (local reference)
      if (specBySlug.has(parentRef)) {
        const children = graph.get(parentRef) || [];
        children.push(slug);
        graph.set(parentRef, children);
      }
    }
  }

  // Detect cycles using DFS
  const visited = new Set<string>();
  const recursionStack = new Set<string>();

  function hasCycle(node: string, path: string[]): string[] | null {
    visited.add(node);
    recursionStack.add(node);

    const children = graph.get(node) || [];
    for (const child of children) {
      if (!visited.has(child)) {
        const cyclePath = hasCycle(child, [...path, child]);
        if (cyclePath) return cyclePath;
      } else if (recursionStack.has(child)) {
        return [...path, child];
      }
    }

    recursionStack.delete(node);
    return null;
  }

  for (const slug of graph.keys()) {
    if (!visited.has(slug)) {
      const cyclePath = hasCycle(slug, [slug]);
      if (cyclePath) {
        const cycleRefs = cyclePath.map(s => `@${s}`).join(" -> ");
        return {
          sorted: [],
          error: {
            type: "circular",
            message: `Circular parent reference: ${cycleRefs}`,
          },
        };
      }
    }
  }

  // Topological sort using DFS
  const sorted: PlanSpec[] = [];
  const processed = new Set<string>();

  function visit(node: string) {
    if (processed.has(node)) return;

    const spec = specBySlug.get(node);
    if (!spec) return;

    // Visit parent first if it's in this plan
    if (spec.parent) {
      const parentRef = spec.parent.startsWith("@") ? spec.parent.slice(1) : spec.parent;
      if (specBySlug.has(parentRef)) {
        visit(parentRef);
      }
    }

    processed.add(node);
    sorted.push(spec);
  }

  for (const slug of specBySlug.keys()) {
    visit(slug);
  }

  return { sorted, error: null };
}

/**
 * Simple slugification helper
 */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Validate parent references.
 *
 * AC: @plan-import ac-17 - Detect missing parent references
 * AC: @plan-import ac-33 - Provide recovery hints
 *
 * @param specs Specs to validate
 * @param existingRefs Set of existing spec refs in the project
 * @returns Errors for specs with invalid parents
 */
export function validateParentRefs(
  specs: PlanSpec[],
  existingRefs: Set<string>,
): ParseError[] {
  const errors: ParseError[] = [];
  const planSlugs = new Set(
    specs.map(s => s.slug || slugify(s.title))
  );

  for (const spec of specs) {
    if (!spec.parent) continue;

    const parentRef = spec.parent.startsWith("@") ? spec.parent.slice(1) : spec.parent;

    // Check if parent exists in plan or project
    if (!planSlugs.has(parentRef) && !existingRefs.has(parentRef)) {
      errors.push({
        type: "dependency",
        message: `Parent ${spec.parent} not found. Check parent exists or define it earlier in plan`,
        spec,
      });
    }
  }

  return errors;
}

/**
 * Diagnostic for YAML-unsafe values in plan document YAML.
 *
 * Scans raw YAML text for unquoted values that contain colons (the most common
 * cause of "Nested mappings are not allowed in compact mappings" errors).
 * Used to enrich error messages when YAML parsing fails.
 *
 * Only flags lines where a known AC field (given, when, then, description, title)
 * has an unquoted value containing a subsequent colon.
 */
export interface YamlUnsafeDiagnostic {
  line: number;
  field: string;
  value: string;
}

/**
 * Detect YAML-unsafe values in raw YAML text.
 *
 * Looks for lines matching `key: value` where value contains an unquoted colon.
 * This pattern causes YAML to interpret the second colon as a nested mapping key.
 */
export function detectYamlUnsafeValues(yamlText: string): YamlUnsafeDiagnostic[] {
  const diagnostics: YamlUnsafeDiagnostic[] = [];
  const lines = yamlText.split("\n");

  // AC fields and other prose fields where colons commonly appear
  // Allow optional YAML list marker (- ) before field name
  const proseFields = /^\s*(?:-\s+)?(given|when|then|description|title|implementation_notes):\s+(.+)$/;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(proseFields);
    if (!match) continue;

    const field = match[1];
    const value = match[2];

    // Skip values that are already quoted or use block scalar indicators
    if (/^["']/.test(value) || /^\|/.test(value) || /^>/.test(value)) continue;

    // Check if value contains a colon followed by a space (YAML mapping indicator)
    if (/:\s/.test(value)) {
      diagnostics.push({
        line: i + 1,
        field,
        value: value.length > 60 ? value.slice(0, 57) + "..." : value,
      });
    }
  }

  return diagnostics;
}
