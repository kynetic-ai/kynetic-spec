import { AsyncLocalStorage } from "node:async_hooks";
import chalk from "chalk";
import { stringify as yamlStringify } from "yaml";
import type { ReferenceIndex } from "../parser/index.js";
import type { Note, Task, TaskStatus } from "../schema/index.js";
import { fieldLabels, sectionHeaders, summaries } from "../strings/labels.js";
import type { ActivityEntry } from "../utils/activity.js";
import { formatRelativeTime } from "../utils/time.js";
import { formatMatchedFields, grepItem } from "../utils/grep.js";

/**
 * Check if a note has been superseded by another note.
 * A note is superseded if its ULID appears in any other note's `supersedes` field.
 */
export function isNoteSuperseded(note: Note, allNotes: Note[]): boolean {
  return allNotes.some((n) => n.supersedes === note._ulid);
}

/**
 * Filter notes to exclude superseded ones.
 * Returns only notes that have not been superseded.
 */
export function filterSupersededNotes(notes: Note[]): Note[] {
  return notes.filter((note) => !isNoteSuperseded(note, notes));
}

/**
 * Annotate notes with superseded status for JSON output.
 * Adds a computed `superseded` field to each note.
 */
export function annotateNotesWithSuperseded(notes: Note[]): Array<Note & { superseded: boolean }> {
  return notes.map((note) => ({
    ...note,
    superseded: isNoteSuperseded(note, notes),
  }));
}

/**
 * Output options
 */
export interface OutputOptions {
  json?: boolean;
}

/**
 * Output format types
 * AC: @output-format-option
 */
export type OutputFormat = "text" | "json" | "yaml";

/**
 * Valid format values for --format option
 */
export const VALID_FORMATS = ["json", "yaml"] as const;

interface OutputRuntimeState {
  outputFormat: OutputFormat;
  verboseMode: boolean;
}

const outputRuntimeStorage = new AsyncLocalStorage<OutputRuntimeState>();

/**
 * Global output format (set by --json, --yaml, --raw, or --format flags)
 * AC: @output-format-option ac-format-json, ac-format-yaml
 */
let globalOutputFormat: OutputFormat = "text";

function getOutputRuntimeState(): OutputRuntimeState | undefined {
  return outputRuntimeStorage.getStore();
}

function updateOutputRuntimeState(update: Partial<OutputRuntimeState>): void {
  const runtimeState = getOutputRuntimeState();
  if (runtimeState) {
    Object.assign(runtimeState, update);
    return;
  }

  if (update.outputFormat !== undefined) {
    globalOutputFormat = update.outputFormat;
  }
  if (update.verboseMode !== undefined) {
    globalVerboseMode = update.verboseMode;
  }
}

export function runWithOutputState<T>(
  fn: () => T,
  initialState: Partial<OutputRuntimeState> = {},
): T {
  return outputRuntimeStorage.run(
    {
      outputFormat: initialState.outputFormat ?? "text",
      verboseMode: initialState.verboseMode ?? false,
    },
    fn,
  );
}

export function setOutputFormat(format: OutputFormat): void {
  updateOutputRuntimeState({ outputFormat: format });
}

export function getOutputFormat(): OutputFormat {
  return getOutputRuntimeState()?.outputFormat ?? globalOutputFormat;
}

/**
 * Set JSON mode (for backward compatibility)
 * AC: @output-format-option ac-json-shorthand
 */
export function setJsonMode(enabled: boolean): void {
  if (enabled) {
    updateOutputRuntimeState({ outputFormat: "json" });
  } else if (getOutputFormat() === "json") {
    updateOutputRuntimeState({ outputFormat: "text" });
  }
}

/**
 * Check if JSON mode is active
 * AC: @output-format-option ac-json-shorthand
 */
export function isJsonMode(): boolean {
  return getOutputFormat() === "json";
}

/**
 * Set YAML mode
 * AC: @output-format-option ac-format-yaml, ac-yaml-shorthand
 */
export function setYamlMode(enabled: boolean): void {
  if (enabled) {
    updateOutputRuntimeState({ outputFormat: "yaml" });
  } else if (getOutputFormat() === "yaml") {
    updateOutputRuntimeState({ outputFormat: "text" });
  }
}

/**
 * Check if YAML mode is active
 * AC: @output-format-option ac-format-yaml
 */
export function isYamlMode(): boolean {
  return getOutputFormat() === "yaml";
}

/**
 * Check if any structured output mode is active (JSON or YAML)
 * AC: @output-format-option ac-yaml-no-ansi, ac-yaml-references
 */
export function isStructuredMode(): boolean {
  const format = getOutputFormat();
  return format === "json" || format === "yaml";
}

/**
 * Global verbose mode (set by --verbose flag)
 */
let globalVerboseMode = false;

export function setVerboseMode(enabled: boolean): void {
  updateOutputRuntimeState({ verboseMode: enabled });
}

export function getVerboseMode(): boolean {
  return getOutputRuntimeState()?.verboseMode ?? globalVerboseMode;
}

/**
 * Output data - JSON/YAML if structured mode, otherwise formatted
 * AC: @output-format-option ac-format-json, ac-format-yaml
 */
export function output(data: unknown, formatter?: () => void): void {
  const format = getOutputFormat();
  if (format === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else if (format === "yaml") {
    console.log(yamlStringify(data, { indent: 2 }));
  } else if (formatter) {
    formatter();
  } else {
    console.log(data);
  }
}

/**
 * Output success message
 * AC: @output-format-option ac-format-json, ac-format-yaml
 */
export function success(message: string, data?: Record<string, unknown>): void {
  const format = getOutputFormat();
  if (format === "json") {
    console.log(JSON.stringify({ success: true, message, ...data }));
  } else if (format === "yaml") {
    console.log(yamlStringify({ success: true, message, ...data }, { indent: 2 }));
  } else {
    console.log(chalk.green("OK"), message);
  }
}

/**
 * Render a `details` value for text-mode error output.
 *
 * Returns the textual portion to print under the main error line. Plain
 * structured objects (e.g. `{ message, suggestion }`) surface their `message`
 * field so the caller's underlying failure text is preserved instead of
 * collapsing to `[object Object]`. Returns `null` when there is nothing
 * meaningful to render so the caller can suppress the secondary line entirely.
 */
function formatErrorDetailsForText(details: unknown): string | null {
  if (details === null || details === undefined) return null;
  if (typeof details === "string") return details;
  if (details instanceof Error) return String(details);
  if (typeof details === "object") {
    const message = (details as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
    return null;
  }
  return String(details);
}

/**
 * Output error message
 * AC: @output-format-option ac-format-json, ac-format-yaml
 */
export function error(message: string, details?: unknown): void {
  const format = getOutputFormat();
  if (format === "json") {
    console.error(JSON.stringify({ success: false, error: message, details }));
  } else if (format === "yaml") {
    console.error(yamlStringify({ success: false, error: message, details }, { indent: 2 }));
  } else {
    console.error(chalk.red("✗"), message);
    if (details) {
      const detailText = formatErrorDetailsForText(details);
      if (detailText !== null) {
        console.error(chalk.gray(detailText));
      }
      // Show suggestion if it's a ShadowError with a suggestion
      if (typeof details === "object" && "suggestion" in details) {
        const suggestion = (details as { suggestion?: string }).suggestion;
        if (suggestion) {
          console.error(chalk.yellow("  Suggestion:"), suggestion);
        }
      }
    }
  }
}

/**
 * Output warning message
 * AC: @output-format-option ac-yaml-no-ansi
 */
export function warn(message: string): void {
  if (isStructuredMode()) {
    // Route warnings to stderr in structured output modes to keep stdout pure
    console.error(chalk.yellow("⚠"), message);
  } else {
    console.warn(chalk.yellow("⚠"), message);
  }
}

/**
 * Output info message
 * AC: @output-format-option ac-yaml-no-ansi
 */
export function info(message: string): void {
  if (isStructuredMode()) {
    // Route info to stderr in structured output modes to keep stdout pure
    console.error(chalk.blue("ℹ"), message);
  } else {
    console.log(chalk.blue("ℹ"), message);
  }
}

/**
 * Format a value for before→after display.
 * Handles arrays, objects, null/undefined, and scalars.
 */
export function formatChangeValue(v: unknown): string {
  if (v === undefined || v === null) return chalk.gray("(none)");
  if (Array.isArray(v)) return v.length === 0 ? chalk.gray("[]") : v.join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/**
 * Display before→after diff for changed fields in text mode.
 * Skips display in JSON/YAML mode (structured output includes changes in data).
 */
export function showChangeDiff(
  changes: Array<{ field: string; before: unknown; after: unknown }>,
): void {
  if (isStructuredMode()) return;
  for (const change of changes) {
    console.log(
      `  ${chalk.gray(`${change.field}:`)} ${chalk.red(formatChangeValue(change.before))} → ${chalk.green(formatChangeValue(change.after))}`,
    );
  }
}

/**
 * Get color for task status
 */
function statusColor(status: TaskStatus): (text: string) => string {
  switch (status) {
    case "pending":
      return (t: string) => chalk.gray(t);
    case "in_progress":
      return (t: string) => chalk.blue(t);
    case "blocked":
      return (t: string) => chalk.red(t);
    case "completed":
      return (t: string) => chalk.green(t);
    case "cancelled":
      return (t: string) => chalk.strikethrough.gray(t);
    default:
      return (t: string) => chalk.white(t);
  }
}

/**
 * Format a task reference (short ULID + slug if available)
 * @param task The task to format
 * @param index Optional ReferenceIndex for dynamic short ULID computation
 */
export function formatTaskRef(task: Task, index?: ReferenceIndex): string {
  const shortId = index ? index.shortUlid(task._ulid) : task._ulid;
  if (task.slugs.length > 0) {
    return `${shortId} (${task.slugs[0]})`;
  }
  return shortId;
}

/**
 * Format task for display
 */
export function formatTask(
  task: Task,
  verbose = false,
  index?: ReferenceIndex,
  full = false,
): string {
  const ref = formatTaskRef(task, index);
  const status = statusColor(task.status)(`[${task.status}]`);
  const priority =
    task.priority <= 2 ? chalk.red(`P${task.priority}`) : chalk.gray(`P${task.priority}`);

  // AC: @session-scoped-task-claiming ac-display
  const sessionLabel = task.session_id
    ? chalk.yellow(`[session ${task.session_id.slice(0, 8)}...]`)
    : "";

  let line = `${ref} ${status} ${priority}${sessionLabel ? ` ${sessionLabel}` : ""} ${task.title}`;

  if (verbose && !full) {
    // AC: @task-list-verbose ac-2 - Single verbose (-v) shows current behavior
    if (task.spec_ref) {
      line += chalk.gray(` (spec: ${task.spec_ref})`);
    }
    if (task.depends_on.length > 0) {
      line += chalk.gray(` deps: [${task.depends_on.join(", ")}]`);
    }
    if (task.tags.length > 0) {
      line += chalk.cyan(` #${task.tags.join(" #")}`);
    }
  }

  return line;
}

/**
 * Get first line of text, truncated to max length
 */
function getFirstLine(text: string | undefined, maxLength: number = 70): string | undefined {
  if (!text) return undefined;
  const firstLine = text.split("\n")[0].trim();
  if (firstLine.length <= maxLength) return firstLine;
  return `${firstLine.slice(0, maxLength - 3)}...`;
}

/**
 * Format full mode context for a task (AC-1, AC-3, AC-5)
 */
function formatFullModeContext(task: Task, index?: ReferenceIndex): void {
  const indent = "    ";

  // Show timestamps (AC-1)
  console.log(chalk.gray(`${indent}Created: ${task.created_at}`));
  if (task.started_at) {
    console.log(chalk.gray(`${indent}Started: ${task.started_at}`));
  }
  if (task.completed_at) {
    console.log(chalk.gray(`${indent}Completed: ${task.completed_at}`));
  }

  // Show notes count and most recent note (AC-1, AC-3)
  if (task.notes && task.notes.length > 0) {
    const mostRecent = task.notes[task.notes.length - 1];
    const preview = getFirstLine(mostRecent.content, 50);
    console.log(chalk.gray(`${indent}Notes: ${task.notes.length} (latest: "${preview}")`));
  }

  // Show pending todos count (AC-1, AC-3)
  if (task.todos && task.todos.length > 0) {
    const pendingCount = task.todos.filter((t) => !t.done).length;
    if (pendingCount > 0) {
      console.log(chalk.gray(`${indent}Pending todos: ${pendingCount}`));
    }
  }

  // Show spec context (AC-5)
  if (task.spec_ref && index) {
    const result = index.resolve(task.spec_ref);
    if (result.ok) {
      const spec = result.item;
      const specName =
        "title" in spec
          ? spec.title
          : "name" in spec
            ? spec.name
            : "id" in spec
              ? spec.id
              : task.spec_ref;
      console.log(chalk.gray(`${indent}Spec: ${task.spec_ref}`));
      console.log(chalk.cyan(`${indent}  ${specName}`));

      // Show spec description if available
      if ("description" in spec && spec.description) {
        const descPreview = getFirstLine(spec.description as string, 70);
        console.log(chalk.gray(`${indent}  ${descPreview}`));
      }

      // Show acceptance criteria if available
      if ("acceptance_criteria" in spec && Array.isArray(spec.acceptance_criteria)) {
        const ac = spec.acceptance_criteria;
        if (ac.length > 0) {
          console.log(chalk.gray(`${indent}  Acceptance Criteria: ${ac.length}`));
          // Show first AC as preview
          const firstAC = ac[0];
          if (typeof firstAC === "object" && firstAC !== null && "id" in firstAC) {
            console.log(chalk.gray(`${indent}    [${firstAC.id}] ${firstAC.then}`));
          }
        }
      }
    }
  }

  // Show tags and dependencies if present
  if (task.tags && task.tags.length > 0) {
    console.log(chalk.gray(`${indent}Tags: ${task.tags.join(", ")}`));
  }
  if (task.depends_on && task.depends_on.length > 0) {
    console.log(chalk.gray(`${indent}Depends on: ${task.depends_on.join(", ")}`));
  }
}

/**
 * Format automation status as a colored label
 * AC: @task-automation-eligibility ac-14
 */
function formatAutomationStatus(automation: string | undefined): string {
  if (!automation) {
    return chalk.gray("[unassessed]");
  }
  switch (automation) {
    case "eligible":
      return chalk.green("[eligible]");
    case "needs_review":
      return chalk.yellow("[needs_review]");
    case "manual_only":
      return chalk.red("[manual_only]");
    default:
      return chalk.gray(`[${automation}]`);
  }
}

/**
 * Format a list of tasks with automation status
 * AC: @task-automation-eligibility ac-14
 */
export function formatTaskListWithAutomation(
  tasks: Task[],
  verbose = false,
  index?: ReferenceIndex,
  grepPattern?: string,
  full = false,
): void {
  if (tasks.length === 0) {
    console.log(summaries.noTasks);
    return;
  }

  for (const task of tasks) {
    const ref = formatTaskRef(task, index);
    const status = statusColor(task.status)(`[${task.status}]`);
    const priority =
      task.priority <= 2 ? chalk.red(`P${task.priority}`) : chalk.gray(`P${task.priority}`);
    const automationLabel = formatAutomationStatus(task.automation);
    // AC: @session-scoped-task-claiming ac-display
    const sessionLabel = task.session_id
      ? chalk.yellow(`[session ${task.session_id.slice(0, 8)}...]`)
      : "";

    let line = `${ref} ${status} ${priority} ${automationLabel}${sessionLabel ? ` ${sessionLabel}` : ""} ${task.title}`;

    if (verbose && !full) {
      if (task.spec_ref) {
        line += chalk.gray(` (spec: ${task.spec_ref})`);
      }
      if (task.depends_on.length > 0) {
        line += chalk.gray(` deps: [${task.depends_on.join(", ")}]`);
      }
      if (task.tags.length > 0) {
        line += chalk.cyan(` #${task.tags.join(" #")}`);
      }
    }

    console.log(line);

    // Show matched fields if grep pattern provided
    if (grepPattern) {
      const match = grepItem(task as unknown as Record<string, unknown>, grepPattern);
      if (match && match.matchedFields.length > 0) {
        console.log(chalk.gray(`    matched: ${formatMatchedFields(match.matchedFields)}`));
      }
    } else if (full) {
      formatFullModeContext(task, index);
    } else {
      // Show context line: first line of description (if present)
      const context = getFirstLine(task.description);
      if (context) {
        console.log(chalk.gray(`    ${context}`));
      }
    }
  }

  console.log(summaries.taskCount(tasks.length));
}

/**
 * Format a list of tasks
 */
export function formatTaskList(
  tasks: Task[],
  verbose = false,
  index?: ReferenceIndex,
  grepPattern?: string,
  full = false,
): void {
  if (tasks.length === 0) {
    console.log(summaries.noTasks);
    return;
  }

  for (const task of tasks) {
    console.log(formatTask(task, verbose, index, full));

    // Show matched fields if grep pattern provided
    if (grepPattern) {
      const match = grepItem(task as unknown as Record<string, unknown>, grepPattern);
      if (match && match.matchedFields.length > 0) {
        console.log(chalk.gray(`    matched: ${formatMatchedFields(match.matchedFields)}`));
      }
    } else if (full) {
      // AC: @task-list-verbose ac-1 - Full mode shows richer context
      formatFullModeContext(task, index);
    } else {
      // Show context line: first line of description (if present)
      const context = getFirstLine(task.description);
      if (context) {
        console.log(chalk.gray(`    ${context}`));
      }
    }
  }

  console.log(summaries.taskCount(tasks.length));
}

export interface FormatTaskDetailsOptions {
  /** Show all notes including superseded ones (default: false) */
  showAllNotes?: boolean;
  /** Resolved active review summary for display */
  activeReview?: {
    ref: string;
    title: string;
    lifecycle_state: string;
    disposition: string;
  } | null;
  /** Activity timeline entries to display */
  activity?: ActivityEntry[];
  /** Show full activity timeline (default: last 10 entries) */
  showFullActivity?: boolean;
  /**
   * Resolved task resource references with drift status for the Resources
   * section. Caller supplies them so the formatter never reaches into the
   * filesystem to load owning manifests.
   *
   * AC: @plan-resource-derivation-semantics-1 ac-resource-drift-is-visible
   */
  resourceRefs?: Array<{
    owner_type: "plan" | "task";
    owner_ref: string;
    id: string;
    path: string;
    status: "present" | "drift" | "missing" | "unresolved";
    recorded_sha256: string;
    current_sha256: string | null;
    message: string;
  }>;
}

/**
 * Format task details
 */
export function formatTaskDetails(
  task: Task,
  index?: ReferenceIndex,
  options: FormatTaskDetailsOptions = {},
): void {
  console.log(chalk.bold(task.title));
  console.log(chalk.gray("─".repeat(40)));
  console.log(`${fieldLabels.ulid}      ${task._ulid}`);
  if (task.slugs.length > 0) {
    console.log(`${fieldLabels.slugs}     ${task.slugs.join(", ")}`);
  }
  console.log(`${fieldLabels.type}      ${task.type}`);
  console.log(`${fieldLabels.status}    ${statusColor(task.status)(task.status)}`);
  console.log(`${fieldLabels.priority}  ${task.priority}`);

  // AC: @task-automation-eligibility ac-17 - show automation status
  const automationDisplay = task.automation || "unassessed";
  const automationColor =
    task.automation === "eligible"
      ? chalk.green
      : task.automation === "needs_review"
        ? chalk.yellow
        : task.automation === "manual_only"
          ? chalk.red
          : chalk.gray;
  console.log(`${fieldLabels.automation} ${automationColor(automationDisplay)}`);

  // AC: @session-scoped-task-claiming ac-display
  if (task.session_id) {
    console.log(`Session:   ${chalk.yellow(task.session_id)}`);
  }

  if (task.description?.trim()) {
    console.log(`\n${sectionHeaders.description}`);
    const desc = task.description.trim();
    for (const line of desc.split("\n")) {
      console.log(`  ${line}`);
    }
  }

  if (task.spec_ref) {
    console.log(`${fieldLabels.specRef}  ${task.spec_ref}`);
  }

  // AC: @plan-derive-enhanced ac-bidirectional-links - display plan_ref
  if (task.plan_ref) {
    console.log(`Plan ref:  ${task.plan_ref}`);
  }

  // AC: @review-task-lifecycle-integration ac-1 - display review_ref
  // AC: @review-cli-task-linkage ac-1 - display resolved review summary
  if (task.review_ref) {
    if (options.activeReview) {
      const r = options.activeReview;
      const stateColor =
        r.lifecycle_state === "open"
          ? chalk.green
          : r.lifecycle_state === "closed"
            ? chalk.red
            : chalk.gray;
      const dispColor =
        r.disposition === "approved"
          ? chalk.green
          : r.disposition === "changes_requested"
            ? chalk.red
            : chalk.yellow;
      console.log(
        `Review ref: ${task.review_ref} ${chalk.gray("→")} ${r.title} ${stateColor(`[${r.lifecycle_state}]`)} ${dispColor(`(${r.disposition})`)}`,
      );
    } else {
      console.log(`Review ref: ${task.review_ref}`);
    }
  }

  // AC: @task-submit ac-submit-2 - display review_url
  if (task.review_url) {
    console.log(`Review:    ${chalk.blue(task.review_url)}`);
  }

  // AC: @portable-task-submission-linkage ac-2 - display submission linkage
  if (task.submission_linkage) {
    const sl = task.submission_linkage;
    console.log(`\n${chalk.bold("─── Submission Linkage ───")}`);
    console.log(`  Branch:  ${sl.branch ? chalk.cyan(sl.branch) : chalk.yellow("(detached)")}`);
    console.log(`  Commit:  ${chalk.gray(sl.commit)}`);
    if (sl.remote) {
      console.log(`  Remote:  ${sl.remote}${sl.remote_url ? ` (${sl.remote_url})` : ""}`);
    }
    if (sl.upstream_ref) {
      console.log(`  Upstream: ${chalk.cyan(sl.upstream_ref)}`);
    }
    if (sl.review_url) {
      console.log(`  Review:  ${chalk.blue(sl.review_url)}`);
    }
    console.log(`  Captured: ${sl.captured_at}`);
  }

  if (task.depends_on.length > 0) {
    if (index) {
      console.log(fieldLabels.depends);
      for (const ref of task.depends_on) {
        const result = index.resolve(ref);
        if (result.ok) {
          const item = result.item;
          const status =
            "status" in item && typeof item.status === "string"
              ? statusColor(item.status as TaskStatus)(`[${item.status}]`)
              : chalk.gray("[spec]");
          // Handle both spec items (with title) and meta items (with name or id)
          const itemName =
            "title" in item
              ? item.title
              : "name" in item
                ? item.name
                : "id" in item
                  ? item.id
                  : ref;
          console.log(`  ${ref} ${chalk.gray("→")} ${itemName} ${status}`);
        } else {
          console.log(`  ${ref} ${chalk.red("(unresolved)")}`);
        }
      }
    } else {
      console.log(`${fieldLabels.depends}   ${task.depends_on.join(", ")}`);
    }
  }

  if (task.blocked_by.length > 0) {
    console.log(chalk.red(`${fieldLabels.blocked}   ${task.blocked_by.join(", ")}`));
  }

  if (task.tags.length > 0) {
    console.log(`${fieldLabels.tags}      ${task.tags.join(", ")}`);
  }

  console.log(`${fieldLabels.created}   ${task.created_at}`);
  if (task.started_at) {
    console.log(`${fieldLabels.started}   ${task.started_at}`);
  }
  if (task.completed_at) {
    console.log(`${fieldLabels.completed} ${task.completed_at}`);
  }

  // Resources section — drift status comes from the resolved refs the caller
  // computed against each owning entity's current manifest.
  // AC: @plan-resource-derivation-semantics-1 ac-derived-task-keeps-plan-resource-reference
  // AC: @plan-resource-derivation-semantics-1 ac-resource-drift-is-visible
  if (options.resourceRefs && options.resourceRefs.length > 0) {
    console.log(`\n${chalk.bold("─── Resources ───")}`);
    for (const entry of options.resourceRefs) {
      const statusLabel =
        entry.status === "present"
          ? chalk.green("OK")
          : entry.status === "drift"
            ? chalk.yellow("DRIFT")
            : entry.status === "missing"
              ? chalk.red("MISSING")
              : chalk.red("UNRESOLVED");
      console.log(
        `  [${statusLabel}] ${entry.id}  (${entry.owner_type} ${entry.owner_ref}, ${entry.path})`,
      );
      if (entry.status !== "present") {
        console.log(chalk.gray(`    ${entry.message}`));
      }
    }
  }

  // Show resolved spec information
  if (task.spec_ref && index) {
    const result = index.resolve(task.spec_ref);
    if (result.ok) {
      const spec = result.item;
      console.log(`\n${sectionHeaders.specContext}`);
      // Handle both spec items (with title) and meta items (with name)
      const specName =
        "title" in spec
          ? spec.title
          : "name" in spec
            ? spec.name
            : "id" in spec
              ? spec.id
              : task.spec_ref;
      console.log(chalk.cyan(specName));
      if ("type" in spec && spec.type) {
        console.log(chalk.gray(`${fieldLabels.type} ${spec.type}`));
      }
      // Show implementation status
      if ("status" in spec && spec.status && typeof spec.status === "object") {
        const status = spec.status as {
          maturity?: string;
          implementation?: string;
        };
        if (status.implementation) {
          const implColor =
            status.implementation === "verified"
              ? chalk.green
              : status.implementation === "implemented"
                ? chalk.cyan
                : status.implementation === "in_progress"
                  ? chalk.yellow
                  : chalk.gray;
          console.log(chalk.gray(fieldLabels.implementation) + implColor(status.implementation));
        }
      }
      if ("description" in spec && spec.description) {
        console.log(chalk.gray(fieldLabels.description));
        // Indent description lines
        const desc = String(spec.description).trim();
        for (const line of desc.split("\n")) {
          console.log(chalk.gray(`  ${line}`));
        }
      }
      if (
        "acceptance_criteria" in spec &&
        Array.isArray(spec.acceptance_criteria) &&
        spec.acceptance_criteria.length > 0
      ) {
        console.log(chalk.gray(fieldLabels.acceptanceCriteria));
        for (const ac of spec.acceptance_criteria) {
          if (ac && typeof ac === "object" && "id" in ac) {
            const acObj = ac as {
              id: string;
              given?: string;
              when?: string;
              then?: string;
            };
            console.log(chalk.gray(`  [${acObj.id}]`));
            if (acObj.given) console.log(chalk.gray(`    Given: ${acObj.given}`));
            if (acObj.when) console.log(chalk.gray(`    When: ${acObj.when}`));
            if (acObj.then) console.log(chalk.gray(`    Then: ${acObj.then}`));
          }
        }
      }
      // Show traceability if present
      if ("traceability" in spec && spec.traceability && typeof spec.traceability === "object") {
        const trace = spec.traceability as {
          implementation?: Array<{
            path: string;
            function?: string;
            lines?: string;
          }>;
          tests?: Array<{ path: string }>;
          commits?: string[];
          issues?: string[];
        };
        const hasTrace =
          trace.implementation?.length ||
          trace.tests?.length ||
          trace.commits?.length ||
          trace.issues?.length;
        if (hasTrace) {
          console.log(chalk.gray(fieldLabels.traceability));
          if (trace.implementation?.length) {
            for (const impl of trace.implementation) {
              let loc = `  Code: ${impl.path}`;
              if (impl.function) loc += `::${impl.function}`;
              if (impl.lines) loc += `:${impl.lines}`;
              console.log(chalk.gray(loc));
            }
          }
          if (trace.tests?.length) {
            for (const test of trace.tests) {
              console.log(chalk.gray(`  Test: ${test.path}`));
            }
          }
          if (trace.commits?.length) {
            console.log(chalk.gray(`  Commits: ${trace.commits.join(", ")}`));
          }
          if (trace.issues?.length) {
            console.log(chalk.gray(`  Issues: ${trace.issues.join(", ")}`));
          }
        }
      }
    }
  }

  if (task.notes.length > 0) {
    // Filter superseded notes unless showAllNotes is true
    const notesToShow = options.showAllNotes ? task.notes : filterSupersededNotes(task.notes);
    const hiddenCount = task.notes.length - notesToShow.length;

    console.log(`\n${sectionHeaders.notes}`);
    for (const note of notesToShow) {
      const author = note.author || "unknown";
      // Mark if this note supersedes another
      const supersededLabel = note.supersedes ? chalk.gray(" (supersedes earlier note)") : "";
      console.log(chalk.gray(`[${note.created_at}] ${author}:`) + supersededLabel);
      console.log(note.content);
    }

    // Show count of hidden notes if any
    if (hiddenCount > 0) {
      console.log(
        chalk.gray(
          `\n(${hiddenCount} superseded note${hiddenCount > 1 ? "s" : ""} hidden - use --all to show)`,
        ),
      );
    }
  }

  // AC: @task-activity-timeline ac-1 — show recent activity by default
  if (options.activity && options.activity.length > 0) {
    const DEFAULT_ACTIVITY_COUNT = 10;
    // Display in reverse chronological order (most recent first)
    const reversed = [...options.activity].toReversed();
    const showAll = options.showFullActivity;
    const entries = showAll ? reversed : reversed.slice(0, DEFAULT_ACTIVITY_COUNT);
    const hiddenCount = reversed.length - entries.length;

    console.log(`\n${sectionHeaders.activity}`);
    for (const entry of entries) {
      const icon = activityIcon(entry.type);
      const time = formatRelativeTime(new Date(entry.timestamp));
      console.log(
        `${icon} ${chalk.gray(time)} ${entry.summary}${entry.author ? chalk.gray(` (${entry.author})`) : ""}`,
      );
    }
    if (hiddenCount > 0) {
      console.log(
        chalk.gray(
          `\n(${hiddenCount} older entr${hiddenCount === 1 ? "y" : "ies"} hidden — use --activity to show all)`,
        ),
      );
    }
  }

  if (task.todos.length > 0) {
    console.log(`\n${sectionHeaders.todos}`);
    for (const todo of task.todos) {
      const check = todo.done ? chalk.green("✓") : chalk.gray("○");
      const text = todo.done ? chalk.strikethrough.gray(todo.text) : todo.text;
      console.log(`${check} [${todo.id}] ${text}`);
    }
  }
}

/**
 * Map activity types to display icons.
 */
function activityIcon(type: string): string {
  switch (type) {
    case "created":
      return chalk.green("●");
    case "started":
      return chalk.cyan("▶");
    case "submitted":
      return chalk.blue("↑");
    case "completed":
      return chalk.green("✓");
    case "blocked":
      return chalk.red("⊘");
    case "needs_work":
      return chalk.yellow("↩");
    case "cancelled":
      return chalk.gray("✕");
    case "note_added":
      return chalk.gray("✎");
    case "state_change":
      return chalk.yellow("◆");
    case "review_linked":
      return chalk.magenta("⚑");
    case "field_updated":
      return chalk.gray("·");
    default:
      return chalk.gray("○");
  }
}
