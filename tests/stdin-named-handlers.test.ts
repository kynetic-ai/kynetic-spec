import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Static analysis: Ensure stdin helper functions use named handlers
 * instead of removeAllListeners(), which would remove listeners
 * registered by other code.
 */
describe("stdin helpers use named handlers", () => {
  const filesToCheck = [
    "src/cli/commands/item.ts",
    "src/cli/commands/session/commands.ts",
  ];

  for (const file of filesToCheck) {
    it(`${file} should not use process.stdin.removeAllListeners()`, () => {
      const content = readFileSync(resolve(file), "utf8");
      expect(content).not.toContain("process.stdin.removeAllListeners()");
    });

    it(`${file} should use named removeListener for cleanup`, () => {
      const content = readFileSync(resolve(file), "utf8");
      // If the file has stdin listeners, it should use removeListener for cleanup
      if (content.includes('process.stdin.on("data"')) {
        expect(content).toContain('process.stdin.removeListener("data"');
        expect(content).toContain('process.stdin.removeListener("end"');
      }
    });
  }
});
