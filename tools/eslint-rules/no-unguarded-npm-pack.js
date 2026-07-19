/**
 * ESLint-compatible rule for oxlint JS Plugins Alpha.
 *
 * Bans `npm pack` invocations in tests that do not pass --ignore-scripts.
 *
 * package.json defines `"prepack": "npm run build"`. An `npm pack` spawned
 * from a test without --ignore-scripts therefore triggers a full rebuild
 * (tsc, build:daemon, rm -rf dist/web-ui) of the live dist/ tree while
 * parallel vitest workers spawn `node dist/cli/index.js`. CLI subprocesses
 * that load dist modules mid-rewrite fail with transient missing-export
 * SyntaxErrors. Packing with --ignore-scripts uses the existing dist/
 * output, which the test runner's pre-test build hook guarantees is current.
 */

const NPM_PACK = /\bnpm\s+pack\b/;
const IGNORE_SCRIPTS = "--ignore-scripts";

function isUnguardedPackText(text) {
  return NPM_PACK.test(text) && !text.includes(IGNORE_SCRIPTS);
}

const noUnguardedNpmPack = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow `npm pack` without --ignore-scripts in tests (prepack rebuilds dist/ mid-suite and races parallel workers spawning the compiled CLI)",
    },
    messages: {
      unguardedNpmPack:
        "`npm pack` without --ignore-scripts runs the prepack build, rewriting dist/ while parallel test workers spawn the compiled CLI. Add --ignore-scripts (the pre-test build hook already guarantees dist/ is current).",
    },
    schema: [],
  },

  create(context) {
    return {
      Literal(node) {
        if (typeof node.value !== "string") return;
        if (!isUnguardedPackText(node.value)) return;
        context.report({ node, messageId: "unguardedNpmPack" });
      },

      TemplateLiteral(node) {
        // Join quasis with a non-whitespace separator so interpolations
        // between "npm" and "pack" cannot produce a false match.
        const text = node.quasis.map((q) => q.value.cooked ?? "").join("\u0000");
        if (!isUnguardedPackText(text)) return;
        context.report({ node, messageId: "unguardedNpmPack" });
      },

      CallExpression(node) {
        // spawn-style array form: fn("npm", ["pack", ...], opts)
        const args = node.arguments;
        for (let i = 0; i < args.length - 1; i++) {
          const cmd = args[i];
          const list = args[i + 1];
          if (cmd.type !== "Literal" || cmd.value !== "npm") continue;
          if (list.type !== "ArrayExpression") continue;
          const elements = list.elements
            .filter((el) => el && el.type === "Literal" && typeof el.value === "string")
            .map((el) => el.value);
          if (elements.includes("pack") && !elements.includes(IGNORE_SCRIPTS)) {
            context.report({ node: list, messageId: "unguardedNpmPack" });
          }
        }
      },
    };
  },
};

const plugin = {
  meta: { name: "no-unguarded-npm-pack" },
  rules: {
    "no-unguarded-npm-pack": noUnguardedNpmPack,
  },
};

export default plugin;
