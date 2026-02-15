/**
 * Tests for Skill Schema Definition
 * AC: @skill-schema ac-1 through ac-3
 * AC: @extended-skill-schema ac-1 through ac-7
 */
import { describe, it, expect } from 'vitest';
import { testUlid } from './helpers/cli';
import { SkillSchema, ClaudeCodeConfigSchema, CodexConfigSchema, PlatformConfigSchema } from '../src/schema/meta';

describe('Skill Schema Definition', () => {
  describe('id validation', () => {
    // AC: @skill-schema ac-1
    it('should reject id with uppercase characters', () => {
      const skill = {
        _ulid: testUlid('SKUPPR'),
        id: 'TaskWork', // uppercase
        name: 'Task Work',
        origin: 'core',
      };

      const result = SkillSchema.safeParse(skill);
      expect(result.success).toBe(false);
      if (!result.success) {
        const idError = result.error.issues.find(
          (issue) => issue.path.includes('id'),
        );
        expect(idError).toBeDefined();
        expect(idError?.message).toContain('kebab-case');
      }
    });

    // AC: @skill-schema ac-1
    it('should reject id with special characters', () => {
      const skill = {
        _ulid: testUlid('SKSPEC'),
        id: 'task_work', // underscore
        name: 'Task Work',
        origin: 'core',
      };

      const result = SkillSchema.safeParse(skill);
      expect(result.success).toBe(false);
      if (!result.success) {
        const idError = result.error.issues.find(
          (issue) => issue.path.includes('id'),
        );
        expect(idError).toBeDefined();
        expect(idError?.message).toContain('kebab-case');
      }
    });

    // AC: @skill-schema ac-1
    it('should reject id starting with number', () => {
      const skill = {
        _ulid: testUlid('SKNUM1'),
        id: '123-task',
        name: 'Task Work',
        origin: 'core',
      };

      const result = SkillSchema.safeParse(skill);
      expect(result.success).toBe(false);
      if (!result.success) {
        const idError = result.error.issues.find(
          (issue) => issue.path.includes('id'),
        );
        expect(idError).toBeDefined();
        expect(idError?.message).toContain('kebab-case');
      }
    });

    // AC: @skill-schema ac-1
    it('should accept valid kebab-case ids', () => {
      const validIds = ['task-work', 'pr-review', 'e2e', 'my-skill-v2'];

      for (const id of validIds) {
        const skill = {
          _ulid: testUlid('SKVAL'),
          id,
          name: 'Test Skill',
          origin: 'core',
        };

        const result = SkillSchema.safeParse(skill);
        expect(result.success).toBe(true);
      }
    });

    // AC: @skill-schema ac-2
    it('should reject missing id field', () => {
      const skill = {
        _ulid: testUlid('SKNOID'),
        name: 'No ID Skill',
        origin: 'core',
      };

      const result = SkillSchema.safeParse(skill);
      expect(result.success).toBe(false);
      if (!result.success) {
        const idError = result.error.issues.find(
          (issue) => issue.path.includes('id'),
        );
        expect(idError).toBeDefined();
        // Check for required field error
        expect(idError?.code === 'invalid_type' || idError?.message?.toLowerCase().includes('required')).toBe(true);
      }
    });
  });

  describe('platforms default', () => {
    // AC: @skill-schema ac-3
    it('should default platforms to ["claude-code"] when not specified', () => {
      const skill = {
        _ulid: testUlid('SKPLAT'),
        id: 'test-skill',
        name: 'Test Skill',
        origin: 'core',
      };

      const result = SkillSchema.safeParse(skill);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.platforms).toEqual(['claude-code']);
      }
    });

    // AC: @skill-schema ac-3
    it('should preserve custom platforms when specified', () => {
      const skill = {
        _ulid: testUlid('SKCUST'),
        id: 'multi-platform-skill',
        name: 'Multi-Platform Skill',
        origin: 'core',
        platforms: ['claude-code', 'cursor', 'windsurf'],
      };

      const result = SkillSchema.safeParse(skill);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.platforms).toEqual(['claude-code', 'cursor', 'windsurf']);
      }
    });
  });

  describe('other fields', () => {
    it('should default depends_on to empty array', () => {
      const skill = {
        _ulid: testUlid('SKDEPS'),
        id: 'test-skill',
        name: 'Test Skill',
        origin: 'core',
      };

      const result = SkillSchema.safeParse(skill);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.depends_on).toEqual([]);
      }
    });

    it('should accept depends_on refs', () => {
      const skill = {
        _ulid: testUlid('SKDEP2'),
        id: 'test-skill',
        name: 'Test Skill',
        origin: 'core',
        depends_on: ['@other-skill', '@another'],
      };

      const result = SkillSchema.safeParse(skill);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.depends_on).toEqual(['@other-skill', '@another']);
      }
    });

    it('should default tags to empty array', () => {
      const skill = {
        _ulid: testUlid('SKTAGS'),
        id: 'test-skill',
        name: 'Test Skill',
        origin: 'core',
      };

      const result = SkillSchema.safeParse(skill);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.tags).toEqual([]);
      }
    });
  });

  // Extended Skill Schema tests
  describe('portable Agent Skills fields', () => {
    // AC: @extended-skill-schema ac-1
    it('should accept license as optional string', () => {
      const skill = {
        _ulid: testUlid('SKLIC1'),
        id: 'licensed-skill',
        name: 'Licensed Skill',
        origin: 'project',
        license: 'MIT',
      };

      const result = SkillSchema.safeParse(skill);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.license).toBe('MIT');
      }
    });

    // AC: @extended-skill-schema ac-1
    it('should accept compatibility as optional string', () => {
      const skill = {
        _ulid: testUlid('SKCOMP'),
        id: 'compatible-skill',
        name: 'Compatible Skill',
        origin: 'project',
        compatibility: '>=1.0.0',
      };

      const result = SkillSchema.safeParse(skill);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.compatibility).toBe('>=1.0.0');
      }
    });

    // AC: @extended-skill-schema ac-1
    it('should accept allowed_tools as array of strings', () => {
      const skill = {
        _ulid: testUlid('SKTOOL'),
        id: 'tools-skill',
        name: 'Tools Skill',
        origin: 'project',
        allowed_tools: ['Bash', 'Read', 'Write'],
      };

      const result = SkillSchema.safeParse(skill);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.allowed_tools).toEqual(['Bash', 'Read', 'Write']);
      }
    });

    // AC: @extended-skill-schema ac-1
    it('should default allowed_tools to empty array', () => {
      const skill = {
        _ulid: testUlid('SKDFLT'),
        id: 'default-tools-skill',
        name: 'Default Tools Skill',
        origin: 'project',
      };

      const result = SkillSchema.safeParse(skill);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.allowed_tools).toEqual([]);
      }
    });

    // AC: @extended-skill-schema ac-7
    it('should accept metadata as optional Record of key-value pairs', () => {
      const skill = {
        _ulid: testUlid('SKMETA'),
        id: 'metadata-skill',
        name: 'Metadata Skill',
        origin: 'project',
        metadata: {
          author: 'Claude',
          version_history: ['1.0.0', '1.1.0'],
          deprecated: false,
          custom_config: { nested: 'value' },
        },
      };

      const result = SkillSchema.safeParse(skill);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.metadata).toEqual({
          author: 'Claude',
          version_history: ['1.0.0', '1.1.0'],
          deprecated: false,
          custom_config: { nested: 'value' },
        });
      }
    });

    // AC: @extended-skill-schema ac-6
    it('should pass validation for skill with no new fields (backward compatibility)', () => {
      const skill = {
        _ulid: testUlid('SKBACK'),
        id: 'backward-compat-skill',
        name: 'Backward Compatible Skill',
        origin: 'core',
        version: '1.0.0',
        platforms: ['claude-code'],
        depends_on: [],
        tags: ['core'],
      };

      const result = SkillSchema.safeParse(skill);
      expect(result.success).toBe(true);
      if (result.success) {
        // Verify no unexpected defaults for new fields
        expect(result.data.license).toBeUndefined();
        expect(result.data.compatibility).toBeUndefined();
        expect(result.data.allowed_tools).toEqual([]);
        expect(result.data.metadata).toBeUndefined();
        expect(result.data.platform_config).toBeUndefined();
      }
    });
  });

  describe('platform_config validation', () => {
    // AC: @extended-skill-schema ac-2
    it('should validate claude_code config with valid fields', () => {
      const skill = {
        _ulid: testUlid('SKCC01'),
        id: 'claude-config-skill',
        name: 'Claude Config Skill',
        origin: 'project',
        platform_config: {
          claude_code: {
            disable_model_invocation: false,
            user_invocable: true,
            context: 'project',
            agent: 'general-purpose',
            model: 'haiku',
            argument_hint: '<task-ref>',
          },
        },
      };

      const result = SkillSchema.safeParse(skill);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.platform_config?.claude_code).toEqual({
          disable_model_invocation: false,
          user_invocable: true,
          context: 'project',
          agent: 'general-purpose',
          model: 'haiku',
          argument_hint: '<task-ref>',
        });
      }
    });

    // AC: @extended-skill-schema ac-2
    it('should validate claude_code config with partial fields', () => {
      const skill = {
        _ulid: testUlid('SKCC02'),
        id: 'partial-claude-skill',
        name: 'Partial Claude Skill',
        origin: 'project',
        platform_config: {
          claude_code: {
            user_invocable: true,
          },
        },
      };

      const result = SkillSchema.safeParse(skill);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.platform_config?.claude_code?.user_invocable).toBe(true);
      }
    });

    // AC: @extended-skill-schema ac-3
    it('should validate codex config with valid fields', () => {
      const skill = {
        _ulid: testUlid('SKCDX1'),
        id: 'codex-config-skill',
        name: 'Codex Config Skill',
        origin: 'project',
        platform_config: {
          codex: {
            allow_implicit_invocation: true,
            display_name: 'My Skill',
            short_description: 'A helpful skill',
            icon_small: 'icon-sm.png',
            icon_large: 'icon-lg.png',
            brand_color: '#ff5500',
            default_prompt: 'Help me with...',
          },
        },
      };

      const result = SkillSchema.safeParse(skill);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.platform_config?.codex).toEqual({
          allow_implicit_invocation: true,
          display_name: 'My Skill',
          short_description: 'A helpful skill',
          icon_small: 'icon-sm.png',
          icon_large: 'icon-lg.png',
          brand_color: '#ff5500',
          default_prompt: 'Help me with...',
        });
      }
    });

    // AC: @extended-skill-schema ac-3
    it('should validate codex config with partial fields', () => {
      const skill = {
        _ulid: testUlid('SKCDX2'),
        id: 'partial-codex-skill',
        name: 'Partial Codex Skill',
        origin: 'project',
        platform_config: {
          codex: {
            display_name: 'Simple Skill',
          },
        },
      };

      const result = SkillSchema.safeParse(skill);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.platform_config?.codex?.display_name).toBe('Simple Skill');
      }
    });

    // AC: @extended-skill-schema ac-4
    it('should pass validation for unknown platform keys (passthrough)', () => {
      const skill = {
        _ulid: testUlid('SKFUTR'),
        id: 'future-platform-skill',
        name: 'Future Platform Skill',
        origin: 'project',
        platform_config: {
          cursor: {
            some_future_field: 'value',
            another_field: true,
          },
          windsurf: {
            config_option: 42,
          },
        },
      };

      const result = SkillSchema.safeParse(skill);
      expect(result.success).toBe(true);
      if (result.success) {
        // Unknown platforms should be preserved via passthrough
        expect(result.data.platform_config).toHaveProperty('cursor');
        expect(result.data.platform_config).toHaveProperty('windsurf');
      }
    });

    // AC: @extended-skill-schema ac-4
    it('should allow mixed known and unknown platforms', () => {
      const skill = {
        _ulid: testUlid('SKMXED'),
        id: 'mixed-platform-skill',
        name: 'Mixed Platform Skill',
        origin: 'project',
        platform_config: {
          claude_code: {
            user_invocable: true,
          },
          codex: {
            display_name: 'Mixed Skill',
          },
          future_agent: {
            custom_setting: 'enabled',
          },
        },
      };

      const result = SkillSchema.safeParse(skill);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.platform_config?.claude_code?.user_invocable).toBe(true);
        expect(result.data.platform_config?.codex?.display_name).toBe('Mixed Skill');
        expect(result.data.platform_config).toHaveProperty('future_agent');
      }
    });

    // AC: @extended-skill-schema ac-5
    it('should fail validation for invalid claude_code config fields', () => {
      const skill = {
        _ulid: testUlid('SKINV1'),
        id: 'invalid-claude-skill',
        name: 'Invalid Claude Skill',
        origin: 'project',
        platform_config: {
          claude_code: {
            user_invocable: true,
            invalid_field: 'not allowed',  // This should cause strict validation failure
          },
        },
      };

      const result = SkillSchema.safeParse(skill);
      expect(result.success).toBe(false);
      if (!result.success) {
        const error = result.error.issues.find(
          (issue) => issue.path.includes('platform_config') || issue.path.includes('claude_code')
        );
        expect(error).toBeDefined();
      }
    });

    // AC: @extended-skill-schema ac-5
    it('should fail validation for invalid codex config fields', () => {
      const skill = {
        _ulid: testUlid('SKINV2'),
        id: 'invalid-codex-skill',
        name: 'Invalid Codex Skill',
        origin: 'project',
        platform_config: {
          codex: {
            display_name: 'Valid Name',
            unknown_setting: true,  // This should cause strict validation failure
          },
        },
      };

      const result = SkillSchema.safeParse(skill);
      expect(result.success).toBe(false);
      if (!result.success) {
        const error = result.error.issues.find(
          (issue) => issue.path.includes('platform_config') || issue.path.includes('codex')
        );
        expect(error).toBeDefined();
      }
    });

    // AC: @extended-skill-schema ac-5
    it('should provide descriptive error for invalid nested fields', () => {
      const skill = {
        _ulid: testUlid('SKINV3'),
        id: 'descriptive-error-skill',
        name: 'Descriptive Error Skill',
        origin: 'project',
        platform_config: {
          claude_code: {
            user_invocable: 'not-a-boolean',  // Should be boolean
          },
        },
      };

      const result = SkillSchema.safeParse(skill);
      expect(result.success).toBe(false);
      if (!result.success) {
        const error = result.error.issues.find(
          (issue) => issue.path.includes('user_invocable')
        );
        expect(error).toBeDefined();
        // Error should describe the type mismatch
        expect(error?.code).toBe('invalid_type');
      }
    });
  });

  describe('ClaudeCodeConfigSchema direct validation', () => {
    it('should accept empty config', () => {
      const result = ClaudeCodeConfigSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it('should accept all valid fields', () => {
      const config = {
        disable_model_invocation: true,
        user_invocable: false,
        context: 'project',
        agent: 'test-agent',
        model: 'opus',
        argument_hint: 'Enter value',
      };
      const result = ClaudeCodeConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it('should reject unknown fields due to strict mode', () => {
      const config = {
        user_invocable: true,
        extra_field: 'not allowed',
      };
      const result = ClaudeCodeConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });
  });

  describe('CodexConfigSchema direct validation', () => {
    it('should accept empty config', () => {
      const result = CodexConfigSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it('should accept all valid fields', () => {
      const config = {
        allow_implicit_invocation: true,
        display_name: 'Display',
        short_description: 'Description',
        icon_small: 'small.png',
        icon_large: 'large.png',
        brand_color: '#123456',
        default_prompt: 'Prompt text',
      };
      const result = CodexConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it('should reject unknown fields due to strict mode', () => {
      const config = {
        display_name: 'Valid',
        unknown_codex_field: true,
      };
      const result = CodexConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });
  });

  describe('PlatformConfigSchema direct validation', () => {
    it('should accept empty config', () => {
      const result = PlatformConfigSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it('should pass through unknown platform keys', () => {
      const config = {
        some_future_platform: {
          any: 'value',
          nested: { deep: true },
        },
      };
      const result = PlatformConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveProperty('some_future_platform');
      }
    });

    it('should validate known platforms strictly', () => {
      const config = {
        claude_code: {
          user_invocable: true,
          not_a_field: 'bad',
        },
      };
      const result = PlatformConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });
  });
});
