/**
 * Re-exports PidFileManager from the shared module. scripts/build-daemon.cjs
 * replaces this shim with a sibling-relative import at staging time so the
 * bundled daemon does not reach back into src/.
 *
 * The shared source lives at src/daemon-shared/ rather than src/daemon/ so
 * tsc and scripts/build-daemon.cjs do not contend for ownership of
 * dist/daemon/. See src/cli/pid-utils.ts for the rationale.
 */

export {
  PidFileManager,
  isNoDaemonModeEnabled,
} from "../../../src/daemon-shared/endpoint.js";
