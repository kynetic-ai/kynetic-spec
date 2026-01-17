/**
 * Ralph Module
 *
 * Event translation and rendering for the ralph autonomous task loop.
 */

// Event types and translator
export {
  type RalphEvent,
  type RalphEventType,
  type RalphEventData,
  type AgentMessageData,
  type AgentThoughtData,
  type ToolStartData,
  type ToolUpdateData,
  type ToolResultData,
  type StatusData,
  type RalphTranslator,
  createTranslator,
} from './events.js';

// CLI renderer
export { type RalphRenderer, createCliRenderer } from './cli-renderer.js';
