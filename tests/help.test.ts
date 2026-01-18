// AC: @auto-cli-docs ac-1, ac-2, ac-3, ac-4, ac-5
import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import {
  extractCommandTree,
  findCommand,
  flattenCommandTree,
  formatCommandUsage,
} from '../src/cli/introspection.js';

describe('extractCommandTree', () => {
  it('should extract basic command metadata', () => {
    const program = new Command()
      .name('test')
      .description('Test program')
      .version('1.0.0');

    const tree = extractCommandTree(program);

    expect(tree.name).toBe('test');
    expect(tree.description).toBe('Test program');
    expect(tree.fullPath).toEqual(['test']);
    expect(tree.aliases).toEqual([]);
    expect(tree.subcommands).toEqual([]);
  });

  it('should extract command with options', () => {
    const program = new Command()
      .name('test')
      .option('-v, --verbose', 'Verbose output')
      .option('-f, --force', 'Force operation', false);

    const tree = extractCommandTree(program);

    expect(tree.options).toHaveLength(2);
    expect(tree.options[0].flags).toBe('-v, --verbose');
    expect(tree.options[0].description).toBe('Verbose output');
    expect(tree.options[1].flags).toBe('-f, --force');
    expect(tree.options[1].description).toBe('Force operation');
  });

  it('should extract command with arguments', () => {
    const program = new Command().name('test').argument('<file>', 'Input file');

    const tree = extractCommandTree(program);

    expect(tree.arguments).toHaveLength(1);
    expect(tree.arguments[0].name).toBe('file');
    expect(tree.arguments[0].description).toBe('Input file');
    expect(tree.arguments[0].required).toBe(true);
  });

  it('should extract command with subcommands', () => {
    const program = new Command().name('test');

    program.command('add').description('Add something').option('-f, --force', 'Force');

    program.command('list').description('List items');

    const tree = extractCommandTree(program);

    expect(tree.subcommands).toHaveLength(2);
    expect(tree.subcommands[0].name).toBe('add');
    expect(tree.subcommands[0].description).toBe('Add something');
    expect(tree.subcommands[0].fullPath).toEqual(['test', 'add']);
    expect(tree.subcommands[0].options).toHaveLength(1);

    expect(tree.subcommands[1].name).toBe('list');
    expect(tree.subcommands[1].description).toBe('List items');
  });

  it('should extract nested subcommands', () => {
    const program = new Command().name('test');

    const task = program.command('task').description('Task operations');
    task.command('add').description('Add task');
    task.command('list').description('List tasks');

    const tree = extractCommandTree(program);

    expect(tree.subcommands).toHaveLength(1);
    expect(tree.subcommands[0].name).toBe('task');
    expect(tree.subcommands[0].subcommands).toHaveLength(2);
    expect(tree.subcommands[0].subcommands[0].fullPath).toEqual(['test', 'task', 'add']);
  });
});

describe('findCommand', () => {
  it('should find top-level command', () => {
    const program = new Command().name('test');
    program.command('add').description('Add');

    const tree = extractCommandTree(program);
    const found = findCommand(tree, ['add']);

    expect(found).not.toBeNull();
    expect(found?.name).toBe('add');
  });

  it('should find nested command', () => {
    const program = new Command().name('test');
    const task = program.command('task');
    task.command('add').description('Add task');

    const tree = extractCommandTree(program);
    const found = findCommand(tree, ['task', 'add']);

    expect(found).not.toBeNull();
    expect(found?.name).toBe('add');
    expect(found?.fullPath).toEqual(['test', 'task', 'add']);
  });

  it('should return null for non-existent command', () => {
    const program = new Command().name('test');
    const tree = extractCommandTree(program);
    const found = findCommand(tree, ['nonexistent']);

    expect(found).toBeNull();
  });

  it('should return root when path is empty', () => {
    const program = new Command().name('test');
    const tree = extractCommandTree(program);
    const found = findCommand(tree, []);

    expect(found).not.toBeNull();
    expect(found?.name).toBe('test');
  });
});

describe('flattenCommandTree', () => {
  it('should flatten tree with nested commands', () => {
    const program = new Command().name('test');
    program.command('add').description('Add');
    const task = program.command('task');
    task.command('start').description('Start task');
    task.command('stop').description('Stop task');

    const tree = extractCommandTree(program);
    const flattened = flattenCommandTree(tree);

    // Should have: test, add, task, start, stop
    expect(flattened).toHaveLength(5);
    expect(flattened.map((c) => c.name)).toEqual(['test', 'add', 'task', 'start', 'stop']);
  });
});

describe('formatCommandUsage', () => {
  it('should format simple command', () => {
    const tree = extractCommandTree(new Command().name('test'));
    const usage = formatCommandUsage(tree);
    expect(usage).toBe('kspec');
  });

  it('should format command with required argument', () => {
    const program = new Command().name('test').argument('<file>', 'File');
    const tree = extractCommandTree(program);
    const usage = formatCommandUsage(tree);
    expect(usage).toBe('kspec <file>');
  });

  it('should format command with optional argument', () => {
    const program = new Command().name('test').argument('[file]', 'File');
    const tree = extractCommandTree(program);
    const usage = formatCommandUsage(tree);
    expect(usage).toBe('kspec [file]');
  });

  it('should format command with options', () => {
    const program = new Command().name('test').option('-v, --verbose');
    const tree = extractCommandTree(program);
    const usage = formatCommandUsage(tree);
    expect(usage).toBe('kspec [options]');
  });

  it('should format subcommand correctly', () => {
    const program = new Command().name('test');
    const add = program.command('add').argument('<title>').option('-f, --force');

    const tree = extractCommandTree(program);
    const addTree = tree.subcommands[0];
    const usage = formatCommandUsage(addTree);

    expect(usage).toBe('kspec add <title> [options]');
  });

  it('should format nested subcommand with full path', () => {
    const program = new Command().name('test');
    const task = program.command('task');
    const add = task.command('add').argument('<title>');

    const tree = extractCommandTree(program);
    const addTree = tree.subcommands[0].subcommands[0];
    const usage = formatCommandUsage(addTree);

    expect(usage).toBe('kspec task add <title>');
  });
});

describe('help command integration', () => {
  it('should auto-generate subcommand lists', () => {
    // This tests AC-5: New subcommands appear automatically
    const program = new Command().name('test');

    // Add some subcommands
    program.command('add').description('Add item');
    program.command('list').description('List items');

    const tree = extractCommandTree(program);

    expect(tree.subcommands).toHaveLength(2);
    expect(tree.subcommands.map((c) => c.name)).toContain('add');
    expect(tree.subcommands.map((c) => c.name)).toContain('list');

    // Now add a new subcommand - it should appear automatically
    program.command('delete').description('Delete item');

    const updatedTree = extractCommandTree(program);
    expect(updatedTree.subcommands).toHaveLength(3);
    expect(updatedTree.subcommands.map((c) => c.name)).toContain('delete');
  });
});
