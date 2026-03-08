/**
 * Tests for package distribution - ensuring templates/ directory is properly
 * included in the npm package with all required subdirectories and content.
 *
 * AC: @package-distribution ac-1 - templates/ directory included in npm pack
 * AC: @package-distribution ac-2 - templates/ contains skills/, agents-sections/, hooks/
 * AC: @package-distribution ac-3 - kspec skill install-core finds templates
 * AC: @package-distribution ac-4 - pre-commit hook source file included
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';

// Package root directory (where templates/ lives)
const PACKAGE_ROOT = path.resolve(__dirname, '..');

describe('Package Distribution', () => {
  // AC: @package-distribution ac-1 (templates/ present and readable — verified by reading files below)
  // AC: @package-distribution ac-2 (skills/, agents-sections/, hooks/ present — verified by reading from each)
  // AC: @package-distribution ac-3
  describe('skills/ contains core skill content', () => {
    it('contains manifest.yaml with core skill definitions', async () => {
      // AC: @package-distribution ac-1
      // AC: @package-distribution ac-2
      const manifestPath = path.join(PACKAGE_ROOT, 'templates', 'skills', 'manifest.yaml');
      const content = await fs.readFile(manifestPath, 'utf-8');
      expect(content).toContain('skills:');
    });

    it('help skill has SKILL.md content', async () => {
      const skillMdPath = path.join(PACKAGE_ROOT, 'templates', 'skills', 'help', 'SKILL.md');
      const content = await fs.readFile(skillMdPath, 'utf-8');
      expect(content.length).toBeGreaterThan(0);
      expect(content).toContain('kspec');
    });
  });

  // AC: @package-distribution ac-2 (hooks/ subdirectory verified by hook content tests)
  // AC: @package-distribution ac-4
  describe('hooks/ contains pre-commit hook source', () => {
    it('pre-commit hook file exists', async () => {
      // AC: @package-distribution ac-2
      // AC: @package-distribution ac-4
      const preCommitPath = path.join(PACKAGE_ROOT, 'templates', 'hooks', 'pre-commit');
      const stats = await fs.stat(preCommitPath);
      expect(stats.isFile()).toBe(true);
    });

    it('pre-commit hook contains kspec-meta branch protection', async () => {
      const preCommitPath = path.join(PACKAGE_ROOT, 'templates', 'hooks', 'pre-commit');
      const content = await fs.readFile(preCommitPath, 'utf-8');
      expect(content).toContain('kspec-meta');
      expect(content).toContain('KSPEC_SHADOW_COMMIT');
    });

    it('pre-commit hook is a valid shell script', async () => {
      const preCommitPath = path.join(PACKAGE_ROOT, 'templates', 'hooks', 'pre-commit');
      const content = await fs.readFile(preCommitPath, 'utf-8');
      expect(content.startsWith('#!/bin/sh') || content.startsWith('#!/bin/bash')).toBe(true);
    });
  });

  describe('agents-sections/ contains markdown templates', () => {
    it('contains markdown template files', async () => {
      // AC: @package-distribution ac-2
      const sectionsPath = path.join(PACKAGE_ROOT, 'templates', 'agents-sections');
      const entries = await fs.readdir(sectionsPath);
      const mdFiles = entries.filter(f => f.endsWith('.md'));
      expect(mdFiles.length).toBeGreaterThan(0);
    });

    it('template files are named with numeric prefixes for ordering', async () => {
      const sectionsPath = path.join(PACKAGE_ROOT, 'templates', 'agents-sections');
      const entries = await fs.readdir(sectionsPath);
      const mdFiles = entries.filter(f => f.endsWith('.md'));
      // All files should start with two digits and a dash
      for (const file of mdFiles) {
        expect(file).toMatch(/^\d{2}-/);
      }
    });
  });

  describe('package.json files field includes templates and plugin', () => {
    it('package.json files array includes templates', async () => {
      // AC: @package-distribution ac-1
      const packageJsonPath = path.join(PACKAGE_ROOT, 'package.json');
      const content = await fs.readFile(packageJsonPath, 'utf-8');
      const pkg = JSON.parse(content);
      expect(pkg.files).toContain('templates');
    });

    // AC: @package-distribution ac-5
    it('package.json files array includes plugin', async () => {
      const packageJsonPath = path.join(PACKAGE_ROOT, 'package.json');
      const content = await fs.readFile(packageJsonPath, 'utf-8');
      const pkg = JSON.parse(content);
      expect(pkg.files).toContain('plugin');
    });
  });

  describe('published root package includes daemon runtime dependencies', () => {
    it('declares @elysiajs/static for global installs', async () => {
      // AC: @web-ui ac-1
      const packageJsonPath = path.join(PACKAGE_ROOT, 'package.json');
      const content = await fs.readFile(packageJsonPath, 'utf-8');
      const pkg = JSON.parse(content);

      expect(pkg.dependencies?.['@elysiajs/cors']).toBeTruthy();
      expect(pkg.dependencies?.['@elysiajs/static']).toBeTruthy();
      expect(pkg.dependencies?.elysia).toBeTruthy();
    });
  });

  // AC: @package-distribution ac-5
  describe('plugin/ directory contains valid plugin structure', () => {
    it('plugin/.claude-plugin/plugin.json exists with correct version', async () => {
      const pluginJsonPath = path.join(PACKAGE_ROOT, 'plugin', '.claude-plugin', 'plugin.json');
      const content = await fs.readFile(pluginJsonPath, 'utf-8');
      const pluginJson = JSON.parse(content);

      // Version should match package.json
      const packageJsonPath = path.join(PACKAGE_ROOT, 'package.json');
      const pkg = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'));

      expect(pluginJson.name).toBe('kspec');
      expect(pluginJson.version).toBe(pkg.version);
      expect(pluginJson.description).toBeTruthy();
    });

    it('plugin/plugins/kspec/skills/ contains SKILL.md for each core skill', async () => {
      // Read manifest to know which skills should exist
      const yaml = await import('yaml');
      const manifestPath = path.join(PACKAGE_ROOT, 'templates', 'skills', 'manifest.yaml');
      const manifest = yaml.parse(await fs.readFile(manifestPath, 'utf-8'));

      for (const skill of manifest.skills) {
        const skillMdPath = path.join(PACKAGE_ROOT, 'plugin', 'plugins', 'kspec', 'skills', skill.id, 'SKILL.md');
        const content = await fs.readFile(skillMdPath, 'utf-8');
        expect(content).toContain('---');
        expect(content).toContain('<!-- kspec-managed -->');
      }
    });
  });

  // AC: @package-distribution ac-6
  describe('plugin/.claude-plugin/marketplace.json is valid', () => {
    it('marketplace.json exists with valid schema and kspec plugin entry', async () => {
      const marketplacePath = path.join(PACKAGE_ROOT, 'plugin', '.claude-plugin', 'marketplace.json');
      const content = await fs.readFile(marketplacePath, 'utf-8');
      const marketplace = JSON.parse(content);

      expect(marketplace.name).toBe('kspec-plugins');
      expect(marketplace.description).toBeTruthy();
      expect(marketplace.owner).toBeDefined();
      expect(Array.isArray(marketplace.plugins)).toBe(true);
      expect(marketplace.plugins.length).toBeGreaterThan(0);

      // Verify kspec plugin entry
      const kspecPlugin = marketplace.plugins.find((p: { name: string }) => p.name === 'kspec');
      expect(kspecPlugin).toBeDefined();
      expect(kspecPlugin.source).toMatch(/^\.\//); // relative path starting with ./
      expect(kspecPlugin.version).toBeTruthy();

      // Version should match package.json
      const packageJsonPath = path.join(PACKAGE_ROOT, 'package.json');
      const pkg = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'));
      expect(kspecPlugin.version).toBe(pkg.version);
    });
  });
});
