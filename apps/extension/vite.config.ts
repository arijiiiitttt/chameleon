import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

/**
 * IMPORTANT: this config builds ONLY the popup and options HTML entries.
 * They are loaded via <script type="module"> tags, so it's safe (and
 * desirable) for Vite/Rollup to split shared code into common chunks
 * between them.
 *
 * The background service worker and content script are built by
 * `vite.background.config.ts` and `vite.content.config.ts` instead, each
 * as a single self-contained IIFE bundle with NO shared chunks. This is
 * not optional: Chrome MV3 content scripts declared via
 * `manifest.json`'s `content_scripts` field are always executed as
 * classic (non-module) scripts and cannot contain `import` statements -
 * a single combined multi-entry Vite build would otherwise silently
 * factor shared code (e.g. the privacy engine, message-router types) into
 * a separate chunk and reference it via `import`, which throws a
 * SyntaxError the instant the content script is injected into any page.
 * See docs/LIMITATIONS.md for how this was caught.
 */
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        popup: resolve(__dirname, "src/popup/index.html"),
        options: resolve(__dirname, "src/options/index.html"),
      },
    },
  },
});
