import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

type ReadCall = {
  firstArg: string;
};

const TESTS_DIR = join(process.cwd(), "tests");
const TEST_FILE_SUFFIX = ".test.ts";

function listTestFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") {
      continue;
    }

    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...listTestFiles(fullPath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(TEST_FILE_SUFFIX)) {
      files.push(fullPath);
    }
  }

  return files;
}

function parseReadCalls(content: string): ReadCall[] {
  const calls: ReadCall[] = [];
  const callPattern = /(?:\b\w+\.)?readFile(?:Sync)?\s*\(/g;
  let match: RegExpExecArray | null = null;

  while ((match = callPattern.exec(content)) !== null) {
    const argsStart = callPattern.lastIndex;
    let i = argsStart;
    let depth = 1;
    let args = "";
    let quote: '"' | "'" | "`" | null = null;
    let escaped = false;

    for (; i < content.length; i += 1) {
      const ch = content[i];

      if (quote) {
        args += ch;
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === "\\") {
          escaped = true;
          continue;
        }
        if (ch === quote) {
          quote = null;
        }
        continue;
      }

      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
        args += ch;
        continue;
      }

      if (ch === "(") {
        depth += 1;
        args += ch;
        continue;
      }

      if (ch === ")") {
        depth -= 1;
        if (depth === 0) {
          break;
        }
        args += ch;
        continue;
      }

      args += ch;
    }

    calls.push({ firstArg: firstTopLevelArg(args) });
    callPattern.lastIndex = i + 1;
  }

  return calls;
}

function firstTopLevelArg(args: string): string {
  let depth = 0;
  let quote: '"' | "'" | "`" | null = null;
  let escaped = false;
  let first = "";

  for (let i = 0; i < args.length; i += 1) {
    const ch = args[i];

    if (quote) {
      first += ch;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      first += ch;
      continue;
    }

    if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
      first += ch;
      continue;
    }

    if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
      first += ch;
      continue;
    }

    if (ch === "," && depth === 0) {
      break;
    }

    first += ch;
  }

  return first.trim();
}

function extractSourceReference(text: string): string | null {
  const directSrcMatch = text.match(/['"`]([^'"`]*(?:^|\/)src\/[^'"`]*)['"`]/);
  if (directSrcMatch?.[1]) {
    return directSrcMatch[1];
  }

  const directPackagesMatch = text.match(/['"`]([^'"`]*packages\/[^'"`]+\/src\/[^'"`]*)['"`]/);
  if (directPackagesMatch?.[1]) {
    return directPackagesMatch[1];
  }

  if (/(?:path\.)?(?:join|resolve)\([\s\S]*?['"`]src['"`]/.test(text)) {
    const segments = [...text.matchAll(/['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);

    if (segments.includes("src")) {
      return segments.join("/");
    }
  }

  if (/(?:path\.)?(?:join|resolve)\([\s\S]*?['"`]packages['"`][\s\S]*?['"`]src['"`]/.test(text)) {
    const segments = [...text.matchAll(/['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);
    return segments.join("/");
  }

  return null;
}

function collectSourceVariableHints(content: string): Map<string, string> {
  const hints = new Map<string, string>();
  const varPattern = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=([\s\S]*?);/g;
  let match: RegExpExecArray | null = null;

  while ((match = varPattern.exec(content)) !== null) {
    const variableName = match[1];
    const initializer = match[2];
    const sourceRef = extractSourceReference(initializer);
    if (sourceRef) {
      hints.set(variableName, sourceRef);
    }
  }

  const forOfPattern = /for\s*\(\s*const\s+([A-Za-z_$][\w$]*)\s+of\s+([A-Za-z_$][\w$]*)\s*\)/g;
  while ((match = forOfPattern.exec(content)) !== null) {
    const itemVariable = match[1];
    const iterableVariable = match[2];
    const iterableHint = hints.get(iterableVariable);
    if (iterableHint) {
      hints.set(itemVariable, iterableHint);
    }
  }

  return hints;
}

function resolveReferencedSourcePath(
  expression: string,
  sourceHints: Map<string, string>,
): string | null {
  const directReference = extractSourceReference(expression);
  if (directReference) {
    return directReference;
  }

  for (const [variableName, sourceHint] of sourceHints.entries()) {
    if (new RegExp(`\\b${variableName}\\b`).test(expression)) {
      return sourceHint;
    }
  }

  return null;
}

describe("no static analysis test pattern", () => {
  it("does not allow tests to read implementation source files", () => {
    const violations = new Set<string>();
    const testFiles = listTestFiles(TESTS_DIR);

    for (const testFilePath of testFiles) {
      const content = readFileSync(testFilePath, "utf-8");
      const sourceHints = collectSourceVariableHints(content);
      const readCalls = parseReadCalls(content);

      for (const readCall of readCalls) {
        const sourcePath = resolveReferencedSourcePath(readCall.firstArg, sourceHints);
        if (!sourcePath) {
          continue;
        }

        const relativePath = relative(process.cwd(), testFilePath);
        violations.add(
          `Test file ${relativePath} reads source file ${sourcePath}. Tests should exercise behavior (import functions, call CLI, make HTTP requests) not scan source code for string patterns.`,
        );
      }
    }

    expect([...violations].toSorted()).toEqual([]);
  });
});
