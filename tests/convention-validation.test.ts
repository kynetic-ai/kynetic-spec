// AC: @convention-definitions ac-3, ac-4
import { describe, it, expect } from 'vitest';
import {
  validateConvention,
  validateConventions,
} from '../src/parser/convention-validation.js';
import type { Convention } from '../src/schema/meta.js';

describe('validateConvention', () => {
  describe('regex validation', () => {
    it('should validate content matching regex pattern', () => {
      const convention: Convention = {
        _ulid: '01TEST0000000000000000000',
        domain: 'commits',
        rules: ['Use conventional commit format'],
        validation: {
          type: 'regex',
          pattern: '^(feat|fix|docs|style|refactor|test|chore)(\\(.+\\))?:\\s.+',
          message: 'Commit must follow conventional format',
        },
      };

      const validContent = 'feat: add user login';
      const result = validateConvention(validContent, convention);
      expect(result).toBeNull();
    });

    it('should reject content not matching regex pattern', () => {
      const convention: Convention = {
        _ulid: '01TEST0000000000000000000',
        domain: 'commits',
        rules: ['Use conventional commit format'],
        validation: {
          type: 'regex',
          pattern: '^(feat|fix|docs|style|refactor|test|chore)(\\(.+\\))?:\\s.+',
          message: 'Commit must follow conventional format',
        },
      };

      const invalidContent = 'Added login feature';
      const result = validateConvention(invalidContent, convention);
      expect(result).not.toBeNull();
      expect(result?.domain).toBe('commits');
      expect(result?.message).toBe('Commit must follow conventional format');
    });

    it('should handle invalid regex pattern', () => {
      const convention: Convention = {
        _ulid: '01TEST0000000000000000000',
        domain: 'test',
        rules: [],
        validation: {
          type: 'regex',
          pattern: '[invalid(regex',
        },
      };

      const result = validateConvention('test', convention);
      expect(result).not.toBeNull();
      expect(result?.message).toContain('Invalid regex pattern');
    });
  });

  describe('enum validation', () => {
    it('should validate content in allowed list', () => {
      const convention: Convention = {
        _ulid: '01TEST0000000000000000000',
        domain: 'tags',
        rules: ['Use standard tags'],
        validation: {
          type: 'enum',
          allowed: ['mvp', 'feature', 'bug', 'tech-debt'],
          message: 'Tag not in allowed list',
        },
      };

      const validContent = 'mvp';
      const result = validateConvention(validContent, convention);
      expect(result).toBeNull();
    });

    it('should reject content not in allowed list', () => {
      const convention: Convention = {
        _ulid: '01TEST0000000000000000000',
        domain: 'tags',
        rules: ['Use standard tags'],
        validation: {
          type: 'enum',
          allowed: ['mvp', 'feature', 'bug', 'tech-debt'],
          message: 'Tag not in allowed list',
        },
      };

      const invalidContent = 'random-tag';
      const result = validateConvention(invalidContent, convention);
      expect(result).not.toBeNull();
      expect(result?.domain).toBe('tags');
      expect(result?.message).toBe('Tag not in allowed list');
      expect(result?.expected).toContain('mvp');
    });
  });

  describe('range validation', () => {
    it('should validate word count within range', () => {
      const convention: Convention = {
        _ulid: '01TEST0000000000000000000',
        domain: 'notes',
        rules: ['Notes should be 10-100 words'],
        validation: {
          type: 'range',
          min: 10,
          max: 100,
          unit: 'words',
          message: 'Note must be between 10-100 words',
        },
      };

      const validContent = 'This is a test note that has exactly twelve words in it yes.';
      const result = validateConvention(validContent, convention);
      expect(result).toBeNull();
    });

    it('should reject content below minimum word count', () => {
      const convention: Convention = {
        _ulid: '01TEST0000000000000000000',
        domain: 'notes',
        rules: [],
        validation: {
          type: 'range',
          min: 10,
          unit: 'words',
        },
      };

      const shortContent = 'Too short';
      const result = validateConvention(shortContent, convention);
      expect(result).not.toBeNull();
      expect(result?.message).toContain('too short');
    });

    it('should reject content above maximum word count', () => {
      const convention: Convention = {
        _ulid: '01TEST0000000000000000000',
        domain: 'notes',
        rules: [],
        validation: {
          type: 'range',
          max: 5,
          unit: 'words',
        },
      };

      const longContent = 'This is way too many words for the limit';
      const result = validateConvention(longContent, convention);
      expect(result).not.toBeNull();
      expect(result?.message).toContain('too long');
    });

    it('should validate character count', () => {
      const convention: Convention = {
        _ulid: '01TEST0000000000000000000',
        domain: 'naming',
        rules: [],
        validation: {
          type: 'range',
          max: 50,
          unit: 'chars',
        },
      };

      const validContent = 'short-name';
      const result = validateConvention(validContent, convention);
      expect(result).toBeNull();
    });

    it('should validate line count', () => {
      const convention: Convention = {
        _ulid: '01TEST0000000000000000000',
        domain: 'documentation',
        rules: [],
        validation: {
          type: 'range',
          min: 2,
          max: 10,
          unit: 'lines',
        },
      };

      const validContent = 'Line 1\nLine 2\nLine 3';
      const result = validateConvention(validContent, convention);
      expect(result).toBeNull();
    });
  });

  describe('prose validation', () => {
    // AC: @convention-definitions ac-4
    it('should skip prose conventions (advisory only)', () => {
      const convention: Convention = {
        _ulid: '01TEST0000000000000000000',
        domain: 'documentation',
        rules: ['Write clear documentation'],
        validation: {
          type: 'prose',
          message: 'Documentation should be clear',
        },
      };

      const content = 'Any content should pass';
      const result = validateConvention(content, convention);
      expect(result).toBeNull();
    });
  });

  describe('no validation', () => {
    it('should accept any content when no validation is configured', () => {
      const convention: Convention = {
        _ulid: '01TEST0000000000000000000',
        domain: 'test',
        rules: ['Some rule'],
      };

      const content = 'Any content';
      const result = validateConvention(content, convention);
      expect(result).toBeNull();
    });
  });
});

describe('validateConventions', () => {
  it('should validate multiple conventions', () => {
    const conventions: Convention[] = [
      {
        _ulid: '01TEST0000000000000000001',
        domain: 'commits',
        rules: [],
        validation: {
          type: 'regex',
          pattern: '^feat:',
        },
      },
      {
        _ulid: '01TEST0000000000000000002',
        domain: 'tags',
        rules: [],
        validation: {
          type: 'enum',
          allowed: ['mvp', 'feature'],
        },
      },
    ];

    const contentMap = {
      commits: 'feat: add feature',
      tags: 'mvp',
    };

    const result = validateConventions(conventions, contentMap);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.stats.conventionsChecked).toBe(2);
  });

  it('should collect errors from multiple conventions', () => {
    const conventions: Convention[] = [
      {
        _ulid: '01TEST0000000000000000001',
        domain: 'commits',
        rules: [],
        validation: {
          type: 'regex',
          pattern: '^feat:',
        },
      },
      {
        _ulid: '01TEST0000000000000000002',
        domain: 'tags',
        rules: [],
        validation: {
          type: 'enum',
          allowed: ['mvp', 'feature'],
        },
      },
    ];

    const contentMap = {
      commits: 'invalid commit',
      tags: 'invalid-tag',
    };

    const result = validateConventions(conventions, contentMap);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(2);
  });

  it('should skip conventions without validation', () => {
    const conventions: Convention[] = [
      {
        _ulid: '01TEST0000000000000000001',
        domain: 'test1',
        rules: [],
      },
      {
        _ulid: '01TEST0000000000000000002',
        domain: 'test2',
        rules: [],
        validation: {
          type: 'regex',
          pattern: '^test',
        },
      },
    ];

    const contentMap = {
      test2: 'test content',
    };

    const result = validateConventions(conventions, contentMap);
    expect(result.valid).toBe(true);
    expect(result.stats.conventionsChecked).toBe(1);
    expect(result.stats.conventionsSkipped).toBe(1);
    expect(result.skipped).toContain('test1');
  });

  // AC: @convention-definitions ac-4
  it('should skip prose conventions', () => {
    const conventions: Convention[] = [
      {
        _ulid: '01TEST0000000000000000001',
        domain: 'documentation',
        rules: [],
        validation: {
          type: 'prose',
        },
      },
    ];

    const contentMap = {
      documentation: 'any content',
    };

    const result = validateConventions(conventions, contentMap);
    expect(result.valid).toBe(true);
    expect(result.skipped).toContain('documentation');
    expect(result.stats.conventionsSkipped).toBe(1);
  });

  it('should skip conventions with no content provided', () => {
    const conventions: Convention[] = [
      {
        _ulid: '01TEST0000000000000000001',
        domain: 'commits',
        rules: [],
        validation: {
          type: 'regex',
          pattern: '^feat:',
        },
      },
    ];

    const contentMap = {}; // No content for commits

    const result = validateConventions(conventions, contentMap);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.stats.conventionsChecked).toBe(0);
  });
});
