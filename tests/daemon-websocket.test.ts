/**
 * E2E tests for WebSocket protocol
 * Spec: @api-contract (ac-25 to ac-32), @trait-websocket-protocol, @daemon-server (ac-13, ac-14)
 */

import { describe, it, expect } from 'vitest';
import { readFile } from 'fs/promises';
import { join } from 'path';

describe('WebSocket Protocol', () => {
  describe('Types and Interfaces', () => {
    let typesContent: string;

    it('should have types file with protocol definitions', async () => {
      typesContent = await readFile(
        join(process.cwd(), 'packages/daemon/src/websocket/types.ts'),
        'utf-8'
      );

      expect(typesContent).toBeTruthy();
    });

    // AC: @api-contract ac-26
    it('should define WebSocketCommand interface with action and request_id', async () => {
      typesContent = await readFile(
        join(process.cwd(), 'packages/daemon/src/websocket/types.ts'),
        'utf-8'
      );

      expect(typesContent).toContain('interface WebSocketCommand');
      expect(typesContent).toContain("action:");
      expect(typesContent).toContain("request_id?:");
      expect(typesContent).toContain("payload?:");
    });

    // AC: @api-contract ac-27
    it('should define CommandAck interface with ack and request_id fields', async () => {
      typesContent = await readFile(
        join(process.cwd(), 'packages/daemon/src/websocket/types.ts'),
        'utf-8'
      );

      expect(typesContent).toContain('interface CommandAck');
      expect(typesContent).toContain('ack:');
      expect(typesContent).toContain('request_id?:');
      expect(typesContent).toContain('success:');
      expect(typesContent).toContain('error?:');
    });

    // AC: @api-contract ac-25, @trait-websocket-protocol ac-1
    it('should define ConnectedEvent with session_id', async () => {
      typesContent = await readFile(
        join(process.cwd(), 'packages/daemon/src/websocket/types.ts'),
        'utf-8'
      );

      expect(typesContent).toContain('interface ConnectedEvent');
      expect(typesContent).toContain("event: 'connected'");
      expect(typesContent).toContain('session_id:');
    });

    // AC: @api-contract ac-29, @trait-websocket-protocol ac-3
    it('should define BroadcastEvent with msg_id, seq, timestamp, topic, event, data', async () => {
      typesContent = await readFile(
        join(process.cwd(), 'packages/daemon/src/websocket/types.ts'),
        'utf-8'
      );

      expect(typesContent).toContain('interface BroadcastEvent');
      expect(typesContent).toContain('msg_id:');
      expect(typesContent).toContain('seq:');
      expect(typesContent).toContain('timestamp:');
      expect(typesContent).toContain('topic:');
      expect(typesContent).toContain('event:');
      expect(typesContent).toContain('data:');
    });

    it('should define ConnectionData with sessionId and topics', async () => {
      typesContent = await readFile(
        join(process.cwd(), 'packages/daemon/src/websocket/types.ts'),
        'utf-8'
      );

      expect(typesContent).toContain('interface ConnectionData');
      expect(typesContent).toContain('sessionId:');
      expect(typesContent).toContain('topics:');
      expect(typesContent).toContain('seq:');
    });
  });

  describe('PubSub Manager', () => {
    let pubsubContent: string;

    it('should have pubsub manager file', async () => {
      pubsubContent = await readFile(
        join(process.cwd(), 'packages/daemon/src/websocket/pubsub.ts'),
        'utf-8'
      );

      expect(pubsubContent).toBeTruthy();
    });

    // AC: @trait-websocket-protocol ac-1
    it('should have addConnection method', async () => {
      pubsubContent = await readFile(
        join(process.cwd(), 'packages/daemon/src/websocket/pubsub.ts'),
        'utf-8'
      );

      expect(pubsubContent).toContain('addConnection');
    });

    it('should have removeConnection method', async () => {
      pubsubContent = await readFile(
        join(process.cwd(), 'packages/daemon/src/websocket/pubsub.ts'),
        'utf-8'
      );

      expect(pubsubContent).toContain('removeConnection');
    });

    // AC: @api-contract ac-28, @trait-websocket-protocol ac-2
    it('should have subscribe method for topic subscription', async () => {
      pubsubContent = await readFile(
        join(process.cwd(), 'packages/daemon/src/websocket/pubsub.ts'),
        'utf-8'
      );

      expect(pubsubContent).toContain('subscribe');
      expect(pubsubContent).toContain('topics');
    });

    it('should have unsubscribe method', async () => {
      pubsubContent = await readFile(
        join(process.cwd(), 'packages/daemon/src/websocket/pubsub.ts'),
        'utf-8'
      );

      expect(pubsubContent).toContain('unsubscribe');
    });

    // AC: @api-contract ac-29, @trait-websocket-protocol ac-3
    it('should have broadcast method that sends events to subscribed clients', async () => {
      pubsubContent = await readFile(
        join(process.cwd(), 'packages/daemon/src/websocket/pubsub.ts'),
        'utf-8'
      );

      expect(pubsubContent).toContain('broadcast');
      expect(pubsubContent).toContain('topic');
      expect(pubsubContent).toContain('event');
    });

    // AC: @api-contract ac-29, @trait-websocket-protocol ac-3
    it('should increment sequence number per connection in broadcast', async () => {
      pubsubContent = await readFile(
        join(process.cwd(), 'packages/daemon/src/websocket/pubsub.ts'),
        'utf-8'
      );

      expect(pubsubContent).toContain('ws.data.seq');
      expect(pubsubContent).toContain('seq:');
    });

    // AC: @api-contract ac-32, @trait-websocket-protocol ac-6
    it('should check backpressure before broadcasting', async () => {
      pubsubContent = await readFile(
        join(process.cwd(), 'packages/daemon/src/websocket/pubsub.ts'),
        'utf-8'
      );

      expect(pubsubContent).toContain('getBufferedAmount');
      expect(pubsubContent).toContain('backpressure');
    });

    // AC: @api-contract ac-29
    it('should generate msg_id using ulid', async () => {
      pubsubContent = await readFile(
        join(process.cwd(), 'packages/daemon/src/websocket/pubsub.ts'),
        'utf-8'
      );

      expect(pubsubContent).toContain('ulid()');
      expect(pubsubContent).toContain('msg_id:');
    });

    // AC: @api-contract ac-29
    it('should include timestamp in broadcast events', async () => {
      pubsubContent = await readFile(
        join(process.cwd(), 'packages/daemon/src/websocket/pubsub.ts'),
        'utf-8'
      );

      expect(pubsubContent).toContain('timestamp:');
      expect(pubsubContent).toContain('toISOString()');
    });

    it('should only broadcast to connections subscribed to topic', async () => {
      pubsubContent = await readFile(
        join(process.cwd(), 'packages/daemon/src/websocket/pubsub.ts'),
        'utf-8'
      );

      expect(pubsubContent).toContain('ws.data.topics.has(topic)');
    });
  });

  describe('Heartbeat Manager', () => {
    let heartbeatContent: string;

    it('should have heartbeat manager file', async () => {
      heartbeatContent = await readFile(
        join(process.cwd(), 'packages/daemon/src/websocket/heartbeat.ts'),
        'utf-8'
      );

      expect(heartbeatContent).toBeTruthy();
    });

    // AC: @daemon-server ac-13, @trait-websocket-protocol ac-4
    it('should define 30 second ping interval', async () => {
      heartbeatContent = await readFile(
        join(process.cwd(), 'packages/daemon/src/websocket/heartbeat.ts'),
        'utf-8'
      );

      expect(heartbeatContent).toContain('30_000'); // 30 seconds in ms
      expect(heartbeatContent).toContain('PING_INTERVAL');
    });

    // AC: @daemon-server ac-14, @trait-websocket-protocol ac-5
    it('should define 90 second pong timeout', async () => {
      heartbeatContent = await readFile(
        join(process.cwd(), 'packages/daemon/src/websocket/heartbeat.ts'),
        'utf-8'
      );

      expect(heartbeatContent).toContain('90_000'); // 90 seconds in ms
      expect(heartbeatContent).toContain('PONG_TIMEOUT');
    });

    // AC: @daemon-server ac-13, @trait-websocket-protocol ac-4
    it('should have start method that sends pings', async () => {
      heartbeatContent = await readFile(
        join(process.cwd(), 'packages/daemon/src/websocket/heartbeat.ts'),
        'utf-8'
      );

      expect(heartbeatContent).toContain('start(');
      expect(heartbeatContent).toContain('ws.ping()');
      expect(heartbeatContent).toContain('setInterval');
    });

    it('should have stop method', async () => {
      heartbeatContent = await readFile(
        join(process.cwd(), 'packages/daemon/src/websocket/heartbeat.ts'),
        'utf-8'
      );

      expect(heartbeatContent).toContain('stop()');
      expect(heartbeatContent).toContain('clearInterval');
    });

    it('should have recordPong method', async () => {
      heartbeatContent = await readFile(
        join(process.cwd(), 'packages/daemon/src/websocket/heartbeat.ts'),
        'utf-8'
      );

      expect(heartbeatContent).toContain('recordPong');
      expect(heartbeatContent).toContain('lastPong');
    });

    // AC: @daemon-server ac-14, @trait-websocket-protocol ac-5, ac-7
    it('should close connection with code 1001 on ping timeout', async () => {
      heartbeatContent = await readFile(
        join(process.cwd(), 'packages/daemon/src/websocket/heartbeat.ts'),
        'utf-8'
      );

      expect(heartbeatContent).toContain('ws.close(1001');
      expect(heartbeatContent).toContain('PONG_TIMEOUT');
    });

    it('should track lastPing and lastPong times', async () => {
      heartbeatContent = await readFile(
        join(process.cwd(), 'packages/daemon/src/websocket/heartbeat.ts'),
        'utf-8'
      );

      expect(heartbeatContent).toContain('lastPing');
      expect(heartbeatContent).toContain('lastPong');
      expect(heartbeatContent).toContain('Date.now()');
    });
  });

  describe('WebSocket Handler', () => {
    let handlerContent: string;

    it('should have handler file', async () => {
      handlerContent = await readFile(
        join(process.cwd(), 'packages/daemon/src/websocket/handler.ts'),
        'utf-8'
      );

      expect(handlerContent).toBeTruthy();
    });

    // AC: @api-contract ac-26
    it('should have handleMessage method that parses commands', async () => {
      handlerContent = await readFile(
        join(process.cwd(), 'packages/daemon/src/websocket/handler.ts'),
        'utf-8'
      );

      expect(handlerContent).toContain('handleMessage');
      expect(handlerContent).toContain('JSON.parse');
    });

    // AC: @api-contract ac-28
    it('should handle subscribe command', async () => {
      handlerContent = await readFile(
        join(process.cwd(), 'packages/daemon/src/websocket/handler.ts'),
        'utf-8'
      );

      expect(handlerContent).toContain("case 'subscribe':");
      expect(handlerContent).toContain('handleSubscribe');
    });

    it('should handle unsubscribe command', async () => {
      handlerContent = await readFile(
        join(process.cwd(), 'packages/daemon/src/websocket/handler.ts'),
        'utf-8'
      );

      expect(handlerContent).toContain("case 'unsubscribe':");
      expect(handlerContent).toContain('handleUnsubscribe');
    });

    it('should handle ping command', async () => {
      handlerContent = await readFile(
        join(process.cwd(), 'packages/daemon/src/websocket/handler.ts'),
        'utf-8'
      );

      expect(handlerContent).toContain("case 'ping':");
      expect(handlerContent).toContain('handlePing');
    });

    // AC: @api-contract ac-27
    it('should send ack response with request_id', async () => {
      handlerContent = await readFile(
        join(process.cwd(), 'packages/daemon/src/websocket/handler.ts'),
        'utf-8'
      );

      expect(handlerContent).toContain('sendAck');
      expect(handlerContent).toContain('request_id');
      expect(handlerContent).toContain('success');
    });

    // AC: @api-contract ac-30
    it('should validate command structure and return error for malformed commands', async () => {
      handlerContent = await readFile(
        join(process.cwd(), 'packages/daemon/src/websocket/handler.ts'),
        'utf-8'
      );

      expect(handlerContent).toContain('validation_error');
      expect(handlerContent).toContain('catch');
      expect(handlerContent).toContain('Invalid JSON');
    });

    // AC: @api-contract ac-30
    it('should validate action field is present', async () => {
      handlerContent = await readFile(
        join(process.cwd(), 'packages/daemon/src/websocket/handler.ts'),
        'utf-8'
      );

      expect(handlerContent).toContain('!command.action');
      expect(handlerContent).toContain('Missing action field');
    });

    // AC: @api-contract ac-28
    it('should validate topics array in subscribe command', async () => {
      handlerContent = await readFile(
        join(process.cwd(), 'packages/daemon/src/websocket/handler.ts'),
        'utf-8'
      );

      expect(handlerContent).toContain('topics');
      expect(handlerContent).toContain('Array.isArray');
    });

    it('should call pubsub.subscribe when handling subscribe command', async () => {
      handlerContent = await readFile(
        join(process.cwd(), 'packages/daemon/src/websocket/handler.ts'),
        'utf-8'
      );

      expect(handlerContent).toContain('this.pubsub.subscribe');
    });

    it('should call pubsub.unsubscribe when handling unsubscribe command', async () => {
      handlerContent = await readFile(
        join(process.cwd(), 'packages/daemon/src/websocket/handler.ts'),
        'utf-8'
      );

      expect(handlerContent).toContain('this.pubsub.unsubscribe');
    });
  });

  describe('Server Integration', () => {
    let serverContent: string;

    it('should import WebSocket modules', async () => {
      serverContent = await readFile(
        join(process.cwd(), 'packages/daemon/src/server.ts'),
        'utf-8'
      );

      expect(serverContent).toContain("from './websocket/pubsub'");
      expect(serverContent).toContain("from './websocket/heartbeat'");
      expect(serverContent).toContain("from './websocket/handler'");
      expect(serverContent).toContain("from './websocket/types'");
    });

    it('should initialize WebSocket managers', async () => {
      serverContent = await readFile(
        join(process.cwd(), 'packages/daemon/src/server.ts'),
        'utf-8'
      );

      expect(serverContent).toContain('new PubSubManager()');
      expect(serverContent).toContain('new HeartbeatManager()');
      expect(serverContent).toContain('new WebSocketHandler');
    });

    // AC: @api-contract ac-25, @trait-websocket-protocol ac-1
    it('should generate session ID and send connected event on WebSocket open', async () => {
      serverContent = await readFile(
        join(process.cwd(), 'packages/daemon/src/server.ts'),
        'utf-8'
      );

      expect(serverContent).toContain('ulid()');
      expect(serverContent).toContain('sessionId');
      expect(serverContent).toContain("event: 'connected'");
      expect(serverContent).toContain('session_id:');
    });

    it('should initialize ConnectionData with sessionId, topics, seq', async () => {
      serverContent = await readFile(
        join(process.cwd(), 'packages/daemon/src/server.ts'),
        'utf-8'
      );

      expect(serverContent).toContain('ws.data = {');
      expect(serverContent).toContain('sessionId');
      expect(serverContent).toContain('topics: new Set');
      expect(serverContent).toContain('seq: 0');
    });

    // AC: @api-contract ac-26, ac-27
    it('should delegate message handling to WebSocketHandler', async () => {
      serverContent = await readFile(
        join(process.cwd(), 'packages/daemon/src/server.ts'),
        'utf-8'
      );

      expect(serverContent).toContain('message(ws, message)');
      expect(serverContent).toContain('wsHandler.handleMessage');
    });

    // AC: @trait-websocket-protocol ac-5
    it('should handle pong events from WebSocket clients', async () => {
      serverContent = await readFile(
        join(process.cwd(), 'packages/daemon/src/server.ts'),
        'utf-8'
      );

      expect(serverContent).toContain('pong(ws)');
      expect(serverContent).toContain('heartbeatManager.recordPong');
    });

    it('should register connection with pubsub on open', async () => {
      serverContent = await readFile(
        join(process.cwd(), 'packages/daemon/src/server.ts'),
        'utf-8'
      );

      expect(serverContent).toContain('pubsubManager.addConnection');
    });

    it('should remove connection from pubsub on close', async () => {
      serverContent = await readFile(
        join(process.cwd(), 'packages/daemon/src/server.ts'),
        'utf-8'
      );

      expect(serverContent).toContain('pubsubManager.removeConnection');
    });

    // AC: @daemon-server ac-13, ac-14
    it('should start heartbeat manager after server starts', async () => {
      serverContent = await readFile(
        join(process.cwd(), 'packages/daemon/src/server.ts'),
        'utf-8'
      );

      expect(serverContent).toContain('heartbeatManager.start');
    });

    it('should stop heartbeat manager during shutdown', async () => {
      serverContent = await readFile(
        join(process.cwd(), 'packages/daemon/src/server.ts'),
        'utf-8'
      );

      expect(serverContent).toContain('heartbeatManager.stop');
    });

    // AC: @trait-websocket-protocol ac-7
    it('should close WebSocket connections with code 1000 during shutdown', async () => {
      serverContent = await readFile(
        join(process.cwd(), 'packages/daemon/src/server.ts'),
        'utf-8'
      );

      expect(serverContent).toContain('ws.close(1000');
      expect(serverContent).toContain('Server shutting down');
    });

    // AC: @api-contract ac-4, ac-29
    it('should broadcast file changes via pubsub to files:updates topic', async () => {
      serverContent = await readFile(
        join(process.cwd(), 'packages/daemon/src/server.ts'),
        'utf-8'
      );

      expect(serverContent).toContain("pubsubManager.broadcast('files:updates'");
      expect(serverContent).toContain('file_changed');
    });

    // AC: @daemon-server ac-6
    it('should broadcast file errors via pubsub to files:errors topic', async () => {
      serverContent = await readFile(
        join(process.cwd(), 'packages/daemon/src/server.ts'),
        'utf-8'
      );

      expect(serverContent).toContain("pubsubManager.broadcast('files:errors'");
      expect(serverContent).toContain('file_error');
    });

    it('should use pubsub connection count in health endpoint', async () => {
      serverContent = await readFile(
        join(process.cwd(), 'packages/daemon/src/server.ts'),
        'utf-8'
      );

      expect(serverContent).toContain('pubsubManager.getConnectionCount()');
    });

    it('should use ConnectionData type for WebSocket data', async () => {
      serverContent = await readFile(
        join(process.cwd(), 'packages/daemon/src/server.ts'),
        'utf-8'
      );

      expect(serverContent).toContain('.ws<ConnectionData>');
    });
  });
});
