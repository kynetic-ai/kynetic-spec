/**
 * Re-exports the canonical PidFileManager and KSPEC_NO_DAEMON helper from
 * the shared daemon endpoint module so the CLI and the daemon package
 * share one implementation.
 */

export { PidFileManager, isNoDaemonModeEnabled } from "../daemon/endpoint.js";
