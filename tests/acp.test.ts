import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import {
  isRequest,
  isResponse,
  isError,
  isNotification,
  JsonRpcFraming,
  ACPClient,
} from '../src/acp/index.js';

// ============================================================================
// Type Guards Tests
// ============================================================================

describe('JSON-RPC Type Guards', () => {
  describe('isRequest', () => {
    it('should identify valid requests', () => {
      const request = {
        jsonrpc: '2.0',
        id: 1,
        method: 'test',
        params: { foo: 'bar' },
      };
      expect(isRequest(request)).toBe(true);
    });

    it('should identify requests with string id', () => {
      const request = {
        jsonrpc: '2.0',
        id: 'abc-123',
        method: 'test',
      };
      expect(isRequest(request)).toBe(true);
    });

    it('should reject requests without method', () => {
      const request = {
        jsonrpc: '2.0',
        id: 1,
      };
      expect(isRequest(request)).toBe(false);
    });

    it('should reject requests without id', () => {
      const notification = {
        jsonrpc: '2.0',
        method: 'test',
      };
      expect(isRequest(notification)).toBe(false);
    });

    it('should reject wrong jsonrpc version', () => {
      const request = {
        jsonrpc: '1.0',
        id: 1,
        method: 'test',
      };
      expect(isRequest(request)).toBe(false);
    });
  });

  describe('isResponse', () => {
    it('should identify valid responses', () => {
      const response = {
        jsonrpc: '2.0',
        id: 1,
        result: { data: 'test' },
      };
      expect(isResponse(response)).toBe(true);
    });

    it('should identify responses with null result', () => {
      const response = {
        jsonrpc: '2.0',
        id: 1,
        result: null,
      };
      expect(isResponse(response)).toBe(true);
    });

    it('should reject responses with error field', () => {
      const error = {
        jsonrpc: '2.0',
        id: 1,
        result: {},
        error: { code: -1, message: 'fail' },
      };
      expect(isResponse(error)).toBe(false);
    });
  });

  describe('isError', () => {
    it('should identify valid errors', () => {
      const error = {
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32600, message: 'Invalid Request' },
      };
      expect(isError(error)).toBe(true);
    });

    it('should identify errors with null id', () => {
      const error = {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      };
      expect(isError(error)).toBe(true);
    });

    it('should identify errors with data', () => {
      const error = {
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32600, message: 'Invalid Request', data: { details: 'missing field' } },
      };
      expect(isError(error)).toBe(true);
    });

    it('should reject errors without error object', () => {
      const response = {
        jsonrpc: '2.0',
        id: 1,
        result: null,
      };
      expect(isError(response)).toBe(false);
    });
  });

  describe('isNotification', () => {
    it('should identify valid notifications', () => {
      const notification = {
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: 'abc' },
      };
      expect(isNotification(notification)).toBe(true);
    });

    it('should identify notifications without params', () => {
      const notification = {
        jsonrpc: '2.0',
        method: 'ping',
      };
      expect(isNotification(notification)).toBe(true);
    });

    it('should reject notifications with id (those are requests)', () => {
      const request = {
        jsonrpc: '2.0',
        id: 1,
        method: 'test',
      };
      expect(isNotification(request)).toBe(false);
    });
  });
});

// ============================================================================
// JsonRpcFraming Tests
// ============================================================================

describe('JsonRpcFraming', () => {
  let stdin: PassThrough;
  let stdout: PassThrough;
  let framing: JsonRpcFraming;

  beforeEach(() => {
    stdin = new PassThrough();
    stdout = new PassThrough();
    framing = new JsonRpcFraming({
      stdin,
      stdout,
      timeout: 1000, // Short timeout for tests
    });
  });

  afterEach(() => {
    framing.close();
  });

  it('should send requests and receive responses', async () => {
    // Set up to capture outgoing message
    const outgoingMessages: string[] = [];
    stdout.on('data', (chunk: Buffer) => {
      outgoingMessages.push(chunk.toString());
    });

    // Start the request
    const resultPromise = framing.sendRequest('test/method', { foo: 'bar' });

    // Wait for the request to be sent
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Verify request was sent
    expect(outgoingMessages.length).toBe(1);
    const sentRequest = JSON.parse(outgoingMessages[0]);
    expect(sentRequest.jsonrpc).toBe('2.0');
    expect(sentRequest.method).toBe('test/method');
    expect(sentRequest.params).toEqual({ foo: 'bar' });
    expect(sentRequest.id).toBe(1);

    // Send response
    const response = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { success: true },
    });
    stdin.write(response + '\n');

    // Verify result
    const result = await resultPromise;
    expect(result).toEqual({ success: true });
  });

  it('should handle error responses', async () => {
    // Suppress console.error for this test
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const resultPromise = framing.sendRequest('test/method');

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Send error response
    const errorResponse = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32600, message: 'Invalid Request' },
    });
    stdin.write(errorResponse + '\n');

    // Verify error is thrown
    await expect(resultPromise).rejects.toThrow('Invalid Request');

    consoleSpy.mockRestore();
  });

  it('should timeout pending requests', async () => {
    const shortTimeoutFraming = new JsonRpcFraming({
      stdin,
      stdout,
      timeout: 50, // Very short timeout
    });

    const resultPromise = shortTimeoutFraming.sendRequest('test/method');

    await expect(resultPromise).rejects.toThrow(/timed out/);

    shortTimeoutFraming.close();
  });

  it('should emit request events for incoming requests', async () => {
    const requestPromise = new Promise<unknown>((resolve) => {
      framing.on('request', resolve);
    });

    // Send incoming request
    const request = JSON.stringify({
      jsonrpc: '2.0',
      id: 'agent-1',
      method: 'fs/read_text_file',
      params: { path: '/test.txt' },
    });
    stdin.write(request + '\n');

    const receivedRequest = await requestPromise;
    expect(receivedRequest).toEqual({
      jsonrpc: '2.0',
      id: 'agent-1',
      method: 'fs/read_text_file',
      params: { path: '/test.txt' },
    });
  });

  it('should emit notification events', async () => {
    const notificationPromise = new Promise<unknown>((resolve) => {
      framing.on('notification', resolve);
    });

    // Send notification
    const notification = JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 'test-session', update: { type: 'progress' } },
    });
    stdin.write(notification + '\n');

    const receivedNotification = await notificationPromise;
    expect(receivedNotification).toEqual({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 'test-session', update: { type: 'progress' } },
    });
  });

  // AC: @acp-client ac-9
  it('should send parse error for malformed JSON', async () => {
    const outgoingMessages: string[] = [];
    stdout.on('data', (chunk: Buffer) => {
      outgoingMessages.push(chunk.toString());
    });

    // Send malformed JSON
    stdin.write('not valid json\n');

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Verify parse error was sent
    expect(outgoingMessages.length).toBe(1);
    const errorResponse = JSON.parse(outgoingMessages[0]);
    expect(errorResponse.jsonrpc).toBe('2.0');
    expect(errorResponse.id).toBe(null);
    expect(errorResponse.error.code).toBe(-32700);
    expect(errorResponse.error.message).toBe('Parse error');
  });

  // AC: @acp-client ac-8
  it('should throw when closed', async () => {
    framing.close();

    await expect(() => framing.sendRequest('test')).rejects.toThrow('closed');
    expect(() => framing.sendNotification('test')).toThrow('closed');
    expect(() => framing.sendResponse(1, {})).toThrow('closed');
  });

  // AC: @acp-client ac-6
  it('should reset pending timers on incoming activity', async () => {
    // Create framing with short timeout
    const shortFraming = new JsonRpcFraming({
      stdin,
      stdout,
      timeout: 100,
    });

    // Start a request
    const resultPromise = shortFraming.sendRequest('test/method');

    // Wait 60ms, then send a notification (activity)
    await new Promise((resolve) => setTimeout(resolve, 60));
    stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'ping' }) + '\n');

    // Wait another 60ms (total 120ms, would have timed out without reset)
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Send the actual response
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'ok' }) + '\n');

    // Should succeed because timer was reset
    const result = await resultPromise;
    expect(result).toBe('ok');

    shortFraming.close();
  });
});

// ============================================================================
// ACPClient Tests
// ============================================================================

describe('ACPClient', () => {
  let stdin: PassThrough;
  let stdout: PassThrough;
  let client: ACPClient;

  beforeEach(() => {
    stdin = new PassThrough();
    stdout = new PassThrough();
    client = new ACPClient({
      stdin,
      stdout,
      timeout: 1000,
      clientInfo: {
        name: 'test-client',
        version: '1.0.0',
      },
    });
  });

  afterEach(() => {
    client.close();
  });

  /**
   * Helper to respond to the next outgoing request
   */
  function respondToNext(result: unknown) {
    return new Promise<void>((resolve) => {
      stdout.once('data', (chunk: Buffer) => {
        const request = JSON.parse(chunk.toString());
        stdin.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result,
          }) + '\n',
        );
        resolve();
      });
    });
  }

  // AC: @acp-client ac-1
  describe('initialize', () => {
    it('should initialize and return agent capabilities', async () => {
      const initPromise = client.initialize();

      // Respond with capabilities
      await respondToNext({
        protocolVersion: 1,
        agentCapabilities: {
          streaming: true,
        },
      });

      const capabilities = await initPromise;
      expect(capabilities).toEqual({ streaming: true });
      expect(client.isInitialized()).toBe(true);
    });

    it('should throw if already initialized', async () => {
      const initPromise = client.initialize();
      await respondToNext({ protocolVersion: 1, agentCapabilities: {} });
      await initPromise;

      await expect(client.initialize()).rejects.toThrow('already initialized');
    });
  });

  // AC: @acp-client ac-2
  describe('newSession', () => {
    it('should create session and return sessionId', async () => {
      // Initialize first
      const initPromise = client.initialize();
      await respondToNext({ protocolVersion: 1, agentCapabilities: {} });
      await initPromise;

      // Create session
      const sessionPromise = client.newSession({
        cwd: '/test',
        _meta: { test: true },
      });

      await respondToNext({ sessionId: 'session-123' });

      const sessionId = await sessionPromise;
      expect(sessionId).toBe('session-123');

      // Verify session is tracked
      const session = client.getSession('session-123');
      expect(session).toEqual({ id: 'session-123', status: 'idle' });
    });

    it('should throw if not initialized', async () => {
      await expect(client.newSession({ cwd: '/' })).rejects.toThrow(
        'not initialized',
      );
    });
  });

  // AC: @acp-client ac-3
  describe('prompt', () => {
    beforeEach(async () => {
      // Initialize and create session for prompt tests
      const initPromise = client.initialize();
      await respondToNext({ protocolVersion: 1, agentCapabilities: {} });
      await initPromise;

      const sessionPromise = client.newSession({ cwd: '/' });
      await respondToNext({ sessionId: 'session-123' });
      await sessionPromise;
    });

    it('should send prompt and return response with stopReason', async () => {
      const promptPromise = client.prompt({
        sessionId: 'session-123',
        prompt: [{ type: 'text', text: 'Hello' }],
      });

      await respondToNext({
        stopReason: 'end_turn',
      });

      const response = await promptPromise;
      expect(response.stopReason).toBe('end_turn');
    });

    it('should update session status during prompt', async () => {
      // Capture the request without immediately responding
      let requestId: number | string | undefined;
      const requestReceived = new Promise<void>((resolve) => {
        stdout.once('data', (chunk: Buffer) => {
          const request = JSON.parse(chunk.toString());
          requestId = request.id;
          resolve();
        });
      });

      const promptPromise = client.prompt({
        sessionId: 'session-123',
        prompt: [{ type: 'text', text: 'Hello' }],
      });

      // Wait for request to be sent
      await requestReceived;

      // NOW check status - should be prompting since we haven't responded yet
      expect(client.getSession('session-123')?.status).toBe('prompting');

      // Send response
      stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: requestId,
          result: { stopReason: 'end_turn' },
        }) + '\n',
      );

      await promptPromise;

      // Check status is idle after
      expect(client.getSession('session-123')?.status).toBe('idle');
    });

    it('should throw if session not found', async () => {
      await expect(
        client.prompt({
          sessionId: 'nonexistent',
          prompt: [{ type: 'text', text: 'Hello' }],
        }),
      ).rejects.toThrow('Session not found');
    });

    it('should throw if already prompting', async () => {
      // Capture the first request without immediately responding
      let requestId: number | string | undefined;
      const requestReceived = new Promise<void>((resolve) => {
        stdout.once('data', (chunk: Buffer) => {
          const request = JSON.parse(chunk.toString());
          requestId = request.id;
          resolve();
        });
      });

      // Start first prompt (don't await)
      const firstPrompt = client.prompt({
        sessionId: 'session-123',
        prompt: [{ type: 'text', text: 'Hello' }],
      });

      // Wait for first prompt request to be sent
      await requestReceived;

      // Try second prompt - should fail because first is still prompting
      await expect(
        client.prompt({
          sessionId: 'session-123',
          prompt: [{ type: 'text', text: 'Hello again' }],
        }),
      ).rejects.toThrow('already prompting');

      // Clean up first prompt by sending response
      stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: requestId,
          result: { stopReason: 'end_turn' },
        }) + '\n',
      );
      await firstPrompt;
    });
  });

  // AC: @acp-client ac-4
  describe('update events', () => {
    beforeEach(async () => {
      const initPromise = client.initialize();
      await respondToNext({ protocolVersion: 1, agentCapabilities: {} });
      await initPromise;

      const sessionPromise = client.newSession({ cwd: '/' });
      await respondToNext({ sessionId: 'session-123' });
      await sessionPromise;
    });

    it('should emit update events for session updates', async () => {
      const updatePromise = new Promise<{ sessionId: string; update: unknown }>(
        (resolve) => {
          client.on('update', (sessionId, update) => {
            resolve({ sessionId, update });
          });
        },
      );

      // Send session update notification
      stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'session-123',
            update: {
              sessionUpdate: 'assistant_message_chunk',
              content: { type: 'text', text: 'Hello!' },
            },
          },
        }) + '\n',
      );

      const { sessionId, update } = await updatePromise;
      expect(sessionId).toBe('session-123');
      expect(update).toEqual({
        sessionUpdate: 'assistant_message_chunk',
        content: { type: 'text', text: 'Hello!' },
      });
    });
  });

  // AC: @acp-client ac-7
  describe('cancel', () => {
    beforeEach(async () => {
      const initPromise = client.initialize();
      await respondToNext({ protocolVersion: 1, agentCapabilities: {} });
      await initPromise;

      const sessionPromise = client.newSession({ cwd: '/' });
      await respondToNext({ sessionId: 'session-123' });
      await sessionPromise;
    });

    it('should send cancel request', async () => {
      const cancelPromise = client.cancel('session-123');
      await respondToNext({});
      await cancelPromise;

      expect(client.getSession('session-123')?.status).toBe('cancelled');
    });

    it('should silently handle Method not found errors', async () => {
      // Suppress console.error for this test
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const cancelPromise = client.cancel('session-123');

      // Respond with Method not found
      stdout.once('data', (chunk: Buffer) => {
        const request = JSON.parse(chunk.toString());
        stdin.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            error: { code: -32601, message: 'Method not found' },
          }) + '\n',
        );
      });

      // Should not throw
      await cancelPromise;

      consoleSpy.mockRestore();
    });

    it('should throw for other errors', async () => {
      // Suppress console.error for this test
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const cancelPromise = client.cancel('session-123');

      // Respond with different error
      stdout.once('data', (chunk: Buffer) => {
        const request = JSON.parse(chunk.toString());
        stdin.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            error: { code: -32603, message: 'Internal error' },
          }) + '\n',
        );
      });

      await expect(cancelPromise).rejects.toThrow('Internal error');

      consoleSpy.mockRestore();
    });
  });

  // AC: @acp-client ac-8
  describe('close', () => {
    it('should close and emit close event', async () => {
      const closePromise = new Promise<void>((resolve) => {
        client.on('close', resolve);
      });

      client.close();

      await closePromise;
      expect(client.isClosed()).toBe(true);
    });

    it('should throw on operations after close', async () => {
      const initPromise = client.initialize();
      await respondToNext({ protocolVersion: 1, agentCapabilities: {} });
      await initPromise;

      client.close();

      await expect(client.newSession({ cwd: '/' })).rejects.toThrow('closed');
    });
  });
});

// ============================================================================
// ACP Mock Tests (for mock agent implementation)
// ============================================================================

describe('ACP Mock Agent', () => {
  let mockProcess: ReturnType<typeof spawn>;
  let client: ACPClient;

  beforeEach(() => {
    // Spawn the mock agent as a subprocess
    const { spawn } = require('node:child_process');
    const mockPath = path.join(__dirname, 'mocks', 'acp-mock.js');
    mockProcess = spawn('node', [mockPath]);

    // Create ACP client connected to the mock
    client = new ACPClient({
      stdin: mockProcess.stdout, // Our stdin reads from mock's stdout
      stdout: mockProcess.stdin, // Our stdout writes to mock's stdin
      timeout: 5000,
      clientInfo: {
        name: 'test-client',
        version: '1.0.0',
      },
    });
  });

  afterEach(() => {
    client.close();
    mockProcess.kill();
  });

  describe('session/request_permission', () => {
    beforeEach(async () => {
      // Initialize the mock agent before each test
      await client.initialize();
    });

    it('should auto-approve with allow_always option', async () => {
      // Send permission request with allow_always option
      // Note: We need to use the framing layer directly since ACPClient doesn't expose requestPermission
      const result = await (client as any).framing.sendRequest('session/request_permission', {
        options: [
          { optionId: 'deny-1', kind: 'deny' },
          { optionId: 'allow-always-1', kind: 'allow_always' },
          { optionId: 'allow-once-1', kind: 'allow_once' },
        ],
      });

      // Should select the allow_always option
      expect(result).toEqual({
        outcome: { outcome: 'selected', optionId: 'allow-always-1' },
      });
    });

    it('should auto-approve with allow_once when allow_always not available', async () => {
      const result = await (client as any).framing.sendRequest('session/request_permission', {
        options: [
          { optionId: 'deny-1', kind: 'deny' },
          { optionId: 'allow-once-1', kind: 'allow_once' },
        ],
      });

      // Should select the allow_once option
      expect(result).toEqual({
        outcome: { outcome: 'selected', optionId: 'allow-once-1' },
      });
    });

    it('should cancel permission requests with no allow options', async () => {
      const result = await (client as any).framing.sendRequest('session/request_permission', {
        options: [
          { optionId: 'deny-1', kind: 'deny' },
          { optionId: 'deny-2', kind: 'deny' },
        ],
      });

      // Should cancel since no allow option available
      expect(result).toEqual({
        outcome: { outcome: 'cancelled' },
      });
    });

    it('should handle empty options array', async () => {
      const result = await (client as any).framing.sendRequest('session/request_permission', {
        options: [],
      });

      // Should cancel since no options available
      expect(result).toEqual({
        outcome: { outcome: 'cancelled' },
      });
    });

    it('should prefer allow_always over allow_once', async () => {
      const result = await (client as any).framing.sendRequest('session/request_permission', {
        options: [
          { optionId: 'allow-once-1', kind: 'allow_once' },
          { optionId: 'allow-always-1', kind: 'allow_always' },
        ],
      });

      // Should prefer allow_always
      expect(result).toEqual({
        outcome: { outcome: 'selected', optionId: 'allow-always-1' },
      });
    });
  });

  describe('session/request_permission - error handling', () => {
    it('should error on permission requests before initialization', async () => {
      // Don't initialize - create a fresh client and send request directly
      const { spawn } = require('node:child_process');
      const mockPath = path.join(__dirname, 'mocks', 'acp-mock.js');
      const freshMock = spawn('node', [mockPath]);

      const freshClient = new ACPClient({
        stdin: freshMock.stdout,
        stdout: freshMock.stdin,
        timeout: 5000,
        clientInfo: { name: 'test', version: '1.0.0' },
      });

      try {
        // Suppress console.error for this test
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        await expect(
          (freshClient as any).framing.sendRequest('session/request_permission', {
            options: [{ optionId: 'allow-1', kind: 'allow_once' }],
          }),
        ).rejects.toThrow('Not initialized');

        consoleSpy.mockRestore();
      } finally {
        freshClient.close();
        freshMock.kill();
      }
    });
  });
});
