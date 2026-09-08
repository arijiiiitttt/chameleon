import { defineConfig } from "vite";
import { resolve } from "node:path";

/**
 * Builds the content script as ONE self-contained file with NO `import`
 * statements. This is mandatory, not a style preference: Chrome/Firefox
 * inject content_scripts declared in manifest.json as classic scripts,
 * and a classic script containing a static `import` throws a
 * SyntaxError immediately, silently breaking the extension on every
 * page. Deliberately its own Vite invocation so Rollup has no other
 * entry point to factor shared chunks out to.
 */
export default defineConfig({
  build: {
    emptyOutDir: false, // preserve output already written by the popup/options and background builds
    rollupOptions: {
      input: { content: resolve(__dirname, "src/content/content-script.ts") },
      output: {
        entryFileNames: "content.js",
        format: "iife",
      },
    },
  },
});
