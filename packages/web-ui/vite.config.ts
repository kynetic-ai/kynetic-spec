import { resolve } from "node:path";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";
import { docsPlugin } from "./vite-plugin-docs";
import { resolveDevDaemonEndpointFromMetadata } from "../../src/daemon-shared/endpoint";

const docsDir = resolve(__dirname, "../../docs");
const releaseNotesPath = resolve(__dirname, "../../RELEASE_NOTES.md");

// AC: @daemon-network-endpoint-contract ac-clients-use-metadata
// Resolve the daemon-advertised endpoint from running-daemon metadata
// at dev-server start. When metadata is present, define the URL env
// vars so the web UI dev client connects to the URLs the daemon
// actually advertises (honoring IPv6 fallback, configured ports, and
// non-default connect hosts).
//
// When no metadata is found we deliberately leave the URL env vars
// undefined so the user-overridable VITE_KSPEC_DAEMON_HOST and
// VITE_KSPEC_DAEMON_PORT (or the documented numeric default) take
// effect inside packages/web-ui/src/lib/constants.ts. Defining a
// fallback here would silently override those overrides.
const daemonEndpoint = resolveDevDaemonEndpointFromMetadata();

const define: Record<string, string> = {};
if (daemonEndpoint) {
  define["import.meta.env.VITE_KSPEC_DAEMON_API_URL"] = JSON.stringify(daemonEndpoint.apiUrl);
  define["import.meta.env.VITE_KSPEC_DAEMON_WS_URL"] = JSON.stringify(daemonEndpoint.wsUrl);
}

export default defineConfig({
  plugins: [
    docsPlugin(docsDir, {
      repoUrl: "https://github.com/lepahc/kynetic-spec/blob/main",
      releaseNotesPath,
      exclude: ["history", "agents-eval-scenarios.md", "prime-mock.md"],
    }),
    sveltekit(),
  ],
  define,
  server: {
    fs: {
      // Allow reading from the top-level docs/ directory during development
      allow: [docsDir],
    },
  },
});
