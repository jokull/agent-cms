import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // `result-rpc` is a `link:` dependency to a sibling checkout with its own
  // node_modules/react, so the bundle otherwise ships TWO Reacts and every
  // hook throws. (admin FRICTION.md #14.)
  resolve: { dedupe: ["react", "react-dom"] },
  build: { outDir: "dist" },
  server: {
    // `pnpm dev` (Vite on :5173) proxies /rpc to the tsx server on :8790.
    proxy: { "/rpc": "http://127.0.0.1:8790" },
  },
});
