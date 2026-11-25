import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@delegolabs/types": path.resolve(
        __dirname,
        "packages/types/src/index.ts",
      ),
      "@delegolabs/utils": path.resolve(
        __dirname,
        "packages/utils/src/index.ts",
      ),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["apps/backend/payments/src/tax/**/*.test.ts"],
  },
});
