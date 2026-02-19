/**
 * Tests for Enhanced Setup Command
 *
 * AC: @enhanced-setup ac-1 through ac-9
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import {
  kspec,
  kspecJson,
  createTempDir,
  cleanupTempDir,
  initGitRepo,
} from './helpers/cli.js';
import { SHADOW_WORKTREE_DIR } from '../src/parser/shadow.js';

describe('kspec setup (enhanced)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir('kspec-enhanced-setup-');
    initGitRepo(tempDir);

    // Create initial commit
    await fs.writeFile(path.join(tempDir, 'README.md'), '# Test', 'utf-8');
    execSync('git add README.md && git commit -m "Initial"', {
      cwd: tempDir,
      stdio: 'pipe',
    });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  describe('--status flag', () => {
    // AC: @enhanced-setup ac-7 - --status reports current state including agent detected
    it('should report agent detection', async () => {
      // Run with CLAUDECODE env var to simulate Claude Code
      const result = kspec('setup --status', tempDir, {
        env: { CLAUDECODE: '1' },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Agent:');
      expect(result.stdout).toContain('claude-code');
    });

    // AC: @enhanced-setup ac-7 - --status reports current state
    it('should report unknown agent when no env vars set', async () => {
      const result = kspec('setup --status', tempDir, {
        env: { CLAUDECODE: '', CLINE_ACTIVE: '', AIDER_MODEL: '' },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Agent:');
    });

    // AC: @enhanced-setup ac-8 - hooks status shown
    it('should report hooks status', async () => {
      const result = kspec('setup --status', tempDir, {
        env: { CLAUDECODE: '1' },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Hooks:');
      expect(result.stdout).toContain('UserPromptSubmit:');
      expect(result.stdout).toContain('Stop:');
      expect(result.stdout).toContain('PreToolUse:');
    });

    // AC: @enhanced-setup ac-8 - skills rendered count shown
    it('should report skills status', async () => {
      const result = kspec('setup --status', tempDir, {
        env: { CLAUDECODE: '1' },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Skills:');
      expect(result.stdout).toContain('Rendered:');
    });

    // AC: @enhanced-setup ac-8 - agents.md freshness shown
    it('should report agents.md status', async () => {
      const result = kspec('setup --status', tempDir, {
        env: { CLAUDECODE: '1' },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('kspec-agents.md:');
      expect(result.stdout).toContain('Status:');
    });

    // AC: @enhanced-setup ac-8 - JSON output includes all status info
    it('should return structured status in JSON mode', async () => {
      const result = kspecJson<{
        agent: { detected: string; confidence: string };
        hooks: { promptCheck: boolean; stop: boolean; preToolUse: boolean };
        skills: { rendered: number };
        agentsMd: { exists: boolean; status: string };
      }>('setup --status', tempDir, {
        env: { CLAUDECODE: '1' },
      });

      expect(result.agent).toBeDefined();
      expect(result.agent.detected).toBe('claude-code');
      expect(result.hooks).toBeDefined();
      expect(result.skills).toBeDefined();
      expect(result.agentsMd).toBeDefined();
    });
  });

  describe('--dry-run flag', () => {
    // AC: @enhanced-setup ac-6 - --dry-run displays planned actions without making changes
    it('should display planned actions', async () => {
      const result = kspec('setup --dry-run', tempDir, {
        env: { CLAUDECODE: '1' },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('DRY RUN');
      expect(result.stdout).toContain('Agent detection');
    });

    // AC: @enhanced-setup ac-6 - no changes made
    it('should not create any files', async () => {
      kspec('setup --dry-run', tempDir, {
        env: { CLAUDECODE: '1' },
      });

      // Check that .claude directory was not created
      const claudeDirExists = await fs.access(path.join(tempDir, '.claude'))
        .then(() => true)
        .catch(() => false);
      expect(claudeDirExists).toBe(false);
    });

    // AC: @trait-dry-run ac-6 - JSON output includes dry_run field
    it('should include dry_run in JSON output', async () => {
      const result = kspecJson<{ dry_run: boolean }>('setup --dry-run', tempDir, {
        env: { CLAUDECODE: '1' },
      });

      expect(result.dry_run).toBe(true);
    });
  });

  describe('--skip-skills flag', () => {
    // AC: @enhanced-setup ac-5 - --skip-skills flag skips skill rendering
    it('should skip skill rendering when flag is set', async () => {
      const result = kspec('setup --dry-run --skip-skills', tempDir, {
        env: { CLAUDECODE: '1' },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Render skills');
      expect(result.stdout).toContain('skipped');
      expect(result.stdout).toContain('--skip-skills flag');
    });
  });

  describe('setup orchestration', () => {
    beforeEach(async () => {
      // Initialize kspec project
      kspec('init --name test-project --no-prompt', tempDir);
    });

    // AC: @enhanced-setup ac-1 - summary displayed listing each step performed
    it('should display summary of all steps performed', async () => {
      const result = kspec('setup --dry-run', tempDir, {
        env: { CLAUDECODE: '1' },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('kspec Setup Summary');
      expect(result.stdout).toContain('Agent detection');
      expect(result.stdout).toContain('Install hooks');
      expect(result.stdout).toContain('Render skills');
      expect(result.stdout).toContain('Generate kspec-agents.md');
    });

    // AC: @enhanced-setup ac-2 - all hook entries present
    // AC: @full-hook-install ac-1 - UserPromptSubmit hook entry is written
    // AC: @full-hook-install ac-2 - Stop hook entry is present
    // AC: @full-hook-install ac-3 - PreToolUse Bash hook entries are present
    it('should install all required hooks', async () => {
      kspec('setup', tempDir, {
        env: { CLAUDECODE: '1' },
      });

      // Check settings.json
      const settingsPath = path.join(tempDir, '.claude', 'settings.json');
      const settingsContent = await fs.readFile(settingsPath, 'utf-8');
      const settings = JSON.parse(settingsContent);

      expect(settings.hooks).toBeDefined();
      // AC: @full-hook-install ac-1
      expect(settings.hooks.UserPromptSubmit).toBeDefined();
      // AC: @full-hook-install ac-2
      expect(settings.hooks.Stop).toBeDefined();
      // AC: @full-hook-install ac-3
      expect(settings.hooks.PreToolUse).toBeDefined();

      // Verify PreToolUse has Bash matcher for worktree guard
      const preToolUse = settings.hooks.PreToolUse;
      const bashEntry = preToolUse.find((entry: { matcher: string }) => entry.matcher === 'Bash');
      expect(bashEntry).toBeDefined();
    });

    // AC: @enhanced-setup ac-2 - PreToolUse guards installed
    // AC: @full-hook-install ac-5 - ralph task-limit guard is generated
    it('should create guard scripts in .claude/hooks/', async () => {
      kspec('setup', tempDir, {
        env: { CLAUDECODE: '1' },
      });

      // Check for guard scripts
      const hooksDir = path.join(tempDir, '.claude', 'hooks');
      const guards = await fs.readdir(hooksDir);

      expect(guards).toContain('kspec-worktree-guard.sh');
      // AC: @full-hook-install ac-5
      expect(guards).toContain('ralph-task-limit-guard.sh');

      // Check scripts are executable
      const guardPath = path.join(hooksDir, 'kspec-worktree-guard.sh');
      const stats = await fs.stat(guardPath);
      expect((stats.mode & 0o111) !== 0).toBe(true); // Has execute permission
    });

    // AC: @full-hook-install ac-4 - worktree guard uses dynamic path detection
    it('should use dynamic path detection in worktree guard', async () => {
      kspec('setup', tempDir, {
        env: { CLAUDECODE: '1' },
      });

      // Read the worktree guard script
      const guardPath = path.join(tempDir, '.claude', 'hooks', 'kspec-worktree-guard.sh');
      const content = await fs.readFile(guardPath, 'utf-8');

      // Should use dynamic CWD from hook input, not hardcoded paths
      expect(content).toContain('CWD=$(echo "$INPUT" | jq -r');
      expect(content).toContain('.cwd');
      // Should not contain hardcoded absolute paths like /home/user/project
      expect(content).not.toMatch(/\/home\/[a-zA-Z]+\/[^\s"']*/);
      expect(content).not.toMatch(/\/Users\/[a-zA-Z]+\/[^\s"']*/);
    });

    // AC: @guard-script-and-diff-quality ac-1
    it('should not block commands where dangerous patterns appear only inside quotes', async () => {
      kspec('setup', tempDir, {
        env: { CLAUDECODE: '1' },
      });

      const guardPath = path.join(tempDir, '.claude', 'hooks', 'kspec-worktree-guard.sh');

      // Helper to run guard script with a command, simulating being inside .kspec
      const runGuard = (command: string) => {
        const input = JSON.stringify({
          tool_input: { command },
          cwd: path.join(tempDir, '.kspec'),
        });
        const result = execSync(
          `echo '${input.replace(/'/g, "'\\''")}' | bash "${guardPath}"`,
          { encoding: 'utf-8', cwd: tempDir }
        );
        return JSON.parse(result);
      };

      // These should be ALLOWED — dangerous patterns are inside quotes
      expect(runGuard('echo "git reset"')).toEqual({ decision: 'allow' });
      expect(runGuard("grep 'git stash' README.md")).toEqual({ decision: 'allow' });
      expect(runGuard('echo "testing git rebase command"')).toEqual({ decision: 'allow' });

      // These should still be BLOCKED — actual dangerous commands
      expect(runGuard('git reset --hard')).toHaveProperty('decision', 'block');
      expect(runGuard('git stash')).toHaveProperty('decision', 'block');
      expect(runGuard('git rebase main')).toHaveProperty('decision', 'block');
    });

    // AC: @enhanced-setup ac-4 - kspec-agents.md exists
    it('should generate kspec-agents.md', async () => {
      kspec('setup', tempDir, {
        env: { CLAUDECODE: '1' },
      });

      const agentsMdPath = path.join(tempDir, 'kspec-agents.md');
      const exists = await fs.access(agentsMdPath)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);

      const content = await fs.readFile(agentsMdPath, 'utf-8');
      expect(content).toContain('Generated by kspec');
      expect(content).toContain('kspec Agent Instructions');
    });

    // AC: @enhanced-setup ac-4 - freshness hash stored
    it('should store freshness hash for kspec-agents.md', async () => {
      kspec('setup', tempDir, {
        env: { CLAUDECODE: '1' },
      });

      const hashPath = path.join(tempDir, '.kspec', '.kspec-agents-hash');
      const exists = await fs.access(hashPath)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);

      const content = await fs.readFile(hashPath, 'utf-8');
      const hash = JSON.parse(content);
      expect(hash.metaHash).toBeDefined();
      expect(hash.generatedAt).toBeDefined();
    });
  });

  describe('skill rendering', () => {
    beforeEach(async () => {
      // Initialize kspec project
      kspec('init --name test-project --no-prompt', tempDir);

      // Add a skill
      kspec('skill add --id test-skill --name "Test Skill" --description "A test skill"', tempDir);

      // Write skill content
      const skillMdPath = path.join(tempDir, '.kspec', 'skills', 'test-skill', 'SKILL.md');
      await fs.writeFile(skillMdPath, '# Test Skill\n\nThis is a test skill.', 'utf-8');
    });

    // AC: @enhanced-setup ac-3 - rendered skill files exist
    it('should render skills to .claude/skills/', async () => {
      kspec('setup', tempDir, {
        env: { CLAUDECODE: '1' },
      });

      // Check skill was rendered
      const renderedPath = path.join(tempDir, '.claude', 'skills', 'test-skill', 'SKILL.md');
      const exists = await fs.access(renderedPath)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);

      const content = await fs.readFile(renderedPath, 'utf-8');
      expect(content).toContain('<!-- kspec-managed -->');
      expect(content).toContain('name: test-skill');
    });

    // AC: @enhanced-setup ac-5 - --skip-skills flag
    it('should not render skills when --skip-skills is set', async () => {
      kspec('setup --skip-skills', tempDir, {
        env: { CLAUDECODE: '1' },
      });

      // Check skill was NOT rendered
      const renderedPath = path.join(tempDir, '.claude', 'skills', 'test-skill', 'SKILL.md');
      const exists = await fs.access(renderedPath)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(false);
    });
  });

  describe('no-hooks flag', () => {
    beforeEach(async () => {
      kspec('init --name test-project --no-prompt', tempDir);
    });

    it('should skip hooks installation when --no-hooks is set', async () => {
      const result = kspec('setup --no-hooks --dry-run', tempDir, {
        env: { CLAUDECODE: '1' },
      });

      expect(result.stdout).toContain('Install hooks');
      expect(result.stdout).toContain('skipped');
      expect(result.stdout).toContain('--no-hooks flag');
    });
  });

  describe('idempotency', () => {
    beforeEach(async () => {
      kspec('init --name test-project --no-prompt', tempDir);
    });

    // Running setup multiple times should be safe
    it('should be idempotent', async () => {
      // First run
      const result1 = kspec('setup', tempDir, {
        env: { CLAUDECODE: '1' },
      });
      expect(result1.exitCode).toBe(0);

      // Second run
      const result2 = kspec('setup', tempDir, {
        env: { CLAUDECODE: '1' },
      });
      expect(result2.exitCode).toBe(0);

      // Check hooks are still correct (not duplicated)
      const settingsPath = path.join(tempDir, '.claude', 'settings.json');
      const settings = JSON.parse(await fs.readFile(settingsPath, 'utf-8'));

      // Should only have one UserPromptSubmit entry
      const promptHooks = settings.hooks.UserPromptSubmit as Array<unknown>;
      expect(promptHooks.length).toBe(1);
    });
  });
});
