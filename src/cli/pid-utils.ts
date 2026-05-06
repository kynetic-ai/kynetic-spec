/**
 * Re-exports the canonical PidFileManager and KSPEC_NO_DAEMON helper from
 * the shared daemon endpoint module so the CLI and the daemon package
 * share one implementation.
 */

export {
  PidFileManager,
  isNoDaemonModeEnabled,
  resolveDaemonClientEndpoint,
  isExternallyReachable,
} from "../daemon/endpoint.js";
export type { DaemonClientEndpoint } from "../daemon/endpoint.js";
