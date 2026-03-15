import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
  },
  resolve: {
    alias: {
      "~": path.resolve(__dirname, "./src"),
      // Ensure only one instance of graphql is loaded (CJS/ESM dedup)
      graphql: path.resolve(__dirname, "node_modules/graphql/index.mjs"),
    },
  },
});
