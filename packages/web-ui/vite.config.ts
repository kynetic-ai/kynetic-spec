import { resolve } from "node:path";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";
import { docsPlugin } from "./vite-plugin-docs";

const docsDir = resolve(__dirname, "../../docs");
const releaseNotesPath = resolve(__dirname, "../../RELEASE_NOTES.md");

export default defineConfig({
  plugins: [
    docsPlugin(docsDir, {
      repoUrl: "https://github.com/lepahc/kynetic-spec/blob/main",
      releaseNotesPath,
      exclude: ["history", "agents-eval-scenarios.md", "prime-mock.md"],
    }),
    sveltekit(),
  ],
  server: {
    fs: {
      // Allow reading from the top-level docs/ directory during development
      allow: [docsDir],
    },
  },
});
