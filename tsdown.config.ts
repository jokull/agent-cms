import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/lib.ts"],
  format: "esm",
  dts: true,
  clean: true,
  // @agent-cms/dast is a workspace types+constants package with zero runtime
  // deps — inline it into dist so the published `agent-cms` tarball is
  // self-contained and consumers need not install it.
  noExternal: ["@agent-cms/dast"],
  deps: {
    onlyBundle: false,
  },
});
