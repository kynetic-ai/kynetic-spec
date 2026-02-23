/**
 * Tests for Interactive Triage UI
 *
 * Verifies triage page structure, API client, navigation, and static mode support.
 * Uses static analysis pattern matching existing web UI tests.
 *
 * AC Coverage:
 * - @interactive-triage-ui ac-1: Card view shows item text, tags, age, added_by
 * - @interactive-triage-ui ac-2: Shows agent recommendation for triaged items
 * - @interactive-triage-ui ac-3: Submit creates/updates record and advances
 * - @interactive-triage-ui ac-4: Override captures override with user attribution
 * - @interactive-triage-ui ac-5: Next/previous navigation, decision state display
 * - @interactive-triage-ui ac-6: Real-time updates via WebSocket triage:updates
 * - @interactive-triage-ui ac-7: Tag and status filters with progress count
 * - @interactive-triage-ui ac-8: Static mode: read-only, action buttons hidden
 *
 * Trait AC Coverage:
 * - @trait-websocket-protocol ac-1: WebSocket connection established
 * - @trait-websocket-protocol ac-2: Subscribe to triage:updates topic
 * - @trait-websocket-protocol ac-3: Handle broadcast events for triage updates
 */

import { describe, it, expect } from 'vitest';
import { readFile } from 'fs/promises';
import { join } from 'path';

const PAGE_PATH = join(process.cwd(), 'packages/web-ui/src/routes/triage/+page.svelte');
const API_PATH = join(process.cwd(), 'packages/web-ui/src/lib/api.ts');
const API_STATIC_PATH = join(process.cwd(), 'packages/web-ui/src/lib/api-static.ts');
const SIDEBAR_PATH = join(process.cwd(), 'packages/web-ui/src/lib/components/Sidebar.svelte');
const MOBILE_NAV_PATH = join(process.cwd(), 'packages/web-ui/src/lib/components/MobileNav.svelte');
const TYPES_PATH = join(process.cwd(), 'packages/web-ui/src/lib/types/triage.ts');

describe('Interactive Triage UI', () => {
  // AC: @interactive-triage-ui ac-1
  it('should display card view with item text, tags, age, and added_by', async () => {
    const content = await readFile(PAGE_PATH, 'utf-8');

    // Card structure with test IDs
    expect(content).toContain('data-testid="triage-card"');
    expect(content).toContain('data-testid="triage-card-text"');
    expect(content).toContain('data-testid="triage-card-tags"');
    expect(content).toContain('data-testid="triage-card-age"');
    expect(content).toContain('data-testid="triage-card-added-by"');

    // Renders inbox item fields
    expect(content).toContain('currentItem.inbox.text');
    expect(content).toContain('currentItem.inbox.tags');
    expect(content).toContain('currentItem.inbox.created_at');
    expect(content).toContain('currentItem.inbox.added_by');
  });

  // AC: @interactive-triage-ui ac-2
  it('should show agent recommendation when record is triaged', async () => {
    const content = await readFile(PAGE_PATH, 'utf-8');

    // Agent recommendation section
    expect(content).toContain('data-testid="triage-agent-recommendation"');
    expect(content).toContain('data-testid="triage-rec-action"');
    expect(content).toContain('data-testid="triage-rec-reasoning"');
    expect(content).toContain('data-testid="triage-rec-evidence"');

    // Shows recommendation when status is triaged (not pending)
    expect(content).toContain("currentItem.record.status !== 'pending'");
    expect(content).toContain('Agent Recommendation');

    // Shows action, reasoning, evidence refs
    expect(content).toContain('currentItem.record.action');
    expect(content).toContain('currentItem.record.reasoning');
    expect(content).toContain('currentItem.record.evidence_refs');
  });

  // AC: @interactive-triage-ui ac-3
  it('should submit triage decision and advance to next item', async () => {
    const content = await readFile(PAGE_PATH, 'utf-8');

    // Action form with submit button
    expect(content).toContain('data-testid="triage-action-form"');
    expect(content).toContain('data-testid="triage-submit"');
    expect(content).toContain('data-testid="triage-reasoning"');
    expect(content).toContain('data-testid="triage-action-buttons"');

    // Submit function calls createTriageRecord
    expect(content).toContain('createTriageRecord');
    expect(content).toContain('handleSubmit');

    // Advances to next item after submit
    expect(content).toContain('currentIndex < filteredItems.length - 1');
    expect(content).toContain('currentIndex++');
  });

  // AC: @interactive-triage-ui ac-4
  it('should support overriding decisions with user attribution', async () => {
    const content = await readFile(PAGE_PATH, 'utf-8');

    // Override logic when record already exists
    expect(content).toContain('overrideTriageRecord');
    expect(content).toContain('Override Decision');

    // Shows override info
    expect(content).toContain('override_reasoning');
    expect(content).toContain('override_by');
  });

  // AC: @interactive-triage-ui ac-5
  it('should support next/previous navigation with decision state display', async () => {
    const content = await readFile(PAGE_PATH, 'utf-8');

    // Navigation buttons
    expect(content).toContain('data-testid="triage-prev"');
    expect(content).toContain('data-testid="triage-next"');
    expect(content).toContain('data-testid="triage-position"');

    // Navigation functions
    expect(content).toContain('goNext');
    expect(content).toContain('goPrevious');
    expect(content).toContain('currentIndex');

    // Keyboard navigation with input guard
    expect(content).toContain('ArrowLeft');
    expect(content).toContain('ArrowRight');
    // Should skip navigation when focus is on input/textarea
    expect(content).toContain('TEXTAREA');
    expect(content).toContain('INPUT');
    expect(content).toContain('isContentEditable');

    // Decision state display on already-triaged items
    expect(content).toContain('data-testid="triage-card-status"');
    expect(content).toContain("'Acted'");
    expect(content).toContain("'Triaged'");
  });

  // AC: @interactive-triage-ui ac-6
  it('should subscribe to triage:updates WebSocket topic for real-time updates', async () => {
    const content = await readFile(PAGE_PATH, 'utf-8');

    // WebSocket subscription
    expect(content).toContain("subscribe(['triage:updates'])");
    expect(content).toContain("on('triage:updates'");
    expect(content).toContain("off('triage:updates'");
    expect(content).toContain("unsubscribe(['triage:updates'])");

    // Handler reloads data
    expect(content).toContain('handleTriageUpdate');
    expect(content).toContain('loadTriageData');
  });

  // AC: @interactive-triage-ui ac-7
  it('should support tag and status filters with progress count', async () => {
    const content = await readFile(PAGE_PATH, 'utf-8');

    // Filter controls
    expect(content).toContain('data-testid="triage-filters"');
    expect(content).toContain('data-testid="triage-status-filter"');
    expect(content).toContain('data-testid="triage-tag-filter"');

    // Progress display
    expect(content).toContain('data-testid="triage-progress"');
    expect(content).toContain('data-testid="triage-progress-bar"');
    expect(content).toContain('triagedCount');
    expect(content).toContain('totalCount');

    // Filter state
    expect(content).toContain('filterTag');
    expect(content).toContain('filterStatus');
    expect(content).toContain('filteredItems');
  });

  // AC: @interactive-triage-ui ac-8
  it('should display read-only in static mode with action buttons hidden', async () => {
    const content = await readFile(PAGE_PATH, 'utf-8');

    // Static mode checks
    expect(content).toContain('isStaticMode()');

    // Action form hidden in static mode
    expect(content).toContain('{#if !isStaticMode()}');

    // Static mode fallback message
    expect(content).toContain('Use the CLI or daemon to triage items');

    // Static mode notice about snapshot limitation
    expect(content).toContain('data-testid="triage-static-notice"');
    expect(content).toContain('not included in static snapshots');

    // Card navigation still works in static mode
    expect(content).toContain('goPrevious');
    expect(content).toContain('goNext');
  });
});

describe('Triage API Client', () => {
  it('should export triage API functions', async () => {
    const content = await readFile(API_PATH, 'utf-8');

    // Triage API functions
    expect(content).toContain('export async function fetchTriageRecords');
    expect(content).toContain('export async function createTriageRecord');
    expect(content).toContain('export async function overrideTriageRecord');
    expect(content).toContain('export async function actOnTriageRecord');

    // Correct endpoints
    expect(content).toContain('/api/triage`');
    expect(content).toContain('/api/triage/${ref}/override`');
    expect(content).toContain('/api/triage/${ref}/act`');
  });

  it('should support static mode for triage reads', async () => {
    const content = await readFile(API_PATH, 'utf-8');
    const staticContent = await readFile(API_STATIC_PATH, 'utf-8');

    // API dispatches to static in static mode
    expect(content).toContain('fetchTriageRecordsStatic');

    // Static function exists
    expect(staticContent).toContain('export function fetchTriageRecordsStatic');
  });

  it('should guard triage write operations with assertWritable', async () => {
    const content = await readFile(API_PATH, 'utf-8');

    // Write operations are guarded
    expect(content).toContain("assertWritable('create triage record')");
    expect(content).toContain("assertWritable('override triage record')");
    expect(content).toContain("assertWritable('execute triage action')");
  });
});

describe('Triage Types', () => {
  it('should define TriageRecord, TriageStatus, and TriageAction types', async () => {
    const content = await readFile(TYPES_PATH, 'utf-8');

    expect(content).toContain('export type TriageStatus');
    expect(content).toContain('export type TriageAction');
    expect(content).toContain('export interface TriageRecord');

    // Status values
    expect(content).toContain("'pending'");
    expect(content).toContain("'triaged'");
    expect(content).toContain("'acted_on'");

    // Action values
    expect(content).toContain("'promote'");
    expect(content).toContain("'delete'");
    expect(content).toContain("'defer'");
    expect(content).toContain("'spec-gap'");
    expect(content).toContain("'duplicate'");

    // Record fields
    expect(content).toContain('inbox_ref');
    expect(content).toContain('item_snapshot');
    expect(content).toContain('evidence_refs');
    expect(content).toContain('override_reasoning');
    expect(content).toContain('override_by');
  });
});

describe('Navigation Integration', () => {
  it('should include Triage link in sidebar navigation', async () => {
    const content = await readFile(SIDEBAR_PATH, 'utf-8');

    expect(content).toContain("path: '/triage'");
    expect(content).toContain("label: 'Triage'");
  });

  it('should include Triage link in mobile navigation', async () => {
    const content = await readFile(MOBILE_NAV_PATH, 'utf-8');

    expect(content).toContain("path: '/triage'");
    expect(content).toContain("label: 'Triage'");
  });
});

// Trait AC coverage tests

// AC: @trait-websocket-protocol ac-1
describe('Trait: WebSocket Protocol', () => {
  // AC: @trait-websocket-protocol ac-2
  it('should subscribe to triage:updates topic on mount', async () => {
    const content = await readFile(PAGE_PATH, 'utf-8');

    // Subscribe with topics array
    expect(content).toContain("subscribe(['triage:updates'])");
  });

  // AC: @trait-websocket-protocol ac-3
  it('should handle broadcast events and reload data', async () => {
    const content = await readFile(PAGE_PATH, 'utf-8');

    // Handler takes BroadcastEvent
    expect(content).toContain('BroadcastEvent');
    expect(content).toContain('handleTriageUpdate');

    // Reloads on update
    expect(content).toContain('loadTriageData');
  });

  it('should clean up subscriptions on destroy', async () => {
    const content = await readFile(PAGE_PATH, 'utf-8');

    // Cleanup in onDestroy
    expect(content).toContain('onDestroy');
    expect(content).toContain("off('triage:updates'");
    expect(content).toContain("unsubscribe(['triage:updates'])");
  });

  it('should skip WebSocket in static mode', async () => {
    const content = await readFile(PAGE_PATH, 'utf-8');

    // Conditional subscription based on mode
    expect(content).toContain('if (!isStaticMode())');
  });
});
