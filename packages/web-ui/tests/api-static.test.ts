import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KspecSnapshot } from '../../shared/src/api';

const modeState = vi.hoisted(() => ({
	snapshot: null as KspecSnapshot | null
}));

vi.mock('$lib/stores/mode.svelte', () => ({
	getSnapshot: () => modeState.snapshot,
	ReadOnlyModeError: class ReadOnlyModeError extends Error {
		constructor(operation: string) {
			super(`Cannot ${operation} in read-only mode.`);
		}
	}
}));

import {
	fetchAlignmentStatic,
	fetchItemsStatic,
	fetchPlanContentStatic,
	fetchPlansStatic,
	fetchTasksStatic,
	fetchTriageRecordsStatic,
	fetchValidationStatic
} from '../src/lib/api-static';

function createSnapshot(): KspecSnapshot {
	return {
		version: '1.0.0',
		exported_at: '2026-03-08T00:00:00.000Z',
		project: { name: 'Test Project', version: '0.1.0' },
		tasks: [
			{
				_ulid: '01TASK00000000000000000001',
				slugs: ['task-one'],
				title: 'Task One',
				type: 'task',
				status: 'in_progress',
				priority: 2,
				spec_ref: '@spec-one',
				tags: ['ui'],
				depends_on: [],
				plan_ref: '@plan-one',
				automation: 'eligible',
				notes: [],
				todos: [],
				notes_count: 0,
				todos_count: 0,
				created_at: '2026-03-01T00:00:00.000Z'
			},
			{
				_ulid: '01TASK00000000000000000002',
				slugs: ['task-two'],
				title: 'Task Two',
				type: 'task',
				status: 'pending',
				priority: 3,
				spec_ref: '@spec-two',
				tags: ['docs'],
				depends_on: [],
				plan_ref: '@plan-two',
				notes: [],
				todos: [],
				notes_count: 0,
				todos_count: 0,
				created_at: '2026-03-02T00:00:00.000Z'
			}
		],
		items: [
			{
				_ulid: '01SPEC00000000000000000001',
				slugs: ['spec-one'],
				title: 'Spec One',
				type: 'feature',
				tags: ['ui'],
				traits: [],
				depends_on: [],
				acceptance_criteria: [
					{
						_ulid: '01AC0000000000000000000001',
						given: 'given',
						when: 'when',
						then: 'then'
					}
				],
				created_at: '2026-03-01T00:00:00.000Z'
			},
			{
				_ulid: '01SPEC00000000000000000002',
				slugs: ['spec-two'],
				title: 'Spec Two',
				type: 'feature',
				tags: ['docs'],
				traits: [],
				depends_on: [],
				acceptance_criteria: [],
				created_at: '2026-03-02T00:00:00.000Z'
			}
		],
		inbox: [],
		plans: [
			{
				_ulid: '01PLAN00000000000000000001',
				slugs: ['plan-one'],
				title: 'Plan One',
				status: 'active',
				created_at: '2026-03-01T00:00:00.000Z',
				derived_specs: ['@spec-one'],
				derived_tasks: ['@task-one'],
				spec_count: 1,
				task_count: 1,
				task_progress: {
					total: 1,
					completed: 0,
					in_progress: 1,
					pending: 0,
					blocked: 0
				},
				content: '# Plan One'
			}
		],
		triage: [
			{
				_ulid: '01TRIAGE000000000000000001',
				inbox_ref: '01INBOX000000000000000001',
				item_snapshot: 'Investigate static mode',
				status: 'triaged',
				action: 'defer',
				reasoning: 'Later',
				decided_by: '@test-user',
				evidence_refs: [],
				created_at: '2026-03-03T00:00:00.000Z'
			}
		],
		session: null,
		observations: [],
		agents: [],
		workflows: [],
		conventions: [],
		validation: {
			valid: false,
			errorCount: 1,
			warningCount: 2,
			schemaErrors: [{ file: 'a.yaml', message: 'schema problem' }],
			refErrors: [],
			refWarnings: [],
			orphans: [],
			completenessWarnings: [
				{
					type: 'missing_test_coverage',
					itemRef: '@spec-one',
					itemTitle: 'Spec One',
					message: 'Missing coverage',
					details: 'Uncovered: ac-1'
				}
			],
			traitCycles: [],
			errors: [{ file: 'a.yaml', message: 'schema problem' }],
			warnings: [{ file: '@spec-one', message: 'Missing coverage' }]
		},
		alignment: {
			stats: {
				totalSpecs: 2,
				specsWithTasks: 1,
				alignedSpecs: 1,
				orphanedSpecs: 1
			},
			warnings: []
		}
	};
}

describe('static API snapshot adapters', () => {
	beforeEach(() => {
		modeState.snapshot = createSnapshot();
	});

	// AC: @gh-pages-export ac-23
	it('returns static plans and resolves plan content by ref', () => {
		const plans = fetchPlansStatic();
		expect(plans.total).toBe(1);
		expect(plans.items[0].title).toBe('Plan One');

		const detail = fetchPlanContentStatic('@plan-one');
		expect(detail.content).toContain('Plan One');
	});

	// AC: @gh-pages-export ac-23
	it('returns static triage records with filters', () => {
		const triaged = fetchTriageRecordsStatic({ status: 'triaged' });
		expect(triaged.total).toBe(1);
		expect(triaged.items[0].action).toBe('defer');

		const acted = fetchTriageRecordsStatic({ status: 'acted_on' });
		expect(acted.total).toBe(0);
	});

	// AC: @gh-pages-export ac-21
	it('returns detailed validation and alignment data from the snapshot', () => {
		const validation = fetchValidationStatic();
		const alignment = fetchAlignmentStatic();

		expect(validation.schemaErrors).toHaveLength(1);
		expect(validation.completenessWarnings).toHaveLength(1);
		expect(alignment.stats.totalSpecs).toBe(2);
		expect(alignment.stats.orphanedSpecs).toBe(1);
	});

	// AC: @gh-pages-export ac-23
	it('supports plan filtering for static task and item lists', () => {
		const tasks = fetchTasksStatic({ plan: 'plan-one' });
		const items = fetchItemsStatic({ plan: 'plan-one' });

		expect(tasks.total).toBe(1);
		expect(tasks.items[0].title).toBe('Task One');
		expect(items.total).toBe(1);
		expect(items.items[0].title).toBe('Spec One');
		expect(items.items[0].acceptance_criteria_count).toBe(1);
	});
});
