import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // `result-rpc` is a `link:` dependency to a sibling checkout with its own
  // node_modules/react, so the bundle otherwise ships TWO Reacts and every
  // hook throws "Cannot read properties of null (reading 'useState')".
  // FRICTION.md #14.
  resolve: { dedupe: ["react", "react-dom"] },
  // Bundle output goes to /static, NOT the default /assets: the Worker owns
  // `/assets/:id/:filename` (the CMS's canonical asset URL) and must not have
  // to disambiguate it from the SPA's own chunks.
  build: { outDir: "dist", assetsDir: "static" },
  server: {
    // `vite dev` for fast iteration; `wrangler dev` (port 8788) owns /rpc,
    // /assets/* (R2 files) and the local /cdn-cgi/image shim.
    proxy: {
      "/rpc": "http://127.0.0.1:8788",
      "/assets": "http://127.0.0.1:8788",
      "/cdn-cgi": "http://127.0.0.1:8788",
    },
  },
});
