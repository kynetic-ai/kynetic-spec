import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import { initContext, type KspecContext } from "../parser/yaml.js";
import { DISPATCH_CONTROL_FILE, parseDispatchControl } from "../parser/index.js";
import type { DispatchControl } from "../schema/dispatch-control.js";
import { acquireFileLock, type FileLockAcquireInfo } from "../parser/file-lock.js";
import { commitIfShadow } from "../parser/shadow.js";
import { getDispatchShadowMutationLockPath, rollbackDirtyShadowWorktree } from "./workspace.js";

const execFileAsync = promisify(execFile);

export interface DispatchShadowTransactionContext {
  projectDir: string;
  operation: string;
  context: KspecContext;
  specDir: string;
  pre_head: string;
  pre_snapshot: DispatchControl;
  acquireInfo: FileLockAcquireInfo;
  committed_oid: string | null;
}

export interface DispatchShadowTransactionPaths {
  dispatchControlPath: string;
  expectedBytes: string;
  proposedSnapshot: DispatchControl;
}

export interface CommittedDispatchControl {
  validatedSnapshot: DispatchControl;
  revision: number;
  commit_oid: string;
  bytes: string;
}

export class DispatchShadowTransactionError extends Error {
  constructor(
    readonly code: "control_commit_failed" | "control_verification_failed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DispatchShadowTransactionError";
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    encoding: "utf-8",
  });
  return result.stdout.toString();
}

async function readHead(specDir: string): Promise<string> {
  return (await git(specDir, ["rev-parse", "HEAD"])).trim();
}

export async function readCommittedDispatchControl(
  specDir: string,
  commitOid = "HEAD",
): Promise<{ snapshot: DispatchControl; bytes: string; commit_oid: string }> {
  const resolvedHead = commitOid === "HEAD" ? await readHead(specDir) : commitOid;
  try {
    const bytes = await git(specDir, ["show", `${resolvedHead}:${DISPATCH_CONTROL_FILE}`]);
    return {
      snapshot: parseDispatchControl(bytes),
      bytes,
      commit_oid: resolvedHead,
    };
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    if (
      stderr.includes("does not exist in") ||
      stderr.includes("exists on disk, but not in") ||
      stderr.includes("path 'dispatch-control.yaml' does not exist")
    ) {
      const { createMissingDispatchControl } = await import("../schema/dispatch-control.js");
      return {
        snapshot: createMissingDispatchControl(),
        bytes: "",
        commit_oid: resolvedHead,
      };
    }
    throw error;
  }
}

async function restorePreHead(ctx: DispatchShadowTransactionContext): Promise<void> {
  await git(ctx.specDir, ["reset", "--hard", ctx.pre_head]);
  await git(ctx.specDir, ["clean", "-fd"]);
}

export async function withDispatchShadowTransaction<T>(
  projectDir: string,
  operation: string,
  fn: (ctx: DispatchShadowTransactionContext) => Promise<T>,
): Promise<T> {
  const lockPath = getDispatchShadowMutationLockPath(projectDir);
  const timeoutMs = Number(process.env.KSPEC_SHADOW_MUTATION_LOCK_TIMEOUT_MS || 5000);
  const release = await acquireFileLock(lockPath, { timeoutMs });
  let transactionContext: DispatchShadowTransactionContext | undefined;
  try {
    if (release.info.forceReclaimed) {
      await rollbackDirtyShadowWorktree(projectDir, operation, release.info);
    }
    const context = await initContext(projectDir);
    if (!context.shadow?.enabled) {
      throw new DispatchShadowTransactionError(
        "control_commit_failed",
        "Dispatch control requires an enabled shadow worktree",
      );
    }
    const preHead = await readHead(context.shadow.worktreeDir);
    const preCommitted = await readCommittedDispatchControl(context.shadow.worktreeDir, preHead);
    transactionContext = {
      projectDir,
      operation,
      context,
      specDir: context.shadow.worktreeDir,
      pre_head: preHead,
      pre_snapshot: preCommitted.snapshot,
      acquireInfo: release.info,
      committed_oid: null,
    };
    return await fn(transactionContext);
  } catch (error) {
    if (transactionContext && transactionContext.committed_oid === null) {
      try {
        await restorePreHead(transactionContext);
      } catch (rollbackError) {
        throw new DispatchShadowTransactionError(
          "control_verification_failed",
          `Dispatch control transaction failed and ${DISPATCH_CONTROL_FILE} could not be restored to ${transactionContext.pre_head}`,
          { cause: new AggregateError([error, rollbackError], "Transaction and rollback failed") },
        );
      }
    }
    throw error;
  } finally {
    await release();
  }
}

export async function commitDispatchShadowTransaction(
  ctx: DispatchShadowTransactionContext,
  paths: DispatchShadowTransactionPaths,
  message: string,
): Promise<CommittedDispatchControl> {
  if (
    path.resolve(paths.dispatchControlPath) !== path.resolve(ctx.specDir, DISPATCH_CONTROL_FILE)
  ) {
    throw new DispatchShadowTransactionError(
      "control_verification_failed",
      "Dispatch control transaction targeted a noncanonical path",
    );
  }
  let committed: boolean;
  try {
    committed = await commitIfShadow(ctx.context.shadow, message);
  } catch (error) {
    await restorePreHead(ctx);
    throw new DispatchShadowTransactionError(
      "control_commit_failed",
      "Dispatch control write could not be committed",
      { cause: error },
    );
  }
  if (!committed) {
    await restorePreHead(ctx);
    throw new DispatchShadowTransactionError(
      "control_commit_failed",
      "Dispatch control write did not produce a committed shadow revision",
    );
  }

  const commitOid = await readHead(ctx.specDir);
  try {
    const committedControl = await readCommittedDispatchControl(ctx.specDir, commitOid);
    const sameSnapshot =
      JSON.stringify(committedControl.snapshot) === JSON.stringify(paths.proposedSnapshot);
    if (committedControl.bytes !== paths.expectedBytes || !sameSnapshot) {
      throw new Error("Committed object does not match the proposed dispatch control bytes");
    }
    ctx.committed_oid = commitOid;
    return {
      validatedSnapshot: committedControl.snapshot,
      revision: committedControl.snapshot.revision,
      commit_oid: commitOid,
      bytes: committedControl.bytes,
    };
  } catch (error) {
    await restorePreHead(ctx);
    throw new DispatchShadowTransactionError(
      "control_verification_failed",
      `Committed ${DISPATCH_CONTROL_FILE} failed verification and was rolled back`,
      { cause: error },
    );
  }
}
