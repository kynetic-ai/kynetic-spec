#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");
const esbuild = require("esbuild");

const projectRoot = path.dirname(__dirname);
const distRoot = path.join(projectRoot, "dist");
const stageDir = path.join(distRoot, "daemon-src");
const outDir = path.join(distRoot, "daemon");
const daemonSourceDir = path.join(projectRoot, "packages", "daemon", "src");
const entityCacheSource = path.join(projectRoot, "src", "daemon", "entity-cache.ts");
const shadowSyncManagerSource = path.join(projectRoot, "src", "daemon", "shadow-sync-manager.ts");
const endpointSource = path.join(projectRoot, "src", "daemon-shared", "endpoint.ts");
const parserIndexDist = path.join(distRoot, "parser", "index.js");

function collectTypeScriptFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTypeScriptFiles(fullPath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      files.push(fullPath);
    }
  }

  return files;
}

async function main() {
  if (!fs.existsSync(parserIndexDist)) {
    childProcess.execFileSync(
      process.execPath,
      [path.join(projectRoot, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"],
      {
        cwd: projectRoot,
        stdio: "inherit",
      },
    );
  }

  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });

  fs.cpSync(daemonSourceDir, stageDir, { recursive: true });
  fs.copyFileSync(entityCacheSource, path.join(stageDir, "entity-cache.ts"));
  // Overwrite the re-export shims from packages/daemon/src/ with the real implementations
  fs.copyFileSync(shadowSyncManagerSource, path.join(stageDir, "shadow-sync-manager.ts"));
  fs.copyFileSync(endpointSource, path.join(stageDir, "endpoint.ts"));
  // Replace the pid.ts shim with a sibling re-export so it does not reach back into src/
  fs.writeFileSync(
    path.join(stageDir, "pid.ts"),
    'export { PidFileManager, isNoDaemonModeEnabled, getDaemonLogPath, DAEMON_LOG_FILENAME, DEFAULT_DAEMON_LOG_MAX_SIZE_BYTES } from "./endpoint.js";\n',
    "utf-8",
  );

  const entryPoints = collectTypeScriptFiles(stageDir);

  await esbuild.build({
    entryPoints,
    outdir: outDir,
    outbase: stageDir,
    bundle: false,
    format: "esm",
    platform: "node",
    target: "node20",
    sourcemap: true,
    logLevel: "info",
  });
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(stageDir, { recursive: true, force: true });
  });
