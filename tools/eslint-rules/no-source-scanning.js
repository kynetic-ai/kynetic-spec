/**
 * ESLint-compatible rule for oxlint JS Plugins Alpha.
 *
 * Bans reading project files and asserting on their string contents in tests.
 * Tests should exercise behavior, not scan file contents.
 *
 * Detection:
 *   1. Track fs imports (readFileSync / readFile) — ESM and require()
 *   2. Track variables assigned from file reads
 *   3. Flag read calls where the path is NOT in a safe directory
 *   4. Flag assertions on variables holding file read results
 *
 * Safe directories (reads allowed without disabling):
 *   - Paths through variables named tempDir, tmpDir, tmp, etc.
 *   - Paths containing fixture-related segments
 *
 * For edge cases, use eslint-disable comments with a reason.
 */

const FS_MODULE_PATTERN = /^(node:)?fs(\/promises)?$/;
const READ_FUNCTIONS = new Set(["readFileSync", "readFile"]);
const ASSERTION_METHODS = new Set([
  "toContain",
  "toMatch",
  "toBe",
  "toEqual",
  "toHaveProperty",
]);
const STRING_SEARCH_METHODS = new Set([
  "includes",
  "match",
  "search",
  "indexOf",
  "startsWith",
  "endsWith",
]);
const PATH_FUNCTIONS = new Set(["join", "resolve"]);

// Path segments that indicate temp/fixture directories (safe to read from)
const SAFE_PATH_SEGMENTS = [
  "fixtures",
  "fixture",
  "/tmp",
  ".kspec",
];

// Function names that return temp directory paths
const TEMP_DIR_FUNCTIONS = new Set([
  "mkdtemp",
  "mkdtempSync",
  "createTempDir",
  "setupTempFixtures",
  "setupMultiDirFixtures",
]);

/**
 * Check if an identifier name looks like a safe temp/fixture variable.
 */
function isSafeVarName(name) {
  const lower = name.toLowerCase();
  return lower.includes("temp") || lower.includes("tmp") || lower.includes("fixture");
}

/**
 * Check if a call expression returns a temp directory path.
 * Matches: mkdtemp(...), setupTempFixtures(), createTempDir(), etc.
 * Also matches: fs.mkdtemp(...), os.tmpdir()
 */
function isTempDirCall(node) {
  if (node.type !== "CallExpression") return false;
  const callee = node.callee;

  // Direct: mkdtemp(...), setupTempFixtures()
  if (callee.type === "Identifier" && TEMP_DIR_FUNCTIONS.has(callee.name)) {
    return true;
  }

  // Namespace: fs.mkdtemp(...), os.tmpdir()
  if (
    callee.type === "MemberExpression" &&
    callee.property.type === "Identifier"
  ) {
    if (TEMP_DIR_FUNCTIONS.has(callee.property.name)) return true;
    if (callee.property.name === "tmpdir") return true;
  }

  return false;
}

/**
 * Check if a path.join/resolve call is rooted in a safe variable or /tmp.
 */
function isPathCallFromSafeRoot(node, safeVars) {
  if (!isPathCall(node)) return false;
  for (const arg of node.arguments) {
    if (arg.type === "Identifier" && safeVars.has(arg.name)) return true;
    if (arg.type === "CallExpression" && isTempDirCall(arg)) return true;
    const strs = extractStrings(arg);
    if (strs && hasSafePathSegment(strs)) return true;
    // Recurse nested path calls
    if (arg.type === "CallExpression" && isPathCall(arg)) {
      if (isPathCallFromSafeRoot(arg, safeVars)) return true;
    }
  }
  return false;
}

/**
 * Extract string values from an AST node.
 */
function extractStrings(node) {
  if (!node) return null;
  if (node.type === "Literal" && typeof node.value === "string") {
    return [node.value];
  }
  if (node.type === "TemplateLiteral") {
    return node.quasis.map((q) => q.value.raw);
  }
  return null;
}

/**
 * Check if a path (from string fragments) contains safe segments.
 */
function hasSafePathSegment(strings) {
  const joined = strings.join("/").toLowerCase();
  return SAFE_PATH_SEGMENTS.some((seg) => joined.includes(seg));
}

/**
 * Check if a CallExpression is path.join/resolve.
 */
function isPathCall(node) {
  if (node.type !== "CallExpression") return false;
  const callee = node.callee;
  if (
    callee.type === "MemberExpression" &&
    callee.object.type === "Identifier" &&
    callee.property.type === "Identifier" &&
    PATH_FUNCTIONS.has(callee.property.name)
  ) {
    return true;
  }
  if (callee.type === "Identifier" && PATH_FUNCTIONS.has(callee.name)) {
    return true;
  }
  return false;
}

/**
 * Determine if a read call's first argument points to a safe path.
 * Safe means: through a temp/fixture variable or contains safe segments.
 */
function isReadFromSafePath(argNode, safeVars) {
  if (!argNode) return false;

  // Variable that is known safe (tempDir, fixtureDir, etc.)
  if (argNode.type === "Identifier" && safeVars.has(argNode.name)) {
    return true;
  }

  // String literal with safe segment
  const strs = extractStrings(argNode);
  if (strs && hasSafePathSegment(strs)) {
    return true;
  }

  // path.join(tempDir, ...) — check if rooted in a safe variable or /tmp
  if (argNode.type === "CallExpression" && isPathCallFromSafeRoot(argNode, safeVars)) {
    return true;
  }

  // Function call that receives a safe variable (e.g. getIndexFilePath(ctx))
  if (argNode.type === "CallExpression" && callReceivesSafeArg(argNode, safeVars)) {
    return true;
  }

  return false;
}

/**
 * Check if a function call receives a safe variable as any argument.
 * Heuristic: if a function gets a safe path, it likely returns a derived path.
 */
function callReceivesSafeArg(node, safeVars) {
  if (node.type !== "CallExpression") return false;
  for (const arg of node.arguments) {
    if (arg.type === "Identifier" && safeVars.has(arg.name)) return true;
  }
  return false;
}

const noSourceScanning = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow reading project files and asserting on their contents in tests",
    },
    messages: {
      noFileRead:
        "Test reads project file ({{path}}). Tests should exercise behavior, not scan file contents. If this read is from test-generated output, disable with an inline comment.",
      noFileContentAssert:
        "Assertion on file contents read from a project path. Use behavioral testing instead of static analysis.",
    },
    schema: [],
  },

  create(context) {
    const fsBindings = new Set();
    const fsNamespaces = new Set();
    const safeVars = new Set(); // variables known to hold temp/fixture paths
    const readResultVars = new Set(); // variables holding unsafe file read results

    return {
      // ── Track ESM fs imports ───────────────────────────────────
      ImportDeclaration(node) {
        if (!FS_MODULE_PATTERN.test(node.source.value)) return;

        for (const spec of node.specifiers) {
          if (
            spec.type === "ImportSpecifier" &&
            READ_FUNCTIONS.has(spec.imported.name)
          ) {
            fsBindings.add(spec.local.name);
          } else if (
            spec.type === "ImportDefaultSpecifier" ||
            spec.type === "ImportNamespaceSpecifier"
          ) {
            fsNamespaces.add(spec.local.name);
          }
        }
      },

      // ── Track require() and variable assignments ───────────────
      VariableDeclarator(node) {
        // require("fs") / require("node:fs")
        if (
          node.init &&
          node.init.type === "CallExpression" &&
          node.init.callee.type === "Identifier" &&
          node.init.callee.name === "require" &&
          node.init.arguments.length > 0 &&
          node.init.arguments[0].type === "Literal" &&
          FS_MODULE_PATTERN.test(node.init.arguments[0].value)
        ) {
          if (node.id.type === "ObjectPattern") {
            for (const prop of node.id.properties) {
              if (
                prop.type === "Property" &&
                prop.key.type === "Identifier" &&
                READ_FUNCTIONS.has(prop.key.name)
              ) {
                const local =
                  prop.value.type === "Identifier"
                    ? prop.value.name
                    : prop.key.name;
                fsBindings.add(local);
              }
            }
          } else if (node.id.type === "Identifier") {
            fsNamespaces.add(node.id.name);
          }
        }

        if (!node.init || node.id.type !== "Identifier") return;
        const varName = node.id.name;
        const init = node.init;
        const callNode =
          init.type === "AwaitExpression" ? init.argument : init;

        // Track variables assigned from temp-dir-creating functions
        // e.g. const testDir = await mkdtemp(...), const dir = await setupTempFixtures()
        if (callNode && callNode.type === "CallExpression" && isTempDirCall(callNode)) {
          safeVars.add(varName);
          return;
        }

        // Track variables with safe-sounding names
        if (isSafeVarName(varName)) {
          safeVars.add(varName);
          return;
        }

        // Track variables assigned from path.join(safeVar, ...) or path.join('/tmp', ...)
        if (callNode && callNode.type === "CallExpression" && isPathCallFromSafeRoot(callNode, safeVars)) {
          safeVars.add(varName);
          return;
        }

        // Track variables assigned from any function call that receives a safe var as argument.
        // Heuristic: if a function is called with a safe variable, its return value is
        // likely a path derived from that safe root (e.g. getIndexFilePath(ctx), getSessionBudgetPath(sessionsDir, id))
        if (callNode && callNode.type === "CallExpression" && callReceivesSafeArg(callNode, safeVars)) {
          safeVars.add(varName);
          return;
        }

        // Track: const content = readFileSync(...) / await readFile(...)
        if (callNode && callNode.type === "CallExpression" && isFsReadCall(callNode)) {
          if (!isReadFromSafePath(callNode.arguments[0], safeVars)) {
            readResultVars.add(varName);
          }
        }
      },

      // ── Track reassignments (let x; x = ...) ─────────────────
      AssignmentExpression(node) {
        if (node.left.type !== "Identifier" || !node.right) return;
        const varName = node.left.name;
        const rhs = node.right;
        const callNode =
          rhs.type === "AwaitExpression" ? rhs.argument : rhs;

        if (callNode && callNode.type === "CallExpression") {
          if (isTempDirCall(callNode) || isPathCallFromSafeRoot(callNode, safeVars) || callReceivesSafeArg(callNode, safeVars)) {
            safeVars.add(varName);
            return;
          }
        }
      },

      // ── Flag unsafe file reads and assertions on results ───────
      CallExpression(node) {
        // Flag read calls to non-safe paths
        if (isFsReadCall(node)) {
          if (!isReadFromSafePath(node.arguments[0], safeVars)) {
            const firstArg = node.arguments[0];
            const argText = firstArg
              ? context.sourceCode.getText(firstArg)
              : "unknown";
            context.report({
              node,
              messageId: "noFileRead",
              data: { path: argText },
            });
          }
          return;
        }

        // Flag: expect(content).toContain() etc.
        if (
          node.callee.type === "MemberExpression" &&
          ASSERTION_METHODS.has(getPropertyName(node.callee))
        ) {
          const expectCall = findExpectCall(node.callee.object);
          if (expectCall) {
            const arg = expectCall.arguments[0];
            if (arg && arg.type === "Identifier" && readResultVars.has(arg.name)) {
              context.report({ node, messageId: "noFileContentAssert" });
              return;
            }
          }
        }

        // Flag: content.includes(...), content.match(...) etc.
        if (
          node.callee.type === "MemberExpression" &&
          node.callee.object.type === "Identifier" &&
          readResultVars.has(node.callee.object.name) &&
          STRING_SEARCH_METHODS.has(getPropertyName(node.callee))
        ) {
          context.report({ node, messageId: "noFileContentAssert" });
        }
      },
    };

    function isFsReadCall(node) {
      if (node.type !== "CallExpression") return false;
      const callee = node.callee;

      if (callee.type === "Identifier" && fsBindings.has(callee.name)) {
        return true;
      }

      if (
        callee.type === "MemberExpression" &&
        callee.object.type === "Identifier" &&
        fsNamespaces.has(callee.object.name) &&
        callee.property.type === "Identifier" &&
        READ_FUNCTIONS.has(callee.property.name)
      ) {
        return true;
      }

      return false;
    }

    function findExpectCall(node) {
      if (
        node.type === "CallExpression" &&
        node.callee.type === "Identifier" &&
        node.callee.name === "expect"
      ) {
        return node;
      }
      if (
        node.type === "MemberExpression" &&
        node.object.type === "CallExpression"
      ) {
        return findExpectCall(node.object);
      }
      return null;
    }

    function getPropertyName(memberExpr) {
      if (memberExpr.property.type === "Identifier") {
        return memberExpr.property.name;
      }
      if (
        memberExpr.property.type === "Literal" &&
        typeof memberExpr.property.value === "string"
      ) {
        return memberExpr.property.value;
      }
      return null;
    }
  },
};

const plugin = {
  meta: { name: "no-source-scanning" },
  rules: {
    "no-source-file-reads": noSourceScanning,
  },
};

export default plugin;
