/**
 * `kspec plan resource` subcommands — manage plan-owned local resource files.
 *
 * Implements the resource attachment CLI surface for folder-backed plans:
 *
 *   - `add`    attach a local file as a plan resource
 *   - `list`   list declared plan resources
 *   - `get`    read one resource's metadata
 *   - `remove` delete a declared plan resource
 *
 * All commands share the structured JSON envelope and exact exit-code map
 * defined by @plan-resource-derivation-semantics-1 and inherited from
 * @trait-semantic-exit-codes. The resource id, path, and content-type rules
 * are inherited from @trait-entity-scoped-local-resources-1 via the shared
 * helpers in `src/parser/entity-local-resources.ts`.
 *
 * AC: @plan-resource-derivation-semantics-1 ac-plan-task-resource-refs-are-structured
 * AC: @plan-resource-derivation-semantics-1 ac-derived-task-keeps-plan-resource-reference
 * AC: @plan-resource-derivation-semantics-1 ac-derived-task-records-resource-version
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Command } from "commander";
import { markMutating } from "../command-annotations.js";
import {
  assertSafeResourceMutationPath,
  captureResourceGitVersion,
  computeResourceMetadata,
  getResourcesDir,
  loadResourceManifest,
  validateResourceId,
  validateResourceRelativePath,
  writeResourceManifest,
} from "../../parser/entity-local-resources.js";
import {
  EntityStorageCompatibilityError,
  isDeterministicEntityStorageIncompatibility,
  requirePlanFolderStorage,
} from "../../parser/entity-storage-compatibility.js";
import { findPlanByRef, initContext } from "../../parser/index.js";
import { getPlanDir } from "../../parser/plan-storage-manager.js";
import { commitIfShadow } from "../../parser/shadow.js";
import type { ResourceMetadata } from "../../schema/resources.js";
import { isJsonMode } from "../output.js";

// ── Exit codes (mirror @trait-semantic-exit-codes ac-1..ac-4) ────────────────
// 0 success
// 1 validation/usage/conflict/not-found
// 2 user cancellation
// 3 runtime / storage incompatibility
const EXIT_SUCCESS = 0;
const EXIT_VALIDATION = 1;
const EXIT_CANCELLED = 2;
const EXIT_RUNTIME = 3;

// ── Error code vocabulary ────────────────────────────────────────────────────
export type PlanResourceErrorCode =
  | "invalid_resource_id"
  | "invalid_resource_path"
  | "source_file_missing"
  | "source_file_unreadable"
  | "resource_conflict"
  | "resource_not_found"
  | "plan_not_found"
  | "confirmation_required"
  | "operation_cancelled"
  | "entity_storage_incompatible";

interface PlanResourceErrorOptions {
  resourceId?: string | null;
  path?: string | null;
  sourceFile?: string | null;
}

interface PlanResourceErrorEnvelope {
  error: string;
  code: PlanResourceErrorCode;
  message: string;
  resource_id: string | null;
  path: string | null;
  source_file: string | null;
}

/**
 * Emit a structured CLI failure with the exact envelope described in the
 * plan resource derivation semantics task — `{ error, code, message,
 * resource_id, path, source_file }`. Text mode prints a human line plus the
 * code; JSON mode prints the envelope verbatim on stderr so stdout stays
 * pure for piping.
 */
function failPlanResource(
  exitCode: number,
  code: PlanResourceErrorCode,
  message: string,
  options: PlanResourceErrorOptions = {},
): never {
  const envelope: PlanResourceErrorEnvelope = {
    error: code,
    code,
    message,
    resource_id: options.resourceId ?? null,
    path: options.path ?? null,
    source_file: options.sourceFile ?? null,
  };
  if (isJsonMode()) {
    console.error(JSON.stringify(envelope));
  } else {
    console.error(`✗ ${message}`);
    console.error(`  Code: ${code}`);
    if (envelope.resource_id) console.error(`  Resource id: ${envelope.resource_id}`);
    if (envelope.path) console.error(`  Path: ${envelope.path}`);
    if (envelope.source_file) console.error(`  Source file: ${envelope.source_file}`);
  }
  process.exit(exitCode);
}

/**
 * Translate an unexpected error into the plan-resource envelope. Deterministic
 * entity-storage incompatibilities exit 3 with `entity_storage_incompatible`;
 * any other unexpected error also exits 3 so callers always see a structured
 * payload instead of an unmapped stack trace.
 */
function failFromUnexpected(err: unknown): never {
  if (isDeterministicEntityStorageIncompatibility(err)) {
    failPlanResource(
      EXIT_RUNTIME,
      "entity_storage_incompatible",
      (err as EntityStorageCompatibilityError).message,
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  failPlanResource(
    EXIT_RUNTIME,
    "entity_storage_incompatible",
    `Unexpected runtime error after validation: ${message}`,
  );
}

function emitSuccess(payload: Record<string, unknown>, textLine: string): void {
  if (isJsonMode()) {
    console.log(JSON.stringify(payload));
  } else {
    console.log(textLine);
  }
}

function isInteractiveStdin(): boolean {
  if (process.env.KSPEC_TEST_TTY === "true") return true;
  return Boolean(process.stdin.isTTY);
}

async function promptYesNo(question: string): Promise<boolean> {
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(`${question} [y/N] `, (response) => resolve(response.trim()));
    });
    return answer.toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

interface ResolvedPlan {
  ulid: string;
  ref: string;
  title: string;
}

/**
 * Resolve a plan ref under folder-backed storage, mapping every failure mode
 * into the plan-resource error envelope so callers get the same exit-code
 * contract no matter which step failed. Specifically:
 *
 *   - manifest gates → entity_storage_incompatible (exit 3)
 *   - missing plan   → plan_not_found              (exit 1)
 */
async function resolvePlanOrFail(planRef: string): Promise<{
  ctx: Awaited<ReturnType<typeof initContext>>;
  plan: ResolvedPlan;
}> {
  const ctx = await initContext();
  try {
    await requirePlanFolderStorage(ctx);
  } catch (err) {
    if (isDeterministicEntityStorageIncompatibility(err)) {
      failPlanResource(
        EXIT_RUNTIME,
        "entity_storage_incompatible",
        (err as EntityStorageCompatibilityError).message,
      );
    }
    failFromUnexpected(err);
  }
  const found = await findPlanByRef(ctx, planRef);
  if (!found) {
    failPlanResource(EXIT_VALIDATION, "plan_not_found", `Plan not found: ${planRef}`);
  }
  return {
    ctx,
    plan: {
      ulid: found._ulid,
      ref: found.slugs[0] ? `@${found.slugs[0]}` : `@${found._ulid}`,
      title: found.title,
    },
  };
}

/**
 * Register `kspec plan resource …` subcommands under the provided plan
 * command group.
 */
export function registerPlanResourceCommands(planCommand: Command): void {
  const resource = planCommand
    .command("resource")
    .description("Manage plan-owned local resource files");

  registerPlanResourceAddCommand(resource);
  registerPlanResourceListCommand(resource);
  registerPlanResourceGetCommand(resource);
  registerPlanResourceRemoveCommand(resource);
}

// ── add ─────────────────────────────────────────────────────────────────────

interface PlanResourceAddOptions {
  id?: string;
  path?: string;
  label?: string;
  description?: string;
  contentType?: string;
  replace?: boolean;
  json?: boolean;
}

function registerPlanResourceAddCommand(resource: Command): void {
  markMutating(resource.command("add <plan-ref> <source-file>"))
    .description("Attach a local file as a plan resource")
    // --id and --path are required by the contract but registered as plain
    // options so missing values surface the structured invalid_resource_id /
    // invalid_resource_path envelope instead of commander's generic
    // "required option not specified" message.
    .option("--id <id>", "Resource identifier")
    .option("--path <relative-path>", "Relative path under the plan's resources/ directory")
    .option("--label <label>", "Optional human-friendly label")
    .option("--description <text>", "Optional description")
    .option("--content-type <mime>", "Override the inferred content type")
    .option(
      "--replace",
      "Replace an existing resource with the same id (refuses path collisions onto a different id)",
    )
    .option("--json", "Output as JSON")
    .addHelpText(
      "after",
      `
Examples:
  $ kspec plan resource add @plan ./shot.png --id login-shot --path screenshots/login.png
  $ kspec plan resource add @plan ./shot.png --id login-shot --path login.png --replace --json`,
    )
    .action(async (planRef: string, sourceFile: string, options: PlanResourceAddOptions) => {
      try {
        await runPlanResourceAdd(planRef, sourceFile, options);
      } catch (err) {
        failFromUnexpected(err);
      }
    });
}

async function runPlanResourceAdd(
  planRef: string,
  sourceFile: string,
  options: PlanResourceAddOptions,
): Promise<void> {
  if (!options.id) {
    failPlanResource(EXIT_VALIDATION, "invalid_resource_id", "--id is required for plan resource add");
  }
  if (!options.path) {
    failPlanResource(EXIT_VALIDATION, "invalid_resource_path", "--path is required for plan resource add");
  }

  const idValidation = validateResourceId(options.id);
  if (!idValidation.ok) {
    failPlanResource(EXIT_VALIDATION, "invalid_resource_id", idValidation.error, {
      resourceId: options.id,
    });
  }
  const pathValidation = validateResourceRelativePath(options.path);
  if (!pathValidation.ok) {
    failPlanResource(EXIT_VALIDATION, "invalid_resource_path", pathValidation.error, {
      resourceId: options.id,
      path: options.path,
    });
  }

  const sourceAbsolute = path.resolve(process.cwd(), sourceFile);
  let sourceStat;
  try {
    sourceStat = await fs.stat(sourceAbsolute);
  } catch {
    failPlanResource(
      EXIT_VALIDATION,
      "source_file_missing",
      `Source file does not exist: ${sourceFile}`,
      { resourceId: options.id, path: options.path, sourceFile },
    );
  }
  if (!sourceStat.isFile()) {
    failPlanResource(
      EXIT_VALIDATION,
      "source_file_unreadable",
      `Source file is not a regular file: ${sourceFile}`,
      { resourceId: options.id, path: options.path, sourceFile },
    );
  }

  const { ctx, plan } = await resolvePlanOrFail(planRef);
  const planDir = getPlanDir(ctx, plan.ulid);
  const resourcesDir = getResourcesDir(planDir);

  // Load the current manifest before deciding whether this is an add or a
  // replacement. We do not touch disk until validation passes so a rejected
  // request cannot leave partial state behind.
  let manifest;
  try {
    manifest = await loadResourceManifest(planDir);
  } catch (err) {
    failFromUnexpected(err);
  }

  const existingById = manifest.resources.find((r) => r.id === options.id);
  const existingByPath = manifest.resources.find((r) => r.path === pathValidation.value);

  // Path-id mismatch: refuse to overwrite a different resource id's path
  // even when --replace is supplied. Replace is scoped to "this id".
  if (existingByPath && existingByPath.id !== options.id) {
    failPlanResource(
      EXIT_VALIDATION,
      "resource_conflict",
      `Path "${pathValidation.value}" is already declared by resource "${existingByPath.id}"; choose a different path or remove the existing entry first.`,
      { resourceId: options.id, path: pathValidation.value },
    );
  }

  // ID conflict without --replace
  if (existingById && !options.replace) {
    failPlanResource(
      EXIT_VALIDATION,
      "resource_conflict",
      `Resource id "${options.id}" already exists on plan ${plan.ref}; pass --replace to overwrite it.`,
      { resourceId: options.id, path: pathValidation.value },
    );
  }

  // Path conflict without --replace (same path, different id was caught above
  // — same path, same id is fine under --replace; same path, no existingById
  // means the path-id mismatch branch already handled it).
  if (!existingById && existingByPath && options.replace) {
    failPlanResource(
      EXIT_VALIDATION,
      "resource_conflict",
      `Path "${pathValidation.value}" is already declared by resource "${existingByPath.id}"; --replace only updates the resource matching --id.`,
      { resourceId: options.id, path: pathValidation.value },
    );
  }

  // Compute and validate the full metadata payload from the SOURCE file
  // before touching the destination. Without this ordering, a rejected
  // validation (e.g. malformed --content-type) would still leave the
  // already-copied bytes on disk while the manifest stays on the old
  // metadata — an inconsistent half-applied state. Hashing the source
  // produces the same bytes/sha256 the copy would land at because
  // fs.copyFile preserves content; git_commit/git_path is captured from
  // the destination after the copy so the recorded identity reflects the
  // shadow-worktree path, not the user's working directory.
  let metadata: ResourceMetadata;
  try {
    const metadataResult = await computeResourceMetadata({
      id: options.id,
      relativePath: pathValidation.value,
      absolutePath: sourceAbsolute,
      contentType: options.contentType,
      label: options.label ?? null,
      description: options.description ?? null,
      captureGit: false,
    });
    if (!metadataResult.ok) {
      failPlanResource(EXIT_VALIDATION, "invalid_resource_path", metadataResult.error, {
        resourceId: options.id,
        path: pathValidation.value,
        sourceFile,
      });
    }
    metadata = metadataResult.value;
  } catch (err) {
    failFromUnexpected(err);
  }

  // Defend against pre-existing symlinks on the destination chain before
  // touching disk. Without this, an existing `<resourcesDir>/sub` symlink
  // to an outside tree would let `fs.copyFile(..., path.join(resourcesDir,
  // "sub/leak.txt"))` write the bytes outside the plan directory entirely.
  // The textual `validateResourceRelativePath` above only catches
  // authoring-time traversal; it cannot see disk-level symlinks. If the
  // previous resource lived at a different relative path, validate that
  // chain too so the post-copy cleanup `fs.rm` cannot delete an outside
  // file through a symlinked predecessor.
  const safeDestination = await assertSafeResourceMutationPath({
    ownerResourcesDir: resourcesDir,
    relativePath: pathValidation.value,
  });
  if (!safeDestination.ok) {
    failPlanResource(EXIT_VALIDATION, "invalid_resource_path", safeDestination.error, {
      resourceId: options.id,
      path: pathValidation.value,
    });
  }
  if (existingById && existingById.path !== pathValidation.value) {
    const safePrevious = await assertSafeResourceMutationPath({
      ownerResourcesDir: resourcesDir,
      relativePath: existingById.path,
    });
    if (!safePrevious.ok) {
      failPlanResource(EXIT_VALIDATION, "invalid_resource_path", safePrevious.error, {
        resourceId: options.id,
        path: existingById.path,
      });
    }
  }

  // All validation passed — safe to mutate the destination.
  await fs.mkdir(resourcesDir, { recursive: true });
  const destination = safeDestination.value.absolutePath;
  await fs.mkdir(path.dirname(destination), { recursive: true });

  try {
    await fs.copyFile(sourceAbsolute, destination);
  } catch (err) {
    failPlanResource(
      EXIT_VALIDATION,
      "source_file_unreadable",
      `Failed to copy source file ${sourceFile}: ${err instanceof Error ? err.message : String(err)}`,
      { resourceId: options.id, path: pathValidation.value, sourceFile },
    );
  }

  // If replacing and the path moved, drop the previous file under the old
  // path so the on-disk tree matches the declared manifest exactly. We
  // intentionally remove only the previous file — not the entire previous
  // directory — to avoid clobbering unrelated siblings. The previous path
  // was symlink-checked above.
  if (existingById && existingById.path !== pathValidation.value) {
    const previousAbsolute = path.join(resourcesDir, existingById.path);
    try {
      await fs.rm(previousAbsolute, { force: true });
    } catch {
      // Tolerated — the next reconcile will surface drift if needed.
    }
  }

  // Capture git version identity from the destination now that the file
  // lives in the plan directory. For a freshly written file this is
  // typically null (no HEAD blob matches yet); a non-null result means the
  // exact bytes already appear at that path in HEAD.
  const gitVersion = captureResourceGitVersion(destination);
  metadata = { ...metadata, git_commit: gitVersion.git_commit, git_path: gitVersion.git_path };

  const replaced = Boolean(existingById);
  const nextResources = replaced
    ? manifest.resources.map((r) => (r.id === options.id ? metadata : r))
    : [...manifest.resources, metadata];

  try {
    await writeResourceManifest(planDir, { resources: nextResources });
  } catch (err) {
    failFromUnexpected(err);
  }

  await commitIfShadow(
    ctx.shadow,
    "plan-resource-add",
    plan.ref,
    `${replaced ? "replaced" : "added"} ${metadata.id} (${metadata.path})`,
  );

  emitSuccess(
    { resource: metadata, replaced },
    replaced
      ? `Replaced plan resource ${metadata.id} on ${plan.ref} (${metadata.path}, ${metadata.bytes} bytes)`
      : `Added plan resource ${metadata.id} to ${plan.ref} (${metadata.path}, ${metadata.bytes} bytes)`,
  );
  process.exit(EXIT_SUCCESS);
}

// ── list ────────────────────────────────────────────────────────────────────

function registerPlanResourceListCommand(resource: Command): void {
  resource
    .command("list <plan-ref>")
    .description("List plan-owned resources")
    .option("--json", "Output as JSON")
    .action(async (planRef: string) => {
      try {
        const { plan, ctx } = await resolvePlanOrFail(planRef);
        const planDir = getPlanDir(ctx, plan.ulid);
        const manifest = await loadResourceManifest(planDir);
        const lines = manifest.resources.map(
          (r) => `  ${r.id}  (${r.path}, ${r.bytes} bytes, ${r.content_type})`,
        );
        emitSuccess(
          { resources: manifest.resources },
          manifest.resources.length === 0
            ? `No resources declared on ${plan.ref}.`
            : `Resources on ${plan.ref}:\n${lines.join("\n")}`,
        );
      } catch (err) {
        failFromUnexpected(err);
      }
    });
}

// ── get ─────────────────────────────────────────────────────────────────────

function registerPlanResourceGetCommand(resource: Command): void {
  resource
    .command("get <plan-ref> <resource-id>")
    .description("Show details for one plan resource")
    .option("--json", "Output as JSON")
    .action(async (planRef: string, resourceId: string) => {
      try {
        const idValidation = validateResourceId(resourceId);
        if (!idValidation.ok) {
          failPlanResource(EXIT_VALIDATION, "invalid_resource_id", idValidation.error, {
            resourceId,
          });
        }
        const { plan, ctx } = await resolvePlanOrFail(planRef);
        const planDir = getPlanDir(ctx, plan.ulid);
        const manifest = await loadResourceManifest(planDir);
        const match = manifest.resources.find((r) => r.id === resourceId);
        if (!match) {
          failPlanResource(
            EXIT_VALIDATION,
            "resource_not_found",
            `Resource "${resourceId}" not found on plan ${plan.ref}.`,
            { resourceId },
          );
        }
        const lines = [
          `Resource ${match.id}`,
          `  Path:         ${match.path}`,
          `  Size:         ${match.bytes} bytes`,
          `  Content type: ${match.content_type}`,
          `  SHA-256:      ${match.sha256}`,
        ];
        if (match.label) lines.push(`  Label:        ${match.label}`);
        if (match.description) lines.push(`  Description:  ${match.description}`);
        if (match.git_commit) {
          lines.push(
            `  Git commit:   ${match.git_commit}${match.git_path ? ` (${match.git_path})` : ""}`,
          );
        }
        emitSuccess({ resource: match }, lines.join("\n"));
      } catch (err) {
        failFromUnexpected(err);
      }
    });
}

// ── remove ──────────────────────────────────────────────────────────────────

interface PlanResourceRemoveOptions {
  force?: boolean;
  json?: boolean;
}

function registerPlanResourceRemoveCommand(resource: Command): void {
  markMutating(resource.command("remove <plan-ref> <resource-id>"))
    .description("Remove a plan resource (manifest entry and file)")
    .option("--force", "Skip confirmation prompt")
    .option("--json", "Output as JSON")
    .action(async (planRef: string, resourceId: string, options: PlanResourceRemoveOptions) => {
      try {
        const idValidation = validateResourceId(resourceId);
        if (!idValidation.ok) {
          failPlanResource(EXIT_VALIDATION, "invalid_resource_id", idValidation.error, {
            resourceId,
          });
        }
        const { ctx, plan } = await resolvePlanOrFail(planRef);
        const planDir = getPlanDir(ctx, plan.ulid);
        const resourcesDir = getResourcesDir(planDir);
        const manifest = await loadResourceManifest(planDir);
        const match = manifest.resources.find((r) => r.id === resourceId);
        if (!match) {
          failPlanResource(
            EXIT_VALIDATION,
            "resource_not_found",
            `Resource "${resourceId}" not found on plan ${plan.ref}.`,
            { resourceId },
          );
        }

        // Defend against pre-existing symlinks on the file chain before
        // any destructive action — including the confirmation prompt.
        // The manifest entry is trusted text but the on-disk path may
        // have been hand-edited or seeded by a hostile bundle. Without
        // this gate, a `<resourcesDir>/sub` symlink to an outside tree
        // would let `fs.rm(path.join(resourcesDir, "sub/leak.txt"))`
        // delete arbitrary files reachable through that symlink. Doing
        // the gate before the prompt avoids a "yes, delete" answer that
        // would otherwise become an unintended outside-file deletion.
        const safeFile = await assertSafeResourceMutationPath({
          ownerResourcesDir: resourcesDir,
          relativePath: match.path,
        });
        if (!safeFile.ok) {
          failPlanResource(EXIT_VALIDATION, "invalid_resource_path", safeFile.error, {
            resourceId,
            path: match.path,
          });
        }

        if (!options.force) {
          // Spec contract:
          //   non-interactive without --force → confirmation_required (exit 1)
          //   interactive answered no         → operation_cancelled (exit 2)
          // JSON mode does not by itself imply non-interactive — automation
          // can opt into the prompt loop by leaving stdin attached.
          if (!isInteractiveStdin()) {
            failPlanResource(
              EXIT_VALIDATION,
              "confirmation_required",
              `Non-interactive environment; pass --force to remove plan resource ${resourceId}.`,
              { resourceId, path: match.path },
            );
          }
          const confirmed = await promptYesNo(
            `Remove plan resource ${resourceId} from ${plan.ref}?`,
          );
          if (!confirmed) {
            failPlanResource(
              EXIT_CANCELLED,
              "operation_cancelled",
              `Removal of plan resource ${resourceId} cancelled.`,
              { resourceId, path: match.path },
            );
          }
        }

        try {
          await fs.rm(safeFile.value.absolutePath, { force: true });
        } catch (err) {
          failFromUnexpected(err);
        }

        const nextResources = manifest.resources.filter((r) => r.id !== resourceId);
        try {
          await writeResourceManifest(planDir, { resources: nextResources });
        } catch (err) {
          failFromUnexpected(err);
        }

        await commitIfShadow(
          ctx.shadow,
          "plan-resource-remove",
          plan.ref,
          `${resourceId} (${match.path})`,
        );

        emitSuccess(
          { removed: { id: resourceId, path: match.path } },
          `Removed plan resource ${resourceId} from ${plan.ref}.`,
        );
        process.exit(EXIT_SUCCESS);
      } catch (err) {
        failFromUnexpected(err);
      }
    });
}
