/**
 * ESLint-compatible rule for oxlint JS Plugins Alpha.
 *
 * Enforces the daemon test fixture contract for kspec test files. The rule
 * keeps test daemons routed through `tests/helpers/daemon.ts` (the shared
 * fixture) and `tests/helpers/mock-daemon.ts` (the mock helper), surfacing
 * patterns that would silently re-introduce bespoke startup, leaked
 * processes, or hand-rolled daemon URLs.
 *
 * Three families of checks:
 *
 *   1. Direct daemon spawn (always flagged outside helper paths)
 *      - spawn() / spawnSync() targeting `dist/daemon/index.js` or the
 *        DAEMON_ENTRY identifier with arguments resolving to that path.
 *      - Hardcoded `spawn("bun", [DAEMON_ENTRY])` is reported with a
 *        more specific message because runtime selection belongs to the
 *        shared fixture.
 *      - The escape hatch is a path allowlist (helpers, the rule itself,
 *        and the rule's own fixture-string test files) or a local
 *        `oxlint-disable-next-line` with a "-- reason" comment.
 *
 *   2. CLI detached serve startup (flagged when no scoped cleanup)
 *      - `runKspec("serve start --detach …")`, raw `execSync(...)`, or
 *        a `spawn("kspec", [...])` whose argv argument array carries
 *        `"serve"`, `"start"`, and `"--detach"` as separate elements.
 *      - The cleanup escape hatch is preserved here because tests of the
 *        CLI's own detach behavior have to use this path. Cleanup must
 *        be registered before the next `await` or `expect()`.
 *
 *   3. Daemon URL construction from `localhost:<port>` (always flagged
 *      outside helper paths)
 *      - `fetch(...)` and `new WebSocket(...)` first arguments whose
 *        string contains `localhost:` followed by digits or a `${`
 *        port interpolation. Variables initialised from a localhost:port
 *        URL string are tracked so `const url = ...; fetch(url)` is
 *        flagged the same way as the inline form. Tests that use the
 *        shared fixture should read URLs from `daemon.apiUrl` /
 *        `daemon.wsUrl` instead.
 *      - String literals used purely as assertion targets, mock data,
 *        or Origin headers are not flagged because the call is not a
 *        fetch/WebSocket entry point.
 *
 * Path allowlist (rule does not run at all in these locations):
 *   - tests/helpers/                 — shared fixture and mock helpers
 *   - tools/eslint-rules/            — the rule source itself
 *   - tests/lint-no-leaky-test-daemon.test.ts
 *   - tests/lint-daemon-test-guardrails.test.ts
 *
 * False positives are worse than false negatives — when the static checks
 * cannot prove a violation, the rule passes and authors are expected to
 * either use the shared fixture or annotate a localized exception.
 */

const HELPER_PATH_PATTERNS = [
  /[\\/]tests[\\/]helpers[\\/]/,
  /[\\/]tools[\\/]eslint-rules[\\/]/,
  /[\\/]tests[\\/]lint-no-leaky-test-daemon\.test\.ts$/,
  /[\\/]tests[\\/]lint-daemon-test-guardrails\.test\.ts$/,
];

const FETCH_LIKE_CALLEES = new Set(["fetch"]);
const WEBSOCKET_LIKE_CONSTRUCTORS = new Set(["WebSocket"]);

const SPAWN_LIKE_CALLEES = new Set([
  "runKspec",
  "kspec",
  "exec",
  "execSync",
  "spawn",
  "spawnSync",
  "execFile",
  "execFileSync",
  "fork",
]);

const noLeakyTestDaemon = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Daemon test guardrails: route daemon startup, cleanup, and URL " +
        "construction through the shared fixture in tests/helpers/.",
    },
    messages: {
      directDaemonSpawn:
        'Direct daemon spawn via "{{pattern}}" bypasses the shared daemon ' +
        "fixture. Use `startTestDaemon` from tests/helpers/daemon.ts (or the " +
        "mock daemon helper) so the test inherits scoped cleanup, env " +
        "isolation, and resolved endpoints. To intentionally bypass the " +
        "fixture, add `// oxlint-disable-next-line " +
        "no-leaky-test-daemon/no-leaky-test-daemon -- <reason naming the " +
        "behavior under test>` immediately above the offending statement.",
      hardcodedBunRuntime:
        'Hardcoded `spawn("bun", [DAEMON_ENTRY])` outside a runtime parity ' +
        "test. The shared fixture (`startTestDaemon`) defaults to Node and " +
        "accepts an explicit `runtime` opt-in; tests that need Bun coverage " +
        "should opt in there or run inside the parity matrix. Add a local " +
        "oxlint-disable-next-line with a -- reason if Bun is genuinely the " +
        "behavior under test.",
      missingCleanup:
        'Detached daemon start via "{{pattern}}" has no scoped cleanup ' +
        "registration. Read the pid file and register " +
        "`onTestFinished(() => killPid(pid))` (or `process.kill(pid, " +
        "'SIGTERM')`) immediately after the start returns and before the " +
        "next await/expect — otherwise an assertion failure leaves the " +
        "daemon running. Tests that do not need the CLI's --detach path " +
        "should use `startTestDaemon` from tests/helpers/daemon.ts.",
      localhostDaemonUrl:
        "Daemon connection URL constructed from `localhost:<port>` in a " +
        "{{pattern}} call. Read URLs from the fixture endpoint " +
        "(`daemon.apiUrl` / `daemon.wsUrl` returned by `startTestDaemon`) " +
        "so HTTP and WebSocket clients share the resolved endpoint and the " +
        "default 127.0.0.1 host. To intentionally test localhost-as-host " +
        "behavior, add a local oxlint-disable-next-line with a -- reason.",
    },
    schema: [],
  },

  create(context) {
    const filename = context.physicalFilename || context.filename || "";
    if (HELPER_PATH_PATTERNS.some((pattern) => pattern.test(filename))) {
      return {};
    }

    // Track whether we've seen afterEach with cleanup in the current describe
    // scope (for the detached-serve cleanup check).
    const describeStack = [];
    let hasTopLevelAfterEachCleanup = false;

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
     * True when a node is inside a named function declaration or named
     * function expression (a helper function). Direct daemon spawn calls
     * inside helper functions are still flagged — even helpers in the
     * test file itself bypass the shared fixture — but the cleanup-based
     * detached-serve check uses this to avoid flagging spawn calls that
     * the caller is responsible for cleaning up.
     */
    function isInHelperFunction(node) {
      let current = node.parent;
      while (current) {
        if (current.type === "FunctionDeclaration" && current.id) {
          return true;
        }
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
     * Daemon-specific cleanup signals. Generic `kill` or `stop` alone do
     * NOT qualify because they could be stopping unrelated fixtures.
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

    function isAfterEachWithCleanup(node) {
      if (node.type !== "CallExpression") return false;
      if (node.callee.type !== "Identifier" || node.callee.name !== "afterEach") {
        return false;
      }
      const text = context.sourceCode.getText(node);
      return hasDaemonCleanupPattern(text);
    }

    function hasCleanupAfter(node) {
      const body = findContainingBody(node);
      if (!body) return false;

      const nodeIndex = findNodeIndex(body, node);
      if (nodeIndex === -1) return false;

      for (let i = nodeIndex + 1; i < body.length; i++) {
        if (statementContainsCleanup(body[i])) {
          return true;
        }
        if (statementContainsAwaitOrExpect(body[i])) {
          return false;
        }
      }
      return false;
    }

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

    function findNodeIndex(body, targetNode) {
      for (let i = 0; i < body.length; i++) {
        if (containsNode(body[i], targetNode)) {
          return i;
        }
      }
      return -1;
    }

    function containsNode(parent, target) {
      if (parent === target) return true;
      if (!parent.range || !target.range) {
        if (parent.start !== undefined && target.start !== undefined) {
          return parent.start <= target.start && parent.end >= target.end;
        }
        return false;
      }
      return parent.range[0] <= target.range[0] && parent.range[1] >= target.range[1];
    }

    function statementContainsCleanup(stmt) {
      const text = context.sourceCode.getText(stmt);
      return (
        text.includes("onTestFinished") ||
        text.includes("killPid") ||
        (text.includes("process.kill") && text.includes("SIGTERM"))
      );
    }

    function statementContainsAwaitOrExpect(stmt) {
      const text = context.sourceCode.getText(stmt);
      return text.includes("await ") || text.includes("expect(");
    }

    function hasAncestorAfterEachCleanup() {
      return (
        hasTopLevelAfterEachCleanup ||
        describeStack.some((d) => d.hasAfterEachCleanup)
      );
    }

    /**
     * Collect string-shaped contributions from a CallExpression argument.
     * Returns the literal and template-string text plus, for ArrayExpression
     * arguments (the argv form of `spawn("kspec", ["serve", "start", "--detach"])`),
     * the joined element strings. Non-string elements contribute a sentinel
     * (`<expr>`) so a detected interpolation does not falsely glue two
     * adjacent flag fragments together.
     */
    function collectArgStringContributions(arg) {
      const out = [];
      if (!arg) return out;
      if (arg.type === "Literal" && typeof arg.value === "string") {
        out.push(arg.value);
        return out;
      }
      if (arg.type === "TemplateLiteral") {
        const parts = [];
        for (let i = 0; i < arg.quasis.length; i += 1) {
          parts.push(arg.quasis[i].value.raw);
          if (i < arg.expressions.length) {
            parts.push("<expr>");
          }
        }
        out.push(parts.join(""));
        return out;
      }
      if (arg.type === "ArrayExpression") {
        for (const el of arg.elements) {
          if (!el) continue;
          if (el.type === "Literal" && typeof el.value === "string") {
            out.push(el.value);
          } else if (el.type === "TemplateLiteral") {
            const parts = [];
            for (let i = 0; i < el.quasis.length; i += 1) {
              parts.push(el.quasis[i].value.raw);
              if (i < el.expressions.length) {
                parts.push("<expr>");
              }
            }
            out.push(parts.join(""));
          } else {
            out.push("<expr>");
          }
        }
        return out;
      }
      return out;
    }

    /**
     * True when the combined string contributions across a CallExpression's
     * arguments name a detached serve invocation. Matches both the
     * single-string form (`runKspec("serve start --detach …")`) and the
     * argv form (`spawn("kspec", ["serve", "start", "--detach", …])`).
     */
    function argsResolveToDetachedServe(node) {
      let hasServe = false;
      let hasStart = false;
      let hasDetach = false;
      for (const arg of node.arguments) {
        const contributions = collectArgStringContributions(arg);
        for (const text of contributions) {
          if (typeof text !== "string") continue;
          if (text.includes("serve start") && text.includes("--detach")) {
            return true;
          }
          const tokens = text.split(/\s+/).filter(Boolean);
          for (const token of tokens) {
            if (token === "serve") hasServe = true;
            else if (token === "start") hasStart = true;
            else if (token === "--detach") hasDetach = true;
          }
        }
      }
      return hasServe && hasStart && hasDetach;
    }

    /**
     * spawn-like CallExpression whose argument list resolves to a daemon
     * entry path (DAEMON_ENTRY identifier or the literal
     * "dist/daemon/index.js"). The first argument is the runtime binary
     * (returned alongside so the caller can recognise hardcoded "bun").
     */
    function readDaemonSpawn(node) {
      if (node.type !== "CallExpression") return null;
      const callee = node.callee;

      const isSpawnCall =
        (callee.type === "Identifier" &&
          (callee.name === "spawn" || callee.name === "spawnSync")) ||
        (callee.type === "MemberExpression" &&
          callee.property.type === "Identifier" &&
          (callee.property.name === "spawn" || callee.property.name === "spawnSync"));

      if (!isSpawnCall) return null;

      let argsCarryDaemonEntry = false;
      for (const arg of node.arguments) {
        const text = context.sourceCode.getText(arg);
        if (text.includes("DAEMON_ENTRY") || text.includes("dist/daemon/index.js")) {
          argsCarryDaemonEntry = true;
          break;
        }
      }
      if (!argsCarryDaemonEntry) return null;

      const firstArg = node.arguments[0];
      let runtimeLiteral = null;
      if (firstArg && firstArg.type === "Literal" && typeof firstArg.value === "string") {
        runtimeLiteral = firstArg.value;
      }
      return { runtimeLiteral };
    }

    function getCalleeName(node) {
      const callee = node.callee;
      if (callee.type === "Identifier") {
        return callee.name;
      }
      if (callee.type === "MemberExpression" && callee.property.type === "Identifier") {
        return callee.property.name;
      }
      return null;
    }

    /**
     * CLI-side detached daemon start: a spawn-like callee receives arguments
     * that resolve to `serve start … --detach`. Recognises both the single
     * command-string form (`runKspec("serve start --detach …")`) and the
     * argv form (`spawn("kspec", ["serve", "start", "--detach", …])`). Used
     * by the cleanup-aware check.
     */
    function isDetachCallExpression(node) {
      if (node.type !== "CallExpression") return false;

      const calleeName = getCalleeName(node);
      if (!calleeName || !SPAWN_LIKE_CALLEES.has(calleeName)) {
        return false;
      }

      return argsResolveToDetachedServe(node);
    }

    /**
     * Detached-serve check keeps the cleanup escape hatch — these tests
     * exist to exercise the CLI's --detach behavior itself.
     */
    function detachWithoutCleanup(node) {
      if (isInLifecycleHook(node, "afterEach")) return false;
      if (hasAncestorAfterEachCleanup()) return false;
      if (hasCleanupAfter(node)) return false;
      if (isInTryWithFinallyCleanup(node)) return false;
      return true;
    }

    /**
     * Inspect string-shaped arguments for a `localhost:<port>` daemon URL.
     * `localhost` alone (no `:port`) is not flagged because in-process
     * `app.handle(new Request("http://localhost/api/..."))` tests use it.
     */
    function carriesLocalhostPortUrl(node) {
      if (!node) return false;
      if (node.type === "Literal" && typeof node.value === "string") {
        return /\/\/localhost:(\d|\$\{)/.test(node.value);
      }
      if (node.type === "TemplateLiteral") {
        // Reconstruct the raw text including `${…}` placeholders so we
        // can detect `localhost:${…}` interpolation patterns.
        const parts = [];
        for (let i = 0; i < node.quasis.length; i += 1) {
          parts.push(node.quasis[i].value.raw);
          if (i < node.expressions.length) {
            parts.push("${...}");
          }
        }
        const reconstructed = parts.join("");
        return /\/\/localhost:(\d|\$\{)/.test(reconstructed);
      }
      return false;
    }

    /**
     * Identifiers whose declared initializer is a localhost:<port> URL.
     * Tracked so a `const url = `http://localhost:${port}/...`; fetch(url)`
     * pattern is still flagged — passing the URL through a variable does
     * not bypass the guardrail.
     */
    const localhostUrlIdentifiers = new Set();

    function isLocalhostUrlIdentifier(node) {
      return (
        node &&
        node.type === "Identifier" &&
        localhostUrlIdentifiers.has(node.name)
      );
    }

    function firstArgIsLocalhostUrl(node) {
      const firstArg = node.arguments[0];
      if (!firstArg) return false;
      if (carriesLocalhostPortUrl(firstArg)) return true;
      return isLocalhostUrlIdentifier(firstArg);
    }

    function isFetchOfLocalhostUrl(node) {
      if (node.type !== "CallExpression") return false;
      if (node.callee.type !== "Identifier") return false;
      if (!FETCH_LIKE_CALLEES.has(node.callee.name)) return false;
      return firstArgIsLocalhostUrl(node);
    }

    function isWebSocketCtorOfLocalhostUrl(node) {
      if (node.type !== "NewExpression") return false;
      if (node.callee.type !== "Identifier") return false;
      if (!WEBSOCKET_LIKE_CONSTRUCTORS.has(node.callee.name)) return false;
      return firstArgIsLocalhostUrl(node);
    }

    return {
      VariableDeclarator(node) {
        if (
          node.id &&
          node.id.type === "Identifier" &&
          node.init &&
          carriesLocalhostPortUrl(node.init)
        ) {
          localhostUrlIdentifiers.add(node.id.name);
        }
      },

      AssignmentExpression(node) {
        if (
          node.operator === "=" &&
          node.left &&
          node.left.type === "Identifier" &&
          carriesLocalhostPortUrl(node.right)
        ) {
          localhostUrlIdentifiers.add(node.left.name);
        }
      },

      CallExpression(node) {
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "describe" &&
          node.arguments.length >= 2
        ) {
          describeStack.push({ hasAfterEachCleanup: false });
        }

        if (isAfterEachWithCleanup(node)) {
          if (describeStack.length > 0) {
            describeStack[describeStack.length - 1].hasAfterEachCleanup = true;
          } else {
            hasTopLevelAfterEachCleanup = true;
          }
          return;
        }

        // Direct daemon spawn — always flagged outside helper paths,
        // including helper functions inside a non-helper test file.
        const daemonSpawn = readDaemonSpawn(node);
        if (daemonSpawn) {
          if (daemonSpawn.runtimeLiteral === "bun") {
            context.report({
              node,
              messageId: "hardcodedBunRuntime",
            });
          } else {
            context.report({
              node,
              messageId: "directDaemonSpawn",
              data: { pattern: "spawn(DAEMON_ENTRY, ...)" },
            });
          }
          return;
        }

        // Detached serve via the CLI — cleanup escape hatch preserved.
        if (isDetachCallExpression(node)) {
          if (
            !isInHelperFunction(node) &&
            !isInLifecycleHook(node, "afterEach") &&
            detachWithoutCleanup(node)
          ) {
            context.report({
              node,
              messageId: "missingCleanup",
              data: { pattern: "serve start --detach" },
            });
          }
          return;
        }

        // Daemon URL constructed from localhost:<port> in fetch().
        if (isFetchOfLocalhostUrl(node)) {
          context.report({
            node,
            messageId: "localhostDaemonUrl",
            data: { pattern: "fetch()" },
          });
        }
      },

      NewExpression(node) {
        if (isWebSocketCtorOfLocalhostUrl(node)) {
          context.report({
            node,
            messageId: "localhostDaemonUrl",
            data: { pattern: "new WebSocket()" },
          });
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

/**
 * Companion rule that prevents the no-leaky-test-daemon escape hatch from
 * being misused. The main rule's escape hatch is `// oxlint-disable-next-line
 * no-leaky-test-daemon/no-leaky-test-daemon -- <reason naming the behavior
 * under test>`. This rule rejects the two ways the escape hatch could
 * silently broaden:
 *
 *   - File- or block-wide `oxlint-disable no-leaky-test-daemon/no-leaky-test-daemon`
 *     directives (the directive must be local to the offending statement).
 *   - Per-line `oxlint-disable-line` / `oxlint-disable-next-line` directives
 *     for our rule with no `-- <reason>` text after the rule name.
 *
 * Because this rule is a separate rule in the same plugin, disabling
 * `no-leaky-test-daemon/no-leaky-test-daemon` (the main rule) does NOT
 * disable this one — the meta-check still fires and reports.
 *
 * False positives are again worse than false negatives: the rule only
 * inspects comments and only fires when a directive textually targets
 * `no-leaky-test-daemon/no-leaky-test-daemon`.
 */
const TARGET_RULE_NAME = "no-leaky-test-daemon/no-leaky-test-daemon";
const META_RULE_NAME = "no-leaky-test-daemon/localized-disable";
const ALL_RULE_DIRECTIVE = /^\s*oxlint-(disable(?:-line|-next-line)?)(?=$|\s)\s*(.*?)\s*$/s;

function findDisableDirective(rawValue) {
  // Block comments may span multiple lines (e.g. /* eslint-disable rule */).
  // Disable directives appear at the start of the comment text only.
  const match = rawValue.match(ALL_RULE_DIRECTIVE);
  if (!match) return null;
  return { directive: match[1], rest: match[2] || "" };
}

function parseDisableBody(rest) {
  // Format: "<rule>[, <rule>...] [-- <reason>]"
  // Supports ESLint-style ` -- ` reason markers and a trailing ` --` with
  // an empty reason (treated as "no reason supplied").
  let ruleList = rest;
  let reason = null;
  const dashSep = rest.match(/(.*?)\s+--\s*(.*)/s);
  if (dashSep) {
    ruleList = dashSep[1].trim();
    reason = dashSep[2].trim();
  }
  const rules = ruleList.length === 0
    ? []
    : ruleList.split(/\s*,\s*/).map((r) => r.trim()).filter(Boolean);
  return { rules, reason };
}

function directiveTargetsTargetRule(rules) {
  // Empty rule list means "all rules" — that disables our main rule too.
  if (rules.length === 0) return true;
  for (const rule of rules) {
    if (rule === TARGET_RULE_NAME) return true;
    // Plugin-name-only forms (e.g., `oxlint-disable-next-line
    // no-leaky-test-daemon`) cover every rule in the plugin.
    if (rule === "no-leaky-test-daemon") return true;
  }
  return false;
}

const localizedDisable = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disables of no-leaky-test-daemon must be local to a single " +
        "statement and include a `-- <reason>` describing the behavior " +
        "under test. File- or block-wide disables are not allowed.",
    },
    messages: {
      missingReason:
        "`oxlint-disable-{{scope}} {{ruleSpec}}` must include a `-- " +
        "<reason>` after the rule name explaining the behavior under " +
        "test (e.g., `-- testing the CLI-launched daemon's health " +
        "endpoint`). Undocumented per-line disables silently bypass the " +
        "daemon test guardrail.",
      fileWideDisable:
        "File- or block-wide `oxlint-disable {{ruleSpec}}` is not " +
        "allowed. Use a per-statement `oxlint-disable-next-line " +
        TARGET_RULE_NAME +
        " -- <reason>` immediately above the offending line so the " +
        "exception stays scoped and documented.",
    },
    schema: [],
  },

  create(context) {
    const filename = context.physicalFilename || context.filename || "";
    if (HELPER_PATH_PATTERNS.some((pattern) => pattern.test(filename))) {
      return {};
    }

    const sourceCode = context.sourceCode;
    if (!sourceCode || typeof sourceCode.getAllComments !== "function") {
      return {};
    }

    function reportComment(comment, messageId, data) {
      const reportTarget = comment.loc
        ? { loc: comment.loc, messageId, data }
        : { node: comment, messageId, data };
      context.report(reportTarget);
    }

    return {
      Program() {
        for (const comment of sourceCode.getAllComments()) {
          const parsed = findDisableDirective(comment.value);
          if (!parsed) continue;
          const { directive, rest } = parsed;
          const body = parseDisableBody(rest);
          if (!directiveTargetsTargetRule(body.rules)) continue;

          const ruleSpec =
            body.rules.length > 0 ? body.rules.join(", ") : TARGET_RULE_NAME;

          if (directive === "disable") {
            reportComment(comment, "fileWideDisable", { ruleSpec });
            continue;
          }
          // disable-line or disable-next-line: must have a non-empty reason.
          if (body.reason === null || body.reason.length === 0) {
            const scope = directive === "disable-line" ? "line" : "next-line";
            reportComment(comment, "missingReason", { scope, ruleSpec });
          }
        }
      },
    };
  },
};

const plugin = {
  meta: { name: "no-leaky-test-daemon" },
  rules: {
    "no-leaky-test-daemon": noLeakyTestDaemon,
    "localized-disable": localizedDisable,
  },
};

export default plugin;
