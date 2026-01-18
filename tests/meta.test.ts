/**
 * Integration tests for kspec meta commands
 * AC: @agent-definitions ac-agent-1, ac-agent-2
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const CLI_PATH = path.join(__dirname, '..', 'src', 'cli', 'index.ts');

/**
 * Run a kspec CLI command and return stdout
 */
function kspec(args: string, cwd: string): string {
  const cmd = `npx tsx ${CLI_PATH} ${args}`;
  try {
    return execSync(cmd, {
      cwd,
      encoding: 'utf-8',
      env: { ...process.env, KSPEC_AUTHOR: '@test' },
    }).trim();
  } catch (error: unknown) {
    const execError = error as { stdout?: string; stderr?: string; message?: string };
    // Return stdout even on error (some commands exit non-zero with valid output)
    if (execError.stdout) return execError.stdout.trim();
    throw new Error(`Command failed: ${cmd}\n${execError.stderr || execError.message}`);
  }
}

/**
 * Run kspec and return JSON output
 */
function kspecJson<T>(args: string, cwd: string): T {
  const output = kspec(`${args} --json`, cwd);
  return JSON.parse(output);
}

/**
 * Copy fixtures to a temp directory for isolated testing
 */
async function setupTempFixtures(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kspec-test-'));
  await fs.cp(FIXTURES_DIR, tempDir, { recursive: true });
  return tempDir;
}

/**
 * Clean up temp directory
 */
async function cleanupTempDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

describe('Integration: meta agents', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @agent-definitions ac-agent-1
  it('should output table with ID, Name, Capabilities columns', () => {
    const output = kspec('meta agents', tempDir);

    // Should contain table headers
    expect(output).toContain('ID');
    expect(output).toContain('Name');
    expect(output).toContain('Capabilities');

    // Should contain agent data from fixtures
    expect(output).toContain('test-agent');
    expect(output).toContain('Test Agent');
    expect(output).toContain('code, test');

    expect(output).toContain('review-agent');
    expect(output).toContain('Review Agent');
    expect(output).toContain('review, analyze');
  });

  // AC: @agent-definitions ac-agent-2
  it('should output JSON array with full agent details', () => {
    interface AgentJson {
      id: string;
      name: string;
      description: string;
      capabilities: string[];
      tools: string[];
      session_protocol: Record<string, string>;
      conventions: string[];
    }

    const agents = kspecJson<AgentJson[]>('meta agents', tempDir);

    // Should be an array
    expect(Array.isArray(agents)).toBe(true);
    expect(agents).toHaveLength(2);

    // First agent
    const testAgent = agents.find(a => a.id === 'test-agent');
    expect(testAgent).toBeDefined();
    expect(testAgent?.name).toBe('Test Agent');
    expect(testAgent?.description).toBe('A test agent for integration testing');
    expect(testAgent?.capabilities).toEqual(['code', 'test']);
    expect(testAgent?.tools).toEqual(['kspec', 'git']);
    expect(testAgent?.session_protocol).toEqual({
      start: 'kspec session start',
      checkpoint: 'kspec session checkpoint',
    });
    expect(testAgent?.conventions).toEqual([
      'Test convention 1',
      'Test convention 2',
    ]);

    // Second agent
    const reviewAgent = agents.find(a => a.id === 'review-agent');
    expect(reviewAgent).toBeDefined();
    expect(reviewAgent?.name).toBe('Review Agent');
    expect(reviewAgent?.capabilities).toEqual(['review', 'analyze']);
    expect(reviewAgent?.tools).toEqual(['kspec']);
  });

  it('should handle empty agents list gracefully', async () => {
    // Create a meta manifest with no agents
    const emptyMetaPath = path.join(tempDir, 'kynetic.meta.yaml');
    await fs.writeFile(emptyMetaPath, 'kynetic_meta: "1.0"\nagents: []\n');

    const output = kspec('meta agents', tempDir);
    expect(output).toContain('No agents defined');
  });

  it('should handle missing meta manifest gracefully', async () => {
    // Remove meta manifest file entirely
    const metaPath = path.join(tempDir, 'kynetic.meta.yaml');
    await fs.rm(metaPath, { force: true });

    // Also remove reference from kynetic.yaml
    const manifestPath = path.join(tempDir, 'kynetic.yaml');
    let content = await fs.readFile(manifestPath, 'utf-8');
    content = content.replace('meta_file: kynetic.meta.yaml\n', '');
    await fs.writeFile(manifestPath, content);

    const output = kspec('meta agents', tempDir);
    // Should show empty result, not crash
    expect(output).toContain('No agents defined');
  });
});
