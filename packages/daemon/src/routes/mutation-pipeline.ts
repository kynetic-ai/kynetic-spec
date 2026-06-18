import {
  createMutationPipeline,
  type MutationCommitDescriptor,
  type MutationEventDescriptor,
  type MutationWriteThroughDescriptor,
} from "../../mutation-pipeline.js";
import type { KspecContext } from "../../parser/index.js";
import type { PubSubManager } from "../websocket/pubsub.js";
import type { EntityCacheAccessor } from "./entity-cache-types.js";

interface RouteMutationOptions<T> {
  ctx: KspecContext;
  projectPath: string;
  getEntityCache?: EntityCacheAccessor;
  pubsub?: PubSubManager;
  apply: () => Promise<T> | T;
  commit: MutationCommitDescriptor;
  writeThrough?:
    | MutationWriteThroughDescriptor[]
    | ((result: T) => MutationWriteThroughDescriptor[] | Promise<MutationWriteThroughDescriptor[]>);
  events?:
    | MutationEventDescriptor[]
    | ((result: T) => MutationEventDescriptor[] | Promise<MutationEventDescriptor[]>);
}

export async function runRouteMutation<T>(options: RouteMutationOptions<T>): Promise<T> {
  const pipeline = createMutationPipeline({
    shadow: options.ctx.shadow,
    cache: options.getEntityCache?.(options.projectPath) ?? null,
    pubsub: options.pubsub ?? null,
    projectPath: options.projectPath,
  });

  return pipeline.run({
    apply: options.apply,
    commit: options.commit,
    writeThrough: options.writeThrough,
    events: options.events,
  });
}
