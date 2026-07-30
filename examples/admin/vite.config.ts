import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // `result-rpc` is a `link:` dependency to a sibling checkout with its own
  // node_modules/react, so the bundle otherwise ships TWO Reacts and every
  // hook throws "Cannot read properties of null (reading 'useState')".
  // FRICTION.md #14.
  resolve: { dedupe: ["react", "react-dom"] },
  build: { outDir: "dist" },
  server: {
    // `vite dev` for fast iteration; `wrangler dev` (port 8788) owns /rpc.
    proxy: { "/rpc": "http://127.0.0.1:8788" },
  },
});
