/**
 * ESLint-compatible rule for oxlint JS Plugins Alpha.
 *
 * Bans value imports from dist/daemon/ that use .ts extensions.
 *
 * The daemon build uses esbuild which only produces .js files (no .d.ts
 * declaration files). Value imports with .ts extensions fail at runtime
 * with ERR_MODULE_NOT_FOUND. Type-only imports are safe because they're
 * erased at compile time, so this rule only flags value imports.
 */

const DAEMON_TS_IMPORT = /\/dist\/daemon\/.*\.ts["']$/;

const noDaemonTsImports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow value imports from dist/daemon/ using .ts extensions (esbuild only produces .js)",
    },
    messages: {
      noDaemonTsImport:
        'Import from dist/daemon/ uses .ts extension but esbuild only produces .js files. Change "{{source}}" to use .js extension.',
    },
    schema: [],
  },

  create(context) {
    return {
      ImportDeclaration(node) {
        const source = node.source.value;
        if (!DAEMON_TS_IMPORT.test(`"${source}"`)) return;

        // Type-only imports are erased at compile time — safe to use .ts
        if (node.importKind === "type") return;

        // Side-effect imports (no specifiers) execute at runtime — flag them
        if (node.specifiers.length === 0) {
          context.report({
            node,
            messageId: "noDaemonTsImport",
            data: { source },
          });
          return;
        }

        // Mixed import: check if ALL specifiers are type-only
        const hasValueSpecifier = node.specifiers.some(
          (spec) => spec.type !== "ImportSpecifier" || spec.importKind !== "type",
        );
        if (!hasValueSpecifier) return;

        context.report({
          node,
          messageId: "noDaemonTsImport",
          data: { source },
        });
      },
    };
  },
};

const plugin = {
  meta: { name: "no-daemon-ts-imports" },
  rules: {
    "no-daemon-ts-imports": noDaemonTsImports,
  },
};

export default plugin;
