const fs = require("fs");
const path = require("path");

function readPackageJson(rootDir, fsApi = fs, pathApi = path) {
  const packageJsonPath = pathApi.join(rootDir, "package.json");
  if (!fsApi.existsSync(packageJsonPath)) {
    return null;
  }

  try {
    return JSON.parse(fsApi.readFileSync(packageJsonPath, "utf8"));
  } catch {
    return null;
  }
}

function collectDirectDependencies(packageJson) {
  if (!packageJson || typeof packageJson !== "object") {
    return [];
  }

  const sections = [
    packageJson.dependencies,
    packageJson.devDependencies,
    packageJson.optionalDependencies,
  ];
  const names = new Set();
  for (const section of sections) {
    if (!section || typeof section !== "object") {
      continue;
    }
    for (const name of Object.keys(section)) {
      names.add(name);
    }
  }
  return [...names].toSorted();
}

function packageInstallPath(nodeModulesDir, packageName, pathApi = path) {
  return pathApi.join(nodeModulesDir, ...packageName.split("/"));
}

function dependencySearchRoot(rootDir, pathApi = path) {
  const normalizedRoot = pathApi.resolve(rootDir);
  const worktreeSegment = `${pathApi.sep}.kspec-worktrees${pathApi.sep}`;
  const markerIndex = normalizedRoot.lastIndexOf(worktreeSegment);
  if (markerIndex === -1) {
    return normalizedRoot;
  }
  return normalizedRoot.slice(0, markerIndex);
}

function packageExistsInAncestorNodeModules(rootDir, packageName, fsApi = fs, pathApi = path) {
  const searchRoot = dependencySearchRoot(rootDir, pathApi);
  let currentDir = pathApi.resolve(rootDir);
  for (;;) {
    if (fsApi.existsSync(packageInstallPath(pathApi.join(currentDir, "node_modules"), packageName))) {
      return true;
    }
    if (currentDir === searchRoot) {
      return false;
    }
    const parentDir = pathApi.dirname(currentDir);
    currentDir = parentDir;
  }
}

function checkProjectDependencies(rootDir, options = {}) {
  const fsApi = options.fsApi || fs;
  const pathApi = options.pathApi || path;
  const hasPackage =
    options.hasPackage ||
    ((dir, packageName) => packageExistsInAncestorNodeModules(dir, packageName, fsApi, pathApi));
  const packageJson = readPackageJson(rootDir, fsApi, pathApi);
  const lockfilePath = pathApi.join(rootDir, "package-lock.json");
  const nodeModules = pathApi.join(rootDir, "node_modules");
  const directDependencies = collectDirectDependencies(packageJson);

  if (!fsApi.existsSync(lockfilePath) || !packageJson) {
    return { ok: true, directDependencies: [], missingPackages: [] };
  }

  const ancestorHasDirectDependencies = directDependencies.some((packageName) =>
    hasPackage(rootDir, packageName),
  );

  if (!fsApi.existsSync(nodeModules) && !ancestorHasDirectDependencies) {
    return {
      ok: false,
      reason: "node_modules/ not found",
      directDependencies,
      missingPackages: [],
    };
  }

  const missingPackages = directDependencies.filter(
    (packageName) =>
      !fsApi.existsSync(packageInstallPath(nodeModules, packageName, pathApi)) &&
      !hasPackage(rootDir, packageName),
  );

  if (missingPackages.length > 0) {
    return {
      ok: false,
      reason: `node_modules missing direct dependencies: ${missingPackages.slice(0, 3).join(", ")}`,
      directDependencies,
      missingPackages,
    };
  }

  return { ok: true, directDependencies, missingPackages: [] };
}

module.exports = {
  checkProjectDependencies,
  collectDirectDependencies,
};
