import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    include: ["test/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.git/**",
      "**/.wrangler/**",
      "**/.claude/**",
      "**/.reference/**",
      "**/examples/**",
      "**/packages/**",
    ],
  },
  resolve: {
    alias: {
      "~": path.resolve(__dirname, "./src"),
      // Ensure only one instance of graphql is loaded (CJS/ESM dedup)
      graphql: path.resolve(__dirname, "node_modules/graphql/index.mjs"),
    },
  },
});
