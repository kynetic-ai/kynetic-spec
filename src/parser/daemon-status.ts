/**
 * Daemon status utilities
 *
 * Extracted from serve.ts to avoid CLI module dependency for doctor.ts.
 * Provides daemon status information without output formatting.
 *
 * AC: @doctor-command ac-daemon-running, ac-daemon-not-running, ac-daemon-unreachable
 */

import { PidFileManager } from "../cli/pid-utils.js";

/**
 * Daemon status information
 */
export interface DaemonStatus {
  /** Whether daemon process is running */
  running: boolean;
  /** Daemon process PID */
  pid: number | null;
  /** Daemon port */
  port: number | null;
  /** Daemon uptime in seconds */
  uptime: number | null;
  /** Whether health endpoint is reachable */
  healthReachable: boolean;
  /** Error message if status check failed */
  error?: string;
}

/**
 * Get daemon status information.
 *
 * Checks PID file, verifies process is running, reads port,
 * and probes health endpoint.
 *
 * AC: @doctor-command ac-daemon-running — returns running status with PID/port/uptime
 * AC: @doctor-command ac-daemon-not-running — returns running=false when not running
 * AC: @doctor-command ac-daemon-unreachable — returns healthReachable=false when endpoint unreachable
 */
export async function getDaemonStatus(): Promise<DaemonStatus> {
  const pidManager = new PidFileManager();
  const running = pidManager.isDaemonRunning();
  const pid = pidManager.readPid();

  const status: DaemonStatus = {
    running,
    pid,
    port: null,
    uptime: null,
    healthReachable: false,
  };

  if (!running) {
    return status;
  }

  // Read port from file
  try {
    status.port = pidManager.readPort();
  } catch {
    // Port file might not exist or be invalid
    status.port = null;
  }

  // Probe health endpoint if we have a port
  // AC: @doctor-command ac-daemon-unreachable
  if (status.port) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);

      const response = await fetch(`http://localhost:${status.port}/api/health`, {
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.ok) {
        status.healthReachable = true;
        const data = (await response.json()) as { status: string; uptime: number };
        if (typeof data.uptime === "number") {
          status.uptime = data.uptime;
        }
      }
    } catch {
      // Health endpoint not reachable - daemon may be starting up or port conflict
      status.healthReachable = false;
    }
  }

  return status;
}
