/// <reference types="astro/client" />

declare module "cloudflare:workers" {
  interface CloudflareEnv {
    CMS: Fetcher;
  }
}
