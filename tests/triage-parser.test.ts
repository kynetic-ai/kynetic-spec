import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  createTempDir,
  cleanupTempDir,
  initGitRepo,
  testUlid,
  testUlids,
} from './helpers/cli.js';
import {
  getTriageFilePath,
  loadTriageRecords,
  saveTriageRecord,
  findTriageRecordByRef,
  findTriageRecordByInboxRef,
  type LoadedTriageRecord,
  type KspecContext,
  toYaml,
} from '../src/parser/yaml.js';

function makeContext(specDir: string): KspecContext {
  const projectRoot = path.dirname(specDir);
  return {
    rootDir: projectRoot,
    projectRoot,
    specDir,
    sessionsDir: path.join(projectRoot, ".kspec-sessions"),
    manifestPath: null,
    manifest: null,
    shadow: null,
    config: {
      shadow: { branch: 'kspec-meta', directory: '.kspec', remote: null, sync_interval: 60 },
      identity: { author: null },
      validation: { strict_refs: true, require_acceptance: false },
      daemon: { port: 3456, host: 'localhost', auto_start: true },
      agent: {
        skills: {
          task_work: '/kspec:task-work',
          reflect: '/kspec:reflect',
          pr_review: '/kspec:review',
        },
      },
    },
  };
}

function makeRecord(overrides: Partial<LoadedTriageRecord> = {}): LoadedTriageRecord {
  return {
    _ulid: testUlid('TRJAGE', 0),
    inbox_ref: testUlid('JNBOX', 0),
    item_snapshot: 'Add dark mode support',
    status: 'triaged',
    action: 'promote',
    reasoning: 'Clear feature request',
    decided_by: '@claude',
    evidence_refs: [],
    created_at: '2026-02-22T00:00:00.000Z',
    ...overrides,
  };
}

let tempDir: string;
let ctx: KspecContext;

beforeEach(async () => {
  tempDir = await createTempDir('triage-parser-');
  ctx = makeContext(tempDir);
});

afterEach(async () => {
  await cleanupTempDir(tempDir);
});

describe('getTriageFilePath', () => {
  // AC: @triage-record-schema ac-6
  it('should return project.triage.yaml path in specDir', () => {
    const result = getTriageFilePath(ctx);
    expect(result).toBe(path.join(tempDir, 'project.triage.yaml'));
  });
});

describe('loadTriageRecords', () => {
  // AC: @triage-record-schema ac-6
  it('should return empty array when file does not exist', async () => {
    const records = await loadTriageRecords(ctx);
    expect(records).toEqual([]);
  });

  // AC: @triage-record-schema ac-6
  it('should load records from TriageFileSchema format', async () => {
    const record = makeRecord();
    const { _sourceFile, ...clean } = record;
    await fs.writeFile(
      path.join(tempDir, 'project.triage.yaml'),
      toYaml({ kynetic_triage: '1.0', triage: [clean] }),
    );

    const records = await loadTriageRecords(ctx);
    expect(records).toHaveLength(1);
    expect(records[0]._ulid).toBe(record._ulid);
    expect(records[0].inbox_ref).toBe(record.inbox_ref);
    expect(records[0].item_snapshot).toBe('Add dark mode support');
    expect(records[0]._sourceFile).toBe(path.join(tempDir, 'project.triage.yaml'));
  });

  // AC: @triage-record-schema ac-7
  // AC: @interactive-triage ac-1 (records survive inbox item deletion)
  it('should preserve item_snapshot even when inbox item no longer exists', async () => {
    const record = makeRecord({ item_snapshot: 'Original idea text that was deleted' });
    const { _sourceFile, ...clean } = record;
    await fs.writeFile(
      path.join(tempDir, 'project.triage.yaml'),
      toYaml({ kynetic_triage: '1.0', triage: [clean] }),
    );

    const records = await loadTriageRecords(ctx);
    expect(records[0].item_snapshot).toBe('Original idea text that was deleted');
  });
});

describe('saveTriageRecord', () => {
  // AC: @triage-record-schema ac-8
  // AC: @interactive-triage ac-1 (records persist in project.triage.yaml)
  it('should create triage file and save a new record', async () => {
    const record = makeRecord();
    await saveTriageRecord(ctx, record);

    const records = await loadTriageRecords(ctx);
    expect(records).toHaveLength(1);
    expect(records[0]._ulid).toBe(record._ulid);
  });

  // AC: @triage-record-schema ac-9
  it('should set updated_at on every save', async () => {
    const record = makeRecord();
    await saveTriageRecord(ctx, record);

    const records = await loadTriageRecords(ctx);
    expect(records[0].updated_at).toBeDefined();
    expect(typeof records[0].updated_at).toBe('string');
  });

  it('should update existing record by ULID', async () => {
    const record = makeRecord();
    await saveTriageRecord(ctx, record);

    // Update with new reasoning
    const updated = makeRecord({ reasoning: 'Updated reasoning' });
    await saveTriageRecord(ctx, updated);

    const records = await loadTriageRecords(ctx);
    expect(records).toHaveLength(1);
    expect(records[0].reasoning).toBe('Updated reasoning');
  });

  // AC: @triage-record-schema ac-8
  it('should upsert by inbox_ref — no duplicate records per inbox item', async () => {
    const [ulid1, ulid2] = testUlids('TRJAGE', 2);
    const inboxRef = testUlid('JNBOX', 0);

    // First record
    await saveTriageRecord(ctx, makeRecord({
      _ulid: ulid1,
      inbox_ref: inboxRef,
      reasoning: 'First assessment',
    }));

    // Second record with different ULID but same inbox_ref
    await saveTriageRecord(ctx, makeRecord({
      _ulid: ulid2,
      inbox_ref: inboxRef,
      reasoning: 'Second assessment',
    }));

    const records = await loadTriageRecords(ctx);
    expect(records).toHaveLength(1);
    expect(records[0].reasoning).toBe('Second assessment');
  });

  // AC: @triage-record-schema ac-8
  it('should preserve existing _ulid and created_at when upserting by inbox_ref', async () => {
    const [ulid1, ulid2] = testUlids('TRJAGE', 2);
    const inboxRef = testUlid('JNBOX', 0);
    const originalCreatedAt = '2026-01-01T00:00:00.000Z';

    // First record establishes identity
    await saveTriageRecord(ctx, makeRecord({
      _ulid: ulid1,
      inbox_ref: inboxRef,
      created_at: originalCreatedAt,
      reasoning: 'First assessment',
    }));

    // Second record with different ULID but same inbox_ref — identity should be preserved
    await saveTriageRecord(ctx, makeRecord({
      _ulid: ulid2,
      inbox_ref: inboxRef,
      created_at: '2026-02-22T00:00:00.000Z',
      reasoning: 'Updated assessment',
    }));

    const records = await loadTriageRecords(ctx);
    expect(records).toHaveLength(1);
    expect(records[0]._ulid).toBe(ulid1); // original identity preserved
    expect(records[0].created_at).toBe(originalCreatedAt); // original timestamp preserved
    expect(records[0].reasoning).toBe('Updated assessment'); // content updated
  });

  it('should save multiple records for different inbox items', async () => {
    const [ulid1, ulid2] = testUlids('TRJAGE', 2);
    const [inbox1, inbox2] = testUlids('JNBOX', 2);

    await saveTriageRecord(ctx, makeRecord({
      _ulid: ulid1,
      inbox_ref: inbox1,
      item_snapshot: 'First item',
    }));

    await saveTriageRecord(ctx, makeRecord({
      _ulid: ulid2,
      inbox_ref: inbox2,
      item_snapshot: 'Second item',
    }));

    const records = await loadTriageRecords(ctx);
    expect(records).toHaveLength(2);
  });

  it('should write TriageFileSchema format with version', async () => {
    await saveTriageRecord(ctx, makeRecord());

    const content = await fs.readFile(
      path.join(tempDir, 'project.triage.yaml'),
      'utf-8',
    );
    expect(content).toContain('kynetic_triage');
    expect(content).toContain('triage:');
  });
});

describe('findTriageRecordByRef', () => {
  it('should find by full ULID', () => {
    const records = [makeRecord()];
    const found = findTriageRecordByRef(records, records[0]._ulid);
    expect(found).toBeDefined();
    expect(found?._ulid).toBe(records[0]._ulid);
  });

  it('should find by short ULID prefix', () => {
    const records = [makeRecord()];
    const prefix = records[0]._ulid.slice(0, 8);
    const found = findTriageRecordByRef(records, prefix);
    expect(found).toBeDefined();
  });

  it('should find with @ prefix', () => {
    const records = [makeRecord()];
    const found = findTriageRecordByRef(records, `@${records[0]._ulid}`);
    expect(found).toBeDefined();
  });

  it('should return undefined for non-matching ref', () => {
    const records = [makeRecord()];
    const found = findTriageRecordByRef(records, 'ZZZZZZZZZZZZZZZZZZZZZZZZZ0');
    expect(found).toBeUndefined();
  });
});

// AC: @triage-record-schema ac-8
describe('findTriageRecordByInboxRef', () => {
  it('should find by inbox_ref ULID', () => {
    const records = [makeRecord()];
    const found = findTriageRecordByInboxRef(records, records[0].inbox_ref);
    expect(found).toBeDefined();
    expect(found?.inbox_ref).toBe(records[0].inbox_ref);
  });

  it('should handle @ prefix on inbox_ref', () => {
    const records = [makeRecord()];
    const found = findTriageRecordByInboxRef(records, `@${records[0].inbox_ref}`);
    expect(found).toBeDefined();
  });

  it('should return undefined when no matching inbox_ref', () => {
    const records = [makeRecord()];
    const found = findTriageRecordByInboxRef(records, testUlid('N0NE', 0));
    expect(found).toBeUndefined();
  });
});
