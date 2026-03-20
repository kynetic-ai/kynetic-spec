import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PidFileManager } from "../src/cli/pid-utils";
import { cleanupTempDir, createIsolatedKspecHome, createTempDir, initGitRepo, kspec } from "./helpers/cli";

describe("KSPEC_NO_DAEMON", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    initGitRepo(tempDir);
    mkdirSync(join(tempDir, ".kspec"), { recursive: true });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @multi-directory-daemon ac-32
  it("suppresses incidental daemon detection when KSPEC_NO_DAEMON is truthy", () => {
    const pidManager = new PidFileManager(join(tempDir, ".daemon-config"));
    pidManager.writePid();

    process.env.KSPEC_NO_DAEMON = "1";

    expect(pidManager.isDaemonRunning()).toBe(false);
    expect(pidManager.isDaemonRunning({ ignoreNoDaemon: true })).toBe(true);
  });

  // AC: @multi-directory-daemon ac-33
  it("allows explicit serve status to ignore KSPEC_NO_DAEMON", async () => {
    const isolatedHome = await createIsolatedKspecHome(tempDir);
    writeFileSync(isolatedHome.daemonPidFilePath, `${process.pid}\n`, "utf-8");

    const result = kspec(`serve status --json --kspec-dir ${join(tempDir, ".kspec")}`, tempDir, {
      env: isolatedHome.env,
    });
    const status = JSON.parse(result.stdout) as {
      running: boolean;
      pid: number | null;
      port: number | null;
    };

    expect(status.running).toBe(true);
    expect(status.pid).toBe(process.pid);
    expect(status.port).toBeNull();
  });
});
