import { commitIfShadow, type ShadowConfig } from "./parser/shadow.js";

export interface MutationCacheCapability {
  writeThrough(domain: string, hint?: unknown): Promise<void>;
}

export interface MutationPubSubCapability {
  broadcast(
    topic: string,
    event: string,
    data: Record<string, unknown>,
    projectPath?: string,
  ): void;
}

export type MutationCommitCapability = (
  shadow: ShadowConfig | null,
  operation: string,
  ref?: string,
  detail?: string,
  verbose?: boolean,
) => Promise<boolean>;

export interface MutationWriteThroughDescriptor {
  domain: string;
  hint?: unknown;
}

export interface MutationEventDescriptor {
  topic: string;
  event: string;
  data: Record<string, unknown>;
}

export interface MutationCommitDescriptor {
  operation: string;
  ref?: string;
  detail?: string;
  verbose?: boolean;
}

export interface MutationPipelineOptions {
  shadow?: ShadowConfig | null;
  cache?: MutationCacheCapability | null;
  pubsub?: MutationPubSubCapability | null;
  projectPath?: string;
  commit?: MutationCommitCapability;
}

export interface MutationOperation<T> {
  apply: () => Promise<T> | T;
  commit: MutationCommitDescriptor;
  writeThrough?:
    | MutationWriteThroughDescriptor[]
    | ((result: T) => MutationWriteThroughDescriptor[] | Promise<MutationWriteThroughDescriptor[]>);
  events?:
    | MutationEventDescriptor[]
    | ((result: T) => MutationEventDescriptor[] | Promise<MutationEventDescriptor[]>);
}

export class MutationPipeline {
  constructor(private readonly options: MutationPipelineOptions = {}) {}

  async run<T>(operation: MutationOperation<T>): Promise<T> {
    const result = await operation.apply();
    const commit = this.options.commit ?? commitIfShadow;

    await commit(
      this.options.shadow ?? null,
      operation.commit.operation,
      operation.commit.ref,
      operation.commit.detail,
      operation.commit.verbose,
    );

    const writeThrough =
      typeof operation.writeThrough === "function"
        ? await operation.writeThrough(result)
        : (operation.writeThrough ?? []);
    if (this.options.cache) {
      for (const descriptor of writeThrough) {
        await this.options.cache.writeThrough(descriptor.domain, descriptor.hint);
      }
    }

    const events =
      typeof operation.events === "function"
        ? await operation.events(result)
        : (operation.events ?? []);
    if (this.options.pubsub) {
      for (const descriptor of events) {
        this.options.pubsub.broadcast(
          descriptor.topic,
          descriptor.event,
          descriptor.data,
          this.options.projectPath,
        );
      }
    }

    return result;
  }
}

export function createMutationPipeline(options: MutationPipelineOptions = {}): MutationPipeline {
  return new MutationPipeline(options);
}
