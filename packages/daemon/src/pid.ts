/**
 * Re-exports PidFileManager from the shared module. scripts/build-daemon.cjs
 * replaces this shim with a sibling-relative import at staging time so the
 * bundled daemon does not reach back into src/.
 */

export { PidFileManager, isNoDaemonModeEnabled } from "../../../src/daemon/endpoint.js";
