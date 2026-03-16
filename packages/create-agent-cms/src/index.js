#!/usr/bin/env node

import { execSync } from "child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, cpSync } from "fs";
import { join, resolve } from "path";
import { createInterface } from "readline";
import { parseArgs } from "util";

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: "string", short: "n" },
    "db-name": { type: "string" },
    "bucket-name": { type: "string" },
    "skip-prompts": { type: "boolean", short: "y", default: false },
    "local-only": { type: "boolean", default: false },
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
    --local-only        Skip remote resource creation (D1/R2), local dev only
    -h, --help          Show this help

  Examples:
    npx create-agent-cms my-blog -y
    npx create-agent-cms my-blog --local-only
    npx create-agent-cms --name my-blog --db-name blog-db -y
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

function run(cmd, opts = {}) {
  console.log(`  $ ${cmd}`);
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], ...opts }).trim();
  } catch (e) {
    if (e.stderr) console.error(`    ${e.stderr.trim()}`);
    throw e;
  }
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

  // --- Scaffold files ---

  console.log(`\n  Scaffolding ./${name}...\n`);

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
          "db:migrate": `wrangler d1 migrations apply ${dbName} --local`,
          "db:migrate:remote": `wrangler d1 migrations apply ${dbName} --remote`,
        },
        dependencies: {
          // For local dev: resolve to agent-cms repo. After npm publish: "agent-cms": "^0.1.0"
          "agent-cms": `file:${join(new URL(".", import.meta.url).pathname, "..", "..", "..")}`,
          wrangler: "^4.73.0",
        },
      },
      null,
      2
    )
  );

  // wrangler.jsonc — database_id will be patched after d1 create
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
            database_id: "LOCAL_PLACEHOLDER",
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

  writeFileSync(
    join(dir, "src/index.ts"),
    `import { createCMSHandler } from "agent-cms";

export default {
  fetch(request: Request, env: { DB: D1Database; ASSETS: R2Bucket; ENVIRONMENT?: string; CMS_READ_KEY?: string; CMS_WRITE_KEY?: string }) {
    return createCMSHandler(env).fetch(request);
  },
};
`
  );

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

  const migrationSrc = join(new URL(".", import.meta.url).pathname, "..", "templates", "0001_create_system_tables.sql");
  if (existsSync(migrationSrc)) {
    cpSync(migrationSrc, join(dir, "migrations/0001_create_system_tables.sql"));
  }

  console.log("  Files created.\n");

  // --- Install dependencies ---

  console.log("  Installing dependencies...\n");
  run("npm install", { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
  console.log("  Done.\n");

  // --- Create Cloudflare resources ---

  if (!flags["local-only"]) {
    console.log("  Creating Cloudflare resources...\n");

    // Create D1 database
    try {
      const d1Output = run(`npx wrangler d1 create ${dbName}`, { cwd: dir });
      // Extract database_id from output
      // Match both TOML (database_id = "...") and JSON ("database_id": "...") output formats
      const idMatch = d1Output.match(/database_id["\s:=]+["']?([0-9a-f-]{36})["']?/);
      if (idMatch) {
        const databaseId = idMatch[1];
        console.log(`  D1 database created: ${databaseId}\n`);
        // Patch wrangler.jsonc with real database_id
        const wranglerPath = join(dir, "wrangler.jsonc");
        const wranglerContent = readFileSync(wranglerPath, "utf-8");
        writeFileSync(wranglerPath, wranglerContent.replace("LOCAL_PLACEHOLDER", databaseId));
      }
    } catch (e) {
      console.log(`  Warning: Could not create D1 database. You may need to create it manually.\n`);
    }

    // Create R2 bucket
    try {
      run(`npx wrangler r2 bucket create ${bucketName}`, { cwd: dir });
      console.log(`  R2 bucket created.\n`);
    } catch (e) {
      console.log(`  Warning: Could not create R2 bucket. It may already exist or you can create it manually.\n`);
    }
  }

  // --- Apply local migrations ---

  console.log("  Applying local D1 migrations...\n");
  try {
    run(`npx wrangler d1 migrations apply ${dbName} --local`, { cwd: dir });
    console.log("");
  } catch (e) {
    console.log(`  Warning: Local migration failed. Run 'npm run db:migrate' manually.\n`);
  }

  // --- Done ---

  console.log(`  ✓ Project ready!\n`);
  console.log(`  cd ${name}`);
  console.log(`  npm run dev\n`);
  console.log(`  Then open http://localhost:8787/graphql\n`);
  console.log(`  Connect Claude to the MCP server:\n`);
  console.log(`  {`);
  console.log(`    "mcpServers": {`);
  console.log(`      "${name}": { "url": "http://localhost:8787/mcp" }`);
  console.log(`    }`);
  console.log(`  }\n`);

  if (!flags["local-only"]) {
    console.log(`  Set API keys (required for production):\n`);
    console.log(`    npx wrangler secret put CMS_READ_KEY    # for GraphQL reads`);
    console.log(`    npx wrangler secret put CMS_WRITE_KEY   # for REST/MCP writes\n`);
    console.log(`  Deploy to production:\n`);
    console.log(`    npm run db:migrate:remote`);
    console.log(`    npm run deploy\n`);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
