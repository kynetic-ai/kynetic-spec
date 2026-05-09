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
 *      - spawn / spawnSync / execFile / execFileSync / fork targeting
 *        `dist/daemon/index.js` or the DAEMON_ENTRY identifier (either as
 *        the executable arg or inside the argv array). For the runtime
 *        form (executable + argv), args[0] must be a recognised JS
 *        runtime: `node` / `bun` (bare or path-suffixed) or the
 *        `process.execPath` MemberExpression in either dot
 *        (`process.execPath`) or static-bracket (`process["execPath"]`,
 *        `process[\`execPath\`]`) form — anything else is treated as an
 *        unrelated subprocess that consumes the daemon path as data.
 *      - exec / execSync shell strings whose first token is the daemon
 *        entry path (direct-executable form) or whose first token is a
 *        recognised JS runtime (`node` / `bun`, bare or path-suffixed)
 *        followed by the daemon entry as the first script-path-position
 *        token after the runtime (runtime form, e.g.
 *        `exec("node dist/daemon/index.js --port 0")`,
 *        `exec("node --enable-source-maps dist/daemon/index.js --port
 *        0")`, or `exec("node --require ./preload.js dist/daemon/
 *        index.js")`). The walker skips standalone flag tokens
 *        (`--enable-source-maps`, `--inspect`), value-consuming option
 *        flags AND their separately-passed values (`--require ./pre.js`,
 *        `-r ./pre.js`, `--conditions production`), and the `--`
 *        separator. Eval-mode flags (`-e`, `--eval`, `-p`, `--print` and
 *        their `--eval=...` / `--print=...` forms) abort detection
 *        because the runtime evaluates inline source instead of executing
 *        a script file. A shell string that merely passes the daemon path
 *        as an argument to an unrelated command (`echo`, `cat`, `grep`)
 *        is NOT a daemon launch and is not reported.
 *      - Hardcoded `bun` runtime variants (`spawn("bun", [DAEMON_ENTRY])`
 *        or `exec("bun dist/daemon/index.js")`) are reported with a more
 *        specific message because runtime selection belongs to the shared
 *        fixture.
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
     * True when an argument node is the daemon entry path — the shared
     * `DAEMON_ENTRY` identifier, a string literal that names
     * `dist/daemon/index.js` (optionally inside a longer absolute path),
     * or a no-substitution template literal (e.g.
     * `` spawn(`dist/daemon/index.js`, …) ``,
     * `` execFile("node", [`dist/daemon/index.js`, …]) ``) whose raw text
     * resolves to the same daemon entry path. The template-literal form
     * resolves to the same string value at runtime, so it must classify
     * the same way as the plain literal — silently accepting it would
     * leave a documented daemon launch out of the guardrail and violate
     * @daemon-test-guardrail-precision
     * ac-direct-daemon-entry-invocations-flagged.
     */
    function isDaemonEntryArg(arg) {
      if (!arg) return false;
      if (arg.type === "Identifier" && arg.name === DAEMON_ENTRY_IDENTIFIER) {
        return true;
      }
      const literal = literalString(arg);
      if (literal !== null) {
        return literal === DAEMON_ENTRY_LITERAL || literal.endsWith("/" + DAEMON_ENTRY_LITERAL);
      }
      const tmpl = templateLiteralRaw(arg);
      if (tmpl !== null) {
        // Only no-substitution templates resolve statically — an
        // interpolated `${…}` placeholder appears in the raw text as the
        // literal `${...}` token and disqualifies the equality / suffix
        // check, mirroring the literal branch's strictness.
        return tmpl === DAEMON_ENTRY_LITERAL || tmpl.endsWith("/" + DAEMON_ENTRY_LITERAL);
      }
      return false;
    }

    /**
     * Resolve a child-process argv ArrayExpression element to a string when
     * the element is statically a string Literal or a TemplateLiteral
     * (raw text with `${...}` placeholders preserved). Returns null for
     * Identifier elements (e.g. `flag`, `DAEMON_ENTRY`), SpreadElement,
     * and any other expression shape the rule cannot statically read.
     *
     * Used by the spawn-like argv-array script-position walk to classify
     * each element by token shape (no-script flag / value-consuming flag /
     * standalone flag / script position). Opaque elements that don't
     * resolve to a string are treated as the script position by the
     * walker — this is conservative because the script slot then fails
     * the daemon-entry check unless the element itself is the DAEMON_ENTRY
     * identifier or a daemon-entry literal/template (handled by
     * `isDaemonEntryArg`).
     */
    function argvElementToString(el) {
      if (!el) return null;
      const literal = literalString(el);
      if (literal !== null) return literal;
      const tmpl = templateLiteralRaw(el);
      if (tmpl !== null) return tmpl;
      return null;
    }

    /**
     * Walk the elements of a spawn/spawnSync/execFile/execFileSync argv
     * ArrayExpression and return the index of the first element in the
     * runtime's "script-position" — i.e. the element the runtime would
     * treat as the script path to execute. Mirrors the
     * `exec`/`execSync` shell-string walker so that
     * `spawn("node", ["--require", "./pre.js", DAEMON_ENTRY, "--port", "0"])`
     * classifies the same as
     * `exec("node --require ./pre.js dist/daemon/index.js --port 0")`.
     *
     * Three classes of preceding elements are modelled:
     *
     *   1. No-script flags (`-e`, `--eval`, `-p`, `--print`,
     *      `--eval=...`, `--print=...`, `-v`, `--version`, `-h`,
     *      `--help`) → return -1 to abort. The runtime evaluates inline
     *      source, prints info, or exits without launching any script,
     *      so a daemon-entry token after them is not a daemon launch.
     *      Without modelling these, the argv-array branch was reporting
     *      `spawn("node", ["--eval", DAEMON_ENTRY])` and
     *      `execFile("node", ["--version", DAEMON_ENTRY])` as direct
     *      daemon launches (the false-positive blocker from review
     *      cycle 9).
     *   2. Value-consuming option flags (`--require ./pre.js`,
     *      `-r ./pre.js`, `--conditions production`, `--input-type
     *      module`, etc., with whitespace-separated value) → skip the
     *      flag AND the next element, then continue. Without this, the
     *      walker would mistake the option's value (e.g. `./pre.js`)
     *      for the script and silently accept real launches like
     *      `spawn("node", ["--require", "./pre.js", DAEMON_ENTRY])`.
     *   3. Standalone flag tokens (anything else starting with `-`,
     *      including `--enable-source-maps`, `--inspect`,
     *      `--inspect-brk=...`, the `--` argument separator, and the
     *      bundled `--require=./pre.js` form) → skip the element and
     *      continue.
     *
     * The first element that does NOT match a flag class is the script
     * position. Opaque elements (identifiers, spreads, computed
     * expressions whose static value the rule cannot read) also become
     * the script position — the walker then defers to
     * `isDaemonEntryArg` to decide whether that opaque element is the
     * daemon entry. This conservative treatment prefers a missed launch
     * (false negative) over a false-positive on a non-daemon argv that
     * happens to follow a flag.
     */
    function findScriptPositionInArgvArray(arrayArg) {
      if (!arrayArg || arrayArg.type !== "ArrayExpression") return -1;
      const elements = arrayArg.elements;
      for (let i = 0; i < elements.length; i += 1) {
        const el = elements[i];
        if (!el) continue;
        const tokenStr = argvElementToString(el);
        if (tokenStr !== null) {
          if (isShellRuntimeNoScriptFlag(tokenStr)) return -1;
          if (isShellRuntimeFlagConsumingValue(tokenStr)) {
            // Consume the flag's value; if there is no next element the
            // walk simply ends.
            i += 1;
            continue;
          }
          if (isShellRuntimeFlagToken(tokenStr)) continue;
        }
        return i;
      }
      return -1;
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
     * True when a node statically resolves to the `process.execPath`
     * MemberExpression. `process.execPath` is the Node.js absolute path
     * to the currently-running interpreter, so passing it as the
     * executable argument to a child-process call launches Node —
     * equivalent to `spawn("node", [...])`. Two shapes are recognised:
     *
     *   - Dot access: `process.execPath` — non-computed, with both
     *     segments as bare identifiers.
     *   - Bracket access with a static string: `process["execPath"]` /
     *     `process[\`execPath\`]` — computed, with a string Literal or a
     *     no-substitution TemplateLiteral whose value is `"execPath"`.
     *     The two surface syntaxes resolve to the same property at
     *     runtime, so they must classify the same way.
     *
     * Other shapes are NOT recognised — keeping the predicate strict
     * avoids false positives on objects that merely share the property
     * name:
     *
     *   - Unrelated `.execPath` properties (`customRuntime.execPath`,
     *     `process.foo.execPath`).
     *   - Other `process` properties (`process.argv0`, `process.cwd`,
     *     `process.execArgv`).
     *   - Computed accesses whose property is a non-string-literal
     *     expression (`process[propName]`, `process[isFast ? "execPath"
     *     : "argv0"]`) — those are not statically resolvable to
     *     `execPath`.
     *   - Aliased bindings (`const node = process.execPath; spawn(node,
     *     …)`).
     */
    function isProcessExecPathExpression(node) {
      if (!node) return false;
      if (node.type !== "MemberExpression") return false;
      if (!node.object || node.object.type !== "Identifier") return false;
      if (node.object.name !== "process") return false;
      if (!node.property) return false;
      if (!node.computed) {
        if (node.property.type !== "Identifier") return false;
        return node.property.name === "execPath";
      }
      // Computed access: only accept a static string Literal or a
      // no-substitution TemplateLiteral whose resolved value is exactly
      // "execPath". Dynamic property expressions are rejected.
      if (
        node.property.type === "Literal" &&
        typeof node.property.value === "string"
      ) {
        return node.property.value === "execPath";
      }
      if (
        node.property.type === "TemplateLiteral" &&
        node.property.expressions.length === 0 &&
        node.property.quasis.length === 1
      ) {
        return node.property.quasis[0].value.cooked === "execPath";
      }
      return false;
    }

    /**
     * True when an argument node statically resolves to a recognised JS
     * runtime executable that takes a script-path argument (`node` or
     * `bun`). Accepts the bare command (`"node"`, `"bun"`), a path form
     * whose final segment is the runtime (`"/usr/bin/node"`,
     * `"./node_modules/.bin/bun"`), or the `process.execPath` MemberExpression
     * (the absolute path to the currently-running Node interpreter).
     * Tokens that merely contain the runtime name as a substring (e.g.
     * `"nodemon"`, `"bunyan"`) are rejected.
     *
     * Used to gate the spawn-like runtime form: only when args[0] is a
     * recognised runtime do we treat a daemon-entry argv element as a
     * daemon launch. Without this guard, `spawn("cat", [DAEMON_ENTRY])` or
     * `execFile("grep", [DAEMON_ENTRY, "src/"])` — where the daemon path
     * is an argument to an unrelated subprocess — would be incorrectly
     * reported as a daemon launch (false positive that violates
     * `@daemon-test-guardrail-precision`
     * `ac-unrelated-subprocesses-not-reported`).
     *
     * The `process.execPath` form is recognised because it is a definite
     * Node runtime expression — tests that write
     * `spawn(process.execPath, [DAEMON_ENTRY, "--port", "0"])` launch the
     * compiled daemon entrypoint just as `spawn("node", [DAEMON_ENTRY,
     * ...])` does, and must satisfy
     * `ac-direct-daemon-entry-invocations-flagged`.
     */
    function isRecognisedRuntimeArg(arg) {
      if (!arg) return false;
      if (isProcessExecPathExpression(arg)) return true;
      const literal = literalString(arg);
      if (literal !== null) {
        return isRecognisedShellRuntimeToken(literal);
      }
      const tmpl = templateLiteralRaw(arg);
      if (tmpl !== null) {
        return isRecognisedShellRuntimeToken(tmpl);
      }
      return false;
    }

    /**
     * Strip a single matched pair of leading + trailing single OR double
     * quotes from a shell-command token. The Bourne-shell (and POSIX-sh)
     * convention is that quoted tokens like `'dist/daemon/index.js'` and
     * `"node"` resolve to the inner string when the shell executes the
     * command, so static analysis must treat them the same as the bare
     * forms when classifying script-path or executable positions.
     *
     * Only a fully-matched outer quote pair is stripped — `'foo` (just a
     * leading quote) and `script's` (an apostrophe in the middle of a
     * token) are returned unchanged. Mixed pairs (`"foo'`) are also not
     * stripped because they would not parse as a single shell token in
     * the first place.
     *
     * Without this normalisation,
     * `exec("'dist/daemon/index.js' --port 0")` and
     * `exec("node 'dist/daemon/index.js' --port 0")` are silently
     * accepted (false negatives that violate
     * @daemon-test-guardrail-precision
     * ac-direct-daemon-entry-invocations-flagged).
     */
    function stripShellQuotes(token) {
      if (typeof token !== "string" || token.length < 2) return token;
      const first = token[0];
      const last = token[token.length - 1];
      if ((first === "'" || first === '"') && first === last) {
        return token.slice(1, -1);
      }
      return token;
    }

    /**
     * True when the leading whitespace-separated token of a shell command
     * string is the kspec CLI (bare `kspec` or a path ending in `/kspec`).
     * The leading token is normalised through `stripShellQuotes` so that
     * `exec("'kspec' serve start --detach")` classifies the same as the
     * bare form.
     */
    function shellCommandLeadsWithKspec(text) {
      if (typeof text !== "string") return false;
      const trimmed = text.trim();
      if (trimmed.length === 0) return false;
      const firstToken = stripShellQuotes(trimmed.split(/\s+/)[0]);
      if (!firstToken) return false;
      return firstToken === "kspec" || firstToken.endsWith("/kspec");
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
     * True when a shell-command token names the daemon entry path. Accepts
     * the bare literal `dist/daemon/index.js` as well as path forms whose
     * trailing segment is the daemon entry (e.g. an absolute path under a
     * project root). Tokens that merely contain the literal as a substring
     * (e.g. `dist/daemon/index.json`) are rejected — only an exact match or
     * a `/<literal>` suffix counts.
     */
    function isDaemonEntryShellToken(token) {
      if (typeof token !== "string") return false;
      return (
        token === DAEMON_ENTRY_LITERAL ||
        token.endsWith("/" + DAEMON_ENTRY_LITERAL)
      );
    }

    /**
     * True when a shell-command token names a recognised JS runtime
     * executable that takes a script-path argument (`node` or `bun`).
     * Accepts the bare command (`node`, `bun`) or a path form whose final
     * segment is the runtime (e.g. `/usr/bin/node`, `./node_modules/.bin/bun`).
     * Tokens that merely contain the runtime name as a substring (e.g.
     * `nodemon`, `bunyan`) are rejected — only an exact match or a
     * `/<runtime>` suffix counts.
     */
    function isRecognisedShellRuntimeToken(token) {
      if (typeof token !== "string") return false;
      return (
        token === "node" ||
        token === "bun" ||
        token.endsWith("/node") ||
        token.endsWith("/bun")
      );
    }

    /**
     * True when a shell-command token is shaped like a runtime option flag
     * — a token whose first character is `-`. Covers long flags
     * (`--enable-source-maps`, `--inspect`, `--inspect-brk=0.0.0.0:9229`),
     * short flags (`-r`), and the `--` argument separator. Used by the
     * shell-string walk to recognise tokens that are not the script path.
     */
    function isShellRuntimeFlagToken(token) {
      return typeof token === "string" && token.length > 0 && token[0] === "-";
    }

    /**
     * True when a shell-command flag token is the bare form of a Node/Bun
     * runtime option that consumes the NEXT token as its value (separated
     * by whitespace, not bundled with `=`). Examples: `--require ./pre.js`,
     * `-r ./pre.js`, `--conditions production`, `--input-type module`.
     *
     * When the walk sees one of these, it must skip BOTH the flag token
     * and the next token before continuing to look for the script path —
     * otherwise the value (e.g. `./pre.js`) is mistaken for the script and
     * a real daemon launch like `node --require ./pre.js dist/daemon/index.js`
     * is silently accepted (the false-negative blocker from review cycle 7).
     *
     * The `=` form (`--require=./pre.js`) bundles the value into the flag
     * token, so the standard one-token flag walk handles it correctly and
     * those forms are not modelled here. Short-flag forms (`-r`) only
     * accept whitespace separation, so `-r=value` is not a recognised Node
     * syntax and is not modelled either.
     *
     * The set is curated to Node and Bun options whose value-consuming
     * semantics could shift which token is the script path. Inclusion
     * requires that the option both (a) appears in the runtime's documented
     * CLI options, and (b) accepts a value via whitespace separation
     * (`--flag value`), not just the bundled `=` form. Standalone boolean
     * flags MUST NOT be listed here — modelling them as value-consuming
     * causes the walker to skip a real script path token, silently
     * accepting daemon launches like `node --use-openssl-ca dist/daemon/
     * index.js` (the false-negative blocker from review cycle 8).
     *
     * Common standalone-flag mistakes to avoid: `--use-openssl-ca`,
     * `--use-bundled-ca`, `--use-system-ca`, `--use-env-proxy`,
     * `--tls-min-v1.0`/v1.1/v1.2/v1.3, `--tls-max-v1.2`/v1.3,
     * `--enable-fips`, `--force-fips`, `--openssl-legacy-provider`,
     * `--openssl-shared-config` — all standalone in the runtime, none
     * value-consuming. `--stack-trace-limit` is the special case of an
     * option that works only in the `=` form (`--stack-trace-limit=N`);
     * the bare-then-value form errors out, so it is NOT value-consuming
     * by whitespace and must not be listed.
     *
     * New runtime options added by future Node/Bun versions are not
     * modelled — false negatives in the new-flag direction are recoverable
     * (the rule continues to flag the runtime form via other test
     * variants), but a false positive on a value would over-broaden the
     * rule. Be conservative.
     */
    function isShellRuntimeFlagConsumingValue(token) {
      if (typeof token !== "string") return false;
      switch (token) {
        case "-r":
        case "--require":
        case "-C":
        case "--conditions":
        case "--input-type":
        case "--cpu-prof-dir":
        case "--cpu-prof-interval":
        case "--cpu-prof-name":
        case "--heap-prof-dir":
        case "--heap-prof-interval":
        case "--heap-prof-name":
        case "--diagnostic-dir":
        case "--report-dir":
        case "--report-directory":
        case "--report-filename":
        case "--report-signal":
        case "--snapshot-blob":
        case "--openssl-config":
        case "--max-http-header-size":
        case "--title":
        case "--unhandled-rejections":
        case "--tls-cipher-list":
        case "--tls-keylog":
        case "--redirect-warnings":
        case "--experimental-loader":
        case "--loader":
        case "--inspect-publish-uid":
          return true;
        case "--preload":
        case "--config":
          // Bun: `--preload <module>`, `--config <path>` consume the next token.
          return true;
        default:
          return false;
      }
    }

    /**
     * True when a runtime option flag causes the JS runtime to NOT execute
     * a script file — anything appearing after such a flag is either ignored
     * by the runtime, consumed as inline source, or forwarded as argv to
     * already-evaluated code. The shell-string walker and the spawn-like
     * argv-array walker both use this predicate to abort at the flag and
     * report no daemon launch, even when a daemon-entry-shaped token follows.
     *
     * Two classes are recognised:
     *
     *   1. Eval-mode flags: `-e` / `--eval` / `-p` / `--print` and the
     *      bundled `--eval=...` / `--print=...` forms. The runtime
     *      evaluates a JS source string instead of executing a script
     *      file. A `dist/daemon/index.js` token after them is either the
     *      eval source string (passing the path text to JS as code) or
     *      an argv forwarded to the eval'd code via process.argv, never
     *      a script the runtime launches. (Closed the false-positive half
     *      of review cycle 7.)
     *
     *   2. Info-exit flags: `-v` / `--version` / `-h` / `--help`. The
     *      runtime prints the requested info and exits with code 0
     *      without executing any script. A daemon-entry token after them
     *      is silently ignored by the runtime (Node's `--version` does
     *      not even read its trailing argv positionally), so reporting
     *      such a call as a direct daemon launch is a false positive.
     *      (Closed the spawn/execFile argv-array half of review cycle 9
     *      — the reviewer's probe was
     *      `execFile("node", ["--version", DAEMON_ENTRY])`.)
     *
     * Other no-script-but-script-shaped flags (`--check` / `-c`,
     * `--syntax-check`) are intentionally NOT modelled here — they
     * accept a script positional but only parse it, which still requires
     * the script path token. False positives on the parse-only forms are
     * recoverable by the shared-fixture exception or a localized
     * disable, so adding them would just trade one form of imprecision
     * for another. Keep this set conservative; only add new entries when
     * a documented runtime option both (a) appears in current Node/Bun
     * CLI docs and (b) prevents script execution outright.
     */
    function isShellRuntimeNoScriptFlag(token) {
      if (typeof token !== "string") return false;
      return (
        token === "-e" ||
        token === "--eval" ||
        token === "-p" ||
        token === "--print" ||
        token.startsWith("--eval=") ||
        token.startsWith("--print=") ||
        token === "-v" ||
        token === "--version" ||
        token === "-h" ||
        token === "--help"
      );
    }

    /**
     * Tokenise a shell-command argument's text. Returns the
     * whitespace-separated tokens of a string Literal or a TemplateLiteral
     * with `${...}` placeholders preserved (so an interpolated value cannot
     * accidentally satisfy a token check). Each token is normalised via
     * `stripShellQuotes` so quoted forms like `'dist/daemon/index.js'` and
     * `"node"` classify the same as the bare equivalents — without this,
     * `exec("'dist/daemon/index.js' --port 0")` and
     * `exec("node 'dist/daemon/index.js'")` would be silently accepted.
     * Returns null when the argument is not a string-shaped node the rule
     * can read statically.
     */
    function shellCommandTokens(arg) {
      if (!arg) return null;
      const literal = literalString(arg);
      if (literal !== null) {
        return literal.trim().split(/\s+/).filter(Boolean).map(stripShellQuotes);
      }
      const tmpl = templateLiteralRaw(arg);
      if (tmpl !== null) {
        return tmpl.trim().split(/\s+/).filter(Boolean).map(stripShellQuotes);
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
     *     Two daemon-entry shapes are accepted. The runtime form requires
     *     args[0] to be a recognised JS runtime (`node` / `bun`, bare or
     *     path-suffixed, or the `process.execPath` MemberExpression for
     *     the currently-running Node interpreter) and the argv array
     *     (args[1]) to contain the daemon entry in the runtime's script
     *     position. The argv-array script-position walk mirrors the
     *     exec/execSync shell-string walker (see
     *     `findScriptPositionInArgvArray`): standalone flags are skipped,
     *     value-consuming flags (`--require`, `-r`, `--conditions`, …)
     *     skip the flag AND its separately-passed value, no-script flags
     *     (`-e` / `--eval`, `-p` / `--print`, `-v` / `--version`, `-h` /
     *     `--help` and the `--eval=…` / `--print=…` forms) abort the walk
     *     and report no launch. Restricting args[0] to a recognised
     *     runtime stops false positives like `spawn("cat", [DAEMON_ENTRY])`
     *     or `execFile("grep", [DAEMON_ENTRY, "src/"])`; the
     *     script-position walk additionally stops false positives like
     *     `execFile("node", ["--version", DAEMON_ENTRY])` and
     *     `spawn("node", ["--eval", "dist/daemon/index.js"])` where the
     *     runtime is invoked but no script is launched (the false-positive
     *     blocker from review cycle 9).
     *
     *     The direct-executable form passes the daemon entry as the first
     *     arg itself; argv may be omitted or an array of forwarded flags.
     *     The direct-executable form matters because a daemon entry built
     *     with a shebang is directly invokable, and
     *     `execFile(DAEMON_ENTRY, [...])` / `spawn(DAEMON_ENTRY, [...])`
     *     launches the compiled daemon the same as the runtime form.
     *   - `fork`
     *     First arg is the module path. The daemon entry must be that
     *     first arg directly — argv elements are forwarded, not executed.
     *   - `exec` / `execSync`
     *     Shell-string callee. The first argument is tokenised on
     *     whitespace and inspected at the executable position only. The
     *     direct-executable form (`exec("dist/daemon/index.js")`) is
     *     matched when the daemon entry is the FIRST token. The runtime
     *     form (`exec("node dist/daemon/index.js")`) is matched when the
     *     first token is a recognised JS runtime (`node` / `bun`, bare or
     *     path-suffixed) and the daemon entry is the first script-path-
     *     position token after the runtime. The walker between the
     *     runtime token and the script path classifies each intermediate
     *     token by shape:
     *
     *       * Standalone flags (`--enable-source-maps`, `--inspect`,
     *         `--inspect-brk=...`, the `--` separator) are skipped.
     *       * Value-consuming option flags whose value is passed as a
     *         SEPARATE next token (`--require ./pre.js`, `-r ./pre.js`,
     *         `--conditions production`, `--input-type module`, etc.)
     *         consume the flag AND the next token, then the walk
     *         continues. Without this, `exec("node --require ./pre.js
     *         dist/daemon/index.js …")` would be silently accepted
     *         because `./pre.js` would be mistaken for the script path.
     *         The bundled-equals form (`--require=./pre.js`) is one
     *         token that starts with `-` and is handled by the
     *         standalone-flag branch.
     *       * Eval-mode flags (`-e`, `--eval`, `-p`, `--print`, plus
     *         `--eval=...` / `--print=...`) abort the walk and report
     *         no daemon launch — the runtime evaluates inline source,
     *         no script file is executed, and any `dist/daemon/index.js`
     *         token after them is either the eval source string or an
     *         argv forwarded to the eval'd code via process.argv.
     *
     *     The first non-flag, non-flag-value token must be the daemon
     *     entry; if a different path appears in that position
     *     (`node ./other-script.js dist/daemon/index.js`), the runtime
     *     is launching that path, not the daemon, and the call is not
     *     reported. A shell string that passes the daemon path as an
     *     argument to an unrelated command (`echo`, `cat`, `grep …`) is
     *     not a daemon launch and is not reported, because the leading
     *     executable token is not a recognised runtime. When the leading
     *     runtime token is `bun` (or a path ending in `/bun`),
     *     `runtimeLiteral` is set to "bun" so the hardcoded-runtime
     *     message fires for shell-string Bun launches too.
     *
     * The returned `pattern` is a short shape descriptor used in the
     * reported message so authors see exactly which call shape was matched
     * (e.g. `fork(DAEMON_ENTRY, ...)` vs `execFile(node, [DAEMON_ENTRY])`
     * vs `execFile(DAEMON_ENTRY, [...])`). `runtimeLiteral` carries the
     * literal first-arg string so the caller can recognise hardcoded `bun`
     * for the runtime parity message; it is `null` for `fork` (Node is
     * implicit), for the direct-executable form (the daemon entry IS the
     * runtime), and for non-literal first args.
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
        if (isDaemonEntryArg(args[0])) {
          return {
            runtimeLiteral: null,
            calleeName,
            pattern: `${calleeName}(${DAEMON_ENTRY_IDENTIFIER}, ...)`,
          };
        }
        if (args.length < 2) return null;
        // Restrict the runtime form to recognised JS runtimes so that
        // `spawn("cat", [DAEMON_ENTRY])` and `execFile("grep",
        // [DAEMON_ENTRY, "src/"])` — where the daemon path is consumed as
        // an argument to an unrelated subprocess, not executed as a script
        // — are not reported. Mirrors the exec/execSync shell-string
        // branch which requires the leading shell token to be `node` or
        // `bun`.
        if (!isRecognisedRuntimeArg(args[0])) return null;
        // Walk the argv array's elements with the same script-position
        // model as the exec/execSync shell-string walker: skip standalone
        // flags, skip value-consuming flags AND their separately-passed
        // values, abort on no-script flags (eval / version / help). The
        // first element in the script position must be the daemon entry
        // for this to count as a daemon launch — without the walk,
        // `execFile("node", ["--version", DAEMON_ENTRY])` and
        // `spawn("node", ["--eval", "dist/daemon/index.js"])` were
        // silently mis-reported as direct daemon launches even though
        // neither runs the daemon (the false-positive blocker from
        // review cycle 9).
        const arrayArg = args[1];
        if (!arrayArg || arrayArg.type !== "ArrayExpression") return null;
        const scriptIdx = findScriptPositionInArgvArray(arrayArg);
        if (scriptIdx === -1) return null;
        if (!isDaemonEntryArg(arrayArg.elements[scriptIdx])) return null;
        const runtimeLiteral = literalString(args[0]);
        let runtimeDescriptor;
        if (runtimeLiteral !== null) {
          runtimeDescriptor = `"${runtimeLiteral}"`;
        } else if (isProcessExecPathExpression(args[0])) {
          runtimeDescriptor = "process.execPath";
        } else {
          runtimeDescriptor = "<runtime>";
        }
        const pattern = `${calleeName}(${runtimeDescriptor}, [${DAEMON_ENTRY_IDENTIFIER}, ...])`;
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

      if (calleeName === "exec" || calleeName === "execSync") {
        const tokens = shellCommandTokens(args[0]);
        if (tokens === null || tokens.length === 0) return null;
        // Direct-executable form: the daemon entry is the FIRST shell
        // token; it IS the runtime that the OS shell launches. A shebang'd
        // daemon entry is invokable directly, so this is equivalent to
        // `execFile(DAEMON_ENTRY, [...])`.
        if (isDaemonEntryShellToken(tokens[0])) {
          return {
            runtimeLiteral: null,
            calleeName,
            pattern: `${calleeName}("${DAEMON_ENTRY_LITERAL} ...")`,
          };
        }
        // Runtime form: a recognised JS runtime token (`node` or `bun`,
        // bare or path-suffixed) at index 0, with the daemon entry as the
        // first script-path-position token after the runtime. The walk
        // models three classes of runtime tokens between the runtime and
        // the script path:
        //
        //   1. Eval-mode flags (`-e`, `--eval`, `-p`, `--print`, and the
        //      bundled `--eval=...` / `--print=...` forms) put the runtime
        //      into eval mode. No script is executed — anything after is
        //      either the eval source or an argv to the eval'd code, not
        //      a script the runtime is launching. Abort and report no
        //      daemon launch (`exec("node --eval dist/daemon/index.js")`
        //      must NOT be flagged).
        //   2. Value-consuming flags (`--require ./pre.js`, `-r ./pre.js`,
        //      `--conditions production`, etc., with whitespace separation)
        //      take the next token as the option's value, NOT as the
        //      script path. Skip both the flag and the value, then keep
        //      walking — `exec("node --require ./pre.js dist/daemon/
        //      index.js")` is a real daemon launch and must be flagged
        //      (the false-negative half of the review cycle 7 blocker).
        //      The `=` form (`--require=./pre.js`) is a single token
        //      starting with `-` and falls through to the standalone-flag
        //      branch which also skips it.
        //   3. Standalone flags (`--enable-source-maps`, `--inspect`,
        //      `--inspect-brk=...`, the `--` separator). Skip the flag
        //      token and continue.
        //
        // After the walk, the first non-flag, non-flag-value token must be
        // the daemon entry. If a different path appears first
        // (`node script.js dist/daemon/index.js`), `node` is running
        // `script.js`, not the daemon, so the call is not reported.
        // Requiring index 0 to be a recognised runtime keeps the classifier
        // from reporting unrelated subprocesses (`echo dist/daemon/index.js`,
        // `cat /…/dist/daemon/index.js`, `grep -r dist/daemon/index.js
        // src/`) that merely pass the path as an argument.
        if (tokens.length < 2) return null;
        if (!isRecognisedShellRuntimeToken(tokens[0])) return null;
        let scriptIdx = -1;
        for (let i = 1; i < tokens.length; i += 1) {
          if (isShellRuntimeNoScriptFlag(tokens[i])) {
            // Eval-mode or info-exit flag: runtime evaluates inline
            // source, prints info, or exits — no script is launched, so
            // a daemon-entry token after it is not a daemon launch.
            return null;
          }
          if (isShellRuntimeFlagConsumingValue(tokens[i])) {
            // Skip the flag AND its separately-passed value.
            i += 1;
            continue;
          }
          if (isShellRuntimeFlagToken(tokens[i])) continue;
          scriptIdx = i;
          break;
        }
        if (scriptIdx === -1) return null;
        if (!isDaemonEntryShellToken(tokens[scriptIdx])) return null;
        const prev = tokens[0];
        const runtimeLiteral =
          prev === "bun" || prev.endsWith("/bun") ? "bun" : null;
        const flagSegment =
          scriptIdx > 1 ? tokens.slice(1, scriptIdx).join(" ") + " " : "";
        return {
          runtimeLiteral,
          calleeName,
          pattern: `${calleeName}("${prev} ${flagSegment}${DAEMON_ENTRY_LITERAL} ...")`,
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
