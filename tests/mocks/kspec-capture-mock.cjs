#!/usr/bin/env node
/**
 * Mock kspec CLI for testing agent invocation lifecycle.
 *
 * Captures all CLI invocations to a JSON file for test verification.
 *
 * Environment variables:
 * - KSPEC_CAPTURE_FILE: Path to file where captured calls will be appended
 *
 * Optional environment variables:
 * - KSPEC_CAPTURE_FAIL_ON: colon-delimited command prefix to fail after capture
 *   (example: "task:block" or "task:note")
 */

"use strict";

const fs = require("node:fs");

const captureFile = process.env.KSPEC_CAPTURE_FILE;
const args = process.argv.slice(2);

if (captureFile) {
  let calls = [];
  try {
    calls = JSON.parse(fs.readFileSync(captureFile, "utf-8"));
  } catch {
    // File doesn't exist yet
  }
  calls.push({ args, timestamp: Date.now() });
  fs.writeFileSync(captureFile, JSON.stringify(calls, null, 2));
}

const failOn = process.env.KSPEC_CAPTURE_FAIL_ON;
if (failOn) {
  const expected = failOn.split(":");
  const matches = expected.every((part, index) => args[index] === part);
  if (matches) {
    process.stderr.write(`Forced failure for ${failOn}\n`);
    process.exit(1);
  }
}

process.exit(0);
