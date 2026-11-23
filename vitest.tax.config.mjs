import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pnpm = (pkg) =>
  path.resolve(__dirname, `node_modules/.pnpm/${pkg}/node_modules`);

export default {
  resolve: {
    alias: {
      "@delegolabs/types": path.resolve(__dirname, "packages/types/src/index.ts"),
      "@delegolabs/utils": path.resolve(__dirname, "packages/utils/src/logger.ts"),
      "@stellar/stellar-sdk": path.resolve(
        pnpm("@stellar+stellar-sdk@16.3.0"),
        "@stellar/stellar-sdk",
      ),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["apps/backend/payments/src/tax/**/*.test.ts"],
  },
};
