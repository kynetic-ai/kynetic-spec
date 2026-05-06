/**
 * Re-exports the canonical PidFileManager and KSPEC_NO_DAEMON helper from
 * the shared daemon endpoint module so the CLI and the daemon package
 * share one implementation.
 *
 * The shared module lives at src/daemon-shared/ rather than src/daemon/ so
 * its tsc output (dist/daemon-shared/) is owned exclusively by tsc and
 * never collides with scripts/build-daemon.cjs's rebuild of dist/daemon/.
 * That separation prevents a concurrent ERR_MODULE_NOT_FOUND race when
 * tests run `npm run build:daemon` while other CLI subprocesses load
 * pid-utils.
 */

export {
  PidFileManager,
  isNoDaemonModeEnabled,
  resolveDaemonClientEndpoint,
  isExternallyReachable,
} from "../daemon-shared/endpoint.js";
export type { DaemonClientEndpoint } from "../daemon-shared/endpoint.js";
