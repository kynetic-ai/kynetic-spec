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
        agent: { detected: string; confidence: string; configPath?: string };
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

    // AC: @droid-agent-detection ac-3
    it('should report droid status with factory config path in JSON mode', async () => {
      const result = kspecJson<{
        agent: { detected: string; confidence: string; configPath?: string };
      }>('setup --status', tempDir, {
        env: {
          FACTORY_PROJECT_DIR: tempDir,
          HOME: tempDir,
          // Clear higher-priority agent env vars so droid detection wins
          CLAUDECODE: '',
          CLAUDE_CODE_ENTRYPOINT: '',
          CLAUDE_PROJECT_DIR: '',
          CLAUDE_CODE: '',
          CODEX_THREAD_ID: '',
          CODEX_SANDBOX: '',
          CODEX_CI: '',
          CODEX_MANAGED_BY_NPM: '',
        },
      });

      expect(result.agent.detected).toBe('droid');
      expect(result.agent.confidence).toBe('high');
      expect(result.agent.configPath).toBe(path.join(tempDir, '.factory', 'settings.json'));
    });

    it('should use --agent override for status without env detection vars', async () => {
      const result = kspec('setup --status --agent claude-code', tempDir, {
        env: { CLAUDECODE: '', CLAUDE_CODE_ENTRYPOINT: '', CLAUDE_PROJECT_DIR: '', CLAUDE_CODE: '' },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Detected: claude-code');
    });

    // AC: @droid-agent-detection ac-6
    // AC: @droid-setup-integration ac-4
    it('should accept droid as a valid setup --agent override', async () => {
      const result = kspecJson<{
        agent: { detected: string; confidence: string; configPath?: string };
      }>('setup --status --agent droid', tempDir, {
        env: { CLAUDECODE: '', CLAUDE_CODE_ENTRYPOINT: '', CLAUDE_PROJECT_DIR: '', CLAUDE_CODE: '', FACTORY_PROJECT_DIR: '', HOME: tempDir },
      });

      expect(result.agent.detected).toBe('droid');
      expect(result.agent.confidence).toBe('high');
      expect(result.agent.configPath).toBe(path.join(tempDir, '.factory', 'settings.json'));
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

    // AC: @enhanced-setup ac-6 - dry-run previews .gitignore updates for sessions directory
    // AC: @session-storage-modes ac-gitignore
    it('should preview .gitignore updates in dry-run mode', async () => {
      // Initialize kspec so .kspec/ exists with .gitignore
      kspec('init --name test-project --no-prompt', tempDir);

      // Remove .kspec-sessions/ and its gitignore entries to simulate a pre-sessions state
      const sessionsDir = path.join(tempDir, '.kspec-sessions');
      await fs.rm(sessionsDir, { recursive: true }).catch(() => {});

      // Remove .kspec-sessions/ from root .gitignore
      const rootGitignore = path.join(tempDir, '.gitignore');
      const rootContent = await fs.readFile(rootGitignore, 'utf-8');
      await fs.writeFile(
        rootGitignore,
        rootContent.split('\n').filter((l) => !l.includes('.kspec-sessions')).join('\n'),
        'utf-8',
      );

      // Remove sessions/ from .kspec/.gitignore
      const shadowGitignore = path.join(tempDir, '.kspec', '.gitignore');
      const shadowContent = await fs.readFile(shadowGitignore, 'utf-8');
      await fs.writeFile(
        shadowGitignore,
        shadowContent.split('\n').filter((l) => !l.includes('sessions')).join('\n'),
        'utf-8',
      );

      const result = kspec('setup --dry-run', tempDir, {
        env: { CLAUDECODE: '1' },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('DRY RUN');
      // Verify all three session directory actions are previewed
      expect(result.stdout).toContain('.kspec-sessions/');
      expect(result.stdout).toContain('.gitignore');
      expect(result.stdout).toContain('.kspec/.gitignore');

      // Verify no actual changes were made
      const rootAfter = await fs.readFile(rootGitignore, 'utf-8');
      expect(rootAfter).not.toContain('.kspec-sessions');
      const shadowAfter = await fs.readFile(shadowGitignore, 'utf-8');
      expect(shadowAfter).not.toContain('sessions/');
      const sessionsDirExists = await fs.access(sessionsDir).then(() => true).catch(() => false);
      expect(sessionsDirExists).toBe(false);
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

    it('should run setup with --agent claude-code without CLAUDECODE env var', async () => {
      const result = kspec('setup --dry-run --agent claude-code', tempDir, {
        env: { CLAUDECODE: '', CLAUDE_CODE_ENTRYPOINT: '', CLAUDE_PROJECT_DIR: '', CLAUDE_CODE: '' },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Agent detection');
      expect(result.stdout).toContain('claude-code');
    });

    it('should reject invalid --agent values with clear error', async () => {
      const result = kspec('setup --status --agent not-a-real-agent', tempDir, {
        expectFail: true,
      });

      expect(result.exitCode).toBeGreaterThan(0);
      expect(result.stderr).toContain('Invalid --agent value');
      expect(result.stderr).toContain('Supported values');
    });

    // AC: @enhanced-setup ac-2 - all hook entries present when enabled
    // AC: @full-hook-install ac-1 - UserPromptSubmit hook entry is written
    // AC: @full-hook-install ac-2 - Stop hook entry is present when enabled
    // AC: @full-hook-install ac-3 - PreToolUse Bash hook entries are present
    it('should install all required hooks when enabled via config', async () => {
      // Enable both hooks explicitly (checkpoint defaults to disabled)
      await fs.writeFile(
        path.join(tempDir, 'kspec.config.yaml'),
        `
hooks:
  checkpoint: true
  prompt_check: true
`
      );

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
    // AC: @native-guard-commands ac-setup-native - native command in PreToolUse
    it('should install native kspec guard worktree command in PreToolUse hooks', async () => {
      kspec('setup', tempDir, {
        env: { CLAUDECODE: '1' },
      });

      // Check settings.json for native guard command
      const settingsPath = path.join(tempDir, '.claude', 'settings.json');
      const settings = JSON.parse(await fs.readFile(settingsPath, 'utf-8'));
      const preToolUse = settings.hooks?.PreToolUse || [];

      const hasNativeGuard = preToolUse.some(
        (entry: { hooks?: Array<{ command?: string }> }) =>
          entry.hooks?.some((h: { command?: string }) => h.command === 'kspec guard worktree'),
      );
      expect(hasNativeGuard).toBe(true);
    });

    // AC: @native-guard-commands ac-setup-native - no bash scripts, native command
    it('should not create bash guard scripts (uses native kspec guard command)', async () => {
      kspec('setup', tempDir, {
        env: { CLAUDECODE: '1' },
      });

      // No bash scripts should be created in .claude/hooks/
      const hooksDir = path.join(tempDir, '.claude', 'hooks');
      let files: string[] = [];
      try {
        files = await fs.readdir(hooksDir);
      } catch {
        // hooks dir might not exist — that's acceptable
      }
      expect(files).not.toContain('kspec-worktree-guard.sh');
      expect(files).not.toContain('ralph-task-limit-guard.sh');
    });

    // AC: @native-guard-commands ac-worktree-guard, ac-worktree-allow
    // Guard logic tested via kspec guard worktree CLI in guard-worktree.test.ts
    it('should test guard logic via native kspec guard worktree command', () => {
      // Run guard command with various inputs to test allow/block behavior
      const runGuard = (command: string, cwd: string) => {
        const input = JSON.stringify({ tool_input: { command }, cwd });
        const result = kspec('guard worktree', tempDir, { stdin: input });
        return JSON.parse(result.stdout.trim());
      };

      // These should be ALLOWED — dangerous patterns are inside quotes
      expect(runGuard('echo "git reset"', path.join(tempDir, '.kspec'))).toEqual({ decision: 'allow' });
      expect(runGuard("grep 'git stash' README.md", path.join(tempDir, '.kspec'))).toEqual({ decision: 'allow' });

      // These should still be BLOCKED — actual dangerous commands
      expect(runGuard('git reset --hard', path.join(tempDir, '.kspec'))).toHaveProperty('decision', 'block');
      expect(runGuard('git stash', path.join(tempDir, '.kspec'))).toHaveProperty('decision', 'block');

      // These should be BLOCKED — split-quote bypass attempts
      expect(runGuard('git "reset" --hard', path.join(tempDir, '.kspec'))).toHaveProperty('decision', 'block');
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

    // AC: @new-project-bootstrapping ac-3
    it('should render core skills to codex output when codex is detected', async () => {
      const result = kspec('setup', tempDir, {
        env: { CODEX_THREAD_ID: 'test-thread-123', CLAUDECODE: '', CLAUDE_CODE_ENTRYPOINT: '', CLAUDE_PROJECT_DIR: '', CLAUDE_CODE: '', HOME: tempDir },
      });
      expect(result.exitCode).toBe(0);

      const codexCorePath = path.join(tempDir, '.agents', 'skills', 'kspec-help', 'SKILL.md');
      const codexCoreExists = await fs.access(codexCorePath)
        .then(() => true)
        .catch(() => false);
      expect(codexCoreExists).toBe(true);

      const codexContent = await fs.readFile(codexCorePath, 'utf-8');
      expect(codexContent).toContain('<!-- kspec-managed -->');
      expect(codexContent).toContain('name: kspec-help');

      const codexConfigPath = path.join(tempDir, '.codex', 'config.toml');
      const codexConfig = await fs.readFile(codexConfigPath, 'utf-8');
      expect(codexConfig).toContain('project_doc_fallback_filenames');
      expect(codexConfig).toContain('kspec-agents.md');

      // Core claude-code path remains plugin-provided (no local render)
      const claudeCorePath = path.join(tempDir, '.claude', 'skills', 'help', 'SKILL.md');
      const claudeCoreExists = await fs.access(claudeCorePath)
        .then(() => true)
        .catch(() => false);
      expect(claudeCoreExists).toBe(false);
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

  describe('droid setup integration', () => {
    beforeEach(async () => {
      kspec('init --name test-project --no-prompt', tempDir);
    });

    // AC: @droid-setup-integration ac-1
    it('renders droid-targeted skills to .factory/skills during setup', async () => {
      kspec(
        'skill add --id droid-setup --name "Droid Setup" --description "Droid setup skill" --platform droid',
        tempDir,
      );
      await fs.writeFile(
        path.join(tempDir, '.kspec', 'skills', 'droid-setup', 'SKILL.md'),
        '# Droid Setup\n\nRendered for Droid setup integration.\n',
        'utf-8',
      );

      const result = kspec('setup --agent droid', tempDir, {
        env: { FACTORY_PROJECT_DIR: tempDir, HOME: tempDir, KSPEC_AUTHOR: '@test' },
      });

      expect(result.exitCode).toBe(0);

      const renderedPath = path.join(tempDir, '.factory', 'skills', 'droid-setup', 'SKILL.md');
      const rendered = await fs.readFile(renderedPath, 'utf-8');
      expect(rendered).toContain('<!-- kspec-managed -->');
      expect(rendered).toContain('name: droid-setup');
    });

    // AC: @droid-setup-integration ac-2
    it('reports droid agent detection with rendered skill counts in setup status', async () => {
      kspec(
        'skill add --id droid-status --name "Droid Status" --description "Droid status skill" --platform droid',
        tempDir,
      );
      await fs.writeFile(
        path.join(tempDir, '.kspec', 'skills', 'droid-status', 'SKILL.md'),
        '# Droid Status\n\nRendered for status checks.\n',
        'utf-8',
      );

      const setupResult = kspec('setup --agent droid', tempDir, {
        env: { FACTORY_PROJECT_DIR: tempDir, HOME: tempDir, KSPEC_AUTHOR: '@test' },
      });
      expect(setupResult.exitCode).toBe(0);

      const status = kspecJson<{
        agent: { detected: string };
        hooks: { supported: boolean; promptCheck: boolean; stop: boolean; preToolUse: boolean };
        skills: { rendered: number };
      }>('setup --status --agent droid', tempDir, {
        env: { FACTORY_PROJECT_DIR: tempDir, HOME: tempDir, KSPEC_AUTHOR: '@test' },
      });

      expect(status.agent.detected).toBe('droid');
      expect(status.hooks.supported).toBe(false);
      expect(status.hooks.promptCheck).toBe(false);
      expect(status.hooks.stop).toBe(false);
      expect(status.hooks.preToolUse).toBe(false);
      // Core skills targeting droid are also installed during setup, so rendered count
      // includes both the custom droid-status skill and all core droid-platform skills
      expect(status.skills.rendered).toBeGreaterThanOrEqual(1);
    });

    it('reports droid hooks as unsupported in human-readable setup status output', async () => {
      const setupResult = kspec('setup --agent droid', tempDir, {
        env: { FACTORY_PROJECT_DIR: tempDir, HOME: tempDir, KSPEC_AUTHOR: '@test' },
      });
      expect(setupResult.exitCode).toBe(0);

      const statusResult = kspec('setup --status --agent droid', tempDir, {
        env: { FACTORY_PROJECT_DIR: tempDir, HOME: tempDir, KSPEC_AUTHOR: '@test' },
      });

      expect(statusResult.exitCode).toBe(0);
      expect(statusResult.stdout).toContain('UserPromptSubmit: unsupported');
      expect(statusResult.stdout).toContain('Stop:             unsupported');
      expect(statusResult.stdout).toContain('PreToolUse:       unsupported');
      expect(statusResult.stdout).toContain('droid hooks are not yet supported');
      expect(statusResult.stdout).not.toContain('UserPromptSubmit: ✗');
      expect(statusResult.stdout).not.toContain('Stop:             ✗');
      expect(statusResult.stdout).not.toContain('PreToolUse:       ✗');
    });

    it('detects native guard hooks in setup status for claude-code', async () => {
      // Enable checkpoint via config so Stop hook is installed
      await fs.writeFile(
        path.join(tempDir, 'kspec.config.yaml'),
        `
hooks:
  checkpoint: true
`
      );

      const setupResult = kspec('setup --agent claude-code', tempDir, {
        env: { CLAUDECODE: '1', HOME: tempDir, KSPEC_AUTHOR: '@test' },
      });
      expect(setupResult.exitCode).toBe(0);

      const status = kspecJson<{
        hooks: { promptCheck: boolean; stop: boolean; preToolUse: boolean; guardsPresent: string[] };
      }>('setup --status --agent claude-code', tempDir, {
        env: { CLAUDECODE: '1', HOME: tempDir, KSPEC_AUTHOR: '@test' },
      });

      expect(status.hooks.promptCheck).toBe(true);
      expect(status.hooks.stop).toBe(true);
      expect(status.hooks.preToolUse).toBe(true);
      expect(status.hooks.guardsPresent).toContain('kspec guard worktree');
    });

    // AC: @droid-setup-integration ac-3
    it('shows Droid-specific KSPEC_AUTHOR guidance for .factory/settings.json', async () => {
      const result = kspec('setup --dry-run --agent droid --force', tempDir, {
        env: { FACTORY_PROJECT_DIR: tempDir, HOME: tempDir, KSPEC_AUTHOR: '' },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Configure author');
      expect(result.stdout).toContain('.factory/settings.json');
      expect(result.stdout).toContain('KSPEC_AUTHOR');
      expect(result.stdout).toContain('@droid');
    });

    // AC: @droid-setup-integration ac-5
    it('skips hook installation for droid with a non-error guidance message', async () => {
      const result = kspec('setup --dry-run --agent droid', tempDir, {
        env: { FACTORY_PROJECT_DIR: tempDir, HOME: tempDir, KSPEC_AUTHOR: '@test' },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Install hooks');
      expect(result.stdout).toContain('skipped');
      expect(result.stdout).toContain('droid hooks are not yet supported');
    });
  });

  // AC: @project-config ac-hooks-section — hooks config controls setup behavior
  // AC: @project-config ac-hooks-missing-keys — absent keys resolve to defaults
  // AC: @project-config ac-hooks-no-config — no hooks section = defaults
  describe('hooks configuration', () => {
    beforeEach(async () => {
      kspec('init --name test-project --no-prompt', tempDir);
    });

    // AC: @project-config ac-hooks-no-config
    // With no hooks config, prompt-check should be installed (default: true)
    // and checkpoint should NOT be installed (default: false)
    it('should install prompt-check but not checkpoint by default', async () => {
      kspec('setup', tempDir, {
        env: { CLAUDECODE: '1' },
      });

      const settingsPath = path.join(tempDir, '.claude', 'settings.json');
      const settings = JSON.parse(await fs.readFile(settingsPath, 'utf-8'));

      // UserPromptSubmit should be present (prompt-check default: enabled)
      expect(settings.hooks.UserPromptSubmit).toBeDefined();
      const hasPromptCheck = settings.hooks.UserPromptSubmit.some(
        (entry: { hooks?: Array<{ command?: string }> }) =>
          entry.hooks?.some((h) => h.command?.includes('session prompt-check')),
      );
      expect(hasPromptCheck).toBe(true);

      // Stop hook should NOT be present (checkpoint default: disabled)
      const hasCheckpoint = settings.hooks.Stop?.some(
        (entry: { hooks?: Array<{ command?: string }> }) =>
          entry.hooks?.some((h) => h.command?.includes('session checkpoint')),
      );
      expect(hasCheckpoint).toBeFalsy();
    });

    // AC: @project-config ac-hooks-section
    it('should install checkpoint when config enables it', async () => {
      await fs.writeFile(
        path.join(tempDir, 'kspec.config.yaml'),
        `
hooks:
  checkpoint: true
  prompt_check: true
`
      );

      kspec('setup', tempDir, {
        env: { CLAUDECODE: '1' },
      });

      const settingsPath = path.join(tempDir, '.claude', 'settings.json');
      const settings = JSON.parse(await fs.readFile(settingsPath, 'utf-8'));

      // Both should be installed
      expect(settings.hooks.UserPromptSubmit).toBeDefined();
      expect(settings.hooks.Stop).toBeDefined();

      const hasCheckpoint = settings.hooks.Stop.some(
        (entry: { hooks?: Array<{ command?: string }> }) =>
          entry.hooks?.some((h) => h.command?.includes('session checkpoint')),
      );
      expect(hasCheckpoint).toBe(true);
    });

    // AC: @project-config ac-hooks-section
    it('should not install prompt-check when config disables it', async () => {
      await fs.writeFile(
        path.join(tempDir, 'kspec.config.yaml'),
        `
hooks:
  checkpoint: false
  prompt_check: false
`
      );

      kspec('setup', tempDir, {
        env: { CLAUDECODE: '1' },
      });

      const settingsPath = path.join(tempDir, '.claude', 'settings.json');
      const settings = JSON.parse(await fs.readFile(settingsPath, 'utf-8'));

      // Neither kspec hook should be present
      const hasPromptCheck = settings.hooks?.UserPromptSubmit?.some(
        (entry: { hooks?: Array<{ command?: string }> }) =>
          entry.hooks?.some((h) => h.command?.includes('session prompt-check')),
      );
      expect(hasPromptCheck).toBeFalsy();

      const hasCheckpoint = settings.hooks?.Stop?.some(
        (entry: { hooks?: Array<{ command?: string }> }) =>
          entry.hooks?.some((h) => h.command?.includes('session checkpoint')),
      );
      expect(hasCheckpoint).toBeFalsy();
    });

    // AC: @project-config ac-hooks-section — removal of previously installed hooks
    it('should remove checkpoint hook when config disables it after previous install', async () => {
      // First: install with checkpoint enabled
      await fs.writeFile(
        path.join(tempDir, 'kspec.config.yaml'),
        `
hooks:
  checkpoint: true
`
      );

      kspec('setup', tempDir, {
        env: { CLAUDECODE: '1' },
      });

      const settingsPath = path.join(tempDir, '.claude', 'settings.json');
      let settings = JSON.parse(await fs.readFile(settingsPath, 'utf-8'));

      // Verify checkpoint was installed
      let hasCheckpoint = settings.hooks.Stop?.some(
        (entry: { hooks?: Array<{ command?: string }> }) =>
          entry.hooks?.some((h) => h.command?.includes('session checkpoint')),
      );
      expect(hasCheckpoint).toBe(true);

      // Second: disable checkpoint
      await fs.writeFile(
        path.join(tempDir, 'kspec.config.yaml'),
        `
hooks:
  checkpoint: false
`
      );

      kspec('setup', tempDir, {
        env: { CLAUDECODE: '1' },
      });

      settings = JSON.parse(await fs.readFile(settingsPath, 'utf-8'));

      // Verify checkpoint was removed
      hasCheckpoint = settings.hooks?.Stop?.some(
        (entry: { hooks?: Array<{ command?: string }> }) =>
          entry.hooks?.some((h) => h.command?.includes('session checkpoint')),
      );
      expect(hasCheckpoint).toBeFalsy();
    });

    // AC: @project-config ac-hooks-preserve-user-stop-hooks
    it('should preserve user-defined Stop hooks when disabling checkpoint', async () => {
      await fs.writeFile(
        path.join(tempDir, 'kspec.config.yaml'),
        `
hooks:
  checkpoint: false
`
      );

      const settingsPath = path.join(tempDir, '.claude', 'settings.json');
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(
        settingsPath,
        `${JSON.stringify({
          hooks: {
            Stop: [
              {
                matcher: 'Notebook',
                hooks: [
                  {
                    type: 'command',
                    command: 'kspec session checkpoint --json',
                  },
                ],
              },
              {
                matcher: '',
                hooks: [
                  {
                    type: 'command',
                    command: 'kspec session checkpoint --json',
                  },
                ],
              },
            ],
          },
        }, null, 2)}\n`,
        'utf-8',
      );

      kspec('setup', tempDir, {
        env: { CLAUDECODE: '1' },
      });

      const settings = JSON.parse(await fs.readFile(settingsPath, 'utf-8'));
      expect(settings.hooks.Stop).toEqual([
        {
          matcher: 'Notebook',
          hooks: [
            {
              type: 'command',
              command: 'kspec session checkpoint --json',
            },
          ],
        },
      ]);
    });

    // AC: @project-config ac-hooks-preserve-user-stop-hooks
    it('should add the managed checkpoint hook alongside user-defined Stop hooks', async () => {
      await fs.writeFile(
        path.join(tempDir, 'kspec.config.yaml'),
        `
hooks:
  checkpoint: true
`
      );

      const settingsPath = path.join(tempDir, '.claude', 'settings.json');
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(
        settingsPath,
        `${JSON.stringify({
          hooks: {
            Stop: [
              {
                matcher: 'Notebook',
                hooks: [
                  {
                    type: 'command',
                    command: 'kspec session checkpoint --json',
                  },
                ],
              },
            ],
          },
        }, null, 2)}\n`,
        'utf-8',
      );

      kspec('setup', tempDir, {
        env: { CLAUDECODE: '1' },
      });

      const settings = JSON.parse(await fs.readFile(settingsPath, 'utf-8'));
      expect(settings.hooks.Stop).toEqual([
        {
          matcher: 'Notebook',
          hooks: [
            {
              type: 'command',
              command: 'kspec session checkpoint --json',
            },
          ],
        },
        {
          matcher: '',
          hooks: [
            {
              type: 'command',
              command: 'kspec session checkpoint --json',
            },
          ],
        },
      ]);
    });

    // AC: @project-config ac-hooks-section — removal of previously installed prompt-check
    it('should remove prompt-check hook when config disables it after previous install', async () => {
      // First: install with defaults (prompt-check enabled)
      kspec('setup', tempDir, {
        env: { CLAUDECODE: '1' },
      });

      const settingsPath = path.join(tempDir, '.claude', 'settings.json');
      let settings = JSON.parse(await fs.readFile(settingsPath, 'utf-8'));

      // Verify prompt-check was installed
      let hasPromptCheck = settings.hooks.UserPromptSubmit?.some(
        (entry: { hooks?: Array<{ command?: string }> }) =>
          entry.hooks?.some((h) => h.command?.includes('session prompt-check')),
      );
      expect(hasPromptCheck).toBe(true);

      // Second: disable prompt-check
      await fs.writeFile(
        path.join(tempDir, 'kspec.config.yaml'),
        `
hooks:
  prompt_check: false
`
      );

      kspec('setup', tempDir, {
        env: { CLAUDECODE: '1' },
      });

      settings = JSON.parse(await fs.readFile(settingsPath, 'utf-8'));

      // Verify prompt-check was removed
      hasPromptCheck = settings.hooks?.UserPromptSubmit?.some(
        (entry: { hooks?: Array<{ command?: string }> }) =>
          entry.hooks?.some((h) => h.command?.includes('session prompt-check')),
      );
      expect(hasPromptCheck).toBeFalsy();
    });

    // AC: @project-config ac-hooks-missing-keys
    it('should resolve absent keys to defaults (checkpoint=false, prompt_check=true)', async () => {
      await fs.writeFile(
        path.join(tempDir, 'kspec.config.yaml'),
        `
hooks: {}
`
      );

      kspec('setup', tempDir, {
        env: { CLAUDECODE: '1' },
      });

      const settingsPath = path.join(tempDir, '.claude', 'settings.json');
      const settings = JSON.parse(await fs.readFile(settingsPath, 'utf-8'));

      // prompt-check should be installed (default: true)
      const hasPromptCheck = settings.hooks.UserPromptSubmit?.some(
        (entry: { hooks?: Array<{ command?: string }> }) =>
          entry.hooks?.some((h) => h.command?.includes('session prompt-check')),
      );
      expect(hasPromptCheck).toBe(true);

      // checkpoint should NOT be installed (default: false)
      const hasCheckpoint = settings.hooks?.Stop?.some(
        (entry: { hooks?: Array<{ command?: string }> }) =>
          entry.hooks?.some((h) => h.command?.includes('session checkpoint')),
      );
      expect(hasCheckpoint).toBeFalsy();
    });

    // Idempotency with hooks config
    it('should be idempotent with hooks config', async () => {
      await fs.writeFile(
        path.join(tempDir, 'kspec.config.yaml'),
        `
hooks:
  checkpoint: true
  prompt_check: true
`
      );

      // First run
      kspec('setup', tempDir, { env: { CLAUDECODE: '1' } });
      const settingsPath = path.join(tempDir, '.claude', 'settings.json');
      const content1 = await fs.readFile(settingsPath, 'utf-8');

      // Second run
      kspec('setup', tempDir, { env: { CLAUDECODE: '1' } });
      const content2 = await fs.readFile(settingsPath, 'utf-8');

      expect(content2).toBe(content1);
    });

    // PreToolUse (worktree guard) should always be installed regardless of hooks config
    it('should always install PreToolUse guard regardless of hooks config', async () => {
      await fs.writeFile(
        path.join(tempDir, 'kspec.config.yaml'),
        `
hooks:
  checkpoint: false
  prompt_check: false
`
      );

      kspec('setup', tempDir, {
        env: { CLAUDECODE: '1' },
      });

      const settingsPath = path.join(tempDir, '.claude', 'settings.json');
      const settings = JSON.parse(await fs.readFile(settingsPath, 'utf-8'));

      // PreToolUse should still be present
      expect(settings.hooks.PreToolUse).toBeDefined();
      const hasGuard = settings.hooks.PreToolUse.some(
        (entry: { hooks?: Array<{ command?: string }> }) =>
          entry.hooks?.some((h) => h.command === 'kspec guard worktree'),
      );
      expect(hasGuard).toBe(true);
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

    // AC: @native-guard-commands ac-idempotent - no duplicates on repeated setup
    it('should not create duplicate guard entries on repeated setup', async () => {
      // First setup
      kspec('setup', tempDir, {
        env: { CLAUDECODE: '1' },
      });

      // Second setup
      kspec('setup', tempDir, {
        env: { CLAUDECODE: '1' },
      });

      const settingsPath = path.join(tempDir, '.claude', 'settings.json');
      const settings = JSON.parse(await fs.readFile(settingsPath, 'utf-8'));
      const preToolUse = settings.hooks?.PreToolUse || [];

      // Count native guard entries
      let guardCount = 0;
      for (const entry of preToolUse) {
        for (const hook of entry.hooks || []) {
          if (hook.command === 'kspec guard worktree') {
            guardCount++;
          }
        }
      }
      expect(guardCount).toBe(1);
    });

    it('should produce identical settings.json content on second run', async () => {
      // First setup
      kspec('setup', tempDir, {
        env: { CLAUDECODE: '1' },
      });

      const settingsPath = path.join(tempDir, '.claude', 'settings.json');
      const content1 = await fs.readFile(settingsPath, 'utf-8');

      // Second setup
      kspec('setup', tempDir, {
        env: { CLAUDECODE: '1' },
      });

      const content2 = await fs.readFile(settingsPath, 'utf-8');

      // Content should be identical (no unnecessary changes)
      expect(content2).toBe(content1);
    });
  });
});
