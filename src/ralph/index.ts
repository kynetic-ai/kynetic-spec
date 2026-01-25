/**
 * Ralph Module
 *
 * Event translation and rendering for the ralph autonomous task loop.
 */

// CLI renderer
export {
  createCliRenderer,
  createPrefixedRenderer,
  type RalphRenderer,
} from "./cli-renderer.js";
// Event types and translator
export {
  type AgentMessageData,
  type AgentThoughtData,
  createTranslator,
  type RalphEvent,
  type RalphEventData,
  type RalphEventType,
  type RalphTranslator,
  type StatusData,
  type ToolResultData,
  type ToolStartData,
  type ToolUpdateData,
} from "./events.js";
// Subagent spawning
export {
  buildSubagentPrompt,
  DEFAULT_SUBAGENT_PREFIX,
  DEFAULT_SUBAGENT_TIMEOUT,
  runSubagent,
  type SubagentConfig,
  type SubagentContext,
  type SubagentOptions,
  type SubagentResult,
} from "./subagent.js";
