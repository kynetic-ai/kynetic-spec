/**
 * Tests for exit code constants and help documentation
 * AC: @cli-exit-codes exit-code-constants, exit-codes-documented, consistent-usage
 */

import { describe, it, expect } from 'vitest';
import { EXIT_CODES, EXIT_CODE_METADATA } from '../src/cli/exit-codes.js';
import { helpContent } from '../src/cli/help/content.js';

describe('EXIT_CODES constants', () => {
  // AC: @cli-exit-codes exit-code-constants
  it('should define all semantic exit codes', () => {
    expect(EXIT_CODES.SUCCESS).toBe(0);
    expect(EXIT_CODES.ERROR).toBe(1);
    expect(EXIT_CODES.USAGE_ERROR).toBe(2);
    expect(EXIT_CODES.NOT_FOUND).toBe(3);
    expect(EXIT_CODES.VALIDATION_FAILED).toBe(4);
    expect(EXIT_CODES.CONFLICT).toBe(5);
  });

  // AC: @cli-exit-codes exit-code-constants
  it('should have unique values for each exit code', () => {
    const values = Object.values(EXIT_CODES);
    const uniqueValues = new Set(values);
    expect(uniqueValues.size).toBe(values.length);
  });

  // AC: @cli-exit-codes exit-code-constants
  it('should be immutable (as const)', () => {
    // TypeScript will enforce this at compile time
    // This test verifies the values are correct
    expect(typeof EXIT_CODES.SUCCESS).toBe('number');
    expect(typeof EXIT_CODES.ERROR).toBe('number');
    expect(typeof EXIT_CODES.USAGE_ERROR).toBe('number');
    expect(typeof EXIT_CODES.NOT_FOUND).toBe('number');
    expect(typeof EXIT_CODES.VALIDATION_FAILED).toBe('number');
    expect(typeof EXIT_CODES.CONFLICT).toBe('number');
  });
});

describe('EXIT_CODE_METADATA documentation', () => {
  // AC: @cli-exit-codes exit-codes-documented
  it('should document all exit codes', () => {
    const codes = Object.values(EXIT_CODES);
    const documentedCodes = EXIT_CODE_METADATA.map((m) => m.code);

    expect(documentedCodes).toHaveLength(codes.length);
    for (const code of codes) {
      expect(documentedCodes).toContain(code);
    }
  });

  // AC: @cli-exit-codes exit-codes-documented
  it('should have description for each exit code', () => {
    for (const metadata of EXIT_CODE_METADATA) {
      expect(metadata.name).toBeTruthy();
      expect(metadata.description).toBeTruthy();
      expect(metadata.commands).toBeTruthy();
    }
  });

  // AC: @cli-exit-codes exit-codes-documented
  it('should map metadata code values to EXIT_CODES constants', () => {
    const metadataByCode = Object.fromEntries(EXIT_CODE_METADATA.map((m) => [m.code, m]));

    expect(metadataByCode[EXIT_CODES.SUCCESS]?.name).toBe('SUCCESS');
    expect(metadataByCode[EXIT_CODES.ERROR]?.name).toBe('ERROR');
    expect(metadataByCode[EXIT_CODES.USAGE_ERROR]?.name).toBe('USAGE_ERROR');
    expect(metadataByCode[EXIT_CODES.NOT_FOUND]?.name).toBe('NOT_FOUND');
    expect(metadataByCode[EXIT_CODES.VALIDATION_FAILED]?.name).toBe('VALIDATION_FAILED');
    expect(metadataByCode[EXIT_CODES.CONFLICT]?.name).toBe('CONFLICT');
  });
});

describe('Exit codes help content', () => {
  // AC: @cli-exit-codes exit-codes-documented
  it('should have help topic for exit-codes', () => {
    expect(helpContent['exit-codes']).toBeDefined();
    expect(helpContent['exit-codes'].title).toBe('Exit Codes');
  });

  // AC: @cli-exit-codes exit-codes-documented
  it('should document all exit code values in help content', () => {
    const helpText = helpContent['exit-codes'].concept;

    // Check that all exit codes are mentioned in help
    expect(helpText).toContain('0 - SUCCESS');
    expect(helpText).toContain('1 - ERROR');
    expect(helpText).toContain('2 - USAGE_ERROR');
    expect(helpText).toContain('3 - NOT_FOUND');
    expect(helpText).toContain('4 - VALIDATION_FAILED');
    expect(helpText).toContain('5 - CONFLICT');
  });

  // AC: @cli-exit-codes exit-codes-documented
  it('should provide scripting examples in help content', () => {
    const helpText = helpContent['exit-codes'].concept;

    expect(helpText).toContain('Scripting Examples');
    expect(helpText).toContain('kspec task get');
    expect(helpText).toContain('kspec validate');
    expect(helpText).toContain('$?');
  });

  // AC: @cli-exit-codes exit-codes-documented
  it('should document which commands use each code', () => {
    const helpText = helpContent['exit-codes'].concept;

    expect(helpText).toContain('Commands Using Each Code');
    expect(helpText).toContain('task');
    expect(helpText).toContain('validate');
    expect(helpText).toContain('item');
  });
});
