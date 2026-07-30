import { defineConfig } from "vitest/config";

/**
 * Local config so `.tsx` hook tests are picked up (the repo-root config only
 * globs `test/**\/*.test.ts`) and JSX compiles with the automatic runtime.
 */
export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
  },
});
