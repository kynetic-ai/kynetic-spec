import path from 'node:path';
import { describe, expect, it } from 'vitest';

const {
  checkKspecCliWithDeps,
  checkNodeModulesWithDeps,
  loadShadowBootstrapConfigWithDeps,
  resolveShadowBootstrapActionWithDeps,
} = require('../scripts/bootstrap.cjs');

function makeRunStub(responses: Record<string, { success: boolean; output: string }>) {
  return (cmd: string) => responses[cmd] ?? { success: false, output: '' };
}

describe('bootstrap checkKspecCli link detection', () => {
  it('returns not linked when global kspec is not linked to local dist', () => {
    const projectRoot = '/workspace';
    const distCli = path.join(projectRoot, 'dist', 'cli', 'index.js');
    const globalBin = path.join('/usr/local', 'bin', 'kspec');

    // AC: @bootstrap-script ac-1
    const status = checkKspecCliWithDeps({
      commandExistsFn: () => true,
      runFn: makeRunStub({
        'kspec --version': { success: true, output: '0.9.0\n' },
        'npm prefix -g': { success: true, output: '/usr/local\n' },
      }),
      fsApi: {
        existsSync: (target: string) => target === distCli || target === globalBin,
        realpathSync: (target: string) =>
          target === distCli
            ? '/workspace/dist/cli/index.js'
            : '/usr/local/lib/node_modules/kspec/dist/cli/index.js',
        readFileSync: () => '',
      },
      pathApi: path,
      platform: 'linux',
      projectRootPath: projectRoot,
    });

    expect(status).toMatchObject({
      available: true,
      linked: false,
      reason: 'kspec is not npm-linked to local project',
      version: '0.9.0',
    });
  });

  it('returns not linked when local dist is not built yet', () => {
    const projectRoot = '/workspace';

    // AC: @bootstrap-script ac-2
    const status = checkKspecCliWithDeps({
      commandExistsFn: () => true,
      runFn: makeRunStub({
        'kspec --version': { success: true, output: '0.9.0\n' },
      }),
      fsApi: {
        existsSync: () => false,
        realpathSync: () => '',
        readFileSync: () => '',
      },
      pathApi: path,
      platform: 'linux',
      projectRootPath: projectRoot,
    });

    expect(status).toMatchObject({
      available: true,
      linked: false,
      reason: 'local dist not built yet',
      version: '0.9.0',
    });
  });

  it('returns linked when global symlink resolves to local dist on unix', () => {
    const projectRoot = '/workspace';
    const distCli = path.join(projectRoot, 'dist', 'cli', 'index.js');
    const globalBin = path.join('/usr/local', 'bin', 'kspec');

    // AC: @bootstrap-script ac-3
    const status = checkKspecCliWithDeps({
      commandExistsFn: () => true,
      runFn: makeRunStub({
        'kspec --version': { success: true, output: '0.9.0\n' },
        'npm prefix -g': { success: true, output: '/usr/local\n' },
      }),
      fsApi: {
        existsSync: (target: string) => target === distCli || target === globalBin,
        realpathSync: () => '/workspace/dist/cli/index.js',
        readFileSync: () => '',
      },
      pathApi: path,
      platform: 'linux',
      projectRootPath: projectRoot,
    });

    expect(status).toMatchObject({
      available: true,
      linked: true,
      version: '0.9.0',
    });
  });

  it('follows unix realpath-based symlink resolution for global bin', () => {
    const projectRoot = '/workspace';
    const distCli = path.join(projectRoot, 'dist', 'cli', 'index.js');
    const globalBin = path.join('/usr/local', 'bin', 'kspec');
    const realpathCalls: string[] = [];

    const status = checkKspecCliWithDeps({
      commandExistsFn: () => true,
      runFn: makeRunStub({
        'kspec --version': { success: true, output: '0.9.0\n' },
        'npm prefix -g': { success: true, output: '/usr/local\n' },
      }),
      fsApi: {
        existsSync: (target: string) => target === distCli || target === globalBin,
        realpathSync: (target: string) => {
          realpathCalls.push(target);
          return '/workspace/dist/cli/index.js';
        },
        readFileSync: () => '',
      },
      pathApi: path,
      platform: 'linux',
      projectRootPath: projectRoot,
    });

    expect(status.linked).toBe(true);
    expect(realpathCalls).toEqual([distCli, globalBin]);
  });
});

describe('bootstrap shadow recovery command selection', () => {
  // AC: @broken-shadow-safety ac-bootstrap-reuses-repair
  it('uses shadow repair when the shadow branch exists but .kspec is missing', () => {
    const action = resolveShadowBootstrapActionWithDeps({
      dirStatus: { exists: false, healthy: false },
      shadowConfig: {
        branch: 'kspec-meta',
        directory: '.kspec',
        remote: null,
        remoteType: null,
      },
      runFn: makeRunStub({
        "git branch --list 'kspec-meta'": { success: true, output: '  kspec-meta\n' },
      }),
      kspecCmd: 'kspec',
    });

    expect(action).toMatchObject({
      kind: 'repair',
      command: 'kspec shadow repair',
    });
  });

  it('uses init when no shadow branch exists yet', () => {
    const action = resolveShadowBootstrapActionWithDeps({
      dirStatus: { exists: false, healthy: false },
      shadowConfig: {
        branch: 'kspec-meta',
        directory: '.kspec',
        remote: null,
        remoteType: null,
      },
      runFn: makeRunStub({
        "git branch --list 'kspec-meta'": { success: true, output: '' },
        "git remote get-url 'origin'": { success: false, output: '' },
      }),
      kspecCmd: 'node dist/cli/index.js',
    });

    expect(action).toMatchObject({
      kind: 'init',
      command: 'node dist/cli/index.js init --no-prompt',
    });
  });

  it('uses shadow repair when the configured remote already has the shadow branch', () => {
    const action = resolveShadowBootstrapActionWithDeps({
      dirStatus: { exists: false, healthy: false },
      shadowConfig: {
        branch: 'kspec-meta',
        directory: '.kspec',
        remote: 'specs-origin',
        remoteType: 'named',
      },
      runFn: makeRunStub({
        "git branch --list 'kspec-meta'": { success: true, output: '' },
        "git remote get-url 'specs-origin'": {
          success: true,
          output: 'git@example.com/specs.git\n',
        },
        "git ls-remote --heads 'specs-origin' 'kspec-meta'": {
          success: true,
          output: 'abc123\trefs/heads/kspec-meta\n',
        },
      }),
      kspecCmd: 'kspec',
    });

    expect(action).toMatchObject({
      kind: 'repair',
      command: 'kspec shadow repair',
    });
  });
});

describe('bootstrap shadow config parsing', () => {
  it('loads branch, directory, and remote from kspec.config.yaml', () => {
    const status = loadShadowBootstrapConfigWithDeps({
      fsApi: {
        existsSync: (target: string) => target === '/workspace/kspec.config.yaml',
        readFileSync: () => [
          'shadow:',
          '  branch: specs-meta',
          '  directory: .shadow-spec',
          '  remote: specs-origin',
        ].join('\n'),
      },
      pathApi: path,
      projectRootPath: '/workspace',
    });

    expect(status).toEqual({
      branch: 'specs-meta',
      directory: '.shadow-spec',
      remote: 'specs-origin',
      remoteType: 'named',
    });
  });
});

describe('bootstrap dependency checks', () => {
  it('detects missing direct dependencies from package.json, not just legacy sentinel packages', () => {
    const status = checkNodeModulesWithDeps({
      projectRootPath: '/workspace',
      fsApi: {
        existsSync: (target: string) => {
          const existing = new Set([
            '/workspace/package.json',
            '/workspace/package-lock.json',
            '/workspace/node_modules',
            '/workspace/node_modules/zod',
          ]);
          return existing.has(target);
        },
        readFileSync: () => JSON.stringify({
          dependencies: {
            zod: '^3.0.0',
            croner: '^10.0.0',
          },
        }),
      },
      pathApi: path,
    });

    expect(status).toMatchObject({
      installed: false,
      reason: expect.stringContaining('croner'),
    });
  });
});
