import { describe, it, expect } from 'vitest';
import { findClosestCommand, COMMAND_ALIASES } from '../src/cli/suggest.js';

describe('Command Suggestions', () => {
  const validCommands = [
    'tasks',
    'task',
    'inbox',
    'item',
    'validate',
    'derive',
    'session',
    'meta',
    'link',
  ];

  describe('findClosestCommand', () => {
    it('should suggest tasks for taks', () => {
      const result = findClosestCommand('taks', validCommands);
      expect(result).toBe('tasks');
    });

    it('should suggest task for tassk', () => {
      const result = findClosestCommand('tassk', validCommands);
      expect(result).toBe('task');
    });

    it('should suggest inbox for inbx', () => {
      const result = findClosestCommand('inbx', validCommands);
      expect(result).toBe('inbox');
    });

    it('should suggest item for itme', () => {
      const result = findClosestCommand('itme', validCommands);
      expect(result).toBe('item');
    });

    it('should suggest validate for validat', () => {
      const result = findClosestCommand('validat', validCommands);
      expect(result).toBe('validate');
    });

    it('should suggest meta for metta', () => {
      const result = findClosestCommand('metta', validCommands);
      expect(result).toBe('meta');
    });

    it('should return null for commands with distance > threshold', () => {
      const result = findClosestCommand('completelywrong', validCommands);
      expect(result).toBeNull();
    });

    it('should be case-insensitive', () => {
      const result = findClosestCommand('TAKS', validCommands);
      expect(result).toBe('tasks');
    });

    it('should handle custom threshold', () => {
      // With threshold of 1, this should not match
      const result = findClosestCommand('taskss', validCommands, 1);
      expect(result).toBe('tasks');
    });

    it('should return closest match when multiple are within threshold', () => {
      // 'tas' is closer to 'task' (distance 1) than 'tasks' (distance 2)
      const result = findClosestCommand('tas', validCommands);
      expect(result).toBe('task');
    });
  });

  describe('COMMAND_ALIASES', () => {
    it('should be defined', () => {
      expect(COMMAND_ALIASES).toBeDefined();
      expect(typeof COMMAND_ALIASES).toBe('object');
    });
  });
});
