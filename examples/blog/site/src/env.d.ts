/// <reference types="astro/client" />
import type { CmsRequestTrace } from "./lib/cms-trace";

declare module "cloudflare:workers" {
  interface CloudflareEnv {
    CMS: Fetcher;
  }
}

declare namespace App {
  interface Locals {
    cmsTrace: CmsRequestTrace;
  }
}
