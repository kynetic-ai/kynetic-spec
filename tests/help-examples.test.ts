// AC: @cli-help-examples ac-1 - Help output includes concrete examples for variadic options
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { kspecOutput as kspec, cleanupTempDir, setupTempFixtures } from './helpers/cli';

describe('CLI help examples for variadic options', () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await setupTempFixtures();
  });

  afterAll(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @cli-help-examples ac-1 - task set shows examples for --depends-on, --refs, --tag
  it('task set --help shows examples for variadic options', () => {
    const output = kspec('task set --help', tempDir);

    // Verify Examples section exists
    expect(output).toContain('Examples:');

    // Verify --depends-on example
    expect(output).toContain('--depends-on @dep1 @dep2');

    // Verify --refs example
    expect(output).toContain('--refs @task1 @task2');

    // Verify --tag example
    expect(output).toContain('--tag cli urgent');
  });

  // AC: @cli-help-examples ac-1 - task complete shows examples for --refs
  it('task complete --help shows examples for --refs', () => {
    const output = kspec('task complete --help', tempDir);

    expect(output).toContain('Examples:');
    expect(output).toContain('--refs @task1 @task2');
    expect(output).toContain('--reason');
  });

  // AC: @cli-help-examples ac-1 - task cancel shows examples for --refs
  it('task cancel --help shows examples for --refs', () => {
    const output = kspec('task cancel --help', tempDir);

    expect(output).toContain('Examples:');
    expect(output).toContain('--refs @task1 @task2');
  });

  // AC: @cli-help-examples ac-1 - task delete shows examples for --refs
  it('task delete --help shows examples for --refs', () => {
    const output = kspec('task delete --help', tempDir);

    expect(output).toContain('Examples:');
    expect(output).toContain('--refs @task1 @task2');
    expect(output).toContain('--force');
    expect(output).toContain('--dry-run');
  });

  // AC: @cli-help-examples ac-1 - task add shows examples for --tag
  it('task add --help shows examples for --tag', () => {
    const output = kspec('task add --help', tempDir);

    expect(output).toContain('Examples:');
    expect(output).toContain('--tag cli urgent');
  });

  // AC: @cli-help-examples ac-1 - meta resolve shows examples for --refs
  it('meta resolve --help shows examples for --refs', () => {
    const output = kspec('meta resolve --help', tempDir);

    expect(output).toContain('Examples:');
    expect(output).toContain('--refs @obs1 @obs2');
    expect(output).toContain('--resolution');
  });

  // AC: @cli-help-examples ac-1 - meta add shows examples for variadic options
  it('meta add --help shows examples for variadic options', () => {
    const output = kspec('meta add --help', tempDir);

    expect(output).toContain('Examples:');
    // Agent example with --capability
    expect(output).toContain('--capability');
    // Convention example with --rule
    expect(output).toContain('--rule');
    // Workflow example with --tag
    expect(output).toContain('--tag');
  });

  // AC: @cli-help-examples ac-1 - item add shows examples for --tag
  it('item add --help shows examples for --tag', () => {
    const output = kspec('item add --help', tempDir);

    expect(output).toContain('Examples:');
    expect(output).toContain('--tag');
  });

  // AC: @cli-help-examples ac-1 - item set shows examples for --tag and --trait
  it('item set --help shows examples for --tag and --trait', () => {
    const output = kspec('item set --help', tempDir);

    expect(output).toContain('Examples:');
    expect(output).toContain('--tag');
    expect(output).toContain('--trait');
  });

  // AC: @cli-help-examples ac-1 - inbox add shows examples for --tag
  it('inbox add --help shows examples for --tag', () => {
    const output = kspec('inbox add --help', tempDir);

    expect(output).toContain('Examples:');
    expect(output).toContain('--tag');
  });

  // AC: @cli-help-examples ac-1 - inbox promote shows examples for --tag
  it('inbox promote --help shows examples for --tag', () => {
    const output = kspec('inbox promote --help', tempDir);

    expect(output).toContain('Examples:');
    expect(output).toContain('--tag');
  });

  // AC: @cli-help-examples ac-1 - module add shows examples for --tag
  it('module add --help shows examples for --tag', () => {
    const output = kspec('module add --help', tempDir);

    expect(output).toContain('Examples:');
    expect(output).toContain('--tag');
  });
});
