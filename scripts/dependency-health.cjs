const fs = require('fs');
const path = require('path');

function readPackageJson(rootDir, fsApi = fs, pathApi = path) {
  const packageJsonPath = pathApi.join(rootDir, 'package.json');
  if (!fsApi.existsSync(packageJsonPath)) {
    return null;
  }

  try {
    return JSON.parse(fsApi.readFileSync(packageJsonPath, 'utf8'));
  } catch {
    return null;
  }
}

function collectDirectDependencies(packageJson) {
  if (!packageJson || typeof packageJson !== 'object') {
    return [];
  }

  const sections = [
    packageJson.dependencies,
    packageJson.devDependencies,
    packageJson.optionalDependencies,
  ];
  const names = new Set();
  for (const section of sections) {
    if (!section || typeof section !== 'object') {
      continue;
    }
    for (const name of Object.keys(section)) {
      names.add(name);
    }
  }
  return [...names].sort();
}

function packageInstallPath(nodeModulesDir, packageName, pathApi = path) {
  return pathApi.join(nodeModulesDir, ...packageName.split('/'));
}

function checkProjectDependencies(rootDir, options = {}) {
  const fsApi = options.fsApi || fs;
  const pathApi = options.pathApi || path;
  const packageJson = readPackageJson(rootDir, fsApi, pathApi);
  const lockfilePath = pathApi.join(rootDir, 'package-lock.json');
  const nodeModules = pathApi.join(rootDir, 'node_modules');

  if (!fsApi.existsSync(lockfilePath) || !packageJson) {
    return { ok: true, directDependencies: [], missingPackages: [] };
  }

  if (!fsApi.existsSync(nodeModules)) {
    return {
      ok: false,
      reason: 'node_modules/ not found',
      directDependencies: collectDirectDependencies(packageJson),
      missingPackages: [],
    };
  }

  const directDependencies = collectDirectDependencies(packageJson);
  const missingPackages = directDependencies.filter((packageName) => (
    !fsApi.existsSync(packageInstallPath(nodeModules, packageName, pathApi))
  ));

  if (missingPackages.length > 0) {
    return {
      ok: false,
      reason: `node_modules missing direct dependencies: ${missingPackages.slice(0, 3).join(', ')}`,
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
