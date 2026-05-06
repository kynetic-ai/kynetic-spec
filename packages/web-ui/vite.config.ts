import { resolve } from "node:path";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";
import { docsPlugin } from "./vite-plugin-docs";
import { resolveDevDaemonEndpoint } from "../../src/daemon/endpoint";

const docsDir = resolve(__dirname, "../../docs");
const releaseNotesPath = resolve(__dirname, "../../RELEASE_NOTES.md");

// AC: @daemon-network-endpoint-contract ac-clients-use-metadata
// Resolve the daemon-advertised endpoint at dev-server start so the web
// UI dev client connects to the same URLs as the running daemon (honors
// IPv6 fallback, configured ports, and non-default connect hosts). When
// no daemon metadata is present, the helper returns the documented
// 127.0.0.1:3456 default so `npm run dev` still works before the daemon
// is started.
const { apiUrl: devApiUrl, wsUrl: devWsUrl } = resolveDevDaemonEndpoint();

export default defineConfig({
  plugins: [
    docsPlugin(docsDir, {
      repoUrl: "https://github.com/lepahc/kynetic-spec/blob/main",
      releaseNotesPath,
      exclude: ["history", "agents-eval-scenarios.md", "prime-mock.md"],
    }),
    sveltekit(),
  ],
  define: {
    "import.meta.env.VITE_KSPEC_DAEMON_API_URL": JSON.stringify(devApiUrl),
    "import.meta.env.VITE_KSPEC_DAEMON_WS_URL": JSON.stringify(devWsUrl),
  },
  server: {
    fs: {
      // Allow reading from the top-level docs/ directory during development
      allow: [docsDir],
    },
  },
});
