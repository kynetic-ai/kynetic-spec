/**
 * PID File Management
 *
 * Manages daemon process PID file for lifecycle control.
 * AC: @daemon-server ac-9, ac-10
 */
export declare class PidFileManager {
    private pidFilePath;
    constructor(kspecDir: string);
    /**
     * AC: @daemon-server ac-9
     * Writes current process PID to .kspec/.daemon.pid
     */
    write(): void;
    /**
     * Reads PID from .kspec/.daemon.pid
     * Returns null if file doesn't exist or is invalid
     */
    read(): number | null;
    /**
     * AC: @daemon-server ac-10
     * Removes PID file during graceful shutdown
     */
    remove(): void;
    /**
     * Checks if a process with given PID is running
     */
    isProcessRunning(pid: number): boolean;
    /**
     * Checks if daemon is currently running based on PID file
     */
    isDaemonRunning(): boolean;
}
//# sourceMappingURL=pid.d.ts.map