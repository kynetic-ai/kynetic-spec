/**
 * Tests for the no-leaky-test-daemon oxlint rule.
 *
 * Verifies that the lint rule flags daemon-spawning patterns in test files
 * that lack cleanup registration (onTestFinished, afterEach, or try/finally),
 * while allowing properly cleaned-up daemon spawns.
 */

import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// AC: @01KNTACP2BXY12MTB2GETNJ7CS ac-3
function runOxlint(fileContent: string): { exitCode: number; output: string } {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "lint-test-"));
  const testFile = path.join(tempDir, "test-file.ts");
  const projectRoot = path.resolve(__dirname, "..");
  const pluginPath = path.resolve(projectRoot, "tools/eslint-rules/no-leaky-test-daemon.js");
  const config = {
    plugins: ["typescript"],
    overrides: [
      {
        files: ["**/*.ts"],
        jsPlugins: [pluginPath],
        rules: {
          "no-leaky-test-daemon/no-leaky-test-daemon": "error",
        },
      },
    ],
  };
  const configFile = path.join(tempDir, ".oxlintrc.json");
  writeFileSync(configFile, JSON.stringify(config));
  writeFileSync(testFile, fileContent);

  try {
    const output = execSync(`npx oxlint --config ${configFile} ${testFile}`, {
      cwd: projectRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    rmSync(tempDir, { recursive: true, force: true });
    return { exitCode: 0, output };
  } catch (err: unknown) {
    const error = err as { status: number; stdout: string; stderr: string };
    const output = (error.stdout || "") + (error.stderr || "");
    rmSync(tempDir, { recursive: true, force: true });
    return { exitCode: error.status, output };
  }
}

describe("no-leaky-test-daemon lint rule", () => {
  describe("positive cases (should flag)", () => {
    // AC: @01KNTACP2BXY12MTB2GETNJ7CS ac-2
    // AC: @01KNTACP2BXY12MTB2GETNJ7CS ac-6
    it("should flag runKspec with serve start --detach and no cleanup", () => {
      const result = runOxlint(`
import { describe, it, expect } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).toContain("no-leaky-test-daemon");
      expect(result.output).toContain("onTestFinished");
    });

    it("should flag template literal with serve start --detach and no cleanup", () => {
      const result = runOxlint(`
import { describe, it, expect } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    const port = 3456;
    runKspec(\`serve start --detach --port \${port}\`);
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    it("should flag spawn with DAEMON_ENTRY and no cleanup", () => {
      const result = runOxlint(`
import { describe, it, expect } from "vitest";
import { spawn } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";

describe("test suite", () => {
  it("should spawn daemon", () => {
    const child = spawn("node", [DAEMON_ENTRY, "--port", "3456"]);
    expect(child.pid).toBeDefined();
  });
});
`);
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    it("should flag execSync with serve start --detach and no cleanup", () => {
      const result = runOxlint(`
import { describe, it, expect } from "vitest";
import { execSync } from "child_process";

describe("test suite", () => {
  it("should start daemon via exec", () => {
    execSync("kspec serve start --detach --port 3456");
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    it("should flag spawn with dist/daemon/index.js string literal and no cleanup", () => {
      const result = runOxlint(`
import { describe, it, expect } from "vitest";
import { spawn } from "child_process";

describe("test suite", () => {
  it("should spawn daemon", () => {
    const child = spawn("node", ["dist/daemon/index.js", "--port", "3456"]);
    expect(child.pid).toBeDefined();
  });
});
`);
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    // Blocker 1 repro: unrelated afterEach with generic 'stop' should not count as cleanup
    it("should flag serve start --detach when afterEach only stops an unrelated fixture", () => {
      const result = runOxlint(`
import { describe, it, expect, afterEach } from "vitest";

describe("test suite", () => {
  afterEach(() => stopUnrelatedFixture());

  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    // Blocker 2 repro: cleanup registered after an await is too late
    it("should flag serve start --detach when cleanup is registered after an await", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

describe("test suite", () => {
  it("should start daemon", async () => {
    runKspec("serve start --detach --port 3456");
    await somethingAsync();
    onTestFinished(() => process.kill(pid, "SIGTERM"));
  });
});
`);
      expect(result.output).toContain("no-leaky-test-daemon");
    });

    // Blocker 2 variant: cleanup after expect is too late
    it("should flag serve start --detach when cleanup is registered after an expect", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    expect(true).toBe(true);
    onTestFinished(() => process.kill(pid, "SIGTERM"));
  });
});
`);
      expect(result.output).toContain("no-leaky-test-daemon");
    });
  });

  describe("negative cases (should NOT flag)", () => {
    // AC: @01KNTACP2BXY12MTB2GETNJ7CS ac-2
    it("should allow serve start --detach with onTestFinished cleanup", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    runKspec("serve start --detach --port 3456");
    const pid = 12345;
    onTestFinished(() => killPid(pid));
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("should allow spawn with DAEMON_ENTRY when afterEach has cleanup", () => {
      const result = runOxlint(`
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";

describe("test suite", () => {
  let child;
  afterEach(() => {
    if (child) child.kill("SIGTERM");
  });

  it("should spawn daemon", () => {
    child = spawn("node", [DAEMON_ENTRY, "--port", "3456"]);
    expect(child.pid).toBeDefined();
  });
});
`);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("should allow spawn in a named helper function", () => {
      const result = runOxlint(`
import { describe, it, expect } from "vitest";
import { spawn } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";

function startDaemon(port) {
  return spawn("node", [DAEMON_ENTRY, "--port", String(port)]);
}

describe("test suite", () => {
  it("should spawn daemon", () => {
    const child = startDaemon(3456);
    expect(child.pid).toBeDefined();
  });
});
`);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("should allow spawn in a named const arrow function", () => {
      const result = runOxlint(`
import { describe, it, expect } from "vitest";
import { spawn } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";

const startDaemon = (port) => {
  return spawn("node", [DAEMON_ENTRY, "--port", String(port)]);
};

describe("test suite", () => {
  it("should spawn daemon", () => {
    const child = startDaemon(3456);
    expect(child.pid).toBeDefined();
  });
});
`);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("should allow spawn for non-daemon binaries", () => {
      const result = runOxlint(`
import { describe, it, expect } from "vitest";
import { spawn } from "child_process";

describe("test suite", () => {
  it("should spawn a non-daemon process", () => {
    const child = spawn("node", ["some-script.js"]);
    expect(child.pid).toBeDefined();
  });
});
`);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("should allow serve start --detach in try/finally with cleanup", () => {
      const result = runOxlint(`
import { describe, it, expect } from "vitest";

describe("test suite", () => {
  it("should start daemon", () => {
    try {
      runKspec("serve start --detach --port 3456");
      expect(true).toBe(true);
    } finally {
      process.kill(pid, "SIGTERM");
    }
  });
});
`);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("should not flag kspec commands without --detach", () => {
      const result = runOxlint(`
import { describe, it, expect } from "vitest";

describe("test suite", () => {
  it("should start daemon in foreground", () => {
    runKspec("serve start --port 3456");
    expect(true).toBe(true);
  });
});
`);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });

    it("should allow spawn with DAEMON_ENTRY and process.kill cleanup", () => {
      const result = runOxlint(`
import { describe, it, expect, onTestFinished } from "vitest";
import { spawn } from "child_process";

const DAEMON_ENTRY = "dist/daemon/index.js";

describe("test suite", () => {
  it("should spawn daemon", () => {
    const child = spawn("node", [DAEMON_ENTRY, "--port", "3456"]);
    onTestFinished(() => process.kill(child.pid, "SIGTERM"));
    expect(child.pid).toBeDefined();
  });
});
`);
      expect(result.output).not.toContain("no-leaky-test-daemon");
    });
  });

  // AC: @01KNTACP2BXY12MTB2GETNJ7CS ac-4
  describe("real codebase validation", () => {
    it("should pass against the full tests/ directory with zero violations", () => {
      const projectRoot = path.resolve(__dirname, "..");
      try {
        const output = execSync(
          `npx oxlint --config .oxlintrc.json tests/ 2>&1 | grep "no-leaky-test-daemon" || true`,
          {
            cwd: projectRoot,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        expect(output.trim()).toBe("");
      } catch (err: unknown) {
        const error = err as { stdout: string; stderr: string };
        const output = (error.stdout || "") + (error.stderr || "");
        // If grep exits non-zero it means no matches — that's the expected result
        if (!output.includes("no-leaky-test-daemon")) {
          // Good — no violations
        } else {
          throw new Error(`Found no-leaky-test-daemon violations in tests/:\n${output}`);
        }
      }
    });
  });
});
