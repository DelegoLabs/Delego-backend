import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@delegolabs/types": path.resolve(__dirname, "../../../packages/types/src/index.ts"),
      "@delegolabs/utils": path.resolve(__dirname, "../../../packages/utils/src/index.ts"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: ["node_modules/", "dist/", "**/*.test.ts", "**/*.config.ts"],
    },
  },
});
