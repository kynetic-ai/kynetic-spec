import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PubSubManager } from '../packages/daemon/src/websocket/pubsub';
import type { ServerWebSocket } from 'bun';
import type { ConnectionData } from '../packages/daemon/src/websocket/types';

describe('PubSubManager', () => {
  let manager: PubSubManager;

  beforeEach(() => {
    manager = new PubSubManager();
  });

  describe('Broadcast Filtering', () => {
    // AC: @multi-directory-daemon ac-18
    it('should only send events to connections with matching projectPath', () => {
      const projectA = '/tmp/project-a';
      const projectB = '/tmp/project-b';

      // Mock WebSocket connections
      const wsA1 = createMockWebSocket('conn-a1', projectA, ['tasks:updates']);
      const wsA2 = createMockWebSocket('conn-a2', projectA, ['tasks:updates']);
      const wsB1 = createMockWebSocket('conn-b1', projectB, ['tasks:updates']);

      manager.addConnection('conn-a1', wsA1);
      manager.addConnection('conn-a2', wsA2);
      manager.addConnection('conn-b1', wsB1);

      // Broadcast event scoped to project A
      manager.broadcast('tasks:updates', 'task_updated', { ref: 'task-1' }, projectA);

      // Only project A connections should receive the event
      expect(wsA1.send).toHaveBeenCalledOnce();
      expect(wsA2.send).toHaveBeenCalledOnce();
      expect(wsB1.send).not.toHaveBeenCalled();
    });

    // AC: @multi-directory-daemon ac-18
    it('should not send events when projectPath does not match', () => {
      const projectA = '/tmp/project-a';
      const projectB = '/tmp/project-b';

      const wsA = createMockWebSocket('conn-a', projectA, ['tasks:updates']);
      const wsB = createMockWebSocket('conn-b', projectB, ['tasks:updates']);

      manager.addConnection('conn-a', wsA);
      manager.addConnection('conn-b', wsB);

      // Broadcast to project B
      manager.broadcast('tasks:updates', 'task_updated', { ref: 'task-1' }, projectB);

      // Only project B should receive
      expect(wsA.send).not.toHaveBeenCalled();
      expect(wsB.send).toHaveBeenCalledOnce();
    });

    // AC: @multi-directory-daemon ac-18
    it('should broadcast to all subscribed connections when projectPath is undefined', () => {
      const projectA = '/tmp/project-a';
      const projectB = '/tmp/project-b';

      const wsA = createMockWebSocket('conn-a', projectA, ['tasks:updates']);
      const wsB = createMockWebSocket('conn-b', projectB, ['tasks:updates']);

      manager.addConnection('conn-a', wsA);
      manager.addConnection('conn-b', wsB);

      // Broadcast without project filter (legacy behavior)
      manager.broadcast('tasks:updates', 'task_updated', { ref: 'task-1' });

      // Both connections should receive
      expect(wsA.send).toHaveBeenCalledOnce();
      expect(wsB.send).toHaveBeenCalledOnce();
    });

    it('should respect topic subscription filtering alongside project filtering', () => {
      const projectA = '/tmp/project-a';

      const ws1 = createMockWebSocket('conn-1', projectA, ['tasks:updates']);
      const ws2 = createMockWebSocket('conn-2', projectA, ['inbox:updates']);

      manager.addConnection('conn-1', ws1);
      manager.addConnection('conn-2', ws2);

      // Broadcast task event to project A
      manager.broadcast('tasks:updates', 'task_updated', { ref: 'task-1' }, projectA);

      // Only conn-1 (subscribed to tasks:updates) should receive
      expect(ws1.send).toHaveBeenCalledOnce();
      expect(ws2.send).not.toHaveBeenCalled();
    });

    it('should handle connections with no projectPath (pre-multi-project)', () => {
      const projectA = '/tmp/project-a';

      const wsLegacy = createMockWebSocket('conn-legacy', undefined, ['tasks:updates']);
      const wsNew = createMockWebSocket('conn-new', projectA, ['tasks:updates']);

      manager.addConnection('conn-legacy', wsLegacy);
      manager.addConnection('conn-new', wsNew);

      // Broadcast to project A
      manager.broadcast('tasks:updates', 'task_updated', { ref: 'task-1' }, projectA);

      // Only new connection (with matching projectPath) should receive
      expect(wsLegacy.send).not.toHaveBeenCalled();
      expect(wsNew.send).toHaveBeenCalledOnce();
    });

    it('should include correct message structure with sequence and metadata', () => {
      const projectA = '/tmp/project-a';
      const ws = createMockWebSocket('conn-1', projectA, ['tasks:updates']);

      manager.addConnection('conn-1', ws);

      manager.broadcast('tasks:updates', 'task_updated', { ref: 'task-1', action: 'start' }, projectA);

      expect(ws.send).toHaveBeenCalledOnce();
      const sentMessage = JSON.parse((ws.send as any).mock.calls[0][0]);

      expect(sentMessage).toMatchObject({
        event: 'task_updated',
        data: { ref: 'task-1', action: 'start' },
      });
      expect(sentMessage).toHaveProperty('msg_id');
      expect(sentMessage).toHaveProperty('seq');
      expect(sentMessage).toHaveProperty('timestamp');
      expect(sentMessage).toHaveProperty('topic', 'tasks:updates');
    });

    it('should increment sequence number per connection', () => {
      const projectA = '/tmp/project-a';
      const ws = createMockWebSocket('conn-1', projectA, ['tasks:updates']);

      manager.addConnection('conn-1', ws);

      manager.broadcast('tasks:updates', 'event1', {}, projectA);
      manager.broadcast('tasks:updates', 'event2', {}, projectA);
      manager.broadcast('tasks:updates', 'event3', {}, projectA);

      expect(ws.send).toHaveBeenCalledTimes(3);

      const messages = (ws.send as any).mock.calls.map((call: any[]) => JSON.parse(call[0]));

      expect(messages[0].seq).toBe(1);
      expect(messages[1].seq).toBe(2);
      expect(messages[2].seq).toBe(3);
    });
  });

  describe('Connection Management', () => {
    it('should track connection count', () => {
      const ws1 = createMockWebSocket('conn-1', '/tmp/project-a', []);
      const ws2 = createMockWebSocket('conn-2', '/tmp/project-b', []);

      expect(manager.getConnectionCount()).toBe(0);

      manager.addConnection('conn-1', ws1);
      expect(manager.getConnectionCount()).toBe(1);

      manager.addConnection('conn-2', ws2);
      expect(manager.getConnectionCount()).toBe(2);

      manager.removeConnection('conn-1');
      expect(manager.getConnectionCount()).toBe(1);
    });

    it('should clean up connection when removed', () => {
      const ws = createMockWebSocket('conn-1', '/tmp/project-a', ['tasks:updates']);

      manager.addConnection('conn-1', ws);
      manager.broadcast('tasks:updates', 'event1', {}, '/tmp/project-a');
      expect(ws.send).toHaveBeenCalledOnce();

      manager.removeConnection('conn-1');
      manager.broadcast('tasks:updates', 'event2', {}, '/tmp/project-a');

      // Should still only be called once (from before removal)
      expect(ws.send).toHaveBeenCalledOnce();
    });
  });
});

// Helper to create mock WebSocket with ConnectionData
function createMockWebSocket(
  sessionId: string,
  projectPath: string | undefined,
  topics: string[]
): ServerWebSocket<ConnectionData> {
  const data: ConnectionData = {
    sessionId,
    topics: new Set(topics),
    seq: 0,
    lastPing: undefined,
    lastPong: Date.now(),
    projectPath: projectPath as any, // Type assertion for test
  };

  return {
    data,
    send: vi.fn(),
    close: vi.fn(),
    // Add minimal required ServerWebSocket properties
  } as unknown as ServerWebSocket<ConnectionData>;
}
