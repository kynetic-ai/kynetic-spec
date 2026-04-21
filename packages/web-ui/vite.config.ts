import { resolve } from "node:path";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";
import { docsPlugin } from "./vite-plugin-docs";

const docsDir = resolve(__dirname, "../../docs");

export default defineConfig({
  plugins: [
    docsPlugin(docsDir, {
      repoUrl: "https://github.com/lepahc/kynetic-spec/blob/main",
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
