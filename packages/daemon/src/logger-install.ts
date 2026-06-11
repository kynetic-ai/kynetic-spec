/**
 * Side-effect module: installs the daemon console tee at module load with
 * built-in defaults (~/.config/kspec/daemon.log, 5 MiB rotation cap).
 *
 * MUST be the first import in the daemon entry point (index.ts). ES module
 * evaluation order guarantees this module runs before server.js →
 * routes/command.js, so the command-route console interceptors capture the
 * tee'd console functions as their originals and command output is never
 * double-logged. See installDaemonConsoleTee in ./logger.js.
 *
 * AC: @daemon-log-capture ac-detached-output-captured
 */

import { DaemonLogWriter, installDaemonConsoleTee } from "./logger.js";
import { getDaemonLogPath } from "./pid.js";

installDaemonConsoleTee(new DaemonLogWriter({ logPath: getDaemonLogPath() }));
