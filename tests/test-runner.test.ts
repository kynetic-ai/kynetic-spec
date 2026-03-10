import { describe, expect, it } from 'vitest';

const { checkDependencies, checkBuild, preTestHooks, postTestHooks } = require('../scripts/test.cjs');

describe('test runner environment checks', () => {
  // AC: @test-suite-perf-reliability ac-5
  it('checkDependencies returns ok when node_modules and vitest exist', () => {
    // The test suite is running, so node_modules must exist
    const result = checkDependencies();
    expect(result.ok).toBe(true);
  });

  // AC: @test-suite-perf-reliability ac-5
  it('checkBuild returns ok when dist/cli/index.js exists', () => {
    // global-setup ensures dist/ exists before tests run
    const result = checkBuild();
    expect(result.ok).toBe(true);
  });

  // AC: @test-suite-perf-reliability ac-6
  it('exposes preTestHooks array with dependencies and build hooks', () => {
    expect(preTestHooks).toBeInstanceOf(Array);
    expect(preTestHooks.length).toBeGreaterThanOrEqual(2);

    const names = preTestHooks.map((h: { name: string }) => h.name);
    expect(names).toContain('dependencies');
    expect(names).toContain('build');
  });

  // AC: @test-suite-perf-reliability ac-6
  it('exposes postTestHooks array for extensibility', () => {
    expect(postTestHooks).toBeInstanceOf(Array);
  });

  // AC: @test-suite-perf-reliability ac-6
  it('each preTestHook has name, check, and fix functions', () => {
    for (const hook of preTestHooks) {
      expect(hook).toHaveProperty('name');
      expect(typeof hook.name).toBe('string');
      expect(typeof hook.check).toBe('function');
      expect(typeof hook.fix).toBe('function');
    }
  });

  // AC: @test-suite-perf-reliability ac-5
  it('build hook has skip function that reads SKIP_BUILD env', () => {
    const buildHook = preTestHooks.find((h: { name: string }) => h.name === 'build');
    expect(buildHook).toBeDefined();
    expect(typeof buildHook.skip).toBe('function');

    // Without env var set, skip returns false
    const origVal = process.env.SKIP_BUILD;
    delete process.env.SKIP_BUILD;
    expect(buildHook.skip()).toBe(false);

    // With env var set, skip returns true
    process.env.SKIP_BUILD = '1';
    expect(buildHook.skip()).toBe(true);

    // Restore
    if (origVal !== undefined) {
      process.env.SKIP_BUILD = origVal;
    } else {
      delete process.env.SKIP_BUILD;
    }
  });
});
