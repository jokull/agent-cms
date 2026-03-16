import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";

export default defineConfig({
  output: "server",
  adapter: cloudflare(),
  i18n: {
    locales: ["en", "is"],
    defaultLocale: "en",
    routing: {
      prefixDefaultLocale: true,
    },
  },
});
