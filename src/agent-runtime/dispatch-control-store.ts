import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  createMissingDispatchControl,
  DispatchControlSchema,
  DispatchCleanupStateSchema,
  type DispatchControl,
  type DispatchCleanupState,
} from "../schema/dispatch-control.js";
import { replaceDispatchControlFile } from "../parser/dispatch-control.js";
import {
  commitDispatchShadowTransaction,
  DispatchShadowTransactionError,
  readCommittedDispatchControl,
  type DispatchShadowTransactionContext,
  withDispatchShadowTransaction,
} from "./dispatch-shadow-transaction.js";

const execFileAsync = promisify(execFile);

export interface DispatchControlPublicationToken {
  revision: number;
  commit_oid: string;
}

export interface DispatchControlPublication {
  snapshot: DispatchControl;
  token: DispatchControlPublicationToken;
}

export interface DispatchControlStoreOptions {
  onPublication?: (publication: DispatchControlPublication) => void;
  onDegraded?: (reason: string) => void;
}

export type DispatchControlMutation = (
  current: DispatchControl,
) => DispatchControl | Promise<DispatchControl>;

export type DispatchCleanupSelector =
  | { scope: "all" }
  | { scope: "global" }
  | { scope: "task"; task_id: string };

export function projectDispatchCleanupState(
  control: DispatchControl,
  selector: DispatchCleanupSelector = { scope: "all" },
): DispatchCleanupState {
  const entries = Object.entries(control.pending_cleanup)
    .filter(([key]) => {
      if (selector.scope === "all") return true;
      if (selector.scope === "global") return key === "global";
      return key === selector.task_id;
    })
    .map(([key, entry]) => ({
      cleanup_id: entry.cleanup_id,
      scope: key === "global" ? ("global" as const) : ("task" as const),
      ...(key === "global" ? {} : { task_id: key }),
      status: entry.status,
      phase: entry.phase,
      ...(entry.error_code === undefined ? {} : { error_code: entry.error_code }),
    }))
    .toSorted((left, right) => {
      if (left.scope !== right.scope) return left.scope === "global" ? -1 : 1;
      const taskOrder = (left.task_id ?? "").localeCompare(right.task_id ?? "");
      return taskOrder || left.cleanup_id.localeCompare(right.cleanup_id);
    });
  return DispatchCleanupStateSchema.parse({
    status:
      entries.length === 0
        ? "idle"
        : entries.some((entry) => entry.status === "failed")
          ? "failed"
          : "pending",
    entries,
  });
}

export class DispatchControlStore {
  private publication: DispatchControlPublication | null = null;
  private publicationVerified = false;
  private degradedReason: string | null = null;
  private settledReread: Promise<void> | null = null;
  private readonly publicationListeners = new Map<
    string | symbol,
    NonNullable<DispatchControlStoreOptions["onPublication"]>
  >();
  private readonly degradedListeners = new Map<
    string | symbol,
    NonNullable<DispatchControlStoreOptions["onDegraded"]>
  >();

  constructor(
    readonly projectDir: string,
    options: DispatchControlStoreOptions = {},
  ) {
    this.addListeners(options);
  }

  addListeners(options: DispatchControlStoreOptions): void {
    if (options.onPublication) this.publicationListeners.set(Symbol(), options.onPublication);
    if (options.onDegraded) this.degradedListeners.set(Symbol(), options.onDegraded);
  }

  setPublicationListener(
    key: string,
    listener: NonNullable<DispatchControlStoreOptions["onPublication"]>,
  ): void {
    this.publicationListeners.set(key, listener);
  }

  getPublication(): DispatchControlPublication {
    if (!this.publication) {
      throw new Error("DispatchControlStore has not loaded committed state");
    }
    return this.publication;
  }

  getDegradedReason(): string | null {
    return this.degradedReason;
  }

  async getObservedHead(): Promise<string> {
    const result = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: path.join(this.projectDir, ".kspec"),
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      encoding: "utf-8",
    });
    return result.stdout.toString().trim();
  }

  async observeWorktreeEvent(observedHead: string | null = null): Promise<void> {
    await this.reloadCommitted(observedHead ?? (await this.getObservedHead()));
  }

  async loadCommitted(): Promise<DispatchControlPublication> {
    try {
      const loaded = await withDispatchShadowTransaction(
        this.projectDir,
        "dispatch-control-load",
        async (ctx) => readCommittedDispatchControl(ctx.specDir),
      );
      if (
        !this.publicationVerified ||
        !this.publication ||
        loaded.snapshot.revision > this.publication.token.revision
      ) {
        this.clearDegraded();
        this.publish(loaded.snapshot, loaded.commit_oid);
      }
    } catch (error) {
      this.markDegraded(error);
      if (!this.publication) {
        const head = await this.getObservedHead().catch(() => "unknown");
        this.publication = {
          snapshot: createMissingDispatchControl(),
          token: { revision: 0, commit_oid: head },
        };
        this.publicationVerified = false;
      }
    }
    return this.getPublication();
  }

  async mutate(
    operation: string,
    mutation: DispatchControlMutation,
  ): Promise<DispatchControlPublication> {
    try {
      const committed = await withDispatchShadowTransaction(
        this.projectDir,
        operation,
        async (ctx) => {
          try {
            const current = ctx.pre_snapshot;
            if (this.publication && current.revision < this.publication.token.revision) {
              throw new Error("Committed dispatch control revision is stale");
            }
            const proposed = DispatchControlSchema.parse(await mutation(current));
            if (proposed.revision <= current.revision) {
              throw new Error("Dispatch control revision must increase monotonically");
            }
            const written = await replaceDispatchControlFile(ctx.specDir, proposed);
            const result = await commitDispatchShadowTransaction(
              ctx,
              {
                dispatchControlPath: written.path,
                expectedBytes: written.bytes,
                proposedSnapshot: proposed,
              },
              operation,
            );
            this.publish(result.validatedSnapshot, result.commit_oid);
            return result;
          } catch (error) {
            await this.publishVerifiedPreTransaction(ctx);
            throw error;
          }
        },
      );
      this.clearDegraded();
      return {
        snapshot: committed.validatedSnapshot,
        token: { revision: committed.revision, commit_oid: committed.commit_oid },
      };
    } catch (error) {
      const observedHead = await this.getObservedHead().catch(() => null);
      if (observedHead !== null) {
        await this.reloadCommitted(observedHead);
      }
      if (error instanceof DispatchShadowTransactionError) {
        this.markDegraded(error);
      }
      throw error;
    }
  }

  async reloadCommitted(observedHead: string): Promise<void> {
    let needsSettledReread = false;
    try {
      await withDispatchShadowTransaction(
        this.projectDir,
        "dispatch-control-reload",
        async (ctx) => {
          const currentHead = await this.getObservedHead();
          if (this.publication?.token.commit_oid === currentHead) {
            needsSettledReread = observedHead === currentHead;
            return;
          }
          await this.applyCommittedHead(ctx.specDir, currentHead);
        },
      );
    } catch (error) {
      this.markDegraded(error);
      return;
    }

    if (needsSettledReread && !this.settledReread) {
      this.settledReread = new Promise<void>((resolve) => setImmediate(resolve))
        .then(async () => {
          await withDispatchShadowTransaction(
            this.projectDir,
            "dispatch-control-settled-reload",
            async (ctx) => {
              const currentHead = await this.getObservedHead();
              if (currentHead !== this.publication?.token.commit_oid) {
                await this.applyCommittedHead(ctx.specDir, currentHead);
              }
            },
          );
        })
        .finally(() => {
          this.settledReread = null;
        });
      await this.settledReread.catch((error) => this.markDegraded(error));
    }
  }

  private async applyCommittedHead(specDir: string, commitOid: string): Promise<void> {
    try {
      const loaded = await readCommittedDispatchControl(specDir, commitOid);
      if (
        this.publicationVerified &&
        this.publication &&
        loaded.snapshot.revision <= this.publication.token.revision
      )
        return;
      this.clearDegraded();
      this.publish(loaded.snapshot, loaded.commit_oid);
    } catch (error) {
      this.markDegraded(error);
    }
  }

  private async publishVerifiedPreTransaction(
    ctx: DispatchShadowTransactionContext,
  ): Promise<void> {
    const currentHead = await this.getObservedHead();
    if (currentHead !== ctx.pre_head) return;
    const restored = await readCommittedDispatchControl(ctx.specDir, currentHead);
    if (JSON.stringify(restored.snapshot) !== JSON.stringify(ctx.pre_snapshot)) return;
    if (
      this.publicationVerified &&
      this.publication &&
      restored.snapshot.revision <= this.publication.token.revision
    )
      return;
    this.clearDegraded();
    this.publish(restored.snapshot, restored.commit_oid);
  }

  private publish(snapshot: DispatchControl, commitOid: string): void {
    const next: DispatchControlPublication = {
      snapshot,
      token: { revision: snapshot.revision, commit_oid: commitOid },
    };
    if (
      this.publication?.token.revision === next.token.revision &&
      this.publication.token.commit_oid === next.token.commit_oid
    ) {
      this.publicationVerified = true;
      return;
    }
    this.publication = next;
    this.publicationVerified = true;
    for (const listener of this.publicationListeners.values()) {
      try {
        listener(next);
      } catch (error) {
        console.error("[dispatch-control] Publication listener failed:", error);
      }
    }
  }

  private markDegraded(error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.degradedReason = `control_store_degraded: dispatch-control.yaml: ${detail}`;
    for (const listener of this.degradedListeners.values()) {
      try {
        listener(this.degradedReason);
      } catch (listenerError) {
        console.error("[dispatch-control] Degraded listener failed:", listenerError);
      }
    }
  }

  private clearDegraded(): void {
    this.degradedReason = null;
  }
}

const stores = new Map<string, DispatchControlStore>();

export function getDispatchControlStore(projectDir: string): DispatchControlStore | null {
  return stores.get(projectDir) ?? null;
}

export function getOrCreateDispatchControlStore(
  projectDir: string,
  options?: DispatchControlStoreOptions,
): DispatchControlStore {
  const existing = stores.get(projectDir);
  if (existing) {
    if (options) existing.addListeners(options);
    return existing;
  }
  const store = new DispatchControlStore(projectDir, options);
  stores.set(projectDir, store);
  return store;
}

export function unregisterDispatchControlStore(projectDir: string): void {
  stores.delete(projectDir);
}
