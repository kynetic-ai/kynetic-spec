/**
 * E2E tests for trait display in item/task output
 * AC: @trait-display ac-1, ac-2, ac-3, ac-4, ac-5
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  kspecOutput as kspec,
  kspecJson,
  setupTempFixtures,
  cleanupTempDir,
  initGitRepo,
} from './helpers/cli';

describe('Trait Display - Item Get', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    await initGitRepo(tempDir);

    // Create a trait module
    const traitModule = `_ulid: 01KFCVXQ97E9XPWSD35B21CR2X
slugs:
  - trait-json-output
title: JSON Output Support
type: trait
description: Trait for specs that support JSON output
status:
  maturity: draft
  implementation: not_started
acceptance_criteria:
  - id: ac-1
    given: command with --json flag
    when: executed
    then: outputs valid JSON
  - id: ac-2
    given: JSON output
    when: parsed
    then: contains all required fields
`;

    await fs.writeFile(
      path.join(tempDir, 'modules/traits.yaml'),
      traitModule
    );

    // Create a module with a feature that implements the trait
    const specModule = `_ulid: 01KFCVXQAABBCCDDEEFFGGHHXX
slugs:
  - spec-with-trait
title: Spec Module
type: module
status:
  maturity: draft
  implementation: not_started

features:
  - _ulid: 01KFCVXQBB00112233445566YY
    slugs:
      - feature-with-trait
    title: Feature with Trait
    type: feature
    status:
      maturity: draft
      implementation: not_started
    traits:
      - "@trait-json-output"
    acceptance_criteria:
      - id: ac-1
        given: feature enabled
        when: user interacts
        then: responds correctly
`;

    await fs.writeFile(
      path.join(tempDir, 'modules/specs.yaml'),
      specModule
    );

    // Update manifest to include new modules
    const manifest = await fs.readFile(
      path.join(tempDir, 'kynetic.yaml'),
      'utf-8'
    );
    const updatedManifest = manifest.replace(
      'includes:\n  - modules/core.yaml',
      'includes:\n  - modules/core.yaml\n  - modules/traits.yaml\n  - modules/specs.yaml'
    );
    await fs.writeFile(
      path.join(tempDir, 'kynetic.yaml'),
      updatedManifest
    );
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @trait-display ac-1
  it('should show own AC followed by inherited AC in text mode', () => {
    const output = kspec('item get @feature-with-trait', tempDir);

    // Should show spec's own AC
    expect(output).toContain('[ac-1]');
    expect(output).toContain('Given: feature enabled');

    // Should show inherited AC section
    expect(output).toContain('─── Inherited from @trait-json-output ───');
    expect(output).toContain('(from @trait-json-output)');
  });

  // AC: @trait-display ac-2
  it('should include inherited_traits array in JSON mode', () => {
    const result = kspecJson<{
      _ulid: string;
      title: string;
      traits: string[];
      acceptance_criteria: Array<{ id: string }>;
      inherited_traits: Array<{
        ref: string;
        title: string;
        acceptance_criteria: Array<{ id: string; given?: string; when?: string; then?: string }>;
      }>;
    }>('item get @feature-with-trait', tempDir);

    expect(result.inherited_traits).toBeDefined();
    expect(result.inherited_traits).toHaveLength(1);
    expect(result.inherited_traits[0].ref).toBe('@trait-json-output');
    expect(result.inherited_traits[0].title).toBe('JSON Output Support');
    expect(result.inherited_traits[0].acceptance_criteria).toHaveLength(2);
    expect(result.inherited_traits[0].acceptance_criteria[0].id).toBe('ac-1');
  });

  // AC: @trait-display ac-4
  it('should label each inherited AC with source trait ref', () => {
    const output = kspec('item get @feature-with-trait', tempDir);

    // Each inherited AC should be labeled with source
    expect(output).toContain('[ac-1] (from @trait-json-output)');
    expect(output).toContain('[ac-2] (from @trait-json-output)');
  });

  // AC: @trait-display ac-5
  it('should show each trait AC in separate labeled section for multiple traits', async () => {
    // Add second trait
    const traitModule = await fs.readFile(
      path.join(tempDir, 'modules/traits.yaml'),
      'utf-8'
    );

    const updatedTraits = traitModule + `
---
_ulid: 01KFCVXQCCAABBCCDDEEFF00XX
slugs:
  - trait-api
title: API Support
type: trait
description: Trait for API endpoints
status:
  maturity: draft
  implementation: not_started
acceptance_criteria:
  - id: ac-1
    given: API endpoint
    when: called
    then: returns correct response
`;

    await fs.writeFile(
      path.join(tempDir, 'modules/traits.yaml'),
      updatedTraits
    );

    // Update spec to implement both traits
    const specModule = await fs.readFile(
      path.join(tempDir, 'modules/specs.yaml'),
      'utf-8'
    );

    const updatedSpec = specModule.replace(
      'traits:\n      - "@trait-json-output"',
      'traits:\n      - "@trait-json-output"\n      - "@trait-api"'
    );

    await fs.writeFile(
      path.join(tempDir, 'modules/specs.yaml'),
      updatedSpec
    );

    const output = kspec('item get @feature-with-trait', tempDir);

    // Should have separate sections for each trait
    expect(output).toContain('─── Inherited from @trait-json-output ───');
    expect(output).toContain('─── Inherited from @trait-api ───');
  });
});

describe('Trait Display - Task Get', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    await initGitRepo(tempDir);

    // Create trait and spec (same as above)
    const traitModule = `_ulid: 01TRAIT10000000000000000
slugs:
  - trait-json-output
title: JSON Output Support
type: trait
description: Trait for specs that support JSON output
status:
  maturity: draft
  implementation: not_started
acceptance_criteria:
  - id: ac-1
    given: command with --json flag
    when: executed
    then: outputs valid JSON
`;

    await fs.writeFile(
      path.join(tempDir, 'modules/traits.yaml'),
      traitModule
    );

    const specModule = `_ulid: 01SPEC100000000000000000
slugs:
  - spec-with-trait
title: Spec Module
type: module
status:
  maturity: draft
  implementation: not_started

features:
  - _ulid: 01SPEC101000000000000000
    slugs:
      - feature-with-trait
    title: Feature with Trait
    type: feature
    status:
      maturity: draft
      implementation: not_started
    traits:
      - "@trait-json-output"
    acceptance_criteria:
      - id: ac-1
        given: feature enabled
        when: user interacts
        then: responds correctly
`;

    await fs.writeFile(
      path.join(tempDir, 'modules/specs.yaml'),
      specModule
    );

    // Update manifest to include new modules
    const manifest = await fs.readFile(
      path.join(tempDir, 'kynetic.yaml'),
      'utf-8'
    );
    const updatedManifest = manifest.replace(
      'includes:\n  - modules/core.yaml',
      'includes:\n  - modules/core.yaml\n  - modules/traits.yaml\n  - modules/specs.yaml'
    );
    await fs.writeFile(
      path.join(tempDir, 'kynetic.yaml'),
      updatedManifest
    );

    // Create task linked to spec
    const tasksFile = `_version: "0.1"
_updated_at: "2026-01-20T00:00:00Z"

tasks:
  - _ulid: 01KFCVXQDD1122334455667788
    slugs:
      - task-with-trait-spec
    title: Task with Trait Spec
    type: task
    status: pending
    priority: 2
    spec_ref: "@feature-with-trait"
    tags: []
    depends_on: []
    blocked_by: []
    notes: []
    todos: []
    created_at: "2026-01-20T00:00:00Z"
`;

    await fs.writeFile(
      path.join(tempDir, 'project.tasks.yaml'),
      tasksFile
    );
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @trait-display ac-3
  it('should show inherited AC sections in task get', () => {
    const output = kspec('task get @task-with-trait-spec', tempDir);

    // Should show task details
    expect(output).toContain('Task with Trait Spec');

    // Should show inherited AC from trait
    expect(output).toContain('─── Inherited from @trait-json-output ───');
    expect(output).toContain('[ac-1] (from @trait-json-output)');
  });

  // AC: @trait-display ac-2 (JSON mode for tasks)
  it('should include inherited_traits in task JSON output', () => {
    const result = kspecJson<{
      _ulid: string;
      title: string;
      spec_ref: string;
      inherited_traits?: Array<{
        ref: string;
        title: string;
        acceptance_criteria: Array<{ id: string }>;
      }>;
    }>('task get @task-with-trait-spec', tempDir);

    expect(result.inherited_traits).toBeDefined();
    expect(result.inherited_traits).toHaveLength(1);
    expect(result.inherited_traits![0].ref).toBe('@trait-json-output');
  });
});
