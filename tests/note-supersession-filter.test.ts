/**
 * Tests for note supersession filtering
 * Verifies that superseded notes are hidden from default display but shown with --all flag
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  kspecOutput as kspec,
  kspecJson,
  setupTempFixtures,
  cleanupTempDir,
  initGitRepo,
} from './helpers/cli';
import type { Note } from '../src/schema/index.js';

describe('Note supersession filtering', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    initGitRepo(tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  describe('task get', () => {
    it('should hide superseded notes by default', () => {
      // Add initial note
      kspec('task note @test-task-pending "Initial implementation"', tempDir);

      // Get the first note's ULID
      const taskWithOneNote = kspecJson<{ notes: Array<Note & { superseded?: boolean }> }>(
        'task get @test-task-pending',
        tempDir
      );
      expect(taskWithOneNote.notes.length).toBe(1);
      const firstNoteUlid = taskWithOneNote.notes[0]._ulid;

      // Add superseding note
      kspec(`task note @test-task-pending "Updated implementation" --supersedes ${firstNoteUlid}`, tempDir);

      // Get task - text output should hide superseded note
      const textOutput = kspec('task get @test-task-pending', tempDir);
      expect(textOutput).toContain('Updated implementation');
      expect(textOutput).not.toContain('Initial implementation');
      expect(textOutput).toContain('1 superseded note hidden');
    });

    it('should show all notes with --all flag', () => {
      // Add initial note
      kspec('task note @test-task-pending "Initial implementation"', tempDir);

      // Get the first note's ULID
      const taskWithOneNote = kspecJson<{ notes: Array<Note & { superseded?: boolean }> }>(
        'task get @test-task-pending',
        tempDir
      );
      const firstNoteUlid = taskWithOneNote.notes[0]._ulid;

      // Add superseding note
      kspec(`task note @test-task-pending "Updated implementation" --supersedes ${firstNoteUlid}`, tempDir);

      // Get task with --all - should show both notes
      const textOutput = kspec('task get @test-task-pending --all', tempDir);
      expect(textOutput).toContain('Updated implementation');
      expect(textOutput).toContain('Initial implementation');
      expect(textOutput).not.toContain('superseded note hidden');
    });

    it('should include superseded field in JSON output', () => {
      // Add initial note
      kspec('task note @test-task-pending "Initial implementation"', tempDir);

      // Get the first note's ULID
      const taskWithOneNote = kspecJson<{ notes: Array<Note & { superseded?: boolean }> }>(
        'task get @test-task-pending',
        tempDir
      );
      const firstNoteUlid = taskWithOneNote.notes[0]._ulid;

      // Add superseding note
      kspec(`task note @test-task-pending "Updated implementation" --supersedes ${firstNoteUlid}`, tempDir);

      // JSON output should always include all notes with superseded field
      const jsonOutput = kspecJson<{ notes: Array<Note & { superseded: boolean }> }>(
        'task get @test-task-pending',
        tempDir
      );

      expect(jsonOutput.notes.length).toBe(2);

      // Find the notes by content
      const initialNote = jsonOutput.notes.find(n => n.content === 'Initial implementation');
      const updatedNote = jsonOutput.notes.find(n => n.content === 'Updated implementation');

      expect(initialNote).toBeDefined();
      expect(updatedNote).toBeDefined();
      expect(initialNote?.superseded).toBe(true);
      expect(updatedNote?.superseded).toBe(false);
    });

    it('should show notes without supersession normally', () => {
      // Add multiple non-superseding notes
      kspec('task note @test-task-pending "First note"', tempDir);
      kspec('task note @test-task-pending "Second note"', tempDir);
      kspec('task note @test-task-pending "Third note"', tempDir);

      // All notes should be visible
      const textOutput = kspec('task get @test-task-pending', tempDir);
      expect(textOutput).toContain('First note');
      expect(textOutput).toContain('Second note');
      expect(textOutput).toContain('Third note');
      expect(textOutput).not.toContain('superseded note hidden');
    });

    it('should mark superseding notes with indicator', () => {
      // Add initial note
      kspec('task note @test-task-pending "Initial implementation"', tempDir);

      // Get the first note's ULID
      const taskWithOneNote = kspecJson<{ notes: Array<Note & { superseded?: boolean }> }>(
        'task get @test-task-pending',
        tempDir
      );
      const firstNoteUlid = taskWithOneNote.notes[0]._ulid;

      // Add superseding note
      kspec(`task note @test-task-pending "Updated implementation" --supersedes ${firstNoteUlid}`, tempDir);

      // The superseding note should indicate it supersedes another
      const textOutput = kspec('task get @test-task-pending', tempDir);
      expect(textOutput).toContain('supersedes earlier note');
    });

    it('should handle multiple superseded notes', () => {
      // Add first note
      kspec('task note @test-task-pending "Version 1"', tempDir);
      const v1 = kspecJson<{ notes: Array<Note> }>('task get @test-task-pending', tempDir);
      const v1Ulid = v1.notes[0]._ulid;

      // Add second note superseding first
      kspec(`task note @test-task-pending "Version 2" --supersedes ${v1Ulid}`, tempDir);
      const v2Task = kspecJson<{ notes: Array<Note & { superseded: boolean }> }>('task get @test-task-pending', tempDir);
      const v2Note = v2Task.notes.find(n => n.content === 'Version 2');
      const v2Ulid = v2Note?._ulid;

      // Add third note superseding second
      kspec(`task note @test-task-pending "Version 3" --supersedes ${v2Ulid}`, tempDir);

      // Default view should only show latest note
      const textOutput = kspec('task get @test-task-pending', tempDir);
      expect(textOutput).toContain('Version 3');
      expect(textOutput).not.toContain('Version 1');
      expect(textOutput).not.toContain('Version 2');
      expect(textOutput).toContain('2 superseded notes hidden');

      // JSON should show all with superseded flags
      const jsonOutput = kspecJson<{ notes: Array<Note & { superseded: boolean }> }>(
        'task get @test-task-pending',
        tempDir
      );
      expect(jsonOutput.notes.length).toBe(3);

      const v1Note = jsonOutput.notes.find(n => n.content === 'Version 1');
      const v2NoteJson = jsonOutput.notes.find(n => n.content === 'Version 2');
      const v3Note = jsonOutput.notes.find(n => n.content === 'Version 3');

      expect(v1Note?.superseded).toBe(true);
      expect(v2NoteJson?.superseded).toBe(true);
      expect(v3Note?.superseded).toBe(false);
    });
  });

  describe('session start', () => {
    it('should filter superseded notes from recent_notes', () => {
      // Start a task and add notes
      kspec('task start @test-task-pending', tempDir);
      kspec('task note @test-task-pending "Initial work"', tempDir);

      // Get the first note's ULID
      const taskWithOneNote = kspecJson<{ notes: Array<Note> }>(
        'task get @test-task-pending',
        tempDir
      );
      const firstNoteUlid = taskWithOneNote.notes[0]._ulid;

      // Add superseding note
      kspec(`task note @test-task-pending "Updated work" --supersedes ${firstNoteUlid}`, tempDir);

      // Session start should only show the non-superseded note
      const session = kspecJson<{ recent_notes: Array<{ content: string }> }>(
        'session start',
        tempDir
      );

      // Only the superseding note should appear
      const noteContents = session.recent_notes.map(n => n.content);
      expect(noteContents).toContain('Updated work');
      expect(noteContents).not.toContain('Initial work');
    });
  });
});
