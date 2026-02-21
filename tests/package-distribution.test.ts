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
  // AC: @package-distribution ac-1
  describe('templates/ directory exists in package root', () => {
    it('templates/ directory exists', async () => {
      const templatesPath = path.join(PACKAGE_ROOT, 'templates');
      const stats = await fs.stat(templatesPath);
      expect(stats.isDirectory()).toBe(true);
    });
  });

  // AC: @package-distribution ac-2
  describe('templates/ contains required subdirectories', () => {
    it('contains skills/ subdirectory', async () => {
      const skillsPath = path.join(PACKAGE_ROOT, 'templates', 'skills');
      const stats = await fs.stat(skillsPath);
      expect(stats.isDirectory()).toBe(true);
    });

    it('contains agents-sections/ subdirectory', async () => {
      const agentsSectionsPath = path.join(PACKAGE_ROOT, 'templates', 'agents-sections');
      const stats = await fs.stat(agentsSectionsPath);
      expect(stats.isDirectory()).toBe(true);
    });

    it('contains hooks/ subdirectory', async () => {
      const hooksPath = path.join(PACKAGE_ROOT, 'templates', 'hooks');
      const stats = await fs.stat(hooksPath);
      expect(stats.isDirectory()).toBe(true);
    });
  });

  // AC: @package-distribution ac-3
  describe('skills/ contains core skill content', () => {
    it('contains manifest.yaml with core skill definitions', async () => {
      const manifestPath = path.join(PACKAGE_ROOT, 'templates', 'skills', 'manifest.yaml');
      const content = await fs.readFile(manifestPath, 'utf-8');
      expect(content).toContain('skills:');
    });

    it('contains at least one core skill directory', async () => {
      const skillsPath = path.join(PACKAGE_ROOT, 'templates', 'skills');
      const entries = await fs.readdir(skillsPath, { withFileTypes: true });
      const skillDirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.'));
      expect(skillDirs.length).toBeGreaterThan(0);
    });

    it('kspec-help skill has SKILL.md content', async () => {
      const skillMdPath = path.join(PACKAGE_ROOT, 'templates', 'skills', 'kspec-help', 'SKILL.md');
      const content = await fs.readFile(skillMdPath, 'utf-8');
      expect(content.length).toBeGreaterThan(0);
      expect(content).toContain('kspec');
    });
  });

  // AC: @package-distribution ac-4
  describe('hooks/ contains pre-commit hook source', () => {
    it('pre-commit hook file exists', async () => {
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

  describe('package.json files field includes templates', () => {
    it('package.json files array includes templates', async () => {
      const packageJsonPath = path.join(PACKAGE_ROOT, 'package.json');
      const content = await fs.readFile(packageJsonPath, 'utf-8');
      const pkg = JSON.parse(content);
      expect(pkg.files).toContain('templates');
    });
  });
});
