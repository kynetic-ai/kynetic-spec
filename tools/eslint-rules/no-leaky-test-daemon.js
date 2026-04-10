/**
 * ESLint-compatible rule for oxlint JS Plugins Alpha.
 *
 * Detects daemon-spawning patterns in test files that lack cleanup
 * registration (onTestFinished, afterEach with kill/stop, or try/finally).
 *
 * Two anti-patterns are detected:
 *   1. Calls containing "serve start" + "--detach" string arguments without
 *      cleanup registration in the same scope.
 *   2. spawn() calls where the first argument resolves to a path containing
 *      "dist/daemon/index.js" without cleanup registration.
 *
 * Only flags spawns that are directly in test callbacks (it/test) or
 * beforeEach callbacks. Spawns inside named helper functions are assumed
 * to be called by cleanup-aware callers and are not flagged.
 *
 * False positives are worse than false negatives — if cleanup can't be
 * statically proven missing, the rule passes.
 */

const noLeakyTestDaemon = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require cleanup registration for daemon-spawning patterns in test files",
    },
    messages: {
      missingCleanup:
        'Daemon spawn via "{{pattern}}" has no cleanup registration. ' +
        "Register cleanup via `onTestFinished(() => killPid(pid))` or " +
        "`onTestFinished(() => process.kill(pid, 'SIGTERM'))` immediately after the spawn returns.",
    },
    schema: [],
  },

  create(context) {
    // Track whether we've seen afterEach with cleanup in the current describe scope
    const describeStack = [];
    let hasTopLevelAfterEachCleanup = false;

    /**
     * Check if a node is inside a function passed to afterEach or beforeEach.
     */
    function isInLifecycleHook(node, hookName) {
      let current = node.parent;
      while (current) {
        if (
          current.type === "CallExpression" &&
          current.callee.type === "Identifier" &&
          current.callee.name === hookName
        ) {
          return true;
        }
        current = current.parent;
      }
      return false;
    }

    /**
     * Check if a node is inside a named function declaration or named
     * function expression (a helper function). Spawns in helpers are not
     * flagged because the caller is expected to manage cleanup.
     *
     * Does not count arrow functions or anonymous functions passed directly
     * to it()/test()/beforeEach() — those ARE test bodies.
     */
    function isInHelperFunction(node) {
      let current = node.parent;
      while (current) {
        // Named function declaration: function startDaemon() { ... }
        if (current.type === "FunctionDeclaration" && current.id) {
          return true;
        }
        // Named function expression in a variable: const startDaemon = function() { ... }
        // or const startDaemon = async function() { ... }
        if (
          current.type === "VariableDeclarator" &&
          current.id &&
          current.id.type === "Identifier" &&
          current.init &&
          (current.init.type === "FunctionExpression" ||
            current.init.type === "ArrowFunctionExpression")
        ) {
          return true;
        }
        // Stop climbing at test framework boundaries — if we hit an it/test/describe
        // callback, the spawn is in a test body, not a helper
        if (
          current.type === "CallExpression" &&
          current.callee.type === "Identifier" &&
          (current.callee.name === "it" ||
            current.callee.name === "test" ||
            current.callee.name === "describe" ||
            current.callee.name === "beforeEach" ||
            current.callee.name === "afterEach" ||
            current.callee.name === "beforeAll" ||
            current.callee.name === "afterAll")
        ) {
          return false;
        }
        current = current.parent;
      }
      return false;
    }

    /**
     * Check if source text contains daemon-specific cleanup patterns.
     *
     * Only matches patterns that are unambiguously daemon cleanup:
     * - process.kill() — sends a signal to a PID (daemon cleanup)
     * - .kill("SIG...") — child process signal (e.g., child.kill("SIGTERM"))
     * - SIGTERM/SIGKILL/SIGINT signal names (only used for process signals)
     * - killPid helper (project-specific daemon kill utility)
     * - stopDaemon/stopMockDaemon helpers (explicit daemon stop functions)
     * - "serve stop" CLI command pattern
     *
     * Generic "kill" or "stop" alone do NOT qualify — they could be
     * stopping unrelated fixtures (e.g., stopUnrelatedFixture()).
     */
    function hasDaemonCleanupPattern(text) {
      return (
        text.includes("process.kill") ||
        /\.kill\(\s*["']SIG/.test(text) ||
        text.includes("SIGTERM") ||
        text.includes("SIGKILL") ||
        text.includes("SIGINT") ||
        text.includes("killPid") ||
        text.includes("stopDaemon") ||
        text.includes("stopMockDaemon") ||
        text.includes("serve stop")
      );
    }

    /**
     * Check if a CallExpression is afterEach(...) and its callback body
     * contains daemon-specific cleanup.
     */
    function isAfterEachWithCleanup(node) {
      if (node.type !== "CallExpression") return false;
      if (
        node.callee.type !== "Identifier" ||
        node.callee.name !== "afterEach"
      ) {
        return false;
      }
      const text = context.sourceCode.getText(node);
      return hasDaemonCleanupPattern(text);
    }

    /**
     * Check whether a node has cleanup registered in the statements
     * that follow it within the same block/function body, BEFORE any
     * await expression or assertion (expect call).
     *
     * The task requires cleanup to be registered before the next
     * expect, await, or scope exit — so cleanup after an await or
     * assertion is too late (the test could fail before reaching it).
     */
    function hasCleanupAfter(node) {
      const body = findContainingBody(node);
      if (!body) return false;

      const nodeIndex = findNodeIndex(body, node);
      if (nodeIndex === -1) return false;

      for (let i = nodeIndex + 1; i < body.length; i++) {
        // Cleanup found before any await/expect — safe
        if (statementContainsCleanup(body[i])) {
          return true;
        }
        // If this statement contains an await or expect, cleanup
        // registered after it is too late — the test can fail here
        if (statementContainsAwaitOrExpect(body[i])) {
          return false;
        }
      }

      return false;
    }

    /**
     * Check if a node is inside a try block that has a finally with
     * daemon-specific cleanup. Uses the same daemon-specific pattern
     * matching as afterEach to avoid false negatives from generic
     * "kill"/"stop" substrings matching unrelated teardown helpers.
     */
    function isInTryWithFinallyCleanup(node) {
      let current = node.parent;
      while (current) {
        if (current.type === "TryStatement" && current.finalizer) {
          const text = context.sourceCode.getText(current.finalizer);
          if (hasDaemonCleanupPattern(text)) {
            return true;
          }
        }
        current = current.parent;
      }
      return false;
    }

    /**
     * Find the body (array of statements) containing this node.
     */
    function findContainingBody(node) {
      let current = node.parent;
      while (current) {
        if (current.type === "BlockStatement" && current.body) {
          return current.body;
        }
        if (current.type === "Program" && current.body) {
          return current.body;
        }
        current = current.parent;
      }
      return null;
    }

    /**
     * Find the index of the statement containing the given node.
     */
    function findNodeIndex(body, targetNode) {
      for (let i = 0; i < body.length; i++) {
        if (containsNode(body[i], targetNode)) {
          return i;
        }
      }
      return -1;
    }

    /**
     * Check if parent contains the target node (by position).
     */
    function containsNode(parent, target) {
      if (parent === target) return true;
      if (!parent.range || !target.range) {
        if (parent.start !== undefined && target.start !== undefined) {
          return parent.start <= target.start && parent.end >= target.end;
        }
        return false;
      }
      return (
        parent.range[0] <= target.range[0] &&
        parent.range[1] >= target.range[1]
      );
    }

    /**
     * Check if a statement contains an onTestFinished or cleanup call.
     */
    function statementContainsCleanup(stmt) {
      const text = context.sourceCode.getText(stmt);
      return (
        text.includes("onTestFinished") ||
        text.includes("killPid") ||
        (text.includes("process.kill") && text.includes("SIGTERM"))
      );
    }

    /**
     * Check if a statement contains an await expression or expect() call.
     * These represent points where the test can fail or pause, so cleanup
     * must be registered before them.
     */
    function statementContainsAwaitOrExpect(stmt) {
      const text = context.sourceCode.getText(stmt);
      return text.includes("await ") || text.includes("expect(");
    }

    /**
     * Check if any describe ancestor has an afterEach with cleanup.
     */
    function hasAncestorAfterEachCleanup() {
      return (
        hasTopLevelAfterEachCleanup ||
        describeStack.some((d) => d.hasAfterEachCleanup)
      );
    }

    /**
     * Check if a string contains the serve-start-detach pattern.
     */
    function isServeStartDetach(value) {
      return (
        typeof value === "string" &&
        value.includes("serve start") &&
        value.includes("--detach")
      );
    }

    /**
     * Check if a node is a spawn-like call targeting the daemon entry.
     */
    function isDaemonSpawnCall(node) {
      if (node.type !== "CallExpression") return false;
      const callee = node.callee;

      const isSpawnCall =
        (callee.type === "Identifier" &&
          (callee.name === "spawn" || callee.name === "spawnSync")) ||
        (callee.type === "MemberExpression" &&
          callee.property.type === "Identifier" &&
          (callee.property.name === "spawn" ||
            callee.property.name === "spawnSync"));

      if (!isSpawnCall) return false;

      for (const arg of node.arguments) {
        const text = context.sourceCode.getText(arg);
        if (
          text.includes("DAEMON_ENTRY") ||
          text.includes("dist/daemon/index.js")
        ) {
          return true;
        }
      }
      return false;
    }

    /**
     * Check if a CallExpression passes a string containing the detach pattern.
     */
    function isDetachCallExpression(node) {
      if (node.type !== "CallExpression") return false;

      for (const arg of node.arguments) {
        if (arg.type === "Literal" && isServeStartDetach(arg.value)) {
          return true;
        }
        if (arg.type === "TemplateLiteral") {
          const fullText = arg.quasis.map((q) => q.value.raw).join("");
          if (isServeStartDetach(fullText)) {
            return true;
          }
        }
      }
      return false;
    }

    /**
     * Central check: is this daemon spawn properly covered by cleanup?
     */
    function isDaemonSpawnWithoutCleanup(node, pattern) {
      // Spawns in helper functions are assumed to have cleanup managed by callers
      if (isInHelperFunction(node)) return false;

      // Spawns in afterEach are cleanup themselves
      if (isInLifecycleHook(node, "afterEach")) return false;

      // Check all cleanup escape hatches
      if (hasAncestorAfterEachCleanup()) return false;
      if (hasCleanupAfter(node)) return false;
      if (isInTryWithFinallyCleanup(node)) return false;

      return true;
    }

    return {
      CallExpression(node) {
        // Track describe() scope entry
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "describe" &&
          node.arguments.length >= 2
        ) {
          describeStack.push({ hasAfterEachCleanup: false });
        }

        // Track afterEach with cleanup at any level
        if (isAfterEachWithCleanup(node)) {
          if (describeStack.length > 0) {
            describeStack[describeStack.length - 1].hasAfterEachCleanup = true;
          } else {
            hasTopLevelAfterEachCleanup = true;
          }
          return;
        }

        // Detect: calls with "serve start --detach" pattern
        if (isDetachCallExpression(node)) {
          if (isDaemonSpawnWithoutCleanup(node, "serve start --detach")) {
            context.report({
              node,
              messageId: "missingCleanup",
              data: { pattern: "serve start --detach" },
            });
          }
          return;
        }

        // Detect: spawn()/spawnSync() targeting daemon entry
        if (isDaemonSpawnCall(node)) {
          if (isDaemonSpawnWithoutCleanup(node, "spawn(DAEMON_ENTRY, ...)")) {
            context.report({
              node,
              messageId: "missingCleanup",
              data: { pattern: "spawn(DAEMON_ENTRY, ...)" },
            });
          }
        }
      },

      "CallExpression:exit"(node) {
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "describe" &&
          node.arguments.length >= 2
        ) {
          describeStack.pop();
        }
      },
    };
  },
};

const plugin = {
  meta: { name: "no-leaky-test-daemon" },
  rules: {
    "no-leaky-test-daemon": noLeakyTestDaemon,
  },
};

export default plugin;
