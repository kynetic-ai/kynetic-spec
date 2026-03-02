#!/usr/bin/env node
/**
 * Mock kspec CLI for testing agent invocation lifecycle.
 *
 * Captures all CLI invocations to a JSON file for test verification.
 *
 * Environment variables:
 * - KSPEC_CAPTURE_FILE: Path to file where captured calls will be appended
 *
 * Always exits with code 0 (success).
 */

'use strict';

const fs = require('node:fs');

const captureFile = process.env.KSPEC_CAPTURE_FILE;
const args = process.argv.slice(2);

if (captureFile) {
  let calls = [];
  try {
    calls = JSON.parse(fs.readFileSync(captureFile, 'utf-8'));
  } catch {
    // File doesn't exist yet
  }
  calls.push({ args, timestamp: Date.now() });
  fs.writeFileSync(captureFile, JSON.stringify(calls, null, 2));
}

process.exit(0);
