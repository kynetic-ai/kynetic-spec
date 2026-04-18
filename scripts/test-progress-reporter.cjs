/**
 * Minimal vitest reporter that emits one line per completed test file to stderr.
 * Used by scripts/test.cjs in non-verbose mode to provide liveness feedback.
 *
 * Lines are prefixed with a marker (KSPEC_PROGRESS:) so the parent process can
 * distinguish progress output from other vitest stderr noise and forward it to
 * the terminal while routing everything else to the log file only.
 *
 * Output format (after parent strips prefix):
 *   PASS tests/parser.test.ts (66 tests, 350ms)
 *   FAIL tests/foo.test.ts (5 tests, 2 failed, 800ms)
 */

const path = require("path");

// ANSI colors — same palette as test.cjs condensed output
const c = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
};

const PROGRESS_PREFIX = "KSPEC_PROGRESS:";

function formatDuration(ms) {
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  return `${Math.round(ms)}ms`;
}

class ProgressReporter {
  onTestModuleEnd(testModule) {
    const filePath = testModule.moduleId;
    const projectRoot = path.resolve(__dirname, "..");
    const relativePath = path.relative(projectRoot, filePath);

    // Count tests by state
    let passed = 0;
    let failed = 0;
    let skipped = 0;

    for (const test of testModule.children.allTests()) {
      const state = test.result().state;
      if (state === "passed") passed++;
      else if (state === "failed") failed++;
      else if (state === "skipped") skipped++;
    }

    const total = passed + failed + skipped;

    // Duration from diagnostic
    const diag = testModule.diagnostic();
    const duration = diag ? formatDuration(diag.duration) : "";

    // Build the display line (colors applied here since parent forwards as-is)
    const ok = failed === 0;
    const marker = ok ? `${c.green}PASS${c.reset}` : `${c.red}FAIL${c.reset}`;

    let counts = `${total} test${total !== 1 ? "s" : ""}`;
    if (failed > 0) {
      counts += `, ${c.red}${failed} failed${c.reset}`;
    }
    if (skipped > 0) {
      counts += `, ${skipped} skipped`;
    }

    const durationPart = duration ? `, ${c.dim}${duration}${c.reset}` : "";
    const line = `  ${marker} ${relativePath} ${c.dim}(${c.reset}${counts}${durationPart}${c.dim})${c.reset}`;

    // Write with prefix so parent can extract from the stderr stream
    process.stderr.write(`${PROGRESS_PREFIX}${line}\n`);
  }
}

module.exports = ProgressReporter;
