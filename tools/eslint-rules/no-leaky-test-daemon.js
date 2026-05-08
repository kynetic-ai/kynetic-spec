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
 * Path allowlist (rule does not run at all in these locations). The list is
 * narrow on purpose: only the approved helper implementations and the
 * lint-rule fixture-string test files are exempt. New `tests/helpers/*` files
 * do NOT inherit the allowlist — generic helpers must use the shared
 * fixture or carry a local documented exception just like any other test.
 *   - tests/helpers/daemon.ts        — shared daemon fixture implementation
 *   - tests/helpers/mock-daemon.ts   — mock daemon helper implementation
 *   - tools/eslint-rules/            — the rule source itself
 *   - tests/lint-no-leaky-test-daemon.test.ts
 *   - tests/lint-daemon-test-guardrails.test.ts
 *
 * False positives are worse than false negatives — when the static checks
 * cannot prove a violation, the rule passes and authors are expected to
 * either use the shared fixture or annotate a localized exception.
 */

const HELPER_PATH_PATTERNS = [
  /[\\/]tests[\\/]helpers[\\/]daemon\.ts$/,
  /[\\/]tests[\\/]helpers[\\/]mock-daemon\.ts$/,
  /[\\/]tools[\\/]eslint-rules[\\/]/,
  /[\\/]tests[\\/]lint-no-leaky-test-daemon\.test\.ts$/,
  /[\\/]tests[\\/]lint-daemon-test-guardrails\.test\.ts$/,
];

const FETCH_LIKE_CALLEES = new Set(["fetch"]);
const WEBSOCKET_LIKE_CONSTRUCTORS = new Set(["WebSocket"]);

const DAEMON_ENTRY_LITERAL = "dist/daemon/index.js";
const DAEMON_ENTRY_IDENTIFIER = "DAEMON_ENTRY";
const KSPEC_EXECUTABLE_PATTERN = /(^|\/)kspec$/;

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
        'Direct daemon entry launch via "{{pattern}}" bypasses the shared ' +
        "daemon fixture. Use `startTestDaemon` from tests/helpers/daemon.ts " +
        "(or the mock daemon helper) so the test inherits scoped cleanup, " +
        "env isolation, and resolved endpoints. To intentionally bypass the " +
        "fixture, add `// oxlint-disable-next-line " +
        "no-leaky-test-daemon/no-leaky-test-daemon -- <reason naming the " +
        "behavior under test>` immediately above the offending statement.",
      hardcodedBunRuntime:
        'Hardcoded `bun` runtime in a direct daemon entry launch via ' +
        '"{{pattern}}" outside a runtime parity test. The shared fixture ' +
        "(`startTestDaemon`) defaults to Node and accepts an explicit " +
        "`runtime` opt-in; tests that need Bun coverage should opt in there " +
        "or run inside the parity matrix. Add a local " +
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
     * True when the combined string contributions across the supplied
     * argument list resolve to a detached serve invocation. Matches both the
     * single-string form (`"serve start --detach …"`) and the argv form
     * (`["serve", "start", "--detach", …]`). The caller is responsible for
     * passing only the args that should contribute (e.g. argv array but not
     * the executable for spawn-like callees) so unrelated tokens cannot
     * satisfy the check.
     */
    function argListResolvesToDetachedServe(args) {
      let hasServe = false;
      let hasStart = false;
      let hasDetach = false;
      for (const arg of args) {
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

    function literalString(node) {
      if (!node) return null;
      if (node.type === "Literal" && typeof node.value === "string") {
        return node.value;
      }
      return null;
    }

    function templateLiteralRaw(node) {
      if (!node || node.type !== "TemplateLiteral") return null;
      const parts = [];
      for (let i = 0; i < node.quasis.length; i += 1) {
        parts.push(node.quasis[i].value.raw);
        if (i < node.expressions.length) {
          parts.push("${...}");
        }
      }
      return parts.join("");
    }

    /**
     * True when an argument node is the daemon entry path — either the
     * shared `DAEMON_ENTRY` identifier or a string literal that names
     * `dist/daemon/index.js` (optionally inside a longer absolute path).
     */
    function isDaemonEntryArg(arg) {
      if (!arg) return false;
      if (arg.type === "Identifier" && arg.name === DAEMON_ENTRY_IDENTIFIER) {
        return true;
      }
      const literal = literalString(arg);
      if (literal === null) return false;
      return literal === DAEMON_ENTRY_LITERAL || literal.endsWith("/" + DAEMON_ENTRY_LITERAL);
    }

    function arrayArgContainsDaemonEntry(arrayArg) {
      if (!arrayArg || arrayArg.type !== "ArrayExpression") return false;
      for (const el of arrayArg.elements) {
        if (el && isDaemonEntryArg(el)) return true;
      }
      return false;
    }

    /**
     * True when an argument node names the kspec CLI executable. Accepts
     * the bare `"kspec"` literal as well as path forms whose final segment
     * is `kspec` (e.g. `"./node_modules/.bin/kspec"`,
     * `\`${binDir}/kspec\``). Tokens that merely contain "kspec" as a
     * substring (e.g. `"mockspec"`) are not considered kspec executables.
     */
    function isKspecExecutableArg(arg) {
      if (!arg) return false;
      const literal = literalString(arg);
      if (literal !== null) {
        return literal === "kspec" || KSPEC_EXECUTABLE_PATTERN.test(literal);
      }
      const tmpl = templateLiteralRaw(arg);
      if (tmpl !== null) {
        return tmpl === "kspec" || KSPEC_EXECUTABLE_PATTERN.test(tmpl);
      }
      return false;
    }

    /**
     * True when the leading whitespace-separated token of a shell command
     * string is the kspec CLI (bare `kspec` or a path ending in `/kspec`).
     */
    function shellCommandLeadsWithKspec(text) {
      if (typeof text !== "string") return false;
      const trimmed = text.trim();
      if (trimmed.length === 0) return false;
      const firstToken = trimmed.split(/\s+/)[0];
      if (!firstToken) return false;
      return firstToken === "kspec" || /\/kspec$/.test(firstToken);
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
     * Direct daemon entry launch detection.
     *
     * Returns a descriptor when the call directly launches the compiled
     * daemon entrypoint (`dist/daemon/index.js` / `DAEMON_ENTRY`) through
     * one of the recognised child-process APIs:
     *
     *   - `spawn` / `spawnSync` / `execFile` / `execFileSync`
     *     First arg is the runtime executable; argv must carry the daemon
     *     entry as one of its array elements.
     *   - `fork`
     *     First arg is the module path. The daemon entry must be that
     *     first arg directly — argv elements are forwarded, not executed.
     *
     * The returned `pattern` is a short shape descriptor used in the
     * reported message so authors see exactly which call shape was matched
     * (e.g. `fork(DAEMON_ENTRY, ...)` vs `execFile(node, [DAEMON_ENTRY])`).
     * `runtimeLiteral` carries the literal first-arg string so the caller
     * can recognise hardcoded `bun` for the runtime parity message; it is
     * `null` for `fork` (Node is implicit) and for non-literal first args.
     */
    function readDaemonEntryInvocation(node) {
      if (node.type !== "CallExpression") return null;
      const calleeName = getCalleeName(node);
      const args = node.arguments;
      if (!calleeName || args.length === 0) return null;

      if (
        calleeName === "spawn" ||
        calleeName === "spawnSync" ||
        calleeName === "execFile" ||
        calleeName === "execFileSync"
      ) {
        if (args.length < 2) return null;
        if (!arrayArgContainsDaemonEntry(args[1])) return null;
        const runtimeLiteral = literalString(args[0]);
        const pattern =
          runtimeLiteral !== null
            ? `${calleeName}("${runtimeLiteral}", [${DAEMON_ENTRY_IDENTIFIER}, ...])`
            : `${calleeName}(<runtime>, [${DAEMON_ENTRY_IDENTIFIER}, ...])`;
        return { runtimeLiteral, calleeName, pattern };
      }

      if (calleeName === "fork") {
        if (!isDaemonEntryArg(args[0])) return null;
        return {
          runtimeLiteral: null,
          calleeName,
          pattern: `fork(${DAEMON_ENTRY_IDENTIFIER}, ...)`,
        };
      }

      return null;
    }

    /**
     * CLI-side detached daemon start detection.
     *
     * Returns true when the CallExpression launches the kspec CLI with
     * `serve start --detach` arguments. The check is intentionally
     * dispatched per-callee so that unrelated subprocesses whose argv
     * tokens happen to overlap (e.g. `spawn("echo", ["serve", "start",
     * "--detach"])`) are not reported:
     *
     *   - `runKspec` / `kspec`
     *     Implicit kspec invocation. Every argument contributes to the
     *     detach token scan.
     *   - `exec` / `execSync`
     *     Shell-string callee. The command string must lead with the
     *     kspec executable; the same argument is then scanned for
     *     `serve`/`start`/`--detach` tokens.
     *   - `spawn` / `spawnSync` / `execFile` / `execFileSync`
     *     First arg must be the kspec executable. Only the argv array
     *     (second arg) is scanned for tokens — the executable itself is
     *     excluded so the kspec name is not mis-counted as a token.
     *   - `fork`
     *     Not a kspec lifecycle entry point (fork executes JS modules,
     *     not the kspec CLI bin).
     */
    function isDetachCallExpression(node) {
      if (node.type !== "CallExpression") return false;
      const calleeName = getCalleeName(node);
      if (!calleeName) return false;
      const args = node.arguments;
      if (args.length === 0) return false;

      if (calleeName === "runKspec" || calleeName === "kspec") {
        return argListResolvesToDetachedServe(args);
      }

      if (calleeName === "exec" || calleeName === "execSync") {
        const cmdArg = args[0];
        const literal = literalString(cmdArg);
        const tmpl = literal === null ? templateLiteralRaw(cmdArg) : null;
        const cmdText = literal !== null ? literal : tmpl;
        if (cmdText === null) return false;
        if (!shellCommandLeadsWithKspec(cmdText)) return false;
        return argListResolvesToDetachedServe([cmdArg]);
      }

      if (
        calleeName === "spawn" ||
        calleeName === "spawnSync" ||
        calleeName === "execFile" ||
        calleeName === "execFileSync"
      ) {
        if (!isKspecExecutableArg(args[0])) return false;
        if (args.length < 2) return false;
        return argListResolvesToDetachedServe([args[1]]);
      }

      return false;
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
     * Bindings whose declarator init or assignment RHS is a `localhost:<port>`
     * URL string. Tracked per lexical scope and source position so a
     * `const url = `http://localhost:${port}/...`; fetch(url)` pattern is
     * flagged the same way as the inline form — without leaking across
     * unrelated `it`/`test` blocks that happen to reuse the same identifier
     * name. Walking outward from the use site picks the innermost binding
     * whose source position is before the use; an inner non-localhost
     * declaration shadows an outer localhost one, and a later non-localhost
     * reassignment in the same scope overrides an earlier localhost binding.
     *
     * Map shape: identifier name → array of
     *   { scopeNode, position, isLocalhost }.
     */
    const localhostUrlBindings = new Map();

    function getNodeStart(node) {
      if (!node) return -1;
      if (node.range && Number.isFinite(node.range[0])) return node.range[0];
      if (typeof node.start === "number") return node.start;
      return -1;
    }

    function isScopeNode(node) {
      if (!node) return false;
      switch (node.type) {
        case "BlockStatement":
        case "Program":
        case "FunctionDeclaration":
        case "FunctionExpression":
        case "ArrowFunctionExpression":
        case "StaticBlock":
          return true;
        default:
          return false;
      }
    }

    function getEnclosingScopeNode(node) {
      let current = node.parent;
      while (current) {
        if (isScopeNode(current)) return current;
        current = current.parent;
      }
      return null;
    }

    function paramBindsName(param, name) {
      if (!param) return false;
      if (param.type === "Identifier") return param.name === name;
      if (param.type === "AssignmentPattern") {
        return paramBindsName(param.left, name);
      }
      if (param.type === "RestElement") {
        return paramBindsName(param.argument, name);
      }
      return false;
    }

    function functionScopeShadowsName(scopeNode, name) {
      if (
        scopeNode.type !== "FunctionDeclaration" &&
        scopeNode.type !== "FunctionExpression" &&
        scopeNode.type !== "ArrowFunctionExpression"
      ) {
        return false;
      }
      const params = scopeNode.params || [];
      for (const param of params) {
        if (paramBindsName(param, name)) return true;
      }
      return false;
    }

    function recordBinding(name, anchorNode, isLocalhost) {
      const scopeNode = getEnclosingScopeNode(anchorNode);
      if (!scopeNode) return;
      const position = getNodeStart(anchorNode);
      if (position < 0) return;
      let entries = localhostUrlBindings.get(name);
      if (!entries) {
        entries = [];
        localhostUrlBindings.set(name, entries);
      }
      entries.push({ scopeNode, position, isLocalhost });
    }

    /**
     * Walk lexical scopes outward from `useNode` and return the most recent
     * binding for `name` whose declaration position is before the use. If a
     * function-scope parameter named `name` is encountered first, treat it
     * as a non-localhost binding (parameters cannot be daemon-URL strings
     * the rule has tracked). Returns null when no binding is in scope.
     */
    function findApplicableBinding(name, useNode) {
      const usePos = getNodeStart(useNode);
      if (usePos < 0) return null;
      const entries = localhostUrlBindings.get(name);
      let current = useNode.parent;
      while (current) {
        if (isScopeNode(current)) {
          if (functionScopeShadowsName(current, name)) {
            return { isLocalhost: false, viaParameter: true };
          }
          if (entries) {
            let candidate = null;
            for (const entry of entries) {
              if (entry.scopeNode !== current) continue;
              if (entry.position >= usePos) continue;
              if (!candidate || entry.position > candidate.position) {
                candidate = entry;
              }
            }
            if (candidate) return candidate;
          }
        }
        current = current.parent;
      }
      return null;
    }

    function isLocalhostUrlIdentifier(node, useNode) {
      if (!node || node.type !== "Identifier") return false;
      const binding = findApplicableBinding(node.name, useNode);
      return binding !== null && binding.isLocalhost === true;
    }

    function firstArgIsLocalhostUrl(node) {
      const firstArg = node.arguments[0];
      if (!firstArg) return false;
      if (carriesLocalhostPortUrl(firstArg)) return true;
      return isLocalhostUrlIdentifier(firstArg, firstArg);
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
        if (!node.id || node.id.type !== "Identifier" || !node.init) return;
        recordBinding(node.id.name, node, carriesLocalhostPortUrl(node.init));
      },

      AssignmentExpression(node) {
        if (
          node.operator !== "=" ||
          !node.left ||
          node.left.type !== "Identifier" ||
          !node.right
        ) {
          return;
        }
        recordBinding(node.left.name, node, carriesLocalhostPortUrl(node.right));
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

        // Direct daemon entry launch — always flagged outside helper paths,
        // including helper functions inside a non-helper test file.
        const daemonEntry = readDaemonEntryInvocation(node);
        if (daemonEntry) {
          if (daemonEntry.runtimeLiteral === "bun") {
            context.report({
              node,
              messageId: "hardcodedBunRuntime",
              data: { pattern: daemonEntry.pattern },
            });
          } else {
            context.report({
              node,
              messageId: "directDaemonSpawn",
              data: { pattern: daemonEntry.pattern },
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
