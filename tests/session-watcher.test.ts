/**
 * Tests for the daemon session watcher.
 *
 * Verifies .kspec-sessions changes produce project-local callbacks without
 * depending on the daemon E2E harness.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { setupMultiDirFixtures, cleanupTempDir } from './helpers/cli';
import { SessionWatcher } from '../packages/daemon/src/session-watcher';

const DEBOUNCE_WAIT = process.env.CI ? 2000 : 600;
const describeOrSkip = process.env.CI ? describe.skip : describe;

describeOrSkip('SessionWatcher', () => {
	let fixturesRoot: string;
	let projectDir: string;

	beforeEach(async () => {
		fixturesRoot = await setupMultiDirFixtures();
		projectDir = join(fixturesRoot, 'project-a');
	});

	afterEach(async () => {
		await cleanupTempDir(fixturesRoot);
	});

	it('fires when session metadata changes under .kspec-sessions', async () => {
		const onSessionChange = vi.fn();
		const sessionDir = join(projectDir, '.kspec-sessions', '01JTESTSESSIONWATCHER0000001');
		await mkdir(sessionDir, { recursive: true });
		const metadataPath = join(sessionDir, 'session.yaml');
		await writeFile(
			metadataPath,
			[
				'id: 01JTESTSESSIONWATCHER0000001',
				'agent_type: task-worker',
				'status: active',
				'started_at: "2026-03-19T12:00:00.000Z"',
				''
			].join('\n')
		);

		const watcher = new SessionWatcher({
			sessionsDir: join(projectDir, '.kspec-sessions'),
			onSessionChange,
			onError: vi.fn()
		});

		await watcher.start();

		await writeFile(
			metadataPath,
			[
				'id: 01JTESTSESSIONWATCHER0000001',
				'agent_type: task-worker',
				'status: completed',
				'started_at: "2026-03-19T12:00:00.000Z"',
				''
			].join('\n')
		);

		await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_WAIT));

		expect(onSessionChange).toHaveBeenCalled();

		await watcher.stop();
	});

	it('stops emitting after watcher stop', async () => {
		const onSessionChange = vi.fn();
		const watcher = new SessionWatcher({
			sessionsDir: join(projectDir, '.kspec-sessions'),
			onSessionChange,
			onError: vi.fn()
		});

		await watcher.start();
		await watcher.stop();

		const sessionDir = join(projectDir, '.kspec-sessions', '01JTESTSESSIONWATCHER0000002');
		await mkdir(sessionDir, { recursive: true });
		const metadataPath = join(sessionDir, 'session.yaml');
		await writeFile(
			metadataPath,
			[
				'id: 01JTESTSESSIONWATCHER0000002',
				'agent_type: task-worker',
				'status: completed',
				'started_at: "2026-03-19T12:00:00.000Z"',
				''
			].join('\n')
		);

		await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_WAIT));

		expect(onSessionChange).not.toHaveBeenCalled();
	});
});
