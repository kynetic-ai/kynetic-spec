/**
 * Agent Runtime module.
 *
 * Provides the core building blocks for per-invocation agent lifecycle:
 * session creation, ACP agent spawn, prompt delivery, event logging,
 * timeout handling, and structured completion tracking.
 */

export {
  runInvocation,
  InvocationTimeoutError,
  type InvocationOptions,
  type InvocationResult,
} from "./invocation.js";

export {
  resolveSkills,
  buildPromptWithSkills,
  type ResolvedSkill,
  type BuildPromptOptions,
} from "./prompts.js";

export {
  DispatchEngine,
  type DispatchEngineOptions,
  type TaskStateChange,
  type TaskStatus,
} from "./dispatch.js";

export {
  ActionExecutor,
  resolveTemplateVars,
  extractTemplateVars,
  validateActionTemplates,
  extractActionTemplates,
  KNOWN_EVENT_FIELDS,
  type ActionEventContext,
  type ActionRunEvent,
  type ActionExecutorOptions,
  type NotifyBroadcast,
  type AgentSpawner,
  type TemplateValidationWarning,
} from "./action-executor.js";

export {
  EventBus,
  type EventBusOptions,
  type EventEnvelope,
  type EventSourceType,
  type EmitOptions,
  type EmitResult,
  type SubscriptionPattern,
  type EventHandler,
} from "./event-bus.js";
