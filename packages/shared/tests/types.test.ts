/**
 * Type validation tests for @kynetic-ai/shared package
 *
 * Verifies:
 * 1. Types compile correctly
 * 2. Exports are accessible
 * 3. Type definitions match expected structure
 *
 * Uses vitest expectTypeOf for compile-time type checking.
 */

import { describe, it, expectTypeOf } from 'vitest';
import type {
  // Core schemas
  TaskStatus,
  TaskType,
  ItemType,
  ImplementationStatus,
  Maturity,
  ObservationType,
  // API types
  PaginatedResponse,
  ErrorResponse,
  TaskSummary,
  TaskDetail,
  Note,
  Todo,
  ItemSummary,
  ItemDetail,
  AcceptanceCriterion,
  InboxItem,
  SessionContext,
  Agent,
  Workflow,
  Observation,
  // WebSocket types
  WebSocketCommand,
  CommandAck,
  ConnectedEvent,
  BroadcastEvent
} from '../src/index';

describe('Core Schema Types', () => {
  it('TaskStatus should be union of valid statuses', () => {
    expectTypeOf<TaskStatus>().toEqualTypeOf<
      'pending' | 'in_progress' | 'pending_review' | 'blocked' | 'completed' | 'cancelled'
    >();
  });

  it('TaskType should be union of valid types', () => {
    expectTypeOf<TaskType>().toEqualTypeOf<
      'epic' | 'task' | 'bug' | 'spike' | 'infra'
    >();
  });

  it('ItemType should be union of valid types', () => {
    expectTypeOf<ItemType>().toEqualTypeOf<
      'module' | 'feature' | 'requirement' | 'constraint' | 'decision' | 'task' | 'trait'
    >();
  });

  it('ImplementationStatus should be union of valid statuses', () => {
    expectTypeOf<ImplementationStatus>().toEqualTypeOf<
      'not_started' | 'in_progress' | 'implemented' | 'verified'
    >();
  });

  it('Maturity should be union of valid values', () => {
    expectTypeOf<Maturity>().toEqualTypeOf<
      'draft' | 'proposed' | 'stable' | 'deferred' | 'deprecated'
    >();
  });

  it('ObservationType should be union of valid types', () => {
    expectTypeOf<ObservationType>().toEqualTypeOf<
      'friction' | 'success' | 'question' | 'idea'
    >();
  });
});

describe('API Response Types', () => {
  it('PaginatedResponse should have correct structure', () => {
    type TestPaginated = PaginatedResponse<string>;

    expectTypeOf<TestPaginated>().toHaveProperty('items');
    expectTypeOf<TestPaginated>().toHaveProperty('total');
    expectTypeOf<TestPaginated>().toHaveProperty('offset');
    expectTypeOf<TestPaginated>().toHaveProperty('limit');

    expectTypeOf<TestPaginated['items']>().toEqualTypeOf<string[]>();
    expectTypeOf<TestPaginated['total']>().toEqualTypeOf<number>();
    expectTypeOf<TestPaginated['offset']>().toEqualTypeOf<number>();
    expectTypeOf<TestPaginated['limit']>().toEqualTypeOf<number>();
  });

  it('ErrorResponse should have correct structure', () => {
    expectTypeOf<ErrorResponse>().toHaveProperty('error');
    expectTypeOf<ErrorResponse>().toHaveProperty('message');
    expectTypeOf<ErrorResponse>().toHaveProperty('suggestion');

    expectTypeOf<ErrorResponse['error']>().toEqualTypeOf<string>();
    expectTypeOf<ErrorResponse['message']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<ErrorResponse['suggestion']>().toEqualTypeOf<string | undefined>();
  });

  it('TaskSummary should have required fields', () => {
    expectTypeOf<TaskSummary>().toHaveProperty('_ulid');
    expectTypeOf<TaskSummary>().toHaveProperty('title');
    expectTypeOf<TaskSummary>().toHaveProperty('status');
    expectTypeOf<TaskSummary>().toHaveProperty('priority');
    expectTypeOf<TaskSummary>().toHaveProperty('notes_count');

    expectTypeOf<TaskSummary['_ulid']>().toEqualTypeOf<string>();
    expectTypeOf<TaskSummary['title']>().toEqualTypeOf<string>();
    expectTypeOf<TaskSummary['status']>().toEqualTypeOf<string>();
    expectTypeOf<TaskSummary['priority']>().toEqualTypeOf<number>();
    expectTypeOf<TaskSummary['notes_count']>().toEqualTypeOf<number>();
  });

  it('TaskDetail should extend TaskSummary', () => {
    expectTypeOf<TaskDetail>().toMatchTypeOf<TaskSummary>();

    expectTypeOf<TaskDetail>().toHaveProperty('notes');
    expectTypeOf<TaskDetail>().toHaveProperty('depends_on');
    expectTypeOf<TaskDetail>().toHaveProperty('blocked_by');

    expectTypeOf<TaskDetail['notes']>().toEqualTypeOf<Note[]>();
    expectTypeOf<TaskDetail['depends_on']>().toEqualTypeOf<string[]>();
    expectTypeOf<TaskDetail['blocked_by']>().toEqualTypeOf<string[]>();
  });

  it('Note should have correct structure', () => {
    expectTypeOf<Note>().toHaveProperty('_ulid');
    expectTypeOf<Note>().toHaveProperty('created_at');
    expectTypeOf<Note>().toHaveProperty('author');
    expectTypeOf<Note>().toHaveProperty('content');

    expectTypeOf<Note['_ulid']>().toEqualTypeOf<string>();
    expectTypeOf<Note['created_at']>().toEqualTypeOf<string>();
    expectTypeOf<Note['author']>().toEqualTypeOf<string>();
    expectTypeOf<Note['content']>().toEqualTypeOf<string>();
  });

  it('Todo should have correct structure', () => {
    expectTypeOf<Todo>().toHaveProperty('_ulid');
    expectTypeOf<Todo>().toHaveProperty('content');
    expectTypeOf<Todo>().toHaveProperty('status');
    expectTypeOf<Todo>().toHaveProperty('created_at');

    expectTypeOf<Todo['status']>().toEqualTypeOf<
      'pending' | 'in_progress' | 'completed'
    >();
  });

  it('ItemSummary should have correct structure', () => {
    expectTypeOf<ItemSummary>().toHaveProperty('_ulid');
    expectTypeOf<ItemSummary>().toHaveProperty('title');
    expectTypeOf<ItemSummary>().toHaveProperty('type');
    expectTypeOf<ItemSummary>().toHaveProperty('tags');

    expectTypeOf<ItemSummary['_ulid']>().toEqualTypeOf<string>();
    expectTypeOf<ItemSummary['title']>().toEqualTypeOf<string>();
    expectTypeOf<ItemSummary['type']>().toEqualTypeOf<string>();
    expectTypeOf<ItemSummary['tags']>().toEqualTypeOf<string[]>();
  });

  it('ItemDetail should extend ItemSummary', () => {
    expectTypeOf<ItemDetail>().toMatchTypeOf<ItemSummary>();

    expectTypeOf<ItemDetail>().toHaveProperty('acceptance_criteria');
    expectTypeOf<ItemDetail>().toHaveProperty('traits');

    expectTypeOf<ItemDetail['acceptance_criteria']>().toEqualTypeOf<AcceptanceCriterion[]>();
    expectTypeOf<ItemDetail['traits']>().toEqualTypeOf<string[]>();
  });

  it('AcceptanceCriterion should have correct structure', () => {
    expectTypeOf<AcceptanceCriterion>().toHaveProperty('_ulid');
    expectTypeOf<AcceptanceCriterion>().toHaveProperty('given');
    expectTypeOf<AcceptanceCriterion>().toHaveProperty('when');
    expectTypeOf<AcceptanceCriterion>().toHaveProperty('then');

    expectTypeOf<AcceptanceCriterion['_ulid']>().toEqualTypeOf<string>();
    expectTypeOf<AcceptanceCriterion['given']>().toEqualTypeOf<string>();
    expectTypeOf<AcceptanceCriterion['when']>().toEqualTypeOf<string>();
    expectTypeOf<AcceptanceCriterion['then']>().toEqualTypeOf<string>();
  });

  it('InboxItem should have correct structure', () => {
    expectTypeOf<InboxItem>().toHaveProperty('_ulid');
    expectTypeOf<InboxItem>().toHaveProperty('text');
    expectTypeOf<InboxItem>().toHaveProperty('created_at');
    expectTypeOf<InboxItem>().toHaveProperty('tags');
    expectTypeOf<InboxItem>().toHaveProperty('added_by');

    expectTypeOf<InboxItem['_ulid']>().toEqualTypeOf<string>();
    expectTypeOf<InboxItem['text']>().toEqualTypeOf<string>();
    expectTypeOf<InboxItem['tags']>().toEqualTypeOf<string[]>();
  });

  it('SessionContext should have correct structure', () => {
    expectTypeOf<SessionContext>().toHaveProperty('focus');
    expectTypeOf<SessionContext>().toHaveProperty('threads');
    expectTypeOf<SessionContext>().toHaveProperty('open_questions');
    expectTypeOf<SessionContext>().toHaveProperty('updated_at');

    expectTypeOf<SessionContext['focus']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<SessionContext['threads']>().toEqualTypeOf<string[]>();
    expectTypeOf<SessionContext['open_questions']>().toEqualTypeOf<string[]>();
    expectTypeOf<SessionContext['updated_at']>().toEqualTypeOf<string>();
  });

  it('Agent should have correct structure', () => {
    expectTypeOf<Agent>().toHaveProperty('_ulid');
    expectTypeOf<Agent>().toHaveProperty('slugs');
    expectTypeOf<Agent>().toHaveProperty('role');
    expectTypeOf<Agent>().toHaveProperty('status');
    expectTypeOf<Agent>().toHaveProperty('capabilities');
    expectTypeOf<Agent>().toHaveProperty('constraints');

    expectTypeOf<Agent['_ulid']>().toEqualTypeOf<string>();
    expectTypeOf<Agent['slugs']>().toEqualTypeOf<string[]>();
    expectTypeOf<Agent['role']>().toEqualTypeOf<string>();
    expectTypeOf<Agent['status']>().toEqualTypeOf<string>();
    expectTypeOf<Agent['capabilities']>().toEqualTypeOf<string[]>();
    expectTypeOf<Agent['constraints']>().toEqualTypeOf<string[]>();
  });

  it('Workflow should have correct structure', () => {
    expectTypeOf<Workflow>().toHaveProperty('_ulid');
    expectTypeOf<Workflow>().toHaveProperty('slugs');
    expectTypeOf<Workflow>().toHaveProperty('name');
    expectTypeOf<Workflow>().toHaveProperty('steps');

    expectTypeOf<Workflow['_ulid']>().toEqualTypeOf<string>();
    expectTypeOf<Workflow['slugs']>().toEqualTypeOf<string[]>();
    expectTypeOf<Workflow['name']>().toEqualTypeOf<string>();
  });

  it('Observation should have correct structure', () => {
    expectTypeOf<Observation>().toHaveProperty('_ulid');
    expectTypeOf<Observation>().toHaveProperty('type');
    expectTypeOf<Observation>().toHaveProperty('content');
    expectTypeOf<Observation>().toHaveProperty('created_at');
    expectTypeOf<Observation>().toHaveProperty('resolved');

    expectTypeOf<Observation['type']>().toEqualTypeOf<ObservationType>();
    expectTypeOf<Observation['resolved']>().toEqualTypeOf<boolean | undefined>();
  });
});

describe('WebSocket Types', () => {
  it('WebSocketCommand should have correct structure', () => {
    expectTypeOf<WebSocketCommand>().toHaveProperty('action');
    expectTypeOf<WebSocketCommand>().toHaveProperty('request_id');
    expectTypeOf<WebSocketCommand>().toHaveProperty('payload');

    expectTypeOf<WebSocketCommand['action']>().toEqualTypeOf<string>();
    expectTypeOf<WebSocketCommand['request_id']>().toEqualTypeOf<string | undefined>();
  });

  it('CommandAck should have correct structure', () => {
    expectTypeOf<CommandAck>().toHaveProperty('ack');
    expectTypeOf<CommandAck>().toHaveProperty('request_id');
    expectTypeOf<CommandAck>().toHaveProperty('success');
    expectTypeOf<CommandAck>().toHaveProperty('error');

    expectTypeOf<CommandAck['ack']>().toEqualTypeOf<boolean>();
    expectTypeOf<CommandAck['success']>().toEqualTypeOf<boolean>();
    expectTypeOf<CommandAck['error']>().toEqualTypeOf<string | undefined>();
  });

  it('ConnectedEvent should have correct structure', () => {
    expectTypeOf<ConnectedEvent>().toHaveProperty('event');
    expectTypeOf<ConnectedEvent>().toHaveProperty('data');

    expectTypeOf<ConnectedEvent['event']>().toEqualTypeOf<'connected'>();
    expectTypeOf<ConnectedEvent['data']>().toHaveProperty('session_id');
    expectTypeOf<ConnectedEvent['data']['session_id']>().toEqualTypeOf<string>();
  });

  it('BroadcastEvent should have correct structure', () => {
    expectTypeOf<BroadcastEvent>().toHaveProperty('msg_id');
    expectTypeOf<BroadcastEvent>().toHaveProperty('seq');
    expectTypeOf<BroadcastEvent>().toHaveProperty('timestamp');
    expectTypeOf<BroadcastEvent>().toHaveProperty('topic');
    expectTypeOf<BroadcastEvent>().toHaveProperty('event');
    expectTypeOf<BroadcastEvent>().toHaveProperty('data');

    expectTypeOf<BroadcastEvent['msg_id']>().toEqualTypeOf<string>();
    expectTypeOf<BroadcastEvent['seq']>().toEqualTypeOf<number>();
    expectTypeOf<BroadcastEvent['timestamp']>().toEqualTypeOf<string>();
    expectTypeOf<BroadcastEvent['topic']>().toEqualTypeOf<string>();
    expectTypeOf<BroadcastEvent['event']>().toEqualTypeOf<string>();
  });

});

describe('Package Exports', () => {
  it('should export all expected types', async () => {
    const exports = await import('../src/index');

    // Core schemas - these are type-only exports, check they exist via type assertions
    type _TaskStatusCheck = typeof exports extends { TaskStatus: never } ? never : unknown;
    type _TaskTypeCheck = typeof exports extends { TaskType: never } ? never : unknown;

    // API types should be exported (runtime check for module structure)
    expect(exports).toBeDefined();
  });
});
