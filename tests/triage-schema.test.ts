import { describe, it, expect } from 'vitest';
import {
  TriageStatusSchema,
  TriageActionSchema,
  TriageRecordSchema,
  TriageRecordInputSchema,
  TriageFileSchema,
} from '../src/schema/index.js';
import { testUlid } from './helpers/cli.js';

const VALID_ULID = testUlid('TRJAGE', 0);
const INBOX_ULID = testUlid('JNBOX', 0);

function validRecord(overrides: Record<string, unknown> = {}) {
  return {
    _ulid: VALID_ULID,
    inbox_ref: INBOX_ULID,
    item_snapshot: 'Add dark mode support',
    status: 'triaged',
    action: 'promote',
    reasoning: 'Clear feature request with user demand',
    decided_by: '@claude',
    evidence_refs: [],
    created_at: '2026-02-22T00:00:00.000Z',
    ...overrides,
  };
}

function actedOnRecord(overrides: Record<string, unknown> = {}) {
  return validRecord({
    status: 'acted_on',
    acted_at: '2026-02-22T02:00:00.000Z',
    result_ref: '@task-new-feature',
    ...overrides,
  });
}

// AC: @triage-record-schema ac-1
describe('TriageRecordSchema - required fields', () => {
  it('should accept a valid triage record with all required fields', () => {
    const result = TriageRecordSchema.safeParse(validRecord());
    expect(result.success).toBe(true);
  });

  // AC: @triage-record-schema ac-1
  it('should require _ulid, inbox_ref, item_snapshot, status, created_at', () => {
    const requiredFields = ['_ulid', 'inbox_ref', 'item_snapshot', 'status', 'created_at'];
    for (const field of requiredFields) {
      const record = validRecord();
      delete (record as Record<string, unknown>)[field];
      const result = TriageRecordSchema.safeParse(record);
      expect(result.success, `should reject missing ${field}`).toBe(false);
    }
  });

  it('should accept a minimal pending record with only required fields', () => {
    const result = TriageRecordSchema.safeParse({
      _ulid: VALID_ULID,
      inbox_ref: INBOX_ULID,
      item_snapshot: 'Some idea',
      status: 'pending',
      created_at: '2026-02-22T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });
});

// AC: @triage-record-schema ac-2
describe('TriageActionSchema', () => {
  it('should accept valid actions: promote, delete, defer, spec-gap, duplicate', () => {
    for (const action of ['promote', 'delete', 'defer', 'spec-gap', 'duplicate']) {
      expect(TriageActionSchema.safeParse(action).success, `should accept ${action}`).toBe(true);
    }
  });

  it('should reject invalid actions', () => {
    expect(TriageActionSchema.safeParse('archive').success).toBe(false);
    expect(TriageActionSchema.safeParse('').success).toBe(false);
    expect(TriageActionSchema.safeParse('PROMOTE').success).toBe(false);
  });
});

// AC: @triage-record-schema ac-1
describe('TriageStatusSchema', () => {
  it('should accept valid statuses: pending, triaged, acted_on', () => {
    for (const status of ['pending', 'triaged', 'acted_on']) {
      expect(TriageStatusSchema.safeParse(status).success, `should accept ${status}`).toBe(true);
    }
  });

  it('should reject invalid statuses', () => {
    expect(TriageStatusSchema.safeParse('completed').success).toBe(false);
    expect(TriageStatusSchema.safeParse('').success).toBe(false);
  });
});

// AC: @triage-record-schema ac-3
describe('TriageRecordSchema - decision fields', () => {
  it('should accept reasoning, decided_by, and evidence_refs', () => {
    const result = TriageRecordSchema.safeParse(validRecord({
      reasoning: 'Clear feature request',
      decided_by: '@claude',
      evidence_refs: ['@some-spec', '@another-ref'],
    }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reasoning).toBe('Clear feature request');
      expect(result.data.decided_by).toBe('@claude');
      expect(result.data.evidence_refs).toEqual(['@some-spec', '@another-ref']);
    }
  });

  it('should default evidence_refs to empty array', () => {
    const result = TriageRecordSchema.safeParse(validRecord({
      evidence_refs: undefined,
    }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.evidence_refs).toEqual([]);
    }
  });

  // AC: @triage-record-schema ac-3
  // AC: @trait-error-guidance ac-5 — validation error indicates which field failed
  it('should reject triaged record without reasoning', () => {
    const result = TriageRecordSchema.safeParse(validRecord({
      reasoning: undefined,
    }));
    expect(result.success).toBe(false);
    if (!result.success) {
      const issues = result.error.issues;
      expect(issues.some(i => i.path.includes('reasoning'))).toBe(true);
    }
  });

  // AC: @triage-record-schema ac-3
  // AC: @trait-error-guidance ac-5 — validation error indicates which field failed
  it('should reject triaged record without decided_by', () => {
    const result = TriageRecordSchema.safeParse(validRecord({
      decided_by: undefined,
    }));
    expect(result.success).toBe(false);
    if (!result.success) {
      const issues = result.error.issues;
      expect(issues.some(i => i.path.includes('decided_by'))).toBe(true);
    }
  });

  // AC: @triage-record-schema ac-3
  // AC: @trait-error-guidance ac-5 — validation error indicates which field failed
  it('should reject triaged record without action', () => {
    const result = TriageRecordSchema.safeParse(validRecord({
      action: undefined,
    }));
    expect(result.success).toBe(false);
    if (!result.success) {
      const issues = result.error.issues;
      expect(issues.some(i => i.path.includes('action'))).toBe(true);
    }
  });

  it('should allow pending record without decision fields', () => {
    const result = TriageRecordSchema.safeParse({
      _ulid: VALID_ULID,
      inbox_ref: INBOX_ULID,
      item_snapshot: 'Idea without decision',
      status: 'pending',
      created_at: '2026-02-22T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });
});

// AC: @triage-record-schema ac-4
describe('TriageRecordSchema - override fields', () => {
  it('should accept override_reasoning, override_by, and override_at', () => {
    const result = TriageRecordSchema.safeParse(validRecord({
      override_reasoning: 'Not ready yet, defer instead',
      override_by: 'alice',
      override_at: '2026-02-22T01:00:00.000Z',
      action: 'defer',
    }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.override_reasoning).toBe('Not ready yet, defer instead');
      expect(result.data.override_by).toBe('alice');
      expect(result.data.override_at).toBe('2026-02-22T01:00:00.000Z');
      // Original decision fields preserved
      expect(result.data.reasoning).toBe('Clear feature request with user demand');
      expect(result.data.decided_by).toBe('@claude');
    }
  });

  it('should allow override fields to be optional', () => {
    const result = TriageRecordSchema.safeParse(validRecord());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.override_reasoning).toBeUndefined();
      expect(result.data.override_by).toBeUndefined();
      expect(result.data.override_at).toBeUndefined();
    }
  });
});

// AC: @triage-record-schema ac-5
describe('TriageRecordSchema - execution fields', () => {
  it('should accept acted_at and result_ref for acted_on status', () => {
    const result = TriageRecordSchema.safeParse(actedOnRecord());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('acted_on');
      expect(result.data.acted_at).toBe('2026-02-22T02:00:00.000Z');
      expect(result.data.result_ref).toBe('@task-new-feature');
    }
  });

  // AC: @triage-record-schema ac-5
  // AC: @trait-error-guidance ac-4 — indicates current state and valid next states
  // AC: @trait-error-guidance ac-5 — validation error indicates which field failed
  it('should reject acted_on record without acted_at', () => {
    const result = TriageRecordSchema.safeParse(actedOnRecord({
      acted_at: undefined,
    }));
    expect(result.success).toBe(false);
    if (!result.success) {
      const issues = result.error.issues;
      expect(issues.some(i => i.path.includes('acted_at'))).toBe(true);
      const actedAtIssue = issues.find(i => i.path.includes('acted_at'));
      expect(actedAtIssue?.message).toContain('acted_at');
    }
  });

  // AC: @triage-record-schema ac-5
  it('should reject acted_on record without action', () => {
    const result = TriageRecordSchema.safeParse(actedOnRecord({
      action: undefined,
    }));
    expect(result.success).toBe(false);
  });
});

// AC: @triage-record-schema ac-6
describe('TriageFileSchema', () => {
  it('should validate a triage file with version and records array', () => {
    const result = TriageFileSchema.safeParse({
      kynetic_triage: '1.0',
      triage: [validRecord()],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kynetic_triage).toBe('1.0');
      expect(result.data.triage).toHaveLength(1);
    }
  });

  it('should accept an empty triage array', () => {
    const result = TriageFileSchema.safeParse({
      kynetic_triage: '1.0',
      triage: [],
    });
    expect(result.success).toBe(true);
  });

  it('should default kynetic_triage version', () => {
    const result = TriageFileSchema.safeParse({
      triage: [],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kynetic_triage).toBe('1.0');
    }
  });
});

// AC: @triage-record-schema ac-7
describe('TriageRecordSchema - item_snapshot preservation', () => {
  it('should require item_snapshot to preserve context after inbox deletion', () => {
    const record = validRecord({ item_snapshot: undefined });
    delete (record as Record<string, unknown>).item_snapshot;
    const result = TriageRecordSchema.safeParse(record);
    expect(result.success).toBe(false);
  });

  it('should reject empty item_snapshot', () => {
    const result = TriageRecordSchema.safeParse(validRecord({ item_snapshot: '' }));
    expect(result.success).toBe(false);
  });
});

// AC: @triage-record-schema ac-9
describe('TriageRecordSchema - updated_at field', () => {
  it('should accept updated_at timestamp', () => {
    const result = TriageRecordSchema.safeParse(validRecord({
      updated_at: '2026-02-22T03:00:00.000Z',
    }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.updated_at).toBe('2026-02-22T03:00:00.000Z');
    }
  });

  it('should allow updated_at to be optional (not set on creation)', () => {
    const result = TriageRecordSchema.safeParse(validRecord());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.updated_at).toBeUndefined();
    }
  });
});

// AC: @trait-error-guidance ac-1 — error includes description of what went wrong
// AC: @trait-error-guidance ac-2 — error includes suggested action to resolve
describe('TriageRecordSchema - error guidance (trait)', () => {
  it('should include descriptive error for invalid ULID', () => {
    const result = TriageRecordSchema.safeParse(validRecord({ _ulid: 'bad' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      const ulidIssue = result.error.issues.find(i => i.path.includes('_ulid'));
      expect(ulidIssue).toBeDefined();
      expect(ulidIssue?.message).toBeTruthy();
    }
  });

  // AC: @trait-error-guidance ac-5 — validation error indicates which field/value failed
  it('should include field path in validation errors', () => {
    const result = TriageRecordSchema.safeParse(validRecord({ status: 'invalid_status' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      const statusIssue = result.error.issues.find(i =>
        i.path.includes('status')
      );
      expect(statusIssue).toBeDefined();
    }
  });

  // AC: @trait-error-guidance ac-4 — invalid state transition guidance
  it('should provide guidance when triaged record missing decision metadata', () => {
    const result = TriageRecordSchema.safeParse(validRecord({
      action: undefined,
      reasoning: undefined,
      decided_by: undefined,
    }));
    expect(result.success).toBe(false);
    if (!result.success) {
      // Should have issues for all three missing fields
      const paths = result.error.issues.map(i => i.path).flat();
      expect(paths).toContain('action');
      expect(paths).toContain('reasoning');
      expect(paths).toContain('decided_by');
    }
  });

  // AC: @trait-error-guidance ac-6 — errors in structured format (Zod issues are JSON-serializable)
  it('should produce JSON-serializable error objects', () => {
    const result = TriageRecordSchema.safeParse(validRecord({ _ulid: 'bad' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      const json = JSON.stringify(result.error.issues);
      expect(json).toBeTruthy();
      const parsed = JSON.parse(json);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed[0]).toHaveProperty('message');
      expect(parsed[0]).toHaveProperty('path');
    }
  });
});

describe('TriageRecordInputSchema', () => {
  it('should accept minimal input (auto-generate ULID and timestamps)', () => {
    const result = TriageRecordInputSchema.safeParse({
      inbox_ref: INBOX_ULID,
      item_snapshot: 'Some idea',
    });
    expect(result.success).toBe(true);
  });

  it('should accept full input with action and reasoning', () => {
    const result = TriageRecordInputSchema.safeParse({
      inbox_ref: INBOX_ULID,
      item_snapshot: 'Some idea',
      action: 'promote',
      reasoning: 'Clear feature request',
      decided_by: '@claude',
    });
    expect(result.success).toBe(true);
  });
});
