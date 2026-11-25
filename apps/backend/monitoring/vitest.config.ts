import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["src/oracleHealth.test.ts"],
  },
  resolve: {
    alias: {
      "@delegolabs/types": path.resolve(root, "../../../packages/types/src/index.ts"),
      "@delegolabs/utils": path.resolve(root, "../../../packages/utils/src/index.ts"),
    },
  },
});
