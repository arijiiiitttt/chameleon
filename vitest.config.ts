import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    environmentMatchGlobs: [["tests/unit/dom-extractor.test.ts", "node"]],
  },
  resolve: {
    alias: {
      "@chameleon/shared-types": path.resolve(__dirname, "packages/shared-types/src/index.ts"),
      "@chameleon/privacy-policy": path.resolve(__dirname, "packages/privacy-policy/src/index.ts"),
      "@chameleon/evaluation": path.resolve(__dirname, "packages/evaluation/src/index.ts"),
      "@chameleon/screen-state": path.resolve(__dirname, "packages/screen-state/src/index.ts"),
      "@chameleon/action-dsl": path.resolve(__dirname, "packages/action-dsl/src/index.ts"),
      "@chameleon/protocol": path.resolve(__dirname, "packages/protocol/src/index.ts"),
    },
  },
});
