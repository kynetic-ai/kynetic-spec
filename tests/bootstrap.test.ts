import path from 'node:path';
import { describe, expect, it } from 'vitest';

const { checkKspecCliWithDeps } = require('../scripts/bootstrap.cjs');

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
