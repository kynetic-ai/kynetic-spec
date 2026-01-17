#!/usr/bin/env node
/**
 * Mock claude CLI for testing ralph command.
 *
 * Controlled via environment variables:
 * - MOCK_CLAUDE_EXIT_CODE: Exit code to return (default: 0)
 * - MOCK_CLAUDE_FAIL_COUNT: Number of times to fail before succeeding (uses a state file)
 * - MOCK_CLAUDE_STATE_FILE: Path to state file for tracking call count
 * - MOCK_CLAUDE_DELAY_MS: Delay before exiting (simulates work)
 * - MOCK_CLAUDE_OUTPUT: Text to output before exiting
 */

import * as fs from 'node:fs';

const exitCode = parseInt(process.env.MOCK_CLAUDE_EXIT_CODE || '0', 10);
const failCount = parseInt(process.env.MOCK_CLAUDE_FAIL_COUNT || '0', 10);
const stateFile = process.env.MOCK_CLAUDE_STATE_FILE;
const delayMs = parseInt(process.env.MOCK_CLAUDE_DELAY_MS || '0', 10);
const output = process.env.MOCK_CLAUDE_OUTPUT || '';

// Read stdin (the prompt) - we don't use it but need to consume it
let stdin = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  stdin += chunk;
});

process.stdin.on('end', async () => {
  // Optional delay
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  // Output if specified
  if (output) {
    console.log(output);
  }

  // Determine exit code
  let finalExitCode = exitCode;

  if (failCount > 0 && stateFile) {
    // Track call count in state file
    let callCount = 0;
    try {
      callCount = parseInt(fs.readFileSync(stateFile, 'utf-8').trim(), 10) || 0;
    } catch {
      // File doesn't exist yet
    }
    callCount++;
    fs.writeFileSync(stateFile, String(callCount));

    // Fail until we've been called failCount times
    if (callCount <= failCount) {
      finalExitCode = 1;
      console.error(`Mock claude: Simulated failure ${callCount}/${failCount}`);
    } else {
      finalExitCode = 0;
      console.log(`Mock claude: Success after ${failCount} failures`);
    }
  }

  process.exit(finalExitCode);
});

// Handle case where stdin is already closed or empty
setTimeout(() => {
  if (stdin === '') {
    process.stdin.emit('end');
  }
}, 100);
