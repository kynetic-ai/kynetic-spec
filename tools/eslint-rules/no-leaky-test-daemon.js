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
 *      - The classifier requires the call to actually reach the kspec
 *        `serve start` lifecycle subcommand: the first two non-flag
 *        positional argv tokens AFTER the `kspec` executable must be
 *        `serve` then `start`, AND `--detach` (or `--detach=…`) must
 *        appear as a flag token. Substring or unordered token-anywhere
 *        matches are NOT sufficient — `kspec search "serve start
 *        --detach"` (whether issued as `exec("kspec search \"serve start
 *        --detach\"")` or `spawn("kspec", ["search", "serve start
 *        --detach"])`) tokenises to argv `["search", "serve start
 *        --detach"]`, whose subcommand is `search`, and is NOT reported.
 *      - Recognised callee shapes:
 *        - `runKspec("serve start --detach …")` /
 *          `kspec("serve start --detach …")` — the helper signature
 *          forwards a single shell-style args string (or, occasionally,
 *          an argv array) directly to the kspec CLI, so per-arg tokens
 *          are gathered with the same quote-aware shell tokeniser used
 *          for `exec`/`execSync`.
 *        - `exec("kspec serve start --detach …")` /
 *          `execSync(...)` — shell-string callee. The first tokenised
 *          token must name the kspec executable (bare `kspec` or a path
 *          ending in `/kspec`); the remaining tokens are then checked
 *          for the `serve start` subcommand path.
 *        - `spawn("kspec", ["serve", "start", "--detach", …])` /
 *          `spawnSync` / `execFile` / `execFileSync` — argv-array
 *          callee. Each argv element is one OS argv slot (no whitespace
 *          re-splitting), and the first two non-flag elements must be
 *          `serve` and `start`.
 *      - The cleanup escape hatch is preserved here because tests of the
 *        CLI's own detach behavior have to use this path. Cleanup must
 *        be an actual CallExpression with a daemon-cleanup shape —
 *        `process.kill(...)`, `<expr>.kill("SIGTERM"|"SIGKILL"|"SIGINT", …)`,
 *        `killPid(...)`, `stopDaemon(...)`, `stopMockDaemon(...)`, or a
 *        kspec-CLI invocation whose args resolve to the `serve stop`
 *        subcommand — and must be registered in the same control flow
 *        before the next `await` or `expect()`. Token-only text like
 *        `console.log("SIGTERM docs")` or
 *        `const cleanupDocs = "killPid should be used later"` is NOT
 *        cleanup: the substrings are data, not a runtime call (the
 *        cycle-2 false-negative blocker on
 *        `@daemon-test-guardrail-precision`
 *        `ac-detached-cleanup-before-observation`). The same AST-based
 *        predicate gates the try/finally finalizer escape hatch, so a
 *        finalizer whose only statement is `console.log("SIGTERM docs")`
 *        is correctly rejected.
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

/**
 * Loopback host+port URL pattern used by the cleanup-timing observation
 * gate (`subtreeContainsAwaitOrExpect`). Matches the common host forms a
 * test would use to talk to a locally-running daemon — `localhost`,
 * `127.0.0.1`, or `[::1]` — followed by an explicit port (digits or a
 * `${...}` template-literal interpolation).
 *
 * Broader than the rule's `localhostDaemonUrl` reporting predicate
 * (`carriesLocalhostPortUrl`), which is intentionally narrow and only
 * names `localhost:` because that is the canonical test-fixture host.
 * The observation gate must additionally recognise `127.0.0.1:` and
 * `[::1]:` because tests legitimately use those (`tests/cli-serve.test
 * .ts`, the cycle-5 reviewer's daemon-fetch probe), and the gate is
 * used only to decide whether a `fetch` / `new WebSocket` between a
 * detached daemon start and a cleanup registration is a daemon
 * observation that the cleanup-timing rule cares about. A bare
 * `fetch("https://example.com/health")` between the two is not a
 * daemon observation and must not be credited (cycle-6 reviewer
 * blocker).
 */
const DAEMON_HOST_PORT_URL_PATTERN =
  /\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d|\$\{)/;

const DAEMON_ENTRY_LITERAL = "dist/daemon/index.js";
const DAEMON_ENTRY_IDENTIFIER = "DAEMON_ENTRY";
const KSPEC_EXECUTABLE_PATTERN = /(^|\/)kspec$/;

/**
 * Daemon-relevant terminating signals — sent to a running daemon, each
 * actually stops the receiving process by default. Used by the cleanup
 * classifier to gate `process.kill(pid, "<signal>")` and
 * `<child-handle>.kill("<signal>")` callee shapes: only these literals
 * (and no signal at all, which defaults to SIGTERM) count as terminating
 * cleanup. Diagnostic / liveness signals (`0`, `SIGUSR1`, `SIGCONT`,
 * `SIGWINCH`, etc.) explicitly DO NOT count — sending them leaves the
 * daemon running, and the cleanup contract requires actual termination.
 */
const TERMINATING_KILL_SIGNALS = new Set(["SIGTERM", "SIGKILL", "SIGINT"]);

/**
 * Identifier-callee names the cleanup classifier recognises as
 * daemon-cleanup helpers. The name alone is necessary but NOT
 * sufficient — see `isTrustedHelperByOrigin` for the origin check that
 * requires either an import from an approved helper module or a local
 * helper body whose runtime path actually contains a terminating
 * primitive. A locally-defined no-op `function killPid(_p) {}` shares
 * this name but does not stop the daemon; the origin check rejects it.
 */
const TRUSTED_HELPER_NAMES = new Set([
  "killPid",
  "stopDaemon",
  "stopMockDaemon",
]);

/**
 * Module specifiers (the `from "…"` string in an `ImportDeclaration`)
 * that resolve to the approved shared daemon-test helpers. An identifier
 * imported from one of these paths is trusted by name because the helper
 * implementation lives behind the path allowlist
 * (`HELPER_PATH_PATTERNS`) and is therefore vetted out-of-band.
 *
 * Patterns are anchored to a relative-path prefix (`./` or `../`,
 * possibly chained: `../../`, `./../`, etc.) so that ONLY in-repo
 * relative imports of the shared helpers resolve. A path that merely
 * ENDS with `helpers/daemon` is not enough — `import { killPid } from
 * "some-unapproved-package/helpers/daemon"` is a bare specifier
 * resolved from `node_modules`, so its body lives outside the path
 * allowlist (`HELPER_PATH_PATTERNS`) and cannot be trusted by name.
 * The relative-prefix anchor closes that gap on
 * `@daemon-test-guardrail-precision`
 * `ac-cleanup-helper-origin-is-trusted`: every approved import in the
 * tests/ tree uses a `./` or `../` form (see e.g.
 * `./helpers/daemon.js`, `../helpers/daemon.js`,
 * `../../helpers/daemon.js`), and a bare or scoped specifier never
 * matches.
 *
 * Intermediate path segments between the relative prefix and
 * `helpers/<file>` are NOT allowed: only exact relative pointers to
 * the shared-helper directory match. Optional `.js` / `.ts` extension
 * is accepted to cover both the TS-source `./helpers/daemon` form and
 * the NodeNext-compatible `./helpers/daemon.js` form used across the
 * test tree.
 */
const APPROVED_HELPER_IMPORT_PATH_PATTERNS = [
  /^(\.\.?\/)+helpers\/(daemon|mock-daemon)(\.[jt]s)?$/,
];

/**
 * Sentinel returned by `findLocalHelperDefinition` when the helper name
 * is bound by an enclosing lexical scope but the binding's runtime value
 * cannot be statically inspected to prove a terminating primitive.
 * Distinct from `null` (no local binding at all) so the caller in
 * `isTrustedHelperByOrigin` can REJECT opaque local bindings rather than
 * falling through to the free-identifier conservative-trust path.
 *
 * The opaque cases are:
 *
 *   - Function/arrow parameters that name the helper. The runtime value
 *     comes from the caller; even a terminating default like `(signal =
 *     "SIGTERM") => process.kill(p, signal)` can be overridden at the
 *     call site, and parameters of the OUTER call (e.g. an `it`
 *     callback's `(killPid = (_p) => {}) => { ... }` first param) are
 *     fully under the test framework's control. Without this sentinel
 *     the cycle-4 reviewer probe `(killPid = (_pid) => {}) => {
 *     runKspec("serve start --detach"); onTestFinished(() => killPid(
 *     pid)); }` fell through to free-identifier trust because
 *     `findLocalHelperDefinition` returned null on the shadowing
 *     parameter and the use site had no other binding, silently
 *     crediting the no-op.
 *
 *   - VariableDeclaration bindings whose initializer is missing or is
 *     not a FunctionExpression / ArrowFunctionExpression. The binding
 *     is a definite local declaration that shadows any outer import,
 *     but the rule cannot inspect a non-function value to prove
 *     termination (`let killPid;`, `const killPid = makeKill()`,
 *     etc.). Treated as opaque on the same grounds as parameter
 *     shadowing.
 *
 *   - VariableDeclaration bindings with an inspectable function /
 *     arrow init whose declarator statement is NOT in source-order
 *     before the cleanup use site's statement within the same
 *     enclosing block. `const`/`let` bindings sit in the temporal
 *     dead zone until their declarator runs, so a cleanup callback
 *     registered earlier in the block (`onTestFinished(() =>
 *     killPid(pid))`) cannot rely on a `const killPid = (p) =>
 *     process.kill(p, "SIGTERM")` declared further down: if any
 *     statement between the registration and the declarator throws
 *     (an `expect(...)`, an `await`, or any other observation),
 *     teardown invokes the cleanup arrow while `killPid` is still in
 *     TDZ — the arrow throws ReferenceError and the daemon is never
 *     terminated. The cycle-5 reviewer probe pinned this gap:
 *     `runKspec("serve start --detach"); const pid =
 *     readPidFromFile(); onTestFinished(() => killPid(pid));
 *     expect(true).toBe(true); const killPid = (p) =>
 *     process.kill(p, "SIGTERM");` — pre-fix
 *     `findLocalHelperDefinition` returned the declarator regardless
 *     of position, the body inspection saw the terminating primitive,
 *     and the use site was silently credited as cleanup despite the
 *     binding being unreachable at teardown when the intervening
 *     `expect` fails. FunctionDeclaration bindings are exempt from
 *     this check because they are hoisted with their value to the
 *     start of the enclosing scope (`function killPid(p) {
 *     process.kill(p, "SIGTERM"); }` declared anywhere in the block
 *     is callable from every statement in that block).
 *
 *   - `for`-statement init bindings, `for-of`/`for-in` left bindings,
 *     and `catch` clause params. These shapes bind `name` in scopes
 *     the original walker (function params + Block/Program statement
 *     lists) did not visit, so a `for (const killPid = (_p) => {};
 *     ...) { ...; onTestFinished(() => killPid(pid)); ... }`, `for
 *     (const killPid of [(_p) => {}]) { ... }`, or `catch (killPid)
 *     { ... }` use site previously fell through to free-identifier
 *     trust. A catch param receives an exception value the rule
 *     cannot inspect; the for-statement init runs once but binds in
 *     the loop's own scope (not the body block) and even a
 *     terminating-shaped init is too unusual to credit; the
 *     for-of/for-in left rebinds on every iteration. All three are
 *     classified as opaque so the use site is rejected. This was the
 *     cycle-6 reviewer blocker on
 *     `@daemon-test-guardrail-precision`
 *     `ac-cleanup-helper-origin-is-trusted`.
 */
const LOCAL_BINDING_OPAQUE = Symbol("local-binding-opaque");

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
      cleanupClosureUnbound:
        'Detached daemon start via "{{pattern}}" registers a cleanup ' +
        "callback that captures an unbound `{{identifier}}` — the closure " +
        "does not yet own the concrete pid, child handle, or stop handle " +
        "for the just-started daemon at registration time, so an " +
        "intervening assertion, await, or daemon observation can fire " +
        "before the binding is set and leave the daemon running. Capture " +
        "the pid (or the spawn child handle) into a `const` BEFORE " +
        "registering `onTestFinished(() => process.kill(pid, 'SIGTERM'))` " +
        "so the cleanup closure binds to a concrete value.",
      localWrapperUnsafe:
        'Detached daemon start via "{{pattern}}" lives inside a local ' +
        "helper function, arrow, or method (object property, class " +
        "method, or function reassigned to a binding) in this test " +
        "file. Local wrappers are not approved daemon-test fixtures — " +
        "they hide the unsafe start from the cleanup contract because " +
        "the call site never sees a scoped cleanup registration tied " +
        "to the daemon. Move the daemon startup into the shared " +
        "fixture (`startTestDaemon` from tests/helpers/daemon.ts) or " +
        "inline the start in the test body with an immediate cleanup " +
        "registration before the next await/expect.",
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
     * True when a node is nested inside a local helper-like abstraction
     * declared in the test file itself. Recognised helper shapes:
     *
     *   - Named FunctionDeclaration: `function start() { ... }`.
     *   - VariableDeclarator with a function or arrow init:
     *     `const start = function () {...}`,
     *     `const start = () => {...}`.
     *   - Object-property method bindings — both the shorthand-method
     *     form `{ start() {...} }` and the longhand-property forms
     *     `{ start: function () {...} }` /
     *     `{ start: () => {...} }` (any Property whose `value` is a
     *     FunctionExpression or ArrowFunctionExpression).
     *   - Class methods and class-field functions:
     *     `class C { start() {} }`, `class C { static start() {} }`,
     *     `class C { start = () => {} }`,
     *     `class C { start = function () {} }` (any MethodDefinition or
     *     PropertyDefinition whose `value` is a function/arrow).
     *   - Function/arrow expressions reassigned to a target binding:
     *     `f = function () {}`, `helper.start = () => {}` (any plain
     *     `=` AssignmentExpression whose right-hand side is a
     *     function/arrow and whose left-hand side is an Identifier or
     *     MemberExpression target).
     *
     * The walk stops at the first ancestor `it`/`test`/`describe`/
     * `beforeEach`/`afterEach`/`beforeAll`/`afterAll` CallExpression,
     * so a node directly inside a test body is NOT considered to be
     * in a helper.
     *
     * The path-allowlisted approved-fixture files (`tests/helpers/
     * daemon.ts`, `tests/helpers/mock-daemon.ts`,
     * `tools/eslint-rules/`, the lint test files) return early at the
     * top of `create()`, so this predicate fires only in ordinary test
     * files — every "helper" it identifies is therefore an unapproved
     * local wrapper.
     *
     * Used by the Program:exit detached-serve check to surface the
     * `localWrapperUnsafe` diagnostic. The rule's approved-fixture
     * boundary is the path allowlist, not the presence of a function
     * declaration / method binding: wrapping a detached daemon start
     * in a local helper inside an ordinary test file does not satisfy
     * the cleanup contract because the call site never sees a scoped
     * cleanup registration tied to the daemon. The cycle-9 reviewer
     * probe (`const daemonHelper = { start() { runKspec("serve start
     * --detach"); const pid = readPidFromFile();
     * onTestFinished(() => process.kill(pid, "SIGTERM")); } };` then
     * `daemonHelper.start();`) was accepted by the earlier predicate
     * because object-method shorthand and class-method bindings did
     * not match its FunctionDeclaration / VariableDeclarator-only
     * checks; this is the regression covered by
     * `ac-approved-daemon-helper-boundary-explicit`.
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
          (current.type === "FunctionExpression" ||
            current.type === "ArrowFunctionExpression") &&
          current.parent
        ) {
          const fnParent = current.parent;
          if (
            fnParent.type === "Property" &&
            fnParent.value === current
          ) {
            return true;
          }
          if (
            fnParent.type === "MethodDefinition" &&
            fnParent.value === current
          ) {
            return true;
          }
          if (
            fnParent.type === "PropertyDefinition" &&
            fnParent.value === current
          ) {
            return true;
          }
          if (
            fnParent.type === "AssignmentExpression" &&
            fnParent.operator === "=" &&
            fnParent.right === current &&
            fnParent.left &&
            (fnParent.left.type === "Identifier" ||
              fnParent.left.type === "MemberExpression")
          ) {
            return true;
          }
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

    function hasCleanupAfter(node) {
      const body = findContainingBody(node);
      if (!body) return false;

      const nodeIndex = findNodeIndex(body, node);
      if (nodeIndex === -1) return false;

      for (let i = nodeIndex + 1; i < body.length; i++) {
        if (statementContainsCleanup(body[i], node)) {
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
        if (
          current.type === "TryStatement" &&
          current.finalizer &&
          subtreeContainsDaemonCleanupCall(current.finalizer, false, node, true)
        ) {
          return true;
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

    /**
     * True when a CallExpression's static shape matches an actual daemon
     * cleanup operation that, by its callee shape and arguments, is
     * expected to terminate or stop the daemon. The classifier is split
     * into per-shape predicates so each requirement (signal validity,
     * helper origin, CLI subcommand) is enforced in one place:
     *
     *   1. `process.kill(<expr>, <signal>?)` — accepted only when
     *      `<signal>` is missing, the `undefined` identifier / `void 0`
     *      sentinel, or one of the terminating literals
     *      `SIGTERM` / `SIGKILL` / `SIGINT`. The Node default when no
     *      second argument is passed is SIGTERM, so the no-arg form
     *      counts. Liveness probes (`process.kill(pid, 0)`),
     *      non-terminating signals (`SIGUSR1`, `SIGCONT`, `SIGWINCH`),
     *      and computed signals fall through to "not cleanup" — sending
     *      them leaves the daemon running.
     *
     *   2. `<expr>.kill(<signal>?)` — child-handle cleanup
     *      (`child.kill(...)`). Same accepted signal policy as
     *      `process.kill`: no signal / `undefined` / `void 0` /
     *      terminating literal counts; everything else is rejected so
     *      `child.kill("SIGUSR1")` etc. do not silently pass. The
     *      receiver is additionally checked by
     *      `isChildHandleReceiverTrusted`: a local ObjectExpression
     *      literal whose `kill` method body contains no terminating
     *      primitive (`const fake = { kill() { console.log("noop") } }`)
     *      is rejected, so a callee-shape look-alike cannot satisfy
     *      cleanup the same way a locally defined no-op named
     *      `killPid` is rejected by the helper-name path.
     *
     *   3. Identifier callees `killPid` / `stopDaemon` /
     *      `stopMockDaemon` — recognised by name only when the origin is
     *      trustworthy (`isTrustedHelperByOrigin`): either imported from
     *      an approved helper module, defined locally with a body that
     *      contains a terminating primitive, or genuinely free (no
     *      visible local definition — presumed external). A locally
     *      defined no-op or logger-only helper with the same name does
     *      NOT count, because the helper body proves the daemon is not
     *      stopped (`@daemon-test-guardrail-precision`
     *      `ac-cleanup-helper-origin-is-trusted`).
     *
     *   4. `runKspec(...)` / `kspec(...)` / `exec(...)` / `execSync(...)`
     *      / `spawn(...)` / `spawnSync(...)` / `execFile(...)` /
     *      `execFileSync(...)` whose argv resolves to the `serve stop`
     *      lifecycle subcommand — the CLI cleanup path. The tokeniser
     *      requires the first two non-flag positional tokens to be
     *      exactly `serve` then `stop`; substring matches don't count.
     *
     * Only an actual call whose CALLEE matches one of these shapes counts.
     * String literals containing kill-token substrings (e.g.
     * `console.log("SIGTERM docs")`, `const cleanupDocs = "killPid should be
     * used later"`) are NOT cleanup — the substring is data, not a runtime
     * call. The reviewer's cycle-2 blocker probes (1) `console.log("SIGTERM
     * docs");` immediately after a detached start, (2) a `const cleanupDocs
     * = "killPid should be used later"` declaration, and (3) a `try { …
     * detached start … } finally { console.log("SIGTERM docs"); }` finalizer
     * all relied on token-only text matching. They are now correctly
     * rejected because none of them contain a CallExpression with a
     * cleanup-shaped callee.
     */
    function isDaemonCleanupCallExpression(node) {
      if (!node || node.type !== "CallExpression") return false;
      const callee = node.callee;
      if (!callee) return false;

      if (callee.type === "Identifier") {
        const name = callee.name;
        if (TRUSTED_HELPER_NAMES.has(name)) {
          return isTrustedHelperByOrigin(name, node);
        }
        if (name === "runKspec" || name === "kspec") {
          const tokens = [];
          for (const arg of node.arguments) {
            for (const t of collectKspecHelperArgTokens(arg)) tokens.push(t);
          }
          return tokensResolveToServeStop(tokens);
        }
        if (name === "exec" || name === "execSync") {
          const tokens = shellCommandTokens(node.arguments[0]);
          if (!tokens || tokens.length === 0) return false;
          const lead = tokens[0];
          if (lead !== "kspec" && !lead.endsWith("/kspec")) return false;
          return tokensResolveToServeStop(tokens.slice(1));
        }
        if (
          name === "spawn" ||
          name === "spawnSync" ||
          name === "execFile" ||
          name === "execFileSync"
        ) {
          if (!isKspecExecutableArg(node.arguments[0])) return false;
          if (node.arguments.length < 2) return false;
          return tokensResolveToServeStop(
            collectArgvArrayTokens(node.arguments[1]),
          );
        }
        return false;
      }

      if (
        callee.type === "MemberExpression" &&
        callee.property &&
        callee.property.type === "Identifier" &&
        callee.property.name === "kill" &&
        callee.object
      ) {
        // process.kill(<expr>, <signal>?) — daemon-relevant only when
        // the signal would actually terminate the receiver. No signal,
        // `undefined`, or a terminating literal (SIGTERM/SIGKILL/SIGINT)
        // counts; liveness probes (`0`), non-terminating signals
        // (SIGUSR1, SIGCONT, SIGWINCH), and computed signals do not.
        if (
          callee.object.type === "Identifier" &&
          callee.object.name === "process"
        ) {
          return isTerminatingKillSignalArg(node.arguments[1], null, null);
        }
        // <expr>.kill(<signal>?) — child handle cleanup. Same accepted
        // signal policy as process.kill, AND the receiver must not be a
        // local object literal whose kill method body does not terminate
        // the daemon. The receiver check rejects the cycle-1 reviewer
        // probe `const fake = { kill() { console.log("noop"); } };
        // onTestFinished(() => fake.kill())` — the literal's kill
        // method has no terminating primitive call, so the cleanup
        // shape is misleading and counts as no cleanup at all.
        if (!isTerminatingKillSignalArg(node.arguments[0], null, null)) {
          return false;
        }
        return isChildHandleReceiverTrusted(callee.object, node);
      }

      return false;
    }

    /**
     * True when `arg` is a kill-signal argument that, sent to a running
     * daemon, actually terminates it. Used by both the top-level
     * `isDaemonCleanupCallExpression` classifier and the helper-body
     * inspection path. Accepted shapes:
     *
     *   - `undefined` argument slot (no second arg passed) — Node's
     *     `process.kill(pid)` and `ChildProcess.kill()` default to
     *     SIGTERM, which is terminating.
     *   - The `undefined` Identifier or `void <expr>` UnaryExpression
     *     sentinel — explicitly passing undefined falls back to the
     *     SIGTERM default in both APIs.
     *   - A string Literal whose value is one of `SIGTERM` / `SIGKILL` /
     *     `SIGINT` (the daemon-relevant terminating signals).
     *
     * When `ownerFn` is provided (helper-body inspection), an Identifier
     * referring to one of the helper's parameters is accepted only if
     * BOTH:
     *
     *   (a) The parameter has a terminating default value
     *       (`AssignmentPattern` with a `SIGTERM`/`SIGKILL`/`SIGINT`
     *       Literal right-hand side), AND
     *   (b) The call site at `useCallNode` either omits the corresponding
     *       argument (caller inherits the terminating default) OR passes
     *       a terminating argument shape (`undefined` / `void` /
     *       terminating Literal).
     *
     * The call-site check is required because parameter defaults only
     * apply when the caller omits the argument — a call like
     * `killPid(pid, "SIGUSR1")` overrides `function killPid(pid, signal
     * = "SIGTERM")` with a non-terminating signal at runtime, leaving the
     * daemon running. Trusting the body's parameter-default alone would
     * silently credit the override and violate
     * `@daemon-test-guardrail-precision`
     * `ac-cleanup-operation-terminates-daemon` /
     * `ac-cleanup-probes-do-not-count`.
     *
     * When `useCallNode` is not provided (recursive body inspection with
     * no concrete use site, or the use site is not a CallExpression),
     * the rule cannot validate an override and rejects the Identifier
     * — the body alone cannot prove termination because the parameter's
     * runtime value depends on the caller.
     *
     * Outside the helper-body context (`ownerFn === null`), the top-level
     * classifier rejects Identifier signals because the actual runtime
     * value cannot be statically pinned.
     *
     * Diagnostic / non-terminating signals — Literal `0` (the liveness
     * probe), `"SIGUSR1"`, `"SIGCONT"`, `"SIGWINCH"`, etc. — fall through
     * to `false`. Computed expressions (CallExpression, TemplateLiteral,
     * MemberExpression) also fall through: the rule cannot prove
     * termination from a runtime-computed signal.
     */
    function isTerminatingKillSignalArg(arg, ownerFn, useCallNode) {
      if (arg === undefined) return true;
      const unwrapped = unwrapTransparentExpression(arg);
      if (!unwrapped) return false;
      if (unwrapped.type === "Identifier" && unwrapped.name === "undefined") {
        return true;
      }
      if (
        unwrapped.type === "UnaryExpression" &&
        unwrapped.operator === "void"
      ) {
        return true;
      }
      if (
        unwrapped.type === "Literal" &&
        typeof unwrapped.value === "string" &&
        TERMINATING_KILL_SIGNALS.has(unwrapped.value)
      ) {
        return true;
      }
      if (
        ownerFn &&
        unwrapped.type === "Identifier" &&
        Array.isArray(ownerFn.params)
      ) {
        for (let i = 0; i < ownerFn.params.length; i++) {
          const param = ownerFn.params[i];
          if (
            param &&
            param.type === "AssignmentPattern" &&
            param.left &&
            param.left.type === "Identifier" &&
            param.left.name === unwrapped.name
          ) {
            const def = unwrapTransparentExpression(param.right);
            if (
              !def ||
              def.type !== "Literal" ||
              typeof def.value !== "string" ||
              !TERMINATING_KILL_SIGNALS.has(def.value)
            ) {
              return false;
            }
            // Parameter default is terminating; the helper terminates
            // the daemon only when the call site preserves the default
            // (arg omitted) or supplies a terminating shape itself.
            // Without a concrete call site to inspect, the override
            // cannot be ruled out, so reject conservatively.
            if (!useCallNode || useCallNode.type !== "CallExpression") {
              return false;
            }
            if (useCallNode.arguments.length <= i) return true;
            return isTerminatingKillSignalArg(
              useCallNode.arguments[i],
              null,
              null,
            );
          }
        }
      }
      return false;
    }

    /**
     * True when the receiver of a `<expr>.kill(...)` cleanup CallExpression
     * is trusted to actually be a daemon-stoppable handle (a ChildProcess
     * from spawn/fork, an outer-scope or framework-provided binding, etc.)
     * and NOT a local object literal whose `kill` method body does not
     * terminate the daemon. The reviewer's cycle-1 probe
     *   `const fake = { kill() { console.log("noop"); } };`
     *   `onTestFinished(() => fake.kill());`
     * shaped cleanup-look-alike code by giving a local literal a `kill`
     * method that does nothing — accepting it would credit cleanup with
     * no actual termination effect (`@daemon-test-guardrail-precision`
     * `ac-cleanup-operation-terminates-daemon` /
     * `ac-cleanup-probes-do-not-count`). The receiver check mirrors the
     * helper-body inspection used for trusted helper names so the same
     * no-op body shape is rejected whether the cleanup is invoked by
     * helper name (`killPid(pid)`) or by member call on a local literal
     * (`fake.kill()`).
     *
     * Resolution paths in order:
     *
     *   1. Receiver is not an Identifier (MemberExpression `agent.process`
     *      or `result.child`, CallExpression `getChild()`, etc.) — the
     *      rule cannot statically pin down a local literal definition,
     *      so the receiver is trusted as a conservative default. False
     *      positives are worse than false negatives for the rule, and
     *      these shapes are the canonical real child-handle access
     *      patterns (`agent.process.kill()` in the agent-runtime tests,
     *      etc.).
     *
     *   2. Receiver Identifier has no concrete local binding in the file
     *      (free identifier, parameter, framework-provided global) —
     *      trusted. The rule cannot prove the binding is a local no-op.
     *
     *   3. Receiver Identifier's most recent concrete binding is
     *      initialized from anything OTHER than an ObjectExpression
     *      literal — trusted. CallExpression initializers
     *      (`spawn(...)`, `fork(...)`, `runKspec(...)`), MemberExpression
     *      initializers (`result.child`), other Identifier aliases, etc.
     *      all fall through. Inferring termination effect across these
     *      shapes requires interprocedural analysis the rule does not
     *      perform; accepting them preserves the canonical legitimate
     *      cleanup shapes (`const child = spawn(...); child.kill()`).
     *
     *   4. Receiver Identifier's binding is an ObjectExpression literal
     *      with a literal `kill` property whose value is a
     *      FunctionExpression / ArrowFunctionExpression (including the
     *      shorthand-method form `{ kill() { ... } }`) — inspect the
     *      body. Trusted iff the body contains a terminating primitive
     *      call (`process.kill` with terminating signal, a child-handle
     *      `.kill` with terminating signal, or a kspec `serve stop` CLI
     *      invocation), exactly mirroring the helper-body inspection
     *      used for the trusted-helper-name path.
     *
     *   5. Receiver Identifier's binding is an ObjectExpression literal
     *      with a `kill` property whose value is something else (an
     *      Identifier reference, a logical expression, etc.), or with no
     *      literal `kill` property at all (the property is added later
     *      via assignment, spread, etc.) — trusted as a conservative
     *      default. The value is not a body the rule can statically
     *      inspect for termination, so the rule cannot prove a no-op.
     */
    function isChildHandleReceiverTrusted(receiver, killCallNode) {
      if (!receiver) return true;
      if (receiver.type !== "Identifier") return true;
      const binding = findConcreteBindingNodeAt(receiver.name, receiver);
      if (!binding) return true;
      const init = bindingInitializer(binding);
      if (!init || init.type !== "ObjectExpression") return true;
      const killProp = findLiteralKillProperty(init);
      if (!killProp) return true;
      const value = killProp.value;
      if (
        value &&
        (value.type === "FunctionExpression" ||
          value.type === "ArrowFunctionExpression")
      ) {
        return helperBodyContainsTerminatingPrimitive(
          value,
          new Set(),
          killCallNode,
        );
      }
      return true;
    }

    /**
     * Extract the right-hand-side initializer from a binding node returned
     * by `findConcreteBindingNodeAt`. A VariableDeclarator's initializer
     * is `init`; a top-level `=` AssignmentExpression's initializer is
     * `right`. Other node shapes have no initializer surface and are
     * returned as null.
     */
    function bindingInitializer(bindingNode) {
      if (!bindingNode) return null;
      if (bindingNode.type === "VariableDeclarator") {
        return bindingNode.init || null;
      }
      if (
        bindingNode.type === "AssignmentExpression" &&
        bindingNode.operator === "="
      ) {
        return bindingNode.right || null;
      }
      return null;
    }

    /**
     * Return the Property node for a literal `kill` key on the supplied
     * ObjectExpression, or null when no such property is present. Computed
     * keys are skipped because the rule cannot statically resolve them to
     * `"kill"`. Both Identifier-key (`{ kill() { ... } }` shorthand,
     * `{ kill: () => { ... } }` longhand) and string-Literal-key
     * (`{ "kill": () => { ... } }`) shapes are recognised.
     */
    function findLiteralKillProperty(objectExpr) {
      if (!objectExpr || !Array.isArray(objectExpr.properties)) return null;
      for (const prop of objectExpr.properties) {
        if (!prop || prop.type !== "Property") continue;
        if (prop.computed) continue;
        if (!prop.key) continue;
        if (prop.key.type === "Identifier" && prop.key.name === "kill") {
          return prop;
        }
        if (
          prop.key.type === "Literal" &&
          typeof prop.key.value === "string" &&
          prop.key.value === "kill"
        ) {
          return prop;
        }
      }
      return null;
    }

    /**
     * Decide whether the recognised helper Identifier `name` at the use
     * site `useNode` is trusted to actually terminate the daemon. Five
     * resolution paths are evaluated, in order:
     *
     *   1. Locally defined with an inspectable body — the lexical scope
     *      chain at `useNode` contains a FunctionDeclaration /
     *      VariableDeclarator-with-function-init named `name`
     *      (`findLocalHelperDefinition` walks every enclosing Block and
     *      the Program). Trust IFF the body contains a CallExpression
     *      matching the strict terminating-primitive shape
     *      (`isTerminatingPrimitiveCall`). A no-op or logger-only helper
     *      fails this check because no terminating primitive is
     *      reachable.
     *
     *      Local-scope-first is intentional: JS lexical scoping means an
     *      inner `function killPid(_pid) { console.log("noop"); }`
     *      declared in the `it` callback shadows any outer import named
     *      `killPid`, so the inner body is the value actually invoked at
     *      runtime. If we checked imports first, we would falsely trust
     *      a shadowed approved import while the real call is the no-op.
     *
     *   2. Locally bound but opaque — the lexical scope chain at
     *      `useNode` binds `name` through a parameter (with or without a
     *      default), a `let`/`const`/`var` with a non-function init, a
     *      parameter destructure, OR a `const`/`let` with a function
     *      init whose declarator statement is at or after the use
     *      site's containing statement in the same enclosing block
     *      (`findLocalHelperDefinition` returns
     *      `LOCAL_BINDING_OPAQUE`). The runtime value cannot be
     *      statically proven to terminate the daemon — a parameter can
     *      be overridden by the caller (the cycle-4 reviewer probe
     *      `(killPid = (_pid) => {}) => onTestFinished(() => killPid(
     *      pid))` is precisely this shape), a non-function init cannot
     *      be inspected for a terminating call, and a late-bound
     *      `const`/`let` lives in the temporal dead zone until its
     *      declarator runs — an intervening assertion or await can
     *      throw before initialization, leaving the cleanup callback
     *      to fail with ReferenceError at teardown (the cycle-5
     *      reviewer probe `onTestFinished(() => killPid(pid));
     *      expect(true).toBe(true); const killPid = (p) =>
     *      process.kill(p, "SIGTERM");` is precisely this shape).
     *      Reject so the caller cannot bootstrap trust through an
     *      unprovable local shadow.
     *
     *   3. Imported from an approved helper module — the import path
     *      matches `APPROVED_HELPER_IMPORT_PATH_PATTERNS` (the shared
     *      daemon fixture or mock helper, behind the lint path
     *      allowlist). The helper's implementation is vetted out of band
     *      so the name carries the trust of the module it comes from.
     *
     *   4. Imported from any OTHER module — the helper is imported but
     *      the source path is not in the approved-helper allowlist
     *      (`import { killPid } from "./fake-cleanup"` and any other
     *      non-vetted module). The vetting boundary is broken: the
     *      module's body lives outside the path allowlist and cannot be
     *      proven to terminate the daemon. Reject so the cycle-1
     *      reviewer probe `import { killPid } from "./fake-cleanup";
     *      onTestFinished(() => killPid(pid))` cannot satisfy cleanup
     *      by name alone (`@daemon-test-guardrail-precision`
     *      `ac-cleanup-helper-origin-is-trusted`).
     *
     *   5. Free identifier — no local binding (function, opaque, or
     *      otherwise) and no import binding at all. The helper is
     *      presumed to come from outside this file via a non-import
     *      channel (a host runtime global, a runtime injection, etc.).
     *      The rule cannot statically prove it is a no-op, so it
     *      conservatively counts as cleanup. This preserves the
     *      historical behavior for tests that rely on a bare `killPid(
     *      pid)` call shape without an explicit import, while the
     *      opaque-local-binding rejection at path 2 prevents a
     *      shadowing local from masquerading as a free identifier.
     *
     * Path 1's no-op rejection, path 2's opaque-local rejection, and
     * path 4's unapproved-import rejection together close the
     * `ac-cleanup-helper-origin-is-trusted` gap. Without path 2, the
     * cycle-4 reviewer probe (a parameter named `killPid` bound to an
     * empty arrow default) would reach path 5 because the parameter
     * shadow returned null from `findLocalHelperDefinition`, and the
     * use site had no other binding — silently crediting the no-op
     * default. Without path 4, an `import { killPid } from
     * "./fake-cleanup"` would reach path 5 and silently satisfy cleanup
     * even though the import source is outside the vetted helper
     * boundary. Without path 1's scope-walk (cycle-3), a nested
     * `function killPid(_pid) { ... }` no-op declared inside the `it`
     * callback would be invisible and silently credited as cleanup by
     * path 5.
     */
    function isTrustedHelperByOrigin(name, useNode) {
      const localResult = findLocalHelperDefinition(name, useNode);
      if (localResult === LOCAL_BINDING_OPAQUE) return false;
      if (localResult) {
        return helperBodyContainsTerminatingPrimitive(
          localResult,
          new Set(),
          useNode,
        );
      }
      if (isHelperNameImportedFromApprovedPath(name, useNode)) return true;
      if (isHelperNameImported(name, useNode)) return false;
      return true;
    }

    /**
     * True when a top-level `ImportDeclaration` in the same file binds
     * the local identifier `name` from any module specifier — the
     * approved-path-aware sister to `isHelperNameImportedFromApprovedPath`.
     * Used by `isTrustedHelperByOrigin` to detect the
     * unapproved-import case: when the helper IS imported but the source
     * is not on the approved-helper allowlist, the helper cannot bridge
     * the vetting boundary by name alone.
     */
    function isHelperNameImported(name, fromNode) {
      const program = findProgramNode(fromNode);
      if (!program || !Array.isArray(program.body)) return false;
      for (const stmt of program.body) {
        if (!stmt || stmt.type !== "ImportDeclaration") continue;
        for (const spec of stmt.specifiers || []) {
          if (!spec || !spec.local || spec.local.type !== "Identifier") {
            continue;
          }
          if (spec.local.name === name) return true;
        }
      }
      return false;
    }

    /**
     * True when a top-level `ImportDeclaration` in the same file imports
     * `name` from a module specifier matching the approved-helper path
     * list. Recognises named, default, and namespace import specifiers —
     * what matters is the locally-bound identifier name, since later
     * call sites refer to that local name regardless of how the value
     * arrived.
     */
    function isHelperNameImportedFromApprovedPath(name, fromNode) {
      const program = findProgramNode(fromNode);
      if (!program || !Array.isArray(program.body)) return false;
      for (const stmt of program.body) {
        if (!stmt || stmt.type !== "ImportDeclaration") continue;
        const source = stmt.source && stmt.source.value;
        if (typeof source !== "string") continue;
        if (
          !APPROVED_HELPER_IMPORT_PATH_PATTERNS.some((pattern) =>
            pattern.test(source),
          )
        ) {
          continue;
        }
        for (const spec of stmt.specifiers || []) {
          if (!spec || !spec.local || spec.local.type !== "Identifier") {
            continue;
          }
          if (spec.local.name === name) return true;
        }
      }
      return false;
    }

    /**
     * Return the lexically-closest local helper definition
     * (FunctionDeclaration or VariableDeclarator init that is a
     * FunctionExpression / ArrowFunctionExpression) named `name` visible
     * at `fromNode`, the `LOCAL_BINDING_OPAQUE` sentinel when an
     * enclosing scope binds `name` through a shape the rule cannot
     * statically inspect (function/arrow parameter, non-function
     * variable init), or `null` when no enclosing scope binds `name` at
     * all. The walk visits every enclosing BlockStatement and the
     * Program body — top-level, function/arrow bodies, `it`/`describe`
     * callbacks, try-blocks — so a helper declared anywhere in the
     * lexical scope chain (most commonly inside the `it` callback that
     * registers the cleanup) is found, not just the module-level shape.
     *
     * Without this scope walk, a `function killPid(_pid) {
     * console.log("noop"); }` declared inside the `it` body would be
     * invisible to the helper-origin check: `findLocalHelperDefinition`
     * would return null, the use site would fall through the
     * unapproved-import gate, and the free-identifier conservative-trust
     * path would silently credit the no-op as cleanup. That is the
     * cycle-3 reviewer blocker on
     * `@daemon-test-guardrail-precision`
     * `ac-cleanup-helper-origin-is-trusted`.
     *
     * Parameter shadowing is now reported as opaque rather than
     * absent (cycle-5 blocker): when an enclosing function/arrow has a
     * parameter named `name`, the parameter is a definite local binding
     * — not a free identifier. The runtime value comes from the caller,
     * which the rule cannot statically resolve, so the binding cannot
     * be trusted by inspecting its default alone. Returning the
     * sentinel routes the use site to the explicit reject branch in
     * `isTrustedHelperByOrigin` rather than the free-identifier
     * conservative-trust path that previously credited
     * `(killPid = (_pid) => {}) => onTestFinished(() => killPid(pid))`.
     *
     * Non-function variable bindings are handled symmetrically: a
     * `let killPid;`, `const killPid = "noop"`, or `let killPid =
     * someCall()` declarator binds the name but cannot be inspected
     * for a terminating primitive, so the sentinel is returned. Only
     * declarators whose init IS a FunctionExpression /
     * ArrowFunctionExpression are inspectable (and handled by
     * `matchHelperDefinitionInStatement` at the top of the loop body
     * before the opaque check fires).
     */
    function findLocalHelperDefinition(name, fromNode) {
      let current = fromNode;
      while (current) {
        if (
          current.type === "FunctionDeclaration" ||
          current.type === "FunctionExpression" ||
          current.type === "ArrowFunctionExpression"
        ) {
          for (const param of current.params || []) {
            if (patternBindsName(param, name)) return LOCAL_BINDING_OPAQUE;
          }
        }
        // CatchClause param: `try { ... } catch (killPid) { ...
        // onTestFinished(() => killPid(pid)); ... }`. The catch param
        // receives the thrown value, which is opaque to static analysis
        // (typically an Error instance, never a terminating primitive).
        // Returning the sentinel routes the use site to the explicit
        // reject branch in `isTrustedHelperByOrigin` instead of letting
        // it fall through to the free-identifier conservative-trust
        // path. Destructuring patterns (`catch ({ killPid }) { ... }`,
        // `catch ([killPid]) { ... }`) are recognised through the
        // shared `patternBindsName` predicate.
        if (
          current.type === "CatchClause" &&
          current.param &&
          patternBindsName(current.param, name)
        ) {
          return LOCAL_BINDING_OPAQUE;
        }
        // ForStatement init: `for (const killPid = ...; ...; ...) {
        // ...; onTestFinished(() => killPid(pid)); ... }`. The init's
        // VariableDeclaration binds `name` in the for-statement's own
        // scope, NOT in any enclosing BlockStatement. Without this
        // branch the binding is invisible and the use site falls
        // through to free-identifier trust. Even a terminating-shaped
        // function init in this position is too unusual to credit —
        // the canonical safe helper shape is a top-level
        // FunctionDeclaration or a block-level declarator handled by
        // `matchHelperDefinitionInStatement`. Returning OPAQUE keeps
        // the rule conservative.
        if (
          current.type === "ForStatement" &&
          current.init &&
          forStatementInitBindsName(current.init, name)
        ) {
          return LOCAL_BINDING_OPAQUE;
        }
        // ForOfStatement / ForInStatement left binding: `for (const
        // killPid of [...]) { ...; onTestFinished(() => killPid(pid));
        // ... }`. The left binding is rebound on every iteration; even
        // if one of the iterated values were a terminating primitive,
        // the rule cannot statically prove which iteration's value is
        // captured by the cleanup closure. Pre-fix the walker missed
        // these shapes entirely. Treat the binding as opaque to keep
        // the rule conservative.
        if (
          (current.type === "ForOfStatement" ||
            current.type === "ForInStatement") &&
          current.left &&
          forXLeftBindsName(current.left, name)
        ) {
          return LOCAL_BINDING_OPAQUE;
        }
        let statements = null;
        if (current.type === "Program" && Array.isArray(current.body)) {
          statements = current.body;
        } else if (
          current.type === "BlockStatement" &&
          Array.isArray(current.body)
        ) {
          statements = current.body;
        }
        if (statements) {
          for (const stmt of statements) {
            const found = matchHelperDefinitionInStatement(stmt, name);
            if (found) {
              // VariableDeclarator function/arrow inits sit in the
              // temporal dead zone until their declarator runs, so the
              // binding is only safe to credit when the declarator
              // statement comes strictly before the use site's
              // containing statement in source order. If the declarator
              // is at or after the use site within this enclosing
              // block, an intervening assertion or await can fail
              // before the binding is initialized and the cleanup
              // arrow will throw ReferenceError at teardown — daemon
              // not terminated. FunctionDeclarations are hoisted with
              // their value to the start of the enclosing scope and
              // need no order check; the wrapper exempts the
              // hoisting-safe shape from the OPAQUE return.
              if (
                statementIsVariableHelperDefinition(stmt, name) &&
                !isStatementBeforeUseSite(stmt, statements, fromNode)
              ) {
                return LOCAL_BINDING_OPAQUE;
              }
              return found;
            }
            if (statementBindsNameOpaquely(stmt, name)) {
              return LOCAL_BINDING_OPAQUE;
            }
          }
        }
        current = current.parent;
      }
      return null;
    }

    /**
     * True when `stmt` (top-level statement of a Block or Program) is
     * a `VariableDeclaration` (optionally wrapped in
     * `ExportNamedDeclaration` / `ExportDefaultDeclaration`) whose
     * declarators include an inspectable function-init binding for
     * `name`: `const|let|var <name> = function|arrow`. The TDZ-aware
     * source-order check in `findLocalHelperDefinition` only applies
     * to these shapes; `FunctionDeclaration` and its exported
     * variants are hoisted and need no order check.
     */
    function statementIsVariableHelperDefinition(stmt, name) {
      if (!stmt) return false;
      if (stmt.type === "ExportNamedDeclaration" && stmt.declaration) {
        return statementIsVariableHelperDefinition(stmt.declaration, name);
      }
      if (stmt.type === "ExportDefaultDeclaration" && stmt.declaration) {
        return statementIsVariableHelperDefinition(stmt.declaration, name);
      }
      if (stmt.type !== "VariableDeclaration") return false;
      for (const decl of stmt.declarations || []) {
        if (
          decl &&
          decl.id &&
          decl.id.type === "Identifier" &&
          decl.id.name === name &&
          decl.init &&
          (decl.init.type === "FunctionExpression" ||
            decl.init.type === "ArrowFunctionExpression")
        ) {
          return true;
        }
      }
      return false;
    }

    /**
     * True when `stmt`'s position within `statements` is strictly
     * before the statement that contains `fromNode` (the cleanup use
     * site). Strict less-than is intentional: when the declarator and
     * the use site are in the same enclosing statement, the use site
     * is nested inside the declarator's init (e.g. `const k = (() =>
     * { onTestFinished(() => k(p)); })()`) and the binding's runtime
     * availability at teardown depends on the IIFE's evaluation
     * order, which the rule cannot statically prove. Returning false
     * routes the use site to the `LOCAL_BINDING_OPAQUE` reject branch
     * — conservatively safe.
     */
    function isStatementBeforeUseSite(stmt, statements, fromNode) {
      const stmtIdx = statements.indexOf(stmt);
      if (stmtIdx === -1) return false;
      const useStmtIdx = findNodeIndex(statements, fromNode);
      if (useStmtIdx === -1) return false;
      return stmtIdx < useStmtIdx;
    }

    /**
     * True when `stmt` is a top-level statement of a Block/Program that
     * binds `name` in a shape the rule cannot statically inspect for a
     * terminating primitive. The inspectable shapes
     * (FunctionDeclaration and VariableDeclarator-with-function-init)
     * are handled by `matchHelperDefinitionInStatement` and must NOT
     * be reported here — only the opaque residuals are reported.
     *
     * Opaque shapes recognised:
     *
     *   - `let|const|var <pattern>` where `<pattern>` binds `name` but
     *     the declarator init is missing or is not a
     *     FunctionExpression / ArrowFunctionExpression
     *     (`let killPid;`, `const killPid = makeKill()`, `let killPid
     *     = "noop"`, `const { killPid } = require("…")`, etc.).
     *
     *   - Export wrappers around an opaque declaration — `export const
     *     killPid = makeKill()` and `export default const killPid =
     *     ...` are unwrapped to the inner declaration so the opaque
     *     classification still fires.
     */
    function statementBindsNameOpaquely(stmt, name) {
      if (!stmt) return false;
      if (stmt.type === "ExportNamedDeclaration" && stmt.declaration) {
        return statementBindsNameOpaquely(stmt.declaration, name);
      }
      if (stmt.type === "ExportDefaultDeclaration" && stmt.declaration) {
        return statementBindsNameOpaquely(stmt.declaration, name);
      }
      if (stmt.type !== "VariableDeclaration") return false;
      for (const decl of stmt.declarations || []) {
        if (!decl || !decl.id) continue;
        if (!patternBindsName(decl.id, name)) continue;
        // The function-init shape for a simple Identifier id named
        // `name` is the inspectable case — matchHelperDefinitionInStatement
        // already returned it above, so by definition we did not reach
        // this point for that shape. Everything else (no init, non-
        // function init, destructure binding `name`) is opaque.
        if (
          decl.id.type === "Identifier" &&
          decl.id.name === name &&
          decl.init &&
          (decl.init.type === "FunctionExpression" ||
            decl.init.type === "ArrowFunctionExpression")
        ) {
          continue;
        }
        return true;
      }
      return false;
    }

    function matchHelperDefinitionInStatement(stmt, name) {
      if (!stmt) return null;
      if (
        stmt.type === "FunctionDeclaration" &&
        stmt.id &&
        stmt.id.name === name
      ) {
        return stmt;
      }
      if (stmt.type === "VariableDeclaration") {
        for (const decl of stmt.declarations) {
          if (
            decl.id &&
            decl.id.type === "Identifier" &&
            decl.id.name === name &&
            decl.init &&
            (decl.init.type === "FunctionExpression" ||
              decl.init.type === "ArrowFunctionExpression")
          ) {
            return decl.init;
          }
        }
        return null;
      }
      if (stmt.type === "ExportNamedDeclaration" && stmt.declaration) {
        return matchHelperDefinitionInStatement(stmt.declaration, name);
      }
      if (stmt.type === "ExportDefaultDeclaration" && stmt.declaration) {
        return matchHelperDefinitionInStatement(stmt.declaration, name);
      }
      return null;
    }

    /**
     * Walk up `fromNode`'s parent chain to find the enclosing Program
     * node. Used by `isHelperNameImportedFromApprovedPath` and
     * `findLocalHelperDefinition` to scan top-level imports and
     * declarations without threading the Program node through every
     * call site.
     */
    function findProgramNode(fromNode) {
      let current = fromNode;
      while (current && current.parent) current = current.parent;
      if (current && current.type === "Program") return current;
      return null;
    }

    /**
     * True when `fnNode`'s body contains at least one CallExpression
     * whose shape is a strict terminating primitive
     * (`isTerminatingPrimitiveCall`) — a `process.kill` or
     * child-handle `.kill` with an accepted terminating signal, or a
     * kspec `serve stop` CLI invocation. Nested function / arrow bodies
     * are NOT descended: their CallExpressions belong to a different
     * cleanup context, so a `process.kill` inside an unrelated nested
     * callback should not count toward `fnNode`'s trust. The `visited`
     * set guards against infinite recursion for pathological reentry
     * shapes (helpers that capture themselves, etc.).
     *
     * Helper-name calls inside the body (e.g. a wrapper that just
     * forwards to another `killPid`) deliberately do NOT count, because
     * the rule must see the actual terminating syscall — wrappers that
     * stack helper names without ever reaching a syscall leave the
     * daemon running. This matches the task spec's "avoid counting
     * recursive wrappers or helper names whose body does not contain an
     * approved terminating cleanup call" requirement.
     */
    function helperBodyContainsTerminatingPrimitive(
      fnNode,
      visited,
      useCallNode,
    ) {
      if (!fnNode || visited.has(fnNode)) return false;
      visited.add(fnNode);
      if (!fnNode.body) return false;
      return subtreeContainsTerminatingPrimitive(
        fnNode.body,
        fnNode,
        useCallNode,
      );
    }

    function subtreeContainsTerminatingPrimitive(node, ownerFn, useCallNode) {
      if (!node || typeof node !== "object" || typeof node.type !== "string") {
        return false;
      }
      if (node !== ownerFn.body) {
        if (
          node.type === "FunctionDeclaration" ||
          node.type === "FunctionExpression" ||
          node.type === "ArrowFunctionExpression"
        ) {
          return false;
        }
      }
      if (
        node.type === "CallExpression" &&
        isTerminatingPrimitiveCall(node, ownerFn, useCallNode)
      ) {
        return true;
      }
      for (const key in node) {
        if (
          key === "parent" ||
          key === "loc" ||
          key === "range" ||
          key === "start" ||
          key === "end" ||
          key === "type" ||
          key === "tokens" ||
          key === "comments"
        ) {
          continue;
        }
        const child = node[key];
        if (Array.isArray(child)) {
          for (const c of child) {
            if (
              c &&
              typeof c === "object" &&
              typeof c.type === "string" &&
              subtreeContainsTerminatingPrimitive(c, ownerFn, useCallNode)
            ) {
              return true;
            }
          }
        } else if (
          child &&
          typeof child === "object" &&
          typeof child.type === "string"
        ) {
          if (subtreeContainsTerminatingPrimitive(child, ownerFn, useCallNode)) {
            return true;
          }
        }
      }
      return false;
    }

    /**
     * Strict terminating-primitive predicate used by helper-body
     * inspection. Mirrors `isDaemonCleanupCallExpression` but
     * deliberately omits the helper-name shortcut so wrappers that just
     * delegate to another `killPid` / `stopDaemon` cannot bootstrap
     * trust without ever reaching a terminating syscall. `ownerFn` is
     * forwarded to `isTerminatingKillSignalArg` so an Identifier-shaped
     * signal that names a parameter with a terminating default is
     * accepted (the `function killPid(pid, signal = "SIGTERM") { ... }`
     * pattern used by `tests/cli-serve.test.ts`). The child-handle
     * receiver check (`isChildHandleReceiverTrusted`) is applied here
     * too so a wrapper whose body invokes a local-no-op-literal kill
     * cannot bootstrap trust either.
     */
    function isTerminatingPrimitiveCall(node, ownerFn, useCallNode) {
      if (!node || node.type !== "CallExpression") return false;
      const callee = node.callee;
      if (!callee) return false;
      if (
        callee.type === "MemberExpression" &&
        callee.property &&
        callee.property.type === "Identifier" &&
        callee.property.name === "kill" &&
        callee.object
      ) {
        if (
          callee.object.type === "Identifier" &&
          callee.object.name === "process"
        ) {
          return isTerminatingKillSignalArg(
            node.arguments[1],
            ownerFn,
            useCallNode,
          );
        }
        if (
          !isTerminatingKillSignalArg(
            node.arguments[0],
            ownerFn,
            useCallNode,
          )
        ) {
          return false;
        }
        return isChildHandleReceiverTrusted(callee.object, node);
      }
      if (callee.type === "Identifier") {
        const name = callee.name;
        if (name === "runKspec" || name === "kspec") {
          const tokens = [];
          for (const arg of node.arguments) {
            for (const t of collectKspecHelperArgTokens(arg)) tokens.push(t);
          }
          return tokensResolveToServeStop(tokens);
        }
        if (name === "exec" || name === "execSync") {
          const tokens = shellCommandTokens(node.arguments[0]);
          if (!tokens || tokens.length === 0) return false;
          const lead = tokens[0];
          if (lead !== "kspec" && !lead.endsWith("/kspec")) return false;
          return tokensResolveToServeStop(tokens.slice(1));
        }
        if (
          name === "spawn" ||
          name === "spawnSync" ||
          name === "execFile" ||
          name === "execFileSync"
        ) {
          if (!isKspecExecutableArg(node.arguments[0])) return false;
          if (node.arguments.length < 2) return false;
          return tokensResolveToServeStop(
            collectArgvArrayTokens(node.arguments[1]),
          );
        }
      }
      return false;
    }

    /**
     * The serve-stop counterpart to `tokensResolveToDetachedServe`: walk
     * the kspec-args token list and confirm the first two non-flag
     * positional tokens are exactly `serve` then `stop`. Used by the
     * cleanup classifier to recognise `runKspec("serve stop ...")`,
     * `exec("kspec serve stop ...")`, and `spawn("kspec", ["serve",
     * "stop", ...])` as the in-flow CLI cleanup path.
     */
    function tokensResolveToServeStop(tokens) {
      let positional1 = null;
      let positional2 = null;
      for (const token of tokens) {
        if (typeof token !== "string" || token.length === 0) continue;
        if (token[0] === "-") continue;
        if (positional1 === null) positional1 = token;
        else if (positional2 === null) positional2 = token;
      }
      return positional1 === "serve" && positional2 === "stop";
    }

    /**
     * Set of recognised in-flow cleanup-registration wrapper names — call
     * names whose callback argument is scoped to the CURRENT test and is
     * guaranteed to run after the test body finishes (success or failure).
     * A daemon-cleanup-shaped CallExpression nested inside one of these
     * callbacks is counted as registered cleanup; a daemon-cleanup-shaped
     * CallExpression nested inside an arbitrary unregistered function or
     * arrow body is NOT — that body is just code stored in a binding or
     * passed to an unrelated callee, never invoked, so the kill never runs.
     *
     * Coverage is intentionally narrow: vitest exposes per-test cleanup
     * via `onTestFinished`, which registers a teardown for the currently
     * running test and is invoked once that test settles. That is the
     * only test-framework hook that scopes cleanup to the just-started
     * detached daemon.
     *
     * The lifecycle hooks (`afterEach`, `afterAll`, `beforeEach`,
     * `beforeAll`) are NOT recognised here because registering them
     * inside a test body does not give the current test scoped cleanup
     * for a daemon that was just started:
     *   - `afterEach` registered inside `it(...)` is added to the parent
     *     describe scope at runtime; vitest does not retroactively run
     *     newly-registered hooks for the test that just registered them,
     *     and even when it did, the registration itself can be skipped if
     *     an earlier statement in the same test throws.
     *   - `beforeEach` / `beforeAll` are setup hooks; their callbacks fire
     *     before subsequent tests, not after the current test, so they
     *     cannot tear down the daemon this test just started.
     *   - `afterAll` runs only when the whole describe block finishes, so
     *     a leaked daemon survives every other test in the file.
     * The cycle-6 reviewer probe `runKspec("serve start --detach");
     * beforeEach(() => killPid(result.pid)); expect(true).toBe(true);`
     * relied on these hooks being recognised — accepting them silently
     * left a detached daemon leaking on the straight-line path to the
     * next observation (`@daemon-test-guardrail-precision`
     * `ac-detached-cleanup-before-observation`).
     *
     * Bare names only — process.on("exit", ...) is matched separately by
     * `isProcessOnExitRegistration` because it is a MemberExpression
     * callee shape.
     */
    const CLEANUP_REGISTRATION_WRAPPER_NAMES = new Set([
      "onTestFinished",
    ]);

    /**
     * Set of Node `process` events whose callbacks WILL run when the
     * process is shutting down or receiving a termination signal —
     * registering a daemon-kill on one of these events does prevent the
     * leak the rule is guarding against. Any other event (`message`,
     * `disconnect`, `warning`, `unhandledRejection`, etc.) fires during
     * normal IPC or error reporting and is not guaranteed to run before
     * the test ends, so a kill registered there does NOT credit cleanup.
     *
     * The cycle-4 reviewer probe `process.on("message", () =>
     * killPid(p))` previously credited cleanup because the predicate
     * accepted any `process.on(...)` event. Constraining the event name
     * to this set rejects that probe and keeps the legitimate
     * `process.on("exit"|"SIGINT"|…)` patterns valid.
     */
    const PROCESS_EXIT_EVENT_NAMES = new Set([
      "exit",
      "beforeExit",
      "SIGINT",
      "SIGTERM",
      "SIGHUP",
      "SIGQUIT",
      "SIGBREAK",
    ]);

    /**
     * True when `callNode` is a `process.on(<exit-event>, <callback>)`
     * registration whose callback argument is the same node passed in
     * `callbackArg`, AND the event name is a string literal naming a
     * process exit/signal event (see `PROCESS_EXIT_EVENT_NAMES`). Used
     * by `isCleanupRegistrationCallback` to recognise the standard Node
     * process-lifecycle cleanup pattern alongside the vitest hook names.
     *
     * The event name MUST be constrained — `process.on("message",
     * killer)` is an IPC handler, not cleanup, and the callback may run
     * during normal communication or never at all before the test ends.
     * Crediting it as cleanup leaves the detached daemon leaking on the
     * straight-line path to the next observation (cycle-4 reviewer
     * blocker on `@daemon-test-guardrail-precision`
     * `ac-detached-cleanup-before-observation`).
     */
    function isProcessOnExitRegistration(callNode, callbackArg) {
      if (!callNode || callNode.type !== "CallExpression") return false;
      const callee = callNode.callee;
      if (!callee || callee.type !== "MemberExpression") return false;
      if (!callee.object || callee.object.type !== "Identifier") return false;
      if (callee.object.name !== "process") return false;
      if (!callee.property || callee.property.type !== "Identifier") return false;
      if (callee.property.name !== "on") return false;
      if (!callNode.arguments.includes(callbackArg)) return false;
      const eventArg = callNode.arguments[0];
      if (!eventArg || eventArg.type !== "Literal") return false;
      if (typeof eventArg.value !== "string") return false;
      return PROCESS_EXIT_EVENT_NAMES.has(eventArg.value);
    }

    /**
     * True when `fnNode` (a FunctionDeclaration, FunctionExpression, or
     * ArrowFunctionExpression) is itself an argument to a recognised
     * cleanup-registration wrapper call — i.e. its body WILL be invoked by
     * the test framework at a defined cleanup boundary.
     *
     * Patterns recognised as registrations:
     *   - `onTestFinished(<fn>)` — vitest per-test teardown, the only
     *     hook that scopes cleanup to the current test.
     *   - `process.on("exit"|"SIGTERM"|…, <fn>)` — Node process-lifecycle
     *     teardown.
     * Lifecycle hooks (`afterEach` / `afterAll` / `beforeEach` /
     * `beforeAll`) are intentionally NOT recognised: registering one
     * inside a test body does not give the current test scoped cleanup
     * for a daemon that was just started (see
     * `CLEANUP_REGISTRATION_WRAPPER_NAMES` for the rationale and the
     * cycle-6 reviewer probe).
     *
     * The callback must occupy an ARGUMENT slot of the call (not the
     * callee position), so an IIFE-shaped node like `(() => kill())()`
     * — where the arrow is the callee, not an argument — is correctly
     * NOT treated as a registration callback.
     *
     * Anything else — assignment to a binding, an element of an array,
     * an argument to an unrelated callee like `console.log(() => …)` —
     * means the function body is never invoked through this expression,
     * so cleanup-shaped calls inside it MUST NOT count as registered
     * cleanup. This is the cycle-3 reviewer's blocker case
     * (`const cleanup = () => killPid(pid);` accepted as cleanup despite
     * the arrow never being invoked).
     */
    function isCleanupRegistrationCallback(fnNode) {
      if (!fnNode) return false;
      const parent = fnNode.parent;
      if (!parent || parent.type !== "CallExpression") return false;
      // Argument-slot check: rejects IIFE callees, MemberExpression
      // calls like obj.method(fn) where fn is metadata, etc.
      if (!parent.arguments.includes(fnNode)) return false;
      const callee = parent.callee;
      if (!callee) return false;
      if (
        callee.type === "Identifier" &&
        CLEANUP_REGISTRATION_WRAPPER_NAMES.has(callee.name)
      ) {
        return true;
      }
      return isProcessOnExitRegistration(parent, fnNode);
    }

    /**
     * True when a node statically resolves to the literal `null` /
     * `undefined` (or `void <expr>`). Used by the cleanup-binding analysis
     * to recognise placeholder initialisers — `let pid;`,
     * `let pid = undefined;`, `let child = null;`,
     * `let child: T | null = null` — that mean the cleanup closure does
     * not yet own a concrete pid/handle for the just-started daemon.
     *
     * Transparent wrappers (TSAsExpression / TSSatisfiesExpression /
     * TSNonNullExpression / TSTypeAssertion / TSInstantiationExpression /
     * ParenthesizedExpression / ChainExpression) are stripped before the
     * structural check so TS-coerced placeholders are recognised too:
     * `let pid = undefined as number | undefined`, `let pid = null as any`,
     * `let pid = (undefined)!`, etc. The cycle-5 reviewer probe motivated
     * this: a captured binding initialised to a wrapped `undefined` was
     * accepted as concrete, leaving the cleanup closure with no usable pid
     * at registration time and violating
     * `ac-detached-cleanup-bound-before-observation`. Using the same
     * unwrap discipline as the kill-target analysis keeps both legs of the
     * binding-status check on the same AST shape.
     */
    function isNullOrUndefinedInitializer(node) {
      if (!node) return true;
      const unwrapped = unwrapTransparentExpression(node);
      if (!unwrapped) return true;
      if (unwrapped.type === "Literal" && unwrapped.value === null) return true;
      if (unwrapped.type === "Identifier" && unwrapped.name === "undefined") {
        return true;
      }
      if (
        unwrapped.type === "UnaryExpression" &&
        unwrapped.operator === "void"
      ) {
        return true;
      }
      return false;
    }

    /**
     * True when a binding pattern (FunctionDeclaration param, etc.) names
     * `targetName` directly or through an AssignmentPattern / RestElement.
     * Object/array destructuring patterns that include `targetName` as a
     * property/element also count — the parameter slot binds the name
     * even though the runtime value comes from a destructure.
     */
    function patternBindsName(pattern, targetName) {
      if (!pattern) return false;
      if (pattern.type === "Identifier") return pattern.name === targetName;
      if (pattern.type === "AssignmentPattern") {
        return patternBindsName(pattern.left, targetName);
      }
      if (pattern.type === "RestElement") {
        return patternBindsName(pattern.argument, targetName);
      }
      if (pattern.type === "ArrayPattern") {
        for (const el of pattern.elements || []) {
          if (el && patternBindsName(el, targetName)) return true;
        }
        return false;
      }
      if (pattern.type === "ObjectPattern") {
        for (const prop of pattern.properties || []) {
          if (prop.type === "RestElement") {
            if (patternBindsName(prop.argument, targetName)) return true;
            continue;
          }
          if (prop.type === "Property" && prop.value) {
            if (patternBindsName(prop.value, targetName)) return true;
          }
        }
        return false;
      }
      return false;
    }

    /**
     * True when a `ForStatement`'s `init` (a VariableDeclaration with
     * `let`/`const`/`var` declarators, e.g. `for (const killPid = (_p)
     * => {}; ...; ...)`) declares the helper `name`. Used by
     * `findLocalHelperDefinition` to recognise the for-init binding
     * scope, which is distinct from any enclosing BlockStatement. Bare
     * non-VariableDeclaration inits (e.g. `for (i = 0; ...; ...)`)
     * cannot introduce a NEW local binding — they assign to an outer
     * one — so they are skipped here and the parent walk continues.
     */
    function forStatementInitBindsName(init, name) {
      if (!init || init.type !== "VariableDeclaration") return false;
      for (const decl of init.declarations || []) {
        if (decl && decl.id && patternBindsName(decl.id, name)) return true;
      }
      return false;
    }

    /**
     * True when a `ForOfStatement`/`ForInStatement`'s `left` (a
     * VariableDeclaration like `const killPid` in `for (const killPid
     * of [...])`) declares the helper `name`. Used by
     * `findLocalHelperDefinition` to recognise the per-iteration left
     * binding scope. Bare LValue lefts (e.g. `for (killPid of arr)`)
     * assign to an existing outer binding rather than introducing a
     * new local; they are skipped here so the parent walk can resolve
     * the actual declaration upstream.
     */
    function forXLeftBindsName(left, name) {
      if (!left || left.type !== "VariableDeclaration") return false;
      for (const decl of left.declarations || []) {
        if (decl && decl.id && patternBindsName(decl.id, name)) return true;
      }
      return false;
    }

    /**
     * True when `name` is locally declared (parameter or variable) inside
     * `callbackFn`'s body, so it is NOT a free identifier captured from
     * the surrounding scope. Used by the cleanup-binding analysis to
     * filter out callback-local names before checking outer-scope
     * bindings.
     */
    function isLocalToCallback(name, callbackFn) {
      if (!callbackFn) return false;
      for (const param of callbackFn.params || []) {
        if (patternBindsName(param, name)) return true;
      }
      const body = callbackFn.body;
      if (body && body.type === "BlockStatement") {
        return blockDeclaresName(body, name);
      }
      return false;
    }

    /**
     * Recursive walk of an AST subtree (a callback body) looking for any
     * VariableDeclaration / FunctionDeclaration / nested function-param
     * binding of `name`. Function/arrow nested deeper are not descended
     * (their inner declarations don't shadow the outer body), but their
     * own declarations don't bind `name` in the callback body either —
     * we check direct declarations only.
     */
    function blockDeclaresName(block, name) {
      if (!block) return false;
      const stack = [block];
      while (stack.length > 0) {
        const node = stack.pop();
        if (!node || typeof node !== "object" || typeof node.type !== "string") {
          continue;
        }
        if (
          node.type === "FunctionDeclaration" ||
          node.type === "FunctionExpression" ||
          node.type === "ArrowFunctionExpression"
        ) {
          if (node !== block) {
            // Nested function — its declarations don't bind `name` in
            // the outer block. Skip the body so we don't mis-attribute
            // an inner local as outer-binding.
            if (
              node.type === "FunctionDeclaration" &&
              node.id &&
              node.id.type === "Identifier" &&
              node.id.name === name
            ) {
              return true;
            }
            continue;
          }
        }
        if (node.type === "VariableDeclaration") {
          for (const d of node.declarations) {
            if (patternBindsName(d.id, name)) return true;
          }
          continue;
        }
        if (
          node.type === "FunctionDeclaration" &&
          node.id &&
          node.id.type === "Identifier" &&
          node.id.name === name
        ) {
          return true;
        }
        for (const key in node) {
          if (
            key === "parent" ||
            key === "loc" ||
            key === "range" ||
            key === "start" ||
            key === "end" ||
            key === "type" ||
            key === "tokens" ||
            key === "comments"
          ) {
            continue;
          }
          const child = node[key];
          if (Array.isArray(child)) {
            for (const c of child) {
              if (c && typeof c === "object" && typeof c.type === "string") {
                stack.push(c);
              }
            }
          } else if (child && typeof child === "object" && typeof child.type === "string") {
            stack.push(child);
          }
        }
      }
      return false;
    }

    /**
     * Sentinel pushed by `collectDaemonKillCaptureNames` when a
     * recognised daemon-kill shape's capture position is an expression
     * that cannot be resolved to a captured outer Identifier — a
     * literal pid, a CallExpression, a `this` expression, etc. The
     * caller treats it as an unbound capture: such targets cannot be
     * statically tied to the just-started daemon, so accepting them as
     * scoped cleanup would silently re-introduce the leak the
     * ownership predicate guards against. The string form is used in
     * the diagnostic when no better name is available.
     *
     * Picked to be a non-Identifier-shaped string so it cannot collide
     * with any real source-level identifier resolution.
     */
    const UNVERIFIABLE_KILL_TARGET = "<unverifiable kill target>";

    /**
     * Strip wrapper nodes that are syntactically transparent — they
     * neither change the expression's runtime value nor the underlying
     * binding. The set:
     *
     *   - `ChainExpression` (optional-chain root)
     *   - `ParenthesizedExpression`
     *   - TS-side transparent assertions / coercions:
     *       `TSAsExpression`        (`pid as number`)
     *       `TSSatisfiesExpression` (`pid satisfies number`)
     *       `TSNonNullExpression`   (`pid!`)
     *       `TSTypeAssertion`       (`<number>pid`)
     *       `TSInstantiationExpression` (`pid<T>`)
     *
     * Wrappers can stack (`((pid as number)!)`), so the unwrap is a
     * fixed-point loop. Anything else — Literal, CallExpression,
     * MemberExpression, etc. — is returned as-is for the caller's own
     * structural analysis.
     *
     * The cycle-3 reviewer probe motivates the TS branches: a safe test
     * that captured the pid before cleanup but used a type assertion
     * inside the callback (`onTestFinished(() => process.kill(pid as
     * number, "SIGTERM"))`) was rejected because the previous walker
     * stopped at the TSAsExpression and fell through to
     * UNVERIFIABLE_KILL_TARGET. Treating these wrappers as transparent
     * preserves the safe shape — the underlying Identifier is still
     * `pid`, which the ownership predicate validates against the
     * detached-start node.
     */
    function unwrapTransparentExpression(node) {
      let current = node;
      while (current && typeof current.type === "string") {
        if (current.type === "ChainExpression" && current.expression) {
          current = current.expression;
          continue;
        }
        if (current.type === "ParenthesizedExpression" && current.expression) {
          current = current.expression;
          continue;
        }
        if (
          current.type === "TSAsExpression" ||
          current.type === "TSSatisfiesExpression" ||
          current.type === "TSNonNullExpression" ||
          current.type === "TSTypeAssertion" ||
          current.type === "TSInstantiationExpression"
        ) {
          if (current.expression) {
            current = current.expression;
            continue;
          }
        }
        break;
      }
      return current;
    }

    /**
     * Walk a kill-capture expression down to the root Identifier it
     * resolves to. Bare `pid` / `child` returns its name; member chains
     * `holder.pid` / `state.daemon.pid` return their leftmost
     * Identifier (`holder` / `state`). Optional-access wrappers
     * (`holder?.pid`, AST `ChainExpression`), parentheses, and
     * transparent TS coercions (`pid as number`, `pid!`, `<number>pid`,
     * `pid satisfies number`) are stripped at each step before
     * descending. Returns null when the chain bottoms out in a
     * non-Identifier (Literal, ThisExpression, CallExpression,
     * TemplateLiteral, etc.) — the caller maps that to
     * `UNVERIFIABLE_KILL_TARGET` so the cleanup-binding check rejects
     * the closure.
     */
    function extractRootCaptureIdentifierName(node) {
      if (!node) return null;
      let current = unwrapTransparentExpression(node);
      while (current && current.type === "MemberExpression" && current.object) {
        current = unwrapTransparentExpression(current.object);
      }
      if (current && current.type === "Identifier") return current.name;
      return null;
    }

    /**
     * Identify the identifiers that the cleanup-callback closure must own
     * concretely for the kill to actually run. For each recognised daemon-
     * kill shape inside the callback body, return the identifier whose
     * value at registration time gates the kill:
     *
     *   - `process.kill(<expr>, "SIGTERM")` → root identifier of `<expr>`
     *     (e.g. `pid`, or `holder` for `holder.pid`, or `state` for
     *     `state.daemon.pid`). Non-Identifier-rooted expressions such as
     *     `process.kill(getPid(), …)` or `process.kill(12345, …)` resolve
     *     to `UNVERIFIABLE_KILL_TARGET`, which the caller treats as
     *     unbound so the cleanup is rejected.
     *   - `<expr>.kill("SIGTERM")` → root identifier of the receiver
     *     `<expr>` (e.g. `child` for a bare receiver, or `handle` for
     *     `handle.child.kill("SIGTERM")`). Same fallthrough to
     *     `UNVERIFIABLE_KILL_TARGET` when the receiver root is not an
     *     Identifier.
     *   - `killPid(<expr>)` / `stopDaemon(<expr>)` /
     *     `stopMockDaemon(<expr>)` → root identifier of `<expr>` with the
     *     same UNVERIFIABLE fallthrough.
     *
     * The earlier predicate only inspected bare-Identifier kill targets,
     * so `process.kill(holder.pid, "SIGTERM")` and `holder.kill("SIGTERM")`
     * were silently accepted as scoped cleanup — even when `holder` was
     * declared BEFORE the daemon start (cycle-8 reviewer probe). Walking
     * MemberExpression chains to the root identifier and feeding the
     * root through the same ownership predicate (`holder`'s declarator
     * ends before the detached-start begins, so it cannot represent the
     * just-started daemon) closes that gap. Rejecting non-Identifier
     * targets as unverifiable also handles `process.kill(12345, …)` and
     * `process.kill(getPid(), …)`, which cannot be tied to the daemon
     * statically and which the missing-cleanup contract still owes a
     * diagnostic for.
     *
     * Identifiers that are locally declared in the callback (params,
     * inner `let`/`const`) are filtered out by the caller — those carry
     * a runtime-bound value, not a captured outer binding.
     */
    function collectDaemonKillCaptureNames(callExpr) {
      const out = [];
      if (!callExpr || callExpr.type !== "CallExpression") return out;
      const callee = callExpr.callee;
      if (!callee) return out;
      if (
        callee.type === "MemberExpression" &&
        callee.property &&
        callee.property.type === "Identifier" &&
        callee.property.name === "kill"
      ) {
        if (
          callee.object &&
          callee.object.type === "Identifier" &&
          callee.object.name === "process"
        ) {
          // process.kill(<expr>, "SIG...") — the kill target gates the
          // kill. Bare Identifier and member chains rooted in an outer
          // Identifier resolve to the root name; literals and call
          // expressions fall through to UNVERIFIABLE_KILL_TARGET.
          const first = callExpr.arguments[0];
          const root = extractRootCaptureIdentifierName(first);
          out.push(root === null ? UNVERIFIABLE_KILL_TARGET : root);
        } else if (callee.object) {
          // <expr>.kill("SIG...") — the receiver gates the kill. Bare
          // Identifier and member chains rooted in an outer Identifier
          // resolve to the root name; non-Identifier-rooted receivers
          // fall through to UNVERIFIABLE_KILL_TARGET.
          const root = extractRootCaptureIdentifierName(callee.object);
          out.push(root === null ? UNVERIFIABLE_KILL_TARGET : root);
        }
        return out;
      }
      if (callee.type === "Identifier") {
        if (
          callee.name === "killPid" ||
          callee.name === "stopDaemon" ||
          callee.name === "stopMockDaemon"
        ) {
          const first = callExpr.arguments[0];
          const root = extractRootCaptureIdentifierName(first);
          out.push(root === null ? UNVERIFIABLE_KILL_TARGET : root);
        }
        // runKspec/exec/spawn cleanup shapes resolve to "serve stop"
        // commands and don't need to capture an outer pid identifier —
        // the kspec CLI re-reads the pid file itself.
      }
      return out;
    }

    /**
     * True when `name` resolves at `useNode` to a binding whose stored
     * value is a concrete (non-null/non-undefined) value at the
     * registration site — so a cleanup callback that captures `name` has
     * a real pid/handle/stop-token to kill if the framework invokes it.
     *
     * The walk inspects each enclosing scope outward from `useNode`:
     *
     *   - Function-scope parameters → bound (the parameter slot carries
     *     a runtime value when the function is invoked).
     *   - In the scope's body, the most recent VariableDeclaration of
     *     `name` (textually before `useNode`) wins. A `const`/`let`/`var`
     *     declarator with a non-null/non-undefined initializer counts as
     *     bound. A declaration with no initializer or with a null /
     *     undefined / `void <expr>` initializer is unbound.
     *   - A subsequent assignment `name = <rhs>` (a top-level
     *     ExpressionStatement) before `useNode` re-binds: a non-
     *     null/undefined RHS sets bound, a null/undefined RHS clears it.
     *   - When the name is declared in this scope, the verdict is
     *     returned — outer scopes are not consulted (lexical shadowing).
     *   - When the name is not declared anywhere we can see, the binding
     *     is treated as bound. This is conservative: globals (`console`,
     *     `process`, etc.) appear as unbound free identifiers but are not
     *     unbound captures the rule cares about; treating them as unbound
     *     would cause spurious flagging.
     *
     * Conditional/loop assignments are NOT credited — the rule's
     * straight-line execution model only honours unconditional
     * statement-level assignments. An assignment buried inside an if/loop
     * cannot be relied on to bind the name before the registration runs.
     */
    function isIdentifierBoundConcretelyAt(name, useNode) {
      const usePos = getNodeStart(useNode);
      if (usePos < 0) return true;
      let current = useNode.parent;
      while (current) {
        if (
          current.type === "FunctionDeclaration" ||
          current.type === "FunctionExpression" ||
          current.type === "ArrowFunctionExpression"
        ) {
          for (const param of current.params || []) {
            if (patternBindsName(param, name)) return true;
          }
        }
        if (current.type === "ClassDeclaration" || current.type === "ClassExpression") {
          if (
            current.id &&
            current.id.type === "Identifier" &&
            current.id.name === name &&
            getNodeStart(current) < usePos
          ) {
            return true;
          }
        }
        if (
          (current.type === "BlockStatement" || current.type === "Program") &&
          current.body
        ) {
          const verdict = inspectStatementsForBinding(current.body, name, usePos);
          if (verdict !== null) return verdict;
        }
        current = current.parent;
      }
      // Not declared in any scope we can see — treat as bound (likely a
      // global or import). The rule does not care about captures of
      // globals/imports for daemon-kill correctness.
      return true;
    }

    function inspectStatementsForBinding(statements, name, usePos) {
      const state = {
        foundDeclaration: false,
        bound: false,
        foundFunctionDeclaration: false,
      };
      walkStatementsForBinding(statements, name, usePos, state);
      if (!state.foundDeclaration && !state.foundFunctionDeclaration) return null;
      if (state.foundFunctionDeclaration) return true;
      return state.bound;
    }

    /**
     * Recursive walker shared by `inspectStatementsForBinding`. Visits
     * the supplied statement list in source order and updates `state`
     * with declarations/assignments to `name` whose source position
     * starts before `usePos`. Descends into `TryStatement.block` and
     * `TryStatement.finalizer` because both run unconditionally on the
     * straight-line execution path: the try body always begins, and
     * the finalizer always fires when control crosses the try
     * boundary. The catch handler is conditional (only runs on
     * exception), so it is intentionally NOT descended.
     *
     * Cross-scope visibility: when an outer scope declares `let X;`
     * with no concrete init and a nested try body assigns `X = ...;`
     * before `usePos`, the descent surfaces the in-try assignment to
     * the outer scope's verdict, so the binding is considered bound at
     * `usePos`. This was the cycle-8 reviewer's finalizer safe-ordering
     * blocker: the prior walker only inspected statements at the same
     * level as the declaration and missed the in-try concrete write.
     */
    function walkStatementsForBinding(statements, name, usePos, state) {
      for (const stmt of statements) {
        if (!stmt) continue;
        const stmtStart = getNodeStart(stmt);
        if (stmtStart < 0 || stmtStart >= usePos) continue;
        if (stmt.type === "VariableDeclaration") {
          for (const declarator of stmt.declarations) {
            if (!declarator || !declarator.id) continue;
            if (declarator.id.type === "Identifier" && declarator.id.name === name) {
              state.foundDeclaration = true;
              if (
                declarator.init &&
                !isNullOrUndefinedInitializer(declarator.init)
              ) {
                state.bound = true;
              } else {
                state.bound = false;
              }
            } else if (patternBindsName(declarator.id, name)) {
              // Destructured binding (`const { kill } = …`) — the source
              // expression carries a runtime value, treat as bound when
              // the init exists at all (a null init would still bind
              // `kill` to undefined, but that case is uncommon and not
              // what the regression tests probe).
              state.foundDeclaration = true;
              state.bound = !!declarator.init;
            }
          }
          continue;
        }
        if (
          stmt.type === "FunctionDeclaration" &&
          stmt.id &&
          stmt.id.type === "Identifier" &&
          stmt.id.name === name
        ) {
          state.foundFunctionDeclaration = true;
          continue;
        }
        if (
          stmt.type === "ClassDeclaration" &&
          stmt.id &&
          stmt.id.type === "Identifier" &&
          stmt.id.name === name
        ) {
          state.foundDeclaration = true;
          state.bound = true;
          continue;
        }
        if (
          stmt.type === "ExpressionStatement" &&
          stmt.expression &&
          stmt.expression.type === "AssignmentExpression" &&
          stmt.expression.operator === "=" &&
          stmt.expression.left &&
          stmt.expression.left.type === "Identifier" &&
          stmt.expression.left.name === name
        ) {
          // Update bound regardless of whether a declaration has been
          // observed at this scope yet — when the declaration lives in
          // an outer scope, the descent surfaces the assignment to the
          // outer walker which then has both the declaration AND this
          // assignment recorded.
          state.bound = !isNullOrUndefinedInitializer(stmt.expression.right);
          continue;
        }
        if (stmt.type === "TryStatement") {
          if (stmt.block && Array.isArray(stmt.block.body)) {
            walkStatementsForBinding(stmt.block.body, name, usePos, state);
          }
          if (stmt.finalizer && Array.isArray(stmt.finalizer.body)) {
            walkStatementsForBinding(stmt.finalizer.body, name, usePos, state);
          }
          continue;
        }
      }
    }

    /**
     * Find the AST node that gave `name` its current concrete value at
     * `useNode`. Returns the most recent VariableDeclarator (with a
     * non-null/non-undefined initializer) or top-level AssignmentExpression
     * (with a non-null/non-undefined RHS) that runs before `useNode` —
     * the same predicates `isIdentifierBoundConcretelyAt` uses, but with
     * the binding NODE returned for ownership analysis. Returns null
     * when the binding is not a concrete value-producing statement
     * (parameter slot, class declaration, function declaration,
     * undeclared / global, or `let pid;` with no concrete assignment) —
     * none of those represent a daemon handle for ownership purposes.
     *
     * The returned node's range is what the caller compares to the
     * detached-start position: the binding is owned only when its
     * source range ends at or after the detached-start begins. That
     * captures the canonical safe shapes:
     *   - `runKspec(...); const pid = readPidFromFile()` — declarator
     *     ends after the detached start.
     *   - `const child = spawn("kspec", ["serve", "start", "--detach"])` —
     *     declarator's range ENCOMPASSES the detached-start expression
     *     (the spawn IS the daemon launch and the binding's initializer
     *     simultaneously).
     * And rejects the cycle-7 reviewer probe `const pid = 12345;
     * runKspec("serve start --detach"); onTestFinished(() => process.kill
     * (pid, "SIGTERM"))` — the declarator ends BEFORE the detached
     * start, so the captured `pid` cannot represent the just-started
     * daemon.
     */
    function findConcreteBindingNodeAt(name, useNode) {
      const usePos = getNodeStart(useNode);
      if (usePos < 0) return null;
      let current = useNode.parent;
      while (current) {
        if (
          current.type === "FunctionDeclaration" ||
          current.type === "FunctionExpression" ||
          current.type === "ArrowFunctionExpression"
        ) {
          for (const param of current.params || []) {
            if (patternBindsName(param, name)) return null;
          }
        }
        if (current.type === "ClassDeclaration" || current.type === "ClassExpression") {
          if (
            current.id &&
            current.id.type === "Identifier" &&
            current.id.name === name &&
            getNodeStart(current) < usePos
          ) {
            return null;
          }
        }
        if (
          (current.type === "BlockStatement" || current.type === "Program") &&
          current.body
        ) {
          const result = findConcreteBindingInStatements(current.body, name, usePos);
          if (result.declared) return result.node;
        }
        current = current.parent;
      }
      return null;
    }

    function findConcreteBindingInStatements(statements, name, usePos) {
      const state = { declared: false, node: null };
      walkStatementsForConcreteBinding(statements, name, usePos, state);
      return state;
    }

    /**
     * Recursive walker shared by `findConcreteBindingInStatements`.
     * Visits the supplied statement list in source order and updates
     * `state` with the most recent concrete binding (declarator with
     * non-null/non-undefined initializer or top-level assignment with
     * non-null/non-undefined RHS) for `name` whose source position
     * starts before `usePos`. Descent into `TryStatement.block` and
     * `TryStatement.finalizer` matches `walkStatementsForBinding`'s
     * unconditional-execution-path discipline so cross-scope
     * declarations (`let pid;` in an outer scope, `pid = X;` inside a
     * try block) resolve to the in-try assignment as the concrete
     * binding node — the cycle-8 reviewer's finalizer safe-ordering
     * blocker.
     */
    function walkStatementsForConcreteBinding(statements, name, usePos, state) {
      for (const stmt of statements) {
        if (!stmt) continue;
        const stmtStart = getNodeStart(stmt);
        if (stmtStart < 0 || stmtStart >= usePos) continue;
        if (stmt.type === "VariableDeclaration") {
          for (const declarator of stmt.declarations) {
            if (!declarator || !declarator.id) continue;
            if (declarator.id.type === "Identifier" && declarator.id.name === name) {
              state.declared = true;
              if (
                declarator.init &&
                !isNullOrUndefinedInitializer(declarator.init)
              ) {
                state.node = declarator;
              } else {
                state.node = null;
              }
            } else if (patternBindsName(declarator.id, name)) {
              state.declared = true;
              state.node = declarator.init ? declarator : null;
            }
          }
          continue;
        }
        if (
          stmt.type === "FunctionDeclaration" &&
          stmt.id &&
          stmt.id.type === "Identifier" &&
          stmt.id.name === name
        ) {
          // Function declarations are hoisted code, not daemon handles —
          // declared but never a concrete daemon-handle binding.
          state.declared = true;
          state.node = null;
          continue;
        }
        if (
          stmt.type === "ClassDeclaration" &&
          stmt.id &&
          stmt.id.type === "Identifier" &&
          stmt.id.name === name
        ) {
          // Class declarations are not daemon handles either.
          state.declared = true;
          state.node = null;
          continue;
        }
        if (
          stmt.type === "ExpressionStatement" &&
          stmt.expression &&
          stmt.expression.type === "AssignmentExpression" &&
          stmt.expression.operator === "=" &&
          stmt.expression.left &&
          stmt.expression.left.type === "Identifier" &&
          stmt.expression.left.name === name
        ) {
          // Update node regardless of whether a declaration has been
          // observed at this scope yet — when the declaration lives in
          // an outer scope, the descent surfaces the assignment to the
          // outer walker which has both the declaration AND this
          // assignment recorded.
          if (!isNullOrUndefinedInitializer(stmt.expression.right)) {
            state.node = stmt.expression;
          } else {
            state.node = null;
          }
          continue;
        }
        if (stmt.type === "TryStatement") {
          if (stmt.block && Array.isArray(stmt.block.body)) {
            walkStatementsForConcreteBinding(stmt.block.body, name, usePos, state);
          }
          if (stmt.finalizer && Array.isArray(stmt.finalizer.body)) {
            walkStatementsForConcreteBinding(
              stmt.finalizer.body,
              name,
              usePos,
              state,
            );
          }
          continue;
        }
      }
    }

    /**
     * Ownership predicate: does `name` resolve at the registration site
     * to a binding whose source range ends at or after the detached
     * daemon start AND no OTHER detached daemon start sits between
     * `detachedStartNode` and the binding? Returns true only when:
     *   1. There is a concrete value-producing binding (declarator with
     *      non-null/non-undefined init, or assignment with
     *      non-null/non-undefined RHS).
     *   2. The binding's range[1] >= detachedStartNode.range[0].
     *   3. No other detached-serve start in `pendingDetachChecks` has
     *      its source position strictly between
     *      `detachedStartNode.range[0]` (exclusive) and the binding's
     *      range[1] (inclusive).
     *
     * The "ends at or after" comparison handles two safe shapes:
     *   - The binding sits AFTER the detached start (`runKspec(...);
     *     const pid = readPidFromFile()`) — declarator ends well past
     *     the runKspec call.
     *   - The binding's initializer IS the detached start (`const child
     *     = spawn("kspec", ["serve", "start", "--detach"])`) — the
     *     declarator's range encompasses the spawn CallExpression, so
     *     the end is past the spawn's start.
     *
     * It rejects the probe shape `const pid = 12345; runKspec(...);
     * onTestFinished(() => process.kill(pid, ...))` — `pid` has a
     * concrete value but its declarator ends BEFORE the runKspec start,
     * so the cleanup closes over a value that cannot be the
     * just-started daemon.
     *
     * The intervening-start check rejects the cycle-8 reviewer probe:
     *   runKspec("serve start --detach --port 3456");  // start A
     *   runKspec("serve start --detach --port 3457");  // start B
     *   const pid = readPidFromFile();
     *   onTestFinished(() => process.kill(pid, "SIGTERM"));
     *   expect(true).toBe(true);
     * A single `pid` binding can only represent one daemon, so when
     * checking ownership of A by `pid`, the intervening start B falls
     * inside the (A.start, pid.end] window and the binding is rejected
     * as not owning A. Checking ownership of B by the same `pid`
     * binding still accepts (no other start sits between B and pid),
     * so the missing-cleanup diagnostic fires only on the earlier,
     * truly-unowned start. Per @daemon-test-guardrail-precision
     * ac-detached-cleanup-bound-before-observation: the cleanup must
     * own the daemon that was just started.
     */
    function isCaptureOwnedByDetachedStart(name, useNode, detachedStartNode) {
      const bindingNode = findConcreteBindingNodeAt(name, useNode);
      if (!bindingNode) return false;
      const bindingEnd = getNodeEnd(bindingNode);
      const detachedStart = getNodeStart(detachedStartNode);
      if (bindingEnd < 0 || detachedStart < 0) return false;
      if (bindingEnd < detachedStart) return false;
      for (const other of pendingDetachChecks) {
        if (other === detachedStartNode) continue;
        const otherStart = getNodeStart(other);
        if (otherStart < 0) continue;
        if (otherStart > detachedStart && otherStart <= bindingEnd) {
          return false;
        }
      }
      return true;
    }

    /**
     * Verify that the closure registered as a cleanup callback owns a
     * concrete pid / child-handle / stop-token at the registration site
     * for every daemon-kill call inside it. Returns true when every
     * captured outer identifier referenced by a recognised daemon-kill
     * shape is concretely bound at registration AND that binding
     * represents the just-started detached daemon (its source range
     * ends at or after `detachedStartNode` begins). Returns false when
     * at least one capture is statically unbound OR is bound to a value
     * that pre-dates the detached start, naming the offender via the
     * `unboundIdentifier` field.
     *
     * This is the static analogue of "the closure has something to kill,
     * AND that something is the daemon this test just started":
     *
     *   - `onTestFinished(() => process.kill(pid, …))` registered before
     *     the assignment that would set `pid` is no scoped cleanup at
     *     all — the framework invoking the callback finds `pid`
     *     undefined and `process.kill(undefined, …)` cannot kill the
     *     just-started detached daemon (the unbound case).
     *   - `const pid = 12345; runKspec("serve start --detach");
     *     onTestFinished(() => process.kill(pid, "SIGTERM"))` IS
     *     concretely bound, but `pid = 12345` was set BEFORE the daemon
     *     start, so the cleanup can kill an unrelated process while the
     *     new detached daemon leaks (the cycle-7 reviewer probe — the
     *     ownership case).
     *
     * `detachedStartNode` is required for the ownership check; the
     * caller passes the pending detached-start CallExpression. When it
     * is not available (legacy callers or non-detached cleanup audits),
     * pass `null` to skip the ownership leg and run only the
     * concretely-bound check.
     */
    function cleanupCallbackBindingStatus(callbackFn, registrationCall, detachedStartNode) {
      if (!callbackFn) return { bound: true, unboundIdentifier: null };
      const checked = new Set();
      const stack = [callbackFn.body];
      while (stack.length > 0) {
        const node = stack.pop();
        if (!node || typeof node !== "object" || typeof node.type !== "string") {
          continue;
        }
        if (
          node !== callbackFn.body &&
          (node.type === "FunctionDeclaration" ||
            node.type === "FunctionExpression" ||
            node.type === "ArrowFunctionExpression")
        ) {
          // Nested function bodies are not on the cleanup callback's
          // straight-line execution path. They are stored, not invoked
          // by the framework's cleanup hook, so a daemon-kill inside is
          // not the cleanup we are validating.
          continue;
        }
        if (
          node.type === "CallExpression" &&
          isDaemonCleanupCallExpression(node)
        ) {
          const captures = collectDaemonKillCaptureNames(node);
          for (const name of captures) {
            if (checked.has(name)) continue;
            checked.add(name);
            if (name === UNVERIFIABLE_KILL_TARGET) {
              // Non-Identifier-rooted kill target (literal pid, call
              // expression, etc.) — cannot be statically tied to the
              // just-started daemon, so reject as unbound. The
              // diagnostic surfaces the sentinel so the author sees
              // that the target is the problem rather than a real
              // missing variable.
              return { bound: false, unboundIdentifier: UNVERIFIABLE_KILL_TARGET };
            }
            if (isLocalToCallback(name, callbackFn)) {
              // The kill target is declared inside the cleanup callback,
              // not captured from outer scope, so the closure does not
              // own a concrete pid / handle / token at registration
              // time — the binding only acquires a value when the
              // callback runs at teardown. The cycle-4 reviewer probe
              //   runKspec("serve start --detach");
              //   onTestFinished(() => {
              //     const pid = readPidFromFile();
              //     process.kill(pid, "SIGTERM");
              //   });
              //   expect(true).toBe(true);
              // disproves the previous "dynamic RHS plausibly reads at
              // cleanup time" exemption: per
              // ac-detached-cleanup-bound-before-observation, ownership
              // must hold AT REGISTRATION TIME so the cleanup contract
              // survives an intervening assertion failure. A
              // callback-local target can never satisfy that — even a
              // CallExpression initializer (`readPidFromFile()`) is
              // evaluated at teardown, not at registration. Always
              // reject; the diagnostic asks the author to capture the
              // pid (or spawn child handle) into an outer `const`
              // before the registration call.
              return { bound: false, unboundIdentifier: name };
            }
            if (!isIdentifierBoundConcretelyAt(name, registrationCall)) {
              return { bound: false, unboundIdentifier: name };
            }
            if (
              detachedStartNode &&
              !isCaptureOwnedByDetachedStart(name, registrationCall, detachedStartNode)
            ) {
              return { bound: false, unboundIdentifier: name };
            }
          }
        }
        for (const key in node) {
          if (
            key === "parent" ||
            key === "loc" ||
            key === "range" ||
            key === "start" ||
            key === "end" ||
            key === "type" ||
            key === "tokens" ||
            key === "comments"
          ) {
            continue;
          }
          const child = node[key];
          if (Array.isArray(child)) {
            for (const c of child) {
              if (c && typeof c === "object" && typeof c.type === "string") {
                stack.push(c);
              }
            }
          } else if (child && typeof child === "object" && typeof child.type === "string") {
            stack.push(child);
          }
        }
      }
      return { bound: true, unboundIdentifier: null };
    }

    /**
     * Find the implicit "registration site" for a direct daemon-cleanup
     * call that is NOT wrapped in a recognised cleanup-registration
     * callback. Walks the parent chain from `callNode` to the first
     * enclosing `TryStatement`. When the detached daemon start lives
     * inside that try block, the captured pid/handle must be concrete
     * by the time the FIRST observation in the try body (after the
     * detached start) can fire — if such an observation throws, the
     * finalizer fires with the binding in its current state. The use
     * node is therefore set to that first observation's containing
     * statement; bindings written before that statement (including
     * inside the try body) are owned by the detached start. When the
     * try body has no observation after the detached start, the only
     * way the finalizer fires is normal try-block completion (or an
     * exception in a non-observation statement), and the binding only
     * needs to be in scope at the cleanup call itself.
     *
     * The cycle-7 implementation incorrectly used the TryStatement
     * itself as the use node, requiring the binding to predate the
     * `try` keyword. That rejected the safe shape:
     *
     *   let pid;
     *   try {
     *     runKspec("serve start --detach --port 3456");
     *     pid = readPidFromFile();         // assignment BEFORE observation
     *     expect(true).toBe(true);          // first observation
     *   } finally {
     *     if (pid !== undefined) process.kill(pid, "SIGTERM");
     *   }
     *
     * That ordering matches the allowed registered-callback shape
     * `runKspec(...); const pid = readPidFromFile(); onTestFinished(...)`:
     * by the time the first observation can fail, the cleanup target
     * is already bound to the just-started daemon. The cycle-8
     * reviewer's blocker.
     *
     * When the detached start is OUTSIDE the enclosing try block, the
     * try-entry semantic still applies (the binding must predate the
     * try keyword, since any in-try statement can throw at the very
     * first instruction). When no enclosing TryStatement is found,
     * the call itself is the "registration" — sibling-scope direct
     * cleanup runs only if the test reaches that statement, and any
     * binding visible there is in scope.
     *
     * Used by `directCleanupCallOwnsDetachedDaemon` and the diagnostic
     * scanner `findUnboundDirectCleanupCapture` to keep both paths in
     * agreement on which AST position gates the capture's ownership.
     */
    function findDirectCleanupRegistrationUseNode(callNode, detachedStartNode) {
      let current = callNode && callNode.parent;
      while (current) {
        if (current.type === "TryStatement") {
          if (detachedStartNode && current.block) {
            const detachedPos = getNodeStart(detachedStartNode);
            const tryBodyStart = getNodeStart(current.block);
            const tryBodyEnd = getNodeEnd(current.block);
            if (
              detachedPos >= 0 &&
              tryBodyStart >= 0 &&
              tryBodyEnd >= 0 &&
              detachedPos >= tryBodyStart &&
              detachedPos < tryBodyEnd
            ) {
              const firstObservation = findFirstObservationInTryBody(
                current.block,
                detachedPos,
              );
              if (firstObservation) return firstObservation;
              // No observation after the detached start in the try
              // body — the binding only needs to be in scope at the
              // cleanup call site itself.
              return callNode;
            }
          }
          return current;
        }
        current = current.parent;
      }
      return callNode;
    }

    /**
     * Walk a try block's direct statements and return the first one
     * whose position is strictly after `afterPos` AND that contains an
     * observation on its straight-line execution path
     * (`subtreeContainsAwaitOrExpect`: `await`, `expect(...)`,
     * `fetch(<daemon-url>)`, or `new WebSocket(<daemon-url>)`).
     * Returns null when no such statement exists.
     *
     * Used by `findDirectCleanupRegistrationUseNode` to locate the
     * earliest in-try observation that could throw and trigger the
     * finalizer; the captured pid/handle must be concrete before that
     * statement so the finalizer holds a valid kill target if the
     * observation fails.
     */
    function findFirstObservationInTryBody(tryBlock, afterPos) {
      if (!tryBlock || !Array.isArray(tryBlock.body)) return null;
      for (const stmt of tryBlock.body) {
        if (!stmt) continue;
        const stmtStart = getNodeStart(stmt);
        if (stmtStart < 0 || stmtStart <= afterPos) continue;
        if (subtreeContainsAwaitOrExpect(stmt)) {
          return stmt;
        }
      }
      return null;
    }

    /**
     * True when a direct daemon-cleanup CallExpression (one that is NOT
     * inside a recognised cleanup-registration callback) has every
     * captured outer identifier concretely owned by the just-started
     * detached daemon at the cleanup's implicit registration site
     * (`findDirectCleanupRegistrationUseNode`). Mirrors the registered-
     * callback path's `cleanupCallbackBindingStatus`, applied to the
     * try/finally finalizer (and any other direct cleanup) instead of
     * an `onTestFinished` callback body. The cycle-7 reviewer probe
     * (`let pid; try { runKspec("serve start --detach"); expect(...);
     * pid = readPidFromFile(); } finally { process.kill(pid as number,
     * "SIGTERM"); }`) bypassed the binding-status check because the
     * subtree walker matched the finalizer's `process.kill(pid, ...)`
     * on shape only — accepting it crediting cleanup even though `pid`
     * is set AFTER an intervening assertion that can throw, leaving
     * the detached daemon to leak. This predicate closes that hole by
     * applying the same ownership rules the registered-callback case
     * uses.
     *
     * Returns true (call counts as cleanup) when there is no
     * `detachedStartNode` to compare against — the ownership leg is
     * informational only when the caller has not provided the
     * just-started daemon node (legacy callers / non-detached audits).
     */
    function directCleanupCallOwnsDetachedDaemon(callNode, detachedStartNode) {
      if (!detachedStartNode) return true;
      const useNode = findDirectCleanupRegistrationUseNode(
        callNode,
        detachedStartNode,
      );
      const captures = collectDaemonKillCaptureNames(callNode);
      for (const name of captures) {
        if (name === UNVERIFIABLE_KILL_TARGET) {
          // Non-Identifier-rooted kill target (literal pid, call
          // expression, etc.) — cannot be statically tied to the just-
          // started daemon. Reject.
          return false;
        }
        if (!isIdentifierBoundConcretelyAt(name, useNode)) {
          return false;
        }
        if (!isCaptureOwnedByDetachedStart(name, useNode, detachedStartNode)) {
          return false;
        }
      }
      return true;
    }

    /**
     * Walk an AST subtree and return true when any descendant CallExpression
     * matches `isDaemonCleanupCallExpression` AT A POSITION THAT WILL
     * ACTUALLY EXECUTE.
     *
     * Function and arrow bodies are descended ONLY when the function or
     * arrow is itself an argument to a recognised cleanup-registration
     * wrapper (see `isCleanupRegistrationCallback`). Bodies of unregistered
     * functions, arrows assigned to a binding, callbacks passed to
     * unrelated callees, methods on an unused object, etc. are NOT
     * descended — code in them is stored, not executed, so a daemon-kill
     * CallExpression inside is not registered cleanup.
     *
     * Non-AST keys (`parent`, `loc`, `range`, `start`, `end`, `type`,
     * `tokens`, `comments`) are skipped so the walk is O(AST nodes) and
     * does not recurse into source-position metadata.
     *
     * The cycle-3 reviewer's blocker case demonstrates the gating:
     *
     *   runKspec("serve start --detach --port 3456");
     *   const cleanup = () => killPid(pid);   // unregistered arrow
     *   expect(true).toBe(true);
     *
     * The arrow's body contains a `killPid(pid)` CallExpression that
     * matches the cleanup shape, but the arrow is bound to `cleanup` and
     * never invoked — so the detached daemon is left running when the
     * assertion runs. The earlier walker descended into all function
     * bodies and accepted the unregistered arrow as cleanup; this walker
     * stops at the arrow because its parent is a VariableDeclarator, not
     * a registration call, and correctly returns false so the missing-
     * cleanup violation is reported.
     *
     * The valid `onTestFinished(() => killPid(pid))` shape still classifies
     * as cleanup: the arrow's parent is a CallExpression whose callee
     * Identifier is `onTestFinished`, so the walker descends into the
     * arrow's body and finds the `killPid(pid)` call.
     */
    function subtreeContainsDaemonCleanupCall(
      node,
      insideRegisteredCallback,
      detachedStartNode,
      inFinalizerContext,
    ) {
      if (!node || typeof node !== "object" || typeof node.type !== "string") {
        return false;
      }
      if (
        node.type === "FunctionDeclaration" ||
        node.type === "FunctionExpression" ||
        node.type === "ArrowFunctionExpression"
      ) {
        if (!isCleanupRegistrationCallback(node)) {
          return false;
        }
        // Inside a registered callback the framework invokes the body
        // at the cleanup boundary, so the body executes — even if the
        // body has its own internal conditionals. Conditional kill
        // shapes inside a registered cleanup callback (a defensive
        // guard like `if (pid) killPid(pid)`) ARE valid cleanup; the
        // pruning below is therefore disabled once descent reaches a
        // registered callback. The REGISTRATION itself, however, must
        // still be unconditional in the surrounding scope (the cycle-4
        // reviewer's `if (shouldCleanup) onTestFinished(...)` probe).
        insideRegisteredCallback = true;
        // Cleanup-binding check: even if the callback contains a
        // daemon-kill CallExpression that the framework will invoke at
        // teardown, the kill is meaningless when the closure captures
        // an outer identifier that has no concrete pid/handle at
        // registration time, OR has a concrete value that pre-dates
        // the just-started daemon (cycle-7 ownership probe). The
        // framework invokes the body, but the body sees `process.kill
        // (undefined, ...)` on a null binding, or `process.kill(<stale
        // pid>, ...)` on a literal-bound `const pid = 12345`, and the
        // detached daemon stays running. Reject the callback as cleanup
        // when any captured outer identifier is unbound or unowned at
        // the registration site.
        const status = cleanupCallbackBindingStatus(node, node.parent, detachedStartNode);
        if (!status.bound) {
          return false;
        }
      }
      if (isDaemonCleanupCallExpression(node)) {
        // Inside a registered callback the cleanupCallbackBindingStatus
        // check at the callback's entry has already validated that every
        // captured outer identifier owns a concrete pid/handle for the
        // just-started daemon — the call here is on the framework's
        // teardown path, so accept it.
        if (insideRegisteredCallback) return true;
        // Direct cleanup outside a registered callback (typically a
        // try/finally finalizer; see `isInTryWithFinallyCleanup`). The
        // finalizer fires when the surrounding `try` block exits,
        // including via an exception thrown anywhere in that block, so
        // the captured pid/handle must already be concrete at the
        // moment the `try` is entered — same ownership semantic as the
        // registered-callback case, but the implicit registration site
        // is the enclosing `try` statement (the kill closure is
        // installed when control crosses the `try` boundary). The
        // cycle-7 reviewer probe `let pid; try { runKspec("serve start
        // --detach"); expect(true).toBe(true); pid = readPidFromFile();
        // } finally { process.kill(pid as number, "SIGTERM"); }`
        // motivated this: the prior implementation accepted the
        // finalizer's `process.kill(pid, ...)` purely on shape, even
        // though `pid = readPidFromFile()` sits AFTER an intervening
        // assertion — if the assertion threw, the finalizer would run
        // with `pid` undefined and the detached daemon would leak,
        // violating @daemon-test-guardrail-precision
        // ac-detached-cleanup-bound-before-observation.
        if (
          !directCleanupCallOwnsDetachedDaemon(node, detachedStartNode)
        ) {
          return false;
        }
        return true;
      }

      // Conditional control-flow shapes outside a registered callback
      // AND outside a finalizer-walk context: do NOT descend into
      // branches whose execution is not guaranteed on the straight-line
      // path between the detached daemon start and the next
      // observation. Cleanup REGISTRATION that lives inside a
      // conditional consequent/alternate, a loop body that may iterate
      // zero times, a switch case, a logical short-circuit right-hand
      // side, or a catch handler is not guaranteed to fire before the
      // next test observation — semantically it is the same as no
      // cleanup.
      //
      // The cycle-4 reviewer probes (`if (false) killPid(p)` and
      // `if (shouldCleanup) onTestFinished(() => killPid(p))`) both
      // relied on descent into a top-level conditional. Pruning here
      // makes them flag, while the existing valid pattern of writing
      // a defensive guard INSIDE a registered cleanup callback (e.g.
      // `onTestFinished(() => { if (pid) killPid(pid); })`) keeps
      // working because the `insideRegisteredCallback` flag flips when
      // descent crosses the registration boundary.
      //
      // The `inFinalizerContext` flag flips on for finalizer walks
      // initiated by `isInTryWithFinallyCleanup`. Inside a finalizer,
      // the cleanup CALL may be defensively guarded (e.g. `if (pid !==
      // undefined) process.kill(pid, "SIGTERM")`) — the guard does
      // not change the cleanup intent, and the OWNERSHIP analysis on
      // each daemon-cleanup CallExpression
      // (`directCleanupCallOwnsDetachedDaemon`) still gates whether
      // the call actually counts as cleanup for the just-started
      // daemon. The cycle-8 reviewer's safe-ordering probe `let pid;
      // try { runKspec("serve start --detach"); pid =
      // readPidFromFile(); expect(...); } finally { if (pid !==
      // undefined) process.kill(pid, "SIGTERM"); }` motivated this:
      // refusing to descend into the IF guard left the cleanup
      // unrecognised even though the binding ordering matched the
      // accepted registered-callback shape `runKspec(); const pid =
      // readPidFromFile(); onTestFinished(...)`.
      if (!insideRegisteredCallback && !inFinalizerContext) {
        if (node.type === "IfStatement") return false;
        if (node.type === "ConditionalExpression") return false;
        if (node.type === "LogicalExpression") {
          // `a && b`, `a || b`, `a ?? b` — `b` may short-circuit. The
          // left-hand side always runs, but cleanup written there
          // would be deeply unidiomatic; skip the whole expression.
          return false;
        }
        if (
          node.type === "WhileStatement" ||
          node.type === "DoWhileStatement" ||
          node.type === "ForStatement" ||
          node.type === "ForInStatement" ||
          node.type === "ForOfStatement"
        ) {
          return false;
        }
        if (node.type === "SwitchStatement") return false;
        if (node.type === "TryStatement") {
          // The try block always begins executing, and the finalizer
          // always runs, so cleanup in either is on the unconditional
          // path. The handler runs only when an exception is thrown,
          // so it is conditional — do not descend.
          if (
            node.block &&
            subtreeContainsDaemonCleanupCall(node.block, false, detachedStartNode, false)
          ) {
            return true;
          }
          if (
            node.finalizer &&
            subtreeContainsDaemonCleanupCall(node.finalizer, false, detachedStartNode, true)
          ) {
            return true;
          }
          return false;
        }
      }

      for (const key in node) {
        if (
          key === "parent" ||
          key === "loc" ||
          key === "range" ||
          key === "start" ||
          key === "end" ||
          key === "type" ||
          key === "tokens" ||
          key === "comments"
        ) {
          continue;
        }
        const child = node[key];
        if (Array.isArray(child)) {
          for (const c of child) {
            if (subtreeContainsDaemonCleanupCall(c, insideRegisteredCallback, detachedStartNode, inFinalizerContext)) {
              return true;
            }
          }
        } else if (child && typeof child === "object" && typeof child.type === "string") {
          if (subtreeContainsDaemonCleanupCall(child, insideRegisteredCallback, detachedStartNode, inFinalizerContext)) {
            return true;
          }
        }
      }
      return false;
    }

    /**
     * True when a sibling statement (after a detached daemon start, before
     * the next observation) registers cleanup that targets the just-started
     * daemon. Cleanup must be an actual CallExpression with a
     * daemon-cleanup shape (see `isDaemonCleanupCallExpression`) AND must
     * appear at a position that will execute — the walker descends into
     * function/arrow bodies only when the function/arrow is itself an
     * argument to a recognised cleanup-registration wrapper
     * (`onTestFinished`, `process.on(<exit-event>, …)`). Lifecycle hooks
     * (`afterEach`/`afterAll`/`beforeEach`/`beforeAll`) are intentionally
     * not recognised; see `CLEANUP_REGISTRATION_WRAPPER_NAMES`. See
     * `subtreeContainsDaemonCleanupCall`.
     *
     * Token-only text matches (e.g. `console.log("SIGTERM docs")`,
     * `const cleanupDocs = "killPid should be used later"`) and
     * cleanup-shaped calls inside an unregistered function body
     * (e.g. `const cleanup = () => killPid(pid);` — the cycle-3 reviewer
     * blocker) are NOT cleanup.
     */
    function statementContainsCleanup(stmt, detachedStartNode) {
      return subtreeContainsDaemonCleanupCall(stmt, false, detachedStartNode);
    }

    /**
     * True when a sibling statement contains an `await`, a direct
     * `expect(...)` call, or a daemon network observation — any of these
     * is treated as the next "test observation" by `hasCleanupAfter`, so
     * cleanup MUST be registered before this statement. The check is
     * AST-based so kill-token text inside string literals and comments
     * cannot mask it (the symmetric tightening to the cleanup predicate
     * above).
     *
     * Observations recognised on the straight-line execution path:
     *   - `AwaitExpression` — the next `await` is the closest synchronous
     *     suspension point and rejects propagate as test failures.
     *   - `expect(...)` — direct vitest expectation.
     *   - `fetch(<daemon-url>)` — daemon network observation. Even an
     *     unawaited fetch initiates an HTTP request to the daemon, so any
     *     error (connection refused, abort) surfaces as a test failure
     *     before a later cleanup registration can run (the cycle-5
     *     reviewer blocker on `@daemon-test-guardrail-precision`
     *     `ac-detached-cleanup-before-observation`: `fetch
     *     ("http://127.0.0.1:3456/api/health")` between the detached
     *     start and `onTestFinished` was not credited as an observation,
     *     leaving the AC under-implemented for non-await daemon
     *     observation calls). The cycle-6 reviewer blocker tightened this
     *     gate to require a daemon URL — bare `fetch("https://example.com
     *     /health")` between the detached start and `onTestFinished` is
     *     NOT a daemon observation and must not trigger the cleanup-
     *     timing report. URL detection reuses the rule's existing
     *     `isFetchOfLocalhostUrl` predicate so the observation surface
     *     stays aligned with the daemon-URL surface.
     *   - `new WebSocket(<daemon-url>)` — daemon WebSocket observation.
     *     The constructor opens a connection to the daemon synchronously,
     *     so a connection failure surfaces before subsequent cleanup can
     *     register. Same URL-filtered semantics as `fetch` — a
     *     `new WebSocket("wss://example.com/...")` is not a daemon
     *     observation.
     *
     * Stored function bodies are NOT on the straight-line path. The
     * walker prunes descent into `FunctionDeclaration`,
     * `FunctionExpression`, and `ArrowFunctionExpression` bodies unless
     * the function is invoked immediately as an IIFE
     * (`(() => expect(true).toBe(true))()`). The cycle-5 reviewer's
     * blocker case demonstrates the gating:
     *
     *   runKspec("serve start --detach --port 3456");
     *   const later = () => expect(true).toBe(true);  // STORED
     *   const pid = readPidFromFile();
     *   onTestFinished(() => killPid(pid));
     *   later();
     *
     * The arrow's body contains `expect(true).toBe(true)` but the arrow
     * is bound to `later` and only invoked after cleanup is registered.
     * The earlier walker descended into all function/arrow bodies and
     * treated stored expects as observations, falsely reporting
     * `missingCleanup` when cleanup IS registered before the function is
     * actually invoked. This walker stops at the arrow because its
     * parent is a `VariableDeclarator`, not an immediately-invoked
     * CallExpression in callee position, and correctly continues so the
     * later `onTestFinished(...)` registration is recognised as
     * cleanup.
     *
     * Symmetric to the cleanup walker (`subtreeContainsDaemonCleanupCall`):
     * cleanup gating accepts function bodies registered as cleanup
     * callbacks (run at teardown); observation gating accepts function
     * bodies invoked immediately (run at this statement).
     */
    function statementContainsAwaitOrExpect(stmt) {
      return subtreeContainsAwaitOrExpect(stmt);
    }

    /**
     * True when a function/arrow node is in the callee position of its
     * parent CallExpression — i.e. an IIFE such as `(() => …)()` whose
     * body executes at this statement. Arrows or functions in argument
     * slots, on the right-hand side of an assignment, in array elements,
     * or anywhere else are stored, not invoked, and their bodies are
     * NOT on the straight-line execution path.
     */
    function isImmediatelyInvokedFunctionExpression(fnNode) {
      if (!fnNode) return false;
      const parent = fnNode.parent;
      if (!parent || parent.type !== "CallExpression") return false;
      return parent.callee === fnNode;
    }

    function subtreeContainsAwaitOrExpect(node) {
      if (!node || typeof node !== "object" || typeof node.type !== "string") {
        return false;
      }
      // Function/arrow bodies are stored, not on the straight-line path
      // — except IIFEs, where the body executes at this statement.
      if (
        node.type === "FunctionDeclaration" ||
        node.type === "FunctionExpression" ||
        node.type === "ArrowFunctionExpression"
      ) {
        if (!isImmediatelyInvokedFunctionExpression(node)) {
          return false;
        }
      }
      if (node.type === "AwaitExpression") return true;
      if (node.type === "CallExpression" && node.callee) {
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "expect"
        ) {
          return true;
        }
        // Daemon network observation: a `fetch(<daemon-url>)` call where
        // the first argument resolves to a loopback host+port URL. The
        // URL filter is required (cycle-6 reviewer blocker) — a bare
        // `fetch("https://example.com/health")` between the detached
        // start and the cleanup registration is not a daemon
        // observation, and crediting it produces a false positive on
        // unrelated network calls. URL recognition uses the broader
        // `isFetchOfDaemonHostUrl` predicate (matching `localhost:`,
        // `127.0.0.1:`, and `[::1]:` host forms with explicit ports)
        // because tests legitimately reach the daemon via
        // `127.0.0.1:<port>` (the cycle-5 fetch regression test). The
        // narrower `isFetchOfLocalhostUrl` reporting predicate is
        // intentionally untouched. Member-form callees
        // (`http.get(...)`, `axios.get(...)`, etc.) are not matched
        // because the URL surface only recognises Identifier `fetch`.
        if (isFetchOfDaemonHostUrl(node)) {
          return true;
        }
      }
      // Daemon WebSocket observation: `new WebSocket(<daemon-url>)`
      // opens a connection synchronously. URL-filtered against the
      // broader loopback-host predicate so a
      // `new WebSocket("wss://example.com/...")` does not register as a
      // daemon observation.
      if (
        node.type === "NewExpression" &&
        isWebSocketCtorOfDaemonHostUrl(node)
      ) {
        return true;
      }
      for (const key in node) {
        if (
          key === "parent" ||
          key === "loc" ||
          key === "range" ||
          key === "start" ||
          key === "end" ||
          key === "type" ||
          key === "tokens" ||
          key === "comments"
        ) {
          continue;
        }
        const child = node[key];
        if (Array.isArray(child)) {
          for (const c of child) {
            if (subtreeContainsAwaitOrExpect(c)) return true;
          }
        } else if (child && typeof child === "object" && typeof child.type === "string") {
          if (subtreeContainsAwaitOrExpect(child)) return true;
        }
      }
      return false;
    }

    /**
     * Sentinel inserted into the kspec-args token list when an argument
     * (or argv array element) does not statically resolve to a string —
     * e.g. an Identifier reference, a SpreadElement, a BinaryExpression.
     * The sentinel intentionally does NOT match `"serve"`, `"start"`, or
     * `"--detach"`, so an opaque element that occupies a positional slot
     * will defeat the kspec subcommand check (`positional1 === "serve" &&
     * positional2 === "start"`). Preferring a false negative here over a
     * false positive matches the rule's overall philosophy: when the
     * classifier cannot prove the kspec subcommand path is `serve start`,
     * it must NOT report the call as a detached daemon launch (the
     * cycle-3 false-positive blocker on
     * `@daemon-test-guardrail-precision`
     * `ac-unrelated-subprocesses-not-reported`).
     */
    const OPAQUE_ARG_SENTINEL = "<expr>";

    /**
     * True when a kspec-args token list resolves to a detached daemon
     * lifecycle invocation: the first two non-flag positional tokens are
     * `serve` then `start`, AND `--detach` (bare or `--detach=…` bundled
     * form) appears as a flag token.
     *
     * Tokens are classified by shape — a token that begins with `-` is a
     * flag (and may have a bundled `=value`); anything else is a
     * positional. Only the first two positionals are inspected for the
     * subcommand path; later positionals are subcommand arguments and do
     * not change the classification.
     *
     * Critically, this is NOT a substring scan over the joined args. The
     * cycle-12 reviewer's blocker case
     * `exec("kspec search \"serve start --detach\"")` tokenises (quote-
     * aware) to `["kspec", "search", "serve start --detach"]` — after
     * dropping the kspec executable token the kspec subcommand is
     * `search`, not `serve start`. The second positional is the literal
     * three-word string `serve start --detach` (one OS argv slot, never
     * re-split by the shell because of the inner quotes), and that
     * single-token positional cannot satisfy `positional2 === "start"`.
     * Likewise `spawn("kspec", ["search", "serve start --detach"])`
     * walks two argv elements as two positionals (`search` and the
     * three-word string) — kspec receives `argv[2] = "serve start
     * --detach"` as an unknown subcommand and never reaches the daemon
     * lifecycle path. Both cases must NOT be reported (cycle-12 blocker
     * on `@daemon-test-guardrail-precision`
     * `ac-unrelated-subprocesses-not-reported`).
     *
     * The caller is responsible for stripping the kspec executable token
     * (for shell strings) or excluding `args[0]` (for spawn-like argv
     * callees) so the executable name is not mis-counted as the first
     * positional.
     */
    function tokensResolveToDetachedServe(tokens) {
      let positional1 = null;
      let positional2 = null;
      let hasDetach = false;
      for (const token of tokens) {
        if (typeof token !== "string" || token.length === 0) continue;
        if (token[0] === "-") {
          if (token === "--detach" || token.startsWith("--detach=")) {
            hasDetach = true;
          }
          continue;
        }
        if (positional1 === null) {
          positional1 = token;
        } else if (positional2 === null) {
          positional2 = token;
        }
      }
      return positional1 === "serve" && positional2 === "start" && hasDetach;
    }

    /**
     * Collect the kspec-args token list contributed by an ArrayExpression
     * argument (the spawn-like argv form). Each element produces exactly
     * ONE token — the spawn-family child-process APIs preserve element
     * boundaries, so a single argv element such as `"serve start --detach"`
     * is a single OS argv slot the kspec CLI sees verbatim, NOT three
     * separate args. Splitting that element on whitespace would silently
     * reintroduce the cycle-12 false positive on
     * `spawn("kspec", ["search", "serve start --detach"])`.
     *
     * Statically-readable elements (string Literal, no-substitution
     * TemplateLiteral, TemplateLiteral with `${...}` placeholders
     * preserved by `argvElementToString`) contribute their resolved
     * string. Opaque elements (Identifier, SpreadElement, computed
     * expressions) contribute the OPAQUE_ARG_SENTINEL so they cannot
     * silently satisfy a positional-equality check while still occupying
     * a positional slot.
     */
    function collectArgvArrayTokens(arrayArg) {
      const out = [];
      if (!arrayArg || arrayArg.type !== "ArrayExpression") return out;
      for (const el of arrayArg.elements) {
        if (!el) continue;
        if (el.type === "SpreadElement") {
          out.push(OPAQUE_ARG_SENTINEL);
          continue;
        }
        const tokenStr = argvElementToString(el);
        if (tokenStr === null) {
          out.push(OPAQUE_ARG_SENTINEL);
          continue;
        }
        out.push(tokenStr);
      }
      return out;
    }

    /**
     * Collect the kspec-args token list contributed by a single argument
     * to a `runKspec`/`kspec` helper call. The helper's contract (see
     * `tests/helpers/cli.ts`'s `kspec(args: string, …)` and the
     * `runKspec(args: string, …)` wrapper) is that the first parameter is
     * a SHELL-STYLE space-separated args string forwarded to the kspec
     * CLI through a shell, so a string argument is tokenised quote-aware
     * via `tokenizeShellCommand` (the same tokeniser the shell-string
     * `exec`/`execSync` callees use). An ArrayExpression argument is
     * treated as the argv form (one token per element). Other argument
     * shapes contribute one OPAQUE_ARG_SENTINEL so an opaque value
     * occupying a positional slot defeats the subcommand match.
     */
    function collectKspecHelperArgTokens(arg) {
      if (!arg) return [];
      const literal = literalString(arg);
      if (literal !== null) {
        return tokenizeShellCommand(literal) || [];
      }
      const tmpl = templateLiteralRaw(arg);
      if (tmpl !== null) {
        return tokenizeShellCommand(tmpl) || [];
      }
      if (arg.type === "ArrayExpression") {
        return collectArgvArrayTokens(arg);
      }
      return [OPAQUE_ARG_SENTINEL];
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
     *      `--help`, `--check`, `--syntax-check`, plus `-c` when the
     *      runtime is Node) → return -1 to abort. The runtime evaluates
     *      inline source, prints info, exits, or only parses the script
     *      — no script is ever executed, so a daemon-entry token after
     *      them is not a daemon launch. Without modelling these, the
     *      argv-array branch was reporting `spawn("node", ["--eval",
     *      DAEMON_ENTRY])` and `execFile("node", ["--version",
     *      DAEMON_ENTRY])` as direct daemon launches (the false-positive
     *      blocker from review cycle 9), and `execSync("node --check
     *      dist/daemon/index.js")` as a launch even though `--check`
     *      only syntax-checks (the false-positive blocker from review
     *      cycle 10).
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
     *
     * The `runtime` parameter — `"node"`, `"bun"`, or `null` — gates
     * runtime-ambiguous short flags (e.g. `-c`). Pass the runtime
     * classification of args[0] from the spawn-like call so Node's
     * parse-only `-c` is recognised but Bun's `-c, --config <path>`
     * (value-consuming) is not silently treated as no-script.
     */
    function findScriptPositionInArgvArray(arrayArg, runtime) {
      if (!arrayArg || arrayArg.type !== "ArrayExpression") return -1;
      const elements = arrayArg.elements;
      for (let i = 0; i < elements.length; i += 1) {
        const el = elements[i];
        if (!el) continue;
        const tokenStr = argvElementToString(el);
        if (tokenStr !== null) {
          if (isShellRuntimeNoScriptFlag(tokenStr, runtime)) return -1;
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
     * The set covers every Node CLI option (and the Bun-specific options
     * we recognise) documented as accepting a value via whitespace
     * separation (`--flag value`). Inclusion requires that the option
     * both (a) appears in the runtime's documented CLI options, and
     * (b) accepts a value via whitespace separation (not just the bundled
     * `=` form). Standalone boolean flags MUST NOT be listed here —
     * modelling them as value-consuming causes the walker to skip a real
     * script path token, silently accepting daemon launches like
     * `node --use-openssl-ca dist/daemon/index.js` (the false-negative
     * blocker from review cycle 8).
     *
     * Coverage philosophy: every documented value-consuming Node option
     * is enumerated here. A "conservative" set leaves false negatives —
     * each missing option silently accepts a real `node --flag value
     * dist/daemon/index.js` daemon launch (cycle 7 blocker for
     * `--require`, cycle 11 blocker for `--import` and `--env-file`).
     * The audit was performed against `node --help` for every flag
     * documented as `--flag=...` (the help syntax for value-consuming
     * options), then verified with a `node --flag value /tmp/script.js`
     * probe to confirm whitespace-separated value consumption. New
     * runtime options added by future Node versions must be added here
     * after running the same audit.
     *
     * Common standalone-flag mistakes to avoid: `--use-openssl-ca`,
     * `--use-bundled-ca`, `--use-system-ca`, `--use-env-proxy`,
     * `--tls-min-v1.0`/v1.1/v1.2/v1.3, `--tls-max-v1.2`/v1.3,
     * `--enable-fips`, `--force-fips`, `--openssl-legacy-provider`,
     * `--openssl-shared-config` — all standalone in the runtime, none
     * value-consuming. `--stack-trace-limit` is the special case of an
     * option that works only in the `=` form (`--stack-trace-limit=N`);
     * the bare-then-value form errors out, so it is NOT value-consuming
     * by whitespace and must not be listed. `--max-old-space-size` is
     * a V8 option that only accepts the `=` form for the same reason;
     * `--max-old-space-size-percentage` is a Node option that does
     * accept whitespace separation and is included.
     *
     * `--inspect`, `--inspect-brk`, and `--inspect-wait` use the
     * `--flag[=[host:]port]` syntax — the value is optional and bundled
     * with `=` only; the bare form is standalone. They are NOT value-
     * consuming via whitespace and must not be listed. `--debug-port`
     * and `--inspect-port` (no `[` brackets in help) DO accept whitespace
     * separation and are included.
     */
    function isShellRuntimeFlagConsumingValue(token) {
      if (typeof token !== "string") return false;
      switch (token) {
        // Module loading and preload (--require, --import, --loader).
        case "-r":
        case "--require":
        case "--import":
        case "--experimental-loader":
        case "--loader":
        // Conditions and module resolution.
        case "-C":
        case "--conditions":
        case "--input-type":
        // Environment and config files.
        case "--env-file":
        case "--env-file-if-exists":
        case "--experimental-config-file":
        // Permissions (require --permission to actually take effect, but
        // the value is consumed regardless).
        case "--allow-fs-read":
        case "--allow-fs-write":
        // Snapshot and SEA.
        case "--snapshot-blob":
        case "--build-snapshot-config":
        case "--experimental-sea-config":
        case "--heapsnapshot-near-heap-limit":
        case "--heapsnapshot-signal":
        // CPU and heap profiler output paths.
        case "--cpu-prof-dir":
        case "--cpu-prof-interval":
        case "--cpu-prof-name":
        case "--heap-prof-dir":
        case "--heap-prof-interval":
        case "--heap-prof-name":
        // Diagnostic report.
        case "--diagnostic-dir":
        case "--report-dir":
        case "--report-directory":
        case "--report-filename":
        case "--report-signal":
        // Inspector port (NOT --inspect / --inspect-brk / --inspect-wait,
        // which are `=`-only optional-value flags).
        case "--debug-port":
        case "--inspect-port":
        case "--inspect-publish-uid":
        // Network and DNS.
        case "--dns-result-order":
        case "--network-family-autoselection-attempt-timeout":
        // Locale and storage paths.
        case "--icu-data-dir":
        case "--localstorage-file":
        // OpenSSL / TLS.
        case "--openssl-config":
        case "--tls-cipher-list":
        case "--tls-keylog":
        case "--secure-heap":
        case "--secure-heap-min":
        // HTTP, process, and warning behaviour.
        case "--max-http-header-size":
        case "--max-old-space-size-percentage":
        case "--title":
        case "--unhandled-rejections":
        case "--redirect-warnings":
        case "--disable-warning":
        case "--disable-proto":
        // Watch mode.
        case "--watch-path":
        case "--watch-kill-signal":
        // Test runner.
        case "--test-concurrency":
        case "--test-coverage-branches":
        case "--test-coverage-exclude":
        case "--test-coverage-functions":
        case "--test-coverage-include":
        case "--test-coverage-lines":
        case "--test-global-setup":
        case "--test-isolation":
        case "--experimental-test-isolation":
        case "--test-name-pattern":
        case "--test-reporter":
        case "--test-reporter-destination":
        case "--test-rerun-failures":
        case "--test-shard":
        case "--test-skip-pattern":
        case "--test-timeout":
        // Trace event categories and require-module tracing.
        case "--trace-event-categories":
        case "--trace-event-file-pattern":
        case "--trace-require-module":
        // V8 thread pool and large-page mapping.
        case "--use-largepages":
        case "--v8-pool-size":
          return true;
        case "--preload":
        case "--config":
        case "-c":
          // Bun: `--preload <module>`, `-c, --config <path>` consume the
          // next token. `-c` is also Node's `--check` short form
          // (parse-only), but the no-script-flag check (with the
          // walker's runtime tag) catches Node's `-c` before this
          // value-consuming check is reached, so listing `-c` here only
          // affects the Bun-runtime walk where it correctly takes the
          // following bunfig.toml path as the option's value.
          return true;
        default:
          return false;
      }
    }

    /**
     * True when a runtime option flag causes the JS runtime to NOT execute
     * a script file — anything appearing after such a flag is either ignored
     * by the runtime, consumed as inline source, parse-only-checked, or
     * forwarded as argv to already-evaluated code. The shell-string walker
     * and the spawn-like argv-array walker both use this predicate to abort
     * at the flag and report no daemon launch, even when a daemon-entry-
     * shaped token follows.
     *
     * Three classes are recognised:
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
     *   3. Parse-only flags: `--check` and `--syntax-check` (long forms
     *      common to Node), plus `-c` when the runtime is Node. The
     *      runtime parses the script for syntax errors and exits without
     *      ever executing it, so the daemon never starts. Reporting
     *      `node --check dist/daemon/index.js` as a daemon launch is a
     *      false positive. (Closed the parse-only blocker from review
     *      cycle 10 — the reviewer's probe was `execSync("node --check
     *      dist/daemon/index.js")`.)
     *
     *      The short form `-c` is gated on `runtime === "node"` because
     *      it is ambiguous between runtimes: Node treats `-c` as the
     *      short form of `--check` (parse-only), but Bun treats `-c` as
     *      the short form of `--config` (value-consuming, takes a
     *      bunfig.toml path). Treating Bun's `-c` as no-script would
     *      silently accept a real `bun -c bunfig.toml dist/daemon/
     *      index.js` daemon launch. The long forms `--check` and
     *      `--syntax-check` are unambiguous (Bun has neither) and apply
     *      regardless of runtime.
     *
     * The `runtime` parameter — `"node"`, `"bun"`, or `null` when the
     * caller cannot determine the runtime statically — gates the
     * runtime-ambiguous short flags. Pass the leading-token classification
     * so the walker can correctly distinguish Node's `-c` from Bun's
     * `-c`. Callers that walk an argv after a recognised runtime arg
     * should always pass the runtime; callers that classify in isolation
     * may pass `null` and miss the parse-only short-flag class.
     */
    function isShellRuntimeNoScriptFlag(token, runtime) {
      if (typeof token !== "string") return false;
      if (
        token === "-e" ||
        token === "--eval" ||
        token === "-p" ||
        token === "--print" ||
        token.startsWith("--eval=") ||
        token.startsWith("--print=") ||
        token === "-v" ||
        token === "--version" ||
        token === "-h" ||
        token === "--help" ||
        token === "--check" ||
        token === "--syntax-check"
      ) {
        return true;
      }
      // Runtime-ambiguous short flag: Node's parse-only `-c` vs Bun's
      // value-consuming `-c, --config <path>`. Only treat as no-script when
      // we know the runtime is Node.
      if (token === "-c" && runtime === "node") return true;
      return false;
    }

    /**
     * Classify the leading shell-token (or argv arg[0]) into a runtime
     * tag used by the flag predicates. Returns `"node"` for the bare
     * `node` token or any path token whose final segment is `node`
     * (also used for the `process.execPath` form by `runtimeTagForArg`).
     * Returns `"bun"` for the bare `bun` token or any path token whose
     * final segment is `bun`. Returns `null` otherwise. Used by both
     * the exec/execSync shell-string walker and the spawn-like
     * argv-array walker so runtime-ambiguous short flags (e.g. `-c`)
     * classify correctly.
     */
    function runtimeTagForToken(token) {
      if (typeof token !== "string") return null;
      if (token === "node" || token.endsWith("/node")) return "node";
      if (token === "bun" || token.endsWith("/bun")) return "bun";
      return null;
    }

    /**
     * Like `runtimeTagForToken` but accepts an AST argument node. Returns
     * `"node"` for the `process.execPath` MemberExpression, the bare
     * `node` literal/template, or a path-suffixed form (`/usr/bin/node`).
     * Returns `"bun"` for the bun analogues. Returns `null` for anything
     * the rule cannot statically recognise as a runtime.
     */
    function runtimeTagForArg(arg) {
      if (!arg) return null;
      if (isProcessExecPathExpression(arg)) return "node";
      const literal = literalString(arg);
      if (literal !== null) return runtimeTagForToken(literal);
      const tmpl = templateLiteralRaw(arg);
      if (tmpl !== null) return runtimeTagForToken(tmpl);
      return null;
    }

    /**
     * Tokenise a shell-command string into argv tokens, respecting POSIX
     * single-quote and double-quote pairs so that a quoted value containing
     * whitespace stays a single token. Returns the array of tokens with
     * each token's outermost matched quote pair stripped (so quoted forms
     * classify the same as bare equivalents at every downstream
     * predicate).
     *
     * Quote handling:
     *   - `'...'` — content is literal, no escape processing, until the
     *     closing single quote. Whitespace inside stays in-token.
     *   - `"..."` — content is literal until the closing double quote.
     *     Whitespace inside stays in-token. (Backslash escapes inside
     *     double quotes are not modelled — static analysis treats them
     *     as bytes; this is conservative because no current Node/Bun
     *     CLI form depends on them for the script-position decision.)
     *   - Outside quotes — whitespace is a token boundary.
     *
     * Why a state machine rather than a plain whitespace split: the
     * value of a value-consuming flag may contain whitespace when
     * quoted, e.g. `node --require './pre load.js' dist/daemon/index.js`.
     * A plain split tokenises the quoted value into TWO tokens (`'./pre`
     * and `load.js'`), so the value-consuming-flag walker skips only
     * one of them and the second-half token (`load.js'`) ends up in the
     * script position before the real daemon entry — silently accepting
     * a real direct daemon launch (the false-negative blocker from
     * review cycle 10). Quote-aware tokenisation keeps the whole value
     * as one token so the walker can advance past it correctly.
     *
     * Template-literal placeholders (`${...}`) are not re-expanded — the
     * raw text from `templateLiteralRaw` already encodes them as the
     * sentinel string `${...}`. The sentinel contains neither quote
     * characters nor whitespace, so it stays in a single token and
     * cannot accidentally satisfy a runtime/script/flag predicate.
     */
    function tokenizeShellCommand(text) {
      if (typeof text !== "string") return null;
      const tokens = [];
      let buf = "";
      let hasContent = false;
      let inSingle = false;
      let inDouble = false;
      const flush = () => {
        if (hasContent) {
          tokens.push(buf);
          buf = "";
          hasContent = false;
        }
      };
      for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (!inSingle && !inDouble) {
          if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
            flush();
            continue;
          }
          if (ch === "'") {
            inSingle = true;
            buf += ch;
            hasContent = true;
            continue;
          }
          if (ch === '"') {
            inDouble = true;
            buf += ch;
            hasContent = true;
            continue;
          }
          buf += ch;
          hasContent = true;
          continue;
        }
        if (inSingle) {
          buf += ch;
          hasContent = true;
          if (ch === "'") inSingle = false;
          continue;
        }
        // inDouble
        buf += ch;
        hasContent = true;
        if (ch === '"') inDouble = false;
      }
      flush();
      return tokens.map(stripShellQuotes);
    }

    /**
     * Tokenise a shell-command argument's text. Returns the quote-aware
     * argv tokens of a string Literal or a TemplateLiteral with `${...}`
     * placeholders preserved (so an interpolated value cannot accidentally
     * satisfy a token check). Each token is normalised via
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
      if (literal !== null) return tokenizeShellCommand(literal);
      const tmpl = templateLiteralRaw(arg);
      if (tmpl !== null) return tokenizeShellCommand(tmpl);
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
        // Pass the runtime tag so the script-position walk can classify
        // runtime-ambiguous short flags (e.g. Node's parse-only `-c` vs
        // Bun's value-consuming `-c, --config`).
        const argvRuntime = runtimeTagForArg(args[0]);
        const scriptIdx = findScriptPositionInArgvArray(arrayArg, argvRuntime);
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
        // Determine the runtime tag from the leading token so the walk
        // can classify runtime-ambiguous short flags (Node's parse-only
        // `-c` vs Bun's value-consuming `-c, --config <path>`).
        const shellRuntime = runtimeTagForToken(tokens[0]);
        let scriptIdx = -1;
        for (let i = 1; i < tokens.length; i += 1) {
          if (isShellRuntimeNoScriptFlag(tokens[i], shellRuntime)) {
            // Eval-mode, info-exit, or parse-only flag: runtime evaluates
            // inline source, prints info, exits, or only syntax-checks the
            // script — no script is actually executed, so a daemon-entry
            // token after it is not a daemon launch.
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
     * the `serve start --detach` lifecycle subcommand. Classification is
     * dispatched per-callee so that unrelated subprocesses whose argv
     * tokens happen to overlap (`spawn("echo", ["serve", "start",
     * "--detach"])`) AND non-daemon kspec subcommands whose later
     * positional values happen to spell the lifecycle path (`spawn(
     * "kspec", ["search", "serve start --detach"])` — the cycle-12
     * blocker case) are both correctly NOT reported. In every shape, the
     * decision delegates to `tokensResolveToDetachedServe`, which
     * requires the FIRST TWO non-flag positional tokens after the kspec
     * executable to be exactly `serve` then `start` and `--detach` (or
     * `--detach=…`) to appear as a flag token — not a substring scan.
     *
     *   - `runKspec` / `kspec`
     *     Implicit kspec invocation. Per-arg tokens are concatenated in
     *     source order via `collectKspecHelperArgTokens`, which uses the
     *     quote-aware shell tokeniser for string args and the per-element
     *     argv collector for ArrayExpression args.
     *   - `exec` / `execSync`
     *     Shell-string callee. The command string is tokenised
     *     quote-aware, the leading token must be the kspec executable
     *     (bare `kspec` or a path ending in `/kspec`), and the remainder
     *     is checked for the `serve start` subcommand path. Quoted
     *     multi-word tokens stay a single positional, so a non-daemon
     *     kspec subcommand that quotes the string `"serve start
     *     --detach"` as a single argv slot is not misreported.
     *   - `spawn` / `spawnSync` / `execFile` / `execFileSync`
     *     First arg must be the kspec executable. Only the argv array
     *     (second arg) is scanned, with each element treated as one OS
     *     argv slot — no whitespace re-splitting — so the same
     *     non-daemon `["search", "serve start --detach"]` pattern is
     *     not misreported.
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
        // Helper signature: forwards the kspec args directly. Concatenate
        // the per-arg token contributions in source order so a variadic
        // `runKspec("serve", "start", "--detach")` is classified the same
        // as the typical single-string `runKspec("serve start --detach")`.
        const tokens = [];
        for (const arg of args) {
          for (const t of collectKspecHelperArgTokens(arg)) tokens.push(t);
        }
        return tokensResolveToDetachedServe(tokens);
      }

      if (calleeName === "exec" || calleeName === "execSync") {
        // Shell-string callee. `tokenizeShellCommand` is quote-aware, so
        // a quoted multi-word token like `"serve start --detach"` stays
        // a single positional after the `kspec` executable token is
        // dropped — preventing the cycle-12 false positive on
        // `exec("kspec search \"serve start --detach\"")`.
        const cmdArg = args[0];
        const literal = literalString(cmdArg);
        const tmpl = literal === null ? templateLiteralRaw(cmdArg) : null;
        const cmdText = literal !== null ? literal : tmpl;
        if (cmdText === null) return false;
        const cmdTokens = tokenizeShellCommand(cmdText);
        if (!cmdTokens || cmdTokens.length === 0) return false;
        const lead = cmdTokens[0];
        if (lead !== "kspec" && !lead.endsWith("/kspec")) return false;
        return tokensResolveToDetachedServe(cmdTokens.slice(1));
      }

      if (
        calleeName === "spawn" ||
        calleeName === "spawnSync" ||
        calleeName === "execFile" ||
        calleeName === "execFileSync"
      ) {
        if (!isKspecExecutableArg(args[0])) return false;
        if (args.length < 2) return false;
        // argv array — each element is one OS argv slot; no whitespace
        // re-splitting. A single element like `"serve start --detach"`
        // remains one positional and cannot satisfy the `serve`/`start`
        // subcommand-path check (cycle-12 false-positive blocker on
        // `spawn("kspec", ["search", "serve start --detach"])`).
        return tokensResolveToDetachedServe(collectArgvArrayTokens(args[1]));
      }

      return false;
    }

    /**
     * Detached-serve check keeps the cleanup escape hatch — these tests
     * exist to exercise the CLI's --detach behavior itself.
     *
     * Cleanup is accepted only when registered in the SAME control flow
     * before the next awaited operation, expectation, or daemon
     * observation. The presence of an ancestor `afterEach` hook with a
     * kill pattern is NOT proof that this specific detached daemon is
     * cleaned up — when the captured pid/handle is bound only after an
     * intervening `await` or `expect()`, an assertion failure leaves the
     * binding null and the detached daemon is leaked. The two valid safe
     * shapes are:
     *
     *   1. Register `onTestFinished` (or another in-flow cleanup
     *      registration matching `hasCleanupAfter`) immediately after the
     *      detached start and before any sibling await/expect.
     *   2. Wrap the detached start in a `try { … } finally { kill … }`
     *      whose finalizer carries a daemon-kill pattern, so the kill
     *      runs even when an assertion or await throws.
     *
     * Tests that intentionally exercise the unsafe shape (e.g., the CLI's
     * own --detach exit-ordering paths) must add a per-line
     * `oxlint-disable-next-line no-leaky-test-daemon/no-leaky-test-daemon
     * -- <reason naming the behavior under test>` immediately above the
     * offending statement (see the localized-disable companion rule).
     */
    function detachWithoutCleanup(node) {
      if (isInLifecycleHook(node, "afterEach")) return false;
      if (hasCleanupAfter(node)) return false;
      if (isInTryWithFinallyCleanup(node)) return false;
      return true;
    }

    /**
     * Scan the sibling statements between a detached daemon start and
     * the next observation (await/expect/daemon-observation). When a
     * cleanup-registration callback (`onTestFinished(...)` /
     * `process.on(<exit-event>, ...)`) is found whose body contains a
     * recognised daemon-kill CallExpression but whose closure captures
     * an outer identifier that is statically unbound at the registration
     * site, return the offender. Returns null when no such mismatch is
     * found — the caller then falls back to the generic "missing
     * cleanup" diagnostic.
     *
     * Used by `Program:exit` to pick the precise diagnostic when
     * `detachWithoutCleanup` returns true: an unbound capture is reported
     * via `cleanupClosureUnbound` (naming the offending identifier), so
     * the author sees "your closure captures `pid` which is undefined at
     * registration" rather than the generic missing-cleanup wording.
     *
     * Stored function bodies (arrows assigned to bindings, callbacks to
     * unrelated callees) are NOT descended — they are not on the
     * straight-line execution path and any cleanup-shaped call inside
     * is irrelevant. The walker mirrors the rule's
     * `subtreeContainsDaemonCleanupCall` discipline.
     */
    function findUnboundCleanupClosure(detachedNode) {
      const body = findContainingBody(detachedNode);
      if (!body) return null;
      const nodeIndex = findNodeIndex(body, detachedNode);
      if (nodeIndex === -1) return null;

      for (let i = nodeIndex + 1; i < body.length; i += 1) {
        const stmt = body[i];
        const found = scanForUnboundCleanupCallback(stmt, detachedNode);
        if (found) return found;
        if (statementContainsAwaitOrExpect(stmt)) {
          break;
        }
      }
      return null;
    }

    /**
     * Companion to `findUnboundCleanupClosure` that surfaces an unbound
     * capture in a DIRECT try/finally finalizer cleanup call. The
     * registered-callback scanner walks sibling statements after the
     * detached start, but a try/finally finalizer hangs off the
     * enclosing `TryStatement` rather than appearing as a sibling, so
     * the regular scanner misses it. Walk the parent chain instead and,
     * for each enclosing `TryStatement` whose finalizer contains a
     * direct daemon-cleanup call, run the same ownership analysis used
     * by `directCleanupCallOwnsDetachedDaemon`. Returns the offender's
     * identifier so the diagnostic emits `cleanupClosureUnbound` with
     * the precise capture rather than the generic missing-cleanup
     * wording.
     *
     * The cycle-7 reviewer probe (`let pid; try { runKspec("serve start
     * --detach"); expect(...); pid = readPidFromFile(); } finally {
     * process.kill(pid as number, "SIGTERM"); }`) is the canonical
     * case: the kill captures `pid` whose only concrete write sits
     * AFTER an intervening assertion that can throw, so the finalizer
     * may run with `pid` undefined and the daemon leaks.
     */
    function findUnboundDirectCleanupCapture(detachedNode) {
      let current = detachedNode && detachedNode.parent;
      while (current) {
        if (current.type === "TryStatement" && current.finalizer) {
          const found = scanFinalizerForUnboundDirectCleanup(
            current.finalizer,
            detachedNode,
          );
          if (found) return found;
        }
        current = current.parent;
      }
      return null;
    }

    function scanFinalizerForUnboundDirectCleanup(node, detachedStartNode) {
      if (!node || typeof node !== "object" || typeof node.type !== "string") {
        return null;
      }
      // Stop at a registered callback boundary — any cleanup-shaped
      // call inside is governed by the callback's own binding-status
      // check (mirrors `subtreeContainsDaemonCleanupCall`'s discipline).
      if (
        node.type === "FunctionDeclaration" ||
        node.type === "FunctionExpression" ||
        node.type === "ArrowFunctionExpression"
      ) {
        return null;
      }
      if (
        node.type === "CallExpression" &&
        isDaemonCleanupCallExpression(node)
      ) {
        const useNode = findDirectCleanupRegistrationUseNode(
          node,
          detachedStartNode,
        );
        const captures = collectDaemonKillCaptureNames(node);
        for (const name of captures) {
          if (name === UNVERIFIABLE_KILL_TARGET) {
            return { identifier: UNVERIFIABLE_KILL_TARGET };
          }
          if (!isIdentifierBoundConcretelyAt(name, useNode)) {
            return { identifier: name };
          }
          if (!isCaptureOwnedByDetachedStart(name, useNode, detachedStartNode)) {
            return { identifier: name };
          }
        }
        return null;
      }
      for (const key in node) {
        if (
          key === "parent" ||
          key === "loc" ||
          key === "range" ||
          key === "start" ||
          key === "end" ||
          key === "type" ||
          key === "tokens" ||
          key === "comments"
        ) {
          continue;
        }
        const child = node[key];
        if (Array.isArray(child)) {
          for (const c of child) {
            if (c && typeof c === "object" && typeof c.type === "string") {
              const found = scanFinalizerForUnboundDirectCleanup(c, detachedStartNode);
              if (found) return found;
            }
          }
        } else if (
          child &&
          typeof child === "object" &&
          typeof child.type === "string"
        ) {
          const found = scanFinalizerForUnboundDirectCleanup(child, detachedStartNode);
          if (found) return found;
        }
      }
      return null;
    }

    function scanForUnboundCleanupCallback(node, detachedStartNode) {
      if (!node || typeof node !== "object" || typeof node.type !== "string") {
        return null;
      }
      if (
        node.type === "FunctionDeclaration" ||
        node.type === "FunctionExpression" ||
        node.type === "ArrowFunctionExpression"
      ) {
        if (!isCleanupRegistrationCallback(node)) return null;
        if (!subtreeContainsAnyDaemonKillShape(node.body)) return null;
        const status = cleanupCallbackBindingStatus(node, node.parent, detachedStartNode);
        if (!status.bound) {
          return { identifier: status.unboundIdentifier };
        }
        return null;
      }
      for (const key in node) {
        if (
          key === "parent" ||
          key === "loc" ||
          key === "range" ||
          key === "start" ||
          key === "end" ||
          key === "type" ||
          key === "tokens" ||
          key === "comments"
        ) {
          continue;
        }
        const child = node[key];
        if (Array.isArray(child)) {
          for (const c of child) {
            if (c && typeof c === "object" && typeof c.type === "string") {
              const found = scanForUnboundCleanupCallback(c, detachedStartNode);
              if (found) return found;
            }
          }
        } else if (
          child &&
          typeof child === "object" &&
          typeof child.type === "string"
        ) {
          const found = scanForUnboundCleanupCallback(child, detachedStartNode);
          if (found) return found;
        }
      }
      return null;
    }

    function subtreeContainsAnyDaemonKillShape(node) {
      if (!node || typeof node !== "object" || typeof node.type !== "string") {
        return false;
      }
      if (isDaemonCleanupCallExpression(node)) return true;
      for (const key in node) {
        if (
          key === "parent" ||
          key === "loc" ||
          key === "range" ||
          key === "start" ||
          key === "end" ||
          key === "type" ||
          key === "tokens" ||
          key === "comments"
        ) {
          continue;
        }
        const child = node[key];
        if (Array.isArray(child)) {
          for (const c of child) {
            if (subtreeContainsAnyDaemonKillShape(c)) return true;
          }
        } else if (
          child &&
          typeof child === "object" &&
          typeof child.type === "string"
        ) {
          if (subtreeContainsAnyDaemonKillShape(child)) return true;
        }
      }
      return false;
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
     * Bindings whose declarator init or assignment RHS is a daemon-shaped
     * URL string. Two flags are tracked per binding so the narrower
     * `localhostDaemonUrl` reporting predicate and the broader
     * cleanup-timing observation gate can each ask the question they
     * actually need:
     *
     *   - `isLocalhost` — true when the RHS matches the narrow
     *     `localhost:<port>` pattern (`carriesLocalhostPortUrl`). Drives
     *     the `localhostDaemonUrl` reporting at `fetch` / `new WebSocket`
     *     call sites.
     *   - `isDaemonHost` — true when the RHS matches the broader
     *     loopback pattern (`carriesDaemonHostPortUrl`: `localhost:`,
     *     `127.0.0.1:`, `[::1]:`). Drives the cleanup-timing observation
     *     gate so a `const url = "http://127.0.0.1:3456/..."; fetch(url)`
     *     between a detached daemon start and the cleanup registration
     *     is recognised as a daemon observation (cycle-7 reviewer
     *     blocker on @daemon-test-guardrail-precision
     *     ac-detached-cleanup-before-observation). Without this the
     *     observation gate would only see inline literals and
     *     template-literal forms, missing the identifier-bound
     *     127.0.0.1 / [::1] cases.
     *
     * Tracked per lexical scope and source position so a
     * `const url = `http://localhost:${port}/...`; fetch(url)` pattern is
     * flagged the same way as the inline form — without leaking across
     * unrelated `it`/`test` blocks that happen to reuse the same
     * identifier name. Walking outward from the use site picks the
     * innermost binding whose source position is before the use; an
     * inner non-loopback declaration shadows an outer loopback one, and
     * a later non-loopback reassignment in the same scope overrides an
     * earlier loopback binding.
     *
     * Map shape: identifier name → array of
     *   { scopeNode, position, isLocalhost, isDaemonHost }.
     */
    const localhostUrlBindings = new Map();

    function getNodeStart(node) {
      if (!node) return -1;
      if (node.range && Number.isFinite(node.range[0])) return node.range[0];
      if (typeof node.start === "number") return node.start;
      return -1;
    }

    function getNodeEnd(node) {
      if (!node) return -1;
      if (node.range && Number.isFinite(node.range[1])) return node.range[1];
      if (typeof node.end === "number") return node.end;
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

    function recordBinding(name, anchorNode, isLocalhost, isDaemonHost) {
      const scopeNode = getEnclosingScopeNode(anchorNode);
      if (!scopeNode) return;
      const position = getNodeStart(anchorNode);
      if (position < 0) return;
      let entries = localhostUrlBindings.get(name);
      if (!entries) {
        entries = [];
        localhostUrlBindings.set(name, entries);
      }
      entries.push({ scopeNode, position, isLocalhost, isDaemonHost });
    }

    /**
     * Walk lexical scopes outward from `useNode` and return the most recent
     * binding for `name` whose declaration position is before the use. If a
     * function-scope parameter named `name` is encountered first, treat it
     * as a non-loopback binding (parameters cannot be daemon-URL strings
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
            return { isLocalhost: false, isDaemonHost: false, viaParameter: true };
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

    /**
     * True when `node` is an Identifier whose tracked binding RHS matches
     * the broader loopback host+port pattern (`localhost:`, `127.0.0.1:`,
     * or `[::1]:`). Used by the cleanup-timing observation gate so an
     * identifier-bound daemon URL is recognised as a daemon observation
     * — symmetric with the inline literal/template-literal path through
     * `carriesDaemonHostPortUrl`. The narrower `isLocalhostUrlIdentifier`
     * keeps driving the `localhostDaemonUrl` reporting predicate.
     */
    function isDaemonHostUrlIdentifier(node, useNode) {
      if (!node || node.type !== "Identifier") return false;
      const binding = findApplicableBinding(node.name, useNode);
      return binding !== null && binding.isDaemonHost === true;
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

    /**
     * Inspect string-shaped arguments for a daemon URL where the host is
     * any common loopback name (`localhost`, `127.0.0.1`, `[::1]`)
     * paired with an explicit port. Used by the cleanup-timing
     * observation gate (`subtreeContainsAwaitOrExpect`) which is
     * intentionally broader than the rule's `localhostDaemonUrl`
     * reporting predicate (`carriesLocalhostPortUrl`) — see
     * `DAEMON_HOST_PORT_URL_PATTERN` for the rationale.
     */
    function carriesDaemonHostPortUrl(node) {
      if (!node) return false;
      if (node.type === "Literal" && typeof node.value === "string") {
        return DAEMON_HOST_PORT_URL_PATTERN.test(node.value);
      }
      if (node.type === "TemplateLiteral") {
        const parts = [];
        for (let i = 0; i < node.quasis.length; i += 1) {
          parts.push(node.quasis[i].value.raw);
          if (i < node.expressions.length) {
            parts.push("${...}");
          }
        }
        return DAEMON_HOST_PORT_URL_PATTERN.test(parts.join(""));
      }
      return false;
    }

    /**
     * True when the first argument of a `fetch(...)` or
     * `new WebSocket(...)` call resolves to a daemon-host URL — either
     * an inline literal/template literal carrying the loopback host+port
     * pattern (`localhost:`, `127.0.0.1:`, `[::1]:`), or an Identifier
     * whose tracked binding RHS matches the same broader pattern. The
     * Identifier surface mirrors the literal surface via
     * `isDaemonHostUrlIdentifier` (cycle-7 reviewer blocker on
     * @daemon-test-guardrail-precision
     * ac-detached-cleanup-before-observation): without it, a test could
     * assign `const url = "http://127.0.0.1:3456/api/health"` and
     * `fetch(url)` between a detached daemon start and cleanup
     * registration without tripping the cleanup-timing rule.
     *
     * Used only by the cleanup-timing observation gate. The
     * `localhostDaemonUrl` reporting predicate keeps using its narrower
     * `firstArgIsLocalhostUrl` so the existing reporting behavior is
     * unchanged.
     */
    function firstArgIsDaemonObservation(node) {
      const firstArg = node.arguments[0];
      if (!firstArg) return false;
      if (carriesDaemonHostPortUrl(firstArg)) return true;
      return isDaemonHostUrlIdentifier(firstArg, firstArg);
    }

    function isFetchOfDaemonHostUrl(node) {
      if (node.type !== "CallExpression") return false;
      if (!node.callee || node.callee.type !== "Identifier") return false;
      if (!FETCH_LIKE_CALLEES.has(node.callee.name)) return false;
      return firstArgIsDaemonObservation(node);
    }

    function isWebSocketCtorOfDaemonHostUrl(node) {
      if (node.type !== "NewExpression") return false;
      if (!node.callee || node.callee.type !== "Identifier") return false;
      if (!WEBSOCKET_LIKE_CONSTRUCTORS.has(node.callee.name)) return false;
      return firstArgIsDaemonObservation(node);
    }

    // Detached daemon-start CallExpressions found during traversal.
    // The cleanup-timing analysis (`detachWithoutCleanup`) is deferred to
    // `Program:exit` so that all `localhostUrlBindings` are recorded
    // before forward statement scans resolve identifier-bound URL
    // observations through `firstArgIsDaemonObservation`. Without
    // deferral, the check at the daemon-start CallExpression entry
    // would run before later `const url = "http://127.0.0.1:3456/..."`
    // VariableDeclarator visits, leaving identifier-bound daemon URLs
    // invisible to the observation gate (cycle-7 reviewer blocker on
    // @daemon-test-guardrail-precision
    // ac-detached-cleanup-before-observation).
    const pendingDetachChecks = [];

    return {
      VariableDeclarator(node) {
        if (!node.id || node.id.type !== "Identifier" || !node.init) return;
        recordBinding(
          node.id.name,
          node,
          carriesLocalhostPortUrl(node.init),
          carriesDaemonHostPortUrl(node.init),
        );
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
        recordBinding(
          node.left.name,
          node,
          carriesLocalhostPortUrl(node.right),
          carriesDaemonHostPortUrl(node.right),
        );
      },

      CallExpression(node) {
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

        // Detached serve via the CLI — defer the cleanup-timing check
        // to `Program:exit` so identifier-bound daemon URLs in later
        // statements are resolved through their fully-populated
        // `localhostUrlBindings` entries. The cleanup escape hatch
        // (an unconditional same-flow registration via
        // `onTestFinished` or a `try { ... } finally { kill }` block,
        // or an ancestor `afterEach` hook) is preserved unchanged.
        if (isDetachCallExpression(node)) {
          pendingDetachChecks.push(node);
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

      "Program:exit"() {
        for (const node of pendingDetachChecks) {
          // afterEach in an outer hook does not by itself prove this
          // specific detached daemon is cleaned up (see the cleanup-
          // binding analysis for the unbound-capture case), but a
          // detached start INSIDE an `afterEach(...)` callback is a
          // teardown shape and not the leak target. Preserve that
          // historical escape hatch.
          if (isInLifecycleHook(node, "afterEach")) continue;

          // Local helper functions/arrows inside ordinary test files
          // are NOT approved daemon-test fixtures. The approved-fixture
          // boundary is the path allowlist (`tests/helpers/daemon.ts`,
          // `tests/helpers/mock-daemon.ts`, `tools/eslint-rules/`, the
          // lint test files). A detached start nested inside a local
          // FunctionDeclaration / arrow / FunctionExpression in an
          // ordinary test file hides the unsafe shape from the cleanup
          // contract — the caller's `it(...)` body never sees a scoped
          // cleanup registration tied to the daemon. Report the
          // wrapper boundary explicitly so the diagnostic names what
          // is wrong.
          // (@daemon-test-guardrail-precision
          // ac-approved-daemon-helper-boundary-explicit)
          if (isInHelperFunction(node)) {
            context.report({
              node,
              messageId: "localWrapperUnsafe",
              data: { pattern: "serve start --detach" },
            });
            continue;
          }

          if (!detachWithoutCleanup(node)) continue;

          // Differentiate the missing-cleanup diagnostic: if a cleanup
          // registration callback was present but its closure captures
          // an unbound outer identifier, surface the binding gap by
          // name so the author sees which capture is the leak.
          // (@daemon-test-guardrail-precision
          // ac-detached-cleanup-bound-before-observation)
          const unbound =
            findUnboundCleanupClosure(node) ||
            findUnboundDirectCleanupCapture(node);
          if (unbound) {
            context.report({
              node,
              messageId: "cleanupClosureUnbound",
              data: {
                pattern: "serve start --detach",
                identifier: unbound.identifier || "<unknown>",
              },
            });
            continue;
          }

          context.report({
            node,
            messageId: "missingCleanup",
            data: { pattern: "serve start --detach" },
          });
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
