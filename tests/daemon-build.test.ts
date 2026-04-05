import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(import.meta.dirname, "..");
const daemonEntry = path.join(projectRoot, "dist", "daemon", "index.js");

function runCommand(command: string, args: string[]) {
  return spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 120_000,
  });
}

describe("daemon build pipeline", () => {
  // AC: @daemon-runtime-adapter ac-runtime-selection
  it("build:daemon emits compiled JavaScript artifacts", () => {
    const result = runCommand("npm", ["run", "build:daemon"]);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("error");
    expect(fs.existsSync(daemonEntry)).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, "dist", "daemon", "entity-cache.js"))).toBe(true);
  });

  // AC: @daemon-runtime-adapter ac-runtime-selection
  it("compiled daemon entrypoint runs under node and bun without a TypeScript loader", () => {
    const buildResult = runCommand("npm", ["run", "build:daemon"]);
    expect(buildResult.status).toBe(0);

    const nodeResult = runCommand("node", [daemonEntry, "--port", "0"]);
    expect(nodeResult.status).toBe(1);
    expect(nodeResult.stderr).toContain("Invalid port number");

    const bunResult = runCommand("bun", [daemonEntry, "--port", "0"]);
    expect(bunResult.status).toBe(1);
    expect(bunResult.stderr).toContain("Invalid port number");
  });
});
