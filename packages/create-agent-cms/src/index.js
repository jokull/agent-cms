#!/usr/bin/env node

import { mkdirSync, writeFileSync, existsSync, cpSync } from "fs";
import { join, resolve } from "path";
import { createInterface } from "readline";
import { parseArgs } from "util";

// Parse CLI flags — every prompt has a flag equivalent for non-interactive use
const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: "string", short: "n" },
    "db-name": { type: "string" },
    "bucket-name": { type: "string" },
    "skip-prompts": { type: "boolean", short: "y", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (flags.help) {
  console.log(`
  Usage: create-agent-cms [project-name] [options]

  Options:
    -n, --name          Project name (default: positional arg or "my-cms")
    --db-name           D1 database name (default: <name>-db)
    --bucket-name       R2 bucket name (default: <name>-assets)
    -y, --skip-prompts  Accept all defaults, no interactive prompts
    -h, --help          Show this help

  Examples:
    npx create-agent-cms my-blog
    npx create-agent-cms --name my-blog --db-name blog-db -y
    npx create-agent-cms my-blog --skip-prompts
`);
  process.exit(0);
}

const isInteractive = process.stdin.isTTY && !flags["skip-prompts"];

function createAsker() {
  if (!isInteractive) return { ask: async () => "", close: () => {} };
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    ask: (q) => new Promise((r) => rl.question(q, r)),
    close: () => rl.close(),
  };
}

async function prompt(ask, question, defaultValue) {
  if (!isInteractive) return defaultValue;
  const answer = (await ask(question)).trim();
  return answer || defaultValue;
}

async function main() {
  console.log("\n  create-agent-cms\n");
  console.log("  Set up an agent-first headless CMS on your Cloudflare account.");
  console.log("  Worker + D1 + R2. Schema managed via MCP. No admin UI.\n");

  const { ask, close } = createAsker();

  const name = flags.name || positionals[0] || await prompt(ask, "  Project name (my-cms): ", "my-cms");
  const dir = resolve(name);

  if (existsSync(dir)) {
    console.error(`\n  Error: directory "${name}" already exists.\n`);
    process.exit(1);
  }

  const dbName = flags["db-name"] || await prompt(ask, `  D1 database name (${name}-db): `, `${name}-db`);
  const bucketName = flags["bucket-name"] || await prompt(ask, `  R2 bucket name (${name}-assets): `, `${name}-assets`);

  close();

  console.log(`\n  Creating project in ./${name}...\n`);

  // Create directory structure
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "migrations"), { recursive: true });

  // Write package.json
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
          "db:migrate": `wrangler d1 migrations apply ${dbName} --local`,
          "db:migrate:remote": `wrangler d1 migrations apply ${dbName} --remote`,
        },
        dependencies: {
          "agent-cms": "^0.1.0",
        },
      },
      null,
      2
    )
  );

  // Write wrangler.jsonc
  writeFileSync(
    join(dir, "wrangler.jsonc"),
    JSON.stringify(
      {
        $schema: "node_modules/wrangler/config-schema.json",
        name,
        main: "src/index.ts",
        compatibility_date: "2024-12-01",
        compatibility_flags: ["nodejs_compat"],
        d1_databases: [
          {
            binding: "DB",
            database_name: dbName,
            database_id: "local", // Updated after `wrangler d1 create`
            migrations_dir: "migrations",
          },
        ],
        r2_buckets: [
          {
            binding: "ASSETS",
            bucket_name: bucketName,
          },
        ],
        vars: {
          ENVIRONMENT: "development",
        },
      },
      null,
      2
    )
  );

  // Write src/index.ts
  writeFileSync(
    join(dir, "src/index.ts"),
    `import { createCMSHandler } from "agent-cms";

export default {
  fetch(request: Request, env: { DB: D1Database; ASSETS: R2Bucket; ENVIRONMENT?: string }) {
    return createCMSHandler(env).fetch(request);
  },
};
`
  );

  // Write tsconfig.json
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ES2022",
          moduleResolution: "bundler",
          lib: ["ES2022"],
          types: ["@cloudflare/workers-types/2023-07-01"],
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          isolatedModules: true,
        },
        include: ["src/**/*.ts"],
      },
      null,
      2
    )
  );

  // Copy migration file
  const migrationSrc = join(
    new URL(".", import.meta.url).pathname,
    "..",
    "templates",
    "0001_create_system_tables.sql"
  );
  if (existsSync(migrationSrc)) {
    cpSync(migrationSrc, join(dir, "migrations/0001_create_system_tables.sql"));
  }

  console.log("  Files created:");
  console.log("    wrangler.jsonc");
  console.log("    src/index.ts");
  console.log("    package.json");
  console.log("    tsconfig.json");
  console.log("    migrations/0001_create_system_tables.sql");

  console.log(`
  Next steps:

    cd ${name}
    npm install

    # Create D1 database (update database_id in wrangler.jsonc with the output)
    wrangler d1 create ${dbName}

    # Create R2 bucket
    wrangler r2 bucket create ${bucketName}

    # Apply migrations (local)
    npm run db:migrate

    # Start dev server
    npm run dev

    # Open GraphiQL
    open http://localhost:8787/graphql

  Connect Claude to the MCP server:

    {
      "mcpServers": {
        "${name}": {
          "url": "http://localhost:8787/mcp"
        }
      }
    }

  Deploy:

    npm run db:migrate:remote
    npm run deploy
`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
