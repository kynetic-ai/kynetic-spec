/**
 * Hook CLI commands for managing event-triggered hooks.
 *
 * Commands: kspec hook list, add, get, set, enable, disable, remove.
 * All commands follow existing CLI patterns for output formatting,
 * shadow branch auto-commit, and batch compatibility.
 *
 * Spec: @dispatch-event-cli
 * Task: @task-hook-cli
 */

import chalk from "chalk";
import Table from "cli-table3";
import type { Command } from "commander";
import { ulid } from "ulid";
import {
  deleteHook,
  initContext,
  type LoadedHook,
  loadMetaContext,
  saveHook,
} from "../../parser/index.js";
import { commitIfShadow } from "../../parser/shadow.js";
import {
  ActionSchema,
  type Hook,
  HookEventTypeSchema,
  HookFilterSchema,
  HookSchema,
  validateHookFilter,
} from "../../schema/index.js";
import { markMutating } from "../command-annotations.js";
import { EXIT_CODES } from "../exit-codes.js";
import { error, isJsonMode, output, success, warn } from "../output.js";

// ─── Reference Resolution ───────────────────────────────────────────────────

/**
 * Resolve a hook reference (ULID prefix or name) from the loaded hooks list.
 */
function resolveHookRef(
  ref: string,
  hooks: LoadedHook[],
): LoadedHook | null {
  const cleanRef = ref.startsWith("@") ? ref.slice(1) : ref;

  for (const hook of hooks) {
    // Match full ULID
    if (hook._ulid === cleanRef) return hook;
    // Match ULID prefix
    if (hook._ulid.toLowerCase().startsWith(cleanRef.toLowerCase())) return hook;
    // Match by name
    if (hook.name === cleanRef) return hook;
  }

  return null;
}

// ─── Formatting ─────────────────────────────────────────────────────────────

/**
 * Format hooks list as a table for human-readable output.
 * AC: @dispatch-event-cli ac-1 — shows name, event trigger, action type, enabled status
 */
function formatHooksList(hooks: LoadedHook[]): void {
  if (hooks.length === 0) {
    console.log(chalk.yellow("No hooks defined"));
    return;
  }

  const table = new Table({
    head: [
      chalk.bold("ID"),
      chalk.bold("Name"),
      chalk.bold("Event"),
      chalk.bold("Action"),
      chalk.bold("Enabled"),
    ],
    style: { head: [], border: [] },
  });

  for (const hook of hooks) {
    table.push([
      hook._ulid.substring(0, 8),
      hook.name,
      hook.on,
      hook.action.type,
      hook.enabled ? chalk.green("yes") : chalk.red("no"),
    ]);
  }

  console.log(table.toString());
  console.log(chalk.gray(`${hooks.length} hook${hooks.length === 1 ? "" : "s"}`));
}

/**
 * Format a single hook for detailed display.
 */
function formatHookDetail(hook: LoadedHook): void {
  console.log(chalk.bold(hook.name));
  console.log(chalk.gray("─".repeat(40)));
  console.log(`ULID:    ${hook._ulid}`);
  console.log(`Name:    ${hook.name}`);
  console.log(`Event:   ${hook.on}`);
  console.log(`Action:  ${hook.action.type}`);
  console.log(`Enabled: ${hook.enabled ? chalk.green("yes") : chalk.red("no")}`);

  if (hook.filter && Object.keys(hook.filter).length > 0) {
    console.log(`Filter:  ${JSON.stringify(hook.filter)}`);
  }

  console.log(`\n${chalk.bold("Action Details")}`);
  console.log(chalk.gray("─".repeat(40)));
  for (const [key, value] of Object.entries(hook.action)) {
    if (key === "type") continue;
    console.log(`  ${key}: ${JSON.stringify(value)}`);
  }
}

// ─── JSON Serialization ─────────────────────────────────────────────────────

/**
 * Serialize a hook for JSON output.
 * AC: @trait-json-output ac-1, ac-2 — valid JSON with all data
 * AC: @trait-json-output ac-4 — references use @ prefix
 * AC: @trait-json-output ac-5 — timestamps use ISO 8601
 */
function hookToJson(hook: LoadedHook): Record<string, unknown> {
  return {
    _ulid: hook._ulid,
    name: hook.name,
    on: hook.on,
    filter: hook.filter ?? null,
    action: hook.action,
    enabled: hook.enabled,
  };
}

// ─── Command Registration ───────────────────────────────────────────────────

/**
 * Register hook CLI commands.
 * AC: @dispatch-event-cli ac-1, ac-4
 */
export function registerHookCommands(program: Command): void {
  const hook = program
    .command("hook")
    .description("Hook management commands");

  // ── kspec hook list ─────────────────────────────────────────────────────
  // AC: @dispatch-event-cli ac-1 — list hooks with name, event, action type, enabled
  // AC: @trait-filterable-list ac-1 through ac-8
  hook
    .command("list")
    .description("List all hooks")
    .option("--status <status>", "Filter by enabled status (enabled/disabled)")
    .option("--tag <tag>", "Filter by event type domain (e.g., task, invocation)")
    .option("--limit <n>", "Maximum number of hooks to show")
    .option("--offset <n>", "Skip first N hooks")
    .option("--count", "Show only total count of matching hooks")
    .action(async (options) => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error("No kspec project found. Run 'kspec init' to create one.");
          process.exit(EXIT_CODES.ERROR);
        }

        const metaCtx = await loadMetaContext(ctx);
        let hooks = metaCtx.hooks || [];

        // AC: @trait-filterable-list ac-1 — filter by status (enabled/disabled)
        if (options.status) {
          if (options.status === "enabled") {
            hooks = hooks.filter((h) => h.enabled);
          } else if (options.status === "disabled") {
            hooks = hooks.filter((h) => !h.enabled);
          } else {
            error(`Invalid status filter: ${options.status}. Use 'enabled' or 'disabled'.`);
            process.exit(EXIT_CODES.VALIDATION_FAILED);
          }
        }

        // AC: @trait-filterable-list ac-2 — filter by tag (event domain)
        if (options.tag) {
          hooks = hooks.filter((h) => h.on.startsWith(options.tag + "."));
        }

        // AC: @trait-filterable-list ac-8 — count mode
        if (options.count) {
          output(
            isJsonMode() ? { count: hooks.length } : hooks.length,
            () => console.log(hooks.length),
          );
          return;
        }

        const totalMatching = hooks.length;

        // AC: @trait-filterable-list ac-4 — offset
        if (options.offset) {
          const offset = parseInt(options.offset, 10);
          if (Number.isNaN(offset) || offset < 0) {
            error("Invalid offset value. Must be a non-negative integer.");
            process.exit(EXIT_CODES.VALIDATION_FAILED);
          }
          hooks = hooks.slice(offset);
        }

        // AC: @trait-filterable-list ac-3 — limit
        if (options.limit) {
          const limit = parseInt(options.limit, 10);
          if (Number.isNaN(limit) || limit < 1) {
            error("Invalid limit value. Must be a positive integer.");
            process.exit(EXIT_CODES.VALIDATION_FAILED);
          }
          hooks = hooks.slice(0, limit);
        }

        // AC: @trait-filterable-list ac-6 — empty result message
        // AC: @trait-filterable-list ac-7 — summary with total and filter state
        output(
          hooks.map(hookToJson),
          () => {
            if (hooks.length === 0) {
              const hasFilters = options.status || options.tag;
              if (hasFilters) {
                console.log(chalk.yellow("No hooks match the specified filters"));
              } else {
                console.log(chalk.yellow("No hooks defined"));
              }
              return;
            }
            formatHooksList(hooks);
            if (totalMatching !== hooks.length) {
              console.log(chalk.gray(`Showing ${hooks.length} of ${totalMatching} matching hooks`));
            }
          },
        );
      } catch (err) {
        error("Failed to list hooks", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // ── kspec hook get ──────────────────────────────────────────────────────
  hook
    .command("get <ref>")
    .description("Get details of a specific hook")
    .action(async (ref: string) => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error("No kspec project found. Run 'kspec init' to create one.");
          process.exit(EXIT_CODES.ERROR);
        }

        const metaCtx = await loadMetaContext(ctx);
        const found = resolveHookRef(ref, metaCtx.hooks);

        if (!found) {
          // AC: @trait-error-guidance ac-1, ac-2, ac-3 — describe error and suggest fix
          error(`Hook not found: ${ref}. Try 'kspec hook list' to see available hooks.`);
          process.exit(EXIT_CODES.NOT_FOUND);
        }

        output(hookToJson(found), () => formatHookDetail(found));
      } catch (err) {
        error("Failed to get hook", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // ── kspec hook add ──────────────────────────────────────────────────────
  // AC: @dispatch-event-cli ac-4 — add a hook with event and action config
  markMutating(
    hook
      .command("add <name>")
      .description("Add a new hook")
      .requiredOption("--on <event-type>", "Event type to trigger on (e.g., task.ready)")
      .requiredOption("--action <json>", "Action definition as JSON")
      .option("--filter <json>", "Optional payload filter as JSON")
      .option("--disabled", "Create the hook in disabled state"),
  ).action(async (name: string, options) => {
    try {
      const ctx = await initContext();

      if (!ctx.manifestPath) {
        error("No kspec project found. Run 'kspec init' to create one.");
        process.exit(EXIT_CODES.ERROR);
      }

      // Validate event type
      // AC: @trait-error-guidance ac-5 — indicate which field/value failed
      const eventResult = HookEventTypeSchema.safeParse(options.on);
      if (!eventResult.success) {
        error(
          `Invalid event type: ${options.on}. ` +
            `Use 'kspec event types' to see valid event types.`,
        );
        process.exit(EXIT_CODES.VALIDATION_FAILED);
      }

      // Parse and validate action JSON
      let actionData: unknown;
      try {
        actionData = JSON.parse(options.action);
      } catch (parseErr) {
        const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
        error(`Invalid JSON in --action: ${msg}`);
        process.exit(EXIT_CODES.VALIDATION_FAILED);
      }

      const actionResult = ActionSchema.safeParse(actionData);
      if (!actionResult.success) {
        const issues = actionResult.error.issues
          .map((i) => `${i.path.join(".") || "action"}: ${i.message}`)
          .join("; ");
        error(`Invalid action: ${issues}`);
        process.exit(EXIT_CODES.VALIDATION_FAILED);
      }

      // Parse and validate filter if provided
      let filterData: Record<string, unknown> | undefined;
      if (options.filter) {
        try {
          filterData = JSON.parse(options.filter);
        } catch (parseErr) {
          const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
          error(`Invalid JSON in --filter: ${msg}`);
          process.exit(EXIT_CODES.VALIDATION_FAILED);
        }

        const filterResult = HookFilterSchema.safeParse(filterData);
        if (!filterResult.success) {
          const issues = filterResult.error.issues
            .map((i) => `${i.path.join(".") || "filter"}: ${i.message}`)
            .join("; ");
          error(`Invalid filter: ${issues}`);
          process.exit(EXIT_CODES.VALIDATION_FAILED);
        }
        filterData = filterResult.data;

        // Warn about unknown filter fields
        const warnings = validateHookFilter(name, options.on, filterData);
        for (const w of warnings) {
          warn(w.message);
        }
      }

      // Check for duplicate name
      const metaCtx = await loadMetaContext(ctx);
      const existing = metaCtx.hooks.find((h) => h.name === name);
      if (existing) {
        error(`A hook named '${name}' already exists (@${existing._ulid.substring(0, 8)}).`);
        process.exit(EXIT_CODES.CONFLICT);
      }

      // Build and validate the full hook
      const hookData = {
        _ulid: ulid(),
        name,
        on: eventResult.data,
        ...(filterData && { filter: filterData }),
        action: actionResult.data,
        enabled: !options.disabled,
      };

      const hookResult = HookSchema.safeParse(hookData);
      if (!hookResult.success) {
        const issues = hookResult.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ");
        error(`Hook validation failed: ${issues}`);
        process.exit(EXIT_CODES.VALIDATION_FAILED);
      }

      // AC: @dispatch-event-cli ac-4 — persist the hook
      await saveHook(ctx, hookResult.data);

      // AC: @trait-shadow-commit ac-1, ac-2, ac-3
      await commitIfShadow(
        ctx.shadow,
        "hook-add",
        hookResult.data._ulid.substring(0, 8),
        name,
      );

      // AC: @trait-json-output ac-1, ac-2
      output(hookToJson(hookResult.data), () =>
        success(`Created hook: ${name} (@${hookResult.data._ulid.substring(0, 8)})`),
      );
    } catch (err) {
      error("Failed to add hook", err);
      process.exit(EXIT_CODES.ERROR);
    }
  });

  // ── kspec hook set ──────────────────────────────────────────────────────
  markMutating(
    hook
      .command("set <ref>")
      .description("Update an existing hook")
      .option("--name <name>", "Update hook name")
      .option("--on <event-type>", "Update event type")
      .option("--action <json>", "Update action definition (JSON)")
      .option("--filter <json>", "Update filter (JSON, use '{}' to clear)")
      .option("--enabled", "Enable the hook")
      .option("--disabled", "Disable the hook"),
  ).action(async (ref: string, options) => {
    try {
      const ctx = await initContext();

      if (!ctx.manifestPath) {
        error("No kspec project found. Run 'kspec init' to create one.");
        process.exit(EXIT_CODES.ERROR);
      }

      const metaCtx = await loadMetaContext(ctx);
      const found = resolveHookRef(ref, metaCtx.hooks);

      if (!found) {
        error(`Hook not found: ${ref}. Try 'kspec hook list' to see available hooks.`);
        process.exit(EXIT_CODES.NOT_FOUND);
      }

      // Apply mutations
      if (options.name) {
        // Check for duplicate name
        const duplicate = metaCtx.hooks.find(
          (h) => h.name === options.name && h._ulid !== found._ulid,
        );
        if (duplicate) {
          error(`A hook named '${options.name}' already exists (@${duplicate._ulid.substring(0, 8)}).`);
          process.exit(EXIT_CODES.CONFLICT);
        }
        found.name = options.name;
      }

      if (options.on) {
        const eventResult = HookEventTypeSchema.safeParse(options.on);
        if (!eventResult.success) {
          error(
            `Invalid event type: ${options.on}. ` +
              `Use 'kspec event types' to see valid event types.`,
          );
          process.exit(EXIT_CODES.VALIDATION_FAILED);
        }
        found.on = eventResult.data;
      }

      if (options.action) {
        let actionData: unknown;
        try {
          actionData = JSON.parse(options.action);
        } catch (parseErr) {
          const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
          error(`Invalid JSON in --action: ${msg}`);
          process.exit(EXIT_CODES.VALIDATION_FAILED);
        }

        const actionResult = ActionSchema.safeParse(actionData);
        if (!actionResult.success) {
          const issues = actionResult.error.issues
            .map((i) => `${i.path.join(".") || "action"}: ${i.message}`)
            .join("; ");
          error(`Invalid action: ${issues}`);
          process.exit(EXIT_CODES.VALIDATION_FAILED);
        }
        found.action = actionResult.data;
      }

      if (options.filter !== undefined) {
        let filterRaw: unknown;
        try {
          filterRaw = JSON.parse(options.filter);
        } catch (parseErr) {
          const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
          error(`Invalid JSON in --filter: ${msg}`);
          process.exit(EXIT_CODES.VALIDATION_FAILED);
        }

        if (
          filterRaw &&
          typeof filterRaw === "object" &&
          Object.keys(filterRaw).length === 0
        ) {
          // Clear filter
          found.filter = undefined;
        } else {
          const filterResult = HookFilterSchema.safeParse(filterRaw);
          if (!filterResult.success) {
            const issues = filterResult.error.issues
              .map((i) => `${i.path.join(".") || "filter"}: ${i.message}`)
              .join("; ");
            error(`Invalid filter: ${issues}`);
            process.exit(EXIT_CODES.VALIDATION_FAILED);
          }
          found.filter = filterResult.data;

          // Warn about unknown filter fields
          const warnings = validateHookFilter(
            found.name,
            found.on,
            filterResult.data,
          );
          for (const w of warnings) {
            warn(w.message);
          }
        }
      }

      if (options.enabled) found.enabled = true;
      if (options.disabled) found.enabled = false;

      await saveHook(ctx, found);

      // AC: @trait-shadow-commit ac-1, ac-2, ac-3
      await commitIfShadow(
        ctx.shadow,
        "hook-set",
        found._ulid.substring(0, 8),
        found.name,
      );

      output(hookToJson(found), () => success(`Updated hook: ${found.name}`));
    } catch (err) {
      error("Failed to update hook", err);
      process.exit(EXIT_CODES.ERROR);
    }
  });

  // ── kspec hook enable ───────────────────────────────────────────────────
  markMutating(
    hook
      .command("enable <ref>")
      .description("Enable a hook"),
  ).action(async (ref: string) => {
    try {
      const ctx = await initContext();

      if (!ctx.manifestPath) {
        error("No kspec project found. Run 'kspec init' to create one.");
        process.exit(EXIT_CODES.ERROR);
      }

      const metaCtx = await loadMetaContext(ctx);
      const found = resolveHookRef(ref, metaCtx.hooks);

      if (!found) {
        error(`Hook not found: ${ref}. Try 'kspec hook list' to see available hooks.`);
        process.exit(EXIT_CODES.NOT_FOUND);
      }

      if (found.enabled) {
        output(hookToJson(found), () =>
          success(`Hook '${found.name}' is already enabled`),
        );
        return;
      }

      found.enabled = true;
      await saveHook(ctx, found);

      await commitIfShadow(
        ctx.shadow,
        "hook-enable",
        found._ulid.substring(0, 8),
        found.name,
      );

      output(hookToJson(found), () => success(`Enabled hook: ${found.name}`));
    } catch (err) {
      error("Failed to enable hook", err);
      process.exit(EXIT_CODES.ERROR);
    }
  });

  // ── kspec hook disable ──────────────────────────────────────────────────
  markMutating(
    hook
      .command("disable <ref>")
      .description("Disable a hook"),
  ).action(async (ref: string) => {
    try {
      const ctx = await initContext();

      if (!ctx.manifestPath) {
        error("No kspec project found. Run 'kspec init' to create one.");
        process.exit(EXIT_CODES.ERROR);
      }

      const metaCtx = await loadMetaContext(ctx);
      const found = resolveHookRef(ref, metaCtx.hooks);

      if (!found) {
        error(`Hook not found: ${ref}. Try 'kspec hook list' to see available hooks.`);
        process.exit(EXIT_CODES.NOT_FOUND);
      }

      if (!found.enabled) {
        output(hookToJson(found), () =>
          success(`Hook '${found.name}' is already disabled`),
        );
        return;
      }

      found.enabled = false;
      await saveHook(ctx, found);

      await commitIfShadow(
        ctx.shadow,
        "hook-disable",
        found._ulid.substring(0, 8),
        found.name,
      );

      output(hookToJson(found), () => success(`Disabled hook: ${found.name}`));
    } catch (err) {
      error("Failed to disable hook", err);
      process.exit(EXIT_CODES.ERROR);
    }
  });

  // ── kspec hook remove ───────────────────────────────────────────────────
  markMutating(
    hook
      .command("remove <ref>")
      .description("Remove a hook")
      .option("--confirm", "Skip confirmation prompt"),
  ).action(async (ref: string, options) => {
    try {
      const ctx = await initContext();

      if (!ctx.manifestPath) {
        error("No kspec project found. Run 'kspec init' to create one.");
        process.exit(EXIT_CODES.ERROR);
      }

      const metaCtx = await loadMetaContext(ctx);
      const found = resolveHookRef(ref, metaCtx.hooks);

      if (!found) {
        error(`Hook not found: ${ref}. Try 'kspec hook list' to see available hooks.`);
        process.exit(EXIT_CODES.NOT_FOUND);
      }

      if (!options.confirm) {
        error(
          `Confirm deletion of hook '${found.name}' with --confirm flag.`,
        );
        process.exit(EXIT_CODES.ERROR);
      }

      const deleted = await deleteHook(ctx, found._ulid);

      if (!deleted) {
        error(`Failed to delete hook '${found.name}'.`);
        process.exit(EXIT_CODES.ERROR);
      }

      // AC: @trait-shadow-commit ac-1
      await commitIfShadow(
        ctx.shadow,
        "hook-remove",
        found._ulid.substring(0, 8),
        found.name,
      );

      output(
        { deleted: true, _ulid: found._ulid, name: found.name },
        () => success(`Removed hook: ${found.name}`),
      );
    } catch (err) {
      error("Failed to remove hook", err);
      process.exit(EXIT_CODES.ERROR);
    }
  });
}
