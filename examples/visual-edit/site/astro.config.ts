import { defineConfig } from "astro/config";
import react from "@astrojs/react";

export default defineConfig({
  output: "server",
  integrations: [react()],
  vite: {
    optimizeDeps: {
      include: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
    },
  },
});
