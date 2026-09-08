import { defineConfig } from "vite";
import { resolve } from "node:path";

/**
 * Builds the background service worker as ONE self-contained file.
 * Deliberately its own Vite invocation (see vite.config.ts's comment) so
 * Rollup has no other entry point in this build to factor shared chunks
 * out to - everything the background script imports gets inlined here.
 */
export default defineConfig({
  build: {
    emptyOutDir: false, // preserve output already written by the popup/options build
    rollupOptions: {
      input: { background: resolve(__dirname, "src/background/service-worker.ts") },
      output: {
        entryFileNames: "background.js",
        format: "iife",
      },
    },
  },
});
