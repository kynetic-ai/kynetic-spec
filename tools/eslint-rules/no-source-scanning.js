/**
 * ESLint-compatible rule for oxlint JS Plugins Alpha.
 *
 * Detects the "source-scanning test" anti-pattern: test files that read
 * implementation source files (src/, templates/, packages/.../src/) and
 * assert on their string contents instead of testing behavior.
 *
 * Four-phase detection:
 *   1. Track fs imports (readFileSync / readFile)
 *   2. Track variables holding source-directory paths
 *   3. Detect read calls targeting source paths
 *   4. Flag assertions on variables that hold source file contents
 */

// Directories that indicate implementation source, not test fixtures
const SOURCE_DIR_SEGMENTS = ["src", "templates"];

// Safe path segments — reads targeting these are NOT violations
const SAFE_PATH_SEGMENTS = [
  "fixtures",
  "tempDir",
  "tmpDir",
  "tmp",
  ".kspec",
  "dist",
  "build",
  "node_modules",
];

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

/**
 * Check whether an array of string argument values contains a source
 * directory segment but no safe-path segment.
 */
function containsSourcePath(strings) {
  const joined = strings.join("/");
  const hasSource = SOURCE_DIR_SEGMENTS.some((seg) => {
    const pattern = new RegExp(`(^|/)${seg}(/|$)`);
    return pattern.test(joined);
  });
  if (!hasSource) return false;
  const hasSafe = SAFE_PATH_SEGMENTS.some((seg) => joined.includes(seg));
  return !hasSafe;
}

/**
 * Extract string values from an AST node (Literal, TemplateLiteral quasis).
 * Returns null if the node contains no extractable strings.
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
 * Check if a CallExpression is path.join(...) or path.resolve(...).
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
 * Collect all extractable string fragments from a call's arguments,
 * including nested path.join/resolve calls and known source-path variables.
 */
function collectCallStringFragments(node, sourcePathVars) {
  const fragments = [];
  for (const arg of node.arguments) {
    const strs = extractStrings(arg);
    if (strs) {
      fragments.push(...strs);
      continue;
    }
    if (arg.type === "Identifier") {
      if (sourcePathVars.has(arg.name)) {
        // Substitute a known source-path marker so containsSourcePath matches
        fragments.push("src/");
      }
      // Skip unknown identifiers (e.g. __dirname, process.cwd())
      continue;
    }
    if (arg.type === "CallExpression" && isPathCall(arg)) {
      fragments.push(...collectCallStringFragments(arg, sourcePathVars));
      continue;
    }
  }
  return fragments;
}

/**
 * Determine if a call argument points to a source path.
 */
function argIsSourcePath(argNode, sourcePathVars) {
  if (!argNode) return false;

  // Variable reference to a known source-path variable
  if (argNode.type === "Identifier" && sourcePathVars.has(argNode.name)) {
    return true;
  }

  // Direct string literal
  const strs = extractStrings(argNode);
  if (strs && containsSourcePath(strs)) {
    return true;
  }

  // Inline path.join/resolve call
  if (argNode.type === "CallExpression" && isPathCall(argNode)) {
    const fragments = collectCallStringFragments(argNode, sourcePathVars);
    if (containsSourcePath(fragments)) return true;
  }

  return false;
}

const noSourceScanning = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow reading source files and asserting on their contents in tests",
    },
    messages: {
      noSourceRead:
        "Test reads source file ({{path}}). Tests should exercise behavior, not scan source code.",
      noSourceAssert:
        "Assertion on source file contents. Use behavioral testing instead of static analysis.",
    },
    schema: [],
  },

  create(context) {
    // Phase 1 state: fs import bindings
    const fsBindings = new Set(); // local names bound to readFileSync/readFile
    const fsNamespaces = new Set(); // local names bound to the fs module object

    // Phase 2 state: variables holding source-directory paths
    const sourcePathVars = new Set();

    // Phase 3/4 state: variables holding source file contents
    const readResultVars = new Set();

    return {
      // ── Phase 1: Track fs imports ──────────────────────────────
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

      // ── Phase 1b: Track require("fs") destructuring ───────────
      //   const { readFileSync } = require("node:fs")
      VariableDeclarator(node) {
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

        // ── Phase 2 + 3: Track path variables and read results ────
        if (!node.init || node.id.type !== "Identifier") return;
        const varName = node.id.name;
        const init = node.init;

        // Direct string literal containing a source path
        const strs = extractStrings(init);
        if (strs && containsSourcePath(strs)) {
          sourcePathVars.add(varName);
          return;
        }

        // path.join/resolve call containing source path segments
        if (init.type === "CallExpression" && isPathCall(init)) {
          const fragments = collectCallStringFragments(init, sourcePathVars);
          if (containsSourcePath(fragments)) {
            sourcePathVars.add(varName);
            return;
          }
        }

        // readFileSync/readFile call — check if reading a source path
        if (init.type === "CallExpression" || init.type === "AwaitExpression") {
          const callNode =
            init.type === "AwaitExpression" ? init.argument : init;
          if (callNode && callNode.type === "CallExpression") {
            if (isFsReadCall(callNode) && argIsSourcePath(callNode.arguments[0], sourcePathVars)) {
              readResultVars.add(varName);
            }
          }
        }
      },

      // ── Phase 3 + 4: Detect read calls and assertions ─────────
      CallExpression(node) {
        // Phase 3: Standalone read calls (not in variable declarations)
        if (isFsReadCall(node) && argIsSourcePath(node.arguments[0], sourcePathVars)) {
          const argText = node.arguments[0]
            ? context.sourceCode.getText(node.arguments[0])
            : "unknown";
          context.report({
            node,
            messageId: "noSourceRead",
            data: { path: argText },
          });
          return;
        }

        // Phase 4: expect(content).toContain() etc.
        if (
          node.callee.type === "MemberExpression" &&
          ASSERTION_METHODS.has(getPropertyName(node.callee))
        ) {
          const obj = node.callee.object;
          // expect(content).toContain(...)
          // expect(content).not.toContain(...)
          const expectCall = findExpectCall(obj);
          if (expectCall) {
            const arg = expectCall.arguments[0];
            if (arg && arg.type === "Identifier" && readResultVars.has(arg.name)) {
              context.report({ node, messageId: "noSourceAssert" });
              return;
            }
          }
        }

        // Phase 4: content.includes(...), content.match(...) etc.
        if (
          node.callee.type === "MemberExpression" &&
          node.callee.object.type === "Identifier" &&
          readResultVars.has(node.callee.object.name) &&
          STRING_SEARCH_METHODS.has(getPropertyName(node.callee))
        ) {
          context.report({ node, messageId: "noSourceAssert" });
        }
      },
    };

    function isFsReadCall(node) {
      if (node.type !== "CallExpression") return false;
      const callee = node.callee;

      // Direct: readFileSync(...)
      if (callee.type === "Identifier" && fsBindings.has(callee.name)) {
        return true;
      }

      // Namespace: fs.readFileSync(...)
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

    /**
     * Walk up through MemberExpression chains to find expect() call.
     * Handles expect(x).toContain() and expect(x).not.toContain().
     */
    function findExpectCall(node) {
      if (
        node.type === "CallExpression" &&
        node.callee.type === "Identifier" &&
        node.callee.name === "expect"
      ) {
        return node;
      }
      // expect(x).not.toContain — node is MemberExpression with .not
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
