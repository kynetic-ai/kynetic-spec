/**
 * Unit tests for Task Board (Kanban) column distribution logic.
 *
 * AC: @ui-task-board ac-1 — Tasks distributed into correct columns
 * AC: @ui-task-board ac-2 — Utility functions for card metadata
 */

import { describe, it, expect } from 'vitest';
import {
	distributeToColumns,
	getStatusClasses,
	formatAge,
	formatElapsed
} from '../src/lib/components/board/board-utils';
import type { TaskSummary } from '../../shared/src/api';

function makeTask(overrides: Partial<TaskSummary> = {}): TaskSummary {
	return {
		_ulid: '01ABC' + Math.random().toString(36).slice(2, 10).toUpperCase(),
		slugs: ['test-task'],
		title: 'Test Task',
		type: 'task',
		status: 'pending',
		priority: 3,
		tags: [],
		depends_on: [],
		created_at: new Date().toISOString(),
		notes_count: 0,
		...overrides
	};
}

describe('distributeToColumns', () => {
	// AC: @ui-task-board ac-1
	it('distributes pending+unassessed tasks to Backlog column', () => {
		const tasks = [
			makeTask({ status: 'pending', automation: undefined }),
			makeTask({ status: 'pending', automation: 'manual_only' })
		];
		const columns = distributeToColumns(tasks);
		const backlog = columns.find((c) => c.id === 'backlog')!;
		expect(backlog.tasks).toHaveLength(2);
	});

	// AC: @ui-task-board ac-1
	it('distributes pending+eligible tasks to Ready column', () => {
		const tasks = [makeTask({ status: 'pending', automation: 'eligible' })];
		const columns = distributeToColumns(tasks);
		const ready = columns.find((c) => c.id === 'ready')!;
		expect(ready.tasks).toHaveLength(1);
	});

	// AC: @ui-task-board ac-1
	it('distributes in_progress and needs_work to In Progress column', () => {
		const tasks = [
			makeTask({ status: 'in_progress' }),
			makeTask({ status: 'needs_work' })
		];
		const columns = distributeToColumns(tasks);
		const inProgress = columns.find((c) => c.id === 'in_progress')!;
		expect(inProgress.tasks).toHaveLength(2);
	});

	// AC: @ui-task-board ac-1
	it('distributes pending_review to Review column', () => {
		const tasks = [makeTask({ status: 'pending_review' })];
		const columns = distributeToColumns(tasks);
		const review = columns.find((c) => c.id === 'review')!;
		expect(review.tasks).toHaveLength(1);
	});

	// AC: @ui-task-board ac-1
	it('distributes completed to Done column (limited to 20)', () => {
		const tasks = Array.from({ length: 25 }, (_, i) =>
			makeTask({
				status: 'completed',
				created_at: new Date(Date.now() - i * 86400000).toISOString()
			})
		);
		const columns = distributeToColumns(tasks);
		const done = columns.find((c) => c.id === 'done')!;
		expect(done.tasks).toHaveLength(20);
	});

	// AC: @ui-task-board ac-1
	it('places blocked tasks in In Progress column', () => {
		const tasks = [makeTask({ status: 'blocked' })];
		const columns = distributeToColumns(tasks);
		const inProgress = columns.find((c) => c.id === 'in_progress')!;
		expect(inProgress.tasks).toHaveLength(1);
		expect(inProgress.tasks[0].status).toBe('blocked');
	});

	// AC: @ui-task-board ac-1
	it('places cancelled tasks in Done column', () => {
		const tasks = [makeTask({ status: 'cancelled' })];
		const columns = distributeToColumns(tasks);
		const done = columns.find((c) => c.id === 'done')!;
		expect(done.tasks).toHaveLength(1);
		expect(done.tasks[0].status).toBe('cancelled');
	});

	// AC: @ui-task-board ac-1
	it('sorts columns by priority (lower number = higher priority)', () => {
		const tasks = [
			makeTask({ status: 'pending', automation: 'eligible', priority: 5 }),
			makeTask({ status: 'pending', automation: 'eligible', priority: 1 }),
			makeTask({ status: 'pending', automation: 'eligible', priority: 3 })
		];
		const columns = distributeToColumns(tasks);
		const ready = columns.find((c) => c.id === 'ready')!;
		expect(ready.tasks[0].priority).toBe(1);
		expect(ready.tasks[1].priority).toBe(3);
		expect(ready.tasks[2].priority).toBe(5);
	});

	// AC: @ui-task-board ac-1
	it('returns all five columns even when empty', () => {
		const columns = distributeToColumns([]);
		expect(columns).toHaveLength(5);
		expect(columns.map((c) => c.id)).toEqual([
			'backlog',
			'ready',
			'in_progress',
			'review',
			'done'
		]);
	});
});

describe('getStatusClasses', () => {
	// AC: @ui-task-board ac-2
	it('returns correct classes for all known statuses', () => {
		const statuses = [
			'pending',
			'in_progress',
			'pending_review',
			'needs_work',
			'completed',
			'blocked',
			'cancelled'
		];
		for (const status of statuses) {
			const result = getStatusClasses(status);
			expect(result.bg).toBeTruthy();
			expect(result.fg).toBeTruthy();
			expect(result.label).toBeTruthy();
		}
	});

	// AC: @ui-task-board ac-2
	it('returns fallback for unknown status', () => {
		const result = getStatusClasses('unknown');
		expect(result.bg).toBe('bg-muted');
		expect(result.label).toBe('unknown');
	});
});

describe('formatAge', () => {
	// AC: @ui-task-board ac-2
	it('formats recent dates as minutes', () => {
		const fiveMinAgo = new Date(Date.now() - 5 * 60000).toISOString();
		expect(formatAge(fiveMinAgo)).toBe('5m');
	});

	// AC: @ui-task-board ac-2
	it('formats hours', () => {
		const threeHoursAgo = new Date(Date.now() - 3 * 3600000).toISOString();
		expect(formatAge(threeHoursAgo)).toBe('3h');
	});

	// AC: @ui-task-board ac-2
	it('formats days', () => {
		const fiveDaysAgo = new Date(Date.now() - 5 * 86400000).toISOString();
		expect(formatAge(fiveDaysAgo)).toBe('5d');
	});
});

describe('formatElapsed', () => {
	// AC: @ui-task-board ac-4
	it('formats seconds', () => {
		expect(formatElapsed(45000)).toBe('45s');
	});

	// AC: @ui-task-board ac-4
	it('formats minutes and seconds', () => {
		expect(formatElapsed(125000)).toBe('2m 5s');
	});

	// AC: @ui-task-board ac-4
	it('formats hours and minutes', () => {
		expect(formatElapsed(3725000)).toBe('1h 2m');
	});
});
