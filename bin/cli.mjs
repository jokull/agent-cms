#!/usr/bin/env node

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const command = process.argv[2];

if (command !== "init") {
  console.log(`Usage: npx agent-cms init [directory]`);
  process.exit(1);
}

const dir = resolve(process.argv[3] || ".");
const name = dir === resolve(".") ? "my-cms" : dir.split("/").pop();

if (existsSync(join(dir, "package.json"))) {
  console.error(`Error: ${dir}/package.json already exists`);
  process.exit(1);
}

mkdirSync(join(dir, "src"), { recursive: true });
mkdirSync(join(dir, "migrations"), { recursive: true });

writeFileSync(
  join(dir, "package.json"),
  JSON.stringify(
    {
      name,
      version: "0.0.1",
      private: true,
      type: "module",
      scripts: {
        dev: "wrangler dev",
        deploy: "wrangler deploy",
        setup: "node setup.mjs",
      },
      dependencies: {
        "agent-cms": "^0.1.0",
        wrangler: "^4.76.0",
      },
    },
    null,
    2,
  ) + "\n",
);

writeFileSync(
  join(dir, "src/index.ts"),
  `import { createCMSHandler } from "agent-cms";

interface Env {
  DB: D1Database;
  ASSETS?: R2Bucket;
  AI?: Ai;
  VECTORIZE?: VectorizeIndex;
  CMS_WRITE_KEY?: string;
  ASSET_BASE_URL?: string;
  ENVIRONMENT?: string;
}

let handler: ReturnType<typeof createCMSHandler> | null = null;

function getHandler(env: Env) {
  if (!handler) {
    handler = createCMSHandler({
      bindings: {
        db: env.DB,
        assets: env.ASSETS,
        writeKey: env.CMS_WRITE_KEY,
        assetBaseUrl: env.ASSET_BASE_URL,
        ai: env.AI,
        vectorize: env.VECTORIZE,
        environment: env.ENVIRONMENT,
      },
    });
  }
  return handler;
}

export default {
  fetch(request: Request, env: Env) {
    return getHandler(env).fetch(request);
  },
  scheduled(controller: ScheduledController, env: Env) {
    return getHandler(env).runScheduledTransitions();
  },
};
`,
);

writeFileSync(
  join(dir, "wrangler.jsonc"),
  JSON.stringify(
    {
      $schema: "node_modules/wrangler/config-schema.json",
      name,
      main: "src/index.ts",
      compatibility_date: "2025-01-01",
      compatibility_flags: ["nodejs_compat"],
      d1_databases: [
        {
          binding: "DB",
          database_name: `${name}-db`,
          database_id: "local",
          migrations_dir: "node_modules/agent-cms/migrations",
        },
      ],
      // Uncomment for assets:
      // r2_buckets: [{ binding: "ASSETS", bucket_name: "${name}-assets" }],
    },
    null,
    2,
  ) + "\n",
);

writeFileSync(
  join(dir, "setup.mjs"),
  `const url = process.argv[2] ?? "http://127.0.0.1:8787";
const token = process.env.CMS_WRITE_KEY;
const headers = { "Content-Type": "application/json" };
if (token) headers.Authorization = \`Bearer \${token}\`;
const res = await fetch(new URL("/api/setup", url), { method: "POST", headers });
console.log(await res.json());
`,
);

console.log(`
  Created ${name}/ with:
    src/index.ts      Cloudflare Worker entry point
    wrangler.jsonc    Worker config with D1 binding
    setup.mjs         DB initialization script
    package.json      Dependencies

  Next steps:
    cd ${name}
    pnpm install
    pnpm dev
    pnpm run setup -- http://127.0.0.1:8787

  Then connect an MCP client:
    claude mcp add --transport http ${name} http://127.0.0.1:8787/mcp
`);
